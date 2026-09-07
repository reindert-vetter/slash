// lineDiff.mjs — the review tree's own line-alignment engine, extracted so a
// SECOND page can reuse it without importing Block.mjs (which carries the whole
// review-tree card: BlockList, translationDiff, columnWidth, shortcut hints…).
//
// Two pure functions, moved here VERBATIM out of src/Block.mjs (they were
// module-private there; Block.mjs now imports them). `alignRows(oldText,
// newText)` is what the tree's split diff panes are built on, and what
// /plan/<KEY>'s block cards use to show the CURRENT code next to the code a
// plan block proposes (see .claude/docs/plan-page.md).
//
// Nothing here touches the DOM, arrow.js or any state — keep it that way, so
// both call sites can rely on it being a plain (oldText, newText) → rows
// function.

// alignRows turns the old and new source into a list of aligned rows. Each row is
// { left, right, leftMark, rightMark }: `left`/`right` are the line text (or null
// when that side has no line on this row), and the marks ('del'/'ins'/null) drive
// the tint. Unchanged lines pair up; a run of removals is paired line-by-line
// with the following run of additions (so a modified line lines up with its
// replacement), and any overflow becomes one-sided rows.
export function alignRows(oldText, newText) {
  const a = oldText ? oldText.split('\n') : []
  const b = newText ? newText.split('\n') : []
  const ops = diffLines(a, b)

  const rows = []
  let dels = []
  let inss = []
  const flush = () => {
    const n = Math.max(dels.length, inss.length)
    for (let i = 0; i < n; i++) {
      const left = i < dels.length ? dels[i] : null
      const right = i < inss.length ? inss[i] : null
      rows.push({
        left,
        right,
        leftMark: left !== null ? 'del' : null,
        rightMark: right !== null ? 'ins' : null,
      })
    }
    dels = []
    inss = []
  }
  for (const op of ops) {
    if (op.op === 'eq') {
      flush()
      if (op.left === op.right) {
        rows.push({ left: op.left, right: op.right, leftMark: null, rightMark: null })
      } else {
        // Equal but for whitespace: a pure re-indent. Emit it as a paired del/ins
        // row so wsOnly catches it downstream — only the shifted whitespace gets
        // the soft tint, the (unchanged) words are never marked. flush() ran first,
        // so this stays 1:1 aligned and never drifts into the positional pairing.
        rows.push({ left: op.left, right: op.right, leftMark: 'del', rightMark: 'ins' })
      }
    } else if (op.op === 'del') {
      dels.push(op.left)
    } else {
      inss.push(op.right)
    }
  }
  flush()
  return rows
}

// diffLines is a classic LCS line diff: it returns a sequence of ops that turn
// `a` into `b` — { op: 'eq', left, right } for a shared line, { op: 'del', left }
// for a line only in `a`, { op: 'ins', right } for a line only in `b`. Blocks are
// function-sized, so the O(n·m) table is cheap — EXCEPT for a whole-file
// fallback block (a multi-thousand-line locale JSON, see blocks-and-ingest.md):
// there the untrimmed table is tens of millions of cells (measured: 0.8–2.2s
// per file on a 9179-line locale JSON with 7 changed lines). The common
// prefix/suffix trim below cuts the DP down to just the changed middle, which
// makes that first-contact spike ~free for the typical "huge file, tiny diff"
// case, while leaving the op sequence a valid LCS alignment either way. Lines
// are matched whitespace-insensitively (via `key`, à la `git diff -w`): a line
// that only got re-indented still pairs with its counterpart and comes back as
// an `eq` op whose `left`/`right` differ only in whitespace, so alignRows can
// show it as a soft re-alignment instead of drifting into the positional
// del/ins pairing — which is also why the trim compares `key(...)`, not the
// raw lines: a re-indented prefix line must keep trimming (it was an `eq` op
// in the untrimmed DP too).
export function diffLines(a, b) {
  const key = (s) => s.replace(/\s+/g, '')
  const n0 = a.length
  const m0 = b.length
  // Common prefix/suffix (whitespace-insensitive, same equality as the DP).
  let pre = 0
  while (pre < n0 && pre < m0 && key(a[pre]) === key(b[pre])) pre++
  let suf = 0
  while (suf < n0 - pre && suf < m0 - pre && key(a[n0 - 1 - suf]) === key(b[m0 - 1 - suf])) suf++
  const ops = []
  for (let p = 0; p < pre; p++) ops.push({ op: 'eq', left: a[p], right: b[p] })
  // O(n·m) LCS on the trimmed middle only.
  const n = n0 - pre - suf
  const m = m0 - pre - suf
  const ka = []
  const kb = []
  for (let p = 0; p < n; p++) ka.push(key(a[pre + p]))
  for (let p = 0; p < m; p++) kb.push(key(b[pre + p]))
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      ops.push({ op: 'eq', left: a[pre + i], right: b[pre + j] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'del', left: a[pre + i] })
      i++
    } else {
      ops.push({ op: 'ins', right: b[pre + j] })
      j++
    }
  }
  while (i < n) ops.push({ op: 'del', left: a[pre + i++] })
  while (j < m) ops.push({ op: 'ins', right: b[pre + j++] })
  for (let p = suf; p > 0; p--) ops.push({ op: 'eq', left: a[n0 - p], right: b[m0 - p] })
  return ops
}
