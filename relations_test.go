package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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

// writeProviderListenerFixtureRepo lays out a head worktree for pr with a
// ServiceProvider that only registers listeners (never dispatches anything
// itself) and one listener whose handle it names — the mirror case of
// writeFixtureRepo's dispatch-site matching.
func writeProviderListenerFixtureRepo(t *testing.T, dataDir string, pr int) {
	t.Helper()
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Providers/EventServiceProvider.php": `<?php
namespace App\Providers;
class EventServiceProvider
{
    protected $listen = [
        OrderCreated::class => [
            SyncOrderFlow::class,
        ],
    ];
}
`,
		"app/Listeners/SyncOrderFlow.php": `<?php
namespace App\Listeners;
class SyncOrderFlow {
    public function handle($event) {
        // sync
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

// providerListenerFixtureBlocks are the changed blocks matching
// writeProviderListenerFixtureRepo.
func providerListenerFixtureBlocks(pr int) (provider, listener Block) {
	provider = Block{PR: pr, File: "app/Providers/EventServiceProvider.php", Class: "EventServiceProvider", Name: classHeaderSentinel, Category: "OTHER", Side: SideNew, Status: StatusModified}
	listener = Block{PR: pr, File: "app/Listeners/SyncOrderFlow.php", Class: "SyncOrderFlow", Name: "handle", Category: "LISTENER", Side: SideNew, Status: StatusAdded}
	return
}

func TestBuildRelationsProviderListener(t *testing.T) {
	dataDir := t.TempDir()
	pr := 44
	writeProviderListenerFixtureRepo(t, dataDir, pr)
	provider, listener := providerListenerFixtureBlocks(pr)

	rels := buildRelations(dataDir, pr, []Block{provider, listener})
	if len(rels) != 1 || !hasEdge(rels, provider, listener) {
		t.Fatalf("want exactly the provider→SyncOrderFlow edge, got %+v", rels)
	}
}

func TestBuildRelationsProviderListenerBothSidesRequired(t *testing.T) {
	dataDir := t.TempDir()
	pr := 45
	writeProviderListenerFixtureRepo(t, dataDir, pr)
	provider, _ := providerListenerFixtureBlocks(pr)

	// The listener's handle is NOT a changed block → the $listen registration
	// alone must not produce an edge, even though the ServiceProvider changed.
	rels := buildRelations(dataDir, pr, []Block{provider})
	if len(rels) != 0 {
		t.Fatalf("want 0 relations without a changed listener, got %+v", rels)
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

// ── Laravel request-lifecycle detectors ─────────────────────────────────────

// writeLaravelFixture lays out a head worktree with a route file, a controller
// whose show() type-hints a FormRequest + an Eloquent model and returns a
// Resource, the FormRequest whose authorize() checks a Policy, and the model,
// resource and policy — enough to exercise all five edges plus the string- and
// resource-route action forms.
func writeLaravelFixture(t *testing.T, dataDir string, pr int) {
	t.Helper()
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"routes/api.php": `<?php
use App\Http\Controllers\ProductGroupController;
Route::get('product-groups/{productGroup}', [ProductGroupController::class, 'show']);
Route::apiResource('promotions', PromotionController::class);
Route::resource('categories', 'CategoryController')->only(['index']);
Route::get('legacy', 'App\Http\Controllers\LegacyController@index');
`,
		"app/Http/Controllers/ProductGroupController.php": `<?php
namespace App\Http\Controllers;
class ProductGroupController {
    public function show(ProductGroupShowRequest $request, ProductGroup $productGroup): ProductGroupResource {
        return ProductGroupResource::make($productGroup);
    }
}
`,
		"app/Http/Controllers/PromotionController.php": `<?php
namespace App\Http\Controllers;
class PromotionController {
    public function index() { return []; }
}
`,
		"app/Http/Controllers/LegacyController.php": `<?php
namespace App\Http\Controllers;
class LegacyController {
    public function index() { return []; }
}
`,
		"app/Http/Controllers/CategoryController.php": `<?php
namespace App\Http\Controllers;
class CategoryController {
    public function index() { return []; }
}
`,
		"app/Http/Requests/ProductGroupShowRequest.php": `<?php
namespace App\Http\Requests;
class ProductGroupShowRequest {
    public function authorize() {
        return user()->can('show', ProductGroupPolicy::class);
    }
    public function rules() { return []; }
}
`,
		"app/Http/Resources/ProductGroupResource.php": `<?php
namespace App\Http\Resources;
class ProductGroupResource {
    public function toArray($request) { return []; }
}
`,
		"app/Models/ProductGroup.php": `<?php
namespace App\Models;
class ProductGroup {
    public function scopeActive($q) { return $q; }
}
`,
		"app/Policies/ProductGroupPolicy.php": `<?php
namespace App\Policies;
class ProductGroupPolicy {
    public function show($user) { return true; }
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

// laravelFixtureBlocks are the changed (new-side) blocks matching writeLaravelFixture.
func laravelFixtureBlocks(pr int) []Block {
	nb := func(file, class, name, cat string) Block {
		return Block{PR: pr, File: file, Class: class, Name: name, Category: cat, Side: SideNew, Status: StatusModified}
	}
	return []Block{
		nb("routes/api.php", "", "api.php", "ROUTE"),
		nb("app/Http/Controllers/ProductGroupController.php", "ProductGroupController", "show", "CONTROLLER"),
		nb("app/Http/Controllers/PromotionController.php", "PromotionController", "index", "CONTROLLER"),
		nb("app/Http/Controllers/LegacyController.php", "LegacyController", "index", "CONTROLLER"),
		nb("app/Http/Controllers/CategoryController.php", "CategoryController", "index", "CONTROLLER"),
		nb("app/Http/Requests/ProductGroupShowRequest.php", "ProductGroupShowRequest", "authorize", "REQUEST"),
		nb("app/Http/Requests/ProductGroupShowRequest.php", "ProductGroupShowRequest", "rules", "REQUEST"),
		nb("app/Http/Resources/ProductGroupResource.php", "ProductGroupResource", "toArray", "RESOURCE"),
		nb("app/Models/ProductGroup.php", "ProductGroup", "scopeActive", "MODEL"),
		nb("app/Policies/ProductGroupPolicy.php", "ProductGroupPolicy", "show", "POLICY"),
	}
}

func blockBy(blocks []Block, class, name string) Block {
	for _, b := range blocks {
		if b.Class == class && b.Name == name {
			return b
		}
	}
	return Block{}
}

func hasKindEdge(rels []relations.Relation, parent, child Block, kind string) bool {
	for _, r := range rels {
		if r.ParentID == parent.ID() && r.ChildID == child.ID() && r.Kind == kind {
			return true
		}
	}
	return false
}

func countKind(rels []relations.Relation, kind string) int {
	n := 0
	for _, r := range rels {
		if r.Kind == kind {
			n++
		}
	}
	return n
}

func TestBuildRelationsLaravelChain(t *testing.T) {
	dataDir := t.TempDir()
	pr := 55
	writeLaravelFixture(t, dataDir, pr)
	blocks := laravelFixtureBlocks(pr)
	rels := buildRelations(dataDir, pr, blocks)

	route := blockBy(blocks, "", "api.php")
	ctrl := blockBy(blocks, "ProductGroupController", "show")
	promo := blockBy(blocks, "PromotionController", "index")
	legacy := blockBy(blocks, "LegacyController", "index")
	category := blockBy(blocks, "CategoryController", "index")
	authorize := blockBy(blocks, "ProductGroupShowRequest", "authorize")
	rules := blockBy(blocks, "ProductGroupShowRequest", "rules")
	resource := blockBy(blocks, "ProductGroupResource", "toArray")
	model := blockBy(blocks, "ProductGroup", "scopeActive")
	policy := blockBy(blocks, "ProductGroupPolicy", "show")

	// route → controller: array-callable, apiResource, string-callable.
	if !hasKindEdge(rels, route, ctrl, relations.KindRouteController) {
		t.Errorf("missing route→controller (array-callable) edge")
	}
	if !hasKindEdge(rels, route, promo, relations.KindRouteController) {
		t.Errorf("missing route→controller (apiResource) edge")
	}
	if !hasKindEdge(rels, route, legacy, relations.KindRouteController) {
		t.Errorf("missing route→controller (string-callable) edge")
	}
	if !hasKindEdge(rels, route, category, relations.KindRouteController) {
		t.Errorf("missing route→controller (string-resource) edge")
	}
	// controller → request (both methods of the request are changed → both surface).
	if !hasKindEdge(rels, ctrl, authorize, relations.KindControllerRequest) {
		t.Errorf("missing controller→request(authorize) edge")
	}
	if !hasKindEdge(rels, ctrl, rules, relations.KindControllerRequest) {
		t.Errorf("missing controller→request(rules) edge")
	}
	// controller → resource / model.
	if !hasKindEdge(rels, ctrl, resource, relations.KindControllerResource) {
		t.Errorf("missing controller→resource edge")
	}
	if !hasKindEdge(rels, ctrl, model, relations.KindControllerModel) {
		t.Errorf("missing controller→model edge")
	}
	// request → policy: authorize()'s ->can('show', ProductGroupPolicy::class).
	if !hasKindEdge(rels, authorize, policy, relations.KindRequestPolicy) {
		t.Errorf("missing request(authorize)→policy(show) edge")
	}
	// The policy edge hangs off authorize, not rules.
	if hasKindEdge(rels, rules, policy, relations.KindRequestPolicy) {
		t.Errorf("policy edge should not hang off rules()")
	}
}

// TestBuildRelationsLaravelChainCapturesLine verifies that every detector
// anchors its relation to the real absolute line of its own regex match (see
// matchLine/blockText in relations.go) — the frontend's group-scoping/
// reordering of the "Onderliggende code" panel (detail-layout.md) depends on
// this being the reviewer-visible source line, not e.g. always 0 or the
// block's own (possibly stale) declaration line. Checked against a line found
// independently by scanning the fixture's own raw source, so this fails if
// the anchor drifts for any reason — a wrong detector Line, or a wrong
// blockText/matchLine offset.
func TestBuildRelationsLaravelChainCapturesLine(t *testing.T) {
	dataDir := t.TempDir()
	pr := 61
	writeLaravelFixture(t, dataDir, pr)
	blocks := laravelFixtureBlocks(pr)
	rels := buildRelations(dataDir, pr, blocks)

	ctrl := blockBy(blocks, "ProductGroupController", "show")
	resource := blockBy(blocks, "ProductGroupResource", "toArray")

	_, headDir := worktreeDirs(dataDir, pr)
	raw, err := os.ReadFile(filepath.Join(headDir, "app/Http/Controllers/ProductGroupController.php"))
	if err != nil {
		t.Fatal(err)
	}
	wantLine := 0
	for i, line := range strings.Split(string(raw), "\n") {
		if strings.Contains(line, "ProductGroupResource::make") {
			wantLine = i + 1
			break
		}
	}
	if wantLine == 0 {
		t.Fatal("fixture line for ProductGroupResource::make not found")
	}

	got, found := -1, false
	for _, r := range rels {
		if r.ParentID == ctrl.ID() && r.ChildID == resource.ID() && r.Kind == relations.KindControllerResource {
			got, found = r.Line, true
		}
	}
	if !found {
		t.Fatalf("controller_resource edge not found: %+v", rels)
	}
	if got != wantLine {
		t.Errorf("controller_resource Line = %d, want %d (the ProductGroupResource::make line)", got, wantLine)
	}
}

func TestBuildRelationsLaravelBothSidesRequired(t *testing.T) {
	dataDir := t.TempDir()
	pr := 56
	writeLaravelFixture(t, dataDir, pr)
	all := laravelFixtureBlocks(pr)

	// Drop the policy block: request → policy must not fire (child not changed),
	// but the controller → request edge (its own changed target) still does.
	var noPolicy []Block
	for _, b := range all {
		if b.Class == "ProductGroupPolicy" {
			continue
		}
		noPolicy = append(noPolicy, b)
	}
	rels := buildRelations(dataDir, pr, noPolicy)
	if countKind(rels, relations.KindRequestPolicy) != 0 {
		t.Errorf("request→policy fired without a changed policy block: %+v", rels)
	}
	ctrl := blockBy(all, "ProductGroupController", "show")
	authorize := blockBy(all, "ProductGroupShowRequest", "authorize")
	if !hasKindEdge(rels, ctrl, authorize, relations.KindControllerRequest) {
		t.Errorf("controller→request should still fire without the policy")
	}

	// Only the controller (no route file block) → no route→controller edges, but
	// the controller's own downstream edges (request/resource/model) still fire.
	var noRoute []Block
	for _, b := range all {
		if b.Category == "ROUTE" {
			continue
		}
		noRoute = append(noRoute, b)
	}
	rels = buildRelations(dataDir, pr, noRoute)
	if countKind(rels, relations.KindRouteController) != 0 {
		t.Errorf("route→controller fired without a changed route block: %+v", rels)
	}
	if countKind(rels, relations.KindControllerResource) != 1 {
		t.Errorf("controller→resource should still fire without the route: %+v", rels)
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
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), rel, testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, db, dataDir, "test/repo")

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

// TestBuildRelationsLaravelWorkflow: the same Activity fills the read-model with
// the full route → controller → request/resource/model + request → policy chain.
func TestBuildRelationsLaravelWorkflow(t *testing.T) {
	dataDir := t.TempDir()
	pr := 77
	writeLaravelFixture(t, dataDir, pr)
	blocks := laravelFixtureBlocks(pr)

	db, err := openDB(filepath.Join(dataDir, "graph.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := replacePRBlocks(db, pr, blocks); err != nil {
		t.Fatal(err)
	}

	rel, err := relations.Open(filepath.Join(dataDir, "relations.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer rel.Close()

	engine := tembed.New(tembed.NewMemoryStore())
	m := NewTaskManager(engine, &github.Fake{}, nil, testInbox(t), rel, testPRMeta(t), nil, nil, nil, nil, nil, nil, nil, db, dataDir, "test/repo")

	ctx := context.Background()
	m.EnsureRelations(ctx, pr)

	got, err := rel.List(ctx, pr)
	if err != nil {
		t.Fatal(err)
	}
	// 4 route→controller + 2 controller→request + 1 resource + 1 model + 1 policy.
	if len(got) != 9 {
		t.Fatalf("relations read-model has %d rows, want 9: %+v", len(got), got)
	}
}
