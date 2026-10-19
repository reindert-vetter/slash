package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"slash/modules/chat"
	"slash/modules/claude"
	"slash/modules/comments"
)

// An AI finding the reviewer is discussing with Claude must survive the next
// code_warning run (supersedeFileWarnings), reach the fresh pass as a numbered
// kept finding, and not be joined by a near-identical twin. Before this, a
// re-run triggered by a push deleted it mid-conversation and the chat's
// "voorstel als comment" failed with "De comment-thread bestaat niet meer."
// (PR 14252).
func TestCodeWarningKeepsWarningWithChat(t *testing.T) {
	dataDir := t.TempDir()
	pr := 61
	writeWarningFixtureRepo(t, dataDir, pr)
	if err := replacePRBlocks(mustOpenGraphDB(t, dataDir), "", pr, []Block{warningFixtureBlock(pr)}); err != nil {
		t.Fatal(err)
	}
	fake := claude.NewFake()
	finding := `[{"file":"app/Services/OrderService.php","line":6,"text":"Hardcoded 1.21 VAT rate."}]`
	fake.SetOutput(claude.ModelOpus, finding)
	m, cs, _ := warningManager(t, dataDir, fake)
	cm, err := chat.Open(filepath.Join(dataDir, "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cm.Close() })
	m.chat = cm
	ctx := context.Background()

	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	first, _ := cs.List(ctx, "", pr)
	if len(first) != 1 {
		t.Fatalf("after first run: comments = %+v", first)
	}
	if err := cm.SaveMessage(ctx, chat.Message{ID: "u1", ConversationID: first[0].ID, PR: pr, Role: "user", Body: "voorstel"}); err != nil {
		t.Fatal(err)
	}

	// Same finding again (plus a reworded one would be the model's job; the
	// identical text is the Go-side hard floor).
	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	second, _ := cs.List(ctx, "", pr)
	if len(second) != 1 || second[0].ID != first[0].ID {
		t.Fatalf("after second run: comments = %+v, want only the kept original %s", second, first[0].ID)
	}
	var last string
	for _, c := range fake.Calls {
		if strings.Contains(c.Prompt, "Changed files in this PR to review") {
			last = c.Prompt
		}
	}
	if !strings.Contains(last, "still discussing") || !strings.Contains(last, "1. app/Services/OrderService.php:6 — Hardcoded 1.21 VAT rate.") {
		t.Fatalf("second prompt does not carry the kept finding: %s", last)
	}

	// The fresh pass reports the kept finding resolved: only then it goes.
	fake.SetOutput(claude.ModelOpus, `[{"resolves":1}]`)
	if _, err := m.StartCodeWarning(CodeWarningInput{PR: pr}); err != nil {
		t.Fatal(err)
	}
	third, _ := cs.List(ctx, "", pr)
	if len(third) != 0 {
		t.Fatalf("after a resolves answer: comments = %+v, want the kept finding superseded", third)
	}
}

// A reviewer reply also keeps a finding; an AI/system reply or a bare status
// sentinel does not, and neither does a resolved finding.
func TestWarningEngaged(t *testing.T) {
	base := comments.Comment{ID: "c1", Source: "ai", Status: "open"}
	with := func(c comments.Comment, rs ...comments.Reaction) comments.Comment {
		c.Reactions = rs
		return c
	}
	cases := []struct {
		name string
		c    comments.Comment
		chat map[string]bool
		want bool
	}{
		{"untouched", base, nil, false},
		{"chat", base, map[string]bool{"c1": true}, true},
		{"reviewer reply", with(base, comments.Reaction{Source: "ui", Body: "klopt niet"}), nil, true},
		{"ai reply", with(base, comments.Reaction{Source: "ai", Body: "auto"}), nil, false},
		{"sentinel only", with(base, comments.Reaction{Source: "ui", Body: reopenSentinel}), nil, false},
		{"resolved with chat", comments.Comment{ID: "c1", Source: "ai", Status: "resolved"}, map[string]bool{"c1": true}, false},
		{"not ai", comments.Comment{ID: "c1", Source: "ui", Status: "open"}, map[string]bool{"c1": true}, false},
	}
	for _, tc := range cases {
		if got := warningEngaged(tc.c, tc.chat); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
