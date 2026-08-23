package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/claude"
	"slash/modules/comments"
	"slash/modules/github"
)

// newTitleManager wires a TaskManager with only the comments store + a claude
// Fake, which is all the comment_titles workflow touches.
func newTitleManager(t *testing.T) (*TaskManager, *comments.Module, *claude.Fake) {
	t.Helper()
	cs, err := comments.Open(filepath.Join(t.TempDir(), "comments.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	fake := claude.NewFake()
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, cs, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, fake, nil, nil, "", "test/repo")
	return m, cs, fake
}

// seedTitleComment stores one long comment to be titled.
func seedTitleComment(t *testing.T, cs *comments.Module, id, body string) comments.Comment {
	t.Helper()
	c := comments.Comment{ID: id, RunID: "run-" + id, PR: 77, File: "app/Foo.php", Line: 12, Author: "AI check", Body: body}
	if err := cs.Save(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	return c
}

// titleOf reads one comment's stored title fields back out of the read-model.
func titleOf(t *testing.T, cs *comments.Module, id string) comments.Comment {
	t.Helper()
	c, ok, err := cs.Get(context.Background(), id)
	if err != nil || !ok {
		t.Fatalf("comment %s not found: %v", id, err)
	}
	return c
}

// A batch of two long comments → one Haiku call, a done title per comment,
// capped at 6 words, and the prompt carried both bodies numbered.
func TestCommentTitlesGeneratesTitles(t *testing.T) {
	m, cs, fake := newTitleManager(t)
	a := seedTitleComment(t, cs, "cmt-a", strings.Repeat("Naast API_TOKEN komt nu TOKEN in dezelfde enum te staan. ", 3))
	b := seedTitleComment(t, cs, "cmt-b", strings.Repeat("De migratie draait zonder transactie waardoor een halve tabel achterblijft. ", 3))
	fake.SetOutputForPrompt(claude.ModelHaiku, claude.CommentTitleSystemPrompt,
		`[{"n":1,"title":"Vault case wist echte settings rijen."},{"n":2,"title":"Migratie zonder transactie laat halve tabel achter want dat kan"}]`)

	if _, err := m.StartCommentTitles(CommentTitlesInput{PR: 77, Items: []commentTitleRef{
		{ID: a.ID, BodyLen: len([]rune(a.Body))},
		{ID: b.ID, BodyLen: len([]rune(b.Body))},
	}}); err != nil {
		t.Fatal(err)
	}

	got := titleOf(t, cs, "cmt-a")
	if got.TitleStatus != comments.TitleStatusDone || got.Title != "Vault case wist echte settings rijen" {
		t.Fatalf("cmt-a title = %+v, want the done 6-word title without its trailing period", got)
	}
	if got.TitleBodyLen != len([]rune(a.Body)) {
		t.Fatalf("cmt-a titleBodyLen = %d, want %d", got.TitleBodyLen, len([]rune(a.Body)))
	}
	// Seven words in, six words stored: the cap is enforced on our side, not
	// left to the model's goodwill.
	if got2 := titleOf(t, cs, "cmt-b"); got2.Title != "Migratie zonder transactie laat halve tabel" {
		t.Fatalf("cmt-b title = %q, want it trimmed to 6 words", got2.Title)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 for the whole batch", n)
	}
	call := fake.Calls[0]
	if !strings.Contains(call.Prompt, "1. ") || !strings.Contains(call.Prompt, "2. ") {
		t.Fatalf("prompt misses the numbering:\n%s", call.Prompt)
	}
	if !strings.Contains(call.Prompt, "API_TOKEN") || !strings.Contains(call.Prompt, "migratie draait zonder transactie") {
		t.Fatalf("prompt misses a body:\n%s", call.Prompt)
	}
	if call.SystemPrompt != claude.CommentTitleSystemPrompt {
		t.Fatalf("system prompt = %q, want the embedded claude.CommentTitleSystemPrompt", call.SystemPrompt)
	}
	if call.WorkDir != "" || len(call.Tools) != 0 {
		t.Fatalf("comment_titles must be context-only, got %+v", call)
	}
}

// A comment the model skipped (or an offline/empty answer) gets a terminal
// failed status, so the frontend stops re-requesting it.
func TestCommentTitlesRecordsFailedForSkipped(t *testing.T) {
	m, cs, fake := newTitleManager(t)
	a := seedTitleComment(t, cs, "cmt-a", strings.Repeat("Eerste lange comment die wel een titel krijgt. ", 3))
	b := seedTitleComment(t, cs, "cmt-b", strings.Repeat("Tweede lange comment die de LLM overslaat. ", 3))
	fake.SetOutputForPrompt(claude.ModelHaiku, claude.CommentTitleSystemPrompt, `[{"n":1,"title":"Eerste comment krijgt een titel"}]`)

	if _, err := m.StartCommentTitles(CommentTitlesInput{PR: 77, Items: []commentTitleRef{
		{ID: a.ID, BodyLen: len([]rune(a.Body))},
		{ID: b.ID, BodyLen: len([]rune(b.Body))},
	}}); err != nil {
		t.Fatal(err)
	}

	if got := titleOf(t, cs, "cmt-a"); got.TitleStatus != comments.TitleStatusDone {
		t.Fatalf("cmt-a status = %q, want done", got.TitleStatus)
	}
	got := titleOf(t, cs, "cmt-b")
	if got.TitleStatus != comments.TitleStatusFailed || got.Title != "" {
		t.Fatalf("cmt-b = %+v, want a terminal failed row with no title", got)
	}
	if got.TitleBodyLen != len([]rune(b.Body)) {
		t.Fatalf("cmt-b titleBodyLen = %d, want the body length it failed for", got.TitleBodyLen)
	}
}

// Requesting the same batch again is an idempotent no-op reuse of the same
// Execution (the deterministic Run ID) — no second LLM call. Editing one
// comment (a different body length) IS a new Execution.
func TestCommentTitlesDedupsPerBatch(t *testing.T) {
	m, cs, fake := newTitleManager(t)
	a := seedTitleComment(t, cs, "cmt-a", strings.Repeat("Een lange comment die een titel verdient. ", 3))
	fake.SetOutputForPrompt(claude.ModelHaiku, claude.CommentTitleSystemPrompt, `[{"n":1,"title":"Titel van deze comment"}]`)

	in := CommentTitlesInput{PR: 77, Items: []commentTitleRef{{ID: a.ID, BodyLen: len([]rune(a.Body))}}}
	first, err := m.StartCommentTitles(in)
	if err != nil {
		t.Fatal(err)
	}
	again, err := m.StartCommentTitles(in)
	if err != nil {
		t.Fatal(err)
	}
	if again != first {
		t.Fatalf("second start = %q, want the same run %q", again, first)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times, want 1 (the repeat must dedup)", n)
	}

	// A longer body = a different Run ID = a real second run.
	edited := CommentTitlesInput{PR: 77, Items: []commentTitleRef{{ID: a.ID, BodyLen: len([]rune(a.Body)) + 20}}}
	third, err := m.StartCommentTitles(edited)
	if err != nil {
		t.Fatal(err)
	}
	if third == first {
		t.Fatalf("edited body reused run %q, want a fresh Execution", first)
	}
	if n := fake.CallCount(); n != 2 {
		t.Fatalf("claude called %d times after the edit, want 2", n)
	}
}

// Recover() must not re-run the LLM Activity of an already-finished run — the
// replay path every workflow has to survive.
func TestCommentTitlesRecoverDoesNotRerun(t *testing.T) {
	m, cs, fake := newTitleManager(t)
	a := seedTitleComment(t, cs, "cmt-a", strings.Repeat("Een lange comment die een titel verdient. ", 3))
	fake.SetOutputForPrompt(claude.ModelHaiku, claude.CommentTitleSystemPrompt, `[{"n":1,"title":"Titel van deze comment"}]`)

	if _, err := m.StartCommentTitles(CommentTitlesInput{PR: 77, Items: []commentTitleRef{{ID: a.ID, BodyLen: len([]rune(a.Body))}}}); err != nil {
		t.Fatal(err)
	}
	if err := m.engine.Recover(); err != nil {
		t.Fatal(err)
	}
	if n := fake.CallCount(); n != 1 {
		t.Fatalf("claude called %d times after Recover, want 1", n)
	}
	if got := titleOf(t, cs, "cmt-a"); got.Title != "Titel van deze comment" {
		t.Fatalf("title after recover = %q", got.Title)
	}
}

// The batch order (and therefore the prompt numbering and the Run ID) is
// independent of the order the caller sent the items in.
func TestCommentTitlesRunIDIgnoresItemOrder(t *testing.T) {
	one := []commentTitleRef{{ID: "cmt-a", BodyLen: 100}, {ID: "cmt-b", BodyLen: 200}}
	two := []commentTitleRef{{ID: "cmt-b", BodyLen: 200}, {ID: "cmt-a", BodyLen: 100}}
	if commentTitlesRunID(77, one) != commentTitlesRunID(77, two) {
		t.Fatal("run id depends on the item order")
	}
	if commentTitlesRunID(77, one) == commentTitlesRunID(78, one) {
		t.Fatal("run id ignores the PR")
	}
}

// trimToTitleWords is the hard cap on what a model may return.
func TestTrimToTitleWords(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"  Vault case wist echte settings rijen.  ", "Vault case wist echte settings rijen"},
		{"Een titel van zeven hele losse woorden hier", "Een titel van zeven hele losse"},
		{`"Titel tussen aanhalingstekens."`, "Titel tussen aanhalingstekens"},
		{"", ""},
	} {
		if got := trimToTitleWords(tc.in); got != tc.want {
			t.Fatalf("trimToTitleWords(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// A comment deleted between the start and the LLM call leaves no row to write
// to — and must not sink the run either.
func TestCommentTitlesSkipsVanishedComment(t *testing.T) {
	m, _, fake := newTitleManager(t)
	fake.SetOutputForPrompt(claude.ModelHaiku, claude.CommentTitleSystemPrompt, `[{"n":1,"title":"Titel"}]`)
	if _, err := m.StartCommentTitles(CommentTitlesInput{PR: 77, Items: []commentTitleRef{{ID: "gone", BodyLen: 300}}}); err != nil {
		t.Fatal(err)
	}
	if n := fake.CallCount(); n != 0 {
		t.Fatalf("claude called %d times for a vanished comment, want 0", n)
	}
}
