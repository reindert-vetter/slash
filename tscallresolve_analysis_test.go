package main

import (
	"os"
	"path/filepath"
	"testing"

	"slash/modules/callresolve"
)

// writeTSFile is the tsscan/tscallresolve test helper mirroring the PHP
// tests' inline os.MkdirAll+os.WriteFile pattern.
func writeTSFile(t *testing.T, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestResolveTSCallsSameFile mirrors the real PR 13538 shape: a changed
// top-level arrow function (trackEvents) calls another top-level function
// (firePurchaseEvent) declared earlier in the same file. No base worktree
// file is written — changedNewLines treats a file absent from the base
// worktree as "added" (fileChangeSet.restrict stays false), so every line
// counts as changed, exactly like the existing PHP resolveCalls tests that
// only populate the head worktree (see TestResolveCallsStaticInheritedMethod).
func TestResolveTSCallsSameFile(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13538
	_, headDir := worktreeDirs(dataDir, "", pr)
	file := "modules/Pages/Resources/assets/js/rendering/modules/pages/scripts/google/tag-manager/v2.ts"
	writeTSFile(t, headDir, file, `export interface GTMEventOptions {
  isOrderSummaryPage?: boolean;
}

const markOrderAsTracked = (orderId: number): void => {
  console.log(orderId);
};

export const firePurchaseEvent = (orderData: number): void => {
  markOrderAsTracked(orderData);
};

export const trackEvents = async (options: GTMEventOptions): Promise<void> => {
  if (options.isOrderSummaryPage) {
    firePurchaseEvent(1);
  }
};
`)

	caller := Block{PR: pr, File: file, Name: "trackEvents", Side: SideNew, Status: StatusModified}
	entries := resolveTSCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "firePurchaseEvent")
	if !ok {
		t.Fatalf("no entry for call %q, got %+v", "firePurchaseEvent", entries)
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("firePurchaseEvent: status = %q, want %q", e.Status, callresolve.StatusResolved)
	}
	if e.ChildMethod != "firePurchaseEvent" || e.ChildClass != "" {
		t.Fatalf("firePurchaseEvent: child = %q/%q, want name only, no class", e.ChildClass, e.ChildMethod)
	}
	if e.ChildCode == "" {
		t.Fatalf("firePurchaseEvent: expected non-empty child code")
	}
	// markOrderAsTracked is only called from firePurchaseEvent's own body,
	// never from trackEvents — the caller block here is only trackEvents, so
	// it must not appear.
	if _, ok := findEntry(entries, "markOrderAsTracked"); ok {
		t.Fatalf("unexpected entry for markOrderAsTracked from the trackEvents caller")
	}
}

// TestResolveTSCallsExpressionBodyArrowNotAScanTarget documents the v1
// boundary: an expression-bodied arrow (no `{ ... }` block) is never scanned
// by tsscan.go, so it can never appear as a CALLER block in the first place
// (the ingest pipeline only ever emits a block for a block-bodied function) —
// resolveTSCalls degrades to "no funcs found for this caller name" and emits
// nothing, rather than panicking or matching the wrong span.
func TestResolveTSCallsExpressionBodyArrowNotAScanTarget(t *testing.T) {
	dataDir := t.TempDir()
	pr := 1
	_, headDir := worktreeDirs(dataDir, "", pr)
	file := "modules/example.ts"
	writeTSFile(t, headDir, file, `const isPaid = (x: number): boolean => x > 0;

export const trackEvents = (): void => {
  isPaid(1);
};
`)
	caller := Block{PR: pr, File: file, Name: "isPaid", Side: SideNew, Status: StatusModified}
	entries := resolveTSCalls(dataDir, pr, []Block{caller})
	if len(entries) != 0 {
		t.Fatalf("expected no entries for a caller name tsscan never emits a block for, got %+v", entries)
	}
}

// TestResolveTSCallsSkipsNonTSFiles is a defensive guard: a PHP block in the
// same PR must never reach the TS-only scan path.
func TestResolveTSCallsSkipsNonTSFiles(t *testing.T) {
	dataDir := t.TempDir()
	pr := 1
	_, headDir := worktreeDirs(dataDir, "", pr)
	writeTSFile(t, headDir, "app/Services/Foo.php", "<?php\nclass Foo {\n    public function bar() {}\n}\n")
	caller := Block{PR: pr, File: "app/Services/Foo.php", Class: "Foo", Name: "bar", Side: SideNew, Status: StatusModified}
	entries := resolveTSCalls(dataDir, pr, []Block{caller})
	if len(entries) != 0 {
		t.Fatalf("expected resolveTSCalls to skip a .php block entirely, got %+v", entries)
	}
}
