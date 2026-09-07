package main

import (
	"strings"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/jira"
)

// TestValidJiraCommentInput pins what may reach Jira at all: every field of a
// posted comment is validated before it leaves the process AND again when it
// comes back out of the recorded history.
func TestValidJiraCommentInput(t *testing.T) {
	ok := JiraCommentInput{Key: "PAYM-813", Body: "klopt dit?"}
	if err := validJiraCommentInput(ok); err != nil {
		t.Fatalf("valid input rejected: %v", err)
	}
	bad := []JiraCommentInput{
		{Key: "not a key", Body: "x"},
		{Key: "813", Body: "x"},        // the bare numeric form the page's route accepts is not a Jira key
		{Key: "PAYM-813", Body: "   "}, // nothing to post
		{Key: "PAYM-813", Body: strings.Repeat("x", 40<<10)},
		{Key: "PAYM-813", Body: "x", Mentions: []jira.Mention{{AccountID: "a b/c", Text: "@x"}}},
		{Key: "PAYM-813", Body: "x", Mentions: []jira.Mention{{AccountID: "638f", Text: ""}}},
	}
	for _, in := range bad {
		if err := validJiraCommentInput(in); err == nil {
			t.Fatalf("input %+v accepted, want a reason", in)
		}
	}
	many := JiraCommentInput{Key: "PAYM-813", Body: "x"}
	for i := 0; i < 21; i++ {
		many.Mentions = append(many.Mentions, jira.Mention{AccountID: "638f", Text: "@x"})
	}
	if err := validJiraCommentInput(many); err == nil {
		t.Fatalf("21 mentions accepted, want a reason")
	}
}

// TestJiraCommentWorkflowPostsOnce runs the whole (one-Activity) workflow
// against the Jira fake: exactly one comment reaches Jira, as an ADF document
// carrying the picked mention as a real mention node — never as plain "@name"
// text, which is the entire point of building the document ourselves.
func TestJiraCommentWorkflowPostsOnce(t *testing.T) {
	m, _, _ := newTestManager(t)
	f := &jira.Fake{}
	m.jira = f
	engine := tembed.New(tembed.NewMemoryStore())
	m.engine = engine
	m.registerJiraCommentActivities(engine)
	engine.RegisterWorkflow(WorkflowJiraComment, jiraCommentWorkflow)

	runID, err := m.StartJiraComment(JiraCommentInput{
		Key: "paym-813", Body: "  @Dennis Sloove kun je kijken?  ",
		Mentions: []jira.Mention{{AccountID: "638f", Text: "@Dennis Sloove"}},
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if len(f.Posted) != 1 {
		t.Fatalf("posted = %+v, want exactly one comment", f.Posted)
	}
	if f.Posted[0].Key != "PAYM-813" {
		t.Fatalf("posted on %q, want the upper-cased key", f.Posted[0].Key)
	}
	adf := string(f.Posted[0].ADF)
	if !strings.Contains(adf, `"type":"mention"`) || !strings.Contains(adf, `"id":"638f"`) {
		t.Fatalf("adf = %s, want a real mention node", adf)
	}
	var res JiraCommentResult
	if err := engine.Result(runID, &res); err != nil {
		t.Fatalf("result: %v", err)
	}
	if res.Key != "PAYM-813" || res.CommentID == "" {
		t.Fatalf("result = %+v", res)
	}
}
