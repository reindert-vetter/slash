// chatMode.mjs — the Claude chat composer's per-conversation "Aanpassen" /
// "Alleen voorstellen" switch.
//
// Default is "Alleen voorstellen". A conversation the reviewer switched to
// "Aanpassen" (Claude may edit code, and may still propose) is remembered
// explicitly; every other conversation is propose-only. A propose-only turn sends `proposeOnly: true` with
// every message, and the backend then never escalates that turn to Edit/Bash
// (runOneClaudeTurn, chat_workflow.go) — the mode travels with each Signal and
// so lands in the workflow history; this module only remembers the switch
// position per conversation for this viewer, in localStorage (a per-viewer
// UI preference, like the theme — not state the server needs to own).
//
// Keyed by the composer's bucket: the conversation id, or the composer draft
// key while a brand-new chat has no conversation yet — moveChatProposeOnly
// carries the setting over once the first message creates the conversation.
import { reactive } from './vendor/arrow.js'

// Stores the keys explicitly set to "Aanpassen" (the default is propose-only).
const STORAGE_KEY = 'claudeChatEditMode'

// rev is the only reactive part: the set itself is plain, so a getter reads
// rev first to subscribe, then the set.
const ui = reactive({ rev: 0 })
let ids = null

function load() {
  if (ids) return ids
  ids = new Set()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const arr = raw ? JSON.parse(raw) : []
    if (Array.isArray(arr)) arr.forEach((k) => typeof k === 'string' && ids.add(k))
  } catch (_) {
    // private window / blocked storage: every chat simply starts on "Alleen voorstellen"
  }
  return ids
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...load()]))
  } catch (_) {
    // best-effort, see load()
  }
}

export function isChatProposeOnly(key) {
  ui.rev
  return !!key && !load().has(String(key))
}

export function setChatProposeOnly(key, on) {
  if (!key) return
  const k = String(key)
  if (on) load().delete(k)
  else load().add(k)
  save()
  ui.rev++
}

// moveChatProposeOnly hands a new chat's setting from its draft key over to
// the conversation id its first message just created.
export function moveChatProposeOnly(from, to) {
  if (!from || !to || String(from) === String(to)) return
  if (!load().has(String(from))) return
  load().delete(String(from))
  setChatProposeOnly(to, false)
}
