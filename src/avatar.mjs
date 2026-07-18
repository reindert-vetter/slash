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

const FALLBACK_CLS =
  'flex shrink-0 items-center justify-center rounded-full bg-slate-200 dark:bg-zinc-700 text-[10px] font-medium uppercase text-slate-700 dark:text-zinc-200 ring-1 ring-slate-200 dark:ring-zinc-700'

// avatarHTML renders one avatar circle for `name` (the author/login shown as
// the title + the initials fallback), sized by `sizeCls` (default h-6 w-6 —
// the PR-list size). Pass a falsy `avatarUrl` to always get the initials
// circle — comments/replies don't carry an avatar URL today (the GitHub
// comment/reaction fetch only threads the login through, see
// tembed-workflows.md), so every comment avatar renders as initials until a
// later backend change adds it. When an avatarUrl IS present the <img> falls
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
  return html`<span class="relative inline-flex shrink-0 ${sizeCls}" title="${title}" data-testid="avatar">
    <img
      src="${avatarUrl}"
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
