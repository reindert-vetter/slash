// jiraNotifyActions.mjs — the ONE implementation of the three Jira-notification
// writes (mark one read, mark one unread again, mark all read) plus the
// just-read grace period they share. Both bells use it: `/pr-overview`'s own
// header bell (overview.mjs) and the small ported bell on `/pr/<id>` and
// `/plan/<KEY>` (jiraBell.mjs), which each keep their own rendering and their
// own reactive store but no longer their own copy of this logic (Reindert:
// "gebruik die van de rest. laat het 1 code zijn .mjs ofzo").
//
// Every write goes the sanctioned way (.claude/rules/workflows-write-boundary.md):
// start (or reuse) the single `jira_inbox` Execution and Signal it with
// `jira_notify`; the tracker's own Activity is the only thing that touches the
// read-model. The local list is updated optimistically so the row, the
// "N ongelezen" counter and the "Alleen ongelezen" filter react on the spot;
// the next poll confirms it. For the unread direction the backend keeps a
// `forced_unread` override precisely so a poll cannot undo it — see
// modules/jiranotify.

import { snoozePreviewUntil } from './snooze.mjs'

// A just-read notification stays visible for a short grace period instead of
// vanishing the instant "Alleen ongelezen" is on (Reindert: "met alleen
// ongelezen aan verdwijnt een item nu meteen zodra het gelezen is — ook door
// je eigen klik — en dan ben je je context kwijt op het moment dat je erop
// klikt"). JIRA_READ_RESPITE_MS is that grace period.
//
// It counts from the moment THIS TAB marked the row read (markRead's own
// Date.now(), not a server timestamp — the read-model's read_at column exists
// but is never sent to the client, see modules/jiranotify's Item, and adding
// that would be a new field for a purely client-side display grace period).
// A row that's genuinely still unread never enters this map at all.
//
// jiraReadRespite is deliberately a PLAIN, non-reactive module-level Map, not
// reactive state — this is a display fact, not domain state. It therefore does
// NOT survive a page refresh (the module reinitializes, the map is empty
// again) — a refresh mid-grace simply ends the grace early rather than "coming
// back" or restarting the countdown, which is the explicit request. It also
// isn't wiped by the periodic `state.jira = ...` reassignment of either page's
// poll, unlike a reactive property would be, so the grace period survives the
// ordinary 60s poll.
export const JIRA_READ_RESPITE_MS = 5 * 60 * 1000
const jiraReadRespite = new Map() // notification id -> Date.now() when marked read here

// jiraRespiteActive: is this row still within its own grace period. Lazily
// forgets an expired entry so the map never grows with stale ids.
export function jiraRespiteActive(n) {
  const at = jiraReadRespite.get(n.id)
  if (typeof at !== 'number') return false
  if (Date.now() - at >= JIRA_READ_RESPITE_MS) {
    jiraReadRespite.delete(n.id)
    return false
  }
  return true
}

// pruneJiraRespite is called by each page's own loader after it replaced the
// list: a notification that dropped out of the read-model entirely (purged,
// see .claude/docs/workflows-trackers.md's jira_inbox retention) can never be
// shown again, grace period or not — drop its stray map entry so the map
// doesn't grow forever across a long session.
export function pruneJiraRespite(items) {
  const liveIds = new Set((items || []).map((n) => n.id))
  for (const id of jiraReadRespite.keys()) {
    if (!liveIds.has(id)) jiraReadRespite.delete(id)
  }
}

// createJiraNotifyActions binds the three writes to one page's own store. The
// store is a tiny adapter over whatever reactive object that page already has
// (overview.mjs's `state`, jiraBell.mjs's `bell`): getItems/setItems for the
// notification list, getRunId/setRunId for the cached jira_inbox Run ID,
// getSnoozed/setSnoozed for the snoozed rows and reload() to re-read the feed
// after a snooze/reminder write.
export function createJiraNotifyActions(store) {
  // ensureRunId starts (or reuses) the single jira_inbox Execution and returns
  // its Run ID — the write target every jira_notify Signal needs. One place
  // that knows how to bootstrap the tracker, shared by all three writes.
  async function ensureRunId() {
    let runId = store.getRunId()
    if (!runId) {
      const started = await fetch('/api/workflows/jira_inbox', { method: 'POST' })
      const body = await started.json()
      runId = (body && body.runId) || ''
      store.setRunId(runId)
    }
    return runId
  }

  async function signal(payload) {
    try {
      const runId = await ensureRunId()
      if (!runId) return false
      const res = await fetch('/api/workflows/' + encodeURIComponent(runId) + '/signals/jira_notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return res.ok
    } catch (err) {
      console.error('jira_notify signal failed:', payload.kind, err)
      return false
    }
  }

  // markRead has two callers on both pages: opening the row (its own @click)
  // and the explicit per-row tick. Both start this row's read-grace period — a
  // reviewer clicking a row to open it is exactly the case that must not
  // vanish out from under them.
  async function markRead(n) {
    if (!n || !n.unread) return
    jiraReadRespite.set(n.id, Date.now())
    store.setItems(store.getItems().map((it) => (it.id === n.id ? { ...it, unread: false } : it)))
    await signal({ kind: 'read', id: n.id })
  }

  // markUnread is markRead's mirror (Reindert: "ik wil rechtermuisknop kunnen
  // drukken en het op ongelezen kunnen markeren", later "laat meldingen ook
  // ongelezen kunnen zetten" for the second bell too). It forgets any leftover
  // grace-period entry: the row is unread again now, so there is nothing left
  // to hold it visible past its own real unread state.
  async function markUnread(n) {
    if (!n || n.unread) return
    jiraReadRespite.delete(n.id)
    store.setItems(store.getItems().map((it) => (it.id === n.id ? { ...it, unread: true } : it)))
    await signal({ kind: 'unread', id: n.id })
  }

  // markAllRead is the "Alles gelezen maken" bulk action. Deliberately does
  // NOT start a read-grace period for the rows it clears (unlike markRead):
  // it is itself the explicit "I'm done looking at these" action, the opposite
  // of the single-row-click case the grace period exists for — granting it
  // here would make the button not actually clear the "Alleen ongelezen" list.
  async function markAllRead() {
    const items = store.getItems()
    if (!items.some((it) => it.unread)) return
    store.setItems(items.map((it) => (it.unread ? { ...it, unread: false } : it)))
    await signal({ kind: 'read_all' })
  }

  // snooze hides one notification or reminder until the chosen moment (the
  // three PR-snooze options, see snooze.mjs), or lifts it with 'clear'. The
  // moment itself is computed in the workflow; here only optimistically: the
  // row moves between the visible list and `snoozed` at once, and comes back
  // unread (Reindert: a snoozed notification returns as unread).
  async function snooze(n, option) {
    if (!n) return
    const items = store.getItems()
    const snoozed = store.getSnoozed ? store.getSnoozed() : []
    if (option === 'clear') {
      store.setSnoozed(snoozed.filter((it) => it.id !== n.id))
      store.setItems([{ ...n, snoozedUntil: '' }, ...items.filter((it) => it.id !== n.id)])
    } else {
      jiraReadRespite.delete(n.id)
      const until = snoozePreviewUntil(option)
      store.setItems(items.filter((it) => it.id !== n.id))
      store.setSnoozed([...snoozed.filter((it) => it.id !== n.id), { ...n, unread: true, snoozedUntil: until ? until.toISOString() : '' }])
    }
    await signal({ kind: 'snooze', id: n.id, option })
    store.reload && store.reload()
  }

  // addReminder creates one free-text reminder, visible 'now' or at one of
  // the three snooze moments. Its id is minted by the workflow, so there is no
  // optimistic row — the list is re-read right after the Signal.
  async function addReminder(text, option) {
    const body = String(text || '').trim()
    if (!body) return false
    // true only once the Signal was accepted AND the list was re-read, so the
    // composer's loader can stay up until the reminder is really in the list.
    const ok = await signal({ kind: 'reminder_add', text: body, option })
    if (!ok) return false
    if (store.reload) await store.reload()
    return true
  }

  // deleteReminder removes a reminder for good (from either list).
  async function deleteReminder(n) {
    if (!n) return
    store.setItems(store.getItems().filter((it) => it.id !== n.id))
    if (store.getSnoozed) store.setSnoozed(store.getSnoozed().filter((it) => it.id !== n.id))
    await signal({ kind: 'reminder_delete', id: n.id })
    store.reload && store.reload()
  }

  return { ensureRunId, markRead, markUnread, markAllRead, snooze, addReminder, deleteReminder }
}
