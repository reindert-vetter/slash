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
	traits     map[string]Block   // trait short name → its whole-class block (resolveCalls rule 8)
	// modelTables maps an explicit `protected $table = 'name'` override (app/Models/)
	// to the model's short class name — the migrationModel rule's primary mapping
	// source (see resolveMigrationModels); the Eloquent naming convention
	// (singularize + Studly) is only its fallback.
	modelTables map[string]string
	// modelCasts maps a model short name → its `$casts` array (field name →
	// cast target class short name) — see resolveCalls rule 5b.
	modelCasts map[string]map[string]string
	// interfaceClasses records every short class name that is an `interface`
	// (via Block.IsInterface, phpscan.go) — used by resolveCalls's
	// interface-typed-receiver rule (see interfaces.go, section "A1") to give
	// an explicitly interface-typed call priority over an otherwise-ambiguous
	// concrete-implementation candidate.
	interfaceClasses map[string]bool
	// implementors maps an interface's short name to every class in the
	// worktree that declares `implements ... ThatInterface ...`
	// (interfaces.go's scanClassImplements) — feeds both
	// interfaceImplementationDetector ("A2") and resolveInterfaceImplementations
	// ("B"), see interfaces.go.
	implementors map[string][]implClass
	// anonMethods maps a file path to the methods declared inside an
	// ANONYMOUS class in that file (Block.Class == "", e.g. every Laravel
	// migration's `return new class extends Migration { ... }`). Such a
	// method has no class name to key idx.byClass on, but "own class" for a
	// $this->/self::/static:: call inside that same anonymous class body
	// unambiguously means "this same anonymous class, this same file" — see
	// methodInAnonClass. Deliberately a SEPARATE map, not folded into
	// byClass under some sentinel key: several files in the worktree each
	// declare their own unrelated anonymous class (every migration does),
	// and byClass[""] would wrongly merge all of them into one bucket.
	anonMethods map[string][]Block
	// classParent maps a NAMED class's short name to its `extends` target's
	// short name (Block.Parent, phpscan.go) — resolveCalls' `parent::` rule.
	// Absent = no `extends` clause, or ambiguous file collision (last write
	// wins, same silent-limit trade-off idx.facades/idx.models already
	// accept for a same-named class in two files).
	classParent map[string]string
	// anonParent mirrors classParent for an anonymous class, keyed by file
	// (mirrors anonMethods) since there is no class name to key on.
	anonParent map[string]string
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
		traits:      map[string]Block{},
		modelTables: map[string]string{},
		modelCasts:  map[string]map[string]string{},
		anonMethods: map[string][]Block{},
		classParent: map[string]string{},
		anonParent:  map[string]string{},

		interfaceClasses: map[string]bool{},
		implementors:     map[string][]implClass{},
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
			if b.Name == "" {
				continue
			}
			if b.Class == "" {
				// An anonymous class's method (e.g. a Laravel migration's
				// `return new class extends Migration { ... }`) has no class
				// name to key idx.byClass on — index it per-file instead, see
				// anonMethods/methodInAnonClass.
				idx.anonMethods[b.File] = append(idx.anonMethods[b.File], b)
				if b.Parent != "" {
					idx.anonParent[b.File] = shortName(b.Parent)
				}
				continue
			}
			short := shortName(b.Class)
			idx.byClass[short] = append(idx.byClass[short], b)
			idx.byMethod[b.Name] = append(idx.byMethod[b.Name], b)
			if alias := scopeAliasOf(b.Name); alias != "" {
				idx.scopeAlias[alias] = append(idx.scopeAlias[alias], b)
			}
			if b.IsInterface {
				idx.interfaceClasses[short] = true
			}
			if b.Parent != "" {
				idx.classParent[short] = shortName(b.Parent)
			}
		}
		// A `class X implements ... Y ...` declaration — index Y → X so a call
		// through an interface-typed receiver (resolveCalls) and the
		// "implementations of an unclaimed interface method" rule
		// (resolveInterfaceImplementations) both have a worktree-wide
		// interface → implementors lookup, without a second file read (see
		// interfaces.go).
		for iface, classes := range scanClassImplements(src) {
			for _, class := range classes {
				idx.implementors[iface] = append(idx.implementors[iface], implClass{class: class, file: rel})
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
		// A trait declaration is not a method either; index it as a whole-class
		// block (mirrors scanModels/scanEnums) so a `use TraitName;` in a class
		// header (resolveCalls rule 8) can point at the trait's own definition.
		for _, b := range scanTraits(src, rel) {
			idx.traits[shortName(b.Class)] = b
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

// scanTraits finds PHP trait declarations and returns one synthetic block per
// trait (Class = the trait name, Name empty), spanning the whole declaration —
// mirrors scanModels/scanEnums. blockSource falls back to line-slicing for it,
// since ScanBlocks never surfaces a class-level symbol.
func scanTraits(src []byte, filename string) []Block {
	s := string(src)
	var out []Block
	for _, loc := range reTraitDef.FindAllStringSubmatchIndex(s, -1) {
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
	reParentCall = regexp.MustCompile(`parent::([A-Za-z_]\w*)\s*\(`)
	reStaticCall = regexp.MustCompile(`([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(`)
	reNewCall    = regexp.MustCompile(`\(new\s+([\\A-Za-z_][\\\w]*)\s*(?:\([^)]*\))?\)->([A-Za-z_]\w*)\s*\(`)
	// reNewObj matches a bare object construction `new Foo(` — it couples to the
	// class's constructor (__construct), so e.g. new PluginDisabledNotification(...)
	// shows that notification's definition as underlying code. It also matches the
	// `new Foo(` inside the chained `(new Foo)->m(` form (rule 2); that is fine, the
	// constructor is a distinct child keyed by the class name.
	reNewObj    = regexp.MustCompile(`\bnew\s+([\\A-Za-z_][\\\w]*)\s*\(`)
	reArrowCall = regexp.MustCompile(`->([A-Za-z_]\w*)\s*\(`)
	// reClassRefReceiver matches a receiver that names its own class literally
	// and is immediately followed by an arrow call: the `app(Foo::class)` /
	// `resolve(Foo::class)` / `make(Foo::class)` container form in
	// `app(Foo::class)->run($x)`. Anchored at the END of the text preceding a
	// `->m(` match, so it only fires for a receiver that really sits directly in
	// front of that arrow. Group 1 is the class name (see rule 4a).
	reClassRefReceiver = regexp.MustCompile(`([\\A-Za-z_][\\\w]*)::class\s*\)\s*$`)
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
	// reTypedParamNamed is like relations.go's reTypedParam, but also captures
	// the variable name (`Foo $var`) — used by resolveCalls rule 3a
	// (interfaces.go) to map a bare $var/property name to its declared type
	// (a constructor/method parameter or a promoted/readonly property), so a
	// later `$var->method(`/`$this->prop->method(` call can be checked
	// against idx.interfaceClasses.
	reTypedParamNamed = regexp.MustCompile(`([\\A-Za-z0-9_]+)\s+\$([A-Za-z_]\w*)`)
	// reThisPropCall matches `$this->prop->method(` — a constructor-promoted
	// (or ordinary) property accessed via $this, called from a method OTHER
	// than the one declaring its type (resolveCalls rule 3a).
	reThisPropCall = regexp.MustCompile(`\$this->([A-Za-z_]\w*)->([A-Za-z_]\w*)\s*\(`)
	// reActivityStubVar matches `$var = Workflow::newActivityStub(FooActivity::class,
	// ...)` — a Temporal workflow method creating a stub for an Activity, whose
	// variable name rarely follows the class-name convention rule 3b relies on
	// (`$runCommand` for `RunCommandActivity`). Captures the variable + the
	// Activity's short class name (resolveCalls rule 3a2). `\s*` also bridges the
	// multi-line call form (`Workflow::newActivityStub(\n    FooActivity::class,`).
	reActivityStubVar = regexp.MustCompile(`\$([A-Za-z_]\w*)\s*=\s*Workflow::newActivityStub\(\s*([\\A-Za-z0-9_]+)::class`)
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
	// reTraitDef matches a PHP trait declaration line — see scanTraits.
	reTraitDef = regexp.MustCompile(`(?m)^\s*trait\s+([A-Za-z_]\w*)`)
	// reTraitUse matches a `use TraitA, TraitB;` trait-import statement inside a
	// class's header region (classHeaderSentinel) — resolveCalls rule 8. Only
	// the plain form ending directly in `;` is matched; a trait-adaptation
	// block (`use A, B { A::foo insteadof B; }`) is deliberately out of scope
	// (v1) — see .claude/docs/tembed-workflows.md.
	reTraitUse = regexp.MustCompile(`(?m)^\s*use\s+((?:\\?[A-Za-z_][\w\\]*\s*,\s*)*\\?[A-Za-z_][\w\\]*)\s*;`)
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
	baseDir, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)
	idx := buildSymbolIndex(headDir)
	diffByFile := map[string]*fileChangeSet{}
	// interfaceVarsByFile caches, per file, the "$var name → interface short
	// name" map rule 3a needs — built from the WHOLE file (not just the
	// current block's own body), since a constructor-PROMOTED property's type
	// hint sits in __construct's signature while it is typically USED via
	// $this->prop in other methods of the same class (see interfaces.go /
	// .claude/docs/tembed-workflows.md, "Interface methods as underlying
	// code"). Cached like diffByFile below, so a class with several changed
	// methods only re-reads/re-scans its own file once.
	interfaceVarsByFile := map[string]map[string]string{}
	// activityStubVarsByFile caches, per file, the "$var name → Temporal Activity
	// short class name" map rule 3a2 needs — built from the WHOLE file for the
	// same reason as interfaceVarsByFile: `Workflow::newActivityStub(...)` often
	// sits a few lines above the `$var->method(...)` call it's used from, both
	// still inside the same block's body in practice, but scanning the whole
	// file is simplest and mirrors the existing cache. Silent limit, accepted:
	// a variable name reused for a different Activity in another method of the
	// same file collides (last assignment in the file wins) — same trade-off
	// interfaceVarsByFile already accepts.
	activityStubVarsByFile := map[string]map[string]string{}

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

		// 1. $this->m( / self::m( / static::m( → a method on the caller's own
		// class — for an anonymous class (Block.Class == "", e.g. a Laravel
		// migration's `return new class extends Migration { ... }`) there is
		// no class name to look up, so "own class" resolves per-file instead
		// (methodInAnonClass; see idx.anonMethods).
		for _, m := range append(reThisCall.FindAllStringSubmatch(scan, -1),
			reSelfCall.FindAllStringSubmatch(scan, -1)...) {
			var def *Block
			if b.Class == "" {
				def = methodInAnonClass(idx, b.File, m[1])
			} else {
				def = methodOnClass(idx, b.Class, m[1])
			}
			if def != nil {
				emit(m[1], def)
			}
		}
		// 1b. parent::m( → a method on the caller's PARENT class. The parent
		// is very often a framework class (Migration, Model, Controller,
		// TestCase) that idx never indexed (vendor is skipped), in which case
		// this falls to `unresolved` — same "call site is on a changed line,
		// let the automatic search try" reasoning as rule 1's own unknown-
		// method fallback, not silence.
		for _, m := range reParentCall.FindAllStringSubmatch(scan, -1) {
			parentClass := idx.classParent[shortName(b.Class)]
			if b.Class == "" {
				parentClass = idx.anonParent[b.File]
			}
			var def *Block
			if parentClass != "" {
				def = methodOnClass(idx, parentClass, m[1])
			}
			emit(m[1], def)
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
			if def == nil && nativeEnumMethods[m[2]] {
				// 3b. A NATIVE enum method on an indexed enum —
				// CustomerInclude::cases() (also from()/tryFrom()). PHP
				// declares these itself, so no worktree block will ever
				// define them; the useful child is the enum DECLARATION,
				// exactly as rule 6 already does for an enum CASE reference
				// (child_method = the method name, so the card reads
				// `CustomerInclude::cases`). Must run BEFORE the
				// unique-global-candidate fallback below, which would
				// otherwise latch onto any unrelated class that happens to
				// declare a same-named method.
				if enums := idx.enums[shortName(recv)]; len(enums) == 1 && !seen[m[2]] {
					e := enums[0]
					seen[m[2]] = true
					code := enrichedCodeSide(blockSource(headDir, e))
					out = append(out, callresolve.Entry{
						PR: pr, CallerID: callerID, CallKey: m[2], Status: callresolve.StatusResolved,
						ChildFile: e.File, ChildClass: e.Class, ChildMethod: m[2],
						ChildLine: code.Start, ChildCode: code.Text,
					})
					continue
				}
			}
			if def == nil && isVendorBuiltin(m[2]) {
				// A vendor/framework/PHP builtin name (resolve_call.go's own
				// denylist) that the receiver doesn't declare resolves to
				// NOTHING, deliberately — not to the unique global candidate
				// below, and not to `unresolved` either. Reported bug:
				// CustomerInclude::cases() (a native enum method on an enum
				// the index didn't recognise) showed the wholly unrelated
				// `Interval::cases` as underlying code, purely because that
				// was the only app method of that name. `unresolved` would be
				// no better here: the same denylist documents that neither
				// Haiku nor the agentic Sonnet can ever find app code for
				// these, so the row would only offer a "Zoeken…" affordance
				// that never finds anything. Same "silently nothing"
				// trade-off as rules 6b/6c/8.
				continue
			}
			if def == nil {
				// Foo doesn't declare m() itself and isn't a facade — it may be
				// INHERITED from a base class (methodOnClass has no extends-chain
				// awareness at all). Mirrors rule 4's own fallback for an unknown
				// ->m( receiver: fall back to the unique global candidate, e.g. a
				// feature-flag class `final class PromotionsV2 extends
				// UnleashFeature` calling PromotionsV2::isEnabled(), which is only
				// ever declared once, on the abstract base UnleashFeature. Several
				// same-named methods elsewhere in the app still stay unresolved
				// (LLM territory), same ambiguity rule as rule 4.
				if cands := idx.candidates(m[2]); len(cands) == 1 {
					def = &cands[0]
				}
			}
			emit(m[2], def)
		}
		// 3a. $var->m( (a plain local/parameter) OR $this->prop->m( (a
		// constructor-PROMOTED or ordinary property, accessed from a
		// DIFFERENT method than the one declaring its type) where the
		// variable/property's DECLARED type is one of the worktree's scanned
		// INTERFACE classes (idx.interfaceClasses) → resolve straight to that
		// interface's OWN method declaration. Runs before the receiver-NAME
		// heuristic (3b) and the global unique-match fallback (4): once a
		// concrete implementation of the interface also defines the same
		// method name, idx.byMethod[key] holds >1 candidate and rule 4 alone
		// would give up as ambiguous/"unresolved" — exactly what left a
		// changed interface method stranded as an orphan top-level start
		// point instead of underlying code of its caller (see
		// .claude/docs/tembed-workflows.md, "Interface methods as
		// underlying code"). An explicit interface type hint is a stronger
		// signal than 3b's bare receiver-NAME guess, hence it runs first and
		// its matches are marked `seen` so 3b/4 never re-process the same
		// call key. The type/name pairing (reTypedParamNamed) is scanned over
		// the WHOLE FILE, not just this block's own body/signature — a
		// promoted property's type sits in __construct's signature, while
		// it's typically USED as $this->prop in other methods of the same
		// class (interfaceVarsByFile caches this per file, like diffByFile).
		varInterfaceType, ok := interfaceVarsByFile[b.File]
		if !ok {
			varInterfaceType = map[string]string{}
			if wholeFile, err := os.ReadFile(filepath.Join(headDir, b.File)); err == nil {
				for _, m := range reTypedParamNamed.FindAllStringSubmatch(string(wholeFile), -1) {
					if iface := shortName(m[1]); idx.interfaceClasses[iface] {
						varInterfaceType[m[2]] = iface
					}
				}
			}
			interfaceVarsByFile[b.File] = varInterfaceType
		}
		if len(varInterfaceType) > 0 {
			resolveInterfaceVar := func(recv, key string) bool {
				if seen[key] {
					return true
				}
				iface, ok := varInterfaceType[recv]
				if !ok {
					return false
				}
				if def := methodOnClass(idx, iface, key); def != nil {
					emit(key, def)
					return true
				}
				return false
			}
			for _, m := range reVarCall.FindAllStringSubmatch(scan, -1) {
				resolveInterfaceVar(m[1], m[2])
			}
			for _, m := range reThisPropCall.FindAllStringSubmatch(scan, -1) {
				resolveInterfaceVar(m[1], m[2])
			}
		}
		// 3a2. $var = Workflow::newActivityStub(FooActivity::class, ...) then
		// $var->m( → a Temporal Activity's method — a workflow's "underlying
		// code" that the receiver-NAME heuristic (3b) usually misses, since the
		// stub variable is rarely named after the Activity class
		// ($runCommand for RunCommandActivity). Runs before 3b/4 and marks
		// `seen`, mirroring 3a, so a bare-name guess or an ambiguous global
		// match never overrides this explicit, mechanically-derived relation.
		// An Activity class the worktree doesn't index (framework/vendor) still
		// resolves to `unresolved` rather than falling through silently — the
		// call site sits on a changed line, so the reviewer gets "Zoek" instead
		// of nothing.
		activityStubClass, ok := activityStubVarsByFile[b.File]
		if !ok {
			activityStubClass = map[string]string{}
			if wholeFile, err := os.ReadFile(filepath.Join(headDir, b.File)); err == nil {
				for _, m := range reActivityStubVar.FindAllStringSubmatch(string(wholeFile), -1) {
					activityStubClass[m[1]] = shortName(m[2])
				}
			}
			activityStubVarsByFile[b.File] = activityStubClass
		}
		if len(activityStubClass) > 0 {
			for _, m := range reVarCall.FindAllStringSubmatch(scan, -1) {
				class, ok := activityStubClass[m[1]]
				if !ok {
					continue
				}
				key := m[2]
				if seen[key] {
					continue
				}
				emit(key, methodOnClass(idx, class, key))
			}
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
		for _, loc := range reArrowCall.FindAllStringSubmatchIndex(scan, -1) {
			key := scan[loc[2]:loc[3]]
			if seen[key] {
				continue
			}
			// 4a. app(Foo::class)->m( — the receiver names its class literally,
			// so this call is deterministically resolvable even though the bare
			// method name is ambiguous app-wide. Without this, `run`/`handle`/
			// `execute` on a container-resolved Activity fell through to
			// `unresolved` and was shipped off to the LLM (resolve_call), which
			// then re-discovered exactly what the source already spells out —
			// paid for, and racing rule 6c-bis's own entry-point row for the
			// same class into a DUPLICATE card in the Onderliggende-code panel
			// (see "The entry points of a referenced class" in
			// .claude/docs/underlying-code.md). An unindexed class (vendor/
			// framework) still falls through to the ordinary path below.
			if pm := reClassRefReceiver.FindStringSubmatch(scan[:loc[0]]); pm != nil {
				if def := methodOnClass(idx, shortName(pm[1]), key); def != nil {
					emit(key, def)
					continue
				}
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
		// AddressType::BILLING. For a receiver that is an indexed enum the
		// child is the whole enum declaration; for a plain class, rule 6b
		// below resolves the constant to its own declaration line instead.
		// Runs after rule 3, so a static call wins the key.
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
			default:
				// 6b. No enum by that name → a constant on a PLAIN class
				// (Foo::MAX_TRIES). Resolves to the constant's own
				// DECLARATION, not to the whole class: for an enum the entire
				// declaration is the useful unit, for an ordinary class it
				// would be a wall of unrelated methods. Go-only and silent on
				// ambiguity, like the enum branch above.
				//
				// A reference to the caller's OWN class is skipped: on a
				// <class-header> block resolveClassMembers already emits that
				// very constant as its own card, and two cards for one
				// declaration is worse than none.
				if shortName(recv) == shortName(b.Class) {
					continue
				}
				if cfile, cm, cok := classConstDecl(headDir, idx, recv, key); cok {
					seen[key] = true
					out = append(out, callresolve.Entry{
						PR: pr, CallerID: callerID, CallKey: key,
						Status: callresolve.StatusResolved, Kind: callresolve.KindConstRef,
						ChildFile: cfile, ChildClass: shortName(recv), ChildMethod: key,
						ChildLine: cm.Line, ChildCode: cm.Text,
					})
				}
			}
		}
		// 6c. Foo::class (no parens, no assignment to a $var, no $casts array
		// entry) → the class as a whole — the generic sibling of 3a2 (which
		// only covers Workflow::newActivityStub(FooActivity::class, ...)):
		// a plain array of class references, e.g. a Temporal workflow's
		// `'activities' => [FooActivity::class, ...]` registration, has no
		// $var/->method() to key a call to, so rules 1-6b never produced
		// underlying code for it at all. Reuses rule 6's own reStaticRef
		// matches (which deliberately skip key=="class") for exactly the
		// opposite case. Runs last among the class/static rules, after its
		// `seen` guard, so a class already claimed under this same key
		// (constructor 2b, model usage 2c, an Activity stub 3a2) is never
		// duplicated — this rule only fills the gap those left. An
		// unindexed class (vendor/framework/exception) resolves to
		// silently NOTHING, never `unresolved`: unlike a method call,
		// `::class` is used constantly for purposes that have no
		// "underlying code" at all (type hints, exception classes), so
		// treating every miss as an LLM-search candidate would flood the
		// panel — the same trade-off rule 6b/8/trait-usage already make.
		for _, loc := range reStaticRef.FindAllStringSubmatchIndex(scan, -1) {
			recv, key := scan[loc[2]:loc[3]], scan[loc[4]:loc[5]]
			if key != "class" {
				continue
			}
			class := shortName(recv)
			if seen[class] || class == shortName(b.Class) {
				continue
			}
			if def, ok := idx.models[class]; ok {
				emitKind(class, &def, callresolve.KindModelUsage)
				continue
			}
			if hb, ok := classHeaderBlockFor(idx, class); ok {
				emitKind(class, &hb, callresolve.KindClassRef)
				// 6c-bis. The <class-header> alone says very little about a
				// class — it is only the declaration region (constants,
				// properties), and it is only interesting at all when this PR
				// changed it. On explicit request a plain `Foo::class`
				// reference therefore ALSO shows the two blocks a reader opens
				// first to understand what the class IS: its constructor and
				// its first other method — even though neither is usually
				// changed by this PR (they are ordinary "unchanged" reference
				// children, like a resolved call into an untouched file).
				// Deliberately scoped to THIS rule only (a bare `Foo::class`),
				// not to `new Foo(...)`/model usage/an Activity stub: those
				// already point at the exact method being used, so a
				// constructor + arbitrary first method next to it is noise.
				ctor, first := classEntryPoints(idx, class, hb.File)
				if ctor != nil {
					emitKind("class_ctor:"+class, ctor, callresolve.KindClassCtor)
				}
				if first != nil {
					emitKind("class_method:"+class, first, callresolve.KindClassFirstMethod)
				}
			}
		}
		// 7. Resource usage (new XResource(/XResource::make|collection(/a
		// `): XResource` return type — the same forms relations.go's
		// controllerResourceDetector matches) → the toArray() method of that
		// Resource class, since that is where a Laravel API Resource defines its
		// actual output. Deliberately a callresolve rule, not a relations
		// detector: the Resource class is very often NOT itself changed in this
		// PR (an existing Resource just newly used), so the both-changed
		// requirement of controllerResourceDetector would otherwise never
		// surface it — mirrors resolveMigrationModels/resolveDataProviders below.
		// The call key is "resource:"+class (contains ':', so — like
		// migration_model:/data_provider: — it never matches a real call-site
		// literal in the frontend's findCallSites, meaning this child shows at
		// group/list level, not tied to one line/call, and never collides with
		// rule 2b's plain class-name constructor key). A Resource class that
		// doesn't override toArray() (uses the framework default) silently
		// yields no child — not an ambiguity for the LLM search, just an
		// absence.
		for _, m := range reResourceUse.FindAllStringSubmatch(scan, -1) {
			class := m[1]
			if class == "" {
				class = m[2]
			}
			if def := methodOnClass(idx, shortName(class), "toArray"); def != nil {
				emit("resource:"+shortName(class), def)
			}
		}
		for _, m := range reResourceReturn.FindAllStringSubmatch(scan, -1) {
			if def := methodOnClass(idx, shortName(m[1]), "toArray"); def != nil {
				emit("resource:"+shortName(m[1]), def)
			}
		}
		// 8. `use TraitName;` added to a class's header (a trait-import
		// statement) → the trait's own definition, since a class using a trait
		// wants the trait's code shown as underlying code, even though the
		// trait itself is very often NOT changed by this PR. Deliberately a
		// callresolve rule (points at possibly-unchanged code), Go-only, no LLM
		// fallback — mirrors resolveMigrationModels/resolveDataProviders. Only
		// meaningful within the class-header region (classHeaderSentinel, see
		// phpscan.go) where a use-statement actually lives; a trait added
		// elsewhere in the class body (unusual PHP, after the first method)
		// falls outside every block's scanned text and is silently missed
		// (same kind of scope boundary as scanMacros' boot-method-only reach).
		// The call key is "trait_usage:"+trait (contains ':', so — like
		// migration_model:/data_provider: — it never matches a real call-site
		// literal, meaning this child shows at group/list level, not tied to
		// one line/call). A name that isn't an indexed trait (a vendor trait, a
		// typo) silently yields no child — never an "unresolved" row.
		if b.Name == classHeaderSentinel {
			for _, m := range reTraitUse.FindAllStringSubmatch(scan, -1) {
				for _, name := range strings.Split(m[1], ",") {
					trait := shortName(strings.TrimSpace(name))
					if trait == "" {
						continue
					}
					if def, ok := idx.traits[trait]; ok {
						emitKind("trait_usage:"+trait, &def, callresolve.KindTraitUsage)
					}
				}
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
// see .claude/docs/tembed-workflows.md ("migration → model"). Go-only, no LLM
// fallback: a migration whose table can't be mapped to a known model just
// produces no child (silent), never an "unresolved" row.
func resolveMigrationModels(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	_, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)
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
// (mirrors resolveMigrationModels) — see .claude/docs/tembed-workflows.md,
// "PHPUnit data providers". Fully deterministic, no LLM fallback: PHPUnit's
// plain #[DataProvider(...)]/@dataProvider always names a method on the
// test's OWN class (no ambiguity to resolve), so a name that doesn't match a
// method there just produces no child (silent), never an "unresolved" row.
//
// It reuses methodZone (testcovers_analysis.go) to read the attribute/
// docblock text directly above (and, since phpscan.go folds a leading
// #[...] attribute into its own block, now partly INSIDE) the test method's
// own span — see funcDeclLine/methodZone's doc comments and
// .claude/docs/blocks-and-ingest.md.
func resolveDataProviders(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	_, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)
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
		// classLine 0: a #[DataProvider] is always per-method, never a
		// class-level annotation shared across methods (unlike testcovers'
		// #[CoversMethod]), so there's no equivalent "sweeps in the class
		// declaration for the first method" concern to bound against here.
		zone, _, _ := methodZone(fi.lines, fi.fileBlocks, b, 0)
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
	baseDir, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)
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

// resolveClassMembers breaks a <class-header> block's declared members —
// properties and constants — out of that one coarse block into their own
// "Onderliggende code" cards, so a reviewer sees `$listen` or `MAX_TRIES` as a
// separate unit next to the diff instead of only inside the header's single
// blob (Reindert, request: "alle aangepaste properties en constanten wil ik
// rechts als onderliggende code zien; ook alle constanten, ook als die niet
// aangepast zijn").
//
// What it emits, per changed <class-header> block:
//   - EVERY constant, changed or not — an unchanged constant is reference
//     material the reviewer explicitly asked to always see.
//   - ONLY a changed/added property — an unchanged property is noise.
//
// A REMOVED member is deliberately never emitted: it no longer exists on the
// head side, and the header block's own diff already shows the deletion.
//
// Deliberately a callresolve rule, not a relations detector or a phpscan
// block: it points at (possibly) unchanged code, and a member must never
// become a PR block — no id, no approval, no row in the block index. Go-only,
// no LLM fallback: an unparsable member simply yields no card, never an
// "unresolved" row (mirrors resolveMigrationModels/resolveDataProviders).
//
// Scope boundary, same one rule 8 (trait usage) already accepts: only the
// <class-header> region is scanned, so a constant declared AFTER the first
// method (unusual PHP) is silently missed.
//
// The call key is "class_member:const:"/"class_member:prop:"+name — it
// contains ':', so like migration_model:/data_provider:/trait_usage: it never
// matches a real call-site literal and the card shows at group/list level
// instead of being scoped to one line (see isBlockLevelCallKey in home.mjs).
func resolveClassMembers(dataDir string, pr int, blocks []Block) []callresolve.Entry {
	baseDir, headDir := worktreeDirs(dataDir, blocksRepo(blocks), pr)

	var out []callresolve.Entry
	for _, b := range blocks {
		if b.Side == SideOld || b.Name != classHeaderSentinel {
			continue
		}
		head := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
		if head.Text == "" {
			continue
		}
		// The same region on the base side, to tell a changed member from an
		// untouched one. A missing base file/class (an added file) leaves the
		// map empty, so every member counts as changed — which is correct.
		baseText := map[string]string{}
		base := extractBlockSource(filepath.Join(baseDir, b.File), b.File, b.Class, b.Name)
		if base.Text != "" {
			for _, m := range scanClassMembers(base.Text, base.Start) {
				baseText[m.Kind+":"+m.Name] = normalizeMemberText(m.Text)
			}
		}

		// A <class-header> block is one coarse blob the reviewer would rather
		// not review as its own top-level card, ON EXPLICIT REQUEST — but ONLY
		// when there is somewhere else to hang its members: every OTHER
		// changed, non-header top-level block of the SAME class (a method that
		// also changed in this PR). classSiblingIDs is empty for a class whose
		// ONLY change in this PR is its header — the header then stays its own
		// caller, exactly as before (the frontend keeps such a header visible,
		// see swallowedClassHeaderIds in home.mjs). With several changed
		// siblings, every one of them gets the SAME member cards — no single
		// "chosen" host, since there is no natural way to pick one.
		callerIDs := classSiblingIDs(blocks, b)
		if len(callerIDs) == 0 {
			callerIDs = []string{b.ID()}
		}
		for _, m := range scanClassMembers(head.Text, head.Start) {
			was, existed := baseText[m.Kind+":"+m.Name]
			changed := !existed || was != normalizeMemberText(m.Text)

			var kind string
			switch {
			case m.Kind == "prop" && changed:
				kind = callresolve.KindClassProperty
			case m.Kind == "prop":
				continue // an unchanged property is not worth a card
			case changed:
				kind = callresolve.KindClassConstantChange
			default:
				kind = callresolve.KindClassConstant
			}
			for _, callerID := range callerIDs {
				out = append(out, callresolve.Entry{
					PR: pr, CallerID: callerID,
					CallKey: "class_member:" + m.Kind + ":" + m.Name,
					Status:  callresolve.StatusResolved, Kind: kind,
					ChildFile: b.File, ChildClass: b.Class, ChildMethod: m.Name,
					ChildLine: m.Line, ChildCode: m.Text,
				})
			}
		}
	}
	return out
}

// classSiblingIDs returns the block IDs of every OTHER top-level, new-side,
// non-header PR block that shares b's file+class — the changed methods a
// <class-header>'s own member cards (resolveClassMembers) attach to instead
// of the header itself, once at least one exists. Deliberately scoped to the
// SAME file, not just the same class short name — two same-named classes in
// different files must never share member cards.
func classSiblingIDs(blocks []Block, header Block) []string {
	var ids []string
	for _, sib := range blocks {
		if sib.Side == SideOld || sib.Name == classHeaderSentinel {
			continue
		}
		if sib.File == header.File && sib.Class == header.Class {
			ids = append(ids, sib.ID())
		}
	}
	return ids
}

// normalizeMemberText is the comparison form of a member declaration: trailing
// whitespace per line dropped, so a pure line-ending/trailing-space difference
// between base and head doesn't read as a change. Indentation IS significant —
// a re-indent shows up in the header's diff too, so calling it "changed" is
// consistent rather than surprising.
func normalizeMemberText(text string) string {
	lines := strings.Split(text, "\n")
	for i, ln := range lines {
		lines[i] = strings.TrimRight(ln, " \t\r")
	}
	return strings.Join(lines, "\n")
}

// classConstDecl finds the declaration of constant `name` on class `class` in
// the head worktree, for resolveCalls' rule 6b (a Foo::MAX_TRIES reference on a
// plain, non-enum class). It looks the class up through the symbol index —
// which indexes the <class-header> block too, so a class with no methods at all
// is still found — and scans that header region with the same scanClassMembers
// used by resolveClassMembers.
//
// ok=false when nothing matches OR when two different files declare a class
// with this short name and that constant: an ambiguous hit stays silent (no
// entry, no "unresolved" row), like every other Go-only rule here.
func classConstDecl(headDir string, idx *symbolIndex, class, name string) (file string, m classMember, ok bool) {
	seenFile := map[string]bool{}
	for _, hb := range idx.byClass[shortName(class)] {
		if hb.Name != classHeaderSentinel || seenFile[hb.File] {
			continue
		}
		seenFile[hb.File] = true
		src := blockSource(headDir, hb)
		if src.Text == "" {
			continue
		}
		for _, cm := range scanClassMembers(src.Text, src.Start) {
			if cm.Kind != "const" || cm.Name != name {
				continue
			}
			if ok {
				return "", classMember{}, false // ambiguous — stay silent
			}
			file, m, ok = hb.File, cm, true
		}
	}
	return file, m, ok
}

// classHeaderBlockFor returns a single block spanning the whole class body
// for a short class name across the whole worktree — resolveCalls rule 6c's
// "point at the class as a whole" target for a plain Foo::class reference
// that no more specific rule (constructor, model usage, Activity stub, ...)
// already claimed. It prefers the real <class-header> block (constants and
// properties declared before the first method); a class with NO header
// region at all — no content between `class X {` and its first method,
// exactly the common shape of a small Temporal Activity — never gets one
// (see phpscan.go's headerLine<=declLine-1 guard), so it falls back to the
// UNION (min Line, max EndLine) of every OTHER block the worktree indexed
// for that class in one file, which for such a class spans its methods
// end-to-end and reads as "the whole class" all the same.
//
// Ambiguous (two files declaring the same short name) or not found at all →
// ok=false, silent — the caller never turns that into an `unresolved` row.
func classHeaderBlockFor(idx *symbolIndex, class string) (Block, bool) {
	blocks := idx.byClass[shortName(class)]
	var found Block
	ok := false
	seenFile := map[string]bool{}
	for _, hb := range blocks {
		if hb.Name != classHeaderSentinel || seenFile[hb.File] {
			continue
		}
		seenFile[hb.File] = true
		if ok {
			return Block{}, false // ambiguous — stay silent
		}
		found, ok = hb, true
	}
	if ok {
		return found, true
	}
	byFile := map[string]*Block{}
	for _, b := range blocks {
		u, ok := byFile[b.File]
		if !ok {
			cp := b
			byFile[b.File] = &cp
			continue
		}
		if b.Line < u.Line {
			u.Line = b.Line
		}
		if b.EndLine > u.EndLine {
			u.EndLine = b.EndLine
		}
	}
	if len(byFile) != 1 {
		return Block{}, false // no blocks at all, or ambiguous across files
	}
	for _, u := range byFile {
		u.Name = classHeaderSentinel
		return *u, true
	}
	return Block{}, false
}

// classEntryPoints returns the two blocks that best introduce a class to a
// reader: its `__construct` and its first OTHER method (lowest declaration
// line), both scoped to `file` — the file classHeaderBlockFor already resolved
// the class to, so an ambiguous short name can never mix methods from two
// different classes here. Either may be nil: a class without an explicit
// constructor yields only the first method, and a class whose only member is
// its constructor yields only that (explicit answer: no "first two methods"
// fallback when there is no constructor — one method is one method).
//
// Both come from the worktree-wide symbol index (idx.byClass), NOT from the
// PR's own blocks table, which only holds what the PR changed — that is the
// whole point: these blocks are usually unchanged, and are shown anyway. A
// method that IS changed by this PR is shown here all the same (it then simply
// appears both as its own review block and as this reference card).
func classEntryPoints(idx *symbolIndex, class, file string) (ctor, first *Block) {
	blocks := idx.byClass[shortName(class)]
	for i := range blocks {
		cand := &blocks[i]
		if cand.File != file || cand.Name == classHeaderSentinel {
			continue
		}
		if cand.Name == "__construct" {
			if ctor == nil || cand.Line < ctor.Line {
				ctor = cand
			}
			continue
		}
		if first == nil || cand.Line < first.Line {
			first = cand
		}
	}
	return ctor, first
}

// translationKeysIn scans a changed-lines excerpt for every recognized
// translation-helper call and returns the captured (unescaped) key strings.
//
// A quoted first argument that is immediately followed by a `.`
// (concatenation, e.g. `trans('includes.' . $this->value)`) is NOT a fully
// static key — only its prefix is known, the rest is decided at runtime —
// and is therefore skipped here, exactly like a call with no quoted literal
// at all (`trans($dynamic)`). Without this check, such a call previously
// still produced a (wrong) key made of just the static prefix, which
// resolveTranslations then reported as "missing" in every locale — a false
// positive, since the translation isn't missing, the key just can't be
// determined statically.
func translationKeysIn(scan string) []string {
	var keys []string
	push := func(re *regexp.Regexp, quote byte) {
		for _, m := range re.FindAllStringSubmatchIndex(scan, -1) {
			if strings.HasPrefix(strings.TrimLeft(scan[m[1]:], " \t\r\n"), ".") {
				continue // concatenation follows — key is dynamic, not fully static
			}
			keys = append(keys, unescapePHPQuoted(scan[m[2]:m[3]], quote))
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

// nativeEnumMethods are the methods PHP gives every backed/pure enum for free.
// No worktree block ever declares them, so a `Foo::cases()` static call can
// only sensibly point at the enum DECLARATION itself — see resolveCalls rule
// 3b. `cases` is in resolve_call.go's vendorBuiltinNames for the same reason
// (the LLM can never find it either); this map is the Go-side counterpart that
// turns it into a useful child instead of a wrong one.
var nativeEnumMethods = map[string]bool{"cases": true, "from": true, "tryFrom": true}

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

// methodInAnonClass is methodOnClass's counterpart for a caller whose own
// class is anonymous (Block.Class == ""), scoped by FILE instead of class
// name — see idx.anonMethods. Used by resolveCalls rule 1 for a
// $this->/self::/static:: call inside such a class (e.g. a Laravel
// migration's private helper methods).
func methodInAnonClass(idx *symbolIndex, file, method string) *Block {
	for i := range idx.anonMethods[file] {
		if idx.anonMethods[file][i].Name == method {
			return &idx.anonMethods[file][i]
		}
	}
	return nil
}
