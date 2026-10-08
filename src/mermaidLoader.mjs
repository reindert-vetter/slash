// mermaidLoader — lazy mermaid rendering for the QA page's before/after pairs
// (.claude/docs/qa-page.md). The vendored bundle (src/vendor/mermaid.min.js,
// ~3.5 MB, see conventions.md) is a classic script that sets window.mermaid;
// it is injected only the first time a diagram is actually shown, so no other
// page — and no QA step without a diagram — pays for it.
//
// diagramHTML(src) is meant for an `.innerHTML="${() => …}"` binding: it
// returns the cached SVG, or a placeholder while the render runs; the binding
// re-runs through the reactive `diagrams.tick` once the render lands.
import { reactive } from './vendor/arrow.js'
import { theme } from './theme.mjs'
import { t } from './i18n.mjs'

export const diagrams = reactive({ tick: 0 })

const cache = new Map() // `${mode}:${src}` → { svg } | { error }
let loading = null
let queue = Promise.resolve() // mermaid.render is not re-entrant: serialize
let seq = 0

function loadMermaid() {
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = new URL('./vendor/mermaid.min.js', import.meta.url).href
      s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid did not load')))
      s.onerror = () => reject(new Error('mermaid did not load'))
      document.head.appendChild(s)
    })
    loading.catch(() => (loading = null))
  }
  return loading
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

// isDark derives the mode from theme.pref itself (same rule as applyTheme),
// not from <html>'s class: the theme watch may not have run yet when this
// binding re-runs on the same pref change.
function isDark() {
  const pref = theme.pref
  return pref === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : pref === 'dark'
}

function render(key, src, dark) {
  queue = queue
    .then(async () => {
      const mermaid = await loadMermaid()
      // securityLevel 'strict': mermaid sanitizes labels and disables click
      // handlers — the source is model-authored text. htmlLabels off keeps
      // the SVG free of foreignObject HTML.
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'default',
        flowchart: { htmlLabels: false },
      })
      const { svg } = await mermaid.render('qa-mermaid-' + ++seq, src)
      cache.set(key, { svg })
    })
    .catch((err) => {
      cache.set(key, { error: (err && err.message) || String(err) })
      // A failed render can leave its temporary element behind.
      document.querySelectorAll('[id^="dqa-mermaid-"]').forEach((el) => el.remove())
    })
    .finally(() => diagrams.tick++)
}

export function diagramHTML(src) {
  void diagrams.tick
  const dark = isDark()
  const key = (dark ? 'd:' : 'l:') + src
  const hit = cache.get(key)
  if (!hit) {
    cache.set(key, { pending: true })
    render(key, src, dark)
  }
  if (!hit || hit.pending) {
    return '<p class="text-[12px] text-slate-400 dark:text-zinc-500">' + escapeHtml(t('Diagram tekenen…')) + '</p>'
  }
  if (hit.error) {
    return (
      '<p class="text-[12px] font-semibold text-amber-800 dark:text-amber-300" data-testid="qa-diagram-error">! ' +
      escapeHtml(t('Diagram kon niet getekend worden')) +
      '</p><pre class="overflow-x-auto rounded-lg bg-slate-100 p-3 text-[12px] dark:bg-zinc-950">' +
      escapeHtml(src) +
      '</pre>'
    )
  }
  return '<div data-testid="qa-diagram" class="flex justify-center overflow-x-auto [&_svg]:h-auto">' + hit.svg + '</div>'
}
