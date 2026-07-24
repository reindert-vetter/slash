package main

import (
	"os"
	"path/filepath"
	"testing"

	"slash/modules/callresolve"
	"slash/modules/relations"
)

// writeInterfaceFixtureRepo writes one interface method plus three
// implementing classes (OrderDriver/RefundDriver/SubscriptionDriver, matching
// the "app/Drivers/" naming used in tembed-workflows.md's WebhookResourceDriver
// example) and one caller that consumes the interface through an explicitly
// interface-typed constructor-promoted property.
func writeInterfaceFixtureRepo(t *testing.T, dataDir string, pr int) {
	t.Helper()
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"packages/Contracts/DriverInterface.php": `<?php
namespace Packages\Contracts;
interface DriverInterface {
    public function triggerableType(): string;
}
`,
		"app/Drivers/OrderDriver.php": `<?php
namespace App\Drivers;
use Packages\Contracts\DriverInterface;
class OrderDriver implements DriverInterface {
    public function triggerableType(): string {
        return 'order';
    }
}
`,
		"app/Drivers/RefundDriver.php": `<?php
namespace App\Drivers;
use Packages\Contracts\DriverInterface;
class RefundDriver implements DriverInterface {
    public function triggerableType(): string {
        return 'refund';
    }
}
`,
		"app/Drivers/SubscriptionDriver.php": `<?php
namespace App\Drivers;
use Packages\Contracts\DriverInterface;
class SubscriptionDriver implements DriverInterface {
    public function triggerableType(): string {
        return 'subscription';
    }
}
`,
		"app/Services/WebhookService.php": `<?php
namespace App\Services;
use Packages\Contracts\DriverInterface;
class WebhookService {
    public function __construct(private DriverInterface $driver) {}
    public function run(): string {
        return $this->driver->triggerableType();
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
}

func interfaceMethodBlock(pr int) Block {
	return Block{
		PR: pr, File: "packages/Contracts/DriverInterface.php", Class: "DriverInterface",
		Name: "triggerableType", Category: "INTERFACE", Side: SideNew, Status: StatusAdded, IsInterface: true,
	}
}

func driverImplBlock(pr int, class, file string) Block {
	return Block{PR: pr, File: file, Class: class, Name: "triggerableType", Side: SideNew, Status: StatusAdded}
}

func hasEdgeKind(rels []relations.Relation, parent, child Block, kind string) bool {
	for _, r := range rels {
		if r.ParentID == parent.ID() && r.ChildID == child.ID() && r.Kind == kind {
			return true
		}
	}
	return false
}

// TestInterfaceImplementationDetectorBothChanged covers "A2": a concrete
// implementing method that changed TOGETHER with the interface method in this
// PR becomes its parent.
func TestInterfaceImplementationDetectorBothChanged(t *testing.T) {
	dataDir := t.TempDir()
	pr := 501
	writeInterfaceFixtureRepo(t, dataDir, pr)
	iface := interfaceMethodBlock(pr)
	order := driverImplBlock(pr, "OrderDriver", "app/Drivers/OrderDriver.php")

	rels := buildRelations(dataDir, pr, []Block{iface, order})
	if !hasEdgeKind(rels, order, iface, relations.KindInterfaceMethod) {
		t.Fatalf("want OrderDriver -> DriverInterface interface_method edge, got %+v", rels)
	}
}

// TestInterfaceImplementationDetectorBothSidesRequired: the interface method
// alone (implementer NOT itself a changed block of this PR) must not produce
// an edge — both-changed, like every other relations detector.
func TestInterfaceImplementationDetectorBothSidesRequired(t *testing.T) {
	dataDir := t.TempDir()
	pr := 502
	writeInterfaceFixtureRepo(t, dataDir, pr)
	iface := interfaceMethodBlock(pr)

	rels := buildRelations(dataDir, pr, []Block{iface})
	for _, r := range rels {
		if r.Kind == relations.KindInterfaceMethod {
			t.Fatalf("want no interface_method edge without a changed implementer, got %+v", rels)
		}
	}
}

// TestResolveCallsInterfaceTypedReceiver covers "A1": a call through an
// explicitly interface-typed constructor-promoted property resolves straight
// to the interface's OWN method declaration, even though several concrete
// implementations in the same worktree also define the same method name
// (which would otherwise make idx.byMethod ambiguous and leave the call
// unresolved).
func TestResolveCallsInterfaceTypedReceiver(t *testing.T) {
	dataDir := t.TempDir()
	pr := 503
	writeInterfaceFixtureRepo(t, dataDir, pr)
	caller := Block{PR: pr, File: "app/Services/WebhookService.php", Class: "WebhookService", Name: "run", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})
	e, ok := findEntry(entries, "triggerableType")
	if !ok {
		t.Fatal("no entry for call 'triggerableType'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("triggerableType: status=%q, want resolved (interface-typed receiver should win over the ambiguity)", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "DriverInterface::triggerableType" {
		t.Fatalf("triggerableType: child=%q, want DriverInterface::triggerableType", got)
	}
}

// TestResolveInterfaceImplementationsCapAndPriority covers "B": an interface
// method with no concrete caller/implementer changed in this PR gets up to
// MaxInterfaceImplementations (2) implementations attached, preferring a
// class that is itself already a block of this PR (OrderDriver, changed for
// an unrelated reason here) over the other, purely-unchanged candidates.
func TestResolveInterfaceImplementationsCapAndPriority(t *testing.T) {
	dataDir := t.TempDir()
	pr := 504
	writeInterfaceFixtureRepo(t, dataDir, pr)
	iface := interfaceMethodBlock(pr)
	// OrderDriver is "already a PR block" via an unrelated method (NOT
	// triggerableType itself, and NOT resolved via a call), it must still be
	// picked first over Refund/SubscriptionDriver.
	orderUnrelated := Block{PR: pr, File: "app/Drivers/OrderDriver.php", Class: "OrderDriver", Name: "someOtherMethod", Side: SideNew, Status: StatusModified}

	blocks := []Block{iface, orderUnrelated}
	claimed := claimedInterfaceMethodIDs(pr, nil, nil)
	entries := resolveInterfaceImplementations(dataDir, pr, blocks, claimed)

	if len(entries) != MaxInterfaceImplementations {
		t.Fatalf("want %d implementation entries (capped), got %d: %+v", MaxInterfaceImplementations, len(entries), entries)
	}
	classes := map[string]bool{}
	for _, e := range entries {
		if e.Kind != callresolve.KindInterfaceImplementation {
			t.Errorf("entry kind=%q, want %q", e.Kind, callresolve.KindInterfaceImplementation)
		}
		if e.CallerID != iface.ID() {
			t.Errorf("entry callerId=%q, want the interface method's own id %q", e.CallerID, iface.ID())
		}
		classes[e.ChildClass] = true
	}
	if !classes["OrderDriver"] {
		t.Fatalf("want OrderDriver (already a PR block) among the picked implementations, got %+v", entries)
	}
	if classes["SubscriptionDriver"] && classes["RefundDriver"] {
		t.Fatalf("want only ONE of Refund/SubscriptionDriver alongside OrderDriver (cap=2), got %+v", entries)
	}
}

// TestResolveInterfaceImplementationsExclusiveWithClaimedParent covers the
// A/B exclusivity rule: an interface method that already has an "A" parent
// (here: an A1 caller resolution) must get NO "B" implementations at all.
func TestResolveInterfaceImplementationsExclusiveWithClaimedParent(t *testing.T) {
	dataDir := t.TempDir()
	pr := 505
	writeInterfaceFixtureRepo(t, dataDir, pr)
	iface := interfaceMethodBlock(pr)
	caller := Block{PR: pr, File: "app/Services/WebhookService.php", Class: "WebhookService", Name: "run", Side: SideNew, Status: StatusModified}

	blocks := []Block{iface, caller}
	calls := resolveCalls(dataDir, pr, blocks)
	claimed := claimedInterfaceMethodIDs(pr, nil, calls)
	if !claimed[iface.ID()] {
		t.Fatalf("want the interface method claimed via the caller's resolved call, got claimed=%+v calls=%+v", claimed, calls)
	}

	entries := resolveInterfaceImplementations(dataDir, pr, blocks, claimed)
	if len(entries) != 0 {
		t.Fatalf("want 0 implementation entries once the interface method is claimed by an A parent, got %+v", entries)
	}
}

// TestClaimedInterfaceMethodIDsFromRelations covers the A2 (relations) half
// of claimedInterfaceMethodIDs.
func TestClaimedInterfaceMethodIDsFromRelations(t *testing.T) {
	pr := 506
	iface := interfaceMethodBlock(pr)
	order := driverImplBlock(pr, "OrderDriver", "app/Drivers/OrderDriver.php")
	rels := []relations.Relation{{PR: pr, ParentID: order.ID(), ChildID: iface.ID(), Kind: relations.KindInterfaceMethod}}

	claimed := claimedInterfaceMethodIDs(pr, rels, nil)
	if !claimed[iface.ID()] {
		t.Fatalf("want the interface method claimed via the A2 relation, got %+v", claimed)
	}
}
