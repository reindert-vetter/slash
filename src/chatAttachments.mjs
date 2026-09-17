// chatAttachments.mjs — images the reviewer pastes or drags into a Claude chat
// composer, on BOTH pages that have such a composer.
//
// Reviewer request, verbatim: "zorg ervoor dat ik ook afbeeldingen in de chat
// kan meegeven. zo kan ik soms een afbeelding vanuit clipboard hebben of een
// afbeelding slepen vanuit finder".
//
// One module, two very different backends behind it — the review tree's
// claude_chat conversation (RelatedPanel.mjs) and the planning page's own
// ticket chat (plan.mjs, the plan tracker's "chat" Kind). That works because
// everything up to the moment of sending is identical: the file is uploaded
// on its own, the reviewer sees a thumbnail while they keep typing, and the
// message that finally goes out carries ids rather than bytes. Only the
// Signal it rides on differs, and that is the caller's own business — see
// takePendingAttachments.
//
// A shared, component-less utility like claudeTurns.mjs/theme.mjs: one
// reactive object plus its own fetches, importing no component, so neither
// page has to import the other's.
//
// The bytes land through POST /api/workflows/chat_attachment — a real
// workflow, because a pasted screenshot is durable state (see
// chat_attachment.go and .claude/rules/workflows-write-boundary.md). This
// module never writes anything else.
import { html, reactive } from './vendor/arrow.js'
import { t } from './i18n.mjs'

// Kept in sync with chat_attachment.go's own constants — the server enforces
// both again, this is only so the reviewer is told BEFORE a pointless 13 MB
// base64 round trip.
const MAX_BYTES = 10 * 1024 * 1024
const MAX_PER_MESSAGE = 5

// byConv holds one entry per conversation the reviewer has attached something
// to: { items: [...], error: '' }. A plain object that is only ever
// REASSIGNED, never mutated in place — that is what re-runs the bindings
// reading it (see .claude/rules/arrowjs-pitfalls.md), exactly like
// claudeTurns.mjs's own byId.
//
// One item is { key, name, status, id, mime, previewUrl }:
//   key        — a local, monotonic id; the ONLY thing the list is keyed on,
//                because an item has no server id while it is still uploading
//                (see the stable-id rule in .claude/rules/conventions.md).
//   status     — 'waiting' | 'uploading' | 'ready' | 'error'
//   id         — the server's content-hash id, once stored
//   previewUrl — a local object URL, so the thumbnail is visible instantly,
//                before the upload has even started.
//
// THE BUCKET IS NOT ALWAYS A CONVERSATION. A brand-new chat ("Chat over deze
// regel") has no conversation at all until the reviewer's first message
// lazily creates its anchor comment (ensureClaudeAnchorForNew,
// RelatedPanel.mjs) — so there is nothing to upload against yet at the moment
// they paste. Such an item is therefore parked as 'waiting' under the
// composer's own draft key, its File kept aside in `fileByKey`, and uploaded
// by takePendingAttachments once the real conversation id finally exists. On
// every other path (an existing conversation, the general chat, the planning
// page) the bucket IS the conversation id and the upload starts immediately.
const att = reactive({ byConv: {} })

// fileByKey holds the raw File of an item that still has to be uploaded.
// Deliberately a plain Map OUTSIDE the reactive object: a File is not data the
// UI renders, and putting one in reactive state would have arrow.js wrap it on
// every read (see the auto-wrap note in .claude/docs/frontend-memory.md).
const fileByKey = new Map()

let nextKey = 0

function entry(convId) {
  return att.byConv[convId] || { items: [], error: '' }
}

function setEntry(convId, next) {
  att.byConv = { ...att.byConv, [convId]: next }
}

// pendingAttachments is what the composer renders and what a send reads.
export function pendingAttachments(convId) {
  return convId ? entry(convId).items : []
}

// attachmentsError is the one reviewer-facing sentence about the LAST refused
// file for this conversation ('' when the last one was fine). Per conversation
// for the same reason claudeTurns.mjs keeps sendError per conversation: the
// reviewer may walk away to another chat before it is read.
export function attachmentsError(convId) {
  return convId ? entry(convId).error : ''
}

// hasUploadingAttachments gates the send: a message must never go out naming
// an id that does not exist yet. A 'waiting' item does NOT gate it — that one
// is uploaded by the send itself, which is exactly what it is waiting for.
export function hasUploadingAttachments(bucket) {
  return pendingAttachments(bucket).some((it) => it.status === 'uploading')
}

// hasPendingAttachments answers "is there anything to send besides text?" —
// what the composer's own Enter/Stuur gate reads.
export function hasPendingAttachments(bucket) {
  return pendingAttachments(bucket).some((it) => it.status === 'ready' || it.status === 'waiting')
}

// attachmentUrl builds the read-only URL of ONE stored attachment. The
// conversation is part of it because that is what scopes the file on disk —
// see chat_attachment.go.
export function attachmentUrl(convId, id) {
  return '/api/chat/attachment?conv=' + encodeURIComponent(convId) + '&id=' + encodeURIComponent(id)
}

// imageFilesFrom pulls the image files out of a paste's clipboardData or a
// drop's dataTransfer. Returns [] for a plain text paste, which is what keeps
// the composer's ordinary Cmd+V untouched.
export function imageFilesFrom(transfer) {
  if (!transfer) return []
  const files = Array.from(transfer.files || [])
  return files.filter((f) => f && typeof f.type === 'string' && f.type.startsWith('image/'))
}

// attachFiles is the one entry point for "the reviewer handed us these files"
// — paste, drop and the paperclip button all funnel through it. Each accepted
// file is shown immediately (status 'uploading') and uploaded on its own, so
// one big screenshot never holds up a small one.
export async function attachFiles(bucket, files, convId = '') {
  if (!bucket) return
  const list = Array.from(files || [])
  if (!list.length) return
  let cur = entry(bucket)
  const accepted = []
  let error = ''
  for (const file of list) {
    if (!file.type || !file.type.startsWith('image/')) {
      error = t('Alleen afbeeldingen kunnen mee — {name} is overgeslagen.', { name: file.name || '?' })
      continue
    }
    if (file.size > MAX_BYTES) {
      error = t('{name} is te groot (max 10 MB).', { name: file.name || 'De afbeelding' })
      continue
    }
    if (cur.items.length + accepted.length >= MAX_PER_MESSAGE) {
      error = t('Maximaal {n} afbeeldingen per bericht.', { n: MAX_PER_MESSAGE })
      break
    }
    nextKey += 1
    const key = 'att' + nextKey
    fileByKey.set(key, file)
    accepted.push({
      key,
      name: file.name || t('afbeelding'),
      status: convId ? 'uploading' : 'waiting',
      id: '',
      mime: file.type,
      previewUrl: URL.createObjectURL(file),
    })
  }
  setEntry(bucket, { items: cur.items.concat(accepted), error })
  if (!convId) return
  await Promise.all(accepted.map((it) => uploadOne(bucket, convId, it)))
}

async function uploadOne(bucket, convId, it) {
  const file = fileByKey.get(it.key)
  if (!file) {
    markItem(bucket, it.key, { status: 'error' }, t('{name} kon niet worden opgeslagen.', { name: it.name }))
    return
  }
  markItem(bucket, it.key, { status: 'uploading' }, '')
  try {
    const data = await fileToBase64(file)
    const res = await fetch('/api/workflows/chat_attachment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: convId, name: it.name, data }),
    })
    if (!res.ok) {
      // The server says WHY in plain Dutch (too big, not an image) — show that
      // rather than a generic sentence. It refuses such a paste with a 400 and
      // leaves no failed run behind; see chatAttachmentRejection
      // (chat_attachment.go).
      const why = await res
        .json()
        .then((b) => (b && b.error) || '')
        .catch(() => '')
      markItem(
        bucket,
        it.key,
        { status: 'error' },
        why
          ? t('{name}: {why}', { name: it.name, why })
          : t('{name} kon niet worden opgeslagen.', { name: it.name }),
      )
      return
    }
    const ref = await res.json()
    if (!ref || !ref.id) {
      markItem(bucket, it.key, { status: 'error' }, t('{name} kon niet worden opgeslagen.', { name: it.name }))
      return
    }
    fileByKey.delete(it.key)
    markItem(bucket, it.key, { status: 'ready', id: ref.id, mime: ref.mime || it.mime }, '')
  } catch (_) {
    markItem(bucket, it.key, { status: 'error' }, t('Geen verbinding met de server — draait slash nog?'))
  }
}

function markItem(bucket, key, patch, error) {
  const cur = entry(bucket)
  const items = cur.items.map((it) => (it.key === key ? { ...it, ...patch } : it))
  setEntry(bucket, { items, error: error || (patch.status === 'error' ? cur.error : '') })
}

// fileToBase64 reads the file as a data URL and hands back only the payload —
// FileReader rather than a manual byte loop, and deliberately base64 rather
// than a multipart upload: the bytes have to reach a workflow's JSON input
// anyway (see chat_attachment.go), so there is nothing to gain from a second
// encoding on the way there.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.onload = () => {
      const url = String(reader.result || '')
      const comma = url.indexOf(',')
      resolve(comma >= 0 ? url.slice(comma + 1) : '')
    }
    reader.readAsDataURL(file)
  })
}

// removePendingAttachment drops one thumbnail again (the × on the chip). The
// uploaded file itself is deliberately left on disk: it is content-addressed,
// so re-attaching the same image costs nothing, and the age-based sweep in the
// cleanup workflow is what eventually reclaims an unused one (see
// sweepChatAttachments).
export function removePendingAttachment(bucket, key) {
  const cur = entry(bucket)
  const gone = cur.items.find((it) => it.key === key)
  if (gone && gone.previewUrl && !gone.previewUrl.startsWith('/')) URL.revokeObjectURL(gone.previewUrl)
  fileByKey.delete(key)
  setEntry(bucket, { items: cur.items.filter((it) => it.key !== key), error: '' })
}

// takePendingAttachments returns the refs to put on the outgoing message —
// {id, name, mime} only — and clears the composer's own list. The caller does
// the sending, because THAT is the part the two pages genuinely differ in: a
// message Signal on the review tree, a plan_answer/plan_hotfix/plan_scope
// Signal on the planning page.
//
// An item that failed to upload is simply left out; one that is still
// uploading cannot occur, because the composer refuses to send while
// hasUploadingAttachments is true.
export async function takePendingAttachments(bucket, convId) {
  if (!bucket || !convId) return []
  // Anything still 'waiting' (pasted before this conversation existed, see the
  // bucket note at the top) is uploaded NOW, against the id that finally
  // exists. Sequentially rather than in parallel: this runs while the reviewer
  // is already waiting on their own send, and a handful of screenshots is not
  // worth five concurrent multi-megabyte POSTs.
  for (const it of entry(bucket).items) {
    if (it.status === 'waiting') await uploadOne(bucket, convId, it)
  }
  const cur = entry(bucket)
  const refs = cur.items
    .filter((it) => it.status === 'ready' && it.id)
    .map((it) => ({ id: it.id, name: it.name, mime: it.mime }))
  for (const it of cur.items) {
    if (it.previewUrl && !it.previewUrl.startsWith('/')) URL.revokeObjectURL(it.previewUrl)
    fileByKey.delete(it.key)
  }
  setEntry(bucket, { items: [], error: '' })
  return refs
}

// restorePendingAttachments puts refs back after a send that never reached the
// server, so the reviewer does not silently lose their screenshots along with
// the failed message. They come back as already-uploaded items (the files ARE
// on disk — only the Signal failed), hence status 'ready' and the server URL
// as the preview.
export function restorePendingAttachments(bucket, convId, refs) {
  if (!bucket || !refs || !refs.length) return
  const cur = entry(bucket)
  const items = refs.map((ref) => {
    nextKey += 1
    return {
      key: 'att' + nextKey,
      name: ref.name || t('afbeelding'),
      status: 'ready',
      id: ref.id,
      mime: ref.mime || '',
      previewUrl: attachmentUrl(convId, ref.id),
    }
  })
  setEntry(bucket, { items: cur.items.concat(items), error: '' })
}

// ---------------------------------------------------------------- rendering

// pendingAttachmentsBar is the row of thumbnails ABOVE the composer: what is
// about to be sent. Rendered as an array-of-one (or an empty array) rather
// than a template↔'' toggle, per the single↔array slot rule in
// .claude/rules/arrowjs-pitfalls.md.
export function pendingAttachmentsBar(bucket, onRemove) {
  const items = pendingAttachments(bucket)
  const error = attachmentsError(bucket)
  if (!items.length && !error) return []
  return [
    html`<div class="flex flex-wrap items-center gap-1.5 pb-1.5" data-testid="chat-attachment-bar">
      ${() =>
        pendingAttachments(bucket).map((it) =>
          html`<span
            class="${'inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-[11px] ' +
            'border-slate-200 bg-slate-50 text-slate-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300'}"
            data-testid="chat-attachment-chip"
          >
            <img
              src="${it.previewUrl}"
              alt="${it.name}"
              class="h-8 w-8 shrink-0 rounded object-cover"
            />
            <span class="max-w-[10rem] truncate">${it.name}</span>
            ${() =>
              // The WORD carries the state, never the colour alone (the
              // reviewer is colourblind): an upload in flight says
              // "uploaden…", a failed one says "mislukt".
              it.status === 'uploading'
                ? html`<span class="shrink-0 italic text-slate-500 dark:text-zinc-400" data-testid="chat-attachment-uploading"
                    >${t('uploaden…')}</span
                  >`
                : it.status === 'error'
                  ? html`<span class="shrink-0 font-medium text-rose-600 dark:text-rose-400" data-testid="chat-attachment-failed"
                      >${t('mislukt')}</span
                    >`
                  : ''}
            <button
              type="button"
              class="shrink-0 rounded px-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
              title="${t('Verwijder deze afbeelding')}"
              data-testid="chat-attachment-remove"
              @click="${(e) => {
                // stopPropagation FIRST, before the state change that
                // unmounts this very chip — see the nested-@click ordering
                // rule in .claude/rules/arrowjs-pitfalls.md.
                if (e) e.stopPropagation()
                removePendingAttachment(bucket, it.key)
                onRemove?.()
              }}"
            >
              ×
            </button>
          </span>`.key('att:' + it.key),
        )}
      <div class="contents">
        ${() =>
          attachmentsError(bucket)
            ? html`<span class="text-[11px] text-rose-600 dark:text-rose-400" data-testid="chat-attachment-error"
                >${attachmentsError(bucket)}</span
              >`
            : ''}
      </div>
    </div>`.key('chat-attachments:' + bucket),
  ]
}

// messageAttachments renders the images of an ALREADY SENT turn, under the
// reviewer's own bubble.
//
// The wrapper carries `markdown-body` and every image `data-md-image` on
// purpose: those two are imageLightbox.mjs's only hooks, so a click opens the
// same fullscreen viewer with the same →/← cycling every other image in the
// app already has — no second implementation, no per-call-site wiring (see
// "Markdown images" in .claude/rules/conventions.md).
export function messageAttachments(msg) {
  const list = (msg && msg.attachments) || []
  const convId = (msg && msg.conversationId) || ''
  if (!list.length || !convId) return ''
  return html`<div class="markdown-body flex flex-wrap gap-1.5 pt-1" data-testid="chat-message-attachments">
    ${() =>
      list.map((a) =>
        html`<img
          src="${attachmentUrl(convId, a.id)}"
          alt="${a.name || ''}"
          title="${a.name || ''}"
          data-md-image="true"
          class="h-24 max-w-[12rem] cursor-zoom-in rounded-lg border border-slate-200 object-cover dark:border-zinc-700"
        />`.key('msgatt:' + a.id),
      )}
  </div>`
}
