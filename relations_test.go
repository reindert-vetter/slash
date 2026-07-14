package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/reindert-vetter/tembed"
	"slash/modules/github"
	"slash/modules/relations"
)

// writeFixtureRepo lays out a head worktree under dataDir for pr with an event
// dispatcher, two listeners (one typed, one mapped via the provider), and an
// EventServiceProvider — enough to exercise every mapping source.
func writeFixtureRepo(t *testing.T, dataDir string, pr int) {
	t.Helper()
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		// Dispatcher: dispatches OrderPaid via event(new …) and OrderShipped via
		// static ::dispatch().
		"app/Actions/PayOrder.php": `<?php
namespace App\Actions;
class PayOrder {
    public function execute() {
        event(new OrderPaid($order));
        OrderShipped::dispatch($order);
    }
}
`,
		// Listener A: matched by its handle() type-hint (OrderPaid).
		"app/Listeners/SendInvoice.php": `<?php
namespace App\Listeners;
class SendInvoice {
    public function handle(OrderPaid $event) {
        // send invoice
    }
}
`,
		// Listener B: untyped handle — matched only via the provider $listen map.
		"app/Listeners/NotifyCustomer.php": `<?php
namespace App\Listeners;
class NotifyCustomer {
    public function handle($event) {
        // notify
    }
}
`,
		"app/Providers/EventServiceProvider.php": `<?php
namespace App\Providers;
class EventServiceProvider {
    protected $listen = [
        OrderShipped::class => [
            NotifyCustomer::class,
        ],
    ];
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

// fixtureBlocks are the changed blocks matching writeFixtureRepo.
func fixtureBlocks(pr int) (dispatcher, listenerA, listenerB Block) {
	dispatcher = Block{PR: pr, File: "app/Actions/PayOrder.php", Class: "PayOrder", Name: "execute", Category: "ACTION", Side: SideNew, Status: StatusModified}
	listenerA = Block{PR: pr, File: "app/Listeners/SendInvoice.php", Class: "SendInvoice", Name: "handle", Category: "LISTENER", Side: SideNew, Status: StatusModified}
	listenerB = Block{PR: pr, File: "app/Listeners/NotifyCustomer.php", Class: "NotifyCustomer", Name: "handle", Category: "LISTENER", Side: SideNew, Status: StatusModified}
	return
}

func hasEdge(rels []relations.Relation, parent, child Block) bool {
	for _, r := range rels {
		if r.ParentID == parent.ID() && r.ChildID == child.ID() && r.Kind == relations.KindEventListener {
			return true
		}
	}
	return false
}

func TestBuildRelationsEventListener(t *testing.T) {
	dataDir := t.TempDir()
	pr := 42
	writeFixtureRepo(t, dataDir, pr)
	dispatcher, listenerA, listenerB := fixtureBlocks(pr)

	// Both mapping sources: type-hint (A) and provider $listen (B).
	rels := buildRelations(dataDir, pr, []Block{dispatcher, listenerA, listenerB})
	if len(rels) != 2 {
		t.Fatalf("got %d relations, want 2: %+v", len(rels), rels)
	}
	if !hasEdge(rels, dispatcher, listenerA) {
		t.Errorf("missing edge dispatcher→SendInvoice (type-hint path)")
	}
	if !hasEdge(rels, dispatcher, listenerB) {
		t.Errorf("missing edge dispatcher→NotifyCustomer (provider path)")
	}
}

func TestBuildRelationsBothSidesRequired(t *testing.T) {
	dataDir := t.TempDir()
	pr := 43
	writeFixtureRepo(t, dataDir, pr)
	dispatcher, listenerA, _ := fixtureBlocks(pr)

	// Listener B's handle is NOT a changed block → no edge for it, even though the
	// provider maps it. Only the changed listener (A) couples.
	rels := buildRelations(dataDir, pr, []Block{dispatcher, listenerA})
	if len(rels) != 1 || !hasEdge(rels, dispatcher, listenerA) {
		t.Fatalf("want exactly the SendInvoice edge, got %+v", rels)
	}

	// No dispatcher block → nothing dispatches → no edges at all.
	rels = buildRelations(dataDir, pr, []Block{listenerA})
	if len(rels) != 0 {
		t.Fatalf("want 0 relations without a dispatcher, got %+v", rels)
	}
}

func TestRelationsModuleRoundTrip(t *testing.T) {
	m, err := relations.Open(filepath.Join(t.TempDir(), "relations.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	rels := []relations.Relation{
		{PR: 1, ParentID: "1:a.php:A::x", ChildID: "1:b.php:B::handle", Kind: relations.KindEventListener},
		{PR: 1, ParentID: "1:a.php:A::x", ChildID: "1:c.php:C::handle", Kind: relations.KindEventListener},
	}
	if err := m.Replace(ctx, 1, rels); err != nil {
		t.Fatal(err)
	}
	got, err := m.List(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("List = %d rows, want 2", len(got))
	}
	// Replace is a full swap for the PR: a smaller set overwrites the larger one.
	if err := m.Replace(ctx, 1, rels[:1]); err != nil {
		t.Fatal(err)
	}
	if got, _ := m.List(ctx, 1); len(got) != 1 {
		t.Fatalf("after shrink List = %d rows, want 1", len(got))
	}
	// A different PR is untouched by another PR's Replace.
	if got, _ := m.List(ctx, 2); len(got) != 0 {
		t.Fatalf("other PR List = %d rows, want 0", len(got))
	}
}

// The build_relations workflow: EnsureRelations starts it, the buildRelations
// Activity runs synchronously and fills the relations read-model.
func TestBuildRelationsWorkflow(t *testing.T) {
	dataDir := t.TempDir()
	pr := 99
	writeFixtureRepo(t, dataDir, pr)
	dispatcher, listenerA, listenerB := fixtureBlocks(pr)

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := replacePRBlocks(db, pr, []Block{dispatcher, listenerA, listenerB}); err != nil {
		t.Fatal(err)
	}

	rel, err := relations.Open(filepath.Join(dataDir, "relations.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer rel.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), rel, testPRMeta(t), nil, nil, nil, db, dataDir, "test/repo")

	ctx := context.Background()
	m.EnsureRelations(ctx, pr) // initial build runs inside StartWorkflow

	got, err := rel.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("relations read-model has %d rows after build, want 2: %+v", len(got), got)
	}
}
