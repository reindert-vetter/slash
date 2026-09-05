package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"slash/modules/claude"
	"slash/modules/comments"
)

// TestParseCommentBatchMarkers covers the contract the system prompt fixes: the
// three marker kinds, a note that may be empty, and prose lines that must NOT be
// mistaken for a marker.
func TestParseCommentBatchMarkers(t *testing.T) {
	text := strings.Join([]string{
		"Ik begin bij de eerste.",
		"[slash:start] c1",
		"- [slash:done] c1 nullsafe operator toegevoegd",
		"[slash:skip] c2 alleen een vraag, geen wijziging nodig",
		"[slash:done] c3",
		"slash:done c4 — geen marker, gewone tekst",
	}, "\n")
	got := parseCommentBatchMarkers(text)
	if len(got) != 4 {
		t.Fatalf("want 4 markers, got %d (%+v)", len(got), got)
	}
	if got[0].Kind != commentBatchStateBusy || got[0].CommentID != "c1" {
		t.Errorf("start marker: %+v", got[0])
	}
	if got[1].Kind != commentBatchStateDone || got[1].Note != "nullsafe operator toegevoegd" {
		t.Errorf("done marker: %+v", got[1])
	}
	if got[2].Kind != commentBatchStateSkipped || got[2].CommentID != "c2" {
		t.Errorf("skip marker: %+v", got[2])
	}
	if got[3].Kind != commentBatchStateDone || got[3].Note != "" {
		t.Errorf("noteless done marker: %+v", got[3])
	}
}

// TestCommentBatchProgressLifecycle pins the volatile snapshot's behaviour,
// including the two decisions that differ from chat_progress.go: an unknown id
// can never enter it, and the finished snapshot is KEPT (with any comment the run
// never reached falling back to "open" instead of staying "busy").
func TestCommentBatchProgressLifecycle(t *testing.T) {
	pr := 4242
	startCommentBatchProgress("", pr, []string{"c1", "c2", "c3"})
	t.Cleanup(func() {
		commentBatchMu.Lock()
		delete(commentBatchByPR, prKey{"", pr})
		commentBatchMu.Unlock()
	})
	if !commentBatchRunning("", pr) {
		t.Fatal("want running after start")
	}
	markCommentBatchCurrent("", pr, "c1")
	markCommentBatchCurrent("", pr, "nope")
	p, _ := commentBatchProgressFor("", pr)
	if p.Current != "c1" || p.Items[0].State != commentBatchStateBusy {
		t.Fatalf("after start marker: %+v", p)
	}
	markCommentBatchOutcome("", pr, "c1", commentBatchStateDone, "aangepast")
	markCommentBatchOutcome("", pr, "c2", commentBatchStateSkipped, "alleen een vraag")
	markCommentBatchCurrent("", pr, "c3")
	p, _ = commentBatchProgressFor("", pr)
	if p.Done != 1 || p.Skipped != 1 || p.Total != 3 {
		t.Fatalf("counts: %+v", p)
	}
	if p.Items[0].Note != "aangepast" || p.Current != "c3" {
		t.Fatalf("outcome bookkeeping: %+v", p)
	}
	finishCommentBatchProgress("", pr)
	p, ok := commentBatchProgressFor("", pr)
	if !ok {
		t.Fatal("finished snapshot must be kept")
	}
	if p.Running || p.Current != "" || p.Items[2].State != commentBatchStateOpen {
		t.Fatalf("after finish: %+v", p)
	}
	if p.Done != 1 || p.Skipped != 1 {
		t.Fatalf("finished counts must survive: %+v", p)
	}
}

// TestCommentBatchTargetsAndPrompt covers the eligibility rule ("van GitHub +
// eigen, geen AI") plus the fact that the prompt names every id the run is
// allowed to report about.
func TestCommentBatchTargetsAndPrompt(t *testing.T) {
	m, _, _, _ := newChatManager(t)
	ctx := context.Background()
	save := func(c comments.Comment) {
		c.PR = 11
		if err := m.comments.Save(ctx, c); err != nil {
			t.Fatal(err)
		}
	}
	save(comments.Comment{ID: "own", RunID: "own", File: "src/A.php", Line: 3, Body: "graag nullsafe", Status: "open"})
	save(comments.Comment{ID: "gh", RunID: "gh", File: "src/B.php", Line: 9, Body: "dit kan korter", Status: "open", Source: "github", Author: "dennis"})
	save(comments.Comment{ID: "ai", RunID: "ai", File: "src/C.php", Line: 1, Body: "risico", Status: "open", Source: "ai"})
	save(comments.Comment{ID: "aiwide", RunID: "aiwide", Body: "risico", Status: "open", Kind: "ai_warning"})
	save(comments.Comment{ID: "closed", RunID: "closed", File: "src/D.php", Line: 2, Body: "was al goed", Status: "resolved"})

	got := commentBatchTargets(ctx, m.comments, commentBatchArg{
		PR:         11,
		CommentIDs: []string{"own", "gh", "ai", "aiwide", "closed", "ghost"},
	})
	var ids []string
	for _, c := range got {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "own,gh" {
		t.Fatalf("targets: %v", ids)
	}
	prompt := commentBatchPrompt(got)
	for _, want := range []string{"own", "gh", "src/A.php:3", "graag nullsafe", "dennis"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt misses %q:\n%s", want, prompt)
		}
	}
}

// TestRunCommentBatchWithoutWorkCopy pins the degrade path: no work copy (gh
// unreachable) means no Claude call at all, a reason on the snapshot, and a zero
// result — so the workflow still completes and the comments stay simply open.
func TestRunCommentBatchWithoutWorkCopy(t *testing.T) {
	stubUnreachableGh(t)
	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	if err := m.comments.Save(ctx, comments.Comment{
		ID: "c1", RunID: "c1", PR: 12, File: "src/A.php", Line: 3, Body: "graag nullsafe", Status: "open",
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		commentBatchMu.Lock()
		delete(commentBatchByPR, prKey{"", 12})
		commentBatchMu.Unlock()
	})

	res := runCommentBatch(ctx, m, m.comments, cm, fake, t.TempDir(), commentBatchArg{
		PR: 12, CommentIDs: []string{"c1"}, TurnID: "run-1",
	})
	if res.Done != 0 || res.NeedsLand {
		t.Fatalf("want a zero result, got %+v", res)
	}
	if len(fake.Calls) != 0 {
		t.Fatalf("want no claude call, got %d", len(fake.Calls))
	}
	p, ok := commentBatchProgressFor("", 12)
	if !ok || p.Error == "" {
		t.Fatalf("want a recorded reason, got %+v", p)
	}
}

// TestCommentBatchProgressSinkMarkers checks that per-comment progress really
// moves while ONE agent is still running: marker lines arrive split across text
// deltas (the CLI streams per token), so only complete lines may be acted on.
func TestCommentBatchProgressSinkMarkers(t *testing.T) {
	pr := 4343
	startCommentBatchProgress("", pr, []string{"c1"})
	t.Cleanup(func() {
		commentBatchMu.Lock()
		delete(commentBatchByPR, prKey{"", pr})
		commentBatchMu.Unlock()
	})
	sink := commentBatchProgressSink("", pr, []string{"c1"})
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "[slash:sta"})
	if p, _ := commentBatchProgressFor("", pr); p.Current != "" {
		t.Fatal("a half-streamed marker line must not count")
	}
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "rt] c1\n"})
	if p, _ := commentBatchProgressFor("", pr); p.Current != "c1" {
		t.Fatalf("want c1 current, got %+v", p)
	}
	sink(claude.ChatEvent{Kind: claude.ChatEventTool, Tool: "Read", Detail: "src/A.php"})
	if p, _ := commentBatchProgressFor("", pr); p.Phase != chatPhaseTool || p.Tool != "Read" {
		t.Fatalf("tool event: %+v", p)
	}
	sink(claude.ChatEvent{Kind: claude.ChatEventText, TextDelta: "[slash:done] c1 aangepast\n"})
	p, _ := commentBatchProgressFor("", pr)
	if p.Done != 1 || p.Items[0].Note != "aangepast" || p.Current != "" {
		t.Fatalf("done marker: %+v", p)
	}
}

// TestRunCommentBatchWaitsForCheckoutWriteSlot pins that the one agentic batch
// run takes the PR's checkout write slot (chat_write_gate.go) before touching
// the shared checkout — the same gate every other checkout-mutating path
// (a write chat turn, a test run, the landing) already holds. Without it the
// batch's Edit/Bash work races a concurrently running write turn on the SAME
// checkout, whose commitCheckoutEditsAt `git add -A` would sweep the batch's
// half-done edits into that other turn's commit.
func TestRunCommentBatchWaitsForCheckoutWriteSlot(t *testing.T) {
	stubUnreachableGh(t)
	m, _, cm, fake := newChatManager(t)
	ctx := context.Background()
	const pr = 999003
	if err := m.comments.Save(ctx, comments.Comment{
		ID: "c1", RunID: "c1", PR: pr, File: "src/A.php", Line: 3, Body: "graag nullsafe", Status: "open",
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		commentBatchMu.Lock()
		delete(commentBatchByPR, prKey{"", pr})
		commentBatchMu.Unlock()
	})

	// Hold this PR's own write-turn slot, exactly like a concurrent
	// code-editing chat turn on the SAME PR would.
	dataDir := t.TempDir()
	release := acquireWriteTurnSlot(ctx, checkoutWriteSlotKey(dataDir, "", pr), nil)

	done := make(chan commentBatchResult, 1)
	go func() {
		done <- runCommentBatch(ctx, m, m.comments, cm, fake, dataDir, commentBatchArg{
			PR: pr, CommentIDs: []string{"c1"}, TurnID: "run-1",
		})
	}()

	// The run must report itself as waiting for the slot, never start silently.
	waitFor(t, func() bool {
		p, ok := commentBatchProgressFor("", pr)
		return ok && p.Phase == chatPhaseWaiting
	})
	select {
	case <-done:
		t.Fatal("runCommentBatch finished while another turn still held the write slot")
	default:
	}

	release()
	select {
	case res := <-done:
		// With gh stubbed unreachable the run degrades at the work-copy step —
		// the point here is only that it proceeded once the slot freed up.
		if res.Done != 0 {
			t.Fatalf("want a zero result on the degrade path, got %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runCommentBatch never proceeded after the slot was released")
	}
}
