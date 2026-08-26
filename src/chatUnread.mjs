// chatUnread.mjs — one shared, per-conversation cache of "does this Claude
// conversation have an answer the reviewer hasn't opened yet" — the durable
// blue-eye indicator behind the "Openstaande chats" index section (see
// openChatComments/chatBlockItem in home.mjs and .claude/docs/claude-chat-panel.md).
//
// A standalone module (like claudeTurns.mjs/commentBatch.mjs), not part of
// RelatedPanel.mjs, for the same reason claudeTurns.mjs is: BlockList.mjs's
// own row (chatUnreadIcon) needs to read it, and RelatedPanel.mjs already
// imports BlockList.mjs (statusInfo/categoryClass/isLocalAiWarning) — a
// reverse import would close a cycle.
//
// Backed by the DURABLE chat_conversations.seen_at column (modules/chat's
// MarkSeen/SeenAt, written via the claude_chat workflow's own "seen" Signal
// action) — unlike claudeTurns.mjs's `answered` flag, which is session-only
// and clears on a refresh, this survives a reload/new tab per explicit
// reviewer request ("dat is iets nieuws en moet je bouwen").
import { reactive } from './vendor/arrow.js'
import { repoParam } from './prContext.mjs'

// byId — undefined = never fetched, boolean once ensureChatUnread's read-only
// GET resolves. Reassigned as a whole object on every update (never mutated
// in place), same pattern as claudeTurns.mjs's own `turns.byId`.
const chatUnread = reactive({ byId: {} })
const fetching = new Set()

// lastAssistantMessageAt — the newest assistant-turn createdAt in `messages`
// (oldest-first, see chat.Module.List), '' if there is none. Compared against
// seenAt to decide "unread": a plain message COUNT would also have to track
// deletions to stay meaningful, a timestamp doesn't (see MarkSeen's own doc
// comment in modules/chat/chat.go).
export function lastAssistantMessageAt(messages) {
  if (!messages) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].createdAt
  }
  return ''
}

// isChatUnread — BlockList.mjs's own read of the cache; `undefined` (never
// fetched yet) reads as "not unread" so a row shows no icon until the fetch
// actually resolves, rather than flashing one speculatively.
export function isChatUnread(c) {
  return !!(c && chatUnread.byId[c.id])
}

// ensureChatUnread lazily fetches c's own transcript+seenAt (the same
// read-only GET RelatedPanel.mjs's loadChatMessages/ensureOtherTaskTitle
// already use) purely to decide unread-ness, exactly once per id until
// invalidated (dropChatUnreadCache below).
export function ensureChatUnread(c) {
  if (!c || chatUnread.byId[c.id] !== undefined || fetching.has(c.id)) return
  fetching.add(c.id)
  fetch('/api/chat?commentId=' + encodeURIComponent(c.id) + repoParam())
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => {
      if (!json) return
      const lastAt = lastAssistantMessageAt(json.messages)
      chatUnread.byId = { ...chatUnread.byId, [c.id]: !!lastAt && lastAt > (json.seenAt || '') }
    })
    .catch(() => {
      // Left unresolved on a failed fetch — no icon meanwhile, and either a
      // later render or the next invalidation tries again.
    })
    .finally(() => fetching.delete(c.id))
}

// setChatUnread lets a caller who already knows the answer (RelatedPanel.mjs,
// right after actually opening a conversation — see loadChatMessages) write
// it directly, skipping a redundant fetch.
export function setChatUnread(id, unread) {
  if (id == null) return
  chatUnread.byId = { ...chatUnread.byId, [id]: !!unread }
}

// dropChatUnreadCache invalidates one conversation's cached entry — called
// from RelatedPanel.mjs's chat.message SSE handler for a FOREIGN conversation
// (the one currently in view marks itself via setChatUnread instead), so the
// next render's ensureChatUnread re-derives it against the fresh transcript.
export function dropChatUnreadCache(id) {
  if (chatUnread.byId[id] === undefined) return
  const next = { ...chatUnread.byId }
  delete next[id]
  chatUnread.byId = next
}

// markChatSeenOnServer sends the durable "seen" Signal (chatActionSeen,
// chat_workflow.go) — fire-and-forget, no busy/error state of its own: it is
// pure bookkeeping, not a reviewer-authored turn, so a dropped/failed POST
// here just means the blue eye reappears next time, same as any other
// best-effort read-model nudge. Run ID is deterministic
// (chatConversationRunID in chat_workflow.go), so no lookup is needed.
export function markChatSeenOnServer(commentId) {
  fetch('/api/workflows/' + encodeURIComponent('chat-' + commentId) + '/signals/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'seen' }),
  }).catch(() => {})
}
