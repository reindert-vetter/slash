package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// blockmove.go detects a block the PR RENAMED or MOVED: the same body
// reappearing under a different symbol, in the same file or in another one.
//
// Without it such a change falls apart into two unrelated entries — a
// "Verwijderd" block for the old symbol and an "added" block for the new one —
// and the reviewer never gets an old-vs-new diff of what actually changed
// inside the body. classify.go can't do this: it pairs old and new blocks on
// symbol() alone, and it runs per FILE (in parallel, one worker per file), so
// it can't see a method that landed in a different file. matchMovedBlocks
// therefore runs ONCE, PR-wide, over the finished block list (parseFiles), and
// is used by both ingest paths (full ingest and the delta refresh).
//
// A detected pair collapses into ONE block: the new one, status "modified",
// carrying the pre-move identity in OldFile/OldClass/OldName/OldLine. The old
// block is dropped. From there everything else follows for free —
// Block.oldPath()/oldSymbol() point /api/code and blockstats at the old
// location, so the reviewer sees a normal old-vs-new diff.
//
// Deliberately deterministic (no AI, no clock, no map iteration driving the
// outcome): it runs inside the ingest Activity, and a re-ingest must produce
// the same blocks — otherwise a block id would move under the comments and
// approvals hanging off it.

const (
	// moveSimilarity is how much of the two bodies must be identical for a
	// removed+added pair to count as one moved block: 2*eq/(old+new) over
	// whitespace-normalized lines. Conservative on purpose — a false pair
	// HIDES a genuinely removed method behind a coincidentally similar new
	// one, which is a worse failure than missing a rename.
	moveSimilarity = 0.75

	// moveMinLines is the smallest body (in compared lines, i.e. blank and
	// brace-only lines already dropped) that may take part in a pair. Without
	// it two unrelated trivial accessors with the same one-line body score a
	// perfect match and get merged.
	moveMinLines = 5

	// moveMaxPairs caps how many real LCS comparisons one PR may cost. The two
	// prefilters below (size bound, multiset bound) already remove nearly
	// every pair in practice; this is the last resort so a PR with hundreds of
	// added AND removed blocks can't turn ingest into an O(n*m*lines^2) crawl.
	// Reaching it means some renames go undetected — never a wrong pair.
	moveMaxPairs = 2000
)

// moveSizeRatio is implied by moveSimilarity, not chosen: with
// sim = 2*eq/(n+m) and eq <= min(n,m), a pair can only reach the threshold when
// max(n,m) <= (2/moveSimilarity - 1) * min(n,m) — 5/3 at 0.75. Anything more
// lopsided is rejected without reading a single line.
var moveSizeRatio = 2/moveSimilarity - 1

// moveCandidate is one removed+added pair that survived the cheap prefilters.
type moveCandidate struct {
	oldIdx, newIdx int
	upper          float64 // multiset upper bound on the real similarity
	score          float64 // the real LCS similarity, filled in later
}

// matchMovedBlocks returns blocks with every detected rename/move collapsed
// into one block. baseDir/headDir are the PR's two worktrees; an unreadable
// worktree simply yields no pairs.
func matchMovedBlocks(blocks []Block, baseDir, headDir string) []Block {
	var oldIdx, newIdx []int
	for i, b := range blocks {
		switch b.Status {
		case StatusRemoved:
			oldIdx = append(oldIdx, i)
		case StatusAdded:
			newIdx = append(newIdx, i)
		}
	}
	if len(oldIdx) == 0 || len(newIdx) == 0 {
		return blocks
	}

	cache := map[string]*moveFile{}
	bodies := map[int][]string{}
	for _, i := range oldIdx {
		bodies[i] = moveBody(cache, baseDir, blocks[i].oldPath(), blocks[i])
	}
	for _, i := range newIdx {
		bodies[i] = moveBody(cache, headDir, blocks[i].File, blocks[i])
	}

	cands := moveCandidates(blocks, oldIdx, newIdx, bodies)
	if len(cands) > moveMaxPairs {
		cands = cands[:moveMaxPairs]
	}

	// The real comparison, only for what survived.
	var scored []moveCandidate
	for _, c := range cands {
		a, b := bodies[c.oldIdx], bodies[c.newIdx]
		eq := 0
		for _, op := range diffLines(a, b) {
			if op.op == "eq" {
				eq++
			}
		}
		c.score = 2 * float64(eq) / float64(len(a)+len(b))
		if c.score >= moveSimilarity {
			scored = append(scored, c)
		}
	}

	// Best match wins, one-to-one. Ties break on block id so the outcome never
	// depends on iteration order.
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		if a, b := blocks[scored[i].oldIdx].ID(), blocks[scored[j].oldIdx].ID(); a != b {
			return a < b
		}
		return blocks[scored[i].newIdx].ID() < blocks[scored[j].newIdx].ID()
	})

	usedOld := map[int]bool{}
	usedNew := map[int]bool{}
	for _, c := range scored {
		if usedOld[c.oldIdx] || usedNew[c.newIdx] {
			continue
		}
		usedOld[c.oldIdx] = true
		usedNew[c.newIdx] = true
		blocks[c.newIdx] = mergeMovedBlock(blocks[c.oldIdx], blocks[c.newIdx])
	}
	if len(usedOld) == 0 {
		return blocks
	}

	out := make([]Block, 0, len(blocks)-len(usedOld))
	for i, b := range blocks {
		if usedOld[i] {
			continue // folded into its new counterpart
		}
		out = append(out, b)
	}
	return out
}

// moveCandidates builds the pairs worth a real LCS comparison, cheapest filter
// first, sorted by their upper bound (best first) so a moveMaxPairs cut keeps
// the most promising ones.
func moveCandidates(blocks []Block, oldIdx, newIdx []int, bodies map[int][]string) []moveCandidate {
	counts := map[int]map[string]int{}
	countOf := func(i int) map[string]int {
		if c, ok := counts[i]; ok {
			return c
		}
		c := map[string]int{}
		for _, l := range bodies[i] {
			c[l]++
		}
		counts[i] = c
		return c
	}

	var cands []moveCandidate
	for _, oi := range oldIdx {
		a := bodies[oi]
		if len(a) < moveMinLines {
			continue
		}
		for _, ni := range newIdx {
			b := bodies[ni]
			if len(b) < moveMinLines {
				continue
			}
			// Size bound — implied by the threshold itself, costs nothing.
			lo, hi := len(a), len(b)
			if lo > hi {
				lo, hi = hi, lo
			}
			if float64(hi) > moveSizeRatio*float64(lo) {
				continue
			}
			// Multiset bound: the number of shared lines, ignoring order, is a
			// hard ceiling on the LCS, so failing it here can never drop a pair
			// that would have passed the real comparison.
			ca, cb := countOf(oi), countOf(ni)
			shared := 0
			for line, n := range ca {
				if m := cb[line]; m > 0 {
					if m < n {
						n = m
					}
					shared += n
				}
			}
			upper := 2 * float64(shared) / float64(len(a)+len(b))
			if upper < moveSimilarity {
				continue
			}
			cands = append(cands, moveCandidate{oldIdx: oi, newIdx: ni, upper: upper})
		}
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].upper != cands[j].upper {
			return cands[i].upper > cands[j].upper
		}
		if a, b := blocks[cands[i].oldIdx].ID(), blocks[cands[j].oldIdx].ID(); a != b {
			return a < b
		}
		return blocks[cands[i].newIdx].ID() < blocks[cands[j].newIdx].ID()
	})
	return cands
}

// mergeMovedBlock folds the removed block ob into its new counterpart nb: nb
// keeps its own (head) identity and gains ob's as the pre-move one, so the old
// diff side is read from where the code really was.
func mergeMovedBlock(ob, nb Block) Block {
	// ob.oldPath(), not ob.File: inside a git-renamed FILE both sides already
	// carry the new path in File and the pre-rename one in OldFile.
	if oldRel := ob.oldPath(); oldRel != nb.File {
		nb.OldFile = oldRel
	} else {
		nb.OldFile = ""
	}
	nb.OldClass = ob.Class
	nb.OldName = ob.Name
	nb.OldLine = ob.Line
	nb.Status = StatusModified
	// Deliberately NOT inherited: ob.FileDeleted. The whole point is that this
	// code did not disappear — it lives at nb's location, in a file that exists.
	return nb
}

// moveFile is one worktree file, read and scanned once — several blocks of the
// same file take part in the matching, and ScanBlocks is the expensive part.
type moveFile struct {
	src    []byte
	blocks []Block
}

// moveBody reads one block's source from a worktree and reduces it to the lines
// the similarity is computed over: whitespace-normalized (like diffLines' own
// wsKey), with blank and brace-only lines dropped so boilerplate can't carry a
// match on its own.
func moveBody(cache map[string]*moveFile, root, rel string, b Block) []string {
	path := filepath.Join(root, rel)
	f, ok := cache[path]
	if !ok {
		f = &moveFile{}
		if src, err := os.ReadFile(path); err == nil {
			f.src = src
			f.blocks = ScanBlocks(src, rel)
		}
		cache[path] = f
	}
	if len(f.src) == 0 {
		return nil
	}
	// Symbol lookup first (exact), line range as the fallback for a block
	// ScanBlocks doesn't surface as its own symbol — same order as blockSource.
	text := ""
	for _, sb := range f.blocks {
		if sb.symbol() == b.symbol() {
			text = sliceLines(f.src, sb.Line, sb.EndLine).Text
			break
		}
	}
	if text == "" {
		text = sliceLines(f.src, b.Line, b.EndLine).Text
	}
	var out []string
	for _, l := range strings.Split(text, "\n") {
		switch k := wsKey(l); k {
		case "", "{", "}", "});", "};", ");":
		default:
			out = append(out, k)
		}
	}
	return out
}
