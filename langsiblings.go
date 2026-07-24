package main

// langsiblings — a read-only helper for the TRANSLATION companion card.
//
// GET /api/langsiblings?pr=N&file=resources/lang/nl/checkout.php
// → {ok:true, siblings:[{locale:"en", file:"resources/lang/en/checkout.php", text:"<head text>"}]}
//
// Read-only: reads the head worktree (like /api/code, blockstats). Lists the
// sibling locale dirs of the given lang file that also contain the same
// basename, excluding the file's own locale and the "vendor" namespace dir.

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

type langSibling struct {
	Locale string `json:"locale"`
	File   string `json:"file"`
	Text   string `json:"text"`
}

// langRootAndLocale splits a lang file path like ".../lang/<locale>/<name>" into
// (langRoot=".../lang", locale, name). ok=false if it doesn't match.
func langRootAndLocale(file string) (langRoot, locale, name string, ok bool) {
	file = filepath.ToSlash(file)
	name = path.Base(file)
	dir := path.Dir(file)    // .../lang/<locale>
	locale = path.Base(dir)  // <locale>
	langRoot = path.Dir(dir) // .../lang
	if locale == "" || path.Base(langRoot) != "lang" {
		return "", "", "", false
	}
	return langRoot, locale, name, true
}

func (s *server) handleLangSiblings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	pr, err := strconv.Atoi(q.Get("pr"))
	if err != nil || pr <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	file := q.Get("file")
	if file == "" || strings.Contains(file, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	langRoot, ownLocale, name, ok := langRootAndLocale(file)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "siblings": []langSibling{}})
		return
	}
	_, headDir := worktreeDirs(s.dataDir, pr)
	full, _, inWorktree := resolveWithinWorktree(headDir, langRoot)
	siblings := []langSibling{}
	if inWorktree {
		entries, _ := os.ReadDir(full)
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			loc := e.Name()
			if loc == ownLocale || loc == "vendor" {
				continue
			}
			rel := path.Join(langRoot, loc, name)
			sibFull, _, sibOK := resolveWithinWorktree(headDir, rel)
			if !sibOK {
				continue
			}
			b, err := os.ReadFile(sibFull)
			if err != nil {
				continue
			}
			siblings = append(siblings, langSibling{Locale: loc, File: rel, Text: string(b)})
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "siblings": siblings})
}
