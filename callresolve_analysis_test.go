package main

import (
	"os"
	"path/filepath"
	"strings"
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

// TestResolveCallsTestHelperClassIndexed: a custom test-base class (tests/
// TestCase.php) is real app code, not vendor — buildSymbolIndex must index
// tests/ so a call to an inherited test helper (unresolvable via the $this->
// own-class rule, since the caller test class doesn't define it directly)
// still resolves uniquely via the generic ->m() candidate rule, instead of
// forcing an unnecessary LLM escalation. Regression guard for the idxSkipDirs
// fix (tests/ used to be skipped entirely).
func TestResolveCallsTestHelperClassIndexed(t *testing.T) {
	dataDir := t.TempDir()
	pr := 8
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"tests/Feature/OrderTest.php": `<?php
namespace Tests\Feature;
class OrderTest {
    public function it_works() {
        $this->actingAsUser();
    }
}
`,
		"tests/TestCase.php": `<?php
namespace Tests;
class TestCase {
    public function actingAsUser() {}
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
	caller := Block{PR: pr, File: "tests/Feature/OrderTest.php", Class: "OrderTest", Name: "it_works", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "actingAsUser")
	if !ok {
		t.Fatalf("no entry for call %q", "actingAsUser")
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("actingAsUser: status = %q, want %q (tests/ must be indexed)", e.Status, callresolve.StatusResolved)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "TestCase::actingAsUser" {
		t.Fatalf("actingAsUser: child = %q, want %q", got, "TestCase::actingAsUser")
	}
}

// TestResolveCallsChangedLinesOnly: when a base worktree exists, only calls on
// lines the PR changed produce entries — a call on an untouched line must not
// surface as underlying code (that was the unrelated-children bug).
func TestResolveCallsChangedLinesOnly(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13
	baseDir, headDir := worktreeDirs(dataDir, pr)
	callerBase := `<?php
namespace App\Services;
class OrderService {
    public function build() {
        $this->prepare();
        $rows = $q->join('contracts');
    }
    public function prepare() {}
    public function join($t) {}
}
`
	// The head version only changes the ->where line; ->join stays untouched.
	callerHead := `<?php
namespace App\Services;
class OrderService {
    public function build() {
        $this->prepare();
        $rows = $q->join('contracts');
        $rows->where('type', 'billing');
    }
    public function prepare() {}
    public function join($t) {}
}
`
	for dir, body := range map[string]string{baseDir: callerBase, headDir: callerHead} {
		p := filepath.Join(dir, "app/Services/OrderService.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Services/OrderService.php", Class: "OrderService", Name: "build", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	// join and prepare sit on unchanged lines → no entries, even though both
	// would statically resolve.
	for _, key := range []string{"join", "prepare"} {
		if _, ok := findEntry(entries, key); ok {
			t.Errorf("call %q sits on an unchanged line but produced an entry", key)
		}
	}
	// where sits on the changed line; nothing in the app defines it → unresolved
	// (the panel offers the LLM search instead of showing nothing).
	if e, ok := findEntry(entries, "where"); !ok {
		t.Error("no entry for call 'where' on the changed line")
	} else if e.Status != callresolve.StatusUnresolved {
		t.Errorf("where: status=%q, want unresolved", e.Status)
	}
}

// TestResolveCallsEnumCase covers an enum case reference on a changed line —
// AddressType::BILLING — resolving to the enum declaration.
func TestResolveCallsEnumCase(t *testing.T) {
	dataDir := t.TempDir()
	pr := 15
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Http/Controllers/UserV3Controller.php": `<?php
namespace App\Http\Controllers;
class UserV3Controller {
    public function hydrate() {
        $q->where('type', AddressType::BILLING);
        $name = AddressType::class;
    }
}
`,
		"app/Enums/AddressType.php": `<?php
namespace App\Enums;
enum AddressType: string
{
    case BILLING = 'billing';
    case SHIPPING = 'shipping';
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

	caller := Block{PR: pr, File: "app/Http/Controllers/UserV3Controller.php", Class: "UserV3Controller", Name: "hydrate", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "BILLING")
	if !ok {
		t.Fatal("no entry for enum case 'BILLING'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("BILLING: status=%q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "AddressType::BILLING" {
		t.Errorf("BILLING: child=%q, want AddressType::BILLING", got)
	}
	if !strings.Contains(e.ChildCode, "case BILLING") {
		t.Errorf("BILLING: child code missing the enum body, got %q", e.ChildCode)
	}
	// Foo::class is not a case reference.
	if _, ok := findEntry(entries, "class"); ok {
		t.Error("AddressType::class should not produce an entry")
	}
}

// TestResolveCallsReceiverVar covers a method call whose receiver variable
// names its class — $order->billingAddress() resolves to Order::billingAddress
// even though Invoice defines the same method (globally ambiguous).
func TestResolveCallsReceiverVar(t *testing.T) {
	dataDir := t.TempDir()
	pr := 17
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Actions/FinalizeOrderInvoice.php": `<?php
namespace App\Actions;
class FinalizeOrderInvoice {
    public static function execute(Order $order): void {
        $order->billingAddress()->update(['signup_token' => $order->reference]);
    }
}
`,
		"app/Models/Order.php": `<?php
namespace App\Models;
class Order {
    public function billingAddress(): MorphOne {
        return $this->morphOne(Address::class, 'addressable');
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

	caller := Block{PR: pr, File: "app/Actions/FinalizeOrderInvoice.php", Class: "FinalizeOrderInvoice", Name: "execute", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "billingAddress")
	if !ok {
		t.Fatal("no entry for call 'billingAddress'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("billingAddress: status=%q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "Order::billingAddress" {
		t.Errorf("billingAddress: child=%q, want Order::billingAddress", got)
	}
}

// TestResolveCallsMacro covers a ->name( call resolving to a Laravel macro
// (Receiver::macro('name', function ...)), which lives inside a boot method's
// body and is therefore invisible to ScanBlocks.
func TestResolveCallsMacro(t *testing.T) {
	dataDir := t.TempDir()
	pr := 11
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Exports/ContractsExport.php": `<?php
namespace App\Exports;
class ContractsExport {
    public function query() {
        return Contract::query()->joinAddress('order');
    }
}
`,
		"app/Providers/MacroServiceProvider.php": `<?php
namespace App\Providers;
use Illuminate\Database\Query\Builder;
class MacroServiceProvider {
    private function bootBuilderMacros(): void {
        Builder::macro('joinIfNeeded', function (...$params) {
            return $this;
        });
        Builder::macro('joinAddress', function (string $morphAlias, ?AddressType $type = null): Builder {
            return $this->joinPolymorphic('addresses', 'addressable', $morphAlias);
        });
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

	caller := Block{PR: pr, File: "app/Exports/ContractsExport.php", Class: "ContractsExport", Name: "query", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "joinAddress")
	if !ok {
		t.Fatal("no entry for macro call 'joinAddress'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("joinAddress: status=%q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "Builder::joinAddress" {
		t.Errorf("joinAddress: child=%q, want Builder::joinAddress", got)
	}
	if e.ChildCode == "" || !strings.Contains(e.ChildCode, "joinPolymorphic") {
		t.Errorf("joinAddress: child code missing the macro body, got %q", e.ChildCode)
	}
}

// TestResolveCallsFacade covers a Laravel facade static call
// (AccountingClient::providers()) resolving to the accessor class's method
// (AccountingDriver::providers) — the facade forwards its static calls to the
// class getFacadeAccessor() returns.
func TestResolveCallsFacade(t *testing.T) {
	dataDir := t.TempDir()
	pr := 21
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Actions/ResetTenancyAction.php": `<?php
namespace App\Actions;
use Modules\Accounting\Client\AccountingClient;
class ResetTenancyAction {
    public function execute() {
        AccountingClient::providers()->forgetDrivers();
    }
}
`,
		"modules/Accounting/Client/AccountingClient.php": `<?php
namespace Modules\Accounting\Client;
use Illuminate\Support\Facades\Facade;
final class AccountingClient extends Facade {
    protected static function getFacadeAccessor(): string {
        return AccountingDriver::class;
    }
}
`,
		"modules/Accounting/Client/AccountingDriver.php": `<?php
namespace Modules\Accounting\Client;
final class AccountingDriver {
    public static function providers(): AccountingProviderService {
        return app(AccountingProviderService::class);
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

	caller := Block{PR: pr, File: "app/Actions/ResetTenancyAction.php", Class: "ResetTenancyAction", Name: "execute", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "providers")
	if !ok {
		t.Fatal("no entry for facade call 'providers'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("providers: status=%q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "AccountingDriver::providers" {
		t.Errorf("providers: child=%q, want AccountingDriver::providers", got)
	}
	if e.ChildCode == "" {
		t.Error("providers: resolved entry has empty child code")
	}
	// forgetDrivers is a framework Manager method (vendor not indexed) → unresolved.
	if f, ok := findEntry(entries, "forgetDrivers"); ok && f.Status != callresolve.StatusUnresolved {
		t.Errorf("forgetDrivers: status=%q, want unresolved", f.Status)
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
        $upsell->save($model->shippingAddress);
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
    public function shippingAddress(): MorphOne {
        return $this->morphOne(Address::class, 'addressable');
    }
}
`,
		"app/Models/Order2.php": `<?php
namespace App\Models;
class Order2 {
    public function shippingAddress(): MorphOne {
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

	// billingAddress: relationship on both Order and Invoice, but the receiver
	// variable names its model ($order) → resolved to Order::billingAddress.
	if e, ok := findEntry(entries, "billingAddress"); !ok {
		t.Error("no entry for magic property 'billingAddress'")
	} else if e.Status != callresolve.StatusResolved || e.ChildClass+"::"+e.ChildMethod != "Order::billingAddress" {
		t.Errorf("billingAddress: status=%q child=%s::%s, want resolved Order::billingAddress", e.Status, e.ChildClass, e.ChildMethod)
	}

	// shippingAddress: relationship on Invoice and Order2, receiver $model names
	// no known class → still ambiguous → unresolved.
	if e, ok := findEntry(entries, "shippingAddress"); !ok {
		t.Error("no entry for magic property 'shippingAddress'")
	} else if e.Status != callresolve.StatusUnresolved {
		t.Errorf("shippingAddress: status=%q, want unresolved", e.Status)
	}

	// total: no method named total anywhere → plain attribute, ignored.
	if _, ok := findEntry(entries, "total"); ok {
		t.Error("plain attribute 'total' should not produce a call entry")
	}
}

// TestResolveCallsScheduledCommand: a scheduled `->command('accounting:import …')`
// call resolves to the artisan command class's handle method, keyed by the
// command name so distinct scheduled commands stay separate. A framework command
// (no class in the app) becomes unresolved, and the generic "command" method key
// is suppressed.
func TestResolveCallsScheduledCommand(t *testing.T) {
	dataDir := t.TempDir()
	pr := 44
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"modules/Accounting/Internal/Providers/AccountingServiceProvider.php": `<?php
namespace Modules\Accounting\Internal\Providers;
class AccountingServiceProvider {
    private function scheduleCommands(): void {
        $schedule = app(Schedule::class);
        $schedule->command('accounting:import --provider=moneybird --limit=100')->everyTenMinutes();
        $schedule->command('accounting:import 3 --provider=reeleezee --limit=30 --force')->everyFiveMinutes();
        $schedule->command('queue:work')->everyMinute();
    }
}
`,
		"modules/Accounting/Internal/Commands/AccountingImport.php": `<?php
namespace Modules\Accounting\Internal\Commands;
class AccountingImport {
    protected $signature = 'accounting:import {tenantId?} {--provider=} {--limit=} {--force}';
    public function handle(): int {
        return 0;
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
	caller := Block{PR: pr, File: "modules/Accounting/Internal/Providers/AccountingServiceProvider.php", Class: "AccountingServiceProvider", Name: "scheduleCommands", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	// accounting:import (scheduled twice) resolves to the command's handle, once.
	e, ok := findEntry(entries, "accounting:import")
	if !ok {
		t.Fatal("no entry for scheduled command accounting:import")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("accounting:import: status=%q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "AccountingImport::handle" {
		t.Errorf("accounting:import: child=%q, want AccountingImport::handle", got)
	}
	if e.ChildCode == "" {
		t.Error("accounting:import: resolved entry has empty child code")
	}

	// queue:work has no command class in the app → unresolved (LLM territory).
	if e, ok := findEntry(entries, "queue:work"); !ok {
		t.Error("no entry for scheduled command queue:work")
	} else if e.Status != callresolve.StatusUnresolved {
		t.Errorf("queue:work: status=%q, want unresolved", e.Status)
	}

	// The generic ->command( arrow call must not surface as its own child.
	if _, ok := findEntry(entries, "command"); ok {
		t.Error("generic 'command' method key should be suppressed")
	}
}

// TestResolveCallsConstructor: a bare `new Foo(...)` construction couples to the
// class's constructor (__construct) — e.g. new PluginDisabledNotification(...)
// shows that notification's definition as underlying code. A class without an
// explicit constructor produces no entry.
func TestResolveCallsConstructor(t *testing.T) {
	dataDir := t.TempDir()
	pr := 42
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Actions/DisablePlugin.php": `<?php
namespace App\Actions;
use App\Notifications\PluginDisabledNotification;
class DisablePlugin {
    public function execute($plugin, $error) {
        $plugin->tenant->notifyOwner(new PluginDisabledNotification($plugin, $error));
        $bare = new PlainThing();
    }
}
`,
		"app/Notifications/PluginDisabledNotification.php": `<?php
namespace App\Notifications;
class PluginDisabledNotification {
    public function __construct($plugin, $error) {}
}
`,
		"app/Support/PlainThing.php": `<?php
namespace App\Support;
class PlainThing {
    public function run() {}
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
	caller := Block{PR: pr, File: "app/Actions/DisablePlugin.php", Class: "DisablePlugin", Name: "execute", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "PluginDisabledNotification")
	if !ok {
		t.Fatal("no entry for constructor call PluginDisabledNotification")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("status = %q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "PluginDisabledNotification::__construct" {
		t.Errorf("child = %q, want PluginDisabledNotification::__construct", got)
	}
	if e.ChildCode == "" {
		t.Error("resolved constructor entry has empty child code")
	}
	// A class without an explicit constructor has no definition to point at.
	if _, ok := findEntry(entries, "PlainThing"); ok {
		t.Error("new PlainThing() (no __construct) should not produce a call entry")
	}
}

// TestResolveCallsModelUsage: a controller that instantiates + statically calls
// an Eloquent model (app/Models/) gets ONE deduped child pointing at the whole
// model — never the constructor, even when the model defines one explicitly —
// while unrelated method calls on the model variable (fill/save, both
// unresolved: they are inherited from Eloquent's base class and never defined
// in the app) and a resource-class resolution are left untouched.
func TestResolveCallsModelUsage(t *testing.T) {
	dataDir := t.TempDir()
	pr := 55
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Http/Controllers/ProductGroupController.php": `<?php
namespace App\Http\Controllers;
class ProductGroupController {
    public function store($request) {
        $productGroup = new ProductGroup();
        $productGroup->fill($request->validated());
        $productGroup->save();
        $resource = ProductGroupResource::make($productGroup);
        return $resource;
    }
}
`,
		"app/Models/ProductGroup.php": `<?php
namespace App\Models;
class ProductGroup extends Model {
    public function __construct(array $attributes = []) {
        parent::__construct($attributes);
    }
    protected $fillable = ['name'];
}
`,
		"app/Http/Resources/ProductGroupResource.php": `<?php
namespace App\Http\Resources;
class ProductGroupResource {
    public static function make($resource = null) {}
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
	caller := Block{PR: pr, File: "app/Http/Controllers/ProductGroupController.php", Class: "ProductGroupController", Name: "store", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	// Exactly one model child, keyed by the model's short name, whole-class
	// (no method) — not the constructor, despite one existing.
	e, ok := findEntry(entries, "ProductGroup")
	if !ok {
		t.Fatal("no entry for model usage 'ProductGroup'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("ProductGroup: status=%q, want resolved", e.Status)
	}
	if e.ChildClass != "ProductGroup" || e.ChildMethod != "" {
		t.Errorf("ProductGroup: child=%q::%q, want ProductGroup::<empty>", e.ChildClass, e.ChildMethod)
	}
	if e.Kind != callresolve.KindModelUsage {
		t.Errorf("ProductGroup: kind=%q, want %q", e.Kind, callresolve.KindModelUsage)
	}
	if e.ChildCode == "" || !strings.Contains(e.ChildCode, "class ProductGroup") {
		t.Errorf("ProductGroup: child code missing the class body, got %q", e.ChildCode)
	}
	// The whole-class excerpt is expected to span the full class body
	// (including its constructor) — it just isn't the *target* of the edge.
	if !strings.Contains(e.ChildCode, "__construct") {
		t.Errorf("ProductGroup: expected whole-class excerpt to include __construct, got %q", e.ChildCode)
	}

	// Only one "ProductGroup" entry — the static/new usages dedupe into one.
	count := 0
	for _, en := range entries {
		if en.CallKey == "ProductGroup" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("got %d ProductGroup entries, want 1 (deduped)", count)
	}

	// The inherited Eloquent methods stay unresolved — untouched by this change.
	for _, key := range []string{"fill", "save"} {
		e, ok := findEntry(entries, key)
		if !ok {
			t.Fatalf("no entry for %q", key)
		}
		if e.Status != callresolve.StatusUnresolved {
			t.Errorf("%s: status=%q, want unresolved", key, e.Status)
		}
	}

	// The resource resolution is unaffected by the model change.
	res, ok := findEntry(entries, "make")
	if !ok {
		t.Fatal("no entry for 'make'")
	}
	if res.Status != callresolve.StatusResolved || res.ChildClass != "ProductGroupResource" {
		t.Errorf("make: got %+v, want resolved ProductGroupResource::make", res)
	}
}

// TestResolveCallsModelWithoutConstructor: the common case — a model with no
// explicit constructor still surfaces as underlying code (rule 2b's "no
// definition to point at" skip must not apply to models).
func TestResolveCallsModelWithoutConstructor(t *testing.T) {
	dataDir := t.TempDir()
	pr := 56
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Services/OrderCreator.php": `<?php
namespace App\Services;
class OrderCreator {
    public function create($attrs) {
        $order = new Order();
        $order->fill($attrs);
        return $order;
    }
}
`,
		"app/Models/Order.php": `<?php
namespace App\Models;
class Order extends Model {
    protected $fillable = ['total'];
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
	caller := Block{PR: pr, File: "app/Services/OrderCreator.php", Class: "OrderCreator", Name: "create", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "Order")
	if !ok {
		t.Fatal("no entry for model usage 'Order' (no explicit constructor)")
	}
	if e.Status != callresolve.StatusResolved || e.ChildClass != "Order" || e.ChildMethod != "" {
		t.Errorf("Order: got %+v, want resolved Order::<empty>", e)
	}
}

// migrationBlock builds the two blocks (up/down) that classify.go produces for
// a migration file's anonymous `return new class extends Migration { ... }`
// (Class == "", see classify_test.go / the real blocks in data/graph.db).
func migrationUpBlock(pr int, file string) Block {
	return Block{PR: pr, File: file, Class: "", Name: "up", Category: "MIGRATION", Side: SideNew, Status: StatusAdded}
}

func migrationDownBlock(pr int, file string) Block {
	return Block{PR: pr, File: file, Class: "", Name: "down", Category: "MIGRATION", Side: SideNew, Status: StatusAdded}
}

// findCallresolveEntry mirrors findEntry but also filters by caller — needed
// once several migrations share a table-derived call key.
func findCallresolveEntry(entries []callresolve.Entry, callerID, callKey string) (callresolve.Entry, bool) {
	for _, e := range entries {
		if e.CallerID == callerID && e.CallKey == callKey {
			return e, true
		}
	}
	return callresolve.Entry{}, false
}

// TestResolveMigrationModelsConvention: a changed migration's Schema::create
// resolves to the model via the Eloquent naming convention (no explicit
// $table override) — the common case described in
// .claude/rules/tembed-workflows.md, "migration → model": the model itself is
// NOT changed by this PR, so it must still surface as underlying code.
func TestResolveMigrationModelsConvention(t *testing.T) {
	dataDir := t.TempDir()
	pr := 60
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"database/migrations/2026_01_01_000000_create_product_groups_table.php": `<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('product_groups', function (Blueprint $table) {
            $table->id();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('product_groups');
    }
};
`,
		"app/Models/ProductGroup.php": `<?php
namespace App\Models;
class ProductGroup extends Model {
    protected $fillable = ['name'];
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
	migFile := "database/migrations/2026_01_01_000000_create_product_groups_table.php"
	up := migrationUpBlock(pr, migFile)
	down := migrationDownBlock(pr, migFile)

	entries := resolveMigrationModels(dataDir, pr, []Block{up, down})

	e, ok := findCallresolveEntry(entries, up.ID(), "migration_model:product_groups")
	if !ok {
		t.Fatalf("no migration_model entry for product_groups, got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved || e.Kind != callresolve.KindMigrationModel {
		t.Errorf("got status=%q kind=%q, want resolved/%q", e.Status, e.Kind, callresolve.KindMigrationModel)
	}
	if e.ChildClass != "ProductGroup" || e.ChildMethod != "" {
		t.Errorf("child=%q::%q, want ProductGroup::<empty>", e.ChildClass, e.ChildMethod)
	}
	if !strings.Contains(e.ChildCode, "class ProductGroup") {
		t.Errorf("expected whole-class model excerpt, got %q", e.ChildCode)
	}

	// The 'down' block never produces its own entries (only 'up' is scanned).
	for _, en := range entries {
		if en.CallerID == down.ID() {
			t.Errorf("unexpected entry for the 'down' block: %+v", en)
		}
	}
}

// TestResolveMigrationModelsExplicitTable: a model with an explicit
// `protected $table` override wins over the naming convention — a migration
// on 'pg' (which the convention would map to a nonexistent "Pg" class) still
// resolves to the model that declares $table = 'pg'.
func TestResolveMigrationModelsExplicitTable(t *testing.T) {
	dataDir := t.TempDir()
	pr := 61
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"database/migrations/2026_01_02_000000_create_pg_table.php": `<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('pg', function ($table) {
            $table->id();
        });
    }

    public function down(): void
    {
    }
};
`,
		"app/Models/ProductGroup.php": `<?php
namespace App\Models;
class ProductGroup extends Model {
    protected $table = 'pg';
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
	migFile := "database/migrations/2026_01_02_000000_create_pg_table.php"
	up := migrationUpBlock(pr, migFile)

	entries := resolveMigrationModels(dataDir, pr, []Block{up})

	e, ok := findCallresolveEntry(entries, up.ID(), "migration_model:pg")
	if !ok {
		t.Fatalf("no migration_model entry for 'pg', got %+v", entries)
	}
	if e.ChildClass != "ProductGroup" {
		t.Errorf("child class=%q, want ProductGroup (via explicit $table override)", e.ChildClass)
	}
}

// TestResolveMigrationModelsMultipleTablesDeduped: a migration touching two
// tables (Schema::create + Schema::table) gets one deduped child per table;
// an unmappable table produces no entry (no LLM fallback — stays silent).
func TestResolveMigrationModelsMultipleTablesDeduped(t *testing.T) {
	dataDir := t.TempDir()
	pr := 62
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"database/migrations/2026_01_03_000000_link_contracts_and_orders.php": `<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('contracts', function ($table) {
            $table->string('proration')->nullable();
        });
        Schema::table('contracts', function ($table) {
            $table->string('extra')->nullable();
        });
        Schema::table('mystery_widgets', function ($table) {
            $table->string('foo')->nullable();
        });
    }

    public function down(): void
    {
    }
};
`,
		"app/Models/Contract.php": `<?php
namespace App\Models;
class Contract extends Model {
    protected $fillable = ['proration'];
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
	migFile := "database/migrations/2026_01_03_000000_link_contracts_and_orders.php"
	up := migrationUpBlock(pr, migFile)

	entries := resolveMigrationModels(dataDir, pr, []Block{up})

	count := 0
	for _, en := range entries {
		if en.CallKey == "migration_model:contracts" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("got %d 'contracts' entries, want 1 (deduped across two Schema::table calls)", count)
	}
	if _, ok := findCallresolveEntry(entries, up.ID(), "migration_model:mystery_widgets"); ok {
		t.Error("expected no entry for an unmappable table ('mystery_widgets' has no model) — should stay silent, not unresolved")
	}
	if len(entries) != 1 {
		t.Errorf("got %d total entries, want exactly 1 (contracts only)", len(entries))
	}
}

// TestResolveDataProviders: a PHPUnit test method's #[DataProvider('name')]
// attribute or legacy "@dataProvider name" docblock resolves to the provider
// method — even though the provider is NOT itself changed by this PR in the
// usual case (this fixture marks every method as changed for simplicity, but
// resolveDataProviders never requires that: it only reads the CALLER's own
// zone). A name that doesn't match any method on the test's own class (a
// typo, or an external provider) silently produces no entry — never an
// "unresolved" row, since there is no ambiguity to hand to an LLM.
func TestResolveDataProviders(t *testing.T) {
	dataDir := t.TempDir()
	pr := 70
	_, headDir := worktreeDirs(dataDir, pr)
	relFile := "tests/Feature/PermissionTest.php"
	src := `<?php
namespace Tests\Feature;

use PHPUnit\Framework\TestCase;

class PermissionTest extends TestCase
{
    #[DataProvider('permissionAccessDataProvider')]
    public function testPermissionAccessAttribute($perm)
    {
        $this->assertTrue(true);
    }

    /**
     * @dataProvider oldStyleProvider
     */
    public function testPermissionAccessDocblock($perm)
    {
        $this->assertTrue(true);
    }

    #[DataProvider('doesNotExist')]
    public function testPermissionAccessTypo($perm)
    {
        $this->assertTrue(true);
    }

    public function permissionAccessDataProvider(): array
    {
        return [[true]];
    }

    public function oldStyleProvider(): array
    {
        return [[false]];
    }
}
`
	p := filepath.Join(headDir, relFile)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	blocks := testCoversBlocks(t, dataDir, pr, relFile)
	entries := resolveDataProviders(dataDir, pr, blocks)

	attrCaller, ok := blockByName(blocks, "PermissionTest::testPermissionAccessAttribute")
	if !ok {
		t.Fatalf("fixture scan did not find testPermissionAccessAttribute, got %v", symbols(blocks))
	}
	e, ok := findCallresolveEntry(entries, attrCaller.ID(), "data_provider:permissionAccessDataProvider")
	if !ok {
		t.Fatalf("no data_provider entry for the #[DataProvider(...)] attribute, got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved || e.Kind != callresolve.KindDataProvider {
		t.Errorf("got status=%q kind=%q, want resolved/%q", e.Status, e.Kind, callresolve.KindDataProvider)
	}
	if e.ChildClass != "PermissionTest" || e.ChildMethod != "permissionAccessDataProvider" {
		t.Errorf("child=%q::%q, want PermissionTest::permissionAccessDataProvider", e.ChildClass, e.ChildMethod)
	}
	if !strings.Contains(e.ChildCode, "function permissionAccessDataProvider") {
		t.Errorf("expected the provider method's own source, got %q", e.ChildCode)
	}

	docCaller, ok := blockByName(blocks, "PermissionTest::testPermissionAccessDocblock")
	if !ok {
		t.Fatalf("fixture scan did not find testPermissionAccessDocblock, got %v", symbols(blocks))
	}
	e2, ok := findCallresolveEntry(entries, docCaller.ID(), "data_provider:oldStyleProvider")
	if !ok {
		t.Fatalf("no data_provider entry for the legacy @dataProvider docblock, got %+v", entries)
	}
	if e2.ChildMethod != "oldStyleProvider" {
		t.Errorf("child method=%q, want oldStyleProvider", e2.ChildMethod)
	}

	typoCaller, ok := blockByName(blocks, "PermissionTest::testPermissionAccessTypo")
	if !ok {
		t.Fatalf("fixture scan did not find testPermissionAccessTypo, got %v", symbols(blocks))
	}
	for _, en := range entries {
		if en.CallerID == typoCaller.ID() {
			t.Errorf("expected silence for an unresolvable provider name, got %+v", en)
		}
	}
}

// TestResolveCallsFoldsLeadingPHPDocInChildCode: a resolved method_call child
// whose definition carries a leading PHPDoc gets the same @return/@param
// signature fold applied to its embedded ChildCode that an active (changed)
// block's diff gets via /api/code — see codesig.go/enrichedCodeSide and
// .claude/rules/blocks-and-ingest.md ("PHPDoc-types in de signatuur vouwen").
// ChildLine must shift by the same removed-line count as the doc.
func TestResolveCallsFoldsLeadingPHPDocInChildCode(t *testing.T) {
	dataDir := t.TempDir()
	pr := 71
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Services/OrderService.php": `<?php
namespace App\Services;
class OrderService {
    public function build() {
        Helper::compute($this->items);
    }
}
`,
		"app/Support/Helper.php": "<?php\n" +
			"namespace App\\Support;\n" +
			"class Helper {\n" +
			"    /**\n" +
			"     * @param array $items\n" +
			"     * @return array\n" +
			"     */\n" +
			"    public static function compute($items)\n" +
			"    {\n" +
			"        return $items;\n" +
			"    }\n" +
			"}\n",
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
	caller := Block{PR: pr, File: "app/Services/OrderService.php", Class: "OrderService", Name: "build", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})
	e, ok := findEntry(entries, "compute")
	if !ok {
		t.Fatalf("no entry for call %q, got %+v", "compute", entries)
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("status = %q, want resolved", e.Status)
	}
	if strings.Contains(e.ChildCode, "/**") || strings.Contains(e.ChildCode, "@param") {
		t.Errorf("ChildCode still carries the PHPDoc, got %q", e.ChildCode)
	}
	if !strings.Contains(e.ChildCode, "function compute(array $items): array") {
		t.Errorf("ChildCode signature not folded, got %q", e.ChildCode)
	}
	if e.ChildLine != 8 {
		t.Errorf("ChildLine = %d, want 8 (the doc's 4 removed lines shift the def from line 4 to line 8)", e.ChildLine)
	}
}

// TestResolveDataProvidersFoldsLeadingPHPDocInChildCode mirrors
// TestResolveCallsFoldsLeadingPHPDocInChildCode for the data_provider rule
// (resolveDataProviders), which writes its own ChildCode/ChildLine separately
// from emitKind.
func TestResolveDataProvidersFoldsLeadingPHPDocInChildCode(t *testing.T) {
	dataDir := t.TempDir()
	pr := 72
	_, headDir := worktreeDirs(dataDir, pr)
	relFile := "tests/Feature/PermissionTest.php"
	src := "<?php\n" +
		"namespace Tests\\Feature;\n" +
		"\n" +
		"use PHPUnit\\Framework\\TestCase;\n" +
		"\n" +
		"class PermissionTest extends TestCase\n" +
		"{\n" +
		"    #[DataProvider('permissionAccessDataProvider')]\n" +
		"    public function testPermissionAccessAttribute($perm)\n" +
		"    {\n" +
		"        $this->assertTrue(true);\n" +
		"    }\n" +
		"\n" +
		"    /**\n" +
		"     * @return array\n" +
		"     */\n" +
		"    public function permissionAccessDataProvider()\n" +
		"    {\n" +
		"        return [[true]];\n" +
		"    }\n" +
		"}\n"
	p := filepath.Join(headDir, relFile)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	blocks := testCoversBlocks(t, dataDir, pr, relFile)
	entries := resolveDataProviders(dataDir, pr, blocks)

	caller, ok := blockByName(blocks, "PermissionTest::testPermissionAccessAttribute")
	if !ok {
		t.Fatalf("fixture scan did not find testPermissionAccessAttribute, got %v", symbols(blocks))
	}
	e, ok := findCallresolveEntry(entries, caller.ID(), "data_provider:permissionAccessDataProvider")
	if !ok {
		t.Fatalf("no data_provider entry for permissionAccessDataProvider, got %+v", entries)
	}
	if strings.Contains(e.ChildCode, "/**") || strings.Contains(e.ChildCode, "@return") {
		t.Errorf("ChildCode still carries the PHPDoc, got %q", e.ChildCode)
	}
	if !strings.Contains(e.ChildCode, "function permissionAccessDataProvider(): array") {
		t.Errorf("ChildCode signature not folded, got %q", e.ChildCode)
	}
	if e.ChildLine != 17 {
		t.Errorf("ChildLine = %d, want 17 (the doc's 3 removed lines shift the def from line 14 to line 17)", e.ChildLine)
	}
}

// TestResolveCallsTypedParamModel covers rule 2d: a type-hinted parameter
// naming an Eloquent model (`Payment $payment`) surfaces the model as
// underlying code even though the signature line itself did NOT change in
// this PR — only a body line did (the common real-world case: an existing
// static-constructor method gains one more mapped field). This proves the
// deliberate whole-body-scan exception (see resolveCalls rule 2d's doc
// comment) actually reaches an unchanged signature.
func TestResolveCallsTypedParamModel(t *testing.T) {
	dataDir := t.TempDir()
	pr := 70
	baseDir, headDir := worktreeDirs(dataDir, pr)
	entityBase := `<?php
namespace App\Entity;
use App\Models\Payment;
class PaymentEntity {
    public static function fromModel(Payment $payment): self
    {
        return new self(
            id: $payment->id,
        );
    }
}
`
	// Only the body gains a line; the "Payment $payment" signature is byte-for-
	// byte identical between base and head.
	entityHead := `<?php
namespace App\Entity;
use App\Models\Payment;
class PaymentEntity {
    public static function fromModel(Payment $payment): self
    {
        return new self(
            id: $payment->id,
            processor: $payment->processor,
        );
    }
}
`
	for dir, body := range map[string]string{baseDir: entityBase, headDir: entityHead} {
		p := filepath.Join(dir, "app/Entity/PaymentEntity.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	modelSrc := `<?php
namespace App\Models;
class Payment extends Model {
    protected $fillable = ['id'];
}
`
	p := filepath.Join(headDir, "app/Models/Payment.php")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(modelSrc), 0o644); err != nil {
		t.Fatal(err)
	}

	caller := Block{PR: pr, File: "app/Entity/PaymentEntity.php", Class: "PaymentEntity", Name: "fromModel", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "Payment")
	if !ok {
		t.Fatalf("no entry for type-hinted model param 'Payment', got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved || e.ChildClass != "Payment" || e.ChildMethod != "" {
		t.Errorf("Payment: got %+v, want resolved Payment::<empty>", e)
	}
	if e.Kind != callresolve.KindModelUsage {
		t.Errorf("Payment: kind=%q, want %q", e.Kind, callresolve.KindModelUsage)
	}
}

// TestResolveCallsTypedParamNonModelIgnored covers rule 2d's false-positive
// gate: a type-hinted parameter whose type is NOT an indexed Eloquent model
// (a plain request/DTO class living outside app/Models/) must never produce a
// callresolve entry, even though the same `Foo $var` shape matches.
func TestResolveCallsTypedParamNonModelIgnored(t *testing.T) {
	dataDir := t.TempDir()
	pr := 71
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Services/PaymentImporter.php": `<?php
namespace App\Services;
use App\Http\Requests\ImportRequest;
class PaymentImporter {
    public function import(ImportRequest $request): void
    {
        $request->validated();
    }
}
`,
		"app/Http/Requests/ImportRequest.php": `<?php
namespace App\Http\Requests;
class ImportRequest {
    public function validated() {}
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
	caller := Block{PR: pr, File: "app/Services/PaymentImporter.php", Class: "PaymentImporter", Name: "import", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	if _, ok := findEntry(entries, "ImportRequest"); ok {
		t.Errorf("ImportRequest is not an app/Models/ class and must not produce a rule 2d entry, got %+v", entries)
	}
}

// TestResolveCallsCastPropertyEnum covers rule 5b: $var->key resolves via the
// receiver's inferred model's $casts array (not a relationship) to the cast's
// target class — an enum here — even though there is no method named `key` on
// the model at all (this is exactly PaymentEntity::fromModel's
// $payment->processor?->value case).
func TestResolveCallsCastPropertyEnum(t *testing.T) {
	dataDir := t.TempDir()
	pr := 72
	baseDir, headDir := worktreeDirs(dataDir, pr)
	entityBase := `<?php
namespace App\Entity;
class PaymentEntity {
    public static function fromModel(Payment $payment): self
    {
        return new self(id: $payment->id);
    }
}
`
	entityHead := `<?php
namespace App\Entity;
class PaymentEntity {
    public static function fromModel(Payment $payment): self
    {
        return new self(
            id: $payment->id,
            processor: $payment->processor?->value,
        );
    }
}
`
	for dir, body := range map[string]string{baseDir: entityBase, headDir: entityHead} {
		p := filepath.Join(dir, "app/Entity/PaymentEntity.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	modelSrc := `<?php
namespace App\Models;
use Modules\Payments\Enums\Driver;
class Payment extends Model {
    protected $casts = [
        'processor' => Driver::class,
    ];
}
`
	enumSrc := `<?php
namespace Modules\Payments\Enums;
enum Driver: string
{
    case Adyen = 'adyen';
    case Mollie = 'mollie';
}
`
	for rel, body := range map[string]string{
		"app/Models/Payment.php":            modelSrc,
		"modules/Payments/Enums/Driver.php": enumSrc,
	} {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Entity/PaymentEntity.php", Class: "PaymentEntity", Name: "fromModel", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "processor")
	if !ok {
		t.Fatalf("no entry for cast property 'processor', got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved || e.ChildClass != "Driver" || e.ChildMethod != "" {
		t.Errorf("processor: got %+v, want resolved Driver::<empty>", e)
	}
	if e.Kind != callresolve.KindMethodCall {
		t.Errorf("processor: kind=%q, want %q (an enum target, not a model)", e.Kind, callresolve.KindMethodCall)
	}
}

// TestResolveCallsCastPropertyAmbiguousEnum covers rule 5b's ambiguity
// handling: this app has several unrelated enums that happen to share a short
// name (a real situation found in the target repo — three distinct "Driver"
// enums live in different modules). A cast pointing at that name can't be
// disambiguated by Go alone, so it must fall back to unresolved (which
// automatically triggers the LLM search, which DOES have enough context —
// the model's own `use` imports — to pick the right one).
func TestResolveCallsCastPropertyAmbiguousEnum(t *testing.T) {
	dataDir := t.TempDir()
	pr := 73
	_, headDir := worktreeDirs(dataDir, pr)
	entitySrc := `<?php
namespace App\Entity;
class PaymentEntity {
    public static function fromModel(Payment $payment): self
    {
        return new self(processor: $payment->processor?->value);
    }
}
`
	modelSrc := `<?php
namespace App\Models;
class Payment extends Model {
    protected $casts = [
        'processor' => Driver::class,
    ];
}
`
	driverA := `<?php
namespace Modules\Payments\Enums;
enum Driver: string { case Adyen = 'adyen'; }
`
	driverB := `<?php
namespace Modules\Memberships\Enums;
enum Driver: string { case Stripe = 'stripe'; }
`
	for rel, body := range map[string]string{
		"app/Entity/PaymentEntity.php":         entitySrc,
		"app/Models/Payment.php":               modelSrc,
		"modules/Payments/Enums/Driver.php":    driverA,
		"modules/Memberships/Enums/Driver.php": driverB,
	} {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Entity/PaymentEntity.php", Class: "PaymentEntity", Name: "fromModel", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "processor")
	if !ok {
		t.Fatalf("no entry for cast property 'processor', got %+v", entries)
	}
	if e.Status != callresolve.StatusUnresolved {
		t.Errorf("processor: status=%q, want unresolved (ambiguous same-named enum)", e.Status)
	}
}

// TestResolveCallsCastPropertyUnknownTargetUnresolved covers rule 5b's third
// branch: a cast to a class that is neither an indexed enum nor an indexed
// model (e.g. a plain Value Object/Castable) must still surface as an
// unresolved entry — never silently nothing — because the call-site itself
// sits on a changed line.
func TestResolveCallsCastPropertyUnknownTargetUnresolved(t *testing.T) {
	dataDir := t.TempDir()
	pr := 74
	_, headDir := worktreeDirs(dataDir, pr)
	entitySrc := `<?php
namespace App\Entity;
class PaymentEntity {
    public static function fromModel(Payment $payment): self
    {
        return new self(meta: $payment->meta);
    }
}
`
	modelSrc := `<?php
namespace App\Models;
class Payment extends Model {
    protected $casts = [
        'meta' => SomeUnindexedValueObject::class,
    ];
}
`
	for rel, body := range map[string]string{
		"app/Entity/PaymentEntity.php": entitySrc,
		"app/Models/Payment.php":       modelSrc,
	} {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Entity/PaymentEntity.php", Class: "PaymentEntity", Name: "fromModel", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "meta")
	if !ok {
		t.Fatalf("no entry for cast property 'meta', got %+v", entries)
	}
	if e.Status != callresolve.StatusUnresolved {
		t.Errorf("meta: status=%q, want unresolved (cast target not indexed anywhere)", e.Status)
	}
}

// TestSliceLangKey covers the array-walking logic directly (no worktree
// needed — it's a pure function over lang-file text): a scalar key, a key
// whose own value is a nested sub-array (returned as its `[...]` source
// text, one keyPath segment deep — not descended further), a value
// containing an escaped quote and a bracket character (must not confuse the
// quote/bracket-aware scan), and a missing key.
func TestSliceLangKey(t *testing.T) {
	text := `<?php

return [
    'foo' => 'Hello world',
    'bar' => [
        'baz' => 'Nested value',
    ],
    'weird' => 'Has a \'quote\' and a [bracket] inside',
];
`
	t.Run("scalar key", func(t *testing.T) {
		val, line, found := sliceLangKey(text, []string{"foo"})
		if !found {
			t.Fatal("expected found=true")
		}
		if val != "'Hello world'" {
			t.Errorf("val = %q, want %q", val, "'Hello world'")
		}
		if line != 4 {
			t.Errorf("line = %d, want 4", line)
		}
	})

	t.Run("nested key returns sub-array text", func(t *testing.T) {
		val, _, found := sliceLangKey(text, []string{"bar"})
		if !found {
			t.Fatal("expected found=true")
		}
		if !strings.HasPrefix(val, "[") || !strings.HasSuffix(val, "]") {
			t.Errorf("val = %q, want a bracketed sub-array", val)
		}
		if !strings.Contains(val, "'baz' => 'Nested value'") {
			t.Errorf("val = %q, missing nested entry", val)
		}
	})

	t.Run("nested key descended into", func(t *testing.T) {
		val, _, found := sliceLangKey(text, []string{"bar", "baz"})
		if !found {
			t.Fatal("expected found=true")
		}
		if val != "'Nested value'" {
			t.Errorf("val = %q, want %q", val, "'Nested value'")
		}
	})

	t.Run("value with escaped quote and bracket", func(t *testing.T) {
		val, _, found := sliceLangKey(text, []string{"weird"})
		if !found {
			t.Fatal("expected found=true")
		}
		want := `'Has a \'quote\' and a [bracket] inside'`
		if val != want {
			t.Errorf("val = %q, want %q", val, want)
		}
	})

	t.Run("missing key", func(t *testing.T) {
		_, _, found := sliceLangKey(text, []string{"does_not_exist"})
		if found {
			t.Error("expected found=false")
		}
	})

	t.Run("missing nested key", func(t *testing.T) {
		_, _, found := sliceLangKey(text, []string{"bar", "nope"})
		if found {
			t.Error("expected found=false")
		}
	})
}

// TestResolveTranslations: a trans()/__() call on a changed line resolves to
// the lang-file value in every locale that has the file, one entry per
// locale; a key missing in a locale still produces an entry with empty
// ChildCode; a dynamic argument, a namespaced ("pkg::x.y") key and a bare
// whole-file reference ("checkout") all produce no entry.
func TestResolveTranslations(t *testing.T) {
	dataDir := t.TempDir()
	pr := 90
	baseDir, headDir := worktreeDirs(dataDir, pr)

	callerBase := `<?php
namespace App\Http\Controllers;
class CheckoutController {
    public function show() {
        return view('checkout.show');
    }
}
`
	callerHead := `<?php
namespace App\Http\Controllers;
class CheckoutController {
    public function show() {
        $label = trans('checkout.foo');
        $sub = __('checkout.bar.baz');
        $dyn = trans($dynamic);
        $pkg = trans('pkg::x.y');
        $whole = trans('checkout');
        return view('checkout.show');
    }
}
`
	for dir, body := range map[string]string{baseDir: callerBase, headDir: callerHead} {
		p := filepath.Join(dir, "app/Http/Controllers/CheckoutController.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	nlLang := `<?php

return [
    'foo' => 'Vervolg naar afrekenen',
    'bar' => [
        'baz' => 'Onderdeel van de bestelling',
    ],
];
`
	enLang := `<?php

return [
    'foo' => 'Continue to checkout',
];
`
	for rel, body := range map[string]string{
		"resources/lang/nl/checkout.php": nlLang,
		"resources/lang/en/checkout.php": enLang,
	} {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Http/Controllers/CheckoutController.php", Class: "CheckoutController", Name: "show", Side: SideNew, Status: StatusModified}
	entries := resolveTranslations(dataDir, pr, []Block{caller})

	if len(entries) != 4 {
		t.Fatalf("got %d entries, want 4 (2 keys x 2 locales): %+v", len(entries), entries)
	}

	e, ok := findCallresolveEntry(entries, caller.ID(), "translation:nl:checkout.foo")
	if !ok {
		t.Fatalf("no entry for translation:nl:checkout.foo, got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved || e.Kind != callresolve.KindTranslation {
		t.Errorf("status/kind = %q/%q, want resolved/%q", e.Status, e.Kind, callresolve.KindTranslation)
	}
	if e.ChildFile != "resources/lang/nl/checkout.php" || e.ChildClass != "nl" || e.ChildMethod != "" {
		t.Errorf("child = %q/%q/%q, want resources/lang/nl/checkout.php/nl/<empty>", e.ChildFile, e.ChildClass, e.ChildMethod)
	}
	if !strings.Contains(e.ChildCode, "Vervolg naar afrekenen") {
		t.Errorf("ChildCode = %q, missing nl value", e.ChildCode)
	}
	if e.ChildLine <= 0 {
		t.Errorf("ChildLine = %d, want > 0", e.ChildLine)
	}

	eEn, ok := findCallresolveEntry(entries, caller.ID(), "translation:en:checkout.foo")
	if !ok {
		t.Fatalf("no entry for translation:en:checkout.foo, got %+v", entries)
	}
	if !strings.Contains(eEn.ChildCode, "Continue to checkout") {
		t.Errorf("ChildCode = %q, missing en value", eEn.ChildCode)
	}

	eNlNested, ok := findCallresolveEntry(entries, caller.ID(), "translation:nl:checkout.bar.baz")
	if !ok {
		t.Fatalf("no entry for translation:nl:checkout.bar.baz, got %+v", entries)
	}
	if !strings.Contains(eNlNested.ChildCode, "Onderdeel van de bestelling") {
		t.Errorf("ChildCode = %q, missing nested nl value", eNlNested.ChildCode)
	}

	// en has no 'bar' key at all — still an entry, but empty/missing.
	eEnMissing, ok := findCallresolveEntry(entries, caller.ID(), "translation:en:checkout.bar.baz")
	if !ok {
		t.Fatalf("no entry for translation:en:checkout.bar.baz (missing-in-locale must still be emitted), got %+v", entries)
	}
	if eEnMissing.ChildCode != "" {
		t.Errorf("ChildCode = %q, want empty (key missing in en)", eEnMissing.ChildCode)
	}
	if eEnMissing.ChildLine != 1 {
		t.Errorf("ChildLine = %d, want 1 (key missing in en)", eEnMissing.ChildLine)
	}

	// Decoys: a dynamic argument, a namespaced key, and a bare whole-file
	// reference must never produce an entry.
	for _, ck := range []string{"pkg", "dynamic", "checkout"} {
		for _, e := range entries {
			if strings.Contains(e.CallKey, ck) && !strings.Contains(e.CallKey, "checkout.foo") && !strings.Contains(e.CallKey, "checkout.bar.baz") {
				t.Errorf("unexpected entry for decoy %q: %+v", ck, e)
			}
		}
	}
}

// TestResolveCallsResourceToArray: a controller instantiating an API Resource
// on a changed line (new AffiliateResourceV2($affiliate)) surfaces that
// Resource's toArray() as underlying code, even though the Resource class
// itself is not changed in this PR — mirrors resolveMigrationModels/
// resolveDataProviders (callresolve may point at unchanged code; relations.go's
// controllerResourceDetector cannot, since it requires both sides changed).
//
// Note: reResourceUse/reResourceReturn (shared, unchanged, with
// relations.go's controllerResourceDetector) require the class name to
// literally END in "Resource" — a versioned name like "AffiliateResourceV2"
// (the exact class from the motivating real-world example) does NOT match
// either detector today. That gap is pre-existing and shared by both
// call sites; this test therefore uses a plain "AffiliateResource" name to
// exercise the (correctly reused, unchanged) matching rule.
func TestResolveCallsResourceToArray(t *testing.T) {
	dataDir := t.TempDir()
	pr := 60
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Http/Controllers/AffiliateController.php": `<?php
namespace App\Http\Controllers;
class AffiliateController {
    public function show($id, $includes) {
        $affiliate = Affiliate::query()->findOrFail($id);
        $resource = new AffiliateResource($affiliate);
        $affiliate->loadMissing($resource->withRelationships($includes));
        return Resource::toPayload($resource, $includes);
    }
}
`,
		"app/Http/Resources/AffiliateResource.php": `<?php
namespace App\Http\Resources;
class AffiliateResource {
    public function toArray($request) {
        return ['id' => $this->id];
    }
}
`,
		"app/Http/Resources/ProductResource.php": `<?php
namespace App\Http\Resources;
class ProductResource {
    public function withRelationships($includes) {
        return $includes;
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
	caller := Block{PR: pr, File: "app/Http/Controllers/AffiliateController.php", Class: "AffiliateController", Name: "show", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "resource:AffiliateResource")
	if !ok {
		t.Fatalf("no entry for resource:AffiliateResource, got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("status=%q, want resolved", e.Status)
	}
	if e.Kind != callresolve.KindMethodCall {
		t.Errorf("kind=%q, want %q (default)", e.Kind, callresolve.KindMethodCall)
	}
	if e.ChildClass != "AffiliateResource" || e.ChildMethod != "toArray" {
		t.Errorf("child=%q::%q, want AffiliateResource::toArray", e.ChildClass, e.ChildMethod)
	}
	if !strings.Contains(e.ChildCode, "function toArray") {
		t.Errorf("ChildCode missing toArray body, got %q", e.ChildCode)
	}

	// bare `Resource::toPayload(...)` never produces a "resource:" child —
	// "Resource" is not itself a "<something>Resource"-suffixed class name (the
	// generic static-call rule 3 still emits its own unrelated "toPayload"
	// unresolved entry, unaffected by this rule).
	if _, ok := findEntry(entries, "resource:Resource"); ok {
		t.Error("unexpected resource: entry for the bare 'Resource' helper class")
	}
}

// TestResolveCallsResourceWithoutToArray: a Resource class that doesn't
// override toArray() (uses the framework default) silently yields no
// "resource:" child — this is not an ambiguity for the LLM search, just an
// absence, mirroring resolveMigrationModels/resolveDataProviders' own
// silent-skip precedent.
func TestResolveCallsResourceWithoutToArray(t *testing.T) {
	dataDir := t.TempDir()
	pr := 61
	_, headDir := worktreeDirs(dataDir, pr)
	files := map[string]string{
		"app/Http/Controllers/ProductGroupController.php": `<?php
namespace App\Http\Controllers;
class ProductGroupController {
    public function store($request) {
        $resource = ProductGroupResource::make($request->productGroup);
        return $resource;
    }
}
`,
		"app/Http/Resources/ProductGroupResource.php": `<?php
namespace App\Http\Resources;
class ProductGroupResource {
    public static function make($resource = null) {}
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
	caller := Block{PR: pr, File: "app/Http/Controllers/ProductGroupController.php", Class: "ProductGroupController", Name: "store", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	for _, e := range entries {
		if strings.HasPrefix(e.CallKey, "resource:") {
			t.Errorf("unexpected resource: entry for a class without toArray(): %+v", e)
		}
	}
}
