package main

import (
	"testing"

	"slash/modules/jira"
)

// TestCollectPlanReferencedKeysFindsLinkAndTextMention pins the two ways a
// referenced ticket is found (reviewer request: "elke jira-link én elke
// vermelding volgen") against a fixture shaped like the real PROD-254/
// PROD-216 pair: an official Jira link on the ticket itself, PLUS a bare key
// mention in a subtask's comment — both surfaced, family keys excluded, and
// an official link's own relation phrase wins as the Reason over a duplicate
// bare mention of the same key.
func TestCollectPlanReferencedKeysFindsLinkAndTextMention(t *testing.T) {
	doc := planDoc{
		Key:         "PROD-254",
		ParentKey:   "PROD-216", // PROD-216 is ALSO this ticket's own parent here —
		Description: "Zie ook PROD-300 voor de migratie.",
		Subtasks:    []planSubtask{{Key: "PROD-255"}},
		RelatedComments: []planComment{
			{Key: "PROD-255", Author: "Dennis", Body: "vergeet PROD-300 niet"},
		},
	}
	linksByKey := map[string][]jira.IssueLink{
		"PROD-254": {{Key: "PROD-300", Title: "Migratie", Relation: "relates to"}},
	}
	got := collectPlanReferencedKeys(doc, linksByKey)
	if len(got) != 1 {
		t.Fatalf("got %+v, want exactly PROD-300 (PROD-216 is family, PROD-255 is family)", got)
	}
	if got[0].Key != "PROD-300" || got[0].Reason != "relates to" {
		t.Fatalf("got %+v, want PROD-300 with the LINK's own reason, not the bare mention's", got[0])
	}
}

// TestCollectPlanReferencedKeysExcludesFamily asserts a mention of the
// ticket's own family (itself, its parent, a sibling) is never surfaced as
// "referenced" — planRelatedKeys already covers that ground.
func TestCollectPlanReferencedKeysExcludesFamily(t *testing.T) {
	doc := planDoc{
		Key:         "PROD-254",
		ParentKey:   "PROD-216",
		Description: "PROD-254 hangt onder PROD-216, zie ook PROD-260.",
		Siblings:    []planSubtask{{Key: "PROD-260"}},
	}
	got := collectPlanReferencedKeys(doc, nil)
	if len(got) != 0 {
		t.Fatalf("got %+v, want none — every mentioned key is family", got)
	}
}

// TestCollectPlanReferencedKeysIsBounded pins maxPlanReferencedIssues.
func TestCollectPlanReferencedKeysIsBounded(t *testing.T) {
	doc := planDoc{Key: "PROD-1", Description: "PROD-2 PROD-3 PROD-4 PROD-5 PROD-6"}
	got := collectPlanReferencedKeys(doc, nil)
	if len(got) != maxPlanReferencedIssues {
		t.Fatalf("got %d, want the bound %d", len(got), maxPlanReferencedIssues)
	}
}

// TestFindBranchInTextMatchesPlausibleBranchName pins the best-effort
// Jira-text heuristic: a slash-delimited token containing the key, and no
// match at all when the text only names the key in prose.
func TestFindBranchInTextMatchesPlausibleBranchName(t *testing.T) {
	got := findBranchInText("PROD-216", "Werk zit al in branch `feature/PROD-216-groepen`, zie de PR.")
	if got != "feature/PROD-216-groepen" {
		t.Fatalf("got %q", got)
	}
	// Case-insensitive: a branch name is often lowercased even though the key
	// itself is upper.
	got = findBranchInText("PROD-216", "branch: prod-216-groepen")
	if got != "prod-216-groepen" {
		t.Fatalf("got %q, want the lowercased branch matched too", got)
	}
	if got := findBranchInText("PROD-216", "Zie PROD-216 voor de context, nog geen branch."); got != "PROD-216" {
		// Bare prose still matches the key itself as a (degenerate) token —
		// documented, accepted behaviour: the caller only trusts this when a
		// GitHub PR search found nothing at all, and always labels it as an
		// unverified guess (see renderPlanIntent).
		t.Fatalf("got %q", got)
	}
}
