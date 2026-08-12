// prContext.mjs — which repo the review-tree page is looking at.
//
// slash reviews more than one repository (see repos.go: the primary repo is the
// EMPTY string, another one is named by its bare repo name in the URL —
// /pr/plug-and-pay-ops/12). Every per-PR API call therefore has to carry a
// `repo=` parameter, and the modules that build those URLs (RelatedPanel.mjs,
// commentBatch.mjs, events.mjs) receive only a bare PR NUMBER from their callers.
//
// Rather than thread a second argument through a dozen internal functions, the
// page sets the repo ONCE at load (home.mjs, from the path) and everyone reads it
// from here. That is safe precisely because it never changes: a page shows one PR
// of one repo for its whole lifetime — the same reason `state.pr` is effectively
// a constant.
//
// Deliberately a plain module variable, not reactive state: nothing re-renders on
// it, it is only ever read while building a request URL.

let repoName = ''

// setPrRepo records the repo NAME from the path ("" = the primary repo). Called
// once, from home.mjs, before any request goes out.
export function setPrRepo(name) {
  repoName = name || ''
}

// prRepo is the repo name ("" for the primary repo).
export function prRepo() {
  return repoName
}

// repoParam is the `&repo=<name>` suffix to append to a per-PR query string, and
// the empty string for the primary repo — so a primary-repo request stays
// byte-identical to what a single-repo build sent.
export function repoParam() {
  return repoName ? '&repo=' + encodeURIComponent(repoName) : ''
}

// repoField is the value to put in a POST body's `repo` key: the repo name, or
// undefined for the primary repo (JSON.stringify drops it, so the body is
// unchanged there).
export function repoField() {
  return repoName || undefined
}
