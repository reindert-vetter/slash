// RelatedPanel — the column to the right of the selected block. Two stacked
// cards: on top the live **comments** on lines of code (wired to the
// task_code_comment workflow), below the related/underlying code the block calls
// into (still dummy — fed from the call-graph edges later).

import { html } from './vendor/arrow.js'
import { reactive } from './vendor/arrow.js'
import { highlight } from './Block.mjs'

// ── Real comments (task_code_comment workflow) ────────────────────────────────
// This section IS wired to the API. Placing a comment starts a Workflow
// Execution (POST /api/workflows/task_code_comment); a reaction sends a Signal
// (POST /api/workflows/{runId}/signals/reply). Everything else here is read-only
// (GET /api/comments?pr=N). Per the write-boundary rule, the UI only ever writes
// by starting or signalling a workflow — never straight to a store.
const cs = reactive({ pr: null, list: [], sel: 0, composing: false, busy: false })

// selectTopComment jumps the selection to the first comment — home.mjs calls it
// on Enter (the shared bit of navigation state).
export function selectTopComment() {
  cs.sel = 0
}

async function loadComments(pr) {
  if (pr == null) return
  try {
    const res = await fetch('/api/comments?pr=' + encodeURIComponent(pr))
    if (res.ok) cs.list = await res.json()
  } catch (_) {
    // keep the last good list on a transient error
  }
}

// syncComments refetches when the PR changes and starts a slow refresh so
// GitHub-polled reactions (server-side, once a minute) surface in the UI.
let refreshTimer = null
function syncComments(pr) {
  if (cs.pr !== pr) {
    cs.pr = pr
    cs.sel = 0
    loadComments(pr)
  }
  if (!refreshTimer) {
    refreshTimer = setInterval(() => cs.pr != null && loadComments(cs.pr), 5000)
  }
}

async function placeComment(state) {
  const b = state && state.blocks && state.blocks[state.selected]
  const el = document.querySelector('[data-testid=comment-compose]')
  const body = el && el.value.trim()
  if (!b || !body) return
  cs.busy = true
  try {
    await fetch('/api/workflows/task_code_comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr: state.pr, file: b.file, line: b.line, author: 'reviewer', body }),
    })
    el.value = ''
    cs.composing = false
    await loadComments(state.pr)
    cs.sel = Math.max(0, cs.list.length - 1)
  } finally {
    cs.busy = false
  }
}

async function sendReaction(done) {
  const c = cs.list[cs.sel]
  if (!c) return
  const el = document.querySelector('[data-testid=reaction-compose]')
  const body = (el && el.value.trim()) || (done ? '/resolve' : '')
  if (!body) return
  cs.busy = true
  try {
    await fetch('/api/workflows/' + encodeURIComponent(c.runId) + '/signals/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'reviewer', body, done }),
    })
    if (el) el.value = ''
    await loadComments(cs.pr)
  } finally {
    cs.busy = false
  }
}

const CSTATUS_DOT = { open: 'bg-amber-400', resolved: 'bg-emerald-500' }

// commentRow — one placed comment (a Workflow Execution) in the left list.
function commentRow(c, i) {
  return html`
    <button
      class="${() =>
        'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition ' +
        (cs.sel === i ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-slate-50')}"
      data-testid="comment-item"
      @click="${() => (cs.sel = i)}"
    >
      <span class="${() => 'mt-1 h-2 w-2 shrink-0 rounded-full ' + (CSTATUS_DOT[c.status] || 'bg-slate-300')}"></span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-xs font-medium text-slate-800">${() => c.body}</span>
        <span class="truncate text-[11px] leading-snug text-slate-500" data-testid="comment-meta"
          >${() => c.file + ':' + c.line + ' · ' + c.reactionCount + ' reacties · ' + c.status}</span
        >
      </span>
    </button>
  `
}

function reactionBubble(r) {
  const mine = r.source === 'ui'
  return html`
    <div class="${() => 'flex ' + (mine ? 'justify-end' : 'justify-start')}">
      <div
        class="${() =>
          'max-w-[85%] rounded-2xl px-3 py-1.5 text-xs leading-relaxed ' +
          (mine ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-700')}"
        data-testid="reaction-bubble"
      >
        ${() => r.body}
      </div>
    </div>
  `
}

// commentsSection — the wired panel: placed comments on the left, the selected
// comment's reactions + a working composer on the right, and a "+ Comment op deze
// regel" button that starts a new Execution on the current block.
function commentsSection(state) {
  syncComments(state ? state.pr : null)
  const target = () => {
    const b = state && state.blocks && state.blocks[state.selected]
    return b ? b.file + ':' + b.line : 'geen regel geselecteerd'
  }
  return html`
    <section
      class="flex min-h-0 flex-1 flex-row overflow-hidden rounded-xl border border-slate-300 bg-white ring-1 ring-black/5"
      data-testid="comments-panel"
    >
      <div class="flex w-56 shrink-0 flex-col overflow-hidden border-r border-slate-100">
        <div class="border-b border-slate-100 px-3 py-2.5">
          <h2 class="text-sm font-semibold text-slate-800">Comments</h2>
          <p class="text-[11px] text-slate-400">op regels code · live</p>
        </div>
        <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5">
          <button
            class="flex w-full items-center gap-2 rounded-md border border-dashed border-slate-200 px-2.5 py-2 text-left text-slate-400 transition hover:border-indigo-200 hover:text-indigo-500"
            data-testid="new-comment"
            @click="${() => (cs.composing = !cs.composing)}"
          >
            <span
              class="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-current text-[11px] leading-none"
              >+</span
            >
            <span class="text-xs font-medium">Comment op deze regel</span>
          </button>
          ${() => cs.list.map((c, i) => commentRow(c, i).key('comment:' + c.id))}
          ${() =>
            cs.list.length === 0
              ? html`<p class="px-2.5 py-3 text-[11px] text-slate-400">Nog geen comments.</p>`
              : null}
        </div>
      </div>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="comment-thread">
        <div class="border-b border-slate-100 px-4 py-2.5">
          <h2 class="truncate text-sm font-semibold text-slate-800">
            ${() => (cs.composing ? 'Nieuwe comment · ' + target() : cs.list[cs.sel] ? cs.list[cs.sel].body : 'Comments')}
          </h2>
          <p class="text-[11px] text-slate-400">
            ${() => (cs.composing ? 'start een task op deze regel' : 'reacties hooken hier op de comment in')}
          </p>
        </div>

        ${() =>
          cs.composing
            ? html`
                <div class="flex min-h-0 flex-1 flex-col gap-2 p-3">
                  <textarea
                    class="min-h-24 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none"
                    placeholder="Je comment op ${() => target()}…"
                    data-testid="comment-compose"
                  ></textarea>
                  <div class="flex items-center justify-end gap-2">
                    <button
                      class="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
                      @click="${() => (cs.composing = false)}"
                    >
                      Annuleer
                    </button>
                    <button
                      class="${() =>
                        'rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white ' +
                        (cs.busy ? 'opacity-50' : 'hover:bg-indigo-600')}"
                      data-testid="comment-send"
                      @click="${() => placeComment(state)}"
                    >
                      Plaats comment
                    </button>
                  </div>
                </div>
              `
            : html`
                <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                  ${() =>
                    (cs.list[cs.sel] ? cs.list[cs.sel].reactions || [] : []).map((r) =>
                      reactionBubble(r).key('reaction:' + r.id)
                    )}
                </div>
                <div class="flex items-center gap-2 border-t border-slate-100 p-2.5">
                  <input
                    class="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none"
                    placeholder="Reageer op deze comment…"
                    data-testid="reaction-compose"
                    @keydown="${(e) => e.key === 'Enter' && sendReaction(false)}"
                  />
                  <button
                    class="shrink-0 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600"
                    data-testid="reaction-send"
                    @click="${() => sendReaction(false)}"
                  >
                    Stuur
                  </button>
                  <button
                    class="shrink-0 rounded-lg border border-emerald-300 px-2.5 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-50"
                    data-testid="reaction-resolve"
                    @click="${() => sendReaction(true)}"
                  >
                    ✓
                  </button>
                </div>
              `}
      </div>
    </section>
  `
}

// ── Related code (placeholder — call-graph edges later) ───────────────────────
const RELATED = [
  {
    label: 'PaymentResource::toArray',
    file: 'app/Http/Resources/PaymentResource.php',
    line: 18,
    code:
      "public function toArray($request): array\n" +
      "{\n" +
      "    return [\n" +
      "        'id'     => $this->id,\n" +
      "        'amount' => $this->amount,\n" +
      "    ];\n" +
      "}",
  },
  {
    label: 'Money::fromCents',
    file: 'app/Support/Money.php',
    line: 42,
    code:
      "public static function fromCents(int $cents): self\n" +
      "{\n" +
      "    return new self($cents);\n" +
      "}",
  },
]

// relatedCard renders one callee: a header (label + file:line) and a short,
// non-interactive code excerpt highlighted like the block panes.
function relatedCard(r) {
  return html`
    <div class="rounded-lg border border-slate-200 bg-slate-50/60" data-testid="related-item">
      <div class="flex items-baseline gap-2 border-b border-slate-100 px-3 py-1.5">
        <span class="truncate font-mono text-xs font-semibold text-slate-700">${r.label}</span>
        <span class="ml-auto shrink-0 font-mono text-[10px] text-slate-400"
          >${r.file}:${r.line}</span
        >
      </div>
      <code
        class="language-php m-0 block overflow-x-auto whitespace-pre px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-700"
        .innerHTML="${() => highlight(r.code)}"
      ></code>
    </div>
  `
}

// RelatedPanel — the fixed-width right column: live comments on top, related
// code below.
export default function RelatedPanel(state) {
  return html`
    <aside class="flex w-[38rem] min-h-0 shrink-0 flex-col gap-3" data-testid="related-panel">
      ${commentsSection(state)}

      <section
        class="flex min-h-0 max-h-[40%] flex-col overflow-hidden rounded-xl border border-slate-300 bg-white ring-1 ring-black/5"
        data-testid="related-code"
      >
        <div class="border-b border-slate-100 px-4 py-2.5">
          <h2 class="text-sm font-semibold text-slate-800">Gerelateerde code</h2>
          <p class="text-[11px] text-slate-400">Functies die dit blok aanroept · dummy</p>
        </div>
        <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
          ${() => RELATED.map((r) => relatedCard(r).key('related:' + r.label))}
        </div>
      </section>
    </aside>
  `
}
