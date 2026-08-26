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
// function to another top-level function DECLARED IN THE SAME FILE, via
// tsscan.go's scanTS. See .claude/docs/workflows-analysis.md, "resolveTSCalls
// (TypeScript, same-file, Go-only)".
//
// Deliberate v1 boundaries, mirroring the "rule-based extras" trio
// (resolveMigrationModels/resolveDataProviders/resolveTranslations):
//   - No cross-file resolution (no import following) — every candidate comes
//     from the caller's OWN file.
//   - No LLM fallback whatsoever. An unresolved/ambiguous call is emitted as
//     NOTHING, never callresolve.StatusUnresolved — so this never triggers
//     the PHP-oriented Haiku/Sonnet search machinery (resolve_call.go) for
//     TypeScript code it was never built to search.
func resolveTSCalls(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	baseDir, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)

	type fileInfo struct {
		src     []byte
		funcs   map[string]Block // name -> its own top-level Block, this file only
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
			funcs := map[string]Block{}
			for _, fb := range scanTSFunctions(string(src), b.File) {
				funcs[fb.Name] = fb
			}
			fi = &fileInfo{src: src, funcs: funcs, changes: changedNewLines(baseDir, headDir, b.File)}
			cache[b.File] = fi
		}
		if fi == nil || len(fi.funcs) == 0 {
			continue
		}
		caller, ok := fi.funcs[b.Name]
		if !ok || b.Class != "" {
			// b.Class != "" would mean a PHP-style class member never
			// produced by scanTS — defensive, never actually happens.
			continue
		}
		changedText := fi.changes.keepChanged(sliceLines(fi.src, caller.Line, caller.EndLine))
		if changedText == "" {
			continue
		}
		callerID := b.ID()
		seen := map[string]bool{}
		for name, def := range fi.funcs {
			if name == b.Name || seen[name] {
				continue
			}
			if !reTSCallName(name).MatchString(changedText) {
				continue
			}
			seen[name] = true
			code := enrichedCodeSide(blockSource(headDir, def))
			out = append(out, callresolve.Entry{
				PR: pr, CallerID: callerID, CallKey: name, Status: callresolve.StatusResolved,
				ChildFile: def.File, ChildClass: "", ChildMethod: def.Name,
				ChildLine: code.Start, ChildCode: code.Text,
			})
		}
	}
	return out
}

// reTSCallName builds the `\bname\s*\(` regex used to detect a call to a
// same-file top-level TS function on the caller's changed lines — deliberately
// the exact same shape home.mjs's findCallSites generic fallback matches a
// bare call key against, so the frontend needs no change to scope the child to
// the right call site.
func reTSCallName(name string) *regexp.Regexp {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(name) + `\s*\(`)
}
