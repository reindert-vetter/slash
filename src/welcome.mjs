// welcome.mjs — entry module for the standalone /welcome showcase page.
//
// Deliberately its OWN entry (never imported by home.mjs/overview.mjs/
// inbox.mjs, and importing nothing from them) so normal use of the review
// tree never loads this module or its component — see the /welcome note in
// api.go and "Pages & routing" in .claude/docs/pages-and-routing.md.
import { reactive, html } from './vendor/arrow.js'
import WelcomeScene from './WelcomeScene.mjs'

// The scene script — a short, linear story, one "stop" at a time. Kept as
// plain data (like COMMANDS in home.mjs) so WelcomeScene.mjs stays a pure
// renderer per scene.kind.
export const WELCOME_SCENES = [
  { kind: 'question', text: 'What does your future look like?', duration: 3200 },
  {
    kind: 'text',
    lines: ["Soon, you're not just a linter anymore.", "You're the one accountable for what ships."],
    duration: 3600,
  },
  {
    kind: 'text',
    lines: ["If you're the one accountable, you need an overview.", 'Fast — but strict.'],
    duration: 3600,
  },
  {
    kind: 'text',
    lines: ['Endless scrolling through a GitHub PR, no idea what happened —', 'while you wrote it?'],
    duration: 3800,
  },
  { kind: 'text', lines: ['Get an overview.', 'See how functions actually relate.'], duration: 3200 },
  { kind: 'mock-pr', duration: 3400 },
  { kind: 'mock-index', duration: 3200 },
  { kind: 'mock-diff', duration: 3600 },
  { kind: 'mock-drill', duration: 3400 },
  {
    kind: 'image',
    src: '/assets/welcome/comment-view.png',
    caption: 'Drop a comment right where it matters, with the whole review tree still in view.',
    duration: 5200,
  },
  {
    kind: 'image',
    src: '/assets/welcome/chat-codeblock.png',
    caption: "Chat about it — code blocks and all. Ask for a change and it lands straight in the directory you pick.",
    duration: 5200,
  },
  { kind: 'end', text: 'Ready to see it for real?', href: '/pr-overview', linkLabel: '← Back to overview', duration: null },
]

const state = reactive({ index: 0 })

let timer = null

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

// A quick camera-flash pulse + the top bar filling up over the scene's own
// duration — both plain, imperative DOM manipulation on two static nodes
// (never bound reactively, see the template below), so this can't collide
// with any arrow.js templating rule; it's just CSS transitions kicked off by
// hand on every scene change.
function flashScreen() {
  const el = document.getElementById('welcome-flash')
  if (!el) return
  el.style.transition = 'none'
  el.style.opacity = '0.18'
  requestAnimationFrame(() => {
    el.style.transition = 'opacity 500ms ease-out'
    el.style.opacity = '0'
  })
}

function animateProgressBar(duration) {
  const bar = document.getElementById('welcome-progress-bar')
  if (!bar) return
  bar.style.transition = 'none'
  bar.style.width = '0%'
  void bar.offsetWidth // force reflow, otherwise the next transition never animates from 0%
  if (duration == null) {
    bar.style.width = '100%'
    return
  }
  requestAnimationFrame(() => {
    bar.style.transition = `width ${duration}ms linear`
    bar.style.width = '100%'
  })
}

function scheduleAutoAdvance() {
  clearTimer()
  const scene = WELCOME_SCENES[state.index]
  if (!scene) return
  flashScreen()
  animateProgressBar(scene.duration)
  if (scene.duration == null) return
  timer = setTimeout(advance, scene.duration)
}

function advance() {
  if (state.index >= WELCOME_SCENES.length - 1) {
    // On the closing scene, forward/confirm keys act like the visible link.
    location.href = WELCOME_SCENES[state.index].href
    return
  }
  state.index++
  scheduleAutoAdvance()
}

function back() {
  if (state.index === 0) return
  state.index--
  scheduleAutoAdvance()
}

// Same keys, same meaning as the review tree's own left→right nav chain (see
// .claude/docs/keyboard-navigation.md): →/↓ and Space move forward through the
// stops (Space mirrors "confirm this, move to the next one"), ←/↑ step back
// one stop, Enter acts on the current stop (here: also forward, and on the
// closing scene it's the same as following the link).
function onKeydown(e) {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'Enter') {
    e.preventDefault()
    advance()
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault()
    back()
  }
}

function mount() {
  const el = document.getElementById('app')
  const template = html`
    <div class="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-zinc-950 px-6">
      <div
        class="welcome-conic pointer-events-none absolute -inset-[20%] opacity-30"
        style="background:conic-gradient(from 0deg, rgba(129,140,248,0.25), rgba(244,114,182,0.2), rgba(52,211,153,0.2), rgba(129,140,248,0.25))"
      ></div>
      <div class="welcome-blob pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-indigo-600/30 blur-3xl"></div>
      <div class="welcome-blob pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-emerald-600/20 blur-3xl"></div>
      <div class="welcome-blob pointer-events-none absolute right-1/3 top-1/4 h-72 w-72 rounded-full bg-fuchsia-600/20 blur-3xl"></div>
      <div class="pointer-events-none absolute inset-x-0 top-0 z-20 h-1 bg-white/5">
        <div
          id="welcome-progress-bar"
          class="h-full bg-gradient-to-r from-indigo-400 via-fuchsia-400 to-emerald-400"
        ></div>
      </div>
      <div id="welcome-flash" class="pointer-events-none absolute inset-0 z-30 bg-white opacity-0"></div>
      <div class="relative z-10 flex w-full items-center justify-center" data-testid="welcome-scene">
        ${() => WelcomeScene(WELCOME_SCENES[state.index]).key('scene-' + state.index)}
      </div>
      <div class="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 gap-1.5" data-testid="welcome-progress">
        ${() =>
          WELCOME_SCENES.map((_, i) =>
            html`<span
              class="${'h-1.5 w-6 rounded-full transition-all duration-300 ' +
              (i === state.index
                ? 'scale-110 bg-indigo-400 shadow-[0_0_10px_2px_rgba(129,140,248,0.8)]'
                : 'bg-white/15')}"
            ></span>`.key('dot-' + i),
          )}
      </div>
    </div>
  `
  template(el)
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('click', (e) => {
    if (e.target.closest('a')) return // let the closing link navigate normally
    advance()
  })
  scheduleAutoAdvance()
}

mount()
