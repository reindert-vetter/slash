package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Laravel route parsing for resolveCalls' route rule (callresolve_analysis.go,
// rule 0). Pure string functions, so the regression-prone parsing is unit
// tested on its own (route_resolve_test.go) — see "Laravel routes" in
// .claude/docs/workflows-analysis.md.

// routeAction is one controller method a route line dispatches to.
type routeAction struct {
	Class  string // the class as written: short, aliased or fully qualified
	Method string
	Match  string // the matched source literal, for line anchoring (matchLine)
}

// restMethods lists the implicit controller methods per resource-route kind,
// in Laravel's own order. Only the ones the controller actually declares are
// linked.
var restMethods = map[string][]string{
	"resource":     {"index", "create", "store", "show", "edit", "update", "destroy"},
	"apiresource":  {"index", "store", "show", "update", "destroy"},
	"singleton":    {"show", "edit", "update"},
	"apisingleton": {"show", "update"},
}

var (
	// Route::resource('prefix', Foo::class) / apiResource / singleton /
	// apiSingleton, including the old string form resource('prefix', 'Foo').
	// Group 1 = the route kind, 2 = Foo (::class form), 3 = Foo (string form).
	reRouteResource = regexp.MustCompile(`\b((?:api)?(?:[Rr]esource|[Ss]ingleton))\s*\(\s*['"][^'"]*['"]\s*,\s*(?:([\\A-Za-z0-9_]+)::class|['"]([\\A-Za-z0-9_]+)['"])`)
	// ->only([...]) / ->except([...]) chained onto a resource route.
	reRouteOnlyExcept = regexp.MustCompile(`^[^;]*?->\s*(only|except)\s*\(\s*\[([^\]]*)\]`)
	reQuotedWord      = regexp.MustCompile(`['"]([A-Za-z0-9_]+)['"]`)
	// middleware( / withoutMiddleware( — any receiver (Route::, ->) — and the
	// array-option form 'middleware' => ... of Route::group([...]).
	reMiddlewareCall  = regexp.MustCompile(`\b(?:middleware|withoutMiddleware)\s*\(`)
	reMiddlewareOpt   = regexp.MustCompile(`['"](?:middleware|excluded_middleware)['"]\s*=>\s*`)
	reMiddlewareToken = regexp.MustCompile(`([\\A-Za-z0-9_]+)::class|'([^'\n]*)'|"([^"\n]*)"`)
	// 'alias' => Foo::class entries of a middleware-alias array.
	reAliasEntry = regexp.MustCompile(`['"]([^'"]+)['"]\s*=>\s*([\\A-Za-z0-9_]+)::class`)
	// protected $middlewareAliases = [...]; / $routeMiddleware (Laravel <10),
	// and bootstrap/app.php's ->alias([...]) (Laravel 11+).
	reAliasBlock = regexp.MustCompile(`(?s)(?:\$(?:middlewareAliases|routeMiddleware)\s*=|->\s*alias\s*\()\s*\[(.*?)\]`)
)

// routeActionsIn returns every controller method the given (changed-lines)
// route text dispatches to: the array callable [Foo::class, 'm'], the old
// string callable 'Foo@m', and a resource route's implicit REST methods
// (filtered by a chained ->only/->except). Resource methods are returned for
// every REST name; the caller keeps only those the controller declares.
func routeActionsIn(scan string) []routeAction {
	var out []routeAction
	for _, m := range reArrayCallable.FindAllStringSubmatch(scan, -1) {
		out = append(out, routeAction{Class: m[1], Method: m[2], Match: m[0]})
	}
	for _, m := range reStringCallable.FindAllStringSubmatch(scan, -1) {
		out = append(out, routeAction{Class: m[1], Method: m[2], Match: m[0]})
	}
	for _, loc := range reRouteResource.FindAllStringSubmatchIndex(scan, -1) {
		kind := strings.ToLower(scan[loc[2]:loc[3]])
		ctrl := ""
		if loc[4] >= 0 {
			ctrl = scan[loc[4]:loc[5]]
		} else {
			ctrl = scan[loc[6]:loc[7]]
		}
		methods := restMethods[kind]
		if oe := reRouteOnlyExcept.FindStringSubmatch(scan[loc[1]:]); oe != nil {
			listed := map[string]bool{}
			for _, w := range reQuotedWord.FindAllStringSubmatch(oe[2], -1) {
				listed[w[1]] = true
			}
			var kept []string
			for _, m := range methods {
				if listed[m] == (oe[1] == "only") {
					kept = append(kept, m)
				}
			}
			methods = kept
		}
		for _, m := range methods {
			out = append(out, routeAction{Class: ctrl, Method: m, Match: scan[loc[0]:loc[1]]})
		}
	}
	return out
}

// routeMiddlewareRef is one middleware a route line names.
type routeMiddlewareRef struct {
	// Alias is the string as written minus its ":params" ('auth:api' →
	// "auth"); empty for the Foo::class form.
	Alias string
	// Class is the short class name of the Foo::class form (or of a quoted
	// FQCN string); empty for a plain alias.
	Class string
}

// routeMiddlewaresIn returns every middleware named in a middleware(...) /
// withoutMiddleware(...) call or a 'middleware' => ... option in scan — a
// string alias (parameters stripped), a quoted FQCN, or a Foo::class.
// Middleware-group names come back as plain aliases; resolving them is the
// caller's business (they are deliberately not expanded).
func routeMiddlewaresIn(scan string) []routeMiddlewareRef {
	var out []routeMiddlewareRef
	add := func(arg string) {
		for _, t := range reMiddlewareToken.FindAllStringSubmatch(arg, -1) {
			if t[1] != "" {
				out = append(out, routeMiddlewareRef{Class: shortName(t[1])})
				continue
			}
			s := t[2] + t[3]
			if i := strings.IndexByte(s, ':'); i >= 0 {
				s = s[:i]
			}
			s = strings.TrimSpace(s)
			if s == "" {
				continue
			}
			if strings.Contains(s, `\`) {
				out = append(out, routeMiddlewareRef{Class: shortName(s)})
				continue
			}
			out = append(out, routeMiddlewareRef{Alias: s})
		}
	}
	for _, loc := range reMiddlewareCall.FindAllStringIndex(scan, -1) {
		open := loc[1] - 1
		end := closingParenIndex(scan, open)
		if end < 0 {
			end = len(scan)
		}
		add(scan[open+1 : end])
	}
	for _, loc := range reMiddlewareOpt.FindAllStringIndex(scan, -1) {
		rest := scan[loc[1]:]
		if strings.HasPrefix(rest, "[") {
			if end := strings.IndexByte(rest, ']'); end >= 0 {
				rest = rest[:end]
			}
		} else if end := strings.IndexAny(rest, ",]\n"); end >= 0 {
			rest = rest[:end]
		}
		add(rest)
	}
	return out
}

// parseMiddlewareAliases reads the alias → short class name map from a
// Kernel's $middlewareAliases/$routeMiddleware array or a bootstrap/app.php
// ->alias([...]) call.
func parseMiddlewareAliases(src string) map[string]string {
	out := map[string]string{}
	for _, blk := range reAliasBlock.FindAllStringSubmatch(src, -1) {
		for _, e := range reAliasEntry.FindAllStringSubmatch(blk[1], -1) {
			out[e[1]] = shortName(e[2])
		}
	}
	return out
}

// loadMiddlewareAliases merges the alias maps of app/Http/Kernel.php and
// bootstrap/app.php in the head worktree (either may be missing).
func loadMiddlewareAliases(headDir string) map[string]string {
	out := map[string]string{}
	for _, rel := range []string{"app/Http/Kernel.php", "bootstrap/app.php"} {
		src, err := os.ReadFile(filepath.Join(headDir, rel))
		if err != nil {
			continue
		}
		for k, v := range parseMiddlewareAliases(string(src)) {
			out[k] = v
		}
	}
	return out
}

// routeBuilderMethods are the Route facade / route-registrar calls a route
// file is made of. In a ROUTE block they are not "calls" worth resolving —
// they used to go to the LLM one by one and always came back notfound.
var routeBuilderMethods = map[string]bool{
	"get": true, "post": true, "put": true, "patch": true, "delete": true,
	"options": true, "any": true, "match": true, "group": true,
	"middleware": true, "withoutMiddleware": true, "prefix": true,
	"name": true, "as": true, "domain": true, "namespace": true,
	"controller": true, "where": true, "whereNumber": true, "whereUuid": true,
	"resource": true, "apiResource": true, "resources": true, "apiResources": true,
	"singleton": true, "apiSingleton": true, "only": true, "except": true,
	"scopeBindings": true, "withoutScopedBindings": true, "withTrashed": true,
	"redirect": true, "view": true, "fallback": true, "missing": true,
	"can": true, "parameters": true, "names": true, "shallow": true,
}

// reUseImport matches a top-level `use Foo\Bar\Baz;` / `use ... as Alias;`.
var reUseImport = regexp.MustCompile(`(?m)^\s*use\s+([\\A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?\s*;`)

// useImports maps the local name of every `use` import in a PHP file to its
// fully qualified class name.
func useImports(fileText string) map[string]string {
	out := map[string]string{}
	for _, m := range reUseImport.FindAllStringSubmatch(fileText, -1) {
		local := m[2]
		if local == "" {
			local = shortName(m[1])
		}
		out[local] = strings.TrimPrefix(m[1], `\`)
	}
	return out
}

// qualifiedClass returns the fully qualified name of a class reference as
// written in a file with the given imports ("" when unknown).
func qualifiedClass(written string, imports map[string]string) string {
	if strings.Contains(written, `\`) {
		return strings.TrimPrefix(written, `\`)
	}
	return imports[written]
}

// methodOnQualifiedClass is methodOnClass that, when several indexed classes
// share the short name (two modules each with a SettingController), prefers
// the one whose file path matches the fully qualified name under PSR-4
// (Modules\Foo\Http\Controllers\X → modules/Foo/Http/Controllers/X.php,
// compared case-insensitively). Falls back to methodOnClass's first match.
func methodOnQualifiedClass(idx *symbolIndex, fqcn, short, method string) *Block {
	if fqcn != "" {
		want := strings.ToLower(strings.ReplaceAll(fqcn, `\`, "/")) + ".php"
		for i := range idx.byClass[short] {
			b := &idx.byClass[short][i]
			if b.Name == method && strings.HasSuffix(strings.ToLower(b.File), want) {
				return b
			}
		}
	}
	return methodOnClass(idx, short, method)
}
