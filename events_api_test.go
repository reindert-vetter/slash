package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The SSE endpoint: correct headers, a frame per published event in the
// documented shape (no `event:` line — the type travels in the payload, see
// eventbus.go), scoping by ?pr=, and an unsubscribe once the client goes away.
func TestHandleEventsStreamsPublishedEvents(t *testing.T) {
	s := &server{}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/events?pr=42", nil).WithContext(ctx)
	rr := httptest.NewRecorder()

	before := events.subscriberCount()
	done := make(chan struct{})
	go func() {
		s.handleEvents(rr, req)
		close(done)
	}()

	// Wait for the handler to have registered itself, then publish.
	waitFor(t, func() bool { return events.subscriberCount() == before+1 })
	events.publish(eventChatProgress, "", 42, "conv-x", chatProgress{Running: true, Phase: chatPhaseWriting, Partial: "Hal"})
	events.publish(eventChatMessage, "", 99, "other-pr", nil) // different PR: must not show up
	waitFor(t, func() bool { return strings.Contains(rr.Body.String(), "conv-x") })

	cancel()
	<-done

	body := rr.Body.String()
	if ct := rr.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if rr.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("missing no-cache header")
	}
	if !strings.Contains(body, "retry: 3000") {
		t.Fatalf("expected a retry hint, got %q", body)
	}
	if !strings.Contains(body, `"type":"chat.progress"`) || !strings.Contains(body, `"partial":"Hal"`) {
		t.Fatalf("published event missing from the stream: %q", body)
	}
	if strings.Contains(body, "other-pr") {
		t.Fatalf("an event of another PR leaked into a scoped stream: %q", body)
	}
	// A named SSE event would only reach an addEventListener for that name, so
	// a handler registered later would miss it — the type must stay in the data.
	if strings.Contains(body, "event: ") {
		t.Fatalf("frames must not carry an event: name, got %q", body)
	}
	if events.subscriberCount() != before {
		t.Fatalf("subscriber not cleaned up after the client went away")
	}
}

// The volatile progress read used to resync a tab that (re)connects mid-turn.
func TestHandleChatProgress(t *testing.T) {
	resetChatProgress()
	defer resetChatProgress()
	s := &server{}

	rr := httptest.NewRecorder()
	s.handleChatProgress(rr, httptest.NewRequest(http.MethodGet, "/api/chat/progress?commentId=c1", nil))
	if body := rr.Body.String(); !strings.Contains(body, `"running":false`) {
		t.Fatalf("no running turn should read as running:false, got %q", body)
	}

	startChatProgress("", 7, "c1")
	rr = httptest.NewRecorder()
	s.handleChatProgress(rr, httptest.NewRequest(http.MethodGet, "/api/chat/progress?commentId=c1", nil))
	if body := rr.Body.String(); !strings.Contains(body, `"running":true`) || !strings.Contains(body, chatPhasePreparing) {
		t.Fatalf("running turn = %q", body)
	}

	rr = httptest.NewRecorder()
	s.handleChatProgress(rr, httptest.NewRequest(http.MethodGet, "/api/chat/progress", nil))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("missing commentId = %d, want 400", rr.Code)
	}
}

// The PR-wide form: every running turn of ONE pr, keyed by conversation id.
// This is what lets a tab know about a conversation it is not currently
// showing (a chat still running on another selection) after a reconnect.
func TestHandleChatProgressPerPR(t *testing.T) {
	resetChatProgress()
	defer resetChatProgress()
	s := &server{}

	startChatProgress("", 7, "c1")
	startChatProgress("", 7, "c2")
	startChatProgress("", 8, "other-pr")
	startChatProgress("owner/name", 7, "other-repo")
	finishChatProgress("", 7, "c2")

	rr := httptest.NewRecorder()
	s.handleChatProgress(rr, httptest.NewRequest(http.MethodGet, "/api/chat/progress?pr=7", nil))
	body := rr.Body.String()
	if !strings.Contains(body, `"c1"`) {
		t.Fatalf("running turn of this pr missing: %q", body)
	}
	if strings.Contains(body, `"c2"`) {
		t.Fatalf("finished turn must be gone: %q", body)
	}
	if strings.Contains(body, "other-pr") || strings.Contains(body, "other-repo") {
		t.Fatalf("another pr/repo leaked into the read: %q", body)
	}
}

// A connection that fell behind is told to resync rather than silently
// skipping events (the drop policy in eventbus.go).
func TestSSEResyncAfterDrop(t *testing.T) {
	h := newEventHub()
	_, sub := h.subscribe("")
	for i := 0; i < eventSubBuffer+1; i++ {
		h.publish(eventChatMessage, "", 1, "conv", nil)
	}
	var out strings.Builder
	if sub.dropped.Swap(false) {
		writeSSE(&out, busEvent{Type: eventResync})
	}
	if !strings.Contains(out.String(), `"type":"resync"`) {
		t.Fatalf("expected a resync frame, got %q", out.String())
	}
}

// A woken connection sends its resync frame straight away — with no further
// event queued for it and long before the 20s keepalive tick. Before this, the
// dropped flag was only ever read on the next real frame or that tick, so a
// tab that fell behind could believe it was up to date for another 20 seconds
// (and blocks.changed, which home.mjs deliberately keeps out of
// onEventsResync, has no other vangnet at all).
func TestHandleEventsResyncsImmediatelyOnDrop(t *testing.T) {
	s := &server{}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodGet, "/api/events?pr=4242", nil).WithContext(ctx)
	rr := httptest.NewRecorder()

	before := events.subscriberCount()
	done := make(chan struct{})
	go func() {
		s.handleEvents(rr, req)
		close(done)
	}()
	waitFor(t, func() bool { return events.subscriberCount() == before+1 })

	// The subscriber this connection registered for itself; the hub taps exactly
	// this pair (flag + wake) when it has to drop an event for it.
	sub := subByScope(t, statusKey("", 4242))
	sub.dropped.Store(true)
	sub.wake <- struct{}{}

	waitFor(t, func() bool { return strings.Contains(rr.Body.String(), `"type":"resync"`) })
	cancel()
	<-done
}

// subByScope returns the one subscriber watching this scope. Test-only reach
// into the hub: the SSE handler owns its subscriber, so there is no other way
// to exercise the writer's wake branch in isolation.
func subByScope(t *testing.T, scope string) *eventSub {
	t.Helper()
	events.mu.Lock()
	defer events.mu.Unlock()
	for _, sub := range events.subs {
		if sub.scope == scope {
			return sub
		}
	}
	t.Fatalf("no subscriber for scope %q", scope)
	return nil
}
