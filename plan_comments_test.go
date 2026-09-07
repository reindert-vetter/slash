package main

import (
	"testing"

	"slash/modules/jira"
)

// TestPlanCommentFamilyOrderAndDedup pins the panel's own ordering rule: this
// ticket first, then the main task, then every subtask, and a key that would
// otherwise appear twice (a subtask that happens to equal the parent, or the
// ticket itself listed as its own subtask by a data glitch) is kept once.
func TestPlanCommentFamilyOrderAndDedup(t *testing.T) {
	self := jira.Issue{
		Key: "PAYM-813", Title: "Self", Comments: []jira.Comment{{Body: "hi"}},
		ParentKey: "PAYM-800", ParentTitle: "Parent",
		Subtasks: []jira.IssueRef{
			{Key: "PAYM-801", Title: "Sub 1"},
			{Key: "paym-813", Title: "Self as subtask, must be dropped"},
			{Key: "PAYM-801", Title: "Duplicate subtask, must be dropped"},
			{Key: "PAYM-800", Title: "Same as parent, must be dropped"},
		},
	}
	groups := planCommentFamily(self)
	if len(groups) != 3 {
		t.Fatalf("groups = %+v, want self+parent+one subtask", groups)
	}
	if groups[0].Key != "PAYM-813" || groups[0].Relation != "self" || len(groups[0].Comments) != 1 {
		t.Fatalf("groups[0] = %+v", groups[0])
	}
	if groups[1].Key != "PAYM-800" || groups[1].Relation != "parent" {
		t.Fatalf("groups[1] = %+v", groups[1])
	}
	if groups[2].Key != "PAYM-801" || groups[2].Relation != "subtask" {
		t.Fatalf("groups[2] = %+v", groups[2])
	}
}

// TestPlanCommentFamilyNoParentOrSubtasks pins that a bare ticket with no
// family still comes back as a single self group, never an error.
func TestPlanCommentFamilyNoParentOrSubtasks(t *testing.T) {
	groups := planCommentFamily(jira.Issue{Key: "PAYM-1"})
	if len(groups) != 1 || groups[0].Relation != "self" {
		t.Fatalf("groups = %+v", groups)
	}
}
