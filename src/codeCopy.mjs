// codeCopy.mjs — a "Kopieer" button for a fenced code block that comes from
// a check or comment (the AI risk-warning / comment / Claude-chat text
// rendered through markdown.mjs's extractCodeFences, and its bigger sibling
// in CodePreview.mjs's pane()) — reviewer request: "maak een copy knop in
// alle codeblok dingen die uit een check of comment komt... rechts in dit
// balkje". Deliberately NOT added to Block.mjs's diff panes — those show the
// PR's own diff code, not something "uit een check of comment".
//
// Two render points, two wiring mechanisms sharing one feedback function:
//   - markdown.mjs builds a raw HTML string (`.innerHTML` binding, no arrow.js
//     template — see its own header comment), so its button's click can only
//     be reached via a document-level DELEGATED listener, exactly like
//     imageLightbox.mjs. `initMarkdownCodeCopy()` below is that listener.
//   - CodePreview.mjs is a real arrow.js template, so its button just calls
//     `copyCodeToClipboard` from a normal `@click`.
//
// Feedback is a WORD swap ("Kopieer" -> the existing "Gekopieerd!" i18n key,
// already used by overview.mjs's own copy-URL button for the same pattern),
// not a colour change — per the colourblind rule, colour alone never carries
// state. Applied by mutating the clicked button's own DOM directly (plain
// `textContent`/`title` writes) rather than through arrow.js reactive state:
// the markdown.mjs button has no arrow.js binding to hang state off in the
// first place, and doing it the same way for the CodePreview.mjs button keeps
// both call sites identical instead of inventing a second mechanism.
import { t } from './i18n.mjs'

const COPIED_MS = 1500

// copyCodeToClipboard writes `code` to the clipboard and flashes `btn`'s own
// label/title from "Kopieer" to "Gekopieerd!" for COPIED_MS, then reverts.
// Best-effort, same minimal error handling as every other clipboard write in
// this app (home.mjs's copyReviewSummary, overview.mjs's copyGithubUrl) — no
// toast convention here, a failed write (no permission, insecure context)
// just logs and leaves the button unchanged.
export async function copyCodeToClipboard(btn, code) {
  if (!btn) return
  try {
    await navigator.clipboard.writeText(code || '')
  } catch (err) {
    console.error('clipboard write failed:', err)
    return
  }
  flashCopied(btn)
}

function flashCopied(btn) {
  // The original label lives in `data-copy-label` (set once, in the markup
  // itself, by both call sites) rather than re-read from `textContent` on
  // every click — robust against a click landing mid-flash (the timer below
  // is cleared and restarted, never stacking two reverts).
  const original = btn.getAttribute('data-copy-label') || t('Kopieer')
  clearTimeout(btn._codeCopyTimer)
  btn.textContent = t('Gekopieerd!')
  btn.setAttribute('data-copied', 'true')
  btn._codeCopyTimer = setTimeout(() => {
    btn.textContent = original
    btn.removeAttribute('data-copied')
  }, COPIED_MS)
}

// initMarkdownCodeCopy wires the one document-level click listener for the
// raw-HTML fence header button (markdown.mjs's `data-testid="code-fence-copy"`).
// Idempotent — safe to call once per page, same shape as
// imageLightbox.mjs's initImageLightbox.
let initialized = false
export function initMarkdownCodeCopy() {
  if (initialized) return
  initialized = true
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-testid="code-fence-copy"]')
    if (!btn) return
    const wrapper = btn.closest('[data-fence-code]')
    if (!wrapper) return
    // stopPropagation so a click on this button doesn't also trigger
    // whatever the fence sits inside of (a comment row's own selection
    // click, a Claude-chat bubble) — same ordering rule as every nested
    // @click in this app: stop first, then act.
    e.stopPropagation()
    copyCodeToClipboard(btn, wrapper.dataset.fenceCode)
  })
}
