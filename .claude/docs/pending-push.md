# Landed but not pushed: the pending ref and its todo

What happens between "Claude, pas dit aan" and that change being on GitHub.

A reviewer-requested Claude edit is committed in the conversation's shadow
worktree and then **lands on the PR's branch locally**, not on GitHub. The push
is a separate, deliberate step the reviewer fires from a **todo row at the very
bottom of the block index**. In between, the change is fully part of the review
tree: it is ingested, diffed, approvable, commentable — the reviewer reviews his
own change before anyone else sees it, and nothing stays behind in a worktree.

**The landing itself is automatic, not a second reviewer step.** The reviewer
only ever asks Claude to commit in plain words; Claude's own `git commit` (run
via Bash in its shadow worktree, see "Two-step tool access"/chat_shell.md in
`.claude/docs/workflows-comments.md`) never itself moves anything onto the PR
branch or touches the worktree afterwards — the `runClaudeTurn` Activity
notices the shadow has something pending after EVERY turn
(`chatShadowNeedsLanding`) and lands/merges/reclaims it the same way an
explicit "commit deze wijziging" always did (see "Automatic landing after a
shell turn" in that same doc). Push, unlike landing, stays a deliberate,
reviewer-only step — never automatic, never `--force`.

Mechanics of the chat turn itself (shadow worktree, the `chat_merge` queue,
conflict resolution) live in `.claude/docs/workflows-comments.md`; this file is
about the landing target, the visibility, and the push.

## The landing target: `refs/slash/pending/pr-<n>/<headRef>`

`prPendingRef` (`chat_shadow.go`). One ref per PR, holding every landed chat
commit for it.

- **Deliberately NOT `refs/heads/<headRef>`.** The clone `runGit` works in is
  the developer's OWN checkout, where a branch of that name may already exist
  and even be checked out. A ref outside `refs/heads` never appears in
  `git branch`, cannot collide with a checkout, and pushes just as well
  (`<pendingRef>:refs/heads/<headRef>`).
- **The branch name is part of the ref PATH** so every reader recovers it from
  git alone (`git for-each-ref refs/slash/pending/pr-<n>/`). That is what keeps
  the read model below purely local — no `gh` call on a plain `GET`.
- **`landAndReclaimChatShadow`** is the only thing that ever moves it, and it
  only moves it FORWARD: `git push`'s own non-fast-forward refusal is gone
  together with the push, so containment is checked explicitly
  (`merge-base --is-ancestor <current> <new>`) before `update-ref`. On success
  the shadow worktree + its `chat/<id>` branch are removed, so nothing is left
  behind on disk.
- **`chatShadowBaseTip`** makes a conversation's shadow start from the pending
  ref when one exists (else `origin/<headRef>`), so a second conversation
  **stacks** on the first one's unpushed work instead of trying to rewind it.
- **`chatShadowMissingTips`** lists, in a fixed order, which of
  `origin/<headRef>` and the pending ref the shadow's own commit does not
  contain yet. Empty → a plain fast-forward landing. Non-empty → the
  `chat_merge` merge path merges each of them (auto-merge; a conflict it cannot
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

## The push: a `"push"` Action on the PR's `chat_merge` queue

`pushPendingPR` (`pending_push.go`), reached via
`ChatMergeRequest{Action: "push"}`. It runs on the same per-PR queue that
serializes landings, so a push can never overlap one.

- An **Action on the existing `"merge"` Signal**, not a second Signal name:
  tembed's `WaitSignal` takes exactly one name and a workflow body may not
  select over two (`.claude/rules/workflow-determinism.md`). Same shape as
  `ChatMessageSignal.Action`/`ReactionSignal.Action`; branching on recorded
  Signal payload stays replay-deterministic.
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
  `pushTodoConfirmCommands`, the two-step shape "Wis Claude-gesprek" uses), so
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
bare-repo-as-origin, the queue's Action dispatch), `chat_shadow_test.go`
(landing on the ref without pushing, a second conversation stacking, a refused
landing), `ingest_delta_test.go` (`ingestRefreshNeeded` with a local commit),
`tests/pending-push-todo.spec.mjs` (the row, the confirm flow, the keyboard
stop, the block marking, the overview badge).
