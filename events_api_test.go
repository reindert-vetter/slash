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
