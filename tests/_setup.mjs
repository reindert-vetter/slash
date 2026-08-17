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
function worktreeWriter(pr, repoKey = '') {
  // A second repo's worktrees carry its key up front ("ops-pr-12-base"), exactly
  // like worktreeDirs in ingest.go — see repos.go.
  const prefix = repoKey ? `${repoKey}-` : ''
  return (side, relPath, contents) => {
    const full = `${TEST_DATA_DIR}/worktrees/${prefix}pr-${pr}-${side}/${relPath}`
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
  materializeTranslationScrollWorktrees()
  materializeDefaultSelWorktrees()
  materializeSvgWorktrees()
  materializeTestClassGroupWorktrees()
  materializeLineSummaryWorktrees()
  materializeClassMemberScopeWorktrees()
  materializeExplainRangeWorktrees()
  materializeWhenScopeWorktrees()
  materializeSignatureRefWorktrees()
  materializeScopeClassRefWorktrees()
  materializeSettings()
  materializeOpsRepoWorktrees()
}

// materializeOpsRepoWorktrees writes the base/head worktrees for the SECOND
// repo's fixture PR (plug-and-pay-ops#12, seeded by tests/fixtures/ops-blocks.json)
// — one hand-written PHP file with a real changed line, so the review tree of a
// non-primary repo has an actual on-disk diff to render. Its directory names carry
// the repo key ("ops-pr-12-base"), which is precisely the layout the server
// derives; if the two ever drift apart, the diff simply comes back empty and
// tests/tree-multi-repo.spec.mjs fails.
function materializeOpsRepoWorktrees() {
  const file = (value) => `<?php

namespace App\\Services;

class MollieCapitalImporter
{
    public function import()
    {
        $rows = ${value};
        return $rows;
    }
}
`
  const write = worktreeWriter(12, 'ops')
  write('base', 'app/Services/MollieCapitalImporter.php', file(1))
  write('head', 'app/Services/MollieCapitalImporter.php', file(2))
}

// materializeSettings writes TEST_DATA_DIR/settings.json with the SECOND
// reviewed repo configured (see repos.go). The shared inbox fixture carries one
// plug-and-pay-ops row, and without this entry the server would canonicalize
// that row's repo to "" (an unknown repo deliberately reads as the primary one)
// — so the multi-repo behaviour under test would silently not be exercised.
//
// Only `repos` is written, deliberately: a `me` block here would change what
// src/mentions.mjs treats as "me" for every mention spec, which has nothing to
// do with this. The primary repo is not listed either — the registry always
// prepends the built-in one and keeps honouring SLASH_REPO_DIR for it. The `dir`
// points inside tests/.tmp so nothing could ever reach a real clone; no spec
// runs git against the second repo (SLASH_GITHUB=off).
function materializeSettings() {
  mkdirSync(TEST_DATA_DIR, { recursive: true })
  writeFileSync(
    `${TEST_DATA_DIR}/settings.json`,
    JSON.stringify(
      {
        repos: [
          {
            slug: 'plug-and-pay/plug-and-pay-ops',
            key: 'ops',
            dir: 'tests/.tmp/data/ops-clone',
            baseBranch: 'master',
          },
        ],
      },
      null,
      2,
    ),
  )
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

// materializeTranslationScrollWorktrees writes the synthetic PR 111 fixture
// worktree for translation-scroll.spec.mjs — its own, DEDICATED lang file
// (resources/lang/nl/big.php) with 20 changed keys, deliberately more than
// fit in the block column's default height, so ↑/↓ through the per-key
// overview genuinely scrolls the highlighted row out of view. A separate PR
// number from materializeTranslationWorktrees' PR 107 above (whose 3-key
// fixture several OTHER specs assert exact content/counts against) —
// changing that one to grow it would break those. Test: this file's own
// spec proves scrollChangeIntoView (home.mjs) now actually brings the active
// key back into view on ArrowDown/ArrowUp, reusing the SAME mechanism a tall
// code diff already had (see .claude/docs/blocks-and-ingest.md,
// "Translation blocks").
function materializeTranslationScrollWorktrees() {
  const key = (i) => `k${String(i).padStart(2, '0')}`
  const line = (i, val) => `    '${key(i)}' => '${val}${i}',`
  const N = 20
  const base = Array.from({ length: N }, (_, i) => line(i, 'oud')).join('\n')
  const head = Array.from({ length: N }, (_, i) => line(i, 'nieuw')).join('\n')
  const nlBase = `<?php\n\nreturn [\n${base}\n];\n`
  const nlHead = `<?php\n\nreturn [\n${head}\n];\n`
  const write = worktreeWriter(111)
  write('base', 'resources/lang/nl/big.php', nlBase)
  write('head', 'resources/lang/nl/big.php', nlHead)
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
// The production method's HEAD version also makes a real call to
// AddressFormatter::formatAddress, right below its one changed line (so both
// rows land in the SAME, default change group) — needed since 'group'
// granularity now hard-filters an Onderliggende-code child whose call site
// doesn't sit inside the selected group (see group-scope.spec.mjs): without a
// genuine, on-a-changed-line call here, the seeded callresolve row would never
// actually be "in scope" and this fixture's "tests bar + one other child"
// premise (see related-tests-group.spec.mjs) would silently stop holding.
function materializeTestsGroupWorktrees() {
  const testFile = (ns, name, method, value) => `<?php

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
  const production = (value) => `<?php

namespace App\\Models;

class TgOrder
{
    public function billingAddress()
    {
        $value = ${value};
        $formatted = (new AddressFormatter())->formatAddress();
        return $value;
    }
}
`
  const write = worktreeWriter(99)
  write('base', 'app/Models/TgOrder.php', testFile('App\\Models', 'TgOrder', 'billingAddress', 1))
  write('head', 'app/Models/TgOrder.php', production(2))
  write('base', 'tests/Feature/TgOrderBillingTest.php', testFile('Tests\\Feature', 'TgOrderBillingTest', 'testBilling', 1))
  write('head', 'tests/Feature/TgOrderBillingTest.php', testFile('Tests\\Feature', 'TgOrderBillingTest', 'testBilling', 2))
  write('base', 'tests/Feature/TgOrderShippingTest.php', testFile('Tests\\Feature', 'TgOrderShippingTest', 'testShipping', 1))
  write('head', 'tests/Feature/TgOrderShippingTest.php', testFile('Tests\\Feature', 'TgOrderShippingTest', 'testShipping', 2))
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

// materializeTestClassGroupWorktrees writes the synthetic PR 110 fixture
// worktrees for test-class-grouping.spec.mjs: two TEST-category classes —
// TriggersIndexTest (two changed methods, tests/fixtures/
// testclassgroup-blocks.json) and SettingsStoreTest (one changed method,
// proving a class groups even with just a single method — see
// testClassRowItem/recomputeLeftList in home.mjs) — each with exactly one
// changed line (`$value = 1` → `$value = 2`) so the diff/approve mechanics
// have something real to act on.
function materializeTestClassGroupWorktrees() {
  const triggersIndex = (value) => `<?php

namespace Tests\\Feature;

class TriggersIndexTest
{
    public function it_should_index_triggers()
    {
        $value = ${value};
    }

    public function it_should_filter_triggers()
    {
        $value = ${value};
    }
}
`
  const settingsStore = (value) => `<?php

namespace Tests\\Feature;

class SettingsStoreTest
{
    public function it_should_store_settings()
    {
        $value = ${value};
    }
}
`
  // StoreHelper is a plain NON-test (OTHER) block in the same PR: because
  // groupTestClasses appends every test_class row after the non-test rest,
  // it lands as the FIRST sidebar row — the "one row further, also a
  // non-test row" landing spot for ↑ from SettingsStoreTest's methodes-kolom
  // edge (the old stepTestMethod flow-through skipped straight over it to
  // another test_class row / clamped — see test-class-grouping.spec.mjs).
  const storeHelper = (value) => `<?php

namespace Tests\\Feature;

class StoreHelper
{
    public function buildPayload()
    {
        $value = ${value};
    }
}
`
  const write = worktreeWriter(110)
  write('base', 'tests/Feature/TriggersIndexTest.php', triggersIndex(1))
  write('head', 'tests/Feature/TriggersIndexTest.php', triggersIndex(2))
  write('base', 'tests/Feature/SettingsStoreTest.php', settingsStore(1))
  write('head', 'tests/Feature/SettingsStoreTest.php', settingsStore(2))
  write('base', 'tests/Feature/StoreHelper.php', storeHelper(1))
  write('head', 'tests/Feature/StoreHelper.php', storeHelper(2))
}

// materializeLineSummaryWorktrees writes the synthetic PR 112 fixture
// worktrees for line-underlying-summary.spec.mjs's "per-line anchoring"
// regression: a caller whose ONE structural change-group spans TWO adjacent
// call lines (lineSummaryFirst then lineSummarySecond), each resolving to a
// DIFFERENT changed PR block (unlike PR 100's arrow fixture, where the
// second call deliberately resolves to an unchanged file for a separate
// test) — so both call sites are real, PR-block-backed lineChildSummaries
// entries. lineSummaryFirst has 1 changed row of its own, lineSummarySecond
// has 2, so each line's badge shows a distinct, independently-computed
// fraction ("0/1" resp. "0/2") — proving the two calls no longer collapse
// onto the group's first line ("0/3" combined) the way an earlier version of
// lineChildSummaries did.
function materializeLineSummaryWorktrees() {
  const caller = (a, b) => `<?php

namespace App\\Actions;

class LineSummaryCallerAction
{
    public function execute()
    {
        $first = $this->svc->lineSummaryFirst(${a});
        $second = $this->svc->lineSummarySecond(${b});
        return $first + $second;
    }
}
`
  const first = (value) => `<?php

namespace App\\Services;

class LineSummaryFirstService
{
    public function lineSummaryFirst()
    {
        $value = ${value};
        return $value;
    }
}
`
  const second = (x, y) => `<?php

namespace App\\Services;

class LineSummarySecondService
{
    public function lineSummarySecond()
    {
        $x = ${x};
        $y = ${y};
        return $x + $y;
    }
}
`
  const write = worktreeWriter(112)
  write('base', 'app/Actions/LineSummaryCallerAction.php', caller(1, 1))
  write('head', 'app/Actions/LineSummaryCallerAction.php', caller(2, 2))
  write('base', 'app/Services/LineSummaryFirstService.php', first(1))
  write('head', 'app/Services/LineSummaryFirstService.php', first(2))
  write('base', 'app/Services/LineSummarySecondService.php', second(1, 2))
  write('head', 'app/Services/LineSummarySecondService.php', second(10, 20))
}

// materializeClassMemberScopeWorktrees writes the synthetic PR 115 fixture
// worktrees for related-class-member-scope.spec.mjs: a class-member card
// (resolveClassMembers, rule 9 in workflows-analysis.md) attached to a
// SIBLING method that has TWO separate changed groups — one that actually
// uses the constant (`self::MAX_TRIES`) and one that doesn't
// (`$unrelated = …`) — so the group/line scoping sharpened on top of
// `3228440` has something real to prove: the member card shows only next to
// the group/line that uses it, not next to every changed group of that
// sibling. The two changed lines (11 and 13) are separated by an unchanged
// filler line (12) so changeGroups splits them into two independent groups
// rather than one run.
function materializeClassMemberScopeWorktrees() {
  const action = (unrelated, tries) => `<?php

namespace App\\Actions;

class ScopeMemberAction
{
    public const MAX_TRIES = 3;

    public function run()
    {
        $unrelated = ${unrelated};
        $filler = 1;
        $tries = ${tries};
    }
}
`
  const write = worktreeWriter(115)
  write('base', 'app/Actions/ScopeMemberAction.php', action(0, 0))
  write('head', 'app/Actions/ScopeMemberAction.php', action(1, 'self::MAX_TRIES'))
}

// materializeExplainRangeWorktrees writes the synthetic PR 116 fixture
// worktree for the MAX_EXPLAIN_LINES cap in footer-explanation-range.spec.mjs
// (footerUnitInfo, home.mjs — "Uitleg maximaal 10 regels", Reindert's answer to
// the auto-explain size question): a function with THREE separate 2-row
// change groups ($a/$b, $c/$d, $e/$f), each pair split from the next by three
// UNCHANGED filler rows ($g1a-c, $g2a-c) — a Shift+ArrowDown range merges two
// groups (row span 2+3+2=7, ≤10) or all three (2+3+2+3+2=12, >10), so the same
// two changed-row counts sit on either side of the cap depending only on how
// far the range is extended, with no separate fixture needed per case. Row
// numbering mirrors materializeExplainWorktrees' own (0: the function
// signature, 1: its opening brace, 2+: the body) — see that function's doc
// comment for why unitKey "group-2-8" below is exactly the two-group merge.
function materializeExplainRangeWorktrees() {
  const file = (a, b, c, d, e, f) => `<?php

namespace App\\Actions;

class ExplainRangeAction
{
    public function execute()
    {
        $a = ${a};
        $b = ${b};
        $g1a = 0;
        $g1b = 0;
        $g1c = 0;
        $c = ${c};
        $d = ${d};
        $g2a = 0;
        $g2b = 0;
        $g2c = 0;
        $e = ${e};
        $f = ${f};
        return $a + $b + $c + $d + $e + $f;
    }
}
`
  const write = worktreeWriter(116)
  write('base', 'app/Actions/ExplainRangeAction.php', file(0, 0, 0, 0, 0, 0))
  write('head', 'app/Actions/ExplainRangeAction.php', file(1, 2, 3, 4, 5, 6))
}

// materializeWhenScopeWorktrees writes the synthetic PR 119 fixture worktrees
// for testcovers-when-scope.spec.mjs: a class-level #[CoversMethod] (PR 119's
// entry in tests/fixtures/testcovers.json carries no `line` at all, mirroring
// the classZoneText fallback testcovers_analysis.go leaves at 0 for exactly
// this shape — see 121be8d and testCoverGroupTier in home.mjs) on a single
// TEST method with TWO separate Given/When/Then cycles.
//
// WhenScopeTest::it_computes_twice is entirely `added`, so every one of its
// 24 rows is a changed row; MAX_GROUP (5, Block.mjs's changeGroups) splits it
// into 5 groups: G0 rows[0-4] (#[Test]/signature/{/"// Given"/$subject=...),
// G1 rows[5-9] ($b/$c/$d/blank/the FIRST "// When" comment itself), G2
// rows[10-14] (the first "// When" STATEMENT + blank/"// Given"/$e/$f), G3
// rows[15-19] ($g/blank/the SECOND "// When" comment/its STATEMENT/blank),
// G4 rows[20-23] ("// Then"/both assertions/the closing brace). Only the two
// STATEMENT rows (10 and 18) are "// When" section rows per whenSectionRows'
// own rule (the comment row itself never counts) — and they land in TWO
// DIFFERENT groups (G2, G3), so the spec's "straddling" case is real: G2 and
// G3 must each independently show the covers card, G0/G1/G4 must not (G1
// proves the comment row alone doesn't count).
//
// WhenScopeSubject::compute is a genuinely changed (`modified`) production
// method, so the covers child is a real PR block with its own diff stat, not
// an "Unchanged" reference.
function materializeWhenScopeWorktrees() {
  const test = `<?php

namespace Tests\\Feature;

use App\\Services\\WhenScopeSubject;
use PHPUnit\\Framework\\Attributes\\CoversMethod;
use PHPUnit\\Framework\\Attributes\\Test;
use Tests\\TestCase;

#[CoversMethod(WhenScopeSubject::class, 'compute')]
final class WhenScopeTest extends TestCase
{
    #[Test]
    public function it_computes_twice(): void
    {
        // Given
        $subject = new WhenScopeSubject();
        $b = 2;
        $c = 3;
        $d = 4;

        // When
        $first = $subject->compute(1);

        // Given
        $e = 5;
        $f = 6;
        $g = 7;

        // When
        $second = $subject->compute(2);

        // Then
        $this->assertSame(1, $first);
        $this->assertSame(2, $second);
    }
}
`
  const subject = (body) => `<?php

namespace App\\Services;

class WhenScopeSubject
{
    public function compute(int $n): int
    {
        return ${body};
    }
}
`
  const write = worktreeWriter(119)
  write('head', 'tests/Feature/WhenScopeTest.php', test) // added — no base side
  write('base', 'app/Services/WhenScopeSubject.php', subject('$n'))
  write('head', 'app/Services/WhenScopeSubject.php', subject('$n * 10'))
}

// materializeSignatureRefWorktrees writes the synthetic PR 120 fixture
// worktree for signature-ref-unit.spec.mjs: a block whose fixture entry
// (tests/fixtures/signatureref-blocks.json) is declared `status: "added"` —
// independent of the classify.go symbol-index lookup that normally derives
// it, exactly like every other seeded-from-JSON fixture — while its base AND
// head worktree files share a byte-identical declaration line for
// SignatureRefAction::decode. /api/code (handleCode → extractBlockSource)
// scans both worktree files independently of the seeded status, so this
// reproduces a real, reachable combination: a method the classifier scores as
// newly added (e.g. a previously interface-only/abstract declaration that
// only now gets a body) whose signature TEXT still happens to already exist
// verbatim in the base file — see "functie naam is niet selecteerbaar" in
// .claude/docs/keyboard-navigation.md ("Reference units"). alignRows then
// pairs that one line as an unchanged `eq` row while every body row below it
// is a genuine addition, exactly like the reported ActivityCommandResult
// card.
function materializeSignatureRefWorktrees() {
  const write = worktreeWriter(120)
  const signature = 'public static function decode(string $output): mixed'
  write(
    'base',
    'app/Actions/SignatureRefAction.php',
    `<?php

namespace App\\Actions;

class SignatureRefAction
{
    ${signature}
    {
        return null;
    }
}
`,
  )
  write(
    'head',
    'app/Actions/SignatureRefAction.php',
    `<?php

namespace App\\Actions;

class SignatureRefAction
{
    ${signature}
    {
        \$lines = preg_split('/\\R/', \$output) ?: [];

        return \$lines[0] ?? null;
    }
}
`,
  )
}

// materializeScopeClassRefWorktrees writes the synthetic PR 121 fixture
// worktree for related-class-ref-entry-points-scope.spec.mjs: a `class_ctor:`/
// `class_method:` entry-point card (rule 6c-bis) must now be scoped to the
// group/line that actually carries the `Foo::class` reference, exactly like
// an ordinary call/a class-member card attached to a sibling — reversed on
// explicit request from the earlier "always block-level" exemption (reported
// bug: selecting an unrelated call on the same block still showed the
// referenced class's constructor/first-method cards, see isBlockLevelCallKey
// in home.mjs). Same two-separate-changed-groups shape as
// materializeClassMemberScopeWorktrees (PR 115): group 0 (`$unrelated`) never
// mentions the class, group 1 (`$repo = app(SomeRepo::class)`) does — the
// unchanged `$filler` line between them splits changeGroups into two
// independent runs.
function materializeScopeClassRefWorktrees() {
  const action = (unrelated, repo) => `<?php

namespace App\\Actions;

class ScopeClassRefAction
{
    public function run()
    {
        $unrelated = ${unrelated};
        $filler = 0;
        $repo = ${repo};
    }
}
`
  const write = worktreeWriter(121)
  write('base', 'app/Actions/ScopeClassRefAction.php', action(0, 'null'))
  write('head', 'app/Actions/ScopeClassRefAction.php', action(1, 'app(SomeRepo::class)'))
}
