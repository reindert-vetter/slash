// WelcomeBlock.mjs — renders exactly one node ("block") of the /welcome tree.
//
// Replaces the earlier scene-based WelcomeScene.mjs: this page no longer
// shows one full-screen slide at a time — every block stays on screen and
// connects to the block before it, growing one continuous tree (see
// welcome.mjs). One component, several "kinds", same reasoning as before for
// keeping them in one file (all share the same card chrome, none is complex
// enough to earn its own file).
//
// Every node also gets a short caption+benefit line ABOVE its card (see
// `caption()` below) and cards are DELIBERATELY not all the same height/width
// any more — each kind's own width/min-height roughly mirrors its real
// counterpart's proportions in the review tree (the PR-info column and the
// merged comment/Claude card are the tallest, the diff header/drill chip the
// shortest), and two kinds (`index`, `comment-chat`) carry a visually
// separated second piece stacked BELOW their main content — the "Comments op
// regels" sub-list under the real pr-index, and the full-size code-preview
// card under the real comment-claude-row (.claude/docs/detail-layout.md).
import { html } from './vendor/arrow.js'

// No width/min-height here on purpose — every call site below sets its own,
// so two Tailwind width classes never fight for the same node (same
// specificity, source order would decide, which is fragile).
const CARD = 'welcome-glow shrink-0 rounded-xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/40'

// arrow.js can't parse a MIXED literal+dynamic attribute value (a static
// prefix next to a ${...}), even for a plain non-reactive string — see
// "Template syntax rules" in .claude/rules/arrowjs-pitfalls.md. Every class
// string below is therefore one JS expression built BEFORE it reaches the
// template.
function cardCls(extra) {
  return (extra ? extra + ' ' : '') + CARD
}

// Splits a string into per-character spans with a staggered animation-delay
// (welcome-letter-in, welcome.html). Only used for the opening "hook" block,
// which always mounts fresh (the tree only ever grows, a block is never
// re-mounted in place), so the cascade reliably plays once, on arrival.
function letterSpans(text) {
  return [...text].map((ch, i) =>
    html`<span class="welcome-letter inline-block" style="${'animation-delay:' + i * 22 + 'ms'}">${ch === ' ' ? ' ' : ch}</span>`.key(
      'ch-' + i,
    ),
  )
}

// The short heading + one-sentence benefit shown above every block as it's
// placed — the reviewer's own opening pitch ("je bent straks niet meer een
// linter...") distributed one stage at a time instead of a single paragraph
// above the whole canvas. Plain, non-reactive text (each node mounts once and
// is never rebound in place), so no arrow.js function-binding is needed.
function caption(node) {
  return html`
    <div class="max-w-[19rem] text-center">
      <p class="text-[10px] font-semibold uppercase tracking-wide text-indigo-300">${node.caption}</p>
      <p class="mt-1 text-[11px] leading-snug text-zinc-400">${node.benefit}</p>
    </div>
  `
}

function hookBlock() {
  return html`
    <div class="${cardCls('flex min-h-40 w-72 flex-col items-center justify-center gap-2 text-center')}">
      <p class="welcome-gradient-text text-2xl font-bold">${letterSpans('You own what ships.')}</p>
      <p class="text-sm text-zinc-400">Fast — but strict. Right-click to see how.</p>
    </div>
  `
}

// Mirrors prInfoCard's own layering: title+Jira badge, meta line, a "Doel"
// box, a short description, then review/CI pills as a separate FOOTER row —
// see "Two layers, and that split is load-bearing" in
// .claude/docs/detail-layout.md. Tallest card in the tree, same as the real
// PR-info column being the leftmost, most-layered stop.
function prBlock() {
  return html`
    <div class="${cardCls('flex min-h-64 w-80 flex-col')}">
      <div class="flex items-center justify-between text-[10px] text-zinc-400">
        <span>plug-and-pay/plug-and-pay</span>
        <span class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-300">STAT-1103</span>
      </div>
      <p class="mt-2 text-sm font-semibold text-white">Session flow with in-memory state</p>
      <div class="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
        <span>reindert-vetter</span>
        <span class="text-emerald-400">+2753</span>
        <span class="text-rose-400">−1</span>
        <span>22 files</span>
      </div>
      <div class="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-2">
        <p class="text-[9px] font-semibold uppercase tracking-wide text-emerald-300">Doel</p>
        <p class="mt-1 text-[11px] leading-relaxed text-zinc-300">
          One workflow per visitor session — no more per-pageview lookups.
        </p>
      </div>
      <p class="mt-2 flex-1 text-xs leading-relaxed text-zinc-400">
        The implementation writes nothing new yet and starts behind the Unleash feature flag
        <span class="text-zinc-300">temporal-session-flow</span>.
      </p>
      <div class="-mx-4 -mb-4 mt-3 flex gap-2 border-t border-white/10 px-4 py-2 text-[10px]">
        <span class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-300">2/2 approved</span>
        <span class="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-300">CI green</span>
      </div>
    </div>
  `
}

// Mirrors BlockList.mjs's own rows (category badge + name + approval count)
// plus, stacked BELOW as its own visually separated piece, the "Comments op
// regels" section that sits under the real pr-index.
function indexBlock() {
  const rows = [
    { kind: 'WORKFLOW', name: 'SessionFlow::run', count: '17/258', cls: 'bg-indigo-500/20 text-indigo-300' },
    { kind: 'WORKFLOW', name: 'SessionFlow::occurred', count: '9/61', cls: 'bg-indigo-500/20 text-indigo-300' },
    { kind: 'TEST', name: 'SessionFlowTest', count: '12/243', cls: 'bg-amber-500/20 text-amber-300' },
  ]
  const comments = [{ text: 'Kun je `viewed` overal hernoemen naar...' }, { text: 'is dit allemaal nodig? kan je niet...' }]
  return html`
    <div class="${cardCls('flex min-h-72 w-72 flex-col')}">
      <p class="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">Start</p>
      <div class="flex flex-col gap-1">
        ${rows.map((r, i) =>
          html`
            <div class="${'flex items-center gap-1.5 rounded px-1.5 py-1 ' + (i === 0 ? 'bg-white/10' : '')}">
              <span class="${'rounded px-1 py-0.5 text-[9px] font-semibold ' + r.cls}">${r.kind}</span>
              <span class="flex-1 truncate text-xs text-zinc-200">${r.name}</span>
              <span class="text-[9px] text-zinc-500">${r.count}</span>
            </div>
          `.key('row-' + i),
        )}
      </div>
      <div class="mt-3 border-t border-white/10 pt-2">
        <p class="mb-1 text-[9px] uppercase tracking-wide text-zinc-500">Comments op regels</p>
        <div class="flex flex-col gap-1">
          ${comments.map((c, i) =>
            html`<div class="truncate rounded px-1.5 py-1 text-[11px] text-zinc-400">${c.text}</div>`.key('cm-' + i),
          )}
        </div>
      </div>
    </div>
  `
}

// Mirrors a real diff card's own header (badge + Class::method + file:line +
// a "modified" pill) above the +/- rows, plus an approve checkbox — see the
// Block-diff card in .claude/docs/keyboard-navigation.md.
function diffBlock() {
  const rows = [
    { t: 'del', code: "'timeout' => 7200," },
    { t: 'add', code: "'timeout_seconds' => (int) config(...) * 60," },
  ]
  return html`
    <div class="${cardCls('relative min-h-48 w-72 overflow-hidden')}">
      <div class="flex items-center gap-1.5 text-[10px]">
        <span class="rounded bg-indigo-500/20 px-1 py-0.5 font-semibold text-indigo-300">PROVIDER</span>
        <span class="flex-1 truncate text-zinc-300">EventServiceProvider::register</span>
        <span class="rounded bg-amber-500/20 px-1 py-0.5 text-amber-300">modified</span>
      </div>
      <p class="mt-1 truncate text-[10px] text-zinc-500">config.php:44</p>
      <div class="relative mt-2 flex flex-col gap-0.5 font-mono text-[11px]">
        <div class="welcome-scan-line pointer-events-none absolute inset-x-0 top-0 h-5 bg-indigo-400/10"></div>
        ${rows.map((r, i) =>
          html`
            <div class="${'rounded px-1.5 py-0.5 ' + (r.t === 'del' ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300')}">
              ${(r.t === 'del' ? '- ' : '+ ') + r.code}
            </div>
          `.key('diff-' + i),
        )}
      </div>
      <div class="mt-2 flex items-center gap-1.5 text-[10px] text-zinc-500">
        <span class="flex h-3.5 w-3.5 items-center justify-center rounded border border-emerald-400/50 text-[9px] text-emerald-400">✓</span>
        <span>approve this change</span>
      </div>
    </div>
  `
}

// Mirrors a RelatedPanel child card: a kind badge (relation) or a diff-stat
// pill (a resolved method call) — .claude/docs/underlying-code.md.
function drillBlock() {
  return html`
    <div class="${cardCls('min-h-40 w-64')}">
      <div class="flex items-center gap-1.5 text-[10px]">
        <span class="rounded bg-zinc-500/20 px-1 py-0.5 font-semibold text-zinc-300">listener</span>
        <span class="flex-1 truncate text-zinc-500">signalWithStart()</span>
      </div>
      <p class="my-1 text-indigo-400">↳</p>
      <p class="truncate text-sm font-semibold text-white">SessionFlow::run</p>
      <span class="mt-2 inline-block rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] text-emerald-300">+8 −0</span>
      <p class="mt-2 text-xs text-zinc-400">opened right beside the call, not a separate page</p>
    </div>
  `
}

// Mirrors the real comment-claude-row: two columns side by side in ONE card,
// split by a dashed vertical divider (not a `→`) — see "One merged card, not
// two" in .claude/docs/detail-layout.md — with a full-size code-preview card
// stacked BELOW it, mirroring CodePreviewPanel
// (.claude/docs/claude-chat-panel.md).
function commentChatBlock() {
  return html`
    <div class="${cardCls('flex min-h-72 w-[34rem] flex-col')}">
      <div class="flex items-stretch gap-3">
        <div class="flex w-1/2 flex-col gap-2">
          <p class="text-[10px] uppercase tracking-wide text-zinc-500">Comment</p>
          <div class="flex items-start gap-2">
            <span class="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-indigo-500/40 text-center text-[10px] leading-5 text-indigo-200">RE</span>
            <p class="text-xs leading-relaxed text-zinc-300">"Change this to max 2 lines"</p>
          </div>
        </div>
        <div class="welcome-connector-in w-px shrink-0 self-stretch border-l border-dashed border-white/15"></div>
        <div class="flex w-1/2 flex-col gap-2">
          <p class="text-[10px] uppercase tracking-wide text-zinc-500">Claude, je reviewbuddy</p>
          <p class="text-xs text-zinc-300">"Two keys, one real caller — here's where."</p>
        </div>
      </div>
      <div class="mt-3 border-t border-white/10 pt-3">
        <p class="mb-1 text-[9px] uppercase tracking-wide text-zinc-500">Codeblok 1 · PHP</p>
        <div class="rounded border border-white/10 bg-black/30 px-1.5 py-1 font-mono text-[10px] text-emerald-300">
          $input['tenant_id'] = $tenantId;
        </div>
      </div>
    </div>
  `
}

function codeEditBlock() {
  return html`
    <div class="${cardCls('flex min-h-32 w-56 flex-col items-center justify-center gap-1 text-center')}">
      <p class="text-2xl">✅</p>
      <p class="text-sm font-semibold text-white">Applied</p>
      <p class="text-xs text-zinc-400">landed straight in the directory you picked</p>
    </div>
  `
}

const RENDERERS = {
  hook: hookBlock,
  pr: prBlock,
  index: indexBlock,
  diff: diffBlock,
  drill: drillBlock,
  'comment-chat': commentChatBlock,
  'code-edit': codeEditBlock,
}

/**
 * @param {object} node - one entry of WELCOME_SEQUENCE (see welcome.mjs).
 * @param {(e: MouseEvent, node: object) => void} onContextMenu - right-click
 *   ON this already-placed block opens a small decorative action menu
 *   instead of building the next block (see welcome.mjs's nodeMenu()).
 * @returns arrow.js template for that single block, its caption+benefit
 *   stacked above the card.
 */
export default function WelcomeBlock(node, onContextMenu) {
  const render = RENDERERS[node.kind] || (() => html`<div></div>`)
  return html`
    <div
      class="welcome-node-in flex shrink-0 flex-col items-center gap-2"
      data-testid="welcome-node"
      data-kind="${node.kind}"
      @contextmenu="${(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(e, node)
      }}"
    >
      ${caption(node)}
      ${render()}
    </div>
  `
}
