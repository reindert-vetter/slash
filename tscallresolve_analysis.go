package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"slash/modules/callresolve"
)

// resolveTSCalls is the TypeScript sibling of resolveCalls (PHP) — deliberately
// much smaller, v1 scope: it links a call INSIDE a changed top-level TS
// function/method to another top-level function OR class method DECLARED IN
// THE SAME FILE, via tsscan.go's scanTS. See
// .claude/docs/workflows-analysis.md, "resolveTSCalls (TypeScript, same-file,
// Go-only)".
//
// Deliberate v1 boundaries, mirroring the "rule-based extras" trio
// (resolveMigrationModels/resolveDataProviders/resolveTranslations):
//   - No cross-file resolution (no import following) — every candidate comes
//     from the caller's OWN file.
//   - No class scoping either: a call matches ANY same-named function/method
//     in the file, top-level or a method of any class — the same loose,
//     name-only precedent this had before class support existed, now simply
//     extended to methods. Two same-named candidates in the same file still
//     resolve to only ONE of them (whichever scanTSFunctions happened to
//     return last for that name) — an existing, accepted limitation, not
//     something this change fixes.
//   - No LLM fallback whatsoever. An unresolved/ambiguous call is emitted as
//     NOTHING, never callresolve.StatusUnresolved — so this never triggers
//     the PHP-oriented Haiku/Sonnet search machinery (resolve_call.go) for
//     TypeScript code it was never built to search.
func resolveTSCalls(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	baseDir, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)

	type fileInfo struct {
		src     []byte
		byName  map[string]Block // name -> its own Block (last-wins on a same-name collision), for loose callee matching
		bySym   map[string]Block // Class::Name (or bare Name) -> Block, for finding the CALLER's own body unambiguously
		changes *fileChangeSet
	}
	cache := map[string]*fileInfo{}

	var out []callresolve.Entry
	for _, b := range blocks {
		if b.Side == SideOld || b.Status == StatusRemoved {
			continue
		}
		if !strings.HasSuffix(b.File, ".ts") {
			continue
		}
		fi, cached := cache[b.File]
		if !cached {
			src, err := os.ReadFile(filepath.Join(headDir, b.File))
			if err != nil {
				cache[b.File] = nil
				continue
			}
			byName := map[string]Block{}
			bySym := map[string]Block{}
			for _, fb := range scanTSFunctions(string(src), b.File) {
				if fb.Name == "" || fb.Name == classHeaderSentinel {
					continue
				}
				byName[fb.Name] = fb
				bySym[fb.symbol()] = fb
			}
			fi = &fileInfo{src: src, byName: byName, bySym: bySym, changes: changedNewLines(baseDir, headDir, b.File)}
			cache[b.File] = fi
		}
		if fi == nil || len(fi.byName) == 0 {
			continue
		}
		caller, ok := fi.bySym[b.symbol()]
		if !ok {
			continue
		}
		changedText := fi.changes.keepChanged(sliceLines(fi.src, caller.Line, caller.EndLine))
		if changedText == "" {
			continue
		}
		callerID := b.ID()
		for name, def := range fi.byName {
			if name == b.Name {
				continue
			}
			if !reTSCallName(name).MatchString(changedText) {
				continue
			}
			code := enrichedCodeSideFor(def.File, blockSource(headDir, def))
			out = append(out, callresolve.Entry{
				PR: pr, CallerID: callerID, CallKey: name, Status: callresolve.StatusResolved,
				ChildFile: def.File, ChildClass: def.Class, ChildMethod: def.Name,
				ChildLine: code.Start, ChildCode: code.Text,
			})
		}
	}
	return out
}

// reTSCallName builds the regex used to detect a call to a same-file TS
// function/method on the caller's changed lines — deliberately the same
// shape home.mjs's findCallSites matches the call key against (its generic
// fallback for a plain name, its own `#name(` branch for a private one), so
// the child scopes to the right call site. Keep the two in sync: before that
// `#` branch existed, findCallSites read a `#name` key as an artisan command
// (non-word character), found no site, and hid every private-method child in
// diff mode.
//
// A private method's name starts with `#` (e.g. `this.#adoptHandedOverIds(`)
// — `#` is a non-word character, so is `.` right before it, and `\b` never
// matches between two non-word characters. A leading `\b` would therefore
// never match a real private-method call site at all; only a plain name
// keeps it (it still guards against matching a stray SUFFIX of a longer
// identifier, e.g. "xfoo(" for name "foo").
func reTSCallName(name string) *regexp.Regexp {
	if strings.HasPrefix(name, "#") {
		return regexp.MustCompile(regexp.QuoteMeta(name) + `\s*\(`)
	}
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\s*\(`)
}
