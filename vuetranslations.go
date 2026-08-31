package main

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"slash/modules/callresolve"
)

// This file resolves Vue-i18n's `$t(...)`/`$tc(...)` calls inside a changed
// `.vue` block to the value they resolve to, per locale — the Vue-side sibling
// of resolveTranslations/emitTranslationChildren (callresolve_analysis.go),
// which does the same for PHP's `trans()`/`__()`/`trans_choice()`/`@lang()`.
// Deliberately its own file, mirroring how tscallresolve_analysis.go keeps the
// TypeScript call-resolution rule separate from the PHP one.
//
// Two structural differences from the PHP rule drive the extra machinery
// below:
//
//  1. A Laravel translation key ENCODES its own file ("file.key" — the first
//     segment names resources/lang/<locale>/<file>.php). A Vue-i18n key does
//     not: `$t('checkouts.show.general.seo.title')` is a plain dot-path into
//     ONE big per-locale JSON blob, and which JSON file that is depends on
//     where the CALLING .vue file lives, not on anything in the key string.
//  2. Each frontend app (resources/admin, resources/checkout, ...) has its own
//     `src/locales/{locale}.json`, and some "domains" inside an app additionally
//     ship their own `locales/{locale}.json` that gets merged into the app's
//     global i18n instance at runtime (`mergeLocaleMessage`, see
//     .claude/docs/workflows-analysis.md). So a key can live in the domain's
//     own file OR the app-wide one. candidateVueLocaleDirs below collects every
//     ancestor "locales"/"lang" directory, nearest first, and
//     emitVueTranslationChildren tries them in that order — nearest wins,
//     falling back outward when the key isn't there.
//
// $t()/$tc() (Vue's global "magic" i18n helpers) are the only forms matched —
// deliberately NOT a bare `t(...)` (the name returned by
// `const { t } = useI18n()`), which is far too common a short identifier/local
// function name to scan for without a large false-positive rate. Out of v1
// scope, same "silently nothing" convention as every rule in
// callresolve_analysis.go.
var (
	// reVueT*/reVueTc* match a Vue-i18n `$t(...)`/`$tc(...)` call with a STATIC,
	// single/double-quoted first argument — see vueTranslationKeysIn. Mirrors
	// reTransSingle/Double's shape (callresolve_analysis.go); RE2 has no
	// backreferences, hence the separate single-/double-quote regexes.
	reVueTSingle  = regexp.MustCompile(`\$t\(\s*'((?:\\.|[^'\\])*)'`)
	reVueTDouble  = regexp.MustCompile(`\$t\(\s*"((?:\\.|[^"\\])*)"`)
	reVueTcSingle = regexp.MustCompile(`\$tc\(\s*'((?:\\.|[^'\\])*)'`)
	reVueTcDouble = regexp.MustCompile(`\$tc\(\s*"((?:\\.|[^"\\])*)"`)

	// reVueLocaleFileName matches a per-locale JSON file's basename, e.g.
	// "en.json" or "nl-NL.json" — see vueLocaleFilesIn.
	reVueLocaleFileName = regexp.MustCompile(`^([a-z]{2}(?:-[A-Za-z]+)?)\.json$`)
)

// vueTranslationKeysIn scans a changed-lines excerpt for every recognized
// `$t(...)`/`$tc(...)` call and returns the captured (unescaped) key strings.
//
// A quoted first argument immediately followed by `+` (string concatenation,
// e.g. `$t('includes.' + this.value)`) is not a fully static key and is
// skipped — mirrors translationKeysIn's own `.`-concatenation guard, just with
// JS's operator instead of PHP's. A template-literal key
// (“ $t(`prefix.${x}`) “) matches neither regex and is silently skipped too.
func vueTranslationKeysIn(scan string) []string {
	var keys []string
	push := func(re *regexp.Regexp, quote byte) {
		for _, m := range re.FindAllStringSubmatchIndex(scan, -1) {
			if strings.HasPrefix(strings.TrimLeft(scan[m[1]:], " \t\r\n"), "+") {
				continue // concatenation follows — key is dynamic, not fully static
			}
			keys = append(keys, unescapePHPQuoted(scan[m[2]:m[3]], quote))
		}
	}
	push(reVueTSingle, '\'')
	push(reVueTDouble, '"')
	push(reVueTcSingle, '\'')
	push(reVueTcDouble, '"')
	return keys
}

// resolveVueTranslations links a `$t('a.b.c')`/`$tc('a.b.c')` call on a
// CHANGED line of a `.vue` block to the corresponding value in every locale
// JSON reachable from that file (see candidateVueLocaleDirs) — the Vue
// counterpart of resolveTranslations. A key whose first argument isn't a
// static quoted literal simply produces no entry; a file with no reachable
// locales directory at all is skipped the same way.
func resolveVueTranslations(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	baseDir, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)
	diffByFile := map[string]*fileChangeSet{}
	targetsByFile := map[string][]vueLocaleTarget{}

	var out []callresolve.Entry
	for _, b := range blocks {
		if b.Side == SideOld || !strings.HasSuffix(b.File, ".vue") {
			continue
		}
		src := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
		if src.Text == "" {
			continue
		}
		fc, ok := diffByFile[b.File]
		if !ok {
			fc = changedNewLines(baseDir, headDir, b.File)
			diffByFile[b.File] = fc
		}
		scan := fc.keepChanged(src)
		if scan == "" {
			continue // the block's change is old-side only (pure deletions)
		}

		targets, cached := targetsByFile[b.File]
		if !cached {
			dirs := candidateVueLocaleDirs(headDir, path.Dir(b.File))
			targets = vueLocaleTargets(headDir, dirs)
			targetsByFile[b.File] = targets
		}
		if len(targets) == 0 {
			continue // no reachable locales/lang directory — out of v1 scope
		}

		callerID := b.ID()
		seen := map[string]bool{} // call keys (translation:<locale>:<key>) already emitted
		for _, key := range vueTranslationKeysIn(scan) {
			out = emitVueTranslationChildren(out, pr, callerID, headDir, key, targets, seen)
		}
	}
	return out
}

// vueLocaleTarget is one locale's ordered list of candidate JSON files for a
// given .vue file — nearest ancestor directory first, see
// candidateVueLocaleDirs/vueLocaleTargets.
type vueLocaleTarget struct {
	locale string
	files  []string // relative paths (forward slashes), nearest directory first
}

// candidateVueLocaleDirs walks from fileDir (a .vue file's own directory,
// relative to headDir, forward slashes) up to the worktree root and returns
// EVERY ancestor directory (nearest first) that has a "locales" or "lang"
// subdirectory containing at least one per-locale JSON file
// (vueLocaleFilesIn) — not just the closest one, because a "domain" locales
// directory (e.g. src/domains/MediaLibrary/locales) is merged into, not a
// replacement for, the app-wide one (src/locales) at runtime. Returning every
// match lets emitVueTranslationChildren try nearest-first and fall back
// outward when a key isn't in the nearer file.
func candidateVueLocaleDirs(headDir, fileDir string) []string {
	var dirs []string
	dir := fileDir
	for {
		for _, name := range [...]string{"locales", "lang"} {
			cand := path.Join(dir, name)
			if len(vueLocaleFilesIn(headDir, cand)) > 0 {
				dirs = append(dirs, cand)
			}
		}
		if dir == "." {
			break
		}
		dir = path.Dir(dir)
	}
	return dirs
}

// vueLocaleFilesIn lists the locale codes present as direct <locale>.json
// files in dirRel (relative to headDir), sorted. Returns nil if the directory
// doesn't exist or has none.
func vueLocaleFilesIn(headDir, dirRel string) []string {
	entries, err := os.ReadDir(filepath.Join(headDir, dirRel))
	if err != nil {
		return nil
	}
	var locales []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if m := reVueLocaleFileName.FindStringSubmatch(e.Name()); m != nil {
			locales = append(locales, m[1])
		}
	}
	sort.Strings(locales)
	return locales
}

// vueLocaleTargets turns candidateVueLocaleDirs' ordered directory list into,
// per locale, the ordered list of files that actually carry that locale — the
// canonical locale SET is taken from the nearest directory (dirs[0]); a
// farther directory only contributes a file for a locale that set already
// names (matches this codebase's convention of every app shipping the same
// locale set everywhere).
func vueLocaleTargets(headDir string, dirs []string) []vueLocaleTarget {
	if len(dirs) == 0 {
		return nil
	}
	locales := vueLocaleFilesIn(headDir, dirs[0])
	targets := make([]vueLocaleTarget, 0, len(locales))
	for _, loc := range locales {
		var files []string
		for _, d := range dirs {
			p := path.Join(d, loc+".json")
			if _, err := os.Stat(filepath.Join(headDir, p)); err == nil {
				files = append(files, p)
			}
		}
		if len(files) == 0 {
			continue
		}
		targets = append(targets, vueLocaleTarget{locale: loc, files: files})
	}
	return targets
}

// emitVueTranslationChildren resolves ONE Vue-i18n key to every locale target
// (nearest-file-first, see vueLocaleTarget) and appends the resulting
// callresolve.Entry rows to out. CallKey/Kind are deliberately IDENTICAL in
// shape to resolveTranslations' own PHP rows (`translation:<locale>:<key>`,
// Kind translation) — the frontend (home.mjs's resolvedCallChildren,
// RelatedPanel.mjs) reads both the same way, so this needs no UI change. A
// key not found in ANY candidate file for a locale still produces a "missing"
// row (ChildLine 1, empty ChildCode) against the nearest file, mirroring
// resolveTranslations' own missing-key convention. Dedup is via seen, shared
// by the caller across every key in one block.
func emitVueTranslationChildren(out []callresolve.Entry, pr int, callerID, headDir, key string, targets []vueLocaleTarget, seen map[string]bool) []callresolve.Entry {
	keyPath := strings.Split(key, ".")
	for _, t := range targets {
		callKey := "translation:" + t.locale + ":" + key
		if seen[callKey] {
			continue
		}
		seen[callKey] = true

		var (
			valueText, usedFile string
			line                int
			found               bool
		)
		for _, f := range t.files {
			fileText, err := os.ReadFile(filepath.Join(headDir, f))
			if err != nil {
				continue
			}
			if vt, ln, ok := sliceJSONKey(string(fileText), keyPath); ok {
				valueText, line, usedFile, found = vt, ln, f, true
				break
			}
		}
		childFile, childLine := t.files[0], 1
		if found {
			childFile, childLine = usedFile, line
		}
		out = append(out, callresolve.Entry{
			PR: pr, CallerID: callerID, CallKey: callKey,
			Status: callresolve.StatusResolved, Kind: callresolve.KindTranslation,
			ChildFile: childFile, ChildClass: t.locale, ChildMethod: "",
			ChildLine: childLine, ChildCode: valueText,
		})
	}
	return out
}

// sliceJSONKey walks a JSON object's nested keys (keyPath, already split on
// ".") and returns the SOURCE TEXT of the value at that path — quotes
// included for a string, or the raw `{...}`/`[...]` text for an
// object/array leaf (e.g. a vue-i18n pluralization array) — plus the 1-based
// line it starts on. Mirrors sliceLangKey's PHP-array counterpart
// (callresolve_analysis.go) both in shape and in NOT restricting the leaf's
// type. found=false when any segment of keyPath is missing, or a
// non-terminal segment isn't itself an object.
func sliceJSONKey(fileText string, keyPath []string) (valueText string, line int, found bool) {
	if len(keyPath) == 0 {
		return "", 0, false
	}
	start := strings.IndexByte(fileText, '{')
	if start < 0 {
		return "", 0, false
	}
	end, ok := matchBracket(fileText, start)
	if !ok {
		return "", 0, false
	}
	vs, ve, ok := findKeyInJSONObjectBody(fileText, start+1, end, keyPath)
	if !ok {
		return "", 0, false
	}
	return fileText[vs:ve], 1 + strings.Count(fileText[:vs], "\n"), true
}

// findKeyInJSONObjectBody scans one JSON object literal's body (the byte
// range strictly between its braces) for `"key": value` entries and, on a
// match for keyPath[0], either returns the value's [start,end) byte range
// (last segment reached) or recurses into it (more segments left — only
// possible when the value is itself a `{...}` object). Mirrors
// findKeyInArrayBody's PHP-array-body scanner, swapped to JSON syntax
// (double-quoted keys only, `:` separator, `{`/`}` nesting).
func findKeyInJSONObjectBody(s string, bodyStart, bodyEnd int, keyPath []string) (valStart, valEnd int, found bool) {
	i := bodyStart
	for i < bodyEnd {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' {
			i++
			continue
		}
		if c != '"' {
			// Not a key start — skip a byte and keep scanning rather than
			// getting stuck (mirrors findKeyInArrayBody's own recovery).
			i++
			continue
		}
		keyEnd, closed := skipQuoted(s, i)
		if !closed {
			return 0, 0, false
		}
		var jsonKey string
		if err := json.Unmarshal([]byte(s[i:keyEnd]), &jsonKey); err != nil {
			i = keyEnd
			continue
		}

		j := skipHorizWS(s, keyEnd, bodyEnd)
		if j >= bodyEnd || s[j] != ':' {
			// Not a "key: value" pair after all — recover past the key.
			i = keyEnd
			continue
		}
		j = skipHorizWS(s, j+1, bodyEnd)
		if j >= bodyEnd {
			return 0, 0, false
		}

		var ve int
		switch s[j] {
		case '"':
			end, closed := skipQuoted(s, j)
			if !closed {
				return 0, 0, false
			}
			ve = end
		case '{', '[':
			end, ok := matchBracket(s, j)
			if !ok {
				return 0, 0, false
			}
			ve = end + 1
		default:
			ve = skipToTopLevelComma(s, j, bodyEnd)
		}

		if jsonKey == keyPath[0] {
			if len(keyPath) == 1 {
				return j, ve, true
			}
			if s[j] == '{' {
				return findKeyInJSONObjectBody(s, j+1, ve-1, keyPath[1:])
			}
			return 0, 0, false // path wants to descend further into a non-object
		}
		i = ve
	}
	return 0, 0, false
}
