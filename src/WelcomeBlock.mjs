// WelcomeBlock.mjs — renders exactly one node ("block") of the /welcome tree.
//
// Replaces the earlier scene-based WelcomeScene.mjs: this page no longer
// shows one full-screen slide at a time — every block stays on screen and
// connects to the block before it, growing one continuous tree (see
// welcome.mjs). One component, several "kinds", same reasoning as before for
// keeping them in one file (all share the same card chrome, none is complex
// enough to earn its own file).
import { html } from './vendor/arrow.js'

const CARD = 'welcome-glow w-64 shrink-0 rounded-xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/40'

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

function hookBlock() {
  return html`
    <div class="${cardCls('flex min-h-40 w-72 flex-col items-center justify-center gap-2 text-center')}">
      <p class="welcome-gradient-text text-2xl font-bold">${letterSpans('You own what ships.')}</p>
      <p class="text-sm text-zinc-400">Fast — but strict. Right-click to see how.</p>
    </div>
  `
}

function prBlock() {
  return html`
    <div class="${cardCls('min-h-40')}">
      <div class="flex items-center justify-between text-[10px] text-zinc-400">
        <span>plug-and-pay/plug-and-pay</span>
        <span class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-300">STAT-1103</span>
      </div>
      <p class="mt-2 text-sm font-semibold text-white">Session flow with in-memory state</p>
      <p class="mt-2 text-xs leading-relaxed text-zinc-400">
        One workflow per visitor session — no more per-pageview lookups.
      </p>
      <div class="mt-3 flex gap-3 text-[10px] text-zinc-500">
        <span>+2753 −1</span>
        <span>22 files</span>
      </div>
    </div>
  `
}

function indexBlock() {
  const rows = [
    { kind: 'WORKFLOW', name: 'SessionFlow::run', cls: 'bg-indigo-500/20 text-indigo-300' },
    { kind: 'WORKFLOW', name: 'SessionFlow::occurred', cls: 'bg-indigo-500/20 text-indigo-300' },
    { kind: 'TEST', name: 'SessionFlowTest', cls: 'bg-amber-500/20 text-amber-300' },
  ]
  return html`
    <div class="${cardCls('min-h-40')}">
      <p class="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">Index</p>
      <div class="flex flex-col gap-1">
        ${rows.map((r, i) =>
          html`
            <div class="${'flex items-center gap-1.5 rounded px-1.5 py-1 ' + (i === 0 ? 'bg-white/10' : '')}">
              <span class="${'rounded px-1 py-0.5 text-[9px] font-semibold ' + r.cls}">${r.kind}</span>
              <span class="truncate text-xs text-zinc-200">${r.name}</span>
            </div>
          `.key('row-' + i),
        )}
      </div>
    </div>
  `
}

function diffBlock() {
  const rows = [
    { t: 'del', code: "'timeout' => 7200," },
    { t: 'add', code: "'timeout_seconds' => (int) config(...) * 60," },
  ]
  return html`
    <div class="${cardCls('relative min-h-40 overflow-hidden')}">
      <p class="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">config.php</p>
      <div class="relative flex flex-col gap-0.5 font-mono text-[11px]">
        <div class="welcome-scan-line pointer-events-none absolute inset-x-0 top-0 h-5 bg-indigo-400/10"></div>
        ${rows.map((r, i) =>
          html`
            <div class="${'rounded px-1.5 py-0.5 ' + (r.t === 'del' ? 'bg-rose-500/15 text-rose-300' : 'bg-emerald-500/15 text-emerald-300')}">
              ${(r.t === 'del' ? '- ' : '+ ') + r.code}
            </div>
          `.key('diff-' + i),
        )}
      </div>
    </div>
  `
}

function drillBlock() {
  return html`
    <div class="${cardCls('min-h-40')}">
      <p class="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">Underlying code</p>
      <p class="truncate text-[11px] text-zinc-500">signalWithStart()</p>
      <p class="my-1 text-indigo-400">↳</p>
      <p class="truncate text-sm font-semibold text-white">SessionFlow::run</p>
      <p class="mt-2 text-xs text-zinc-400">opened right beside the call, not a separate page</p>
    </div>
  `
}

function commentBlock() {
  return html`
    <div class="${cardCls('min-h-40')}">
      <p class="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">Comment</p>
      <div class="flex items-start gap-2">
        <span class="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-indigo-500/40 text-center text-[10px] leading-5 text-indigo-200">RE</span>
        <p class="text-xs leading-relaxed text-zinc-300">"Change this to max 2 lines"</p>
      </div>
    </div>
  `
}

function chatBlock() {
  return html`
    <div class="${cardCls('min-h-40')}">
      <p class="mb-2 text-[10px] uppercase tracking-wide text-zinc-500">Claude, je reviewbuddy</p>
      <p class="text-xs text-zinc-300">"Two keys, one real caller — here's where."</p>
      <div class="mt-2 rounded border border-white/10 bg-black/30 px-1.5 py-1 font-mono text-[10px] text-emerald-300">
        $input['tenant_id'] = $tenantId;
      </div>
    </div>
  `
}

function codeEditBlock() {
  return html`
    <div class="${cardCls('flex min-h-40 flex-col items-center justify-center gap-1 text-center')}">
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
  comment: commentBlock,
  chat: chatBlock,
  'code-edit': codeEditBlock,
}

/**
 * @param {object} node - one entry of WELCOME_SEQUENCE (see welcome.mjs).
 * @param {(e: MouseEvent, node: object) => void} onContextMenu - right-click
 *   ON this already-placed block opens a small decorative action menu
 *   instead of building the next block (see welcome.mjs's nodeMenu()).
 * @returns arrow.js template for that single block.
 */
export default function WelcomeBlock(node, onContextMenu) {
  const render = RENDERERS[node.kind] || (() => html`<div></div>`)
  return html`
    <div
      class="welcome-node-in shrink-0"
      data-testid="welcome-node"
      data-kind="${node.kind}"
      @contextmenu="${(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(e, node)
      }}"
    >
      ${render()}
    </div>
  `
}
