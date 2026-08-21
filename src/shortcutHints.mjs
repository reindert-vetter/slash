import { html } from './vendor/arrow.js'

// MAX_HINTS — the highest number of hints any caller currently builds (see
// home.mjs's blockShortcutHints/RelatedPanel.mjs's commentClaudeShortcutHints).
// A fixed number of SLOTS, each independently reactive and hidden when unused,
// deliberately replaces a keyed `.map()` over a dynamically-sized array: a
// bare reactive slot that keeps returning a TEMPLATE (never toggling through
// `''`) — exactly what switching between two non-empty hint sets does — does
// not reliably re-diff a nested keyed list inside it (observed live:
// switching list mode -> diff mode left every hint reading the OLD set's
// text forever, even with each item's own key made unique across sets). A
// fixed set of plain `${() => ...}` text/attribute bindings is the one shape
// arrow.js is unambiguously reliable about, so this sidesteps the whole
// class of bug instead of chasing it further. Bump this if a future caller
// ever needs more hints than the current longest list.
const MAX_HINTS = 8

// ShortcutHintBar — a thin, muted line under a card showing exactly which
// keys currently do something IN THAT CARD's context. Reviewer request:
// "onder elke kaart wil ik een lijn met hints wat je op dat moment voor
// keys kan typen, shortcuts live wat op dat moment relevant is". See "A
// contextual keyboard-hint line under each card" in
// .claude/docs/keyboard-navigation.md.
//
// `hintsFn` is a FUNCTION (not a plain array), mirroring Block.mjs's own
// activeGroup/hintsEnabled convention, so this stays reactive to whatever
// navigation state the caller's hints depend on — home.mjs/RelatedPanel.mjs
// each compute their own hint list from state they already own, this
// component only renders it.
export function ShortcutHintBar(hintsFn) {
  const hints = () => (hintsFn ? hintsFn() : []) || []
  const hasAny = () => hints().length > 0
  const slots = Array.from({ length: MAX_HINTS }, (_, i) => i)
  return html`
    <div
      class="${() =>
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 dark:border-zinc-800/60 px-3 py-1.5 text-[11px] text-slate-400 dark:text-zinc-500 ' +
        (hasAny() ? '' : 'hidden')}"
      data-testid="shortcut-hints"
    >
      ${slots.map((i) =>
        html`<span
          class="${() => 'flex items-center gap-1 ' + (hints()[i] ? '' : 'hidden')}"
          data-testid="shortcut-hint"
        >
          <kbd
            class="rounded border border-slate-300 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/60 px-1 py-0.5 font-mono text-[10px] leading-none text-slate-500 dark:text-zinc-400"
            >${() => (hints()[i] ? hints()[i].key : '')}</kbd
          >
          <span>${() => (hints()[i] ? hints()[i].label : '')}</span>
        </span>`.key('hint-slot:' + i),
      )}
    </div>
  `
}
