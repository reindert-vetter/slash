package main

import (
	"encoding/json"
	"testing"
)

func TestTouchedSectionFileDefaultOffAndRoundTrip(t *testing.T) {
	defer touchedSectionOn.Store(touchedSectionOn.Load())
	dir := t.TempDir()
	loadTouchedSectionFile(dir)
	if touchedSectionShown() {
		t.Fatal("missing file must mean off")
	}
	if err := saveTouchedSectionFile(dir, true); err != nil {
		t.Fatal(err)
	}
	touchedSectionOn.Store(false)
	loadTouchedSectionFile(dir)
	if !touchedSectionShown() {
		t.Fatal("saved true must load as on")
	}
}

func TestFilterTouchedSectionRawAndSlice(t *testing.T) {
	secs := []inboxSection{{Title: "Needs your review"}, {Title: touchedSectionTitle}}
	if got := withoutTouchedSection(secs); len(got) != 1 || got[0].Title != "Needs your review" {
		t.Fatalf("withoutTouchedSection = %+v", got)
	}
	raw, _ := json.Marshal(secs)
	var back []inboxSection
	if err := json.Unmarshal(filterTouchedSectionRaw(raw), &back); err != nil {
		t.Fatal(err)
	}
	if len(back) != 1 || back[0].Title != "Needs your review" {
		t.Fatalf("filterTouchedSectionRaw = %+v", back)
	}
}
