// welcome.mjs — entry module for the standalone /welcome showcase page.
//
// Deliberately its OWN entry (never imported by home.mjs/overview.mjs/
// inbox.mjs, and importing nothing from them) so normal use of the review
// tree never loads this module or its component — see the /welcome note in
// api.go and "Pages & routing" in .claude/docs/pages-and-routing.md.
//
// Second revision (this file replaces the earlier slideshow): the reviewer
// asked for ONE continuously growing tree instead of full-screen scenes —
// blocks connect to the right of each other, built up one at a time by a
// right-click (or a key), and a final step zooms out to fit the whole built
// tree in view. Same interaction the real review tree already has: a
// right-click runs the exact same thing a key runs (see "The right-click
// context menu" in .claude/docs/command-palette.md) — reused here 1:1.
//
// Third revision: each node also carries its own `caption`/`benefit` — a
// short heading plus one sentence, shown ABOVE that block as it's placed —
// instead of one static paragraph above the whole canvas. This is where the
// reviewer's own opening pitch ("je bent straks niet meer een linter, maar
// jij de eindbaas...") is distributed across the build, one benefit per
// stage instead of a wall of text up front. The comment+chat pair (formerly
// two separate nodes) is also merged into ONE node here, because in the real
// review tree they sit side by side in a single card with a dashed divider
// (`comment-claude-row`, .claude/docs/detail-layout.md) — not two things
// connected by a `→`.
import { reactive, html } from './vendor/arrow.js'
import WelcomeBlock from './WelcomeBlock.mjs'

// The tree's own nodes, left to right — mirrors the real review tree's own
// left→right nav chain (description → index → diff → underlying code →
// comment+chat), see .claude/docs/keyboard-navigation.md. `menu` is the
// decorative, non-functional right-click-on-this-block action list (the
// "and you can do things" part of the request); `caption`/`benefit` render
// above the block as it's placed (WelcomeBlock.mjs).
export const WELCOME_SEQUENCE = [
  {
    kind: 'hook',
    caption: 'Why this tree exists',
    benefit: "You're not a linter anymore — you're the one who decides what ships. Right-click to see how.",
    menu: ['This is the whole idea'],
  },
  {
    kind: 'pr',
    caption: '1 — The PR, summarized',
    benefit: 'One screen instead of endless scrolling through a diff you already wrote yourself.',
    menu: ['Open PR on GitHub', 'Show all changed files'],
  },
  {
    kind: 'index',
    caption: '2 — Every touched function, indexed',
    benefit: 'See everything that got generated before you commit to reviewing any single piece of it.',
    menu: ['Jump to a block', 'Filter by category'],
  },
  {
    kind: 'diff',
    caption: '3 — The diff, one function at a time',
    benefit: 'Fast, but strict: approve line by line, not the whole file on faith.',
    menu: ['Approve this change', 'View full diff'],
  },
  {
    kind: 'drill',
    caption: '4 — Underlying code',
    benefit: 'See the connection between functions — what calls this, what this calls next.',
    menu: ['Open as its own column', 'Back to caller'],
  },
  {
    kind: 'comment-chat',
    caption: '5 — Comment on the line, Claude right beside it',
    benefit: 'Ask why, right where the code lives — no separate tab, no lost context.',
    menu: ['Reply', 'Resolve thread', 'Ask a follow-up', 'Apply this suggestion'],
  },
  {
    kind: 'code-edit',
    caption: '6 — The edit lands',
    benefit: 'Applied straight to your branch — still your call, every time.',
    menu: ['View the commit', 'Open in editor'],
  },
]

const state = reactive({
  count: 0, // how many WELCOME_SEQUENCE entries are currently placed
  zoomed: false, // the final "fit the whole tree in view" step
  menu: { open: false, x: 0, y: 0, title: '', items: [] },
})

// A quick camera-flash pulse on every step — plain, imperative DOM
// manipulation on a static, never reactively-bound node (see the template
// below), exactly like the progress-bar trick in the previous revision, so
// this can't collide with any arrow.js templating rule.
function flashScreen() {
  const el = document.getElementById('welcome-flash')
  if (!el) return
  el.style.transition = 'none'
  el.style.opacity = '0.16'
  requestAnimationFrame(() => {
    el.style.transition = 'opacity 500ms ease-out'
    el.style.opacity = '0'
  })
}

// Positions the track: while building, it slides left just enough to keep
// the newest block comfortably in view (never further than needed); once
// zoomed, it scales down and centers so the ENTIRE built tree fits inside
// the viewport at once. Two separate CSS properties (margin-left for
// position, transform:scale for size) so they never fight over the same
// `transform` value, and both are set by hand here rather than through an
// arrow.js binding — this is pure layout math against measured DOM sizes,
// nothing reactive to track.
function layoutTrack() {
  const viewport = document.getElementById('welcome-viewport')
  const track = document.getElementById('welcome-track')
  if (!viewport || !track) return
  const vw = viewport.clientWidth
  const naturalWidth = track.scrollWidth

  if (!state.zoomed) {
    track.style.transition = 'margin-left 500ms cubic-bezier(.16,1,.3,1), transform 500ms cubic-bezier(.16,1,.3,1)'
    track.style.transform = 'scale(1)'
    const overflow = naturalWidth - vw
    track.style.marginLeft = (overflow > 0 ? -(overflow + 32) : 0) + 'px'
  } else {
    const pad = 48
    const scale = Math.min(1, (vw - pad * 2) / Math.max(naturalWidth, 1))
    const centeredLeft = (vw - naturalWidth * scale) / 2
    track.style.transition = 'margin-left 900ms cubic-bezier(.16,1,.3,1), transform 900ms cubic-bezier(.16,1,.3,1)'
    track.style.transform = `scale(${scale})`
    track.style.marginLeft = centeredLeft + 'px'
  }
}

function scheduleLayout() {
  requestAnimationFrame(layoutTrack)
}

function closeMenu() {
  if (state.menu.open) state.menu.open = false
}

function openNodeMenu(e, node) {
  state.menu = { open: true, x: e.clientX, y: e.clientY, title: node.kind, items: node.menu }
}

function reset() {
  state.count = 0
  state.zoomed = false
  scheduleLayout()
}

function zoomOut() {
  state.zoomed = true
  scheduleLayout()
}

function zoomIn() {
  state.zoomed = false
  scheduleLayout()
}

// The one action a right-click on empty canvas, or a forward key, always
// runs: dismiss a decorative menu first if one is open (a right-click/key
// while it's open is read as "never mind"), otherwise place the next block,
// or — once every block is placed — zoom out to reveal the whole tree, or —
// once already zoomed out — start over so the build can be watched again.
function advance() {
  flashScreen()
  if (state.menu.open) {
    closeMenu()
    return
  }
  if (!state.zoomed) {
    if (state.count < WELCOME_SEQUENCE.length) {
      state.count++
      scheduleLayout()
      return
    }
    zoomOut()
    return
  }
  reset()
}

// The reverse: undo one step. Zoomed → un-zoom first (mirrors the forward
// chain treating the zoom as just the last "stop"), then remove blocks one
// at a time, same ←/↑ meaning as the review tree's own nav chain (a step
// back always peels back exactly one stop).
function back() {
  flashScreen()
  if (state.menu.open) {
    closeMenu()
    return
  }
  if (state.zoomed) {
    zoomIn()
    return
  }
  if (state.count > 0) {
    state.count--
    scheduleLayout()
  }
}

function onKeydown(e) {
  if (e.key === 'Escape' && state.menu.open) {
    e.preventDefault()
    closeMenu()
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    advance()
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault()
    back()
  }
}

function hintText() {
  if (state.menu.open) return 'Right-click again (or Enter) to dismiss'
  if (state.zoomed) return 'This is the whole tree. Right-click to build it again.'
  if (state.count === 0) return 'Right-click anywhere (or press Enter) to start building the tree'
  if (state.count < WELCOME_SEQUENCE.length) return 'Right-click again (or →/Enter) to connect the next block'
  return 'One more time to zoom out and see the whole tree'
}

function nodeMenu() {
  const m = state.menu
  return html`
    <div
      class="welcome-node-in fixed z-40 min-w-40 rounded-lg border border-white/10 bg-zinc-900/95 p-1 text-xs shadow-2xl shadow-black/60"
      style="${'left:' + m.x + 'px;top:' + m.y + 'px;'}"
      data-testid="welcome-node-menu"
    >
      ${m.items.map((label, i) => html`<div class="rounded px-2 py-1.5 text-zinc-200 hover:bg-white/10">${label}</div>`.key('mi-' + i))}
    </div>
  `
}

function connector(i) {
  return html`<div class="welcome-connector-in flex w-8 shrink-0 items-center justify-center text-lg text-indigo-400">→</div>`.key(
    'connector-' + i,
  )
}

function trackChildren() {
  const nodes = WELCOME_SEQUENCE.slice(0, state.count)
  const children = []
  nodes.forEach((node, i) => {
    if (i > 0) children.push(connector(i))
    children.push(WelcomeBlock(node, openNodeMenu).key('node-' + i))
  })
  return children
}

function mount() {
  const el = document.getElementById('app')
  const template = html`
    <div
      class="relative flex h-screen w-screen flex-col items-center justify-center gap-6 overflow-hidden bg-zinc-950 px-6"
      @contextmenu="${(e) => {
        e.preventDefault()
        advance()
      }}"
    >
      <div
        class="welcome-conic pointer-events-none absolute -inset-[20%] opacity-30"
        style="background:conic-gradient(from 0deg, rgba(129,140,248,0.25), rgba(244,114,182,0.2), rgba(52,211,153,0.2), rgba(129,140,248,0.25))"
      ></div>
      <div class="welcome-blob pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-indigo-600/30 blur-3xl"></div>
      <div class="welcome-blob pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-emerald-600/20 blur-3xl"></div>
      <div class="welcome-blob pointer-events-none absolute right-1/3 top-1/4 h-72 w-72 rounded-full bg-fuchsia-600/20 blur-3xl"></div>
      <div id="welcome-flash" class="pointer-events-none absolute inset-0 z-30 bg-white opacity-0"></div>

      <div class="relative z-10 flex w-full max-w-6xl flex-col items-center gap-5">
        <div id="welcome-viewport" class="relative flex h-[54vh] w-full items-center overflow-hidden" data-testid="welcome-viewport">
          <div id="welcome-track" class="flex items-center gap-3" style="transform-origin:0% 50%;" data-testid="welcome-track">
            ${() => trackChildren()}
          </div>
        </div>
        <p class="text-center text-sm text-zinc-400" data-testid="welcome-hint">${() => hintText()}</p>
      </div>

      <a
        href="/pr-overview"
        class="welcome-glow fixed bottom-6 right-6 z-20 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-opacity hover:bg-indigo-400"
        style="${() => 'opacity:' + (state.zoomed ? '1' : '0') + ';pointer-events:' + (state.zoomed ? 'auto' : 'none') + ';'}"
        data-testid="welcome-back-link"
      >
        ← Back to overview
      </a>

      <div class="contents">${() => (state.menu.open ? nodeMenu() : '')}</div>
    </div>
  `
  template(el)
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('click', (e) => {
    if (e.target.closest('a')) return // let the back-link navigate normally
    closeMenu()
  })
  scheduleLayout()
}

mount()
