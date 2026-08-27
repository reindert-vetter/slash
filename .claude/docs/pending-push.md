# Landed but not pushed: the pending ref and its todo

What happens between "Claude, pas dit aan" and that change being on GitHub.

**The write side changed underneath this file.** A reviewer-requested Claude
edit used to be committed in a per-conversation, disposable shadow worktree
(`chat_shadow.go`); it is now committed directly in the PR's ONE shared,
standing local checkout of the reviewer's own — resolved once per PR and
remembered for the rest of the review, never a throwaway branch. See
`chat_checkout.go` and `todo/todo-local-checkout-chat-edits.md` (kept local/
uncommitted) for the selection ladder and the dirty/ambiguous-checkout
consult. Nothing in THIS file's own subject — the landing target, its
visibility, and the push — changed: landing still advances the same
`refs/slash/pending/pr-<n>/<headRef>` ref, only now via a local, network-less
`git fetch` of the checkout's new commit INTO the shared clone first
(`advancePendingRefFromCheckout`), since that ref lives in the shared clone,
never in the reviewer's own checkout.

A reviewer-requested Claude edit is committed in the PR's shared local
checkout and then **lands on the PR's branch locally**, not on GitHub. The push
is a separate, deliberate step the reviewer fires from a **todo row at the very
bottom of the block index**. In between, the change is fully part of the review
tree: it is ingested, diffed, approvable, commentable — the reviewer reviews his
own change before anyone else sees it, and the checkout itself is never touched
beyond that (no worktree to reclaim any more — it's the reviewer's own,
permanent clone).

**Before landing, there is now a live "wordt aangepast" status too.** A file a
still-running turn is editing shows its own per-block pill immediately — see
"'Wordt aangepast': a live, per-block status while an edit hasn't landed yet"
in `.claude/docs/claude-chat-panel.md` (`chat_edit_pending.go`). It is a
DIFFERENT signal from everything below: this file is about the landed
change becoming visible/diffable and the separate, deliberate push step;
"wordt aangepast" is about the time BEFORE that landing has even happened.

**The landing itself is automatic, not a second reviewer step.** The reviewer
only ever asks Claude to commit in plain words; Claude's own `git commit` (run
via Bash in that checkout, see "Two-step tool access"/chat_shell.md in
`.claude/docs/workflows-comments.md`) never itself moves anything onto the PR
branch — the `runClaudeTurn` Activity notices the checkout has something
pending after a turn that itself changed it (`turnChangedCheckout` +
`chatCheckoutNeedsLanding`; a read-only question turn never lands anything,
not even work the shared checkout already held) and lands/merges it the
same way an explicit "commit deze wijziging" always did (see "Automatic
landing after a shell turn" in that same doc). Push, unlike landing, stays a
deliberate, reviewer-only step — never automatic, never `--force`.

Mechanics of the chat turn itself (the shared checkout, the `chat_merge`
queue, conflict resolution) live in `.claude/docs/workflows-comments.md`; this
file is about the landing target, the visibility, and the push.

## The landing target: `refs/slash/pending/pr-<n>/<headRef>`

`prPendingRef` (`chat_checkout.go`). One ref per PR, holding every landed chat
commit for it.

- **Deliberately NOT `refs/heads/<headRef>`.** The clone `runGit` works in is
  the SHARED ingest clone, where a branch of that name may already exist. A
  ref outside `refs/heads` never appears in `git branch`, cannot collide with
  a checkout, and pushes just as well (`<pendingRef>:refs/heads/<headRef>`).
- **The branch name is part of the ref PATH** so every reader recovers it from
  git alone (`git for-each-ref refs/slash/pending/pr-<n>/`). That is what keeps
  the read model below purely local — no `gh` call on a plain `GET`.
- **`advancePendingRefFromCheckout`** is the only thing that ever moves it, and
  it only moves it FORWARD: `git push`'s own non-fast-forward refusal is gone
  together with the push, so containment is checked explicitly
  (`merge-base --is-ancestor <current> <new>`) before `update-ref`. Since a
  write turn now commits directly onto the checkout's own real branch (no more
  disposable `chat/<id>` branch to land FROM), this function first pulls that
  one commit from the checkout into the shared clone with a local,
  network-less `git fetch <checkout-dir> <sha>` — the checkout itself is never
  touched or removed, it is the reviewer's own permanent clone.
- **A second conversation of the same PR needs no "stacking" of its own any
  more** — every conversation of a PR shares the exact SAME checkout now
  (`chat_checkout.go`), so a second conversation's edit is simply the next
  sequential commit in that one directory, never a divergent branch to
  reconcile. The only remaining source of a real conflict is origin itself
  moving (someone pushing straight to the PR branch on GitHub) — see
  `resolveCheckoutMerge` in `chat_merge.go` (auto-merge against
  `origin/<headRef>` only now, one tip instead of two; a conflict it cannot
  resolve becomes a consultation message in the conversation itself, see
  `workflows-comments.md`).

## Amending a chain of chat commits (`commitCheckoutEditsAt`)

Reviewer request: several "commit deze wijziging" landings in a row, before a
push, should end up as ONE commit rather than a growing stack — easier to
review/push/revert as a single unit. Scoped deliberately narrow:

- **Only `commitCheckoutEditsAt`'s OWN commit** (the "commit deze wijziging"
  Activity's `git commit`, see below) is ever a candidate to amend. Claude's
  own free-text `git commit` run via Bash during a shell turn
  (`.claude/docs/workflows-comments.md`, "Two-step tool access") is
  deliberately **out of scope** — it has no fixed message convention, so there
  is no safe, positive way to recognize it (a heuristic like "not obviously
  manual" could just as easily match the reviewer's own commit in this same
  shared checkout). No prompt change, no required tag for that path.
- **Recognition is positive, not "not manual"**: `commitCheckoutEditsAt`'s own
  commits always carry the exact subject line `chatEditCommitSubject`
  ("Claude: reviewer-requested edit", `chat_checkout.go`) with the body as a
  bullet list of the conversation ids that landed into it (see the message
  format below). `amendableChatCommit` (`chat_checkout.go`) only treats HEAD
  as a candidate when ALL of:
  1. its subject is EXACTLY that string;
  2. it has exactly one parent (never a merge commit — see
     `resolveCheckoutMerge`'s own `git commit --no-edit` after a real
     conflict);
  3. it is **not already reachable from a freshly fetched
     `origin/<headRefName>`** — the hard "never rewrite a pushed commit"
     check, done with the checkout's own up-to-date fetch, not the coarser
     branch-wide ahead/behind count further down in `commitCheckoutEditsAt`.
- **PR-wide, not per-conversation**: the checkout is shared by every
  conversation of a PR (see the file header), so the "previous commit" being
  amended into may belong to a *different* chat thread than the one landing
  now — deliberate, two unrelated reviewer requests can end up folded into one
  commit.
- **Message format**: `chatEditCommitMessage(conversationID)` builds the
  FIRST landing's message (subject, blank line, one `- <conversationId>`
  bullet); `appendChatEditCommitMessage(existing, conversationID)` adds one
  more bullet to an existing message on every amend — so the message always
  shows every request that went into the commit, in landing order, never just
  the latest one silently replacing the rest.
- **The pending ref then has to move non-fast-forward.** An amend rewrites
  HEAD rather than extending it (same parent, new SHA), so
  `advancePendingRefFromCheckout` gained an `allowAmend` parameter: only
  `commitCheckoutEditsAt` ever passes `true`, and only right after it actually
  ran `git commit --amend` — every other caller (the ordinary landing path,
  `resolveCheckoutMerge`'s conflict-resolution landing) still passes `false`
  and keeps the strict fast-forward-only check. This is deliberately not a
  general non-fast-forward escape hatch: the one authoritative "was this ever
  pushed" check already happened, against a fresh fetch, in
  `amendableChatCommit` just before the amend, and nothing else can move the
  ref in between because `chat_merge`'s queue serializes this PR's landings
  one at a time.
- **The ingest-refresh SHA changes underneath it, as expected**: after an
  amend the old SHA is gone; `refreshTreeAfterLanding` re-reads the pending
  ref (now pointing at the new, amended SHA) same as any other landing, so
  nothing extra was needed there — the pre-existing re-anchor pass already
  covers a SHA change.
- Tests: `TestCommitCheckoutEditsAmendsIntoPreviousUnpushedChatCommit` (folds
  a second, different-conversation landing into the first, pending ref
  follows the new SHA, both conversation ids end up in the message),
  `TestCommitCheckoutEditsDoesNotAmendAfterAPush` (a push in between forces a
  new commit), `TestAmendableChatCommitRejectsAMergeCommit`,
  `TestAmendableChatCommitRejectsAManualCommit` — all in
  `chat_checkout_test.go`.

## Visible immediately: the refresh at a local SHA

`refreshTreeAfterLanding` (`chat_merge.go`) signals the PR's own `pr_status`
tracker with the pending ref's commit as `HeadSHA` and the **already recorded**
base SHA (so it stays a delta, not a full re-ingest). From there it is the
ordinary ingest-refresh branch: `refreshIngestDelta`, the re-anchor pass, the
relations + `code_warning` rebuild. Nothing in that branch cares whether the
head SHA is on GitHub — it only needs a locally reachable commit, which a landed
commit is by definition. Cross-workflow Ensure+Signal from inside an Activity,
best-effort/log-only, the shape `enqueueChatMerge`/`reanchorAfterRefresh`
already use.

**`ingestRefreshNeeded` (`workflows.go`) is what keeps it visible.** The poller
used to signal whenever the live `headRefOid` differed from the stored one —
with a landed commit that is true on *every* tick, so the tree would be rewound
to the older remote tip over and over. It now also requires that the stored head
does **not** already contain the remote tip:

- pushed → remote and stored are the same commit again → the plain equality case;
- landed, not pushed → stored contains remote → no refresh, the local commit
  stays;
- someone else pushed on top of an unpushed local commit → remote is no longer
  contained → the refresh fires and the tree deliberately follows GitHub again
  (the shared truth), until the pending commit is pushed.

## "Wordt bijgewerkt": auto-refreshing the reviewer's OWN landing

Reviewer request: "als claude net een aanpassing heeft gedaan waarom code is
aangepast/weg is, dan wil ik dat gelijk zien... label 'ongepusht' is niet
voldoende." Everything above makes the landing itself immediate, but there is
a real gap between "landed" (visible right away as `ongepusht`) and "the
block/diff panel actually shows the new code" — that only becomes true once
the ingest-refresh `refreshTreeAfterLanding` triggered actually completes.
Until this feature, nothing said so, and the one thing that DID exist for a
version-mismatch — the `blocks.changed` → `staleTreeRow` notice below — is a
manual, click-to-reload notice, deliberately so a colleague's surprise push
never yanks a reviewer's active approve-cursor out from under them (see "the
notice leaves the selection and the tree untouched" in
`tests/blocks-stale-notice.spec.mjs`). That same caution doesn't apply to the
reviewer's OWN just-requested edit — they asked for exactly this change, so
it's safe to apply the moment it's ready, no click needed.

### The ordering trap: this refresh is NOT actually async — don't design as if it were

`refreshTreeAfterLanding` (`chat_merge.go`) signals the PR's `pr_status`
tracker (`tm.engine.SignalWorkflow`). tembed's `Engine.SignalWorkflow`
(`tembed/engine.go`) drives that signal **fully inline**: it calls `advance()`
synchronously, which replays `prStatusWorkflow`'s body and, for any Activity
not yet in history, calls the registered Go function **directly**
(`Workflow.ExecuteActivity`, `tembed/workflow.go`) — no queue, no goroutine
dispatch. So by the time `refreshTreeAfterLanding` **returns**, the ENTIRE
ingest-refresh it triggered — `refreshIngestDelta`, the re-anchor pass,
`buildRelations`, kicking off `autoStartCodeWarning` — has already run to
completion, all inside that one call.

A first version of this feature got this wrong: it called
`markChatRefreshPendingFiles(...)` (the "wordt bijgewerkt" registry, below)
**after** `refreshTreeAfterLanding(...)` returned, reasoning that the refresh
would still be "in flight" at that point and a later `blocks.changed` could be
correlated against it. Because the refresh had, in fact, ALREADY completed
(including clearing that very registry from inside the nested Activity call)
before that line ever ran, the mark always landed on an already-emptied
registry — permanently stuck, and `blocks.changed` always reached the browser
before this tab had any chance to see the registry non-empty, so it
**always** fell back to the manual `staleTreeRow` path. **Symptom**: the
reviewer reported the auto-refresh feature simply didn't do anything —
confirmed by tracing the exact synchronous call chain, not by guessing.
**Lesson for any future change here**: never assume there is a wall-clock gap
between "landed" and "the tree caught up" for a chat-triggered refresh — there
isn't one, by design of this engine. A registry populated/read via a
SEPARATELY fetched read model (a second `GET`, even one triggered by its own
SSE event) can never reliably be checked against another event fired from
inside that same synchronous call — there is no ordering guarantee between two
independent fetches racing a single inline call chain. The fix below embeds
the answer directly in the event that matters, computed atomically at the
exact point of publish, so there is nothing left to race.

- **`chat_refresh_pending.go`** is a small PR-scoped in-memory registry, the
  same operational shape as `chat_edit_pending.go`'s "wordt aangepast" set:
  `markChatRefreshPendingFiles`/`clearChatRefreshPendingFiles`/
  `chatRefreshPendingFilesFor`. Populated in `processChatMergeAt`
  (`chat_merge.go`) **before** `refreshTreeAfterLanding` is even called (see
  the ordering trap above), from the exact file set `chat_edit_pending.go` is
  about to clear (the files the landed turn's own Edit/Write calls touched) —
  so a block reads three, not two, possible statuses in sequence: `wordt
  aangepast` (mid-turn) → `wordt bijgewerkt` (landed, tree not caught up yet)
  → `ongepusht` (until the reviewer pushes).
- **Cleared** the moment an ingest-refresh actually swaps the blocks table:
  both `scanAndStoreBlocks` and `refreshIngestDelta`'s Activities
  (`workflows.go`) call `clearChatRefreshPendingFiles` right before
  `publishBlocksChanged`.
- **Exposed on the existing `GET /api/chat/checkout`** read model
  (`checkoutView.RefreshingFiles`, `chat_checkout.go`) — no new endpoint,
  reusing the same poll/SSE cadence (`checkout.changed`, already published
  right after `PendingFiles` at landing time) the checkout chip already has.
  **This registry (and the pill it drives) is now PURELY COSMETIC** — see the
  race-free auto-refresh trigger below, which deliberately does not read it.
- **Frontend** (`home.mjs`): `checkoutRefreshingFiles()` mirrors
  `checkoutPendingFiles()`. `refreshingPill`/`opts.refreshing` (`BlockList.mjs`/
  `Block.mjs`) render the pill — a THIRD glyph/colour (`⟳`, violet) next to
  `unpushedPill`'s `⇧` and `editingPill`'s `✎`, so a block that is mid-edit,
  landed-not-refreshed, AND separately unpushed at once still reads as three
  distinct things, never colour alone.

### The auto-refresh trigger: embedded in the `blocks.changed` payload, not correlated against a second read model

Race-free by construction: `PRStateSignal` (`workflows.go`) carries a
`LandedFiles []string` field, set only by `refreshTreeAfterLanding` (empty for
the ordinary colleague-push poller, `pollIngestRefresh`). It travels — exactly
like `BaseSHA`/`HeadSHA` already did — through the recorded Signal payload into
`prStatusWorkflow`'s `HeadSHA != ""` branch, into the `refreshIngestDelta`
Activity's own input (`arg.LandedFiles`), which — in the SAME Activity call
that swaps the blocks table — publishes `blocks.changed` with those files
embedded directly in the event's own payload (`blocksChangedPayload`,
`eventbus.go`): `publishBlocksChanged(repo, pr, arg.LandedFiles)`. Nothing here
is a NEW Activity call or a change in call order, so replay stays deterministic
(`.claude/rules/workflow-determinism.md`) exactly like `BaseSHA`/`HeadSHA`
already were.

`home.mjs`'s `onEvent('blocks.changed', (ev) => ...)` reads `ev.data.landedFiles`
directly — **never** `state.checkout.refreshingFiles` (the registry above) —
to decide: non-empty → `refreshBlocksAfterOwnLanding(files)` (this reviewer's
own landing, safe to auto-apply); empty/absent → the existing manual
`staleTreeRow` flow (`state.blocksStale = true`), completely unchanged from
before this feature existed.

**Still just a routing hint, never the source of truth**
(`.claude/docs/server-events.md`): `refreshBlocksAfterOwnLanding` always does a
REAL `GET /api/blocks` fetch regardless of the payload; nothing is rendered
straight from the event. A dropped/missed `blocks.changed` frame (a resync, a
brief disconnect) simply falls back to whatever the NEXT `blocks.changed`
brings — worst case, the tab shows the ordinary manual notice one refresh
later, exactly the pre-existing, already-tested fallback. No workflow decision
anywhere depends on whether this frame ever reaches a browser.

- **If the reviewer's selected block itself disappeared** (the edit removed or
  moved the method/class the cursor was on): `refreshBlocksAfterOwnLanding`
  first lets `recomputeLeftList`'s ordinary id-preserving reindex run (falls
  back to index 0 if nothing else applies), then — only when the previously
  selected id is genuinely gone — looks for another block whose `file` is one
  of THIS landing's own touched files and selects the first such match in
  list order (reviewer's own call: "ga dan naar een gerelateerd bestand wat je
  net hebt aangepast, als dat mogelijk is"). No such candidate → the generic
  index-0 fallback stands, untouched.

#### Refreshing the blocks is not enough: the CODE and the approvals live outside them

Reviewer report: "ik zie de aanpassing niet verschijnen, ook na 10 seconden
niet, als ik dan refresh wel. ik heb ik vaker meegemaakt." Three separate
things had to be re-read, because `GET /api/blocks` carries neither of them and
the refresh replaces every block OBJECT with a fresh copy:

- **The source.** `b.code` is fetched lazily per block (`ensureCode`,
  `home.mjs`) and deduped in the module-level `codeRequested` Set (key
  `file|label|side`), which nothing ever cleared. `GET /api/code` reads the head
  worktree LIVE off disk (`code.go`'s `extractBlockSource`), and the
  ingest-refresh has already moved that worktree to the landed commit — so the
  server had the new source all along and only this Set kept it off screen,
  until a full page reload dropped the whole module. `invalidateCodeCache(files)`
  now drops the marks for the landing's own files (also
  `langSiblingRequested`, keyed by block id) BEFORE the fresh blocks are
  mounted. Symptom without it: the pre-landing code (the fresh objects had not
  been mounted yet) and then, once they were, a header-only card with no diff at
  all — never the new code.
- **The per-row approvals.** `b.approvedRows`/`b.approvedCalls` also live on the
  block object, so `loadApprovals()` is re-run (paired with the pre-existing
  `loadBlockStats()`), otherwise every checkmark and the "approve N/M" counter
  vanished from the refreshed blocks.
- **An open drilled column.** `state.drill` holds its own block objects; each
  level is re-pointed at the new object with the same `id` (a `synthetic` frame
  carries its source inline and is left alone), so a drilled column gets the new
  code and the fresh approvals too instead of silently staying on the
  pre-landing ones.

**Ordering matters, and the trap is the same one `loadBlocks` already avoids:**
`recomputeLeftList()` runs FIRST, and only then
`await Promise.all([loadApprovals(), loadBlockStats()])` + one more
`recomputeLeftList()`. Awaiting `loadApprovals` BEFORE that first recompute
wedged the selected card completely — it reassigns `state.allBlocks` wholesale,
which mid-swap collides with the card's own keyed rebuild (the co-subscriber /
keyed-node pitfalls in `.claude/rules/arrowjs-pitfalls.md`): the code was
fetched and `codeDiff` even ran, but its DOM never mounted, leaving a
header-only card forever. Measured/reproduced in
`tests/refreshing-pill.spec.mjs` — keep that order.

Tests: `TestBuildCheckoutViewReportsRefreshingFiles`
(`chat_checkout_test.go`), the `RefreshingFiles` assertion in
`TestProcessChatMergeClearsPendingEditedFilesOnSuccess` (`chat_merge_test.go`),
`TestPublishBlocksChangedCarriesLandedFiles` (`eventbus_test.go`),
`TestRefreshTreeAfterLandingPublishesLandedFilesThroughTheRealSignalChain`
(`chat_merge_test.go` — drives the REAL synchronous
`Engine.SignalWorkflow`/`ExecuteActivity` chain end to end against a throwaway
local git repo, the regression test for the ordering trap above — a
choreographed mock event would not have caught it), `tests/refreshing-pill.spec.mjs`
(the pill, the payload-driven auto-refresh-and-follow-selection round trip,
and the manual-fallback case with no `landedFiles` payload).

### The backstop for a MISSED `blocks.changed` frame: `pendingPushView.TreeCaughtUp`

Reviewer report: "na een claude aanpassing, blijft het zoeken naar nieuwe
aanpassing en is het niet zichtbaar (na 5 minuten nu)" — a real gap, not the
already-documented ordering trap above (that one is fully synchronous and was
confirmed unaffected). `blocks.changed` is deliberately excluded from
`onEventsResync` (see `.claude/docs/server-events.md`, "the one event that
does NOT refetch" — a bare reconnect must never raise a false stale-tree
notice), and `pollIngestRefresh`/`ingestRefreshNeeded` can never backstop THIS
specific case: it only reacts to the PR's **remote** head SHA moving, which a
landed-but-not-yet-pushed local commit never does. So if the one
`blocks.changed` frame this landing publishes is dropped on the wire (a full
64-frame subscriber buffer, or a resync racing the exact moment it fires — see
`eventbus.go`), a tab has no way back to a fresh tree short of a manual reload
— indefinitely, even though the backend itself already finished
(`refreshIngestDelta` is synchronous/inline, see the ordering trap above; it is
only the SSE **notification** of that completion that can go missing, never
the underlying ingest work).

`pendingPushView.TreeCaughtUp` (`pending_push.go`,
`ingestCaughtUpWithPendingRef`) closes this gap with a second, **git+DB-only**
signal that needs no event to reach the truth: it reports whether
`pr_ingest.head_sha` (written only by `scanAndStoreBlocks`/`refreshIngestDelta`)
already equals the pending ref's current commit. `db == nil` or no prior
ingest recorded at all → `true` (defensively "nothing to catch up to" rather
than a "still behind" that could never resolve for a PR with no full ingest to
land against).

**Frontend** (`src/home.mjs`): `loadPendingPush` — already polled by
`pendingpush.changed` and by the existing resync hook, both independent of the
`blocks.changed` frame — tracks a plain module variable
`pendingPushSyncedSha` (never reactive, same shape as `codeRequested`): the
pending-ref sha this TAB has already caught up to. Only when
`row.treeCaughtUp` is `true` **and** its sha differs from that tracked value
does it call the existing `refreshBlocksAfterOwnLanding(row.files)` — the same
function the ordinary `blocks.changed` handler already uses. This keeps the
hard rule intact: the very FIRST read after page load only establishes the
baseline and never fires (a fresh page load already gets a consistent tree
from `loadBlocks()`, and firing here too would refetch on every ordinary open
of a PR that happens to have older, already-reviewed unpushed work sitting on
it) — a bare reconnect with no NEW caught-up sha never triggers anything,
exactly like `blocks.changed`'s own exclusion from `onEventsResync` demands.
`refreshBlocksAfterOwnLanding` itself stamps `pendingPushSyncedSha` from
`state.pendingPush.sha` at the end of its own run too, so whichever of the two
paths (the SSE frame or this poll-based backstop) gets there first is what
counts — the other is then a no-op instead of a redundant second refetch.

**And that backstop no longer waits for an event either.** `loadPendingPush`
also runs on its own slow timer (`PENDING_PUSH_POLL_MS`, 10s, `src/home.mjs`,
alongside the existing `pollWorkflows`/`pollProblems` intervals). The reviewer
hit the case where BOTH frames of a landing went missing — `blocks.changed` AND
`pendingpush.changed` — after which nothing in the tab ever asked again:
`blocks.changed` is excluded from `onEventsResync` by design, and the server
only re-offers a `resync` on the next event or its 20s keepalive tick
(`sseKeepAlive`, `tasks_api.go`). The timer is deliberately the exact same
read, not a new source of truth: it is local-only (`for-each-ref` +
`rev-list --count` + `diff --name-only`, no network, no `gh`), and the
`treeCaughtUp && sha !== pendingPushSyncedSha` guard is what keeps every
ordinary tick a no-op — the ordinary `blocks.changed` frame still gets there
first whenever it arrives. Test: the "a landing whose SSE frames never arrive"
case in `tests/refreshing-pill.spec.mjs` (no events at all, only the poll).
**Why the frames go missing in the first place is a separate, still-open
question** (a full 64-frame subscriber buffer, a stream that died between the
two publishes): this only bounds the damage to one tick instead of "until a
manual reload".

Test: `TestLoadPendingPushTreeCaughtUpBackstop` (`pending_push_test.go`) pins
`TreeCaughtUp` purely against `pr_ingest`/the pending ref's git state, with no
event/workflow involved at all — the exact shape `loadPendingPush`'s polling
backstop above depends on.

## The push: a `"push"` Action on the PR's `chat_merge` queue

`pushPendingPR` (`pending_push.go`), reached via
`ChatMergeRequest{Action: "push"}`. It runs on the same per-PR queue that
serializes landings, so a push can never overlap one.

- An **Action on the existing `"merge"` Signal**, not a second Signal name:
  tembed's `WaitSignal` takes exactly one name and a workflow body may not
  select over two (`.claude/rules/workflow-determinism.md`). Same shape as
  `ChatMessageSignal.Action`/`ReactionSignal.Action`; branching on recorded
  Signal payload stays replay-deterministic.
- **`handleWorkflows` (`tasks_api.go`) has its own `case` for `SignalChatMerge`
  ("merge")** on `POST /api/workflows/{runID}/signals/merge` — the route
  `pushPendingWork` (`src/home.mjs`) actually calls. It accepts only
  `{"action":"push"}` and rejects the empty ("land") Action with 400: landing
  is only ever sent cross-workflow via a direct `engine.SignalWorkflow` call
  from `enqueueChatMerge` (which carries a real `ConversationID`), never from
  the UI. This case was missing for a while — every "push" click reached the
  generic dispatcher's fallback and got "unknown signal" (400), so the queue,
  the read model and the Activity all worked in isolation while the reviewer's
  actual button did nothing. Regression test:
  `TestHandleWorkflowsPushSignal` (`pending_push_test.go`).
- `git push origin <pendingRef>:refs/heads/<headRef>` — **never `--force`**, so
  git itself refuses a non-fast-forward. The local ref is dropped only after a
  successful push (which is also what lets `ingestRefreshNeeded` fall back to
  its equality case).
- A **refused push is expected behaviour**, not an error: the ref is kept, the
  reason is reduced to one actionable line (`pushFailureReason`), and the
  reviewer can merge the newer tip in via a fresh chat commit and press Enter
  again.
- `cleanup.go`'s `purgePR` sweeps a purged PR's pending refs
  (`removePendingRefs`).

## The read model: `GET /api/pending-push?prs=N[,N…]`

`handlePendingPush` (`tasks_api.go`) → `loadPendingPush`. Read-only and
local-only: `for-each-ref` + `rev-list --count` + `diff --name-only`, no fetch,
no `gh`. Batch-shaped because the PR overview asks about several rows at once.

Per PR: `headRef`, `sha`, `ahead`, `files`, `state`
(`ready`/`pushing`/`failed`), `pushRunId` (the `chat_merge` queue's own
deterministic Run ID, so the UI signals without deriving a Go-side id — same
shape as `state.approveRunId`) and `error`.

`ahead`/`files` are computed against whatever `origin/<headRef>` the last fetch
left behind: good enough for display, and never a decision input — the push
itself re-checks against the real remote.

**A ref whose commits are already on the branch reports nothing at all.** If
`rev-list --count origin/<headRef>..<pendingRef>` comes back exactly `0`, the
landed commits ARE on GitHub — the reviewer pushed the branch himself from his
own checkout, or the app pushed and then failed to drop the ref — so
`loadPendingPush` returns `nil` and clears the volatile status. Only a count of
`0` proves this; an unknown `origin/<headRef>` or a failed read keeps the
default `ahead: 1`, because "unknown" must never hide real work. Without this
the default `ahead: 1` survived a zero count and left a stale "⇧ ongepusht"
pill on every touched block, forever (reviewer report; regression test
`TestLoadPendingPushIgnoresARefAlreadyOnTheBranch`). The orphaned ref itself is
deliberately NOT deleted from this polled `GET` — a git write on every tick,
possibly next to an in-flight landing for the same PR, buys nothing; it is
swept with the PR (`removePendingRefs`, `cleanup.go`).

**The `pushing`/`failed` status is in-memory only** (`pendingPushStatus`), gone
after a restart, no read-model or workflow-history write — the same operational
carve-out as `chat_progress.go` (see
`.claude/rules/workflows-write-boundary.md`). The durable truth is git itself:
the pending ref either still exists or it doesn't.

`pendingpush.changed` (`eventbus.go`) nudges every tab watching the PR to
refetch, published on a landing and on every push transition. Like every other
event it is never the truth, only "refetch me" (`.claude/docs/server-events.md`).

## The UI

- **The todo row** (`pushTodoRow`, `src/BlockList.mjs`) sits at the very bottom
  of the index, below both toggle rows, under its own "Aan het einde" heading.
  Deliberately **not** a comment on a block: it belongs to no block, it belongs
  to the end of the review. It names the branch and the commit count and states
  its status in **words** (`klaar om te pushen` / `pushen…` /
  `push mislukt — Enter probeert opnieuw`) next to a `⇧` glyph — never colour
  alone. Its `.key()` encodes that status, since arrow.js reuses a keyed node
  without re-running its bindings.
- **It is the new bottom-most stop** of the sidebar's `↑`/`↓` loop
  (`state.pushTodoFocused`, mirroring `ignoreToggleFocused` everywhere — see
  `.claude/docs/keyboard-navigation.md`). `Enter` and a click do the same thing:
  open a **one-more-step confirm** menu (`pushTodoCommandsFor` →
  `pushTodoConfirmCommands`, the two-step shape "Keur de HELE PR goed" uses —
  "Wis Claude-gesprek" only confirms while the PR's shared checkout has
  pending work, see `.claude/docs/claude-chat-panel.md`), so
  the first keypress never pushes. Confirming calls `pushPendingWork`, which
  signals the queue.
- **Per-block marking**: an index row (`unpushedPill`, `BlockList.mjs`) and the
  block's own diff card (`opts.unpushed`, `Block.mjs`) show `⇧ ongepusht` when
  their file is in `files`. Per **file**, not per block — as fine-grained as the
  read model's git diff gets without re-deriving blocks for an unpushed commit;
  a file with several changed blocks marks all of them. Accepted trade-off.
- **PR overview**: an `Ongepusht N` badge per ingested row (`unpushedPill`,
  `src/overview.mjs`, backfilled by `kickOffPendingPush` exactly like the
  approval badge) so "this one still has something of mine waiting" is visible
  before opening the tree. See `.claude/docs/pr-overview.md`.

## Tests

`pending_push_test.go` (read model, both push outcomes against a throwaway
bare-repo-as-origin, the queue's Action dispatch), `chat_checkout_test.go`
(landing on the ref without pushing, a refused landing, the selection ladder,
the submodule-safety guard), `chat_merge_test.go` (two conversations of the
same PR landing sequentially on the SAME checkout, a real merge conflict
against origin), `ingest_delta_test.go` (`ingestRefreshNeeded` with a local
commit), `tests/pending-push-todo.spec.mjs` (the row, the confirm flow, the
keyboard stop, the block marking, the overview badge).
