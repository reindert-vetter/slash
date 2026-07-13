package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"slash/modules/callresolve"
)

// This file is the call-resolution analysis service (package main; it reads the
// head worktree = a side effect, so it is only called from a workflow Activity).
// It statically resolves PHP method calls inside changed blocks to their
// defining method — including methods in files the PR did not change — and
// writes the result (resolved/unresolved) to the callresolve read-model.
//
// It mirrors relations.go: a whole-worktree scan (like providerEventMap) plus
// per-block body scanning (like dispatchedEvents). What it cannot pin becomes an
// "unresolved" row, which the UI offers to the LLM resolve_call workflow.

// symbolIndex is a lookup over every method defined in the head worktree.
type symbolIndex struct {
	byClass    map[string][]Block // class short name → its methods
	byMethod   map[string][]Block // method name → every block defining it
	scopeAlias map[string][]Block // Eloquent scope alias (scopeX → x) → defining blocks
}

var idxSkipDirs = map[string]bool{
	"vendor": true, "node_modules": true, ".git": true,
	"storage": true, "public": true, "tests": true,
}

// buildSymbolIndex walks the head worktree once and indexes every class method.
func buildSymbolIndex(headDir string) *symbolIndex {
	idx := &symbolIndex{
		byClass:    map[string][]Block{},
		byMethod:   map[string][]Block{},
		scopeAlias: map[string][]Block{},
	}
	_ = filepath.WalkDir(headDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if idxSkipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".php") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(headDir, path)
		if err != nil {
			rel = path
		}
		for _, b := range ScanBlocks(src, rel) {
			if b.Class == "" || b.Name == "" {
				continue
			}
			short := shortName(b.Class)
			idx.byClass[short] = append(idx.byClass[short], b)
			idx.byMethod[b.Name] = append(idx.byMethod[b.Name], b)
			if alias := scopeAliasOf(b.Name); alias != "" {
				idx.scopeAlias[alias] = append(idx.scopeAlias[alias], b)
			}
		}
		return nil
	})
	return idx
}

// scopeAliasOf maps an Eloquent scope method (scopeJoinAddress) to the name the
// caller uses (joinAddress); "" if b is not a scope method.
func scopeAliasOf(method string) string {
	if !strings.HasPrefix(method, "scope") || len(method) <= len("scope") {
		return ""
	}
	rest := method[len("scope"):]
	if rest == "" || rest[0] < 'A' || rest[0] > 'Z' {
		return ""
	}
	return strings.ToLower(rest[:1]) + rest[1:]
}

// candidates returns the shortlist of definitions a call key could refer to
// (used by the Go resolver's unique-match rule and, later, as the Haiku
// shortlist). It unions the method-name and scope-alias indexes, deduped by ID.
func (idx *symbolIndex) candidates(callKey string) []Block {
	var out []Block
	seen := map[string]bool{}
	add := func(bs []Block) {
		for _, b := range bs {
			if !seen[b.ID()] {
				seen[b.ID()] = true
				out = append(out, b)
			}
		}
	}
	add(idx.byMethod[callKey])
	add(idx.scopeAlias[callKey])
	return out
}

var (
	reThisCall   = regexp.MustCompile(`\$this->([A-Za-z_]\w*)\s*\(`)
	reSelfCall   = regexp.MustCompile(`(?:self|static)::([A-Za-z_]\w*)\s*\(`)
	reStaticCall = regexp.MustCompile(`([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(`)
	reNewCall    = regexp.MustCompile(`\(new\s+([\\A-Za-z_][\\\w]*)\s*(?:\([^)]*\))?\)->([A-Za-z_]\w*)\s*\(`)
	reArrowCall  = regexp.MustCompile(`->([A-Za-z_]\w*)\s*\(`)
	// reArrowProp matches a bare `->name` property access. Go regexp has no
	// lookahead, so a trailing `(` (i.e. a method call) is filtered out by
	// inspecting the char after the match (see resolveCalls rule 5).
	reArrowProp = regexp.MustCompile(`->([A-Za-z_]\w*)`)
	// reRelationCall recognises an Eloquent relationship method body — a method
	// returning $this->hasMany(...) / morphOne(...) / belongsTo(...) etc. is the
	// definition a magic property like $order->billingAddress resolves to.
	reRelationCall = regexp.MustCompile(`\b(?:hasOne|hasMany|belongsTo|belongsToMany|morphOne|morphMany|morphTo|morphToMany|hasOneThrough|hasManyThrough|morphedByMany)\s*\(`)
)

// resolveCalls scans every changed new-side block's body for method calls and
// resolves each against the worktree symbol index. Returns callresolve entries
// (resolved with the child definition + its source, or unresolved).
func resolveCalls(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	_, headDir := worktreeDirs(dataDir, pr)
	idx := buildSymbolIndex(headDir)

	var out []callresolve.Entry
	for _, b := range blocks {
		if b.Side == SideOld {
			continue
		}
		src := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
		if src.Text == "" {
			continue
		}
		callerID := b.ID()
		seen := map[string]bool{} // call keys already emitted for this caller

		emit := func(key string, def *Block) {
			if key == "" || seen[key] {
				return
			}
			seen[key] = true
			if def == nil {
				out = append(out, callresolve.Entry{
					PR: pr, CallerID: callerID, CallKey: key, Status: callresolve.StatusUnresolved,
				})
				return
			}
			if def.File == b.File && def.symbol() == b.symbol() {
				return // no self-edge
			}
			code := extractBlockSource(filepath.Join(headDir, def.File), def.File, def.Class, def.Name)
			out = append(out, callresolve.Entry{
				PR: pr, CallerID: callerID, CallKey: key, Status: callresolve.StatusResolved,
				ChildFile: def.File, ChildClass: def.Class, ChildMethod: def.Name,
				ChildLine: def.Line, ChildCode: code.Text,
			})
		}

		// 1. $this->m( / self::m( / static::m( → a method on the caller's own class.
		for _, m := range append(reThisCall.FindAllStringSubmatch(src.Text, -1),
			reSelfCall.FindAllStringSubmatch(src.Text, -1)...) {
			if def := methodOnClass(idx, b.Class, m[1]); def != nil {
				emit(m[1], def)
			}
		}
		// 2. (new Foo)->m( → method on Foo.
		for _, m := range reNewCall.FindAllStringSubmatch(src.Text, -1) {
			if def := methodOnClass(idx, shortName(m[1]), m[2]); def != nil {
				emit(m[2], def)
			}
		}
		// 3. Foo::m( → static method on Foo (skip self/static/parent handled above).
		for _, m := range reStaticCall.FindAllStringSubmatch(src.Text, -1) {
			recv := m[1]
			if recv == "self" || recv == "static" || recv == "parent" {
				continue
			}
			if def := methodOnClass(idx, shortName(recv), m[2]); def != nil {
				emit(m[2], def)
			}
		}
		// 4. ->m( with an unknown receiver: resolve only on a unique global /
		// scope match; an ambiguous app method becomes unresolved (LLM territory).
		// Method names not defined anywhere in the app worktree are ignored
		// (framework/builtins live under skipped vendor/).
		for _, m := range reArrowCall.FindAllStringSubmatch(src.Text, -1) {
			key := m[1]
			if seen[key] {
				continue
			}
			cands := idx.candidates(key)
			switch {
			case len(cands) == 1:
				emit(key, &cands[0])
			case len(cands) > 1:
				emit(key, nil) // ambiguous → unresolved
			}
		}
		// 5. ->name (no parens) → an Eloquent magic property. Laravel resolves
		// $order->billingAddress to the relationship method billingAddress() on
		// the model. We only treat it as a call when `name` matches a method whose
		// body *is* a relationship (so plain attribute access like ->id, ->name is
		// ignored): a unique relationship → resolved, several → unresolved (the LLM
		// picks the right model). Runs after rule 4, so a parens call wins the key.
		for _, loc := range reArrowProp.FindAllStringSubmatchIndex(src.Text, -1) {
			rest := src.Text[loc[1]:]
			if strings.HasPrefix(strings.TrimLeft(rest, " \t"), "(") {
				continue // it's a method call, handled by rules 1-4
			}
			key := src.Text[loc[2]:loc[3]]
			if seen[key] {
				continue
			}
			rels := relationshipCandidates(headDir, idx, key)
			switch {
			case len(rels) == 1:
				emit(key, &rels[0])
			case len(rels) > 1:
				emit(key, nil) // ambiguous → unresolved (LLM territory)
			}
		}
	}
	return out
}

// relationshipCandidates narrows idx.candidates(key) to the methods whose body
// is an Eloquent relationship (return $this->hasMany(...) / morphOne(...) / …) —
// the definitions a magic property access ($order->billingAddress) can point to.
// It reads each candidate's body from the head worktree, so it is only called
// from within the resolve activity.
func relationshipCandidates(headDir string, idx *symbolIndex, key string) []Block {
	var out []Block
	for _, c := range idx.candidates(key) {
		if c.Name != key { // scope aliases can't be a magic property
			continue
		}
		src := extractBlockSource(filepath.Join(headDir, c.File), c.File, c.Class, c.Name)
		if src.Text != "" && reRelationCall.MatchString(src.Text) {
			out = append(out, c)
		}
	}
	return out
}

// methodOnClass returns the block defining method on the given class short name,
// or nil if that class/method is not in the index.
func methodOnClass(idx *symbolIndex, class, method string) *Block {
	short := shortName(class)
	for i := range idx.byClass[short] {
		if idx.byClass[short][i].Name == method {
			return &idx.byClass[short][i]
		}
	}
	return nil
}
