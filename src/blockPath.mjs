// blockPath — the MODULE and LAYER a block lives in, derived straight from its
// file path. A pure utility (like urlState.mjs/theme.mjs), no component.
//
// A path in this repo carries up to three independent, each OPTIONAL pieces of
// meaning, shown as three separate labels in the review tree:
//
//   1. the MODULE — `app/…` or `modules/<Name>/…`. `app` counts as a module
//      name like any other (Reindert), so there is no special case for it;
//   2. the LAYER  — an optional Internal/Shared/Client grouping inside a
//      module;
//   3. the TYPE   — the directory saying what kind of thing this is. That one
//      is `b.category`, derived and STORED on the Go side (classify.go's
//      typeDirCategory).
//
// Two directory styles live side by side in the real repo and both must work:
//
//   modules/Checkouts/Internal/Services/Foo.php   (new: module/layer/type)
//   modules/Payments/Services/Foo.php             (old: module/type)
//   app/Features/PromotionCodesV2Feature.php      (app behaves like a module)
//   config/services.php                           (plain Laravel: type only)
//
// Only the module and the layer are computed here. Doing it in the frontend —
// rather than as two more stored block columns — means no schema migration and
// no re-ingest for an already-ingested PR: the path is already on the block.
//
// PARITY: splitBlockPath in classify.go implements this exact split for the
// category half. Keep the two in step — if they disagree about whether a
// segment is a layer, a block can show a layer pill that Go treated as a type
// directory (and vice versa). See .claude/docs/blocks-and-ingest.md.

// The optional middle layer. Verified against every module in the real repo:
// only these three ever occur as a grouping directory.
const LAYER_DIRS = new Set(['Client', 'Internal', 'Shared'])

// splitBlockPath returns { module, layer } for a repo-relative path; either
// may be ''.
//
// The layer guard is the subtle part. `Client` is genuinely ambiguous here:
// `modules/Checkouts/Client/Services/Foo.php` uses it as a LAYER, while
// `modules/Payments/Client/MollieClient.php` and `app/Client/OrderClient.php`
// hold files directly and use it as a TYPE directory. Requiring at least three
// remaining segments (layer / type / file) tells the two apart from the path
// alone. Don't "simplify" this to a bare name check.
export function splitBlockPath(file) {
  const segs = String(file || '').split('/')
  let module = ''
  if (segs.length > 1 && segs[0] === 'app') {
    module = 'app'
    segs.splice(0, 1)
  } else if (segs.length > 2 && segs[0] === 'modules') {
    module = segs[1]
    segs.splice(0, 2)
  }
  let layer = ''
  if (segs.length >= 3 && LAYER_DIRS.has(segs[0])) {
    layer = segs[0]
    segs.splice(0, 1)
  }
  return { module, layer }
}

// A stable, deterministic colour for a free-form label (a module name), from
// the same Tailwind families the category pills already use. Reindert asked to
// "just start over with the colours" rather than make every new label a
// neutral grey, so the palette simply wraps around.
//
// Per the colourblind rule the WORD carries the meaning and the colour is only
// decoration — two labels landing on the same hue is therefore fine, as long
// as their text differs. Deterministic so one module always looks the same
// across rows, columns and sessions.
const LABEL_PALETTE = [
  'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300',
  'bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-300',
  'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-300',
  'bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300',
  'bg-fuchsia-100 dark:bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300',
  'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300',
  'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300',
  'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300',
  'bg-lime-100 dark:bg-lime-500/20 text-lime-700 dark:text-lime-300',
  'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300',
  'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300',
  'bg-pink-100 dark:bg-pink-500/20 text-pink-700 dark:text-pink-300',
  'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300',
  'bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300',
  'bg-cyan-100 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-300',
  'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-300',
]

export function paletteClass(label) {
  let h = 0
  const s = String(label || '')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return LABEL_PALETTE[h % LABEL_PALETTE.length]
}
