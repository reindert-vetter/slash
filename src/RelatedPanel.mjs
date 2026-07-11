// RelatedPanel — the column to the right of the selected block. Two stacked
// placeholder cards: on top the related/underlying code that the selected block
// calls into (later fed from the call-graph edges), below a task list + a chat
// with `claude` about the selected task. Everything here is dummy data for now —
// no /api wiring yet.

import { reactive, html } from './vendor/arrow.js'
import { highlight } from './Block.mjs'

// RELATED — dummy "underlying code" the selected block leans on. Later this comes
// from the edges table (the functions this block calls). Each entry is one small
// callee with a short source excerpt so the card looks real while we design it.
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

// TASKS — dummy review tasks. The chat below belongs to the *selected* task, so
// each task carries its own transcript (`you` = reviewer, `claude` = assistant).
// Later this is real work items with a real /api/claude thread per task.
const TASKS = [
  {
    title: 'billingAddress-wissel checken',
    status: 'open',
    // note — wat er als laatst gebeurde of wat er nu van de reviewer wordt
    // verwacht. Later afgeleid uit de thread (laatste bericht / open vraag).
    note:
      'Claude wacht op je antwoord: de method wisselt van $order->address naar ' +
      '->billingAddress. Bevestig of de rest van de payment-flow deze kolom ook ' +
      'gebruikt voordat we dit blok goedkeuren.',
    chat: [
      { role: 'claude', text: 'Deze method roept nu $order->billingAddress i.p.v. ->address aan. Bewust?' },
      { role: 'you', text: 'Ja, address is verwijderd. Klopt de rest van de flow nog?' },
      { role: 'claude', text: 'Placeholder-antwoord — chat is nog niet gekoppeld.' },
    ],
  },
  {
    title: 'Ontbrekende tests',
    status: 'in-progress',
    note: 'Claude schrijft een test…',
    chat: [
      { role: 'claude', text: 'findOrCreateCustomer heeft geen test voor de joinAddress-tak.' },
      { role: 'you', text: 'Schrijf een placeholder-test.' },
    ],
  },
  {
    title: 'Money::fromCents afronding',
    status: 'done',
    note: 'Afgerond · geen probleem gevonden',
    chat: [{ role: 'claude', text: 'Afronding gecontroleerd — geen probleem gevonden.' }],
  },
]

// STATUS_DOT — the little status marker colour per task state.
const STATUS_DOT = {
  open: 'bg-slate-300',
  'in-progress': 'bg-amber-400',
  done: 'bg-emerald-500',
}

// relatedCard renders one callee: a header (label + file:line) and a short,
// non-interactive code excerpt highlighted like the block panes. `highlight`
// escapes the source, so the string is safe for the .innerHTML binding.
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

// newTaskButton — the first item in the task list: a dashed "+ Nieuwe taak" row
// to start a new review task. Placeholder — not wired up yet.
function newTaskButton() {
  return html`
    <button
      class="flex w-full items-center gap-2 rounded-md border border-dashed border-slate-200 px-2.5 py-2 text-left text-slate-400 transition hover:border-indigo-200 hover:text-indigo-500"
      data-testid="new-task"
    >
      <span
        class="grid h-4 w-4 shrink-0 place-items-center rounded-full border border-current text-[11px] leading-none"
        >+</span
      >
      <span class="text-xs font-medium">Nieuwe taak</span>
    </button>
  `
}

// taskRow renders one task in the left list: a status dot + title, highlighted
// when it is the selected task. Clicking it switches the chat to that task.
function taskRow(t, i, ui) {
  return html`
    <button
      class="${() =>
        'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition ' +
        (ui.task === i ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-slate-50')}"
      data-testid="task-row"
      @click="${() => (ui.task = i)}"
    >
      <span class="${() => 'mt-1 h-2 w-2 shrink-0 rounded-full ' + (STATUS_DOT[t.status] || 'bg-slate-300')}"></span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-xs font-medium text-slate-800">${t.title}</span>
        <span class="line-clamp-3 text-[11px] leading-snug text-slate-500" data-testid="task-note"
          >${t.note}</span
        >
      </span>
    </button>
  `
}

// chatBubble renders one message, aligned right for the reviewer and left for
// claude, with the usual sent/received tinting.
function chatBubble(m) {
  const mine = m.role === 'you'
  return html`
    <div class="${() => 'flex ' + (mine ? 'justify-end' : 'justify-start')}">
      <div
        class="${() =>
          'max-w-[85%] rounded-2xl px-3 py-1.5 text-xs leading-relaxed ' +
          (mine ? 'bg-indigo-500 text-white' : 'bg-slate-100 text-slate-700')}"
        data-testid="chat-bubble"
      >
        ${() => m.text}
      </div>
    </div>
  `
}

// RelatedPanel — the fixed-width right column. Related code on top (scrolls if it
// grows), then a task list + the selected task's chat filling the rest, with a
// disabled placeholder composer at the foot. `ui` holds the local, non-persisted
// selection (which task's thread is open).
export default function RelatedPanel(ui) {
  // `ui.task` is the selected task; shared with home.mjs so Enter can jump the
  // selection to the top task. Fall back to a local reactive when used standalone.
  ui = ui || reactive({ task: 0 })
  return html`
    <aside
      class="flex w-[38rem] min-h-0 shrink-0 flex-col gap-3"
      data-testid="related-panel"
    >
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

      <section
        class="flex min-h-0 flex-1 flex-row overflow-hidden rounded-xl border border-slate-300 bg-white ring-1 ring-black/5"
        data-testid="tasks"
      >
        <div
          class="flex w-56 shrink-0 flex-col overflow-hidden border-r border-slate-100"
          data-testid="task-list"
        >
          <div class="border-b border-slate-100 px-3 py-2.5">
            <h2 class="text-sm font-semibold text-slate-800">Taken</h2>
            <p class="text-[11px] text-slate-400">dummy</p>
          </div>
          <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5">
            ${newTaskButton()}
            ${() => TASKS.map((t, i) => taskRow(t, i, ui).key('task:' + i))}
          </div>
        </div>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="chat">
          <div class="border-b border-slate-100 px-4 py-2.5">
            <h2 class="truncate text-sm font-semibold text-slate-800">
              ${() => TASKS[ui.task].title}
            </h2>
            <p class="text-[11px] text-slate-400">Overleg met claude · dummy</p>
          </div>
          <div class="no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
            ${() => TASKS[ui.task].chat.map((m, i) => chatBubble(m).key('chat:' + ui.task + ':' + i))}
          </div>
          <div class="flex items-center gap-2 border-t border-slate-100 p-2.5">
            <input
              class="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none"
              placeholder="Stel een vraag… (nog niet gekoppeld)"
              disabled
            />
            <button
              class="shrink-0 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white opacity-50"
              disabled
            >
              Stuur
            </button>
          </div>
        </div>
      </section>
    </aside>
  `
}
