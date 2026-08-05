// CodePreview.mjs — the standalone code-preview column opened from a
// "Bekijk volledig ↗" button inside a comment/Claude-chat code fence (see
// markdown.mjs's extractCodeFences and RelatedPanel.mjs's openCodePreview/
// CodePreviewPanel, which owns the reactive `cp` state this file only
// renders). Pure template, no reactive() state of its own and no import of
// RelatedPanel.mjs — the same split ClaudeChat.mjs/translationDiff.mjs
// already have with their owning module, so there is no circular import.
//
// D1 (see .claude/docs/claude-chat-panel.md, "A full-size code-preview
// column"): this is deliberately NOT a real line-diff. There is no
// clientside diff algorithm in this codebase — the existing diff rendering
// (Block.mjs's codeDiff/unifiedCodeDiff) works only on `rows` the backend
// already shaped from the PR's own git hunks, not on two arbitrary strings.
// Building/vendoring a diff algorithm for this one feature was judged out of
// proportion; instead the two sides render as independently Prism-highlighted
// panes, stacked "Huidig" above "Voorgesteld" below — literally what was
// asked ("onder elkaar, oude boven, nieuwe onder"), without colour-coded
// line-level comparison. A follow-up can add real diffing later.
import { html } from './vendor/arrow.js'
import { highlightForLang } from './Block.mjs'

function pane(titleText, code, lang) {
  return html`
    <div class="rounded border border-slate-200 dark:border-zinc-700 overflow-hidden">
      <div
        class="px-2 py-1 text-[11px] font-medium text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/60 border-b border-slate-200 dark:border-zinc-700"
      >
        ${titleText}
      </div>
      <pre
        class="code m-0 max-h-[40vh] overflow-auto p-2 text-xs leading-relaxed"
      ><code class="language-php" .innerHTML="${() => highlightForLang(code, lang)}"></code></pre>
    </div>
  `
}

// codePreviewPanel(cp, onClose) — `cp` is the reactive `{ open, lang, code,
// oldCode, title }` object RelatedPanel.mjs owns; every field that can change
// is read from inside its own `${() => ...}` binding (mirrors
// claudeChatColumn's own discipline in ClaudeChat.mjs) so a later open of a
// DIFFERENT fence — which reuses this same mounted shape — always repaints,
// never freezing on the first-opened fence's content (the static chunk-reuse
// pitfall in arrowjs-pitfalls.md).
export function codePreviewPanel(cp, onClose) {
  return html`
    <div
      class="flex w-[42rem] shrink-0 flex-col gap-2 rounded-xl border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 ring-1 ring-black/5"
      data-testid="code-preview-column"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="truncate text-[11px] font-medium text-slate-500 dark:text-zinc-500" data-testid="code-preview-title">
          ${() => cp.title || 'Codeblok'}
        </span>
        <button
          type="button"
          class="shrink-0 rounded text-slate-400 hover:text-indigo-600 dark:text-zinc-600 dark:hover:text-indigo-400"
          data-testid="code-preview-close"
          title="Sluiten"
          @click="${() => onClose()}"
        >
          ✕
        </button>
      </div>
      <div class="flex flex-col gap-2" data-testid="code-preview-body">
        ${() => (cp.oldCode != null ? pane('Huidig (PR)', cp.oldCode, cp.lang) : '')}
        ${() => pane(cp.oldCode != null ? 'Voorgesteld (chat)' : 'Codeblok', cp.code, cp.lang)}
      </div>
    </div>
  `
}
