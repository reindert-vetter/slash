// WelcomeScene.mjs — renders exactly one scene of the /welcome showcase.
//
// One component, several "kinds" of scene (question / text / a handful of
// hand-built mocks of the review tree's own look / a real screenshot / the
// closer). Kept in one file because every kind shares the same fade-in
// wrapper and none of them is complex enough to earn its own file — see
// "A component/page module too small to earn its own file" style call in
// other .mjs files across this repo.
import { html } from './vendor/arrow.js'

const MOCK_CARD = 'rounded-xl border border-white/10 bg-white/[0.04] p-4 shadow-2xl shadow-black/40'

// arrow.js can't parse a MIXED literal+dynamic attribute value (a static
// prefix next to a ${...}) even for a plain, non-reactive string — see
// "Template syntax rules" in .claude/rules/arrowjs-pitfalls.md. Every class
// string below is therefore built as one JS expression BEFORE it reaches the
// template, never split across a literal part and a ${...} part.
function mockCardCls(extra) {
  return (extra ? extra + ' ' : '') + MOCK_CARD + ' welcome-glow'
}

// Splits a string into per-character spans, each with its own staggered
// animation-delay (welcome-letter-in, welcome.html) — a fresh `.key()`ed list
// every time (this component always mounts under a freshly `.key()`ed scene
// node, see welcome.mjs), so the cascade genuinely replays on every visit to
// this scene rather than only once.
function letterSpans(text) {
  return [...text].map((ch, i) =>
    html`<span class="welcome-letter inline-block" style="${'animation-delay:' + i * 26 + 'ms'}">${ch === ' ' ? ' ' : ch}</span>`.key(
      'ch-' + i,
    ),
  )
}

function questionScene(scene) {
  return html`
    <div class="welcome-scene-enter flex flex-col items-center gap-3 text-center">
      <p class="max-w-3xl text-3xl font-semibold tracking-tight text-white sm:text-5xl">
        ${letterSpans(scene.text)}<span class="welcome-caret text-indigo-400">|</span>
      </p>
    </div>
  `
}

function textScene(scene) {
  return html`
    <div class="welcome-scene-enter flex max-w-3xl flex-col items-center gap-4 text-center">
      ${scene.lines.map(
        (line, i) =>
          html`<p
            class="${i === 0
              ? 'welcome-gradient-text text-3xl font-bold sm:text-4xl'
              : 'text-lg text-zinc-300 sm:text-xl'}"
          >
            ${line}
          </p>`.key('line-' + i),
      )}
    </div>
  `
}

function mockPrScene() {
  return html`
    <div class="${mockCardCls('welcome-scene-enter w-full max-w-xl')}">
      <div class="flex items-center justify-between text-xs text-zinc-400">
        <span>plug-and-pay/plug-and-pay</span>
        <span class="rounded bg-emerald-500/20 px-2 py-0.5 text-emerald-300">STAT-1103</span>
      </div>
      <p class="mt-2 text-base font-semibold text-white">Session flow with in-memory session state and enrichment</p>
      <p class="mt-2 text-sm leading-relaxed text-zinc-400">
        Adds a Temporal workflow per visitor session that keeps session state in workflow memory, so UTM data, sales
        page and device info no longer have to be looked up again per pageview.
      </p>
      <div class="mt-3 flex gap-4 text-xs text-zinc-500">
        <span>+2753 −1</span>
        <span>22 files</span>
      </div>
    </div>
  `
}

function mockIndexScene() {
  const rows = [
    { kind: 'MIGRATION', name: 'up', cls: 'bg-sky-500/20 text-sky-300' },
    { kind: 'WORKFLOW', name: 'SessionFlow::run', cls: 'bg-indigo-500/20 text-indigo-300' },
    { kind: 'WORKFLOW', name: 'SessionFlow::occurred', cls: 'bg-indigo-500/20 text-indigo-300' },
    { kind: 'TEST', name: 'SessionFlowTest', cls: 'bg-amber-500/20 text-amber-300' },
    { kind: 'TEST', name: 'SessionEnricherTest', cls: 'bg-amber-500/20 text-amber-300' },
  ]
  return html`
    <div class="${mockCardCls('welcome-scene-enter w-full max-w-xl')}">
      <p class="mb-3 text-xs uppercase tracking-wide text-zinc-500">Index</p>
      <div class="flex flex-col gap-1.5">
        ${rows.map((r, i) =>
          html`
            <div class="${'flex items-center gap-2 rounded px-2 py-1 ' + (i === 1 ? 'bg-white/10' : '')}">
              <span class="${'rounded px-1.5 py-0.5 text-[10px] font-semibold ' + r.cls}">${r.kind}</span>
              <span class="truncate text-sm text-zinc-200">${r.name}</span>
            </div>
          `.key('row-' + i),
        )}
      </div>
    </div>
  `
}

function mockDiffScene() {
  const rows = [
    { t: 'del', code: "'session_timeout' => 7200," },
    { t: 'add', code: "'session_timeout_seconds' => (int) config('statistics.session_flow.session_timeout_minutes') * 60," },
    { t: 'add', code: "'conversion_window_seconds' => (int) config('statistics.session_flow.conversion_window_minutes') * 60," },
    { t: 'ctx', code: '];' },
  ]
  return html`
    <div class="${mockCardCls('welcome-scene-enter relative w-full max-w-xl overflow-hidden')}">
      <p class="mb-3 text-xs uppercase tracking-wide text-zinc-500">config.php</p>
      <div class="relative flex flex-col gap-0.5 font-mono text-[13px]">
        <div class="welcome-scan-line pointer-events-none absolute inset-x-0 top-0 h-6 bg-indigo-400/10"></div>
        ${rows.map((r, i) =>
          html`
            <div
              class="${'rounded px-2 py-0.5 ' +
              (r.t === 'del' ? 'bg-rose-500/15 text-rose-300' : r.t === 'add' ? 'bg-emerald-500/15 text-emerald-300' : 'text-zinc-400')}"
            >
              ${(r.t === 'del' ? '- ' : r.t === 'add' ? '+ ' : '  ') + r.code}
            </div>
          `.key('diff-' + i),
        )}
      </div>
    </div>
  `
}

function mockDrillScene() {
  return html`
    <div class="welcome-scene-enter flex w-full max-w-3xl items-center gap-3">
      <div class="w-56 shrink-0 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs text-zinc-500">
        <p class="mb-1 truncate text-zinc-300">SessionFlowService::signalWithStart()</p>
        <p class="truncate">calls SessionFlow::run</p>
      </div>
      <div class="text-indigo-400">→</div>
      <div class="${mockCardCls('min-w-0 flex-1')}">
        <p class="mb-1 text-xs uppercase tracking-wide text-zinc-500">Underlying code</p>
        <p class="truncate text-sm font-semibold text-white">SessionFlow::run</p>
        <p class="mt-1 text-xs text-zinc-400">the workflow this call actually starts — open right beside it</p>
      </div>
    </div>
  `
}

function imageScene(scene) {
  return html`
    <div class="welcome-scene-enter flex w-full max-w-4xl flex-col items-center gap-3">
      <div class="welcome-wipe welcome-glow w-full overflow-hidden rounded-xl border border-white/10">
        <img src="${scene.src}" alt="${scene.caption}" class="w-full" />
      </div>
      <p class="max-w-2xl text-center text-base text-zinc-300">${scene.caption}</p>
    </div>
  `
}

function endScene(scene) {
  return html`
    <div class="welcome-scene-enter flex flex-col items-center gap-5 text-center">
      <p class="welcome-gradient-text text-4xl font-bold sm:text-5xl">${scene.text}</p>
      <a
        href="${scene.href}"
        class="welcome-glow rounded-lg bg-indigo-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-400"
        data-testid="welcome-back-link"
      >
        ${scene.linkLabel}
      </a>
    </div>
  `
}

/**
 * @param {object} scene - one entry of WELCOME_SCENES (see welcome.mjs).
 * @returns arrow.js template for that single scene.
 */
export default function WelcomeScene(scene) {
  switch (scene.kind) {
    case 'question':
      return questionScene(scene)
    case 'text':
      return textScene(scene)
    case 'mock-pr':
      return mockPrScene()
    case 'mock-index':
      return mockIndexScene()
    case 'mock-diff':
      return mockDiffScene()
    case 'mock-drill':
      return mockDrillScene()
    case 'image':
      return imageScene(scene)
    case 'end':
      return endScene(scene)
    default:
      return html`<div></div>`
  }
}
