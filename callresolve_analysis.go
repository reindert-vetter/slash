package main

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
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
	enums      map[string][]Block // enum short name → its declaration block(s)
	commands   map[string]Block   // artisan command name (accounting:import) → its handle method
	facades    map[string]string  // Laravel facade short name → accessor class short name
	models     map[string]Block   // Eloquent model short name (app/Models/) → its whole-class block
	// modelTables maps an explicit `protected $table = 'name'` override (app/Models/)
	// to the model's short class name — the migrationModel rule's primary mapping
	// source (see resolveMigrationModels); the Eloquent naming convention
	// (singularize + Studly) is only its fallback.
	modelTables map[string]string
	// modelCasts maps a model short name → its `$casts` array (field name →
	// cast target class short name) — see resolveCalls rule 5b.
	modelCasts map[string]map[string]string
}

// idxSkipDirs is deliberately narrow: "tests" is NOT skipped, because a
// custom test-base class (tests/TestCase.php, tests/HttpTestCase.php) or a
// shared trait under tests/Concerns/ is real app code a test caller can
// legitimately call ($this->actingAs(...) overridden on the app's own
// TestCase) — skipping it forced every such call to escalate all the way to
// the agentic Sonnet pass (which finds it via Grep) instead of resolving for
// free right here. Indexing it is purely additive: it can only ever add
// candidates, never remove one, so a call that resolved uniquely before
// still does (a rare same-name collision just falls back to the existing
// "ambiguous → unresolved" path, same as any other ambiguity).
var idxSkipDirs = map[string]bool{
	"vendor": true, "node_modules": true, ".git": true,
	"storage": true, "public": true,
}

// buildSymbolIndex walks the head worktree once and indexes every class method.
func buildSymbolIndex(headDir string) *symbolIndex {
	idx := &symbolIndex{
		byClass:     map[string][]Block{},
		byMethod:    map[string][]Block{},
		scopeAlias:  map[string][]Block{},
		enums:       map[string][]Block{},
		commands:    map[string]Block{},
		facades:     map[string]string{},
		models:      map[string]Block{},
		modelTables: map[string]string{},
		modelCasts:  map[string]map[string]string{},
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
		fileBlocks := ScanBlocks(src, rel)
		for _, b := range fileBlocks {
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
		// A Laravel artisan command declares its name in `protected $signature =
		// 'name ...'`; the handle() method of that class is what runs. Index the
		// command name → its handle block so a scheduled `->command('name ...')`
		// call resolves to the command's code.
		for _, name := range scanCommands(src) {
			for _, b := range fileBlocks {
				if b.Name == "handle" {
					idx.commands[name] = b
					break
				}
			}
		}
		// Laravel macros are anonymous closures nested inside a boot method, so
		// ScanBlocks does not surface them; index them separately so a ->name(
		// call resolves to the macro closure like any method.
		for _, b := range scanMacros(src, rel) {
			short := shortName(b.Class)
			idx.byClass[short] = append(idx.byClass[short], b)
			idx.byMethod[b.Name] = append(idx.byMethod[b.Name], b)
		}
		// Enums are declarations, not methods, so ScanBlocks does not surface
		// them; index them separately so a case reference (AddressType::BILLING)
		// resolves to the enum definition.
		for _, b := range scanEnums(src, rel) {
			idx.enums[b.Class] = append(idx.enums[b.Class], b)
		}
		// A Laravel facade (`class X extends Facade` with a getFacadeAccessor
		// returning Y::class) forwards its static calls to Y; index facade →
		// accessor so AccountingClient::providers() resolves to AccountingDriver.
		for f, acc := range scanFacades(src) {
			idx.facades[f] = acc
		}
		// An Eloquent model (app/Models/) is indexed as a whole-class block so a
		// `new Model()`/`Model::` usage can point at the model itself rather than a
		// single method — see scanModels.
		if hasSeg(rel, "app/Models/") {
			// A model's `protected $casts = [...]` array (legacy form) maps a field
			// name to a cast target class (an enum, or another class) — read once
			// per file and attached to every model class it declares (a model file
			// almost always declares exactly one).
			casts := scanModelCasts(src)
			for _, b := range scanModels(src, rel) {
				short := shortName(b.Class)
				idx.models[short] = b
				if casts != nil {
					idx.modelCasts[short] = casts
				}
			}
			// An explicit `protected $table = 'name'` overrides the Eloquent naming
			// convention — record it so resolveMigrationModels's Schema::create/table
			// mapping prefers it over singularize+Studly.
			if tm := reModelTable.FindStringSubmatch(string(src)); tm != nil {
				for _, b := range scanModels(src, rel) {
					idx.modelTables[tm[1]] = shortName(b.Class)
				}
			}
		}
		return nil
	})
	return idx
}

// scanModels finds PHP class declarations in an Eloquent model file and returns
// one synthetic block per class (Class = the class name, Name empty), spanning
// the whole declaration — mirrors scanEnums. blockSource falls back to
// line-slicing for it since ScanBlocks never surfaces a class-level symbol.
func scanModels(src []byte, filename string) []Block {
	s := string(src)
	var out []Block
	for _, loc := range reModelClassDef.FindAllStringSubmatchIndex(s, -1) {
		name := s[loc[2]:loc[3]]
		i := loc[1]
		for i < len(s) && s[i] != '{' {
			i++
		}
		if i >= len(s) {
			continue
		}
		startLine := 1 + strings.Count(s[:loc[0]], "\n")
		bodyLine := 1 + strings.Count(s[:i], "\n")
		endLine, _ := skipBody(s, i, &bodyLine)
		out = append(out, Block{File: filename, Class: name, Line: startLine, EndLine: endLine})
	}
	return out
}

// scanModelCasts extracts an Eloquent model's `protected $casts = [...]` array
// (field name → cast target class short name) — used by resolveCalls rule 5b
// to resolve a magic property backed by an attribute cast ($payment->processor
// cast to an enum, or another class) rather than a relationship (rule 5a/5).
// Only the legacy array-literal form is scanned; a cast to a plain string
// ('date' => 'datetime', no ::class suffix) is deliberately not matched —
// there is no class to point at. The modern Laravel 11 `casts(): array
// { return [...]; }` method form is left for a later pass. Returns nil if the
// file has no $casts array at all (distinct from an empty one, though both are
// treated the same by the caller).
func scanModelCasts(src []byte) map[string]string {
	m := reModelCastsBlock.FindStringSubmatch(string(src))
	if m == nil {
		return nil
	}
	out := map[string]string{}
	for _, e := range reModelCastEntry.FindAllStringSubmatch(m[1], -1) {
		out[e[1]] = shortName(e[2])
	}
	return out
}

// scanEnums finds PHP enum declarations and returns one synthetic block per
// enum (Class = the enum name, Name empty), spanning the whole declaration.
// blockSource falls back to line-slicing for it, like a macro closure.
func scanEnums(src []byte, filename string) []Block {
	s := string(src)
	var out []Block
	for _, loc := range reEnumDef.FindAllStringSubmatchIndex(s, -1) {
		name := s[loc[2]:loc[3]]
		// The header (`: string implements X`) never contains '{'; the first
		// one opens the body.
		i := loc[1]
		for i < len(s) && s[i] != '{' {
			i++
		}
		if i >= len(s) {
			continue
		}
		startLine := 1 + strings.Count(s[:loc[0]], "\n")
		bodyLine := 1 + strings.Count(s[:i], "\n")
		endLine, _ := skipBody(s, i, &bodyLine)
		out = append(out, Block{File: filename, Class: name, Line: startLine, EndLine: endLine})
	}
	return out
}

// scanMacros finds Laravel macro registrations —
// Receiver::macro('name', function (...) {...}) — which ScanBlocks misses because
// they live *inside* a boot method's body (skipBody swallows the whole method) as
// anonymous closures. Each becomes a synthetic block named after the macro and
// classed by the receiver, so a ->name( call resolves to its closure like any
// method. Its source is read via blockSource, which line-slices when a symbol
// lookup can't re-find it.
func scanMacros(src []byte, filename string) []Block {
	s := string(src)
	var out []Block
	for _, loc := range reMacroDef.FindAllStringSubmatchIndex(s, -1) {
		receiver := s[loc[2]:loc[3]]
		name := s[loc[4]:loc[5]]
		// Walk from just past `function` (loc[1]) to the body '{', skipping the
		// parameter list, an optional return type, strings and comments.
		i := loc[1]
		for i < len(s) {
			switch s[i] {
			case '\'':
				if j, _, closed := skipSingleQuote(s, i); closed {
					i = j
					continue
				}
				i = len(s)
			case '"':
				if j, _, closed := skipDoubleQuote(s, i); closed {
					i = j
					continue
				}
				i = len(s)
			case '{', ';':
				// '{' = body opener; ';' = no body (e.g. an fn arrow closure) → bail.
				goto found
			default:
				i++
			}
		}
	found:
		if i >= len(s) || s[i] != '{' {
			continue
		}
		startLine := 1 + strings.Count(s[:loc[0]], "\n")
		bodyLine := 1 + strings.Count(s[:i], "\n")
		endLine, _ := skipBody(s, i, &bodyLine)
		out = append(out, Block{
			File: filename, Class: receiver, Name: name,
			Line: startLine, EndLine: endLine,
		})
	}
	return out
}

// scanCommands finds Laravel artisan command names declared in a file via
// `protected $signature = 'name arg ...'`. The command name is the first
// whitespace-delimited token of the signature (the rest are arguments/options).
// Only $signature is matched (not $name) — it is command-specific, so it never
// mistakes an unrelated class property for a command.
func scanCommands(src []byte) []string {
	var out []string
	for _, m := range reCommandSignature.FindAllStringSubmatch(string(src), -1) {
		if fields := strings.Fields(m[1]); len(fields) > 0 {
			out = append(out, fields[0])
		}
	}
	return out
}

// scanFacades finds Laravel facade classes in a file. A facade is a
// `class X extends Facade` whose getFacadeAccessor() returns Y::class; every
// static call on X (AccountingClient::providers()) actually runs on Y
// (AccountingDriver::providers()), so we map the facade short name → accessor
// short name. Facade files hold one facade + one accessor, so the class and
// accessor matches are paired positionally (falling back to the single accessor
// when counts differ).
func scanFacades(src []byte) map[string]string {
	s := string(src)
	classes := reFacadeClass.FindAllStringSubmatch(s, -1)
	accessors := reFacadeAccessor.FindAllStringSubmatch(s, -1)
	if len(classes) == 0 || len(accessors) == 0 {
		return nil
	}
	out := map[string]string{}
	for i, c := range classes {
		acc := accessors[0]
		if i < len(accessors) {
			acc = accessors[i]
		}
		out[shortName(c[1])] = shortName(acc[1])
	}
	return out
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
	// reNewObj matches a bare object construction `new Foo(` — it couples to the
	// class's constructor (__construct), so e.g. new PluginDisabledNotification(...)
	// shows that notification's definition as underlying code. It also matches the
	// `new Foo(` inside the chained `(new Foo)->m(` form (rule 2); that is fine, the
	// constructor is a distinct child keyed by the class name.
	reNewObj    = regexp.MustCompile(`\bnew\s+([\\A-Za-z_][\\\w]*)\s*\(`)
	reArrowCall = regexp.MustCompile(`->([A-Za-z_]\w*)\s*\(`)
	// reCommandCall matches a scheduled artisan call `->command('name ...')` and
	// captures the whole command string (the name is its first token). Used to
	// resolve $schedule->command('accounting:import ...') to the command's handle.
	reCommandCall = regexp.MustCompile(`->command\(\s*['"]([^'"]+)['"]`)
	// reCommandSignature matches a Laravel command's `protected $signature =
	// 'name ...'` declaration; group 1 is the whole signature string.
	reCommandSignature = regexp.MustCompile(`\$signature\s*=\s*['"]([^'"]+)['"]`)
	// reArrowProp matches a bare `->name` property access. Go regexp has no
	// lookahead, so a trailing `(` (i.e. a method call) is filtered out by
	// inspecting the char after the match (see resolveCalls rule 5).
	reArrowProp = regexp.MustCompile(`->([A-Za-z_]\w*)`)
	// reVarCall / reVarProp capture the receiver variable too ($order->m( /
	// $order->m) — the variable name reveals the class ($order → Order), the
	// same heuristic resolvePrompt teaches the LLM.
	reVarCall = regexp.MustCompile(`\$([A-Za-z_]\w*)->([A-Za-z_]\w*)\s*\(`)
	reVarProp = regexp.MustCompile(`\$([A-Za-z_]\w*)->([A-Za-z_]\w*)`)
	// reRelationCall recognises an Eloquent relationship method body — a method
	// returning $this->hasMany(...) / morphOne(...) / belongsTo(...) etc. is the
	// definition a magic property like $order->billingAddress resolves to.
	reRelationCall = regexp.MustCompile(`\b(?:hasOne|hasMany|belongsTo|belongsToMany|morphOne|morphMany|morphTo|morphToMany|hasOneThrough|hasManyThrough|morphedByMany)\s*\(`)
	// reEnumDef matches a PHP enum declaration line.
	reEnumDef = regexp.MustCompile(`(?m)^\s*enum\s+([A-Za-z_]\w*)`)
	// reModelClassDef matches a PHP class declaration line (used only within
	// app/Models/ files, see scanModels), so a model surfaces as one whole-class
	// block rather than a single method.
	reModelClassDef = regexp.MustCompile(`(?m)^\s*(?:abstract\s+|final\s+)*class\s+([A-Za-z_]\w*)`)
	// reStaticRef matches Foo::name — with or without a call; a trailing `(`
	// (a static call, rule 3's territory) is filtered by inspecting the char
	// after the match, like reArrowProp.
	reStaticRef = regexp.MustCompile(`([A-Za-z_]\w*)::([A-Za-z_]\w*)`)
	// reMacroDef matches a Laravel macro registration —
	// Receiver::macro('name', function ...) — up to the `function` keyword. RE2 has
	// no backreferences, so the two quote chars are matched independently (a mixed
	// pair like 'name" is not valid PHP and never occurs in practice).
	reMacroDef = regexp.MustCompile(`([A-Za-z_]\w*)::macro\(\s*['"]([A-Za-z_]\w*)['"]\s*,\s*(?:static\s+)?function\b`)
	// reFacadeClass matches a Laravel facade declaration `class X extends Facade`
	// (also a namespaced/aliased ...Facade base). reFacadeAccessor captures the
	// accessor class from `getFacadeAccessor() { return Y::class; }` (lazy match
	// bridges the method signature and its return; RE2 supports [\s\S]*?).
	reFacadeClass    = regexp.MustCompile(`class\s+([A-Za-z_]\w*)\s+extends\s+[\\\w]*Facade\b`)
	reFacadeAccessor = regexp.MustCompile(`getFacadeAccessor\b[\s\S]*?return\s+([\\A-Za-z_][\\\w]*)::class`)
	// reModelTable matches an Eloquent model's explicit table override
	// (`protected $table = 'product_groups';`) — see resolveMigrationModels.
	reModelTable = regexp.MustCompile(`\$table\s*=\s*['"]([a-zA-Z0-9_]+)['"]`)
	// reModelCastsBlock matches an Eloquent model's `protected $casts = [...]`
	// array (legacy Laravel <11 form) — see scanModelCasts. Lazy match on the
	// body so a later, unrelated `];` in the same file doesn't get swallowed.
	reModelCastsBlock = regexp.MustCompile(`(?s)\$casts\s*=\s*\[(.*?)\]\s*;`)
	// reModelCastEntry matches one `'field' => Target::class` entry inside a
	// $casts array body — see scanModelCasts.
	reModelCastEntry = regexp.MustCompile(`['"](\w+)['"]\s*=>\s*([\\A-Za-z0-9_]+)::class`)
	// reSchemaTable matches a migration's `Schema::create('table', ...)` or
	// `Schema::table('table', ...)` call — see resolveMigrationModels.
	reSchemaTable = regexp.MustCompile(`Schema::(?:create|table)\(\s*['"]([a-zA-Z0-9_]+)['"]`)
	// reDataProviderAttr matches the modern PHPUnit #[DataProvider('method')]
	// attribute — see resolveDataProviders. Only the plain, single-argument form
	// is matched (the provider is always a method on the test's OWN class);
	// #[DataProviderExternal(Class::class, 'method')] is out of scope.
	reDataProviderAttr = regexp.MustCompile(`#\[\s*DataProvider\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)\s*\]`)
	// reDataProviderDocblock matches the legacy "@dataProvider method" docblock
	// tag — see resolveDataProviders.
	reDataProviderDocblock = regexp.MustCompile(`@dataProvider\s+([A-Za-z0-9_]+)`)

	// reTrans*/reLang* match a Laravel translation helper call with a STATIC,
	// single/double-quoted first argument — see resolveTranslations. RE2 has no
	// backreferences, so the single- and double-quote forms are separate
	// regexes (mirrors reMacroDef's quote handling); a call whose first arg is
	// a variable/concatenation simply matches neither and is silently skipped.
	reTransSingle       = regexp.MustCompile(`\b(?:trans|__)\(\s*'((?:\\.|[^'\\])*)'`)
	reTransDouble       = regexp.MustCompile(`\b(?:trans|__)\(\s*"((?:\\.|[^"\\])*)"`)
	reTransChoiceSingle = regexp.MustCompile(`\btrans_choice\(\s*'((?:\\.|[^'\\])*)'`)
	reTransChoiceDouble = regexp.MustCompile(`\btrans_choice\(\s*"((?:\\.|[^"\\])*)"`)
	reLangSingle        = regexp.MustCompile(`@lang\(\s*'((?:\\.|[^'\\])*)'`)
	reLangDouble        = regexp.MustCompile(`@lang\(\s*"((?:\\.|[^"\\])*)"`)

	// reLangReturn locates a Laravel lang file's top-level `return [ ... ]`
	// array — see sliceLangKey.
	reLangReturn = regexp.MustCompile(`\breturn\s*\[`)
)

// resolveCalls scans every changed new-side block for method calls and resolves
// each against the worktree symbol index. Returns callresolve entries (resolved
// with the child definition + its source, or unresolved). Only the block's
// *changed* lines are scanned (diffed base↔head per file), so a call sitting on
// an untouched line never produces a child — the panel shows underlying code of
// what the PR actually changed.
func resolveCalls(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	baseDir, headDir := worktreeDirs(dataDir, pr)
	idx := buildSymbolIndex(headDir)
	diffByFile := map[string]*fileChangeSet{}

	var out []callresolve.Entry
	for _, b := range blocks {
		if b.Side == SideOld {
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
		callerID := b.ID()
		seen := map[string]bool{} // call keys already emitted for this caller

		// emitKind is emit's underlying implementation with an explicit Kind — used
		// by rule 2c to tag its rows "model_usage" instead of the default
		// "method_call" (see callresolve.Kind*). emit is the plain-call shorthand
		// used by every other rule.
		emitKind := func(key string, def *Block, kind string) {
			if key == "" || seen[key] {
				return
			}
			seen[key] = true
			if def == nil {
				out = append(out, callresolve.Entry{
					PR: pr, CallerID: callerID, CallKey: key, Status: callresolve.StatusUnresolved,
					Kind: kind,
				})
				return
			}
			if def.File == b.File && def.symbol() == b.symbol() {
				return // no self-edge
			}
			code := enrichedCodeSide(blockSource(headDir, *def))
			out = append(out, callresolve.Entry{
				PR: pr, CallerID: callerID, CallKey: key, Status: callresolve.StatusResolved,
				Kind:      kind,
				ChildFile: def.File, ChildClass: def.Class, ChildMethod: def.Name,
				ChildLine: code.Start, ChildCode: code.Text,
			})
		}
		emit := func(key string, def *Block) {
			emitKind(key, def, callresolve.KindMethodCall)
		}

		// 1. $this->m( / self::m( / static::m( → a method on the caller's own class.
		for _, m := range append(reThisCall.FindAllStringSubmatch(scan, -1),
			reSelfCall.FindAllStringSubmatch(scan, -1)...) {
			if def := methodOnClass(idx, b.Class, m[1]); def != nil {
				emit(m[1], def)
			}
		}
		// 2. (new Foo)->m( → method on Foo.
		for _, m := range reNewCall.FindAllStringSubmatch(scan, -1) {
			if def := methodOnClass(idx, shortName(m[1]), m[2]); def != nil {
				emit(m[2], def)
			}
		}
		// 2b. new Foo(...) → the constructor of Foo (its __construct method). The
		// call key is the class short name (not "__construct") so distinct
		// constructions never collapse and the frontend's findCallSites matches
		// `Foo(`. A class with no explicit constructor (no __construct block) is
		// skipped — there is no definition to point at. An Eloquent model
		// (app/Models/) is excluded here — rule 2c below points at the model
		// itself, never its constructor.
		for _, m := range reNewObj.FindAllStringSubmatch(scan, -1) {
			class := shortName(m[1])
			if _, isModel := idx.models[class]; isModel {
				continue
			}
			if def := methodOnClass(idx, class, "__construct"); def != nil {
				emit(class, def)
			}
		}
		// 2c. new Model(...) / Model::... on an Eloquent model (app/Models/) → the
		// model as a whole, not a method: "this model is used here". One deduped
		// child per model class (key = the model's short name, matching the
		// frontend's findCallSites `Foo(`/`Foo::` lookup), regardless of how many
		// times or in how many ways (instantiation, static call) the model is used
		// in this block.
		for _, m := range reNewObj.FindAllStringSubmatch(scan, -1) {
			if def, ok := idx.models[shortName(m[1])]; ok {
				emitKind(shortName(m[1]), &def, callresolve.KindModelUsage)
			}
		}
		for _, m := range reStaticCall.FindAllStringSubmatch(scan, -1) {
			if def, ok := idx.models[shortName(m[1])]; ok {
				emitKind(shortName(m[1]), &def, callresolve.KindModelUsage)
			}
		}
		// 2d. A type-hinted parameter naming an Eloquent model (`Payment $payment`
		// in the signature) surfaces that model as underlying code even when no
		// *line* referencing it changed — a parameter's type is a structural
		// property of the whole (changed) function, not of one particular line
		// (the common case: only the function's body changed, its signature
		// didn't). Deliberately scans the WHOLE block body (src.Text), not
		// scan/changed lines — a narrow, explicit exception to this function's
		// "only changed lines" rule (see the doc comment above), mirroring
		// relations.go's controllerModelDetector (which scans a controller's
		// whole body for the same `Foo $var` pattern) and how
		// resolveMigrationModels/resolveDataProviders below also point at
		// unchanged code. Reuses relations.go's reTypedParam; gated on
		// idx.models so an unrelated parameter type (Request, Collection, ...)
		// never matches — false positives are effectively impossible.
		for _, m := range reTypedParam.FindAllStringSubmatch(src.Text, -1) {
			if def, ok := idx.models[shortName(m[1])]; ok {
				emitKind(shortName(m[1]), &def, callresolve.KindModelUsage)
			}
		}
		// 3. Foo::m( → static method on Foo (skip self/static/parent handled
		// above). An unknown class/method (typically a framework call — vendor is
		// not indexed) becomes unresolved, so the panel still offers the LLM
		// search instead of silently showing nothing.
		for _, m := range reStaticCall.FindAllStringSubmatch(scan, -1) {
			recv := m[1]
			if recv == "self" || recv == "static" || recv == "parent" {
				continue
			}
			def := methodOnClass(idx, shortName(recv), m[2])
			if def == nil {
				// A Laravel facade forwards static calls to its accessor class:
				// AccountingClient::providers() → AccountingDriver::providers().
				if acc, ok := idx.facades[shortName(recv)]; ok {
					def = methodOnClass(idx, acc, m[2])
				}
			}
			emit(m[2], def)
		}
		// 3b. $var->m( → infer the receiver class from the variable name
		// ($order->billingAddress() → Order::billingAddress), the heuristic
		// resolvePrompt teaches the LLM. Runs before the global unique-match
		// rule, so an ambiguous method (billingAddress on several models)
		// still resolves when the receiver names its model. Note: the call
		// key is the bare method name, so two receivers calling the same
		// method in one block collapse into the first match's definition.
		for _, m := range reVarCall.FindAllStringSubmatch(scan, -1) {
			if def := methodOrScopeOnClass(idx, ucfirst(m[1]), m[2]); def != nil {
				emit(m[2], def)
			}
		}
		// 3c. $schedule->command('name ...') → the artisan command's handle method.
		// The call key is the command NAME (accounting:import), not "command", so
		// distinct scheduled commands stay separate children (the frontend matches
		// the string literal in the diff, since a name like accounting:import can
		// never be a method identifier). Mark "command" as seen so the generic
		// arrow-call rule below doesn't also emit a redundant unresolved "command".
		for _, m := range reCommandCall.FindAllStringSubmatch(scan, -1) {
			seen["command"] = true
			fields := strings.Fields(m[1])
			if len(fields) == 0 {
				continue
			}
			name := fields[0]
			if def, ok := idx.commands[name]; ok {
				emit(name, &def)
			} else {
				emit(name, nil) // an unknown (e.g. framework) command → LLM territory
			}
		}
		// 4. ->m( with an unknown receiver: resolve only on a unique global /
		// scope match; an ambiguous app method becomes unresolved (LLM territory).
		// A method name not defined anywhere in the app worktree (framework/
		// builtins live under skipped vendor/) is *also* unresolved: it sits on a
		// changed line, so the reviewer gets the "Zoek" button instead of nothing.
		for _, m := range reArrowCall.FindAllStringSubmatch(scan, -1) {
			key := m[1]
			if seen[key] {
				continue
			}
			cands := idx.candidates(key)
			if len(cands) == 1 {
				emit(key, &cands[0])
			} else {
				emit(key, nil) // ambiguous or unknown → unresolved
			}
		}
		// 5a. $var->name (no parens) → a magic property whose receiver names
		// its model: $order->billingAddress resolves to Order::billingAddress
		// when that method's body is a relationship, even if other models
		// define the same relationship (rule 5 would call that ambiguous).
		for _, loc := range reVarProp.FindAllStringSubmatchIndex(scan, -1) {
			rest := scan[loc[1]:]
			if strings.HasPrefix(strings.TrimLeft(rest, " \t"), "(") {
				continue // a method call, handled by rules 1-4
			}
			recv, key := scan[loc[2]:loc[3]], scan[loc[4]:loc[5]]
			if seen[key] {
				continue
			}
			if def := methodOnClass(idx, ucfirst(recv), key); def != nil && isRelationship(headDir, *def) {
				emit(key, def)
			}
		}
		// 5b. $var->key (no parens) where the receiver's inferred model has a
		// $casts entry for key ($payment->processor, with $payment naming
		// Payment and Payment's $casts mapping 'processor' => Driver::class) →
		// the cast's target class as a whole (an enum, or another model) —
		// Eloquent's *attribute-casting* magic property, distinct from 5a's
		// *relationship* magic property, so no isRelationship check applies
		// here. Runs on the same $var->key matches as 5a (both use scan, not
		// src.Text — the call-site itself sits on a changed line here, unlike
		// rule 2d above, so no changed-lines exception is needed). A cast
		// target named by several same-named enums (e.g. this app has three
		// unrelated "Driver" enums in different modules) is ambiguous and
		// left unresolved — the automatic LLM search then picks the right one
		// using the model's own `use` imports as context.
		for _, loc := range reVarProp.FindAllStringSubmatchIndex(scan, -1) {
			rest := scan[loc[1]:]
			if strings.HasPrefix(strings.TrimLeft(rest, " \t"), "(") {
				continue // a method call, handled by rules 1-4
			}
			recv, key := scan[loc[2]:loc[3]], scan[loc[4]:loc[5]]
			if seen[key] {
				continue
			}
			class, ok := idx.modelCasts[ucfirst(recv)][key]
			if !ok {
				continue // no cast entry for this field — not this rule's territory
			}
			switch enums := idx.enums[class]; {
			case len(enums) == 1:
				emit(key, &enums[0])
			case len(enums) > 1:
				emit(key, nil) // several same-named enums — ambiguous → unresolved
			default:
				if def, ok := idx.models[class]; ok {
					emitKind(key, &def, callresolve.KindModelUsage)
				} else {
					emit(key, nil) // a cast to something we don't index (e.g. a plain Value Object/Castable) — still surfaced, not silent
				}
			}
		}
		// 5. ->name (no parens) → an Eloquent magic property. Laravel resolves
		// $order->billingAddress to the relationship method billingAddress() on
		// the model. We only treat it as a call when `name` matches a method whose
		// body *is* a relationship (so plain attribute access like ->id, ->name is
		// ignored): a unique relationship → resolved, several → unresolved (the LLM
		// picks the right model). Runs after rule 4, so a parens call wins the key.
		for _, loc := range reArrowProp.FindAllStringSubmatchIndex(scan, -1) {
			rest := scan[loc[1]:]
			if strings.HasPrefix(strings.TrimLeft(rest, " \t"), "(") {
				continue // it's a method call, handled by rules 1-4
			}
			key := scan[loc[2]:loc[3]]
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
		// 6. Foo::NAME (no parens) → an enum case (or const) reference, e.g.
		// AddressType::BILLING. Only receivers that are an indexed enum count
		// (a constant on a plain class is ignored); the child is the whole enum
		// declaration. Runs after rule 3, so a static call wins the key.
		for _, loc := range reStaticRef.FindAllStringSubmatchIndex(scan, -1) {
			rest := scan[loc[1]:]
			if strings.HasPrefix(strings.TrimLeft(rest, " \t"), "(") {
				continue // a static call, handled by rule 3
			}
			recv, key := scan[loc[2]:loc[3]], scan[loc[4]:loc[5]]
			if key == "class" || seen[key] {
				continue
			}
			enums := enumCaseCandidates(headDir, idx, recv, key)
			switch {
			case len(enums) == 1:
				e := enums[0]
				seen[key] = true
				code := enrichedCodeSide(blockSource(headDir, e))
				out = append(out, callresolve.Entry{
					PR: pr, CallerID: callerID, CallKey: key, Status: callresolve.StatusResolved,
					ChildFile: e.File, ChildClass: e.Class, ChildMethod: key,
					ChildLine: code.Start, ChildCode: code.Text,
				})
			case len(enums) > 1:
				emit(key, nil) // same case on several enums → unresolved
			}
		}
	}
	return out
}

// resolveMigrationModels links a changed migration's `up` method to the
// Eloquent model(s) it defines/alters — so a reviewer sees the model as
// "Onderliggende code" even when it was NOT itself changed by this PR (the
// common case: a migration adds a column to an already-existing model). This
// is deliberately a callresolve rule, not a both-changed relations detector —
// see .claude/rules/tembed-workflows.md ("migration → model"). Go-only, no LLM
// fallback: a migration whose table can't be mapped to a known model just
// produces no child (silent), never an "unresolved" row.
func resolveMigrationModels(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	_, headDir := worktreeDirs(dataDir, pr)
	idx := buildSymbolIndex(headDir)

	var out []callresolve.Entry
	for _, b := range blocks {
		if b.Side == SideOld || b.Category != "MIGRATION" || b.Name != "up" {
			continue
		}
		src := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
		if src.Text == "" {
			continue
		}
		callerID := b.ID()
		seenTable := map[string]bool{}
		for _, m := range reSchemaTable.FindAllStringSubmatch(src.Text, -1) {
			table := m[1]
			if seenTable[table] {
				continue
			}
			seenTable[table] = true

			class, ok := idx.modelTables[table]
			if !ok {
				class = studly(singularizeTable(table))
			}
			def, ok := idx.models[class]
			if !ok {
				continue // no known model for this table — stay silent, no LLM
			}
			code := enrichedCodeSide(blockSource(headDir, def))
			out = append(out, callresolve.Entry{
				PR: pr, CallerID: callerID, CallKey: "migration_model:" + table,
				Status: callresolve.StatusResolved, Kind: callresolve.KindMigrationModel,
				ChildFile: def.File, ChildClass: def.Class, ChildMethod: "",
				ChildLine: code.Start, ChildCode: code.Text,
			})
		}
	}
	return out
}

// resolveDataProviders links a changed PHPUnit test method to the data
// provider method its #[DataProvider('name')] attribute (or the legacy
// "@dataProvider name" docblock tag) names — so the provider shows up as
// "Onderliggende code" even when it is NOT itself changed by this PR (the
// common case: an existing provider feeding a newly added/changed test). This
// is deliberately a callresolve rule, not a both-changed relations detector
// (mirrors resolveMigrationModels) — see .claude/rules/tembed-workflows.md,
// "PHPUnit data providers". Fully deterministic, no LLM fallback: PHPUnit's
// plain #[DataProvider(...)]/@dataProvider always names a method on the
// test's OWN class (no ambiguity to resolve), so a name that doesn't match a
// method there just produces no child (silent), never an "unresolved" row.
//
// It reuses methodZone (testcovers_analysis.go) to read the attribute/
// docblock text directly above (and, since phpscan.go folds a leading
// #[...] attribute into its own block, now partly INSIDE) the test method's
// own span — see funcDeclLine/methodZone's doc comments and
// .claude/rules/blocks-and-ingest.md.
func resolveDataProviders(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	_, headDir := worktreeDirs(dataDir, pr)
	idx := buildSymbolIndex(headDir)

	type fileInfo struct {
		lines      []string
		fileBlocks []Block
	}
	cache := map[string]*fileInfo{}

	var out []callresolve.Entry
	for _, b := range blocks {
		if b.Side == SideOld || b.Category != "TEST" {
			continue
		}
		fi, cached := cache[b.File]
		if !cached {
			src, err := os.ReadFile(filepath.Join(headDir, b.File))
			if err != nil {
				cache[b.File] = nil
				continue
			}
			fi = &fileInfo{lines: strings.Split(string(src), "\n"), fileBlocks: ScanBlocks(src, b.File)}
			cache[b.File] = fi
		}
		if fi == nil {
			continue
		}
		zone, _, _ := methodZone(fi.lines, fi.fileBlocks, b)
		if zone == "" {
			continue
		}

		callerID := b.ID()
		seen := map[string]bool{}
		matches := append(reDataProviderAttr.FindAllStringSubmatch(zone, -1),
			reDataProviderDocblock.FindAllStringSubmatch(zone, -1)...)
		for _, m := range matches {
			name := m[1]
			if seen[name] {
				continue
			}
			seen[name] = true
			def := methodOnClass(idx, b.Class, name)
			if def == nil {
				continue // typo'd or external provider — stay silent, no LLM
			}
			if def.File == b.File && def.symbol() == b.symbol() {
				continue // no self-edge
			}
			code := enrichedCodeSide(blockSource(headDir, *def))
			out = append(out, callresolve.Entry{
				PR: pr, CallerID: callerID, CallKey: "data_provider:" + name,
				Status: callresolve.StatusResolved, Kind: callresolve.KindDataProvider,
				ChildFile: def.File, ChildClass: def.Class, ChildMethod: def.Name,
				ChildLine: code.Start, ChildCode: code.Text,
			})
		}
	}
	return out
}

// langLocaleFile is one locale's copy of a lang file (`resources/lang/<locale>/
// <fileSeg>.php`), found by resolveTranslations for a given key's fileSeg.
type langLocaleFile struct {
	locale string // e.g. "nl", "en"
	file   string // relative path (forward slashes), e.g. "resources/lang/nl/checkout.php"
}

// resolveTranslations links a `trans('file.key')` / `__('file.key')` /
// `trans_choice('file.key', ...)` / `@lang('file.key')` call on a CHANGED line
// to the corresponding value in EVERY locale's lang file — so a reviewer sees
// what a translation key actually resolves to, per language, even though the
// lang files themselves are (almost always) unchanged by this PR. Deliberately
// a callresolve rule (points at unchanged files), Go-only, no LLM fallback: a
// key whose first argument isn't a static quoted literal, that names a
// vendor/package translation (contains "::"), or that has no "file.key" form
// (a bare whole-file reference) simply produces no entry — never an
// "unresolved" row, mirroring resolveMigrationModels/resolveDataProviders.
//
// A key that's missing in a given locale's file still produces an entry (so
// the reviewer sees "missing in <locale>" instead of nothing) — with an empty
// ChildCode and ChildLine 1.
func resolveTranslations(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	baseDir, headDir := worktreeDirs(dataDir, pr)
	diffByFile := map[string]*fileChangeSet{}
	langCache := map[string][]langLocaleFile{} // fileSeg → locales that have <fileSeg>.php

	var out []callresolve.Entry
	for _, b := range blocks {
		if b.Side == SideOld {
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

		callerID := b.ID()
		seen := map[string]bool{} // call keys (translation:<locale>:<key>) already emitted

		for _, key := range translationKeysIn(scan) {
			if strings.Contains(key, "::") {
				continue // vendor/namespaced package translation — out of v1 scope
			}
			dot := strings.Index(key, ".")
			if dot < 0 {
				continue // whole-file reference (no key) — out of v1 scope
			}
			fileSeg := key[:dot]
			keyPath := strings.Split(key[dot+1:], ".")

			locales, cached := langCache[fileSeg]
			if !cached {
				locales = localesForLangFile(headDir, fileSeg)
				langCache[fileSeg] = locales
			}
			for _, loc := range locales {
				callKey := "translation:" + loc.locale + ":" + key
				if seen[callKey] {
					continue
				}
				seen[callKey] = true

				fileText, err := os.ReadFile(filepath.Join(headDir, loc.file))
				if err != nil {
					continue
				}
				valueText, line, found := sliceLangKey(string(fileText), keyPath)
				childLine := 1
				if found {
					childLine = line
				}
				out = append(out, callresolve.Entry{
					PR: pr, CallerID: callerID, CallKey: callKey,
					Status: callresolve.StatusResolved, Kind: callresolve.KindTranslation,
					ChildFile: loc.file, ChildClass: loc.locale, ChildMethod: "",
					ChildLine: childLine, ChildCode: valueText,
				})
			}
		}
	}
	return out
}

// translationKeysIn scans a changed-lines excerpt for every recognized
// translation-helper call and returns the captured (unescaped) key strings.
func translationKeysIn(scan string) []string {
	var keys []string
	push := func(re *regexp.Regexp, quote byte) {
		for _, m := range re.FindAllStringSubmatch(scan, -1) {
			keys = append(keys, unescapePHPQuoted(m[1], quote))
		}
	}
	push(reTransSingle, '\'')
	push(reTransDouble, '"')
	push(reTransChoiceSingle, '\'')
	push(reTransChoiceDouble, '"')
	push(reLangSingle, '\'')
	push(reLangDouble, '"')
	return keys
}

// unescapePHPQuoted undoes the two escapes that matter inside a PHP
// single/double-quoted literal for our purposes: \<quote> → <quote> and
// \\ → \. Anything else is left as-is (translation keys are plain identifiers
// in practice).
func unescapePHPQuoted(s string, quote byte) string {
	if !strings.ContainsRune(s, '\\') {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) && (s[i+1] == quote || s[i+1] == '\\') {
			b.WriteByte(s[i+1])
			i++
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// localesForLangFile finds the lang root (resources/lang, else lang) under
// headDir and lists every immediate locale subdirectory that contains
// <fileSeg>.php, sorted for determinism.
func localesForLangFile(headDir, fileSeg string) []langLocaleFile {
	root := langRoot(headDir)
	if root == "" {
		return nil
	}
	entries, err := os.ReadDir(filepath.Join(headDir, root))
	if err != nil {
		return nil
	}
	var locales []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(headDir, root, e.Name(), fileSeg+".php")); err == nil {
			locales = append(locales, e.Name())
		}
	}
	sort.Strings(locales)
	out := make([]langLocaleFile, 0, len(locales))
	for _, loc := range locales {
		out = append(out, langLocaleFile{locale: loc, file: root + "/" + loc + "/" + fileSeg + ".php"})
	}
	return out
}

// langRoot reports the Laravel lang directory relative to headDir:
// "resources/lang" if present, else the older top-level "lang", else "".
func langRoot(headDir string) string {
	if isDir(filepath.Join(headDir, "resources/lang")) {
		return "resources/lang"
	}
	if isDir(filepath.Join(headDir, "lang")) {
		return "lang"
	}
	return ""
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// sliceLangKey walks a Laravel lang file's top-level `return [ ... ]` array
// and returns the SOURCE TEXT of the value at keyPath — a quoted scalar like
// 'Hello' when keyPath's last segment is reached, or a balanced `[ ... ]`
// sub-array's text when it still has to descend — plus the 1-based line the
// value starts on. found=false when the array itself, or any segment of
// keyPath, cannot be located (missing key, or a scalar value that keyPath
// tries to descend into further).
func sliceLangKey(fileText string, keyPath []string) (valueText string, line int, found bool) {
	if len(keyPath) == 0 {
		return "", 0, false
	}
	loc := reLangReturn.FindStringIndex(fileText)
	if loc == nil {
		return "", 0, false
	}
	openIdx := loc[1] - 1 // index of the '['
	closeIdx, ok := matchBracket(fileText, openIdx)
	if !ok {
		return "", 0, false
	}
	vs, ve, ok := findKeyInArrayBody(fileText, openIdx+1, closeIdx, keyPath)
	if !ok {
		return "", 0, false
	}
	return fileText[vs:ve], 1 + strings.Count(fileText[:vs], "\n"), true
}

// findKeyInArrayBody scans one array literal's body (the byte range strictly
// between its brackets, i.e. NOT including '[' / ']' themselves) for
// `'key' => value` entries (single- or double-quoted key) and, on a match for
// keyPath[0], either returns the value's [start,end) byte range (last
// segment reached) or recurses into it (more segments left — only possible
// when the value is itself a `[ ... ]` array).
func findKeyInArrayBody(s string, bodyStart, bodyEnd int, keyPath []string) (valStart, valEnd int, found bool) {
	i := bodyStart
	for i < bodyEnd {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' {
			i++
			continue
		}
		if c != '\'' && c != '"' {
			// Not a key start (e.g. a stray comment) — skip a byte and keep
			// scanning rather than getting stuck.
			i++
			continue
		}
		keyEnd, closed := skipQuoted(s, i)
		if !closed {
			return 0, 0, false
		}
		key := unescapePHPQuoted(s[i+1:keyEnd-1], s[i])

		j := skipHorizWS(s, keyEnd, bodyEnd)
		if j+1 >= bodyEnd || s[j] != '=' || s[j+1] != '>' {
			// Not a "key => value" pair after all — recover by moving past the
			// key and continuing the scan.
			i = keyEnd
			continue
		}
		j = skipHorizWS(s, j+2, bodyEnd)
		if j >= bodyEnd {
			return 0, 0, false
		}

		var ve int
		switch s[j] {
		case '\'', '"':
			end, closed := skipQuoted(s, j)
			if !closed {
				return 0, 0, false
			}
			ve = end
		case '[':
			end, ok := matchBracket(s, j)
			if !ok {
				return 0, 0, false
			}
			ve = end + 1
		default:
			ve = skipToTopLevelComma(s, j, bodyEnd)
		}

		if key == keyPath[0] {
			if len(keyPath) == 1 {
				return j, ve, true
			}
			if s[j] == '[' {
				return findKeyInArrayBody(s, j+1, ve-1, keyPath[1:])
			}
			return 0, 0, false // path wants to descend further into a scalar
		}
		i = ve
	}
	return 0, 0, false
}

// skipHorizWS skips ordinary whitespace (space/tab/newline/CR) from i, capped
// at limit.
func skipHorizWS(s string, i, limit int) int {
	for i < limit {
		switch s[i] {
		case ' ', '\t', '\n', '\r':
			i++
		default:
			return i
		}
	}
	return i
}

// skipToTopLevelComma scans forward from i (the start of a bare, unquoted,
// non-array value — e.g. true/false/a number/a constant) to the next comma at
// bracket depth 0, or limit if none. Quote- and bracket-aware so a nested
// structure is never mistaken for the entry separator.
func skipToTopLevelComma(s string, i, limit int) int {
	depth := 0
	for i < limit {
		switch s[i] {
		case '\'', '"':
			end, closed := skipQuoted(s, i)
			if !closed {
				return limit
			}
			i = end
			continue
		case '(', '[', '{':
			depth++
		case ')', ']', '}':
			depth--
		case ',':
			if depth == 0 {
				return i
			}
		}
		i++
	}
	return limit
}

// singularizeTable is a pragmatic (English, non-exhaustive) singularizer for a
// snake_case table name — the fallback mapping source when a model has no
// explicit `$table` override. Deliberately not a full inflector: it covers the
// common Laravel table-naming patterns ("-ies" → "-y", trailing "-s" dropped),
// not every irregular English plural.
func singularizeTable(table string) string {
	if strings.HasSuffix(table, "ies") && len(table) > 3 {
		return table[:len(table)-3] + "y"
	}
	if strings.HasSuffix(table, "s") && !strings.HasSuffix(table, "ss") {
		return table[:len(table)-1]
	}
	return table
}

// studly converts a snake_case name to StudlyCase (Laravel's naming
// convention for a model class derived from its table).
func studly(s string) string {
	parts := strings.Split(s, "_")
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, "")
}

// enumCaseCandidates returns the enums named recv that actually define case (or
// const) key — the definitions a reference like AddressType::BILLING points to.
func enumCaseCandidates(headDir string, idx *symbolIndex, recv, key string) []Block {
	var out []Block
	re := regexp.MustCompile(`\b(?:case|const)\s+` + key + `\b`)
	for _, e := range idx.enums[shortName(recv)] {
		if re.MatchString(blockSource(headDir, e).Text) {
			out = append(out, e)
		}
	}
	return out
}

// fileChangeSet is the head-side changed lines of one file; restrict=false means
// "treat every line as changed" (added file, missing base worktree, git error).
type fileChangeSet struct {
	set      lineSet
	restrict bool
}

// keepChanged filters a block's source down to its changed lines (joined by
// newlines), so the call-scan regexes only ever see code the PR touched.
func (fc *fileChangeSet) keepChanged(src codeSide) string {
	if !fc.restrict {
		return src.Text
	}
	var kept []string
	for i, line := range strings.Split(src.Text, "\n") {
		if fc.set[src.Start+i] {
			kept = append(kept, line)
		}
	}
	return strings.Join(kept, "\n")
}

// changedNewLines diffs the base and head worktree copies of file (git
// --no-index, so no repo needed) and returns the head-side changed line
// numbers. It reuses the ingest diff parser, so "changed" means exactly what
// classified the block as modified.
func changedNewLines(baseDir, headDir, file string) *fileChangeSet {
	basePath := filepath.Join(baseDir, file)
	if _, err := os.Stat(basePath); err != nil {
		return &fileChangeSet{} // added file (or no base worktree) → all lines
	}
	raw, err := exec.Command("git", "diff", "--no-color", "--unified=0", "--no-index", "--",
		basePath, filepath.Join(headDir, file)).Output()
	if err != nil {
		// git exits 1 when the files differ — the expected success case.
		if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 1 {
			return &fileChangeSet{}
		}
	}
	// parseUnifiedDiff keys by path; with --no-index the old and new path are
	// both absolute (and different), so union every entry's new-side set.
	set := lineSet{}
	for _, fd := range parseUnifiedDiff(string(raw)) {
		for ln := range fd.changedNew {
			set[ln] = true
		}
	}
	return &fileChangeSet{set: set, restrict: true}
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
		if isRelationship(headDir, c) {
			out = append(out, c)
		}
	}
	return out
}

// isRelationship reports whether the block's body is an Eloquent relationship
// (return $this->hasMany(...) / morphOne(...) / …).
func isRelationship(headDir string, b Block) bool {
	src := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
	return src.Text != "" && reRelationCall.MatchString(src.Text)
}

// methodOrScopeOnClass resolves method on class directly or via its Eloquent
// scope form (joinAddress → scopeJoinAddress).
func methodOrScopeOnClass(idx *symbolIndex, class, method string) *Block {
	if def := methodOnClass(idx, class, method); def != nil {
		return def
	}
	return methodOnClass(idx, class, "scope"+ucfirst(method))
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
