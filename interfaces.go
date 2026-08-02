package main

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"slash/modules/callresolve"
	"slash/modules/relations"
)

// This file adds "interface as underlying code" support on top of the
// existing relations/callresolve infrastructure (relations.go /
// callresolve_analysis.go). Two independent, mutually EXCLUSIVE mechanisms
// per interface method:
//
//   A. A concrete, changed block already "claims" the interface method:
//      A1 (resolveCalls rule 3a, callresolve_analysis.go) — a caller whose
//      receiver is explicitly typed as the interface resolves its call
//      straight to the interface's own method declaration, instead of
//      getting lost in the ambiguity once a concrete implementation also
//      defines the same method name; A2 (interfaceImplementationDetector,
//      below) — a "both changed" relations edge when the concrete
//      IMPLEMENTING method changed together with the interface method in
//      this PR (parent = the concrete method, child = the interface method —
//      "interface = onderliggende code van het concrete blok").
//   B. Neither A1 nor A2 claims the interface method (nothing concrete in
//      this PR points at it) → resolveInterfaceImplementations attaches up
//      to MaxInterfaceImplementations concrete implementations of that
//      method — possibly entirely UNCHANGED code — as its own children, so
//      the interface method (which then simply stays a top-level start
//      point, see .claude/docs/detail-layout.md) still shows what
//      implements it.
//
// See .claude/docs/tembed-workflows.md ("Interface methods as underlying
// code").

// MaxInterfaceImplementations caps how many concrete implementations
// resolveInterfaceImplementations attaches to an otherwise-unclaimed
// interface method — enforced HERE, at the source (mirrors code_warning.go's
// warningsPerBlock cap), never as a frontend-side truncation.
const MaxInterfaceImplementations = 2

// implClass is one class in the head worktree that implements a given
// interface (`class X implements ... Y ...`), found by scanClassImplements.
type implClass struct {
	class string // short class name
	file  string // path relative to headDir
}

// reClassImplements matches a class declaration's `implements` clause,
// however far it sits from the `class` keyword (an `extends`/constructor
// promotion in between) and regardless of how many lines it spans — the
// `[^{]` character class can never cross the class's own opening brace, so a
// class WITHOUT an implements clause simply never matches here (no false
// positive bleeding into a later, unrelated class in the same file).
// Multiple interfaces (`implements A, B, C`) are captured together in group 2
// and split by parseImplementsList.
var reClassImplements = regexp.MustCompile(`\bclass\s+([A-Za-z_]\w*)\b[^{]*?\bimplements\s+([^{]+)`)

// parseImplementsList splits an `implements` clause's raw text (as captured
// by reClassImplements) into short interface names.
func parseImplementsList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if name := shortName(strings.TrimSpace(part)); name != "" {
			out = append(out, name)
		}
	}
	return out
}

// scanClassImplements scans one file's source for every `class X implements
// A, B` declaration and returns, per implemented interface's short name, the
// implementing classes' short names — called once per file from
// buildSymbolIndex's existing worktree walk (callresolve_analysis.go), so it
// costs no extra file read.
func scanClassImplements(src []byte) map[string][]string {
	out := map[string][]string{}
	for _, m := range reClassImplements.FindAllStringSubmatch(string(src), -1) {
		class := shortName(m[1])
		for _, iface := range parseImplementsList(m[2]) {
			out[iface] = append(out[iface], class)
		}
	}
	return out
}

// changedInterfaceMethods indexes this PR's changed (new-side) interface
// method blocks by "InterfaceShort::method" — shared by
// interfaceImplementationDetector (A2) and resolveInterfaceImplementations
// (B, via claimedInterfaceMethodIDs's caller).
func changedInterfaceMethods(blocks []Block) map[string]Block {
	out := map[string]Block{}
	for _, b := range blocks {
		if b.Side == SideOld || !b.IsInterface || b.Class == "" || b.Name == "" {
			continue
		}
		out[shortName(b.Class)+"::"+b.Name] = b
	}
	return out
}

// splitInterfaceMethodKey splits a "InterfaceShort::method" key as built by
// changedInterfaceMethods.
func splitInterfaceMethodKey(key string) (iface, method string) {
	parts := strings.SplitN(key, "::", 2)
	if len(parts) != 2 {
		return key, ""
	}
	return parts[0], parts[1]
}

// dedupClasses removes duplicate class short names while preserving the
// (deterministic, worktree-walk) order they were found in.
func dedupClasses(impls []implClass) []string {
	seen := map[string]bool{}
	var out []string
	for _, im := range impls {
		if seen[im.class] {
			continue
		}
		seen[im.class] = true
		out = append(out, im.class)
	}
	return out
}

// interfaceImplementationDetector is the "A2" relations detector: a concrete
// method that implements an interface method AND changed together with it in
// this PR (both sides changed) becomes the PARENT of that interface method
// ("interface = onderliggende code van het concrete blok"). There is no
// single natural match location within either block's own text (unlike e.g.
// a dispatch call), so Line is recorded as 0 — the same graceful degradation
// documented for a testcovers `covered_by` row without a Line (see
// .claude/docs/tembed-workflows.md, "Linking test coverage": it simply
// sorts into groupTier 1 at the frontend instead of being reordered to the
// top of the selected group).
func interfaceImplementationDetector(headDir string, pr int, blocks []Block) []relations.Relation {
	ifaceMethods := changedInterfaceMethods(blocks)
	if len(ifaceMethods) == 0 {
		return nil
	}
	idx := buildSymbolIndex(headDir)
	ix := indexChangedBlocks(blocks)
	var out []relations.Relation
	emit := edgeEmitter(&out, pr, relations.KindInterfaceMethod)
	for key, iface := range ifaceMethods {
		ifaceShort, method := splitInterfaceMethodKey(key)
		for _, class := range dedupClasses(idx.implementors[ifaceShort]) {
			if implBlock, ok := ix.method(class, method); ok {
				emit(implBlock, iface, 0)
			}
		}
	}
	return out
}

// claimedInterfaceMethodIDs returns the block IDs of every interface method
// (of THIS PR) that already has an "A" parent — a both-changed
// interfaceImplementationDetector edge (rels), or ANY resolved/found
// callresolve entry (calls) whose target happens to be that interface
// method, regardless of which resolveCalls rule produced it. B (below) skips
// these — an interface method gets EITHER a concrete parent OR up to
// MaxInterfaceImplementations implementation children of its own, never
// both.
func claimedInterfaceMethodIDs(pr int, rels []relations.Relation, calls []callresolve.Entry) map[string]bool {
	claimed := map[string]bool{}
	for _, r := range rels {
		if r.Kind == relations.KindInterfaceMethod {
			claimed[r.ChildID] = true
		}
	}
	for _, c := range calls {
		if c.Status != callresolve.StatusResolved && c.Status != callresolve.StatusFound {
			continue
		}
		if c.ChildFile == "" || c.ChildMethod == "" {
			continue
		}
		claimed[Block{PR: pr, File: c.ChildFile, Class: c.ChildClass, Name: c.ChildMethod}.ID()] = true
	}
	return claimed
}

// resolveInterfaceImplementations is the "B" callresolve rule: for every
// changed interface method of this PR that claimedIDs does NOT already
// cover, attach up to MaxInterfaceImplementations concrete implementations —
// Go only, no LLM fallback (a purely mechanical `class X implements Y`
// scan). An interface without any indexed implementor, or whose
// implementors don't actually define the method, silently yields nothing
// (mirrors resolveMigrationModels's "unmappable → nothing" precedent), never
// an "unresolved" row.
func resolveInterfaceImplementations(dataDir string, pr int, blocks []Block, claimedIDs map[string]bool) []callresolve.Entry {
	_, headDir := worktreeDirs(dataDir, pr)
	ifaceMethods := changedInterfaceMethods(blocks)
	if len(ifaceMethods) == 0 {
		return nil
	}
	idx := buildSymbolIndex(headDir)
	ix := indexChangedBlocks(blocks)
	cache := newLastModifiedCache(headDir)

	var out []callresolve.Entry
	for key, iface := range ifaceMethods {
		if claimedIDs[iface.ID()] {
			continue
		}
		ifaceShort, method := splitInterfaceMethodKey(key)
		classes := dedupClasses(idx.implementors[ifaceShort])
		if len(classes) == 0 {
			continue
		}
		for _, class := range selectTopImplementations(ix, classes, method, idx, cache) {
			def := methodOnClass(idx, class, method)
			if def == nil {
				continue
			}
			code := enrichedCodeSide(blockSource(headDir, *def))
			callKey := "interface_impl:" + ifaceShort + "::" + method + ":" + class
			out = append(out, callresolve.Entry{
				PR: pr, CallerID: iface.ID(), CallKey: callKey, Status: callresolve.StatusResolved,
				Kind:      callresolve.KindInterfaceImplementation,
				ChildFile: def.File, ChildClass: def.Class, ChildMethod: def.Name,
				ChildLine: code.Start, ChildCode: code.Text,
			})
		}
	}
	return out
}

// selectTopImplementations picks up to MaxInterfaceImplementations of
// classes (candidate implementing classes, in deterministic worktree-walk
// order) that actually define method: implementations that are themselves
// already a block of this PR (ANY changed block of that class, not
// necessarily the method itself — "al ergens in de PR voorkomt") come
// first, in their found order; the remainder is filled up ordered by the
// implementing FILE's last git-commit time, most recent first
// (gitLastCommitTime, cached per file via cache so a file shared by several
// candidates only triggers one `git log` call).
func selectTopImplementations(ix blockIndex, classes []string, method string, idx *symbolIndex, cache *lastModifiedCache) []string {
	var withMethod []implClass
	for _, class := range classes {
		def := methodOnClass(idx, class, method)
		if def == nil {
			continue
		}
		withMethod = append(withMethod, implClass{class: class, file: def.File})
	}
	var inPR, others []implClass
	for _, im := range withMethod {
		if len(ix.byClass[im.class]) > 0 {
			inPR = append(inPR, im)
		} else {
			others = append(others, im)
		}
	}
	sort.SliceStable(others, func(i, j int) bool {
		return cache.timeOf(others[i].file) > cache.timeOf(others[j].file)
	})
	all := append(inPR, others...)
	if len(all) > MaxInterfaceImplementations {
		all = all[:MaxInterfaceImplementations]
	}
	out := make([]string, len(all))
	for i, im := range all {
		out[i] = im.class
	}
	return out
}

// lastModifiedCache memoizes gitLastCommitTime per file within one
// resolveInterfaceImplementations run, so a file shared by several
// candidates (or several interface methods) only triggers one `git log`
// call.
type lastModifiedCache struct {
	dir   string
	cache map[string]int64
}

func newLastModifiedCache(headDir string) *lastModifiedCache {
	return &lastModifiedCache{dir: headDir, cache: map[string]int64{}}
}

func (c *lastModifiedCache) timeOf(file string) int64 {
	if t, ok := c.cache[file]; ok {
		return t
	}
	t := gitLastCommitTime(c.dir, file)
	c.cache[file] = t
	return t
}

// gitLastCommitTime returns the unix-seconds commit time of the last commit
// that touched file within dir (a worktree/checkout), or 0 on any failure
// (no git history for a fixture-only test dir, an unreadable dir, …) — this
// only affects the ordering tie-break among >2 candidate implementations,
// never whether one is found at all.
func gitLastCommitTime(dir, file string) int64 {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := runGitIn(ctx, dir, "log", "-1", "--format=%ct", "--", file)
	if err != nil {
		return 0
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}
	return n
}
