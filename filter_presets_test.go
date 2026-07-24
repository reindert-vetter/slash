package main

import "testing"

// The preset filter allow-list rejects an unknown key and maps known keys to
// their fixed gh-search expression (never raw UI text). filterPresets is the
// source of truth handleFilter reads.
func TestFilterPresetsAllowList(t *testing.T) {
	if _, ok := filterPresets["definitely-not-a-preset"]; ok {
		t.Fatal("unknown preset key unexpectedly present")
	}
	for _, key := range []string{"updated-oud", "alle-open", "alle-draft", "ouder-3-dagen"} {
		if _, ok := filterPresets[key]; !ok {
			t.Fatalf("preset %q missing from allow-list", key)
		}
	}
	// The date-bounded preset carries a %s placeholder handleFilter fills in.
	if got := filterPresets["ouder-3-dagen"]; !contains(got, "%s") {
		t.Fatalf("ouder-3-dagen preset %q missing date placeholder", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
