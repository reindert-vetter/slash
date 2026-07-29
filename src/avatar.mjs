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
