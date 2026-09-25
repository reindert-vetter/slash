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

// TestResolveTSCallsPrivateMethodSameClass is the concrete PR 13885 case: a
// changed method (init) calls a private method (`this.#adoptHandedOverIds()`)
// of the SAME class, declared later in the same file. Proves the `#`-name
// regex fix in reTSCallName (no leading `\b`, which never matches between
// the `.` and the `#`) and the caller-lookup fix (bySym, keyed on the full
// Class::Name symbol so a same-named method in another class can't shadow
// the real caller's own body).
func TestResolveTSCallsPrivateMethodSameClass(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13885
	_, headDir := worktreeDirs(dataDir, "", pr)
	file := "resources/analytics/src/analytics.ts"
	writeTSFile(t, headDir, file, `class PlugAndPayAnalytics {
    init() {
        const params = new URLSearchParams(window.location.search);
        this.#adoptHandedOverIds(params);
    }

    #adoptHandedOverIds(params: URLSearchParams) {
        console.log(params);
    }
}
`)
	caller := Block{PR: pr, File: file, Class: "PlugAndPayAnalytics", Name: "init", Side: SideNew, Status: StatusModified}
	entries := resolveTSCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "#adoptHandedOverIds")
	if !ok {
		t.Fatalf("no entry for call %q, got %+v", "#adoptHandedOverIds", entries)
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("#adoptHandedOverIds: status = %q, want %q", e.Status, callresolve.StatusResolved)
	}
	if e.ChildClass != "PlugAndPayAnalytics" || e.ChildMethod != "#adoptHandedOverIds" {
		t.Fatalf("#adoptHandedOverIds: child = %q/%q, want PlugAndPayAnalytics/#adoptHandedOverIds", e.ChildClass, e.ChildMethod)
	}
	if e.ChildCode == "" {
		t.Fatalf("#adoptHandedOverIds: expected non-empty child code")
	}
}

// TestResolveTSCallsMatchesSameNameAcrossClasses documents the deliberately
// loose, name-only precedent (reviewer decision: NOT scoped to the caller's
// own class) — a call inside one class's method resolves to a same-named
// method declared on an entirely DIFFERENT class in the same file, exactly
// like the existing top-level-only behavior already did for two same-named
// top-level functions.
func TestResolveTSCallsMatchesSameNameAcrossClasses(t *testing.T) {
	dataDir := t.TempDir()
	pr := 1
	_, headDir := worktreeDirs(dataDir, "", pr)
	file := "modules/example.ts"
	writeTSFile(t, headDir, file, `class Other {
    helper() {
        console.log('other');
    }
}

class Foo {
    run() {
        this.helper();
    }

    helper() {
        console.log('foo');
    }
}
`)
	caller := Block{PR: pr, File: file, Class: "Foo", Name: "run", Side: SideNew, Status: StatusModified}
	entries := resolveTSCalls(dataDir, pr, []Block{caller})
	if _, ok := findEntry(entries, "helper"); !ok {
		t.Fatalf("expected a 'helper' entry (loose, name-only match), got %+v", entries)
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
