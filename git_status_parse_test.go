package main

import (
	"reflect"
	"testing"
)

// A stale untracked cache / fsmonitor makes `git status --porcelain` print
// "warning: could not open directory '…'" on stderr. Those lines must never
// be read as paths (they used to surface as "ning: could not open …" in the
// werkmap overlay and made a clean tree look dirty).
func TestParseGitStatusPathsSkipsNonPorcelainLines(t *testing.T) {
	out := []byte("warning: could not open directory 'app/Mail/Admins/': No such file or directory\n" +
		" M app/Workflows/ImportSubscriptionStatsFlow.php\n" +
		"?? new file.txt\n" +
		"R  old.php -> new.php\n" +
		" M \"quoted path.php\"\n")
	got := parseGitStatusPaths(out)
	want := []string{"app/Workflows/ImportSubscriptionStatsFlow.php", "new file.txt", "new.php", "quoted path.php"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseGitStatusPaths = %q, want %q", got, want)
	}
}
