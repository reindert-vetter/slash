// globalSetup: build the Go binary ONCE for the whole run. Each worker then
// seeds its own DB and starts its own server against this binary (see
// _fixtures.mjs) — so we never rebuild per test and workers don't share write
// state. The per-worker DBs/servers live under tests/.tmp/w<n>/.
//
// Every fixture worktree this file materializes lands under TEST_DATA_DIR
// (tests/.tmp/data), NOT the live data/ tree, and every worker server runs
// with `-data tests/.tmp/data` (see _fixtures.mjs). Two reasons:
//  1. A test run must never touch the reviewer's real worktrees/DBs. The live
//     data/ tree is owned by the running dev server and by the daily `cleanup`
//     workflow, which purges the data of PRs merged more than a week ago —
//     including, before this split, the fixture worktrees written here (the
//     fixture PR numbers are real, long-merged plug-and-pay PR numbers). That
//     wiped the suite's main anchor fixture out from under it.
//  2. It makes the whole suite reproducible from a fresh checkout: everything
//     the specs read off disk is written here, by hand, instead of coming from
//     a real `gh`/`git` ingest that another machine/CI can't reproduce.
// tests/.tmp is gitignored, so this stays generated-not-committed — the
// fixture *content* is committed (it lives in this file), the materialized
// tree is a build artifact, exactly like tests/.tmp/slash itself.
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

export const TEST_DATA_DIR = 'tests/.tmp/data'

// worktreeWriter returns a write(side, relPath, contents) for one fixture PR's
// base/head worktrees under TEST_DATA_DIR — the shared shape every
// materialize*Worktrees function below uses (it mirrors the layout
// worktreeDirs() in ingest.go expects: <data>/worktrees/pr-<n>-{base,head}).
function worktreeWriter(pr) {
  return (side, relPath, contents) => {
    const full = `${TEST_DATA_DIR}/worktrees/pr-${pr}-${side}/${relPath}`
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, contents)
  }
}

export default function globalSetup() {
  rmSync('tests/.tmp', { recursive: true, force: true })
  mkdirSync('tests/.tmp', { recursive: true })
  execSync('go build -o tests/.tmp/slash .', { stdio: 'inherit' })
  materializeMainWorktrees()
  materializeTreeWorktrees()
  materializeExplainWorktrees()
  materializeTestsGroupWorktrees()
  materializeArrowWorktrees()
  materializeRangeSelectWorktrees()
  materializePreviewWidthWorktrees()
  materializeDrillLineSkipWorktrees()
  materializeTranslationWorktrees()
  materializeDefaultSelWorktrees()
  materializeSvgWorktrees()
}

// materializeMainWorktrees writes the base/head worktrees for the suite's MAIN
// anchor fixture, PR 12903 (tests/fixtures/blocks.json) — the fixture most
// specs navigate: blocks.spec, navigate, urlstate, command-menu,
// postapprove-menu, review-submit-menu, drill-*, related-*, group-scope, …
//
// This used to be REAL data: a `gh`/`git` ingest of the actual plug-and-pay PR
// 12903, hand-topped-up with a couple of synthetic support files, living in the
// live data/ tree. That was unreproducible (a fresh checkout/CI never had it,
// and the on-disk pair had drifted away from the PR's real base/head SHAs) and
// — since the daily `cleanup` workflow purges the data of PRs merged over a
// week ago — deletable out from under the suite, which is exactly what
// happened. So the fixture is hand-written here now, like every other
// materialize*Worktrees function in this file.
//
// The specs pin down the required diff SHAPE precisely (see the fixture notes
// in postapprove-menu.spec.mjs / review-submit-menu.spec.mjs /
// drill-sibling-walk.spec.mjs); every file below is written to satisfy it:
//
//   - EXACTLY TWO blocks carry a change, one single-row change group each, so
//     that approving those two is "the whole PR approved" and the
//     block-spanning "next unapproved" search has a deterministic route:
//       * CreatePaymentAction::execute — `$order->address->update([` →
//         `$order->billingAddress->update([`. The changed line sits at
//         ABSOLUTE line 67 (execute itself starts at line 26): load-bearing
//         for group-scope.spec.mjs, whose relation fixture anchors
//         GroupScopeChildA on line 67 (inside the selected group → groupTier
//         0) and GroupScopeChildB on line 30 (outside it → groupTier 1). It
//         also sits ~40 lines into a deliberately long function body, so
//         drill-focus.spec.mjs's "the parent re-scrolls to its active change"
//         test has something to scroll (scrollTop > 0) — a short function
//         would fit the pane and never scroll at all.
//         Its new side splits into 3 call segments (`$order` /
//         `->billingAddress` / `->update([`), which is what lets `f` on the
//         single-row group jump straight to 'call' and then step to chg=1.
//       * Order::address — `morphOne(...)` → `billingAddress()`, likewise one
//         single-row group whose new side carries a call segment to underline.
//         Present in BOTH worktrees even though its fixture status is
//         'removed' (which only makes the card render one pane): drill-focus /
//         drill-sibling-walk / drill-preview patch that status to 'modified'
//         and expect a genuine two-sided diff.
//   - EVERY other block has ZERO changed rows: its file is byte-identical in
//     base and head. That includes the two `added` relation children
//     (GroupScopeChildA/B) — they must exist in the BASE worktree too, since an
//     added block whose base file is missing reads as all-new rows, which would
//     add changed rows to execute's subtree total and break "approving blocks 1
//     and 6 approves the PR".
//   - CreatePaymentAction::findOrCreateCustomer deliberately has no change of
//     its own while living in the SAME file as execute: that same-file
//     adjacency drives the connector/step-chevron/look-ahead-preview tests, and
//     its zero change groups give drill-sibling-walk a single-keypress
//     overflow.
function materializeMainWorktrees() {
  const write = worktreeWriter(12903)

  // pad(n) fills the gap up to a wanted line number with harmless, unchanged
  // body lines, so a block's declaration (and its one changed line) can sit at
  // the exact ABSOLUTE line the fixtures/specs expect. Every padded line is
  // identical in base and head, so it never shows up as a change.
  const pad = (n, indent = '        ') =>
    Array.from({ length: n }, (_, i) => `${indent}$step${i} = ${i};`).join('\n')

  // --- app/Actions/CreatePaymentAction.php ---------------------------------
  // Lines 1-25: header. Line 26: `execute`'s declaration. Line 67: the one
  // changed line. Everything else is identical on both sides.
  const createPayment = (addressProp) => `<?php

declare(strict_types=1);

namespace App\\Actions;

use App\\Enums\\AddressType;
use App\\Models\\Address;
use App\\Models\\Customer;
use App\\Models\\Order;
use App\\Support\\PaymentInputAdapter;
use App\\Support\\Psp;
use Illuminate\\Support\\Facades\\Redis;

/**
 * Creates a PSP payment for one of our own orders.
 *
 * The class-level docblock and the use-list above are only here to push
 * execute()'s declaration down to line 26 and its changed line to line 67 —
 * see materializeMainWorktrees in tests/_setup.mjs for why those two absolute
 * line numbers are load-bearing.
 */
final class CreatePaymentAction
{
    // Create a new PSP payment based on our internal Order model
    public static function execute(Order $order, array $options): ?array
    {
        $paymentResource = null;
        Psp::setMode($order->mode);

        if (!self::findOrCreateCustomer($order)) {
            return null;
        }

        // Transform our internal Order object to a format the PSP can handle
        $input = PaymentInputAdapter::get($order);
${pad(21)}

        // We must know the payment flow started, even without a response
        $order->payment_id = 'empty';
        $order->saveWithoutTimestamps();

        $paymentResource = Psp::createPayment($input);

        $order->payment_id = $paymentResource['id'];
        $order->save();
        $order->${addressProp}->update([
            'payment_options' => $paymentResource['options'],
        ]);

        return $paymentResource;
    }

    private static function findOrCreateCustomer(Order $order): bool
    {
        $customer = Customer::query()->firstWhere('email', $order->email);
        if ($customer === null) {
            $customer = Customer::create(['email' => $order->email]);
        }

        $order->customer_id = $customer->id;

        return true;
    }
}
`

  // --- app/Models/Order.php -----------------------------------------------
  // One changed line inside address(): a morphOne relation call becomes a
  // delegating call to billingAddress().
  const order = (addressBody) => `<?php

declare(strict_types=1);

namespace App\\Models;

class Order
{
    public function customer()
    {
        return $this->belongsTo(Customer::class);
    }

    public function address()
    {
        ${addressBody}
    }

    public function billingAddress()
    {
        return $this->morphOne(Address::class, 'addressable')->where('type', 'billing');
    }
}
`

  const same = {
    'app/Actions/ProcessCartAction.php': `<?php

declare(strict_types=1);

namespace App\\Actions;

class ProcessCartAction
{
    public function handle(array $cart): array
    {
        $lines = [];
        foreach ($cart as $item) {
            $lines[] = $this->buildLine($item);
        }

        return $lines;
    }

    private function buildLine(array $item): array
    {
        return ['sku' => $item['sku'], 'qty' => $item['qty']];
    }
}
`,
    'app/Enums/AddressType.php': `<?php

declare(strict_types=1);

namespace App\\Enums;

enum AddressType: string
{
    case BILLING = 'billing';
    case SHIPPING = 'shipping';

    public static function fromString(string $value): self
    {
        return self::from($value);
    }
}
`,
    'app/Http/Controllers/Api/ContractController.php': `<?php

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Models\\Contract;

/**
 * Read-only contract endpoints.
 *
 * Padded so index() starts at line 30 — blocks.spec.mjs asserts the card's
 * meta line reads ContractController.php:30, matching the seeded fixture.
 */
class ContractController
{
    private array $filters = [];

    private array $sorts = [];

    private int $perPage = 25;

    public function __construct()
    {
        $this->filters = [];
    }

    public function index()
    {
        $contracts = Contract::query()->paginate($this->perPage);

        return $contracts;
    }
}
`,
    'app/Models/Address.php': `<?php

declare(strict_types=1);

namespace App\\Models;

class Address
{
    public function billingAddress()
    {
        return $this->where('type', 'billing');
    }
}
`,
    'database/migrations/2026_07_06_120000_add_type_to_addresses_table.php': `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('addresses', function (Blueprint $table) {
            $table->string('type')->default('billing');
        });
    }
};
`,
    'tests/Feature/Addresses/AddressTypeTest.php': `<?php

declare(strict_types=1);

namespace Tests\\Feature\\Addresses;

use App\\Enums\\AddressType;
use Tests\\TestCase;

class AddressTypeTest extends TestCase
{
    public function test_it_casts_type(): void
    {
        $this->assertSame(AddressType::BILLING, AddressType::fromString('billing'));
    }
}
`,
    'zzz_test_support/GroupScopeChildA.php': `<?php

namespace ZzzTestSupport;

class GroupScopeChildA
{
    public function run()
    {
        return 'a';
    }
}
`,
    'zzz_test_support/GroupScopeChildB.php': `<?php

namespace ZzzTestSupport;

class GroupScopeChildB
{
    public function run()
    {
        return 'b';
    }
}
`,
  }

  write('base', 'app/Actions/CreatePaymentAction.php', createPayment('address'))
  write('head', 'app/Actions/CreatePaymentAction.php', createPayment('billingAddress'))
  write(
    'base',
    'app/Models/Order.php',
    order("return $this->morphOne(Address::class, 'addressable');"),
  )
  write('head', 'app/Models/Order.php', order('return $this->billingAddress();'))
  for (const [rel, contents] of Object.entries(same)) {
    write('base', rel, contents)
    write('head', rel, contents)
  }
}

// materializeDefaultSelWorktrees writes the synthetic PR 108 fixture worktrees
// for fresh-open-default-selection.spec.mjs (same rationale/mold as
// materializeTreeWorktrees above, but its OWN PR number — PR 95 is mutated to
// fully-approved by postapprove-tree.spec.mjs without cleanup, so reusing it
// here would make this spec's outcome depend on run order within the same
// worker). Two independent, hand-written PHP files with one real changed line
// each (deliberately NOT linked via a relation — a relation child's approval
// count rolls up into its parent's combined subtree total, see
// subtreeApproveCount/detail-layout.md, so a parent can never itself read as
// "fully approved" while its own child is still open; two independent
// top-level blocks keep this fixture's approval math simple and
// unambiguous), so GET /api/blockstats has an actual on-disk diff to read —
// that's what lets a plain `rows:[0]` signal fully approve a block via the
// approve workflow (see fresh-open-default-selection.spec.mjs).
function materializeDefaultSelWorktrees() {
  const file = (name, method, value) => `<?php

namespace App\\Actions;

class ${name}
{
    public function ${method}()
    {
        $value = ${value};
        return $value;
    }
}
`
  const write = worktreeWriter(108)
  write('base', 'app/Actions/DefaultSelBlockA.php', file('DefaultSelBlockA', 'run', 1))
  write('head', 'app/Actions/DefaultSelBlockA.php', file('DefaultSelBlockA', 'run', 2))
  write('base', 'app/Actions/DefaultSelBlockB.php', file('DefaultSelBlockB', 'run', 1))
  write('head', 'app/Actions/DefaultSelBlockB.php', file('DefaultSelBlockB', 'run', 2))
}

// materializeTranslationWorktrees writes the synthetic PR 107 fixture worktrees
// for translation.spec.mjs (same rationale as materializeTreeWorktrees above): a
// changed Laravel lang file `resources/lang/nl/checkout.php` (a TRANSLATION
// block → the changes-only key overview), its unchanged `en` sibling (for the
// read-only companion card + GET /api/langsiblings), and a caller
// CheckoutRequest::messages that references two keys via trans()/__() (the
// resolved translation children come from tests/fixtures/translation-callresolve.json).
function materializeTranslationWorktrees() {
  const nlBase = `<?php

return [
    'foo' => 'oud',
    'bar' => 'zelfde',
    'weg' => 'verwijderd',
    'only_nl' => 'alleen nl',
];
`
  const nlHead = `<?php

return [
    'foo' => 'nieuw',
    'bar' => 'zelfde',
    'extra' => 'toegevoegd',
    'only_nl' => 'alleen nl',
];
`
  const en = `<?php

return [
    'foo' => 'new-en',
    'bar' => 'same',
    'extra' => 'added-en',
];
`
  const caller = (body) => `<?php

namespace App\\Http\\Requests;

class CheckoutRequest
{
    public function messages()
    {
        return [${body}];
    }
}
`
  const write = worktreeWriter(107)
  write('base', 'resources/lang/nl/checkout.php', nlBase)
  write('head', 'resources/lang/nl/checkout.php', nlHead)
  write('base', 'resources/lang/en/checkout.php', en)
  write('head', 'resources/lang/en/checkout.php', en)
  write('base', 'app/Http/Requests/CheckoutRequest.php', caller(''))
  write(
    'head',
    'app/Http/Requests/CheckoutRequest.php',
    caller("\n            'x' => trans('checkout.foo'),\n            'y' => __('checkout.only_nl'),\n        "),
  )
}

// materializeTreeWorktrees writes the (gitignored, normally real-git-derived)
// base/head worktree files for the synthetic PR 95 fixture used by
// postapprove-tree.spec.mjs — two tiny, hand-written PHP files with one real
// changed line each (parent + child, linked via tests/fixtures/tree-relations.json),
// so GET /api/code (and /api/blockstats) has an actual on-disk diff to read.
// Every other seeded fixture PR (90/91/92/93/94) deliberately has NO worktree
// on disk — their tests only exercise child-listing/drill mechanics, never
// real diff/approval content (see relations.spec.mjs) — but a tree-descent
// approve test needs something real to approve, and TEST_DATA_DIR/worktrees/
// is shared + read-only across workers (see _fixtures.mjs) rather than
// per-worker, so this writes it once here, like the binary build above,
// instead of relying on a real `gh`/`git` ingest that CI/a fresh checkout
// can't reproduce.
function materializeTreeWorktrees() {
  const file = (name, method, value) => `<?php

namespace App\\Actions;

class ${name}
{
    public function ${method}()
    {
        $value = ${value};
        return $value;
    }
}
`
  const write = worktreeWriter(95)
  write('base', 'app/Actions/TreeParentAction.php', file('TreeParentAction', 'execute', 1))
  write('head', 'app/Actions/TreeParentAction.php', file('TreeParentAction', 'execute', 2))
  write('base', 'app/Actions/TreeChildAction.php', file('TreeChildAction', 'run', 1))
  write('head', 'app/Actions/TreeChildAction.php', file('TreeChildAction', 'run', 2))
}

// materializeExplainWorktrees writes the synthetic PR 97 fixture worktrees for
// footer-explanation.spec.mjs (same rationale as materializeTreeWorktrees
// above): a parent function whose change introduces an if-statement, plus an
// event_listener child (tests/fixtures/explain-relations.json) with its own
// if-introducing change — so the footer's AI-description flow has a real,
// deterministic diff whose aligned rows — and thus the seeded unit keys
// group-2-4/line-2, see tests/fixtures/explanations.json — are fully fixed by
// these file contents, for both the top-level block and a drilled column.
// materializeTestsGroupWorktrees writes the synthetic PR 99 fixture worktrees
// for related-tests-group.spec.mjs (same rationale as materializeTreeWorktrees
// above): one production method plus two test methods, each with one real
// changed line, so keyboard navigation can genuinely enter the production
// block's diff (→) and step into its Onderliggende-code panel — where the two
// covering tests (tests/fixtures/testsgroup-testcovers.json) group into the
// horizontal tests bar next to a seeded resolved call
// (tests/fixtures/testsgroup-callresolve.json, the "other" non-test child).
function materializeTestsGroupWorktrees() {
  const file = (ns, name, method, value) => `<?php

namespace ${ns};

class ${name}
{
    public function ${method}()
    {
        $value = ${value};
        return $value;
    }
}
`
  const write = worktreeWriter(99)
  write('base', 'app/Models/TgOrder.php', file('App\\Models', 'TgOrder', 'billingAddress', 1))
  write('head', 'app/Models/TgOrder.php', file('App\\Models', 'TgOrder', 'billingAddress', 2))
  write('base', 'tests/Feature/TgOrderBillingTest.php', file('Tests\\Feature', 'TgOrderBillingTest', 'testBilling', 1))
  write('head', 'tests/Feature/TgOrderBillingTest.php', file('Tests\\Feature', 'TgOrderBillingTest', 'testBilling', 2))
  write('base', 'tests/Feature/TgOrderShippingTest.php', file('Tests\\Feature', 'TgOrderShippingTest', 'testShipping', 1))
  write('head', 'tests/Feature/TgOrderShippingTest.php', file('Tests\\Feature', 'TgOrderShippingTest', 'testShipping', 2))
}

// materializeArrowWorktrees writes the synthetic PR 100 fixture worktrees for
// call-arrows.spec.mjs (same rationale as materializeTreeWorktrees above): a
// caller with TWO separate changed groups — an unrelated group first (a
// changed $flag/$note pair, no call site at all — this is the reported-bug
// group: it's the DEFAULT active unit on entering the diff, and doesn't cover
// either call site) and, after a blank/unchanged line, a second group with
// the two adjacent call lines — `arrowHelper` resolves to
// ArrowHelperService::arrowHelper, itself a changed PR 100 block (so the
// call-arrow overlay draws an arrow to its child card), while `arrowPlain`
// resolves to a file the PR doesn't touch (an "Ongewijzigd" child — no arrow).
// A THIRD layer proves the overlay follows a drilled column, not just the
// top-level cursor: ArrowHelperService::arrowHelper itself calls
// ArrowNestedService::arrowNested on a changed line, so drilling into
// arrowHelper from the caller's Onderliggende-code panel (see
// call-arrows.spec.mjs) must show an arrow anchored inside THAT drilled
// column's own diff, scoped to its own drillCursor — not the top-level one.
// Seeded via tests/fixtures/arrow-blocks.json + arrow-callresolve.json.
function materializeArrowWorktrees() {
  const caller = (flag, note, h, p) => `<?php

namespace App\\Actions;

class ArrowCallerAction
{
    public function execute()
    {
        $flag = ${flag};
        $note = '${note}';

        $value = $this->calc->arrowHelper(${h});
        $other = $this->calc->arrowPlain(${p});
        return $value + $other;
    }
}
`
  const helper = (value, n) => `<?php

namespace App\\Services;

class ArrowHelperService
{
    public function arrowHelper()
    {
        $value = ${value};
        $nested = $this->service->arrowNested(${n});
        return $value + $nested;
    }
}
`
  const nested = (mult) => `<?php

namespace App\\Services;

class ArrowNestedService
{
    public function arrowNested($x)
    {
        return $x * ${mult};
    }
}
`
  const write = worktreeWriter(100)
  write('base', 'app/Actions/ArrowCallerAction.php', caller('false', 'old', 1, 1))
  write('head', 'app/Actions/ArrowCallerAction.php', caller('true', 'context', 2, 3))
  write('base', 'app/Services/ArrowHelperService.php', helper(1, 1))
  write('head', 'app/Services/ArrowHelperService.php', helper(2, 2))
  write('base', 'app/Services/ArrowNestedService.php', nested(2))
  write('head', 'app/Services/ArrowNestedService.php', nested(3))
}

function materializeExplainWorktrees() {
  const file = (name, method, varName, body) => `<?php

namespace App\\Actions;

class ${name}
{
    public function ${method}()
    {
${body}
        return $${varName};
    }
}
`
  const write = worktreeWriter(97)
  write('base', 'app/Actions/ExplainAction.php', file('ExplainAction', 'execute', 'value', '        $value = 1;'))
  write(
    'head',
    'app/Actions/ExplainAction.php',
    file('ExplainAction', 'execute', 'value', '        if ($value > 0) {\n            $value = 2;\n        }'),
  )
  write('base', 'app/Actions/ExplainChildAction.php', file('ExplainChildAction', 'handle', 'amount', '        $amount = 5;'))
  write(
    'head',
    'app/Actions/ExplainChildAction.php',
    file('ExplainChildAction', 'handle', 'amount', '        if ($amount > 10) {\n            $amount = 20;\n        }'),
  )
  // ExplainNoIfAction — a third block whose change is a plain, MULTI-LINE
  // reassignment with no if-statement at all: its one change group spans 2
  // rows (a paired "$value = 1;" → "$value = 2;" modification, plus a lone
  // "$extra = 3;" insert row) — footerExplain has nothing to show (no
  // "if"/"elseif" in the text), but footerUnit now DOES (the per-line inline
  // diff of the whole group). Used by the "footer shows a per-line diff for
  // a multi-row group" test in footer-explanation.spec.mjs — distinct from
  // ExplainAction/ExplainChildAction above, which both deliberately DO
  // introduce an if.
  write('base', 'app/Actions/ExplainNoIfAction.php', file('ExplainNoIfAction', 'execute', 'value', '        $value = 1;'))
  write(
    'head',
    'app/Actions/ExplainNoIfAction.php',
    file('ExplainNoIfAction', 'execute', 'value', '        $value = 2;\n        $extra = 3;'),
  )
}

// materializeRangeSelectWorktrees writes the synthetic PR 102 fixture worktree
// for range-select.spec.mjs (same rationale as materializeTreeWorktrees
// above): ONE file with two methods, so they're linked as same-file
// neighbours (the dashed connector) — needed to prove a Shift+ArrowDown range
// selection clamps at the block boundary instead of flowing into the next
// block like a plain ArrowDown does. `execute` changes FOUR lines in TWO
// separate runs of two ($a/$b, then $c/$d), split by one unchanged `$mid`
// line in between — so at gran==='line' there are still four contiguous
// gran==='line' units in a row (unaffected by the grouping, none split by
// MAX_GROUP since each run is well under 5), while at gran==='group' there
// are now two distinct group units to Shift-select across (the whole point
// of the group-level range-select test). `other` changes just one line,
// only used to prove the flow boundary.
function materializeRangeSelectWorktrees() {
  const contents = (a, b, c, d, x) => `<?php

namespace App\\Actions;

class RangeSelectAction
{
    public function execute()
    {
        $a = ${a};
        $b = ${b};
        $mid = 5;
        $c = ${c};
        $d = ${d};
        return $a + $b + $c + $d;
    }

    public function other()
    {
        $x = ${x};
        return $x;
    }
}
`
  const write = worktreeWriter(102)
  const rel = 'app/Actions/RangeSelectAction.php'
  write('base', rel, contents(0, 0, 0, 0, 8))
  write('head', rel, contents(1, 2, 3, 4, 9))
}

// materializePreviewWidthWorktrees writes the synthetic PR 105 fixture
// worktrees for preview-matches-active-width.spec.mjs (Task 29, same
// rationale as materializeTreeWorktrees above): a one-sided `added` block
// (selected — a whole new file, only written to the head worktree, never the
// base one) followed in the blocks list by a two-sided `modified` block (the
// look-ahead preview) — so the preview's own diff is genuinely two-sided
// (has real old+new text) and the test can prove home.mjs's
// activeSingleSided override actually collapses it to narrow + unified
// instead of showing its natural, wider, side-by-side both-panes diff.
function materializePreviewWidthWorktrees() {
  const file = (name, method, value) => `<?php

namespace App\\Actions;

class ${name}
{
    public function ${method}()
    {
        $value = ${value};
        return $value;
    }
}
`
  // PR 105 — previewwidth-blocks.json's own number. (This said 107 before, a
  // copy/paste slip from the translation fixture above: the worktrees landed
  // under pr-107 while the blocks were seeded as PR 105, so this fixture's
  // diffs were never actually on disk where /api/code looks for them.)
  const write = worktreeWriter(105)
  // Added block: head-only, no base file at all (fileAdded-equivalent).
  write('head', 'app/Actions/PreviewWidthAddedAction.php', file('PreviewWidthAddedAction', 'execute', 1))
  // Modified block: real old+new text, so its diff is genuinely two-sided.
  write('base', 'app/Actions/PreviewWidthModAction.php', file('PreviewWidthModAction', 'execute', 1))
  write('head', 'app/Actions/PreviewWidthModAction.php', file('PreviewWidthModAction', 'execute', 2))
}

// materializeDrillLineSkipWorktrees writes the synthetic PR 106 fixture
// worktrees for drill-approve-line-skip.spec.mjs (same rationale as
// materializeTreeWorktrees above): a parent block (one changed line, mold of
// the PR-95 tree fixture) whose event_listener child (TreeChildAction2::run)
// has TWO adjacent changed lines instead of one — contiguous, so they still
// form a single 'group' unit, but f (zoom in) splits them into two separate
// 'line' units. That shape is exactly what's needed to prove the "next unit
// stays in the same block" exception in afterApproveAction (home.mjs) also
// fires while a drilled Onderliggende-code column owns the keyboard, not only
// at the top level.
function materializeDrillLineSkipWorktrees() {
  const parent = (value) => `<?php

namespace App\\Actions;

class TreeParentAction2
{
    public function execute()
    {
        $value = ${value};
        return $value;
    }
}
`
  const child = (a, b) => `<?php

namespace App\\Actions;

class TreeChildAction2
{
    public function run()
    {
        $a = ${a};
        $b = ${b};
        return $a + $b;
    }
}
`
  const write = worktreeWriter(106)
  write('base', 'app/Actions/TreeParentAction2.php', parent(1))
  write('head', 'app/Actions/TreeParentAction2.php', parent(2))
  write('base', 'app/Actions/TreeChildAction2.php', child(1, 2))
  write('head', 'app/Actions/TreeChildAction2.php', child(10, 20))
}

// materializeSvgWorktrees writes the synthetic PR 109 fixture worktrees for
// svg-preview.spec.mjs: a changed `.svg` file (whole-file OTHER block, no PHP
// function to scan — see ScanBlocks' wholeFileBlock fallback in
// phpscan.go) with a genuinely different old/new circle color, driving
// Block.mjs's svgSlot rendered old/new <img> preview. A second `.svg` file
// carries a hostile payload (`<script>`/`onload=`) in BOTH its old and new
// content, to prove the preview never executes it (see svgDataUri's own doc
// comment on why an <img>-rendered data URI is safe for untrusted SVG).
function materializeSvgWorktrees() {
  const icon = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <circle cx="12" cy="12" r="10" fill="${color}"/>
</svg>
`
  const evil = `<svg xmlns="http://www.w3.org/2000/svg" onload="window.__svgXssFired=true">
  <script>window.__svgXssFired=true</script>
  <rect width="10" height="10" fill="#00f"/>
</svg>
`
  const write = worktreeWriter(109)
  write('base', 'public/icons/logo.svg', icon('#f00'))
  write('head', 'public/icons/logo.svg', icon('#0f0'))
  write('base', 'public/icons/evil.svg', evil)
  write('head', 'public/icons/evil.svg', evil)
}
