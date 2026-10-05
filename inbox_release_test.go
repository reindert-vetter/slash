package main

import "testing"

func TestIsReleaseToMaster(t *testing.T) {
	cases := []struct {
		head, base string
		want       bool
	}{
		{"release", "master", true},
		{"release", "main", false},
		{"hotfix/AI-554", "master", false},
		{"feature/x", "release", false},
		{"release/2026-10", "master", false},
	}
	for _, c := range cases {
		got := isReleaseToMaster(inboxRow{HeadRefName: c.head, BaseRefName: c.base})
		if got != c.want {
			t.Errorf("%s→%s: got %v, want %v", c.head, c.base, got, c.want)
		}
	}
}
