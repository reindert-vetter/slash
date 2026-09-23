package main

import (
	"context"
	"testing"
)

// A comment on a line of the PR description block (prDescriptionFile, see
// prDescriptionBlock in src/home.mjs) has no diff line on GitHub, so it must
// go to the flat PR conversation as an issue comment — the commented line
// quoted above the remark — and its replies must follow as issue comments too,
// never as a review comment/reply that GitHub would reject.
func TestTaskCodeCommentOnPRDescriptionPostsQuotedIssueComment(t *testing.T) {
	m, gh, cs := newTestManager(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runID, err := m.StartCodeComment(ctx, CodeCommentInput{
		PR: 42, File: prDescriptionFile, Line: 3, StartLine: 3, EndLine: 3,
		Author: "reindert", Body: "Which endpoint is this about?",
		Code: "Adds the refund endpoint.", Gran: "line", Label: "PR-titel & omschrijving",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gh.PostedCount() != 0 {
		t.Fatalf("review comments posted = %d, want 0", gh.PostedCount())
	}
	if gh.IssuePostedCount() != 1 {
		t.Fatalf("issue comments posted = %d, want 1", gh.IssuePostedCount())
	}
	want := "> Adds the refund endpoint.\n\nWhich endpoint is this about?"
	if got := gh.IssuePosted[0]; got != want {
		t.Fatalf("issue body = %q, want %q", got, want)
	}
	list, _ := cs.List(ctx, "", 42)
	if len(list) != 1 || list[0].GithubID == 0 || list[0].Body != "Which endpoint is this about?" {
		t.Fatalf("comments = %+v, want one stored with the unquoted body and a github id", list)
	}

	if err := m.Signal(runID, ReactionSignal{ID: "ui-1", Source: "ui", Author: "reindert", Body: "the POST one"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return gh.IssuePostedCount() == 2 })
	if gh.PostedCount() != 0 {
		t.Fatalf("review replies posted = %d, want 0 (a reply mirrors as an issue comment)", gh.PostedCount())
	}
}

func TestDescriptionIssueBodyLeavesOrdinaryCommentsAlone(t *testing.T) {
	in := CodeCommentInput{File: "src/Order.php", Code: "return 1;"}
	if got := descriptionIssueBody(in, "body"); got != "body" {
		t.Fatalf("ordinary comment body = %q, want unchanged", got)
	}
	in = CodeCommentInput{File: prDescriptionFile, Code: "line one\r\nline two  "}
	if got := descriptionIssueBody(in, "body"); got != "> line one\n> line two\n\nbody" {
		t.Fatalf("description body = %q", got)
	}
}
