// bellReminders.mjs — reminders and snoozing inside the notification bell,
// ONE implementation for every bell: /pr-overview's own (overview.mjs) and the
// small one on /pr/<id> (jiraBell.mjs). Reindert: "het zijn algemene
// reminders, dus overal". See "Reminders and snooze in the bell" in
// .claude/docs/pr-overview.md.
//
// - A reminder is free text plus a moment: "Nu" or one of the three PR-snooze
//   moments (snooze.mjs). It lives in the same feed as the Jira notifications
//   (id prefix "rem:", kind "reminder"), counts as unread once visible, and
//   behaves like a read Jira item after "gelezen".
// - Every row (Jira notification or reminder) gets a clock button with the
//   same three moments; a snoozed row leaves the list and sits in the
//   collapsed "Gesnoozed (N)" block until its moment, then comes back unread.
//
// The writes are createJiraNotifyActions' snooze/addReminder/deleteReminder
// (jiraNotifyActions.mjs): start-or-reuse jira_inbox, then Signal jira_notify.
// This file only renders. Its own small `ui` store is module-level: one bell
// per page.

import { html, reactive } from './vendor/arrow.js'
import { t } from './i18n.mjs'
import { relativeTime } from './relativeTime.mjs'
import { SNOOZE_OPTIONS, snoozePreviewUntil, formatSnoozeMoment } from './snooze.mjs'
import { jiraRespiteActive } from './jiraNotifyActions.mjs'
import { SnoozeDatePicker } from './SnoozeDatePicker.mjs'

const ui = reactive({
  composerOpen: false,
  text: '',
  snoozeFor: '', // id of the row whose snooze options are expanded
  snoozedOpen: false,
  saving: '', // option key being saved right now ('' = idle)
  failed: false,
})

const REMINDER_OPTIONS = [{ key: 'now', label: 'Nu' }, ...SNOOZE_OPTIONS]

// svg — an icon as a raw string through .innerHTML: a <path> built as its own
// html`` fragment would land in the HTML namespace and not render.
function svg(paths, cls = 'h-3.5 w-3.5') {
  const markup =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="' +
    cls +
    '" aria-hidden="true">' +
    paths.map((d) => '<path d="' + d + '"></path>').join('') +
    '</svg>'
  return html`<span class="inline-flex shrink-0" .innerHTML="${() => markup}"></span>`
}
const CLOCK = ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2']
const PLUS = ['M12 5v14', 'M5 12h14']
const X = ['M18 6 6 18', 'm6 6 12 12']
const CHECK = ['M20 6 9 17l-5-5']
const UNDO = ['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13']

const ICON_BTN =
  'rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600 dark:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-indigo-400'
const SMALL_BTN =
  'shrink-0 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'

// A button nested in a row's <a>: no navigation, no bubbling, BEFORE the state
// change (the nested-@click ordering rule in .claude/rules/arrowjs-pitfalls.md).
function stop(e) {
  if (!e) return false
  e.preventDefault()
  e.stopPropagation()
  return true
}

function momentLabel(key) {
  if (key === 'now') return t('direct')
  return formatSnoozeMoment(snoozePreviewUntil(key))
}

// createBellReminders binds the rendering to one bell's actions (the object
// createJiraNotifyActions returned) and its snoozed list getter.
export function createBellReminders(actions, getSnoozed) {
  function addButton() {
    return html`<button
      type="button"
      data-testid="reminder-add"
      title="${t('Herinnering toevoegen')}"
      class="${SMALL_BTN + ' inline-flex items-center gap-1'}"
      @click="${() => {
        ui.composerOpen = !ui.composerOpen
        if (ui.composerOpen) requestAnimationFrame(() => document.querySelector('[data-testid="reminder-text"]')?.focus())
      }}"
    >
      ${svg(PLUS, 'h-3 w-3')}<span>${t('Herinnering')}</span>
    </button>`
  }

  async function submit(option) {
    const text = ui.text.trim()
    if (!text || ui.saving) return
    ui.saving = option
    ui.failed = false
    const ok = await actions.addReminder(text, option)
    ui.saving = ''
    if (!ok) {
      ui.failed = true // text stays, so nothing typed is lost
      return
    }
    ui.text = ''
    ui.composerOpen = false
    // A later moment lands in "Gesnoozed", not the main list: open it so the
    // saved reminder is visible.
    if (option !== 'now') ui.snoozedOpen = true
  }

  // composer — the text field plus the four moments; picking a moment creates
  // the reminder, Enter means "Nu". Stable root, toggled inside.
  function composer() {
    return html`<div class="contents">
      ${() =>
        ui.composerOpen
          ? [
              html`<div data-testid="reminder-composer" class="border-b border-slate-100 px-3 py-2.5 dark:border-zinc-800">
                <input
                  type="text"
                  data-testid="reminder-text"
                  maxlength="500"
                  placeholder="${t('Waar wil je aan herinnerd worden?')}"
                  class="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px] text-slate-900 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                  value="${() => ui.text}"
                  disabled="${() => !!ui.saving}"
                  @input="${(e) => (ui.text = e.target.value)}"
                  @keydown="${(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.stopPropagation()
                      submit('now')
                    }
                  }}"
                />
                <div class="mt-2 flex flex-wrap items-center gap-1.5">
                  <span class="text-[11px] text-slate-500 dark:text-zinc-500">${t('Zichtbaar:')}</span>
                  ${REMINDER_OPTIONS.map((o) =>
                    html`<button
                      type="button"
                      data-testid="reminder-option"
                      data-option="${o.key}"
                      class="${SMALL_BTN}"
                      disabled="${() => !ui.text.trim() || !!ui.saving}"
                      @click="${() => submit(o.key)}"
                    >
                      <span
                        data-testid="reminder-spinner"
                        class="${() => (ui.saving === o.key ? 'mr-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]' : 'hidden')}"
                      ></span>
                      ${() => (ui.saving === o.key ? t('Opslaan…') + ' ' : '')}${t(o.label)} <span class="text-slate-400 dark:text-zinc-500">· ${momentLabel(o.key)}</span>
                    </button>`.key('ro:' + o.key),
                  )}
                  ${SnoozeDatePicker({
                    testid: 'reminder-date',
                    label: 'Op dit moment',
                    buttonCls: SMALL_BTN,
                    disabled: () => !ui.text.trim() || !!ui.saving,
                    onPick: (option) => submit(option),
                  })}
                  <span data-testid="reminder-failed" class="text-[11px] font-medium text-rose-600 dark:text-rose-400">${() => (ui.failed ? '✕ ' + t('Opslaan mislukt') : '')}</span>
                </div>
              </div>`.key('reminder-composer'),
            ]
          : []}
    </div>`
  }

  // snoozeButton — the clock on every row; expands snoozeOptions(n).
  function snoozeButton(n) {
    return html`<button
      type="button"
      data-testid="notify-snooze"
      title="${t('Snooze…')}"
      class="${ICON_BTN}"
      @click="${(e) => {
        if (!stop(e)) return
        ui.snoozeFor = ui.snoozeFor === n.id ? '' : n.id
      }}"
    >
      ${svg(CLOCK)}
    </button>`
  }

  function snoozeOptions(n) {
    return html`<div class="contents">
      ${() =>
        ui.snoozeFor === n.id
          ? [
              html`<div data-testid="notify-snooze-options" class="mt-1.5 flex flex-wrap gap-1.5">
                ${SNOOZE_OPTIONS.map((o) =>
                  html`<button
                    type="button"
                    data-testid="notify-snooze-option"
                    data-option="${o.key}"
                    class="${SMALL_BTN}"
                    @click="${(e) => {
                      if (!stop(e)) return
                      ui.snoozeFor = ''
                      actions.snooze(n, o.key)
                    }}"
                  >
                    ${t(o.label)} <span class="text-slate-400 dark:text-zinc-500">· ${momentLabel(o.key)}</span>
                  </button>`.key('so:' + o.key),
                )}
                ${SnoozeDatePicker({
                  testid: 'notify-snooze-date',
                  buttonCls: SMALL_BTN,
                  onPick: (option) => {
                    ui.snoozeFor = ''
                    actions.snooze(n, option)
                  },
                })}
              </div>`.key('snooze-options'),
            ]
          : []}
    </div>`
  }

  function deleteButton(n) {
    return html`<button
      type="button"
      data-testid="reminder-delete"
      title="${t('Herinnering verwijderen')}"
      class="${ICON_BTN}"
      @click="${(e) => {
        if (!stop(e)) return
        actions.deleteReminder(n)
      }}"
    >
      ${svg(X)}
    </button>`
  }

  // reminderRow — a reminder in the list. Not a link (there is nowhere to go):
  // a click marks it read, like opening a Jira row. Unread = dot plus bold
  // text plus the word "Herinnering" — never colour alone.
  function reminderRow(n) {
    return html`<div
      data-testid="reminder-row"
      data-jira-id="${n.id}"
      class="group flex cursor-default items-start gap-3 border-b border-slate-100 px-4 py-3 transition-colors last:border-b-0 hover:bg-slate-100 dark:border-zinc-800/70 dark:hover:bg-zinc-800/40"
      @click="${() => actions.markRead(n)}"
    >
      <span class="flex w-8 shrink-0 items-center justify-center pt-0.5 text-indigo-500 dark:text-indigo-400">${svg(CLOCK, 'h-5 w-5')}</span>
      <div class="min-w-0 flex-1">
        <h3
          class="${'whitespace-pre-wrap break-words text-[13.5px] text-slate-900 dark:text-zinc-100 ' + (n.unread ? 'font-semibold' : 'font-normal')}"
        >${n.title}</h3>
        <p class="mt-0.5 text-xs text-slate-500 dark:text-zinc-500">
          ${t('Herinnering') + ' · ' + relativeTime(n.at)}
          ${() =>
            !n.unread && jiraRespiteActive(n)
              ? [html`<span data-testid="jira-respite-mark" class="text-indigo-500 dark:text-indigo-400">· ${t('net gelezen')}</span>`.key('respite')]
              : []}
        </p>
        ${snoozeOptions(n)}
      </div>
      <div class="flex shrink-0 items-center gap-2 self-start pt-0.5">
        <div class="contents">
          ${() =>
            n.unread
              ? [
                  html`<button type="button" data-testid="jira-mark-read" title="${t('Markeer als gelezen')}" class="${ICON_BTN}"
                    @click="${(e) => stop(e) && actions.markRead(n)}">${svg(CHECK)}</button>`.key('read'),
                ]
              : [
                  html`<button type="button" data-testid="jira-mark-unread" title="${t('Markeer als ongelezen')}" class="${ICON_BTN}"
                    @click="${(e) => stop(e) && actions.markUnread(n)}">${svg(UNDO)}</button>`.key('unread'),
                ]}
        </div>
        ${snoozeButton(n)} ${deleteButton(n)}
        <span
          data-testid="${n.unread ? 'jira-unread-dot' : 'reminder-read-gap'}"
          title="${n.unread ? t('Ongelezen') : ''}"
          class="${'inline-block h-2 w-2 shrink-0 rounded-full ' + (n.unread ? 'bg-indigo-500 dark:bg-indigo-400' : '')}"
        ></span>
      </div>
    </div>`.key('jira:' + n.id + (n.unread ? ':u' : ':r'))
  }

  // snoozedSection — the collapsed "Gesnoozed (N)" block at the bottom of the
  // panel, with "Snooze opheffen" per row. Always-present root; hidden at 0.
  function snoozedSection() {
    return html`<div
      data-testid="notify-snoozed-section"
      class="${() => 'border-t border-slate-100 dark:border-zinc-800 ' + ((getSnoozed() || []).length ? 'block' : 'hidden')}"
    >
      <button
        type="button"
        data-testid="notify-snoozed-toggle"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-slate-600 hover:bg-slate-50 dark:text-zinc-400 dark:hover:bg-zinc-800/40"
        @click="${() => (ui.snoozedOpen = !ui.snoozedOpen)}"
      >
        ${svg(CLOCK)}
        <span>${() => t('Gesnoozed ({n})', { n: (getSnoozed() || []).length })}</span>
        <span class="ml-auto text-[11px] text-slate-400 dark:text-zinc-500">${() => (ui.snoozedOpen ? t('verbergen') : t('tonen'))}</span>
      </button>
      ${() =>
        ui.snoozedOpen
          ? (getSnoozed() || []).map((n) =>
              html`<div data-testid="notify-snoozed-row" data-jira-id="${n.id}" class="flex items-start gap-3 px-4 py-2 text-[12.5px]">
                <div class="min-w-0 flex-1">
                  <p class="line-clamp-2 text-slate-800 dark:text-zinc-200">${(n.kind === 'reminder' ? t('Herinnering') + ': ' : '') + (n.title || n.issueKey || '')}</p>
                  <p class="text-[11px] text-slate-500 dark:text-zinc-500">
                    ${t('gesnoozed tot {time}', { time: formatSnoozeMoment(new Date(n.snoozedUntil)) })}
                  </p>
                </div>
                <button type="button" data-testid="notify-unsnooze" class="${SMALL_BTN}" @click="${() => actions.snooze(n, 'clear')}">
                  ${t('Snooze opheffen')}
                </button>
                <div class="contents">${() => (n.kind === 'reminder' ? [deleteButton(n).key('del')] : [])}</div>
              </div>`.key('snoozed:' + n.id + ':' + n.snoozedUntil),
            )
          : []}
    </div>`
  }

  return { addButton, composer, snoozeButton, snoozeOptions, reminderRow, snoozedSection }
}
