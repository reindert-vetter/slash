// avatar.mjs — the one shared GitHub-style avatar renderer: an <img> when an
// avatarUrl is known, otherwise a colored initials circle. Extracted from
// src/overview.mjs's reviewerAvatar (the PR-list reviewer avatars) so every
// other place that needs to show "who" (comments, replies, PR-wide items) gets
// the exact same look instead of re-deriving initials/classes locally.
import { html } from './vendor/arrow.js'

// initialsOf mirrors the PR-list's reviewer-avatar fallback: the first two
// characters of the name/login, uppercased. GitHub logins never contain
// spaces, so this is the same simple slice used there.
export function initialsOf(name) {
  const n = (name || '').trim()
  return n ? n.slice(0, 2).toUpperCase() : '?'
}

// me is the authenticated GitHub user (login + avatar), fetched once from the
// read-only /api/me (see handleMe). A comment/reply written in THIS app carries
// no GitHub author of its own — the UI posts the placeholder author "reviewer"
// and no avatar at all — so without this every own message rendered as a bare
// initials circle next to real profile pictures from GitHub-imported ones.
// Deliberately a display-time substitution (identityOf below) instead of a new
// column: it also fixes every own comment/reply ALREADY stored with "reviewer",
// which a write-time fix could only repair through a per-thread backfill Signal.
const me = { login: '', avatarUrl: '' }
let mePromise = null

// ensureMe fetches /api/me at most once per page. Await it before the first
// render that uses identityOf: a late arrival can otherwise never show up,
// because arrow.js reuses a keyed node without re-running its bindings (see
// conventions.md) and `me` is deliberately a plain, non-reactive object.
// Failure (offline, SLASH_GITHUB=off, {ok:false}) leaves `me` empty, which makes
// identityOf a no-op — never an error the caller has to handle.
export function ensureMe() {
  if (!mePromise) {
    mePromise = fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.ok && data.login) {
          me.login = data.login
          me.avatarUrl = data.avatarUrl || ''
        }
      })
      .catch(() => {})
  }
  return mePromise
}

// identityOf resolves who to show for one comment/reply: the local reviewer for
// an own (`source: 'ui'`) message once /api/me is known, otherwise exactly what
// the message itself carries (a GitHub-imported comment, a polled GitHub reply,
// an AI finding). Returns `{name, avatarUrl}` for avatarHTML + the author line,
// so both always name the same person.
export function identityOf(source, author, avatarUrl) {
  if (source === 'ui' && me.login) return { name: me.login, avatarUrl: me.avatarUrl }
  return { name: author, avatarUrl }
}

// ── real names behind a GitHub login ───────────────────────────────────────
// A login ("dennissloove") is not what a reviewer calls a colleague ("Dennis").
// GET /api/names resolves a batch of logins to {name, avatarUrl} — the local
// names.json override first, then the GitHub profile name (see usernames.go) —
// and the result is cached for the page's lifetime here, exactly like `me`
// above. An unresolved login keeps an entry with an empty name so we never ask
// for it twice; displayNameOf then falls back to the bare login.
const names = new Map() // login -> {name, avatarUrl}
const namesPending = new Set() // logins already requested, response not in yet

// NAMES_WAIT_MS bounds how long ensureNames makes its caller wait. The lookup is
// a `gh api graphql` call server-side, so it is normally fast (and cached for
// the server's lifetime) but not guaranteed to be — and this runs on the inbox's
// first paint. Past this deadline the caller renders with whatever is known
// (logins, then), while the response still lands in `names` for the next render
// — the overview re-renders on its own snapshot poll.
const NAMES_WAIT_MS = 1500

// ensureNames resolves every not-yet-known login in ONE request. Await it BEFORE
// pushing the rows that render those names into reactive state: `names` is a
// plain, non-reactive Map, and arrow.js reuses a keyed node without re-running
// its bindings (see conventions.md), so a late arrival can never repaint the row
// that was already mounted. A login that is already in flight is not requested
// again, so overlapping callers never duplicate a lookup.
export function ensureNames(logins) {
  const todo = [...new Set((logins || []).filter((l) => l && !names.has(l) && !namesPending.has(l)))]
  todo.forEach((l) => namesPending.add(l))
  const done = todo.length
    ? fetch('/api/names?logins=' + encodeURIComponent(todo.join(',')))
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
        .then((data) => {
          const got = data && data.ok && data.names ? data.names : {}
          // Cache the misses too (an empty name), so a polling page stops asking.
          for (const login of todo) {
            const u = got[login] || {}
            names.set(login, { name: u.name || '', avatarUrl: u.avatarUrl || '' })
            namesPending.delete(login)
          }
        })
    : Promise.resolve()
  return Promise.race([done, new Promise((resolve) => setTimeout(resolve, NAMES_WAIT_MS))])
}

// fullNameOf is the resolved full name ("Dennis Sloove"), or '' when unknown.
export function fullNameOf(login) {
  const u = names.get(login)
  return (u && u.name) || ''
}

// firstNameOf cuts a full name down to its first whitespace-separated token.
// Casing is left exactly as GitHub/names.json gives it — never forced.
export function firstNameOf(name) {
  return (name || '').trim().split(/\s+/)[0] || ''
}

// displayNameOf is what to show for a login: their first name when known,
// otherwise the login itself, unmodified (no forced capitalisation — an
// invented-looking name is worse than an honest username).
export function displayNameOf(login) {
  return firstNameOf(fullNameOf(login)) || login || ''
}

// avatarUrlOf is the profile picture behind a login, '' when unknown — pass it
// to avatarHTML, which then renders the initials circle instead.
export function avatarUrlOf(login) {
  const u = names.get(login)
  return (u && u.avatarUrl) || ''
}

const FALLBACK_CLS =
  'flex shrink-0 items-center justify-center rounded-full bg-slate-200 dark:bg-zinc-700 text-[10px] font-medium uppercase text-slate-700 dark:text-zinc-200 ring-1 ring-slate-200 dark:ring-zinc-700'

// proxiedAvatarUrl routes an avatar through our own /api/avatar cache instead
// of hitting GitHub's CDN directly on every mount — avatars never change, so
// the server caches the fetched image in memory and answers with a long-lived
// Cache-Control, giving the browser a stable, same-origin URL to cache too
// (see avatar_proxy.go). Not itself validated client-side; the endpoint
// rejects anything that isn't avatars.githubusercontent.com.
function proxiedAvatarUrl(avatarUrl) {
  return '/api/avatar?url=' + encodeURIComponent(avatarUrl)
}

// avatarHTML renders one avatar circle for `name` (the author/login shown as
// the title + the initials fallback), sized by `sizeCls` (default h-6 w-6 —
// the PR-list size). Pass a falsy `avatarUrl` to always get the initials
// circle — a github-imported comment or a polled GitHub reply carries its
// author's `user.avatar_url` through the fetch into the comments read-model
// (see tembed-workflows.md); a comment/reply written in this app carries none
// and gets the local reviewer's own avatar via identityOf above. The stored
// avatar_url covers bot accounts too — a "[bot]" login
// has no github.com/<login>.png shorthand, so the real field is the only
// source. When an avatarUrl IS present the <img> falls
// back to the same initials circle via `onerror`, so an unreachable image
// (e.g. offline/test runs with SLASH_GITHUB=off) never leaves a broken-image
// icon. `extraCls` (default '') is appended to the circle's own class (image
// or fallback) — used by the PR-list's reviewer avatar for its pending
// opacity/grayscale treatment, which is specific to that call site.
export function avatarHTML(name, avatarUrl, sizeCls = 'h-6 w-6', extraCls = '') {
  const initials = initialsOf(name)
  const title = name || 'onbekend'
  if (!avatarUrl) {
    return html`<span class="${FALLBACK_CLS + ' ' + sizeCls + ' ' + extraCls}" title="${title}" data-testid="avatar-fallback">${initials}</span>`
  }
  return html`<span class="${'relative inline-flex shrink-0 ' + sizeCls}" title="${title}" data-testid="avatar">
    <img
      src="${proxiedAvatarUrl(avatarUrl)}"
      alt=""
      loading="lazy"
      class="${sizeCls + ' rounded-full object-cover ring-1 ring-slate-200 dark:ring-zinc-700 ' + extraCls}"
      onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'"
    />
    <span
      class="${'hidden absolute inset-0 ' + FALLBACK_CLS}"
      data-testid="avatar-fallback"
      >${initials}</span
    >
  </span>`
}

// escapeAttr is a minimal HTML-attribute escape for avatarHtmlString below —
// its output is a plain string spliced into a larger plain-string template
// (Block.mjs's paneHTML/rowCellHTML), not an arrow.js html`` template, so
// nothing escapes it automatically the way arrow.js's own template compiler
// would.
function escapeAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// avatarHtmlString is the raw-HTML-STRING sibling of avatarHTML, for a caller
// that builds plain HTML strings instead of arrow.js html`` templates —
// Block.mjs's paneHTML/rowCellHTML assign their result via a `.innerHTML`
// binding rather than mounting an arrow.js template, and avatarHTML's own
// html`` template can't be embedded there (it would stringify to the
// template function itself, e.g. "i=>je(n,i)" — see the "leaks the template
// function as text" pitfall in conventions.md). Same look/behavior (a
// proxied <img> with an initials-circle onerror fallback) as avatarHTML,
// just built with an ordinary template literal and its own attribute
// escaping instead of relying on arrow.js's.
export function avatarHtmlString(name, avatarUrl, sizeCls = 'h-6 w-6', extraCls = '') {
  const initials = escapeAttr(initialsOf(name))
  const title = escapeAttr(name || 'onbekend')
  if (!avatarUrl) {
    return `<span class="${FALLBACK_CLS + ' ' + sizeCls + ' ' + extraCls}" title="${title}" data-testid="avatar-fallback">${initials}</span>`
  }
  return `<span class="relative inline-flex shrink-0 ${sizeCls}" title="${title}" data-testid="avatar"><img src="${escapeAttr(proxiedAvatarUrl(avatarUrl))}" alt="" loading="lazy" class="${sizeCls} rounded-full object-cover ring-1 ring-slate-200 dark:ring-zinc-700 ${extraCls}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" /><span class="hidden absolute inset-0 ${FALLBACK_CLS}" data-testid="avatar-fallback">${initials}</span></span>`
}
