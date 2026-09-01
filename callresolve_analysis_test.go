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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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

// TestResolveCallsStaticInheritedMethod: Foo::m( where Foo does NOT declare m()
// itself but INHERITS it from an abstract base class (methodOnClass has no
// extends-chain awareness) must still resolve when m() is declared exactly
// once in the whole worktree — the same unique-global-candidate fallback rule
// 4 already applies to an unknown ->m( receiver. Regression fixture: a
// feature-flag class `final class PromotionsV2 extends UnleashFeature`
// calling PromotionsV2::isEnabled(), which is only ever declared on the
// abstract base UnleashFeature (real-world case found in PR 13259).
func TestResolveCallsStaticInheritedMethod(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13259
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Features/PromotionsV2.php": `<?php
namespace App\Features;
use PlugAndPay\Features\UnleashFeature;
final class PromotionsV2 extends UnleashFeature {
    public static function getName(): string { return 'promotions-v2'; }
}
`,
		"packages/plugandpay/Features/UnleashFeature.php": `<?php
namespace PlugAndPay\Features;
abstract class UnleashFeature {
    public static function isEnabled(): bool { return true; }
}
`,
		"app/Services/CheckoutService.php": `<?php
namespace App\Services;
use App\Features\PromotionsV2;
class CheckoutService {
    public function build() {
        $isActive = PromotionsV2::isEnabled();
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
	caller := Block{PR: pr, File: "app/Services/CheckoutService.php", Class: "CheckoutService", Name: "build", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "isEnabled")
	if !ok {
		t.Fatalf("no entry for call %q", "isEnabled")
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("isEnabled: status = %q, want %q (inherited static method must resolve via the unique-candidate fallback)", e.Status, callresolve.StatusResolved)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "UnleashFeature::isEnabled" {
		t.Fatalf("isEnabled: child = %q, want %q", got, "UnleashFeature::isEnabled")
	}
}

// TestResolveCallsStaticInheritedMethodAmbiguous: the same shape as above, but
// TWO unrelated classes declare a method of that name — the fallback must
// stay unresolved (LLM territory) rather than guessing.
func TestResolveCallsStaticInheritedMethodAmbiguous(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13260
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Features/PromotionsV2.php": `<?php
namespace App\Features;
use PlugAndPay\Features\UnleashFeature;
final class PromotionsV2 extends UnleashFeature {
    public static function getName(): string { return 'promotions-v2'; }
}
`,
		"packages/plugandpay/Features/UnleashFeature.php": `<?php
namespace PlugAndPay\Features;
abstract class UnleashFeature {
    public static function isEnabled(): bool { return true; }
}
`,
		"app/Billing/Invoice.php": `<?php
namespace App\Billing;
class Invoice {
    public static function isEnabled(): bool { return false; }
}
`,
		"app/Services/CheckoutService.php": `<?php
namespace App\Services;
use App\Features\PromotionsV2;
class CheckoutService {
    public function build() {
        $isActive = PromotionsV2::isEnabled();
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
	caller := Block{PR: pr, File: "app/Services/CheckoutService.php", Class: "CheckoutService", Name: "build", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "isEnabled")
	if !ok {
		t.Fatalf("no entry for call %q", "isEnabled")
	}
	if e.Status != callresolve.StatusUnresolved {
		t.Fatalf("isEnabled: status = %q, want %q (ambiguous global match must not guess)", e.Status, callresolve.StatusUnresolved)
	}
}

// TestResolveCallsAnonymousClassOwnMethod: a Laravel migration's
// `return new class extends Migration { ... }` gives every method in it
// Block.Class == "" (phpscan.go has no stable name to key an anonymous class
// on). A $this-> or self:: call from one of its methods to a PRIVATE sibling
// method declared in that same anonymous class body must still resolve —
// "own class" for such a call means "this same anonymous class, this same
// file" (methodInAnonClass), not "no class at all". Reported bug: it used to
// silently produce nothing, not even an `unresolved` row.
func TestResolveCallsAnonymousClassOwnMethod(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13221
	_, headDir := worktreeDirs(dataDir, "", pr)
	file := `<?php
use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    public function up(): void
    {
        foreach (self::INDEXES as $from => $to) {
            $this->renameIndex($from, $to);
        }
    }

    private function renameIndex(string $from, string $to): void
    {
        if (!$this->hasIndex($from)) {
            return;
        }
    }

    private function hasIndex(string $name): bool
    {
        return true;
    }
};
`
	rel := "database/migrations/2026_08_14_130000_rename_users_indexes.php"
	p := filepath.Join(headDir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(file), 0o644); err != nil {
		t.Fatal(err)
	}
	caller := Block{PR: pr, File: rel, Class: "", Name: "up", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "renameIndex")
	if !ok {
		t.Fatal("no entry for call \"renameIndex\" — $this-> inside an anonymous class silently produced nothing")
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("renameIndex: status = %q, want %q", e.Status, callresolve.StatusResolved)
	}
	if e.ChildMethod != "renameIndex" || e.ChildFile != rel {
		t.Fatalf("renameIndex: child = %q in %q, want method %q in %q", e.ChildMethod, e.ChildFile, "renameIndex", rel)
	}
}

// TestResolveCallsParentMethod: `parent::m(` resolves to the method declared
// on the caller's own (indexed) parent class, using the `extends` target
// phpscan.go now stamps on every Block (Block.Parent).
func TestResolveCallsParentMethod(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13222
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Models/BaseModel.php": `<?php
namespace App\Models;
class BaseModel {
    public function __construct(array $attributes = []) {}
}
`,
		"app/Models/ProductGroup.php": `<?php
namespace App\Models;
class ProductGroup extends BaseModel {
    public function __construct(array $attributes = []) {
        parent::__construct($attributes);
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
	caller := Block{PR: pr, File: "app/Models/ProductGroup.php", Class: "ProductGroup", Name: "__construct", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "__construct")
	if !ok {
		t.Fatal("no entry for call \"__construct\" — parent:: is not resolved at all")
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("__construct: status = %q, want %q", e.Status, callresolve.StatusResolved)
	}
	if e.ChildClass != "BaseModel" {
		t.Fatalf("__construct: child class = %q, want %q", e.ChildClass, "BaseModel")
	}
}

// TestResolveCallsParentMethodUnindexed: the far more common case — the
// parent is a framework class (e.g. Laravel's own Migration/Model) that the
// worktree index never sees (vendor is skipped). `parent::` must still turn
// into an `unresolved` row, not silence, mirroring rule 1's own "method
// exists nowhere in the app" fallback.
func TestResolveCallsParentMethodUnindexed(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13223
	_, headDir := worktreeDirs(dataDir, "", pr)
	file := `<?php
namespace App\Console\Commands;
use Illuminate\Console\Command;
class SyncOrders extends Command {
    public function handle(): void {
        parent::handle();
    }
}
`
	rel := "app/Console/Commands/SyncOrders.php"
	p := filepath.Join(headDir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(file), 0o644); err != nil {
		t.Fatal(err)
	}
	caller := Block{PR: pr, File: rel, Class: "SyncOrders", Name: "handle", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "handle")
	if !ok {
		t.Fatal("no entry for call \"handle\" — parent:: onto an unindexed framework class produced nothing")
	}
	if e.Status != callresolve.StatusUnresolved {
		t.Fatalf("handle: status = %q, want %q", e.Status, callresolve.StatusUnresolved)
	}
}

// TestResolveCallsChangedLinesOnly: when a base worktree exists, only calls on
// lines the PR changed produce entries — a call on an untouched line must not
// surface as underlying code (that was the unrelated-children bug).
func TestResolveCallsChangedLinesOnly(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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

// TestResolveCallsEnumCasesCall: a NATIVE enum method call
// (CustomerInclude::cases()) must resolve to the enum DECLARATION, never to an
// unrelated class that happens to declare a same-named method. Reported bug
// (PR 13381): `new MultipleIn(CustomerInclude::cases())` showed
// `Interval::cases` as underlying code, because that unrelated enum was the
// only app symbol named `cases` and rule 3's unique-global-candidate fallback
// picked it up.
func TestResolveCallsEnumCasesCall(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13381
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Enums/Includes/CustomerInclude.php": `<?php
namespace App\Enums\Includes;
enum CustomerInclude: string
{
    case ORDERS = 'orders';
    case SUBSCRIPTIONS = 'subscriptions';
}
`,
		// The only class in the worktree declaring a method literally named
		// `cases` — the wrong answer this test guards against.
		"modules/Statistics/Enums/Interval.php": `<?php
namespace Modules\Statistics\Enums;
class Interval
{
    public static function cases(): array
    {
        return [];
    }
}
`,
		"app/Http/Requests/CustomerShowRequest.php": `<?php
namespace App\Http\Requests;
use App\Enums\Includes\CustomerInclude;
class CustomerShowRequest {
    public function rules(): array
    {
        return ['include' => new MultipleIn(CustomerInclude::cases())];
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

	caller := Block{PR: pr, File: "app/Http/Requests/CustomerShowRequest.php", Class: "CustomerShowRequest", Name: "rules", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "cases")
	if !ok {
		t.Fatal("no entry for call 'cases'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Fatalf("cases: status=%q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "CustomerInclude::cases" {
		t.Fatalf("cases: child=%q, want CustomerInclude::cases", got)
	}
	if !strings.Contains(e.ChildCode, "case ORDERS") {
		t.Errorf("cases: child code missing the enum body, got %q", e.ChildCode)
	}
}

// TestResolveCallsBuiltinStaticNoGlobalFallback: the same builtin method name
// on a receiver that is NOT an indexed enum (a vendor enum, an unscanned file)
// must produce NO entry at all — neither the unrelated unique global candidate
// nor an `unresolved` row that the LLM search could never satisfy.
func TestResolveCallsBuiltinStaticNoGlobalFallback(t *testing.T) {
	dataDir := t.TempDir()
	pr := 13382
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"modules/Statistics/Enums/Interval.php": `<?php
namespace Modules\Statistics\Enums;
class Interval
{
    public static function cases(): array
    {
        return [];
    }
}
`,
		"app/Http/Requests/VendorRequest.php": `<?php
namespace App\Http\Requests;
use Vendor\Package\SomeVendorEnum;
class VendorRequest {
    public function rules(): array
    {
        return ['x' => SomeVendorEnum::cases()];
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

	caller := Block{PR: pr, File: "app/Http/Requests/VendorRequest.php", Class: "VendorRequest", Name: "rules", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	if e, ok := findEntry(entries, "cases"); ok {
		t.Fatalf("cases: got entry %+v, want none (builtin name, receiver not an indexed enum)", e)
	}
}

// TestResolveCallsReceiverVar covers a method call whose receiver variable
// names its class — $order->billingAddress() resolves to Order::billingAddress
// even though Invoice defines the same method (globally ambiguous).
func TestResolveCallsReceiverVar(t *testing.T) {
	dataDir := t.TempDir()
	pr := 17
	_, headDir := worktreeDirs(dataDir, "", pr)
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

// TestResolveCallsTemporalActivityStub covers rule 3a2: a workflow method
// assigns Workflow::newActivityStub(FooActivity::class, ...) to a variable
// whose name does not follow the class-name convention (like $runCommand for
// RunCommandActivity), then calls a method on that stub — which the plain
// receiver-name heuristic (3b) can't resolve on its own.
func TestResolveCallsTemporalActivityStub(t *testing.T) {
	dataDir := t.TempDir()
	pr := 21
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Workflows/ImportStatsFlow.php": `<?php
namespace App\Workflows;
use App\Workflows\Activities\RunCommandActivity;
class ImportStatsFlow {
    public function run(): \Generator {
        $runCommand = Workflow::newActivityStub(
            RunCommandActivity::class,
            $options,
        );
        yield $runCommand->run($command);
    }
}
`,
		"app/Workflows/Activities/RunCommandActivity.php": `<?php
namespace App\Workflows\Activities;
final class RunCommandActivity {
    public function run(string $command): array {
        return [];
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

	caller := Block{PR: pr, File: "app/Workflows/ImportStatsFlow.php", Class: "ImportStatsFlow", Name: "run", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "run")
	if !ok {
		t.Fatal("no entry for call 'run'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("run: status=%q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "RunCommandActivity::run" {
		t.Errorf("run: child=%q, want RunCommandActivity::run", got)
	}
}

// TestResolveCallsTemporalActivityStubUnknownClass covers 3a2's unresolved
// path: the stub names an Activity class the worktree doesn't index (e.g. a
// vendor/framework Activity), so the call still becomes unresolved rather
// than silently nothing — the call site sits on a changed line.
func TestResolveCallsTemporalActivityStubUnknownClass(t *testing.T) {
	dataDir := t.TempDir()
	pr := 22
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Workflows/ImportStatsFlow.php": `<?php
namespace App\Workflows;
use Some\Vendor\FrameworkActivity;
class ImportStatsFlow {
    public function run(): \Generator {
        $runCommand = Workflow::newActivityStub(FrameworkActivity::class, $options);
        yield $runCommand->doSomething();
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

	caller := Block{PR: pr, File: "app/Workflows/ImportStatsFlow.php", Class: "ImportStatsFlow", Name: "run", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "doSomething")
	if !ok {
		t.Fatal("no entry for call 'doSomething'")
	}
	if e.Status != callresolve.StatusUnresolved {
		t.Errorf("doSomething: status=%q, want unresolved", e.Status)
	}
}

// TestResolveCallsClassRef covers rule 6c: a bare Foo::class reference with
// no $var assignment, no ->method() call, no $casts entry — the shape a
// Temporal workflow's `'activities' => [FooActivity::class, ...]`
// registration array has, which 3a2's newActivityStub heuristic can't key on
// at all. It should resolve to the whole class, Kind class_ref.
func TestResolveCallsClassRef(t *testing.T) {
	dataDir := t.TempDir()
	pr := 23
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"config/workflows.php": `<?php
return [
    'activities' => [
        RunCommandActivity::class,
    ],
];
`,
		"app/Workflows/Activities/RunCommandActivity.php": `<?php
namespace App\Workflows\Activities;
final class RunCommandActivity {
    public function run(string $command): array {
        return [];
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

	caller := Block{PR: pr, File: "config/workflows.php", Class: "", Name: "workflows.php", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "RunCommandActivity")
	if !ok {
		t.Fatal("no entry for call 'RunCommandActivity'")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("RunCommandActivity: status=%q, want resolved", e.Status)
	}
	if e.Kind != callresolve.KindClassRef {
		t.Errorf("RunCommandActivity: kind=%q, want %q", e.Kind, callresolve.KindClassRef)
	}
	if e.ChildClass != "RunCommandActivity" {
		t.Errorf("RunCommandActivity: child class=%q, want RunCommandActivity", e.ChildClass)
	}
}

// TestResolveCallsClassRefEntryPoints covers rule 6c-bis: alongside the class
// itself, a bare Foo::class reference also yields the class's __construct and
// its first OTHER method as reference children — neither of which this PR
// changed (they aren't even blocks of the PR, only worktree symbols). A second
// class in the same fixture has no constructor at all, to pin down that it
// then yields only the first method rather than falling back to two.
func TestResolveCallsClassRefEntryPoints(t *testing.T) {
	dataDir := t.TempDir()
	pr := 24
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"config/workflows.php": `<?php
return [
    'activities' => [
        RunCommandActivity::class,
        PlainActivity::class,
    ],
];
`,
		"app/Workflows/Activities/RunCommandActivity.php": `<?php
namespace App\Workflows\Activities;
final class RunCommandActivity {
    public function __construct(private Runner $runner) {
    }
    public function run(string $command): array {
        return [];
    }
    public function later(): void {
    }
}
`,
		"app/Workflows/Activities/PlainActivity.php": `<?php
namespace App\Workflows\Activities;
final class PlainActivity {
    public function handle(): void {
    }
    public function other(): void {
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

	caller := Block{PR: pr, File: "config/workflows.php", Class: "", Name: "workflows.php", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	ctor, ok := findEntry(entries, "class_ctor:RunCommandActivity")
	if !ok {
		t.Fatal("no entry for class_ctor:RunCommandActivity")
	}
	if ctor.Kind != callresolve.KindClassCtor || ctor.ChildMethod != "__construct" {
		t.Errorf("ctor: kind=%q method=%q, want %q/__construct", ctor.Kind, ctor.ChildMethod, callresolve.KindClassCtor)
	}

	first, ok := findEntry(entries, "class_method:RunCommandActivity")
	if !ok {
		t.Fatal("no entry for class_method:RunCommandActivity")
	}
	if first.Kind != callresolve.KindClassFirstMethod || first.ChildMethod != "run" {
		t.Errorf("first method: kind=%q method=%q, want %q/run", first.Kind, first.ChildMethod, callresolve.KindClassFirstMethod)
	}

	if _, ok := findEntry(entries, "class_ctor:PlainActivity"); ok {
		t.Error("PlainActivity has no constructor, want no class_ctor entry")
	}
	plain, ok := findEntry(entries, "class_method:PlainActivity")
	if !ok {
		t.Fatal("no entry for class_method:PlainActivity")
	}
	if plain.ChildMethod != "handle" {
		t.Errorf("PlainActivity first method=%q, want handle", plain.ChildMethod)
	}
}

// TestResolveCallsClassRefModel covers rule 6c's model branch: a bare
// Model::class reference (no new/method call) merges into the SAME
// model_usage kind (and call key) that new Model()/Model::method() already
// produce, so a model referenced both ways in one block never shows two
// duplicate cards.
func TestResolveCallsClassRefModel(t *testing.T) {
	dataDir := t.TempDir()
	pr := 24
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Jobs/SyncOrders.php": `<?php
namespace App\Jobs;
class SyncOrders {
    public function handle(): void {
        $map = ['model' => Order::class];
    }
}
`,
		"app/Models/Order.php": `<?php
namespace App\Models;
class Order extends Model {
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

	caller := Block{PR: pr, File: "app/Jobs/SyncOrders.php", Class: "SyncOrders", Name: "handle", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "Order")
	if !ok {
		t.Fatal("no entry for call 'Order'")
	}
	if e.Kind != callresolve.KindModelUsage {
		t.Errorf("Order: kind=%q, want %q", e.Kind, callresolve.KindModelUsage)
	}
}

// TestResolveCallsMacro covers a ->name( call resolving to a Laravel macro
// (Receiver::macro('name', function ...)), which lives inside a boot method's
// body and is therefore invisible to ScanBlocks.
func TestResolveCallsMacro(t *testing.T) {
	dataDir := t.TempDir()
	pr := 11
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
// .claude/docs/tembed-workflows.md, "migration → model": the model itself is
// NOT changed by this PR, so it must still surface as underlying code.
func TestResolveMigrationModelsConvention(t *testing.T) {
	dataDir := t.TempDir()
	pr := 60
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
// .claude/docs/blocks-and-ingest.md ("PHPDoc-types in de signatuur vouwen").
// ChildLine must shift by the same removed-line count as the doc.
func TestResolveCallsFoldsLeadingPHPDocInChildCode(t *testing.T) {
	dataDir := t.TempDir()
	pr := 71
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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
// ChildCode; a dynamic argument, a namespaced ("pkg::x.y") key, a bare
// whole-file reference ("checkout"), and a static-prefix-plus-concatenation
// key (`'checkout.' . $suffix`, in both trans() and trans_choice() form —
// same regex family) all produce no entry.
func TestResolveTranslations(t *testing.T) {
	dataDir := t.TempDir()
	pr := 90
	baseDir, headDir := worktreeDirs(dataDir, "", pr)

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
        $concat = trans('checkout.' . $suffix);
        $concatChoice = trans_choice('checkout.' . $suffix, 1);
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

	// A static prefix followed by concatenation ('checkout.' . $suffix) is
	// NOT a fully static key — it must be skipped entirely, never produce an
	// entry with a truncated key like "translation:nl:checkout." (which would
	// wrongly render as "missing in nl/en", the reported bug). Covers both
	// trans() and trans_choice() — same regex family.
	for _, ck := range []string{"translation:nl:checkout.", "translation:en:checkout."} {
		for _, e := range entries {
			if e.CallKey == ck {
				t.Errorf("unexpected entry for truncated concatenated key %q: %+v", ck, e)
			}
		}
	}
}

// TestResolveTranslationsModuleNamespace: a namespaced key
// (`rules::translations.foo`) resolves against the matching Laravel-modules
// package's OWN lang directory (modules/<Dir>/Internal/Resources/lang, per
// config/modules.php's path-generator convention) instead of being silently
// skipped like a genuine third-party vendor key — reported case:
// RetryActionHistoryRequest::withValidator's
// trans('rules::translations.validation.action_history_not_latest') showed
// "Geen onderliggende code." for the whole block.
func TestResolveTranslationsModuleNamespace(t *testing.T) {
	dataDir := t.TempDir()
	pr := 91
	baseDir, headDir := worktreeDirs(dataDir, "", pr)

	callerBase := `<?php
namespace Modules\Rules\Internal\Http\Requests;
class RetryActionHistoryRequest {
    public function withValidator($validator) {
    }
}
`
	callerHead := `<?php
namespace Modules\Rules\Internal\Http\Requests;
class RetryActionHistoryRequest {
    public function withValidator($validator) {
        $validator->errors()->add('action_history', trans('rules::translations.validation.action_history_not_latest'));
    }
}
`
	for dir, body := range map[string]string{baseDir: callerBase, headDir: callerHead} {
		p := filepath.Join(dir, "modules/Rules/Internal/Http/Requests/RetryActionHistoryRequest.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	moduleJSON := `{"name": "Rules", "alias": "rules"}`
	if err := os.MkdirAll(filepath.Join(headDir, "modules/Rules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(headDir, "modules/Rules/module.json"), []byte(moduleJSON), 0o644); err != nil {
		t.Fatal(err)
	}

	nlLang := `<?php

return [
    'validation' => [
        'action_history_not_latest' => 'Deze uitgevoerde regel is al opnieuw geprobeerd.',
    ],
];
`
	enLang := `<?php

return [
    'validation' => [
        'action_history_not_latest' => 'This action history has already been retried.',
    ],
];
`
	for rel, body := range map[string]string{
		"modules/Rules/Internal/Resources/lang/nl/translations.php": nlLang,
		"modules/Rules/Internal/Resources/lang/en/translations.php": enLang,
	} {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "modules/Rules/Internal/Http/Requests/RetryActionHistoryRequest.php", Class: "RetryActionHistoryRequest", Name: "withValidator", Side: SideNew, Status: StatusModified}
	entries := resolveTranslations(dataDir, pr, []Block{caller})

	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2 (1 key x 2 locales): %+v", len(entries), entries)
	}

	wantKey := "rules::translations.validation.action_history_not_latest"
	eNl, ok := findCallresolveEntry(entries, caller.ID(), "translation:nl:"+wantKey)
	if !ok {
		t.Fatalf("no entry for translation:nl:%s, got %+v", wantKey, entries)
	}
	if eNl.ChildFile != "modules/Rules/Internal/Resources/lang/nl/translations.php" {
		t.Errorf("ChildFile = %q, want modules/Rules/Internal/Resources/lang/nl/translations.php", eNl.ChildFile)
	}
	if !strings.Contains(eNl.ChildCode, "al opnieuw geprobeerd") {
		t.Errorf("ChildCode = %q, missing nl value", eNl.ChildCode)
	}

	eEn, ok := findCallresolveEntry(entries, caller.ID(), "translation:en:"+wantKey)
	if !ok {
		t.Fatalf("no entry for translation:en:%s, got %+v", wantKey, entries)
	}
	if !strings.Contains(eEn.ChildCode, "already been retried") {
		t.Errorf("ChildCode = %q, missing en value", eEn.ChildCode)
	}
}

// TestResolveEnumValueTranslations: trans('prefix.' . $this->value) called
// from a backed enum's own method resolves to the translation key EVERY case
// of that enum produces at runtime, one entry per (case x locale) — the
// reported case (OrderSummaryInclude::getLabel) that showed no underlying
// code at all before this rule existed, because the concatenation makes the
// key dynamic and resolveTranslations itself deliberately skips it.
func TestResolveEnumValueTranslations(t *testing.T) {
	dataDir := t.TempDir()
	pr := 91
	_, headDir := worktreeDirs(dataDir, "", pr)

	enumHead := `<?php
namespace App\Enums\Includes;

enum OrderSummaryInclude: string
{
    case BILLING = 'billing';
    case ITEMS = 'items';

    public function getLabel(): string
    {
        return trans('includes.orders.' . $this->value);
    }
}
`
	enumPath := filepath.Join(headDir, "app/Enums/Includes/OrderSummaryInclude.php")
	if err := os.MkdirAll(filepath.Dir(enumPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(enumPath, []byte(enumHead), 0o644); err != nil {
		t.Fatal(err)
	}

	nlLang := `<?php

return [
    'orders' => [
        'billing' => 'Facturatiegegevens',
        'items'   => 'Bestel regels',
    ],
];
`
	enLang := `<?php

return [
    'orders' => [
        'billing' => 'Billing details',
        'items'   => 'Order lines',
    ],
];
`
	for rel, body := range map[string]string{
		"resources/lang/nl/includes.php": nlLang,
		"resources/lang/en/includes.php": enLang,
	} {
		p := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{
		PR: pr, File: "app/Enums/Includes/OrderSummaryInclude.php", Class: "OrderSummaryInclude",
		Name: "getLabel", Category: "ENUM", Side: SideNew, Status: StatusAdded,
	}
	entries := resolveEnumValueTranslations(dataDir, pr, []Block{caller})

	if len(entries) != 4 {
		t.Fatalf("got %d entries, want 4 (2 cases x 2 locales): %+v", len(entries), entries)
	}

	e, ok := findCallresolveEntry(entries, caller.ID(), "translation:nl:includes.orders.billing")
	if !ok {
		t.Fatalf("no entry for translation:nl:includes.orders.billing, got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved || e.Kind != callresolve.KindTranslation {
		t.Errorf("status/kind = %q/%q, want resolved/%q", e.Status, e.Kind, callresolve.KindTranslation)
	}
	if !strings.Contains(e.ChildCode, "Facturatiegegevens") {
		t.Errorf("ChildCode = %q, missing nl value", e.ChildCode)
	}

	eEn, ok := findCallresolveEntry(entries, caller.ID(), "translation:en:includes.orders.items")
	if !ok {
		t.Fatalf("no entry for translation:en:includes.orders.items, got %+v", entries)
	}
	if !strings.Contains(eEn.ChildCode, "Order lines") {
		t.Errorf("ChildCode = %q, missing en value", eEn.ChildCode)
	}
}

// TestResolveEnumValueTranslationsNonEnumSkipped: the exact same dynamic
// trans() shape on a block that is NOT categorized ENUM produces no entry —
// this rule must never fabricate a key outside a backed enum's own method.
func TestResolveEnumValueTranslationsNonEnumSkipped(t *testing.T) {
	dataDir := t.TempDir()
	pr := 92
	_, headDir := worktreeDirs(dataDir, "", pr)

	classHead := `<?php
namespace App\Http\Controllers;
class NotAnEnum {
    public function getLabel(): string
    {
        return trans('includes.orders.' . $this->value);
    }
}
`
	p := filepath.Join(headDir, "app/Http/Controllers/NotAnEnum.php")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(classHead), 0o644); err != nil {
		t.Fatal(err)
	}

	caller := Block{
		PR: pr, File: "app/Http/Controllers/NotAnEnum.php", Class: "NotAnEnum",
		Name: "getLabel", Category: "CONTROLLER", Side: SideNew, Status: StatusAdded,
	}
	entries := resolveEnumValueTranslations(dataDir, pr, []Block{caller})
	if len(entries) != 0 {
		t.Fatalf("got %d entries, want 0 (non-ENUM block): %+v", len(entries), entries)
	}
}

// TestResolveConfigCalls: a config('file.key.path') call on a changed line
// resolves to the value declared in config/<file>.php, and — because that
// value reads a static env('VAR', ...) AND the exact `VAR=` line in
// .env.example was itself changed by this PR — also to the .env.example
// sibling. See TestResolveConfigCallsEnvLineUnchanged for the "file changed,
// but not this line" case, which must NOT produce the .env.example entry.
func TestResolveConfigCalls(t *testing.T) {
	dataDir := t.TempDir()
	pr := 91
	baseDir, headDir := worktreeDirs(dataDir, "", pr)

	callerBase := `<?php
namespace App\Services;
class StatisticsService {
    public function build() {
        return [];
    }
}
`
	callerHead := `<?php
namespace App\Services;
class StatisticsService {
    public function build() {
        $timeout = (int) config('statistics.session_flow.session_timeout_minutes') * 60;
        $dyn = config($dynamic);
        $whole = config('app');
        return $timeout;
    }
}
`
	for dir, body := range map[string]string{baseDir: callerBase, headDir: callerHead} {
		p := filepath.Join(dir, "app/Services/StatisticsService.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	configPHP := `<?php

return [
    'session_flow' => [
        'session_timeout_minutes' => env('SESSION_TIMEOUT_MINUTES', 30),
    ],
];
`
	configPath := filepath.Join(headDir, "config/statistics.php")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(configPHP), 0o644); err != nil {
		t.Fatal(err)
	}

	envBase := "APP_NAME=Laravel\n"
	envHead := "APP_NAME=Laravel\nSESSION_TIMEOUT_MINUTES=30\n"
	for dir, body := range map[string]string{baseDir: envBase, headDir: envHead} {
		if err := os.WriteFile(filepath.Join(dir, ".env.example"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Services/StatisticsService.php", Class: "StatisticsService", Name: "build", Side: SideNew, Status: StatusModified}
	entries := resolveConfigCalls(dataDir, pr, []Block{caller})

	e, ok := findCallresolveEntry(entries, caller.ID(), "config:statistics.session_flow.session_timeout_minutes")
	if !ok {
		t.Fatalf("no config_value entry, got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved || e.Kind != callresolve.KindConfigValue {
		t.Errorf("status/kind = %q/%q, want resolved/%q", e.Status, e.Kind, callresolve.KindConfigValue)
	}
	if e.ChildFile != "config/statistics.php" {
		t.Errorf("ChildFile = %q, want config/statistics.php", e.ChildFile)
	}
	if !strings.Contains(e.ChildCode, "SESSION_TIMEOUT_MINUTES") {
		t.Errorf("ChildCode = %q, missing env() call", e.ChildCode)
	}
	if e.ChildLine <= 0 {
		t.Errorf("ChildLine = %d, want > 0", e.ChildLine)
	}

	eEnv, ok := findCallresolveEntry(entries, caller.ID(), "config_env:statistics.session_flow.session_timeout_minutes")
	if !ok {
		t.Fatalf("no env_example entry (the SESSION_TIMEOUT_MINUTES line was added in this PR), got %+v", entries)
	}
	if eEnv.Status != callresolve.StatusResolved || eEnv.Kind != callresolve.KindEnvExample {
		t.Errorf("status/kind = %q/%q, want resolved/%q", eEnv.Status, eEnv.Kind, callresolve.KindEnvExample)
	}
	if eEnv.ChildFile != ".env.example" || eEnv.ChildMethod != "SESSION_TIMEOUT_MINUTES" {
		t.Errorf("child = %q/%q, want .env.example/SESSION_TIMEOUT_MINUTES", eEnv.ChildFile, eEnv.ChildMethod)
	}
	if !strings.Contains(eEnv.ChildCode, "SESSION_TIMEOUT_MINUTES=30") {
		t.Errorf("ChildCode = %q, want the SESSION_TIMEOUT_MINUTES= line", eEnv.ChildCode)
	}

	// Decoys: a dynamic argument and a bare whole-file reference must never
	// produce an entry.
	for _, ck := range []string{"config:dynamic", "config:app"} {
		for _, e := range entries {
			if e.CallKey == ck {
				t.Errorf("unexpected entry for decoy %q: %+v", ck, e)
			}
		}
	}
}

// TestResolveConfigCallsEnvLineUnchanged: .env.example DID change in this PR,
// but not the specific `VAR=` line the resolved config value reads — the
// .env.example sibling must NOT appear (gated on the exact line, not "the
// file changed somewhere" — Reindert, explicit clarification).
func TestResolveConfigCallsEnvLineUnchanged(t *testing.T) {
	dataDir := t.TempDir()
	pr := 92
	baseDir, headDir := worktreeDirs(dataDir, "", pr)

	callerBase := `<?php
class StatisticsService {
    public function build() {
        return [];
    }
}
`
	callerHead := `<?php
class StatisticsService {
    public function build() {
        return (int) config('statistics.session_flow.session_timeout_minutes') * 60;
    }
}
`
	for dir, body := range map[string]string{baseDir: callerBase, headDir: callerHead} {
		p := filepath.Join(dir, "app/Services/StatisticsService.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	configPHP := `<?php

return [
    'session_flow' => [
        'session_timeout_minutes' => env('SESSION_TIMEOUT_MINUTES', 30),
    ],
];
`
	configPath := filepath.Join(headDir, "config/statistics.php")
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, []byte(configPHP), 0o644); err != nil {
		t.Fatal(err)
	}

	// .env.example changed in this PR — but only an unrelated line, the
	// SESSION_TIMEOUT_MINUTES line itself stays byte-for-byte identical.
	envBase := "APP_NAME=Laravel\nSESSION_TIMEOUT_MINUTES=30\n"
	envHead := "APP_NAME=Laravel\nSESSION_TIMEOUT_MINUTES=30\nOTHER_VAR=1\n"
	for dir, body := range map[string]string{baseDir: envBase, headDir: envHead} {
		if err := os.WriteFile(filepath.Join(dir, ".env.example"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Services/StatisticsService.php", Class: "StatisticsService", Name: "build", Side: SideNew, Status: StatusModified}
	entries := resolveConfigCalls(dataDir, pr, []Block{caller})

	if _, ok := findCallresolveEntry(entries, caller.ID(), "config:statistics.session_flow.session_timeout_minutes"); !ok {
		t.Fatalf("no config_value entry, got %+v", entries)
	}
	if e, ok := findCallresolveEntry(entries, caller.ID(), "config_env:statistics.session_flow.session_timeout_minutes"); ok {
		t.Errorf("unexpected env_example entry (SESSION_TIMEOUT_MINUTES line itself is unchanged): %+v", e)
	}
}

// TestResolveCallsResourceToArray: a controller instantiating an API Resource
// on a changed line (new AffiliateResource($affiliate)) surfaces that
// Resource's toArray() as underlying code, even though the Resource class
// itself is not changed in this PR — mirrors resolveMigrationModels/
// resolveDataProviders (callresolve may point at unchanged code; relations.go's
// controllerResourceDetector cannot, since it requires both sides changed).
// See TestResolveCallsResourceToArrayVersionedName for the versioned/collection
// class-name form (AffiliateResourceV2).
func TestResolveCallsResourceToArray(t *testing.T) {
	dataDir := t.TempDir()
	pr := 60
	_, headDir := worktreeDirs(dataDir, "", pr)
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

// TestResolveCallsResourceToArrayVersionedName proves the versioned/collection
// class-name form (AffiliateResourceV2 — the exact class from the motivating
// real-world example, not just the plain "XResource" form) also resolves to
// its toArray() method. False-positive guard: a class ending in "Resource"
// followed by an unrelated word (ResourceManager) must never match.
func TestResolveCallsResourceToArrayVersionedName(t *testing.T) {
	dataDir := t.TempDir()
	pr := 62
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Http/Controllers/AffiliateController.php": `<?php
namespace App\Http\Controllers;
class AffiliateController {
    public function show($affiliate) {
        $resource = new AffiliateResourceV2($affiliate);
        $manager = new ResourceManager();
        return $resource;
    }
}
`,
		"app/Http/Resources/AffiliateResourceV2.php": `<?php
namespace App\Http\Resources;
class AffiliateResourceV2 {
    public function toArray($request) {
        return ['id' => $this->id];
    }
}
`,
		"app/Support/ResourceManager.php": `<?php
namespace App\Support;
class ResourceManager {
    public function toArray($request) {
        return [];
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

	e, ok := findEntry(entries, "resource:AffiliateResourceV2")
	if !ok {
		t.Fatalf("no entry for resource:AffiliateResourceV2, got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("status=%q, want resolved", e.Status)
	}
	if e.ChildClass != "AffiliateResourceV2" || e.ChildMethod != "toArray" {
		t.Errorf("child=%q::%q, want AffiliateResourceV2::toArray", e.ChildClass, e.ChildMethod)
	}

	// ResourceManager is NOT a "Resource"/"ResourceCollection"(+version)
	// class — must never be picked up by this rule.
	if _, ok := findEntry(entries, "resource:ResourceManager"); ok {
		t.Error("unexpected resource: entry for ResourceManager (false positive)")
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
	_, headDir := worktreeDirs(dataDir, "", pr)
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

func TestResolveCallsTraitUsage(t *testing.T) {
	dataDir := t.TempDir()
	pr := 63
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Services/OrderService.php": `<?php
namespace App\Services;

class OrderService
{
    use Loggable, MissingTrait;

    public function process($order)
    {
        return $order;
    }
}
`,
		"app/Concerns/Loggable.php": `<?php
namespace App\Concerns;

trait Loggable
{
    public function log($message)
    {
        return $message;
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
	caller := Block{PR: pr, File: "app/Services/OrderService.php", Class: "OrderService", Name: classHeaderSentinel, Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "trait_usage:Loggable")
	if !ok {
		t.Fatalf("no entry for trait_usage:Loggable, got %+v", entries)
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("status=%q, want resolved", e.Status)
	}
	if e.Kind != callresolve.KindTraitUsage {
		t.Errorf("kind=%q, want %q", e.Kind, callresolve.KindTraitUsage)
	}
	if e.ChildClass != "Loggable" || e.ChildMethod != "" {
		t.Errorf("child=%q::%q, want Loggable::<empty>", e.ChildClass, e.ChildMethod)
	}
	if !strings.Contains(e.ChildCode, "function log") {
		t.Errorf("ChildCode missing the trait body, got %q", e.ChildCode)
	}

	// MissingTrait isn't indexed anywhere in the worktree — it silently yields
	// no entry, never an "unresolved" row (no LLM fallback for this rule).
	for _, e := range entries {
		if strings.HasPrefix(e.CallKey, "trait_usage:MissingTrait") {
			t.Errorf("unexpected entry for an unindexed trait: %+v", e)
		}
	}
}

func TestResolveCallsTraitUsageOutsideHeaderIgnored(t *testing.T) {
	dataDir := t.TempDir()
	pr := 64
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		// A `use Loggable;` statement AFTER the first method declaration falls
		// outside the class-header block (classHeaderSentinel only spans up to
		// the first method), so this is a deliberate scope boundary: no entry.
		"app/Services/OrderService.php": `<?php
namespace App\Services;

class OrderService
{
    public function process($order)
    {
        return $order;
    }

    use Loggable;
}
`,
		"app/Concerns/Loggable.php": `<?php
namespace App\Concerns;

trait Loggable
{
    public function log($message)
    {
        return $message;
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
	caller := Block{PR: pr, File: "app/Services/OrderService.php", Class: "OrderService", Name: "process", Side: SideNew, Status: StatusModified}

	entries := resolveCalls(dataDir, pr, []Block{caller})

	for _, e := range entries {
		if strings.HasPrefix(e.CallKey, "trait_usage:") {
			t.Errorf("unexpected trait_usage entry from outside the class header: %+v", e)
		}
	}
}

// writeWorktreeFiles materializes rel→body under dir (used by the class-member
// tests, which need a base side as well as a head side).
func writeWorktreeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestResolveClassMembers covers the four outcomes of the class-header member
// rule: a changed property is a card, an unchanged property is not, and a
// constant is always a card — tagged changed or unchanged.
func TestResolveClassMembers(t *testing.T) {
	dataDir := t.TempDir()
	pr := 71
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	const file = "app/Providers/EventServiceProvider.php"

	writeWorktreeFiles(t, baseDir, map[string]string{file: `<?php
namespace App\Providers;

class EventServiceProvider
{
    public const MAX_TRIES = 3;
    private const OLD_VALUE = 'a';

    protected $listen = [
        OrderPaid::class => [SendReceipt::class],
    ];

    protected $untouched = ['stays'];

    public function boot()
    {
    }
}
`})
	writeWorktreeFiles(t, headDir, map[string]string{file: `<?php
namespace App\Providers;

class EventServiceProvider
{
    public const MAX_TRIES = 3;
    private const OLD_VALUE = 'b';

    protected $listen = [
        OrderPaid::class => [SendReceipt::class],
        OrderRefunded::class => [SendCreditNote::class],
    ];

    protected $untouched = ['stays'];

    public function boot()
    {
    }
}
`})

	caller := Block{PR: pr, File: file, Class: "EventServiceProvider", Name: classHeaderSentinel, Side: SideNew, Status: StatusModified}
	entries := resolveClassMembers(dataDir, pr, []Block{caller})

	// A changed property gets a card, tagged as a property.
	e, ok := findEntry(entries, "class_member:prop:$listen")
	if !ok {
		t.Fatalf("no entry for the changed $listen property, got %+v", entries)
	}
	if e.Kind != callresolve.KindClassProperty {
		t.Errorf("$listen kind=%q, want %q", e.Kind, callresolve.KindClassProperty)
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("$listen status=%q, want resolved", e.Status)
	}
	if !strings.Contains(e.ChildCode, "OrderRefunded::class") {
		t.Errorf("$listen ChildCode misses the multi-line array body: %q", e.ChildCode)
	}
	if e.ChildClass != "EventServiceProvider" || e.ChildMethod != "$listen" {
		t.Errorf("$listen descriptor = %q::%q, want EventServiceProvider::$listen", e.ChildClass, e.ChildMethod)
	}
	if e.ChildLine != 9 {
		t.Errorf("$listen ChildLine=%d, want 9 (absolute line in the head file)", e.ChildLine)
	}

	// An unchanged property is deliberately NOT a card.
	if _, ok := findEntry(entries, "class_member:prop:$untouched"); ok {
		t.Errorf("unchanged property $untouched must not get a card, got %+v", entries)
	}

	// An unchanged constant IS a card — explicitly requested — tagged unchanged.
	e, ok = findEntry(entries, "class_member:const:MAX_TRIES")
	if !ok {
		t.Fatalf("no entry for the unchanged MAX_TRIES constant, got %+v", entries)
	}
	if e.Kind != callresolve.KindClassConstant {
		t.Errorf("MAX_TRIES kind=%q, want %q", e.Kind, callresolve.KindClassConstant)
	}

	// A changed constant is a card too, tagged as changed.
	e, ok = findEntry(entries, "class_member:const:OLD_VALUE")
	if !ok {
		t.Fatalf("no entry for the changed OLD_VALUE constant, got %+v", entries)
	}
	if e.Kind != callresolve.KindClassConstantChange {
		t.Errorf("OLD_VALUE kind=%q, want %q", e.Kind, callresolve.KindClassConstantChange)
	}
}

// TestResolveClassMembersAddedFile: with no base side at all every member
// counts as changed, so an added file's properties all get a card.
func TestResolveClassMembersAddedFile(t *testing.T) {
	dataDir := t.TempDir()
	pr := 72
	_, headDir := worktreeDirs(dataDir, "", pr)
	const file = "app/Services/Fresh.php"
	writeWorktreeFiles(t, headDir, map[string]string{file: `<?php
namespace App\Services;

class Fresh
{
    private string $name = 'x';

    public function run() {}
}
`})

	caller := Block{PR: pr, File: file, Class: "Fresh", Name: classHeaderSentinel, Side: SideNew, Status: StatusAdded}
	entries := resolveClassMembers(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "class_member:prop:$name")
	if !ok {
		t.Fatalf("no entry for $name on an added file, got %+v", entries)
	}
	if e.Kind != callresolve.KindClassProperty {
		t.Errorf("$name kind=%q, want %q", e.Kind, callresolve.KindClassProperty)
	}
}

// TestResolveClassMembersAttachedToSibling: with another changed, non-header
// top-level block of the SAME class in this PR — and NO change in the header's
// own members — the header's member cards attach to that sibling's CallerID
// instead of the header's own — on explicit request, so the reviewer can hide
// the <class-header> block from the index entirely once its content is
// reachable via a sibling (see swallowedClassHeaderIds, home.mjs). The header
// itself, if also passed in, gets NO member entries of its own in this case.
//
// Both sides therefore declare the SAME constant: a CHANGED member keeps the
// header as its own caller instead, see
// TestResolveClassMembersChangedMemberStaysOnHeader.
func TestResolveClassMembersAttachedToSibling(t *testing.T) {
	dataDir := t.TempDir()
	pr := 74
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	const file = "app/Flows/ImportSubscriptionStatsFlow.php"
	const src = `<?php
namespace App\Flows;

class ImportSubscriptionStatsFlow
{
    private const int BATCH_SIZE = 100;

    public function run()
    {
    }
}
`
	writeWorktreeFiles(t, baseDir, map[string]string{file: src})
	writeWorktreeFiles(t, headDir, map[string]string{file: src})

	header := Block{PR: pr, File: file, Class: "ImportSubscriptionStatsFlow", Name: classHeaderSentinel, Side: SideNew, Status: StatusModified}
	sibling := Block{PR: pr, File: file, Class: "ImportSubscriptionStatsFlow", Name: "run", Side: SideNew, Status: StatusModified}
	entries := resolveClassMembers(dataDir, pr, []Block{header, sibling})

	var forSibling, forHeader []callresolve.Entry
	for _, e := range entries {
		if e.CallKey != "class_member:const:BATCH_SIZE" {
			continue
		}
		if e.CallerID == sibling.ID() {
			forSibling = append(forSibling, e)
		}
		if e.CallerID == header.ID() {
			forHeader = append(forHeader, e)
		}
	}
	if len(forSibling) != 1 {
		t.Fatalf("sibling caller got %d BATCH_SIZE entries, want 1 (entries: %+v)", len(forSibling), entries)
	}
	if len(forHeader) != 0 {
		t.Fatalf("header caller got %d BATCH_SIZE entries, want 0 once a sibling exists", len(forHeader))
	}
}

// TestResolveClassMembersAttachedToEverySibling: with TWO changed siblings,
// every one of them gets the SAME member cards — no single "chosen" host.
func TestResolveClassMembersAttachedToEverySibling(t *testing.T) {
	dataDir := t.TempDir()
	pr := 75
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	const file = "app/Flows/ImportSubscriptionStatsFlow.php"
	// Same constant on both sides — an UNCHANGED member is what makes the
	// sibling attachment apply at all (see headerHasOwnChange).
	const src = `<?php
namespace App\Flows;

class ImportSubscriptionStatsFlow
{
    private const int BATCH_SIZE = 100;

    public function run()
    {
    }

    public function finish()
    {
    }
}
`
	writeWorktreeFiles(t, baseDir, map[string]string{file: src})
	writeWorktreeFiles(t, headDir, map[string]string{file: src})

	header := Block{PR: pr, File: file, Class: "ImportSubscriptionStatsFlow", Name: classHeaderSentinel, Side: SideNew, Status: StatusModified}
	run := Block{PR: pr, File: file, Class: "ImportSubscriptionStatsFlow", Name: "run", Side: SideNew, Status: StatusModified}
	finish := Block{PR: pr, File: file, Class: "ImportSubscriptionStatsFlow", Name: "finish", Side: SideNew, Status: StatusModified}
	entries := resolveClassMembers(dataDir, pr, []Block{header, run, finish})

	for _, want := range []Block{run, finish} {
		found := false
		for _, e := range entries {
			if e.CallKey == "class_member:const:BATCH_SIZE" && e.CallerID == want.ID() {
				found = true
			}
		}
		if !found {
			t.Errorf("no BATCH_SIZE entry for sibling %q, got %+v", want.ID(), entries)
		}
	}
}

// TestResolveClassMembersChangedMemberStaysOnHeader: a header whose OWN member
// changed keeps its member cards on the header itself, even with a changed
// sibling in the same class — so the <class-header> block stays a visible,
// approvable row in the index instead of being swallowed (headerHasOwnChange;
// swallowedClassHeaderIds, home.mjs). Reindert: "als een php constante is
// aangepast, maar het kan niet als onderliggende code ergens aan gekoppeld
// worden, laat het dan zien als losse blok wat ik moet goedkeuren."
//
// Covers all three shapes of "its own member changed" — a changed constant, a
// changed property, and a REMOVED constant (never emitted as a card at all, so
// only the header's own diff shows it) — deliberately treated identically.
// TestResolveClassMembersChangedMemberAttachesToSibling pins the reversal of
// the old headerHasOwnChange rule: a header whose OWN constant/property changed
// (or lost one) used to keep its member cards on itself, so the changed row
// stayed approvable somewhere. Since splitClassHeaderMembers (phpscan.go) every
// member is a block of its own — approvable whether or not anything references
// it — so the cards now go to the changed sibling method unconditionally.
func TestResolveClassMembersChangedMemberAttachesToSibling(t *testing.T) {
	const file = "app/Flows/ImportSubscriptionStatsFlow.php"
	cases := []struct {
		name string
		pr   int
		base string
		head string
	}{
		{
			name: "changed constant",
			pr:   76,
			base: `<?php

class ImportSubscriptionStatsFlow
{
    private const int HEARTBEAT_TIMEOUT_MINUTES = 2;

    public function run()
    {
    }
}
`,
			head: `<?php

class ImportSubscriptionStatsFlow
{
    private const int HEARTBEAT_TIMEOUT_MINUTES = 20;

    public function run()
    {
    }
}
`,
		},
		{
			name: "changed property",
			pr:   77,
			base: `<?php

class ImportSubscriptionStatsFlow
{
    private const int BATCH_SIZE = 100;

    protected $queue = 'default';

    public function run()
    {
    }
}
`,
			head: `<?php

class ImportSubscriptionStatsFlow
{
    private const int BATCH_SIZE = 100;

    protected $queue = 'stats';

    public function run()
    {
    }
}
`,
		},
		{
			name: "removed constant",
			pr:   78,
			base: `<?php

class ImportSubscriptionStatsFlow
{
    private const int BATCH_SIZE = 100;

    private const int OLD_LIMIT = 5;

    public function run()
    {
    }
}
`,
			head: `<?php

class ImportSubscriptionStatsFlow
{
    private const int BATCH_SIZE = 100;

    public function run()
    {
    }
}
`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dataDir := t.TempDir()
			baseDir, headDir := worktreeDirs(dataDir, "", tc.pr)
			writeWorktreeFiles(t, baseDir, map[string]string{file: tc.base})
			writeWorktreeFiles(t, headDir, map[string]string{file: tc.head})

			header := Block{PR: tc.pr, File: file, Class: "ImportSubscriptionStatsFlow", Name: classHeaderSentinel, Side: SideNew, Status: StatusModified}
			sibling := Block{PR: tc.pr, File: file, Class: "ImportSubscriptionStatsFlow", Name: "run", Side: SideNew, Status: StatusModified}
			entries := resolveClassMembers(dataDir, tc.pr, []Block{header, sibling})

			if len(entries) == 0 {
				t.Fatalf("no member entries at all")
			}
			for _, e := range entries {
				if e.CallerID != sibling.ID() {
					t.Errorf("entry %s has caller %q, want the sibling %q", e.CallKey, e.CallerID, sibling.ID())
				}
			}
			_ = header
		})
	}
}

// TestResolveCallsConstRef covers rule 6b: a Foo::MAX_TRIES reference on a
// PLAIN (non-enum) class resolves to that constant's own declaration, and an
// ambiguous short class name stays silent.
func TestResolveCallsConstRef(t *testing.T) {
	dataDir := t.TempDir()
	pr := 73
	_, headDir := worktreeDirs(dataDir, "", pr)
	writeWorktreeFiles(t, headDir, map[string]string{
		"app/Services/RetryService.php": `<?php
namespace App\Services;

class RetryService
{
    public function attempt()
    {
        return Config::MAX_TRIES + Ambiguous::LIMIT;
    }
}
`,
		"app/Support/Config.php": `<?php
namespace App\Support;

class Config
{
    public const MAX_TRIES = 5;
}
`,
		"app/A/Ambiguous.php": `<?php
namespace App\A;

class Ambiguous
{
    public const LIMIT = 1;
}
`,
		"app/B/Ambiguous.php": `<?php
namespace App\B;

class Ambiguous
{
    public const LIMIT = 2;
}
`,
	})

	caller := Block{PR: pr, File: "app/Services/RetryService.php", Class: "RetryService", Name: "attempt", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "MAX_TRIES")
	if !ok {
		t.Fatalf("no entry for the Config::MAX_TRIES reference, got %+v", entries)
	}
	if e.Kind != callresolve.KindConstRef {
		t.Errorf("MAX_TRIES kind=%q, want %q", e.Kind, callresolve.KindConstRef)
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("MAX_TRIES status=%q, want resolved", e.Status)
	}
	if !strings.Contains(e.ChildCode, "const MAX_TRIES = 5") {
		t.Errorf("MAX_TRIES ChildCode=%q, want just the constant declaration", e.ChildCode)
	}
	if strings.Contains(e.ChildCode, "class Config") {
		t.Errorf("MAX_TRIES ChildCode must be the declaration only, not the class: %q", e.ChildCode)
	}
	if e.ChildFile != "app/Support/Config.php" {
		t.Errorf("MAX_TRIES ChildFile=%q, want app/Support/Config.php", e.ChildFile)
	}

	// Two classes with the same short name both declaring LIMIT → stay silent.
	if _, ok := findEntry(entries, "LIMIT"); ok {
		t.Errorf("an ambiguous constant reference must not produce an entry, got %+v", entries)
	}
}

// TestResolveCallsOwnClassConstRef covers rule 6b-bis: a self::/static:: (or
// own-class-name) constant reference resolves to its own declaration in the
// caller's file, including inside a Laravel migration's ANONYMOUS class — which
// has no class name and no <class-header> block, so both rule 6b's symbol-index
// lookup and rule 9's member cards used to leave it silently unresolved.
func TestResolveCallsOwnClassConstRef(t *testing.T) {
	dataDir := t.TempDir()
	pr := 74
	_, headDir := worktreeDirs(dataDir, "", pr)
	writeWorktreeFiles(t, headDir, map[string]string{
		"database/migrations/2026_08_21_120000_register.php": `<?php

use Illuminate\Database\Migrations\Migration;

return new class extends Migration
{
    private const ATTRIBUTES = [
        'PaymentId' => 'keyword',
        'TenantId' => 'int',
    ];

    public function up(): void
    {
        foreach (self::ATTRIBUTES as $name => $type) {
            $this->add($name, $type);
        }
    }
};
`,
		"app/Services/Retry.php": `<?php
namespace App\Services;

class Retry
{
    public const MAX_TRIES = 5;

    public function attempt()
    {
        return static::MAX_TRIES + Retry::MAX_TRIES;
    }
}
`,
	})

	// An anonymous migration class: Class is empty, so `self` matches nothing
	// in the symbol index and there is no <class-header> block either.
	anon := Block{PR: pr, File: "database/migrations/2026_08_21_120000_register.php", Class: "", Name: "up", Side: SideNew, Status: StatusAdded}
	entries := resolveCalls(dataDir, pr, []Block{anon})
	e, ok := findEntry(entries, "ATTRIBUTES")
	if !ok {
		t.Fatalf("no entry for the self::ATTRIBUTES reference, got %+v", entries)
	}
	if e.Kind != callresolve.KindConstRef || e.Status != callresolve.StatusResolved {
		t.Errorf("ATTRIBUTES kind=%q status=%q, want %q/resolved", e.Kind, e.Status, callresolve.KindConstRef)
	}
	if !strings.Contains(e.ChildCode, "const ATTRIBUTES") || !strings.Contains(e.ChildCode, "'TenantId' => 'int'") {
		t.Errorf("ATTRIBUTES ChildCode=%q, want the whole constant declaration", e.ChildCode)
	}
	if strings.Contains(e.ChildCode, "public function up") {
		t.Errorf("ATTRIBUTES ChildCode must be the declaration only, not the method: %q", e.ChildCode)
	}
	if e.ChildFile != anon.File {
		t.Errorf("ATTRIBUTES ChildFile=%q, want %q", e.ChildFile, anon.File)
	}

	// A NAMED class always has its header region read by rule 9, whether or not
	// this PR changed a header BLOCK (a header of nothing but constants leaves
	// no such block at all — splitClassHeaderMembers). So 6b-bis stays out of
	// the way and rule 9 supplies the one and only card.
	named := Block{PR: pr, File: "app/Services/Retry.php", Class: "Retry", Name: "attempt", Side: SideNew, Status: StatusModified}
	entries = resolveCalls(dataDir, pr, []Block{named})
	for _, e := range entries {
		if e.CallKey == "MAX_TRIES" {
			t.Fatalf("6b-bis must leave a named class's constant to rule 9: %+v", e)
		}
	}
	members := resolveClassMembers(dataDir, pr, []Block{named})
	n := 0
	for _, e := range members {
		if e.CallKey == "class_member:const:MAX_TRIES" {
			n++
			if e.CallerID != named.ID() {
				t.Errorf("MAX_TRIES caller=%q, want the changed method %q", e.CallerID, named.ID())
			}
		}
	}
	if n != 1 {
		t.Fatalf("want exactly one MAX_TRIES member card, got %d: %+v", n, members)
	}

	// With the <class-header> itself in the PR, rule 9 owns that declaration
	// and 6b-bis must stay out of the way — no second card.
	header := Block{PR: pr, File: "app/Services/Retry.php", Class: "Retry", Name: classHeaderSentinel, Side: SideNew, Status: StatusModified}
	entries = resolveCalls(dataDir, pr, []Block{named, header})
	if _, ok := findEntry(entries, "MAX_TRIES"); ok {
		t.Errorf("a changed <class-header> already emits the member card; 6b-bis must not add one: %+v", entries)
	}
}

// TestResolveCallsAppClassReceiver covers rule 4a: `app(Foo::class)->run(...)`
// names its own class literally, so the call resolves deterministically even
// though the bare method name `run` is ambiguous app-wide. Before this rule the
// call became `unresolved` and was shipped off to the LLM (resolve_call), which
// re-discovered exactly what the source already spells out — and produced a
// SECOND card next to rule 6c-bis's own entry-point row for the same class.
func TestResolveCallsAppClassReceiver(t *testing.T) {
	dataDir := t.TempDir()
	pr := 33
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"tests/Feature/BackfillTest.php": `<?php
namespace Tests\Feature;
final class BackfillTest {
    public function it_backfills(): void {
        app(BackfillActivity::class)->run('_v2');
    }
}
`,
		"app/Workflows/Activities/BackfillActivity.php": `<?php
namespace App\Workflows\Activities;
final class BackfillActivity {
    public function run(string $suffix): void {
    }
}
`,
		// A second, unrelated run() so idx.candidates("run") is ambiguous: without
		// rule 4a the call below falls through to StatusUnresolved.
		"app/Workflows/Activities/OtherActivity.php": `<?php
namespace App\Workflows\Activities;
final class OtherActivity {
    public function run(string $suffix): void {
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

	caller := Block{PR: pr, File: "tests/Feature/BackfillTest.php", Class: "BackfillTest", Name: "it_backfills", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	run, ok := findEntry(entries, "run")
	if !ok {
		t.Fatal("no entry for call key run")
	}
	if run.Status != callresolve.StatusResolved {
		t.Fatalf("run status=%q, want %q", run.Status, callresolve.StatusResolved)
	}
	if run.Kind != callresolve.KindMethodCall {
		t.Errorf("run kind=%q, want %q", run.Kind, callresolve.KindMethodCall)
	}
	if run.ChildClass != "BackfillActivity" || run.ChildMethod != "run" {
		t.Errorf("run resolved to %s::%s, want BackfillActivity::run", run.ChildClass, run.ChildMethod)
	}
}

// TestResolveCallsAppClassReceiverUnknownClass keeps rule 4a from swallowing the
// ordinary path: an unindexed (vendor/framework) class has no method to point
// at, so the call must still end up unresolved — LLM territory, as before.
func TestResolveCallsAppClassReceiverUnknownClass(t *testing.T) {
	dataDir := t.TempDir()
	pr := 34
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"tests/Feature/BackfillTest.php": `<?php
namespace Tests\Feature;
final class BackfillTest {
    public function it_backfills(): void {
        app(VendorOnlyActivity::class)->run('_v2');
    }
}
`,
		"app/Workflows/Activities/BackfillActivity.php": `<?php
namespace App\Workflows\Activities;
final class BackfillActivity {
    public function run(string $suffix): void {
    }
}
`,
		"app/Workflows/Activities/OtherActivity.php": `<?php
namespace App\Workflows\Activities;
final class OtherActivity {
    public function run(string $suffix): void {
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

	caller := Block{PR: pr, File: "tests/Feature/BackfillTest.php", Class: "BackfillTest", Name: "it_backfills", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	run, ok := findEntry(entries, "run")
	if !ok {
		t.Fatal("no entry for call key run")
	}
	if run.Status != callresolve.StatusUnresolved {
		t.Errorf("run status=%q, want %q", run.Status, callresolve.StatusUnresolved)
	}
}

// TestResolveCallsConstructorSelf: `new self(...)`/`new static(...)` construct
// the caller's OWN class, so they couple to that class's __construct — the call
// key stays the literal `self`/`static` (see rule 2b). The head version changes
// only ONE ARGUMENT LINE of a multi-line `new self(` whose `new self(` line
// itself is untouched, which is the case keepChanged's open-paren widening
// exists for: without it the scan never sees the call name and the reviewer gets
// no underlying code for the very argument he changed.
func TestResolveCallsConstructorSelf(t *testing.T) {
	dataDir := t.TempDir()
	pr := 77
	baseDir, headDir := worktreeDirs(dataDir, "", pr)
	base := `<?php
namespace App\Data;
final class SessionState {
    public function __construct(
        private readonly int $tenantId,
        private readonly string $sessionId,
    ) {
    }
    public static function fromArray(array $state): self
    {
        $instance = new self(
            tenantId : (int) $state['tenant_id'],
            sessionId: (string) $state['session'],
        );
        return $instance;
    }
    public static function fresh(int $tenantId): static
    {
        return new static($tenantId, '');
    }
}
`
	// Only the sessionId argument line differs; `new self(` itself is unchanged.
	head := strings.Replace(base, "$state['session']", "$state['session_id']", 1)
	for dir, body := range map[string]string{baseDir: base, headDir: head} {
		p := filepath.Join(dir, "app/Data/SessionState.php")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	caller := Block{PR: pr, File: "app/Data/SessionState.php", Class: "SessionState", Name: "fromArray", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	e, ok := findEntry(entries, "self")
	if !ok {
		t.Fatal("no entry for `new self(` (call key 'self')")
	}
	if e.Status != callresolve.StatusResolved {
		t.Errorf("status = %q, want resolved", e.Status)
	}
	if got := e.ChildClass + "::" + e.ChildMethod; got != "SessionState::__construct" {
		t.Errorf("child = %q, want SessionState::__construct", got)
	}
	if e.ChildCode == "" {
		t.Error("resolved constructor entry has empty child code")
	}

	// `new static(...)` resolves the same way, keyed by its own literal.
	fresh := Block{PR: pr, File: "app/Data/SessionState.php", Class: "SessionState", Name: "fresh", Side: SideNew, Status: StatusModified}
	freshEntries := resolveCalls(dataDir, pr, []Block{fresh})
	if _, ok := findEntry(freshEntries, "static"); ok {
		t.Error("`new static(` on an unchanged line should produce no entry")
	}
	// Change that line too, and it does.
	headFresh := strings.Replace(head, "return new static($tenantId, '');", "return new static($tenantId, 'x');", 1)
	p := filepath.Join(headDir, "app/Data/SessionState.php")
	if err := os.WriteFile(p, []byte(headFresh), 0o644); err != nil {
		t.Fatal(err)
	}
	e2, ok := findEntry(resolveCalls(dataDir, pr, []Block{fresh}), "static")
	if !ok {
		t.Fatal("no entry for `new static(` (call key 'static')")
	}
	if got := e2.ChildClass + "::" + e2.ChildMethod; got != "SessionState::__construct" {
		t.Errorf("static child = %q, want SessionState::__construct", got)
	}
}

// TestResolveCallsNewObjectFirstMethod covers rule 2b-bis: a `new Foo(...)`
// with no explicit chained call (a Laravel validation Rule object handed
// straight to a `rules()` array, the exact reported case) shows the class's
// first OTHER method next to its constructor, since no call site for that
// method — invoked only through the `Rule` interface — ever appears in the
// caller's own source.
func TestResolveCallsNewObjectFirstMethod(t *testing.T) {
	dataDir := t.TempDir()
	pr := 88
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Http/Requests/HeaderUpdateRequest.php": `<?php
namespace App\Http\Requests;
final class HeaderUpdateRequest {
    public function rules(): array {
        return [
            'description' => ['nullable', 'string', new MaxLengthWithoutHtml(3000)],
        ];
    }
}
`,
		"app/Rules/MaxLengthWithoutHtml.php": `<?php
namespace App\Rules;
final class MaxLengthWithoutHtml {
    public function __construct(private int $max) {
    }
    public function validate(string $attribute, mixed $value, \Closure $fail): void {
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

	caller := Block{PR: pr, File: "app/Http/Requests/HeaderUpdateRequest.php", Class: "HeaderUpdateRequest", Name: "rules", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	ctor, ok := findEntry(entries, "MaxLengthWithoutHtml")
	if !ok {
		t.Fatal("no entry for the constructor (call key 'MaxLengthWithoutHtml')")
	}
	if ctor.Kind != callresolve.KindMethodCall || ctor.ChildMethod != "__construct" {
		t.Errorf("ctor: kind=%q method=%q, want %q/__construct", ctor.Kind, ctor.ChildMethod, callresolve.KindMethodCall)
	}

	first, ok := findEntry(entries, "class_method:MaxLengthWithoutHtml")
	if !ok {
		t.Fatal("no entry for class_method:MaxLengthWithoutHtml")
	}
	if first.Kind != callresolve.KindClassFirstMethod || first.ChildMethod != "validate" {
		t.Errorf("first method: kind=%q method=%q, want %q/validate", first.Kind, first.ChildMethod, callresolve.KindClassFirstMethod)
	}
}

// TestResolveCallsNewObjectChainedCallNoFirstMethod covers the exclusion half
// of rule 2b-bis: a `new Foo(...)` that IS immediately chained into an
// explicit method call already names the exact method in play, so no
// `class_method:` entry point is added next to it — same reasoning as rule
// 6c-bis's own bare-`Foo::class` exclusion for this shape.
func TestResolveCallsNewObjectChainedCallNoFirstMethod(t *testing.T) {
	dataDir := t.TempDir()
	pr := 89
	_, headDir := worktreeDirs(dataDir, "", pr)
	files := map[string]string{
		"app/Services/Billing.php": `<?php
namespace App\Services;
final class Billing {
    public function charge(): void {
        $result = new Invoice(100)->render();
    }
}
`,
		"app/Services/Invoice.php": `<?php
namespace App\Services;
final class Invoice {
    public function __construct(private int $amount) {
    }
    public function render(): string {
        return '';
    }
    public function other(): void {
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

	caller := Block{PR: pr, File: "app/Services/Billing.php", Class: "Billing", Name: "charge", Side: SideNew, Status: StatusModified}
	entries := resolveCalls(dataDir, pr, []Block{caller})

	if _, ok := findEntry(entries, "Invoice"); !ok {
		t.Fatal("no entry for the constructor (call key 'Invoice')")
	}
	if _, ok := findEntry(entries, "class_method:Invoice"); ok {
		t.Error("class_method:Invoice should not be emitted next to an explicitly chained call")
	}
}
