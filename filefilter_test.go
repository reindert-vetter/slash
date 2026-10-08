package main

import "testing"

func TestFileFilterIgnores(t *testing.T) {
	cases := []struct {
		mode, file string
		want       bool
	}{
		{"all", "a.vue", false},
		{"backend", "a.vue", true},
		{"backend", "x/b.mjs", true},
		{"backend", "c.php", false},
		{"frontend", "c.php", true},
		{"frontend", "d.tsx", false},
	}
	for _, c := range cases {
		if got := fileFilterIgnores(c.mode, c.file); got != c.want {
			t.Errorf("%s %s: got %v", c.mode, c.file, got)
		}
	}
}

func TestApprovalRollupIgnoredCountsAsDone(t *testing.T) {
	files := []string{"a.php", "b.vue"}
	rows := []int{4, 6}
	approved := []int{1, 5}
	done, total, ign := approvalRollup("backend", files, rows, approved)
	if done != 7 || total != 10 || ign != 6 {
		t.Fatalf("backend: %d/%d ign %d", done, total, ign)
	}
	done, total, ign = approvalRollup("all", files, rows, approved)
	if done != 6 || total != 10 || ign != 0 {
		t.Fatalf("all: %d/%d ign %d", done, total, ign)
	}
}
