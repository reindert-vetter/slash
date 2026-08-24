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
pending after EVERY turn (`chatCheckoutNeedsLanding`) and lands/merges it the
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
the ingest-refresh `refreshTreeAfterLanding` triggered actually completes,
which can take a few seconds. Until this feature, nothing said so, and the
one thing that DID exist for a version-mismatch — the `blocks.changed` →
`staleTreeRow` notice below — is a manual, click-to-reload notice, deliberately
so a colleague's surprise push never yanks a reviewer's active approve-cursor
out from under them (see "the notice leaves the selection and the tree
untouched" in `tests/blocks-stale-notice.spec.mjs`). That same caution doesn't
apply to the reviewer's OWN just-requested edit — they asked for exactly this
change, so it's safe to apply the moment it's ready, no click needed.

- **`chat_refresh_pending.go`** is a small PR-scoped in-memory registry, the
  same operational shape as `chat_edit_pending.go`'s "wordt aangepast" set:
  `markChatRefreshPendingFiles`/`clearChatRefreshPendingFiles`/
  `chatRefreshPendingFilesFor`. Populated in `processChatMergeAt`
  (`chat_merge.go`) the moment a landing succeeds, from the exact file set
  `chat_edit_pending.go` is about to clear (the files the landed turn's own
  Edit/Write calls touched) — so a block reads three, not two, possible
  statuses in sequence: `wordt aangepast` (mid-turn) → `wordt bijgewerkt`
  (landed, tree not caught up yet) → `ongepusht` (until the reviewer pushes).
- **Cleared** the moment an ingest-refresh actually swaps the blocks table:
  both `scanAndStoreBlocks` and `refreshIngestDelta`'s Activities
  (`workflows.go`) call `clearChatRefreshPendingFiles` right before
  `publishBlocksChanged` — the same instant the frontend's `blocks.changed`
  event fires, so the registry and the event go dark together.
- **Exposed on the existing `GET /api/chat/checkout`** read model
  (`checkoutView.RefreshingFiles`, `chat_checkout.go`) — no new endpoint,
  reusing the same poll/SSE cadence (`checkout.changed`, already published
  right after `PendingFiles` at landing time) the checkout chip already has.
- **Frontend** (`home.mjs`): `checkoutRefreshingFiles()` mirrors
  `checkoutPendingFiles()`. `refreshingPill`/`opts.refreshing` (`BlockList.mjs`/
  `Block.mjs`) render the pill — a THIRD glyph/colour (`⟳`, violet) next to
  `unpushedPill`'s `⇧` and `editingPill`'s `✎`, so a block that is mid-edit,
  landed-not-refreshed, AND separately unpushed at once still reads as three
  distinct things, never colour alone.
- **The auto-refresh itself**: `onEvent('blocks.changed', ...)` checks
  `checkoutRefreshingFiles()` BEFORE deciding what to do with the event. Non-empty
  (this event is this reviewer's own landing catching up) →
  `refreshBlocksAfterOwnLanding(files)` re-fetches `/api/blocks` + relations and
  reindexes, then re-fetches the checkout (clears the now-empty
  `refreshingFiles` locally too) — `state.blocksStale` is never set. Empty (a
  colleague's push, or this tab's own `checkout.changed` for the landing simply
  hasn't arrived yet) → the existing manual `staleTreeRow` flow, unchanged.
- **If the reviewer's selected block itself disappeared** (the edit removed or
  moved the method/class the cursor was on): `refreshBlocksAfterOwnLanding`
  first lets `recomputeLeftList`'s ordinary id-preserving reindex run (falls
  back to index 0 if nothing else applies), then — only when the previously
  selected id is genuinely gone — looks for another block whose `file` is one
  of THIS landing's own touched files and selects the first such match in
  list order (reviewer's own call: "ga dan naar een gerelateerd bestand wat je
  net hebt aangepast, als dat mogelijk is"). No such candidate → the generic
  index-0 fallback stands, untouched.

Tests: `TestBuildCheckoutViewReportsRefreshingFiles`
(`chat_checkout_test.go`), the `RefreshingFiles` assertion in
`TestProcessChatMergeClearsPendingEditedFilesOnSuccess` (`chat_merge_test.go`),
`tests/refreshing-pill.spec.mjs` (the pill on both the index row and the diff
card, and the full auto-refresh-and-follow-selection round trip).

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
