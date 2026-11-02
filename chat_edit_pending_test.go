package main

import "testing"

// A pending flag with no landing queued or running must not read as "a landing
// is coming": that was the endless transient retry loop.
func TestChatLandExpectedNeedsLandingInFlight(t *testing.T) {
	const repo, pr = "", 987654
	t.Cleanup(func() { clearChatPendingFiles(repo, pr) })
	markChatFilesPending(repo, pr, []string{"a.php"})
	if chatLandExpected(repo, pr) {
		t.Fatal("expected false: files pending but no landing in flight")
	}
	beginChatLanding(repo, pr)
	if !chatLandExpected(repo, pr) {
		t.Fatal("expected true while a landing is queued")
	}
	endChatLanding(repo, pr)
	if chatLandExpected(repo, pr) {
		t.Fatal("expected false once the landing finished")
	}
	endChatLanding(repo, pr) // must not go negative
	beginChatLanding(repo, pr)
	if !chatLandExpected(repo, pr) {
		t.Fatal("counter drifted after an extra end")
	}
	endChatLanding(repo, pr)
}
