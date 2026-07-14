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
