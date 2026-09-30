package main

import (
	"context"
	"errors"
	"testing"

	"github.com/reindert-vetter/tembed"

	"slash/modules/github"
)

func TestValidatePrDescriptionEdit(t *testing.T) {
	cases := []struct {
		name    string
		in      PrDescriptionEditInput
		wantErr bool
	}{
		{"ok", PrDescriptionEditInput{PR: 1, Title: " T ", Body: "b\r\n"}, false},
		{"bad pr", PrDescriptionEditInput{PR: 0, Title: "T"}, true},
		{"empty title", PrDescriptionEditInput{PR: 1, Title: "  "}, true},
		{"multiline title", PrDescriptionEditInput{PR: 1, Title: "a\nb"}, true},
		{"unknown repo", PrDescriptionEditInput{PR: 1, Title: "T", Repo: "nobody/nothing"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := c.in
			err := validatePrDescriptionEdit(&in)
			if (err != nil) != c.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, c.wantErr)
			}
			if c.name == "ok" && (in.Title != "T" || in.Body != "b") {
				t.Fatalf("not normalised: %+v", in)
			}
		})
	}
}

// TestPrDescriptionEditWritesAndRefreshesPrmeta: the workflow PATCHes GitHub
// (github.Fake) and the prmeta read-model serves the new text right away. A
// GitHub body with \r\n still matches a base the UI normalised to \n.
func TestPrDescriptionEditWritesAndRefreshesPrmeta(t *testing.T) {
	gh := &github.Fake{}
	gh.SetPRMetaFor(42, github.Meta{Title: "Old title", Body: "line one\r\nline two\r\n"})
	engine := tembed.New(tembed.NewMemoryStore())
	pm := testPRMeta(t)
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), pm, nil, nil, nil, nil, nil, nil, nil, "", "test/repo")

	in := PrDescriptionEditInput{PR: 42, Title: "New title", Body: "line one\nline 2", BaseTitle: "Old title", BaseBody: "line one\nline two"}
	if err := validatePrDescriptionEdit(&in); err != nil {
		t.Fatal(err)
	}
	if _, err := m.StartPrDescriptionEdit(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	edits := gh.EditedPRs()
	if len(edits) != 1 || edits[0].PR != 42 || edits[0].Title != "New title" || edits[0].Body != "line one\nline 2" {
		t.Fatalf("edits = %+v", edits)
	}
	got, ok, err := pm.Get(t.Context(), "", 42)
	if err != nil || !ok {
		t.Fatalf("prmeta get: ok=%v err=%v", ok, err)
	}
	if got.Title != "New title" || got.Body != "line one\nline 2" {
		t.Fatalf("prmeta = %q / %q, want the new text", got.Title, got.Body)
	}
}

// TestPrDescriptionEditRefusesStaleBase: a description changed on GitHub
// since the edit started is never overwritten, and no run is started.
func TestPrDescriptionEditRefusesStaleBase(t *testing.T) {
	gh := &github.Fake{}
	gh.SetPRMetaFor(42, github.Meta{Title: "Old title", Body: "a colleague changed this"})
	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, gh, nil, testInbox(t), testRelations(t), testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, "", "test/repo")
	before, _ := engine.Runs()

	_, err := m.StartPrDescriptionEdit(context.Background(), PrDescriptionEditInput{PR: 42, Title: "New", Body: "x", BaseTitle: "Old title", BaseBody: "original"})
	if !errors.Is(err, errPrDescStale) {
		t.Fatalf("err = %v, want errPrDescStale", err)
	}
	if n := len(gh.EditedPRs()); n != 0 {
		t.Fatalf("EditPullRequest called %d times, want 0", n)
	}
	after, _ := engine.Runs()
	if len(after) != len(before) {
		t.Fatalf("a stale edit must not start a run (%d → %d)", len(before), len(after))
	}
}
