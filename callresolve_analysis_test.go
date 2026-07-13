package main

import (
	"os"
	"path/filepath"
	"testing"

	"slash/modules/callresolve"
)

// writeCallFixtureRepo lays out a head worktree with one caller that makes four
// kinds of call: a same-class $this-> method, a static Class::method, an
// Eloquent query scope (scopeJoinAddress → joinAddress), and an ambiguous method
// defined in two classes.
func writeCallFixtureRepo(t *testing.T, dataDir string, pr int) {
	t.Helper()
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Services/OrderService.php": `<?php
namespace App\Services;
class OrderService {
    public function build() {
        $this->prepare();
        Helper::compute();
        Order::query()->joinAddress('contract');
        $this->repo->fetch();
    }
    public function prepare() {}
}
`,
		"app/Support/Helper.php": `<?php
namespace App\Support;
class Helper {
    public static function compute() {}
}
`,
		"app/Models/Order.php": `<?php
namespace App\Models;
class Order {
    public function scopeJoinAddress($query, $type) {}
}
`,
		"app/Repos/RepoA.php": `<?php
namespace App\Repos;
class RepoA {
    public function fetch() {}
}
`,
		"app/Repos/RepoB.php": `<?php
namespace App\Repos;
class RepoB {
    public function fetch() {}
}
`,
	}
	for rel, body := range files {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func findEntry(entries []callresolve.Entry, callKey string) (callresolve.Entry, bool) {
	for _, e := range entries {
		if e.CallKey == callKey {
			return e, true
		}
	}
	return callresolve.Entry{}, false
}

func TestResolveCallsStatic(t *testing.T) {
	dataDir := t.TempDir()
	pr := 7
	writeCallFixtureRepo(t, dataDir, pr)
	caller := Block{PR: pr, File: "app/Services/OrderService.php", Class: "OrderService", Name: "build", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	cases := map[string]struct {
		status string
		child  string // expected child class::method for resolved
	}{
		"prepare":     {callresolve.StatusResolved, "OrderService::prepare"},
		"compute":     {callresolve.StatusResolved, "Helper::compute"},
		"joinAddress": {callresolve.StatusResolved, "Order::scopeJoinAddress"},
		"fetch":       {callresolve.StatusUnresolved, ""},
	}
	for key, want := range cases {
		e, ok := findEntry(entries, key)
		if !ok {
			t.Errorf("no entry for call %q", key)
			continue
		}
		if e.Status != want.status {
			t.Errorf("call %q: status = %q, want %q", key, e.Status, want.status)
		}
		if want.status == callresolve.StatusResolved {
			got := e.ChildClass + "::" + e.ChildMethod
			if got != want.child {
				t.Errorf("call %q: child = %q, want %q", key, got, want.child)
			}
			if e.ChildCode == "" {
				t.Errorf("call %q: resolved entry has empty child code", key)
			}
		}
	}

	// Old-side blocks are skipped entirely.
	old := caller
	old.Side = SideOld
	if got := resolveCalls(dataDir, pr, []Block{old}); len(got) != 0 {
		t.Fatalf("old-side block produced %d entries, want 0", len(got))
	}
}

// TestResolveCallsMagicProperty covers Eloquent magic-property access
// ($order->billingAddress, no parentheses) resolving to the relationship method:
// a unique relationship → resolved, one defined on two models → unresolved, and a
// plain attribute (no matching relationship method) → ignored.
func TestResolveCallsMagicProperty(t *testing.T) {
	dataDir := t.TempDir()
	pr := 9
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Services/Replicator.php": `<?php
namespace App\Services;
class Replicator {
    public function run() {
        $upsell->save($order->billingAddress->replicate());
        $upsell->save($order->contract);
        $total = $order->total;
    }
}
`,
		"app/Models/Order.php": `<?php
namespace App\Models;
class Order {
    public function billingAddress(): MorphOne {
        return $this->morphOne(Address::class, 'addressable');
    }
    public function contract() {
        return $this->belongsTo(Contract::class);
    }
}
`,
		"app/Models/Invoice.php": `<?php
namespace App\Models;
class Invoice {
    public function billingAddress(): MorphOne {
        return $this->morphOne(Address::class, 'addressable');
    }
}
`,
	}
	for rel, body := range files {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Services/Replicator.php", Class: "Replicator", Name: "run", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	// contract: defined only on Order → resolved as a relationship.
	if e, ok := findEntry(entries, "contract"); !ok {
		t.Error("no entry for magic property 'contract'")
	} else if e.Status != callresolve.StatusResolved || e.ChildClass+"::"+e.ChildMethod != "Order::contract" {
		t.Errorf("contract: status=%q child=%s::%s, want resolved Order::contract", e.Status, e.ChildClass, e.ChildMethod)
	}

	// billingAddress: relationship on both Order and Invoice → ambiguous → unresolved.
	if e, ok := findEntry(entries, "billingAddress"); !ok {
		t.Error("no entry for magic property 'billingAddress'")
	} else if e.Status != callresolve.StatusUnresolved {
		t.Errorf("billingAddress: status=%q, want unresolved", e.Status)
	}

	// total: no method named total anywhere → plain attribute, ignored.
	if _, ok := findEntry(entries, "total"); ok {
		t.Error("plain attribute 'total' should not produce a call entry")
	}
}
