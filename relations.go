package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"slash/modules/relations"
)

// This file is the relation-analysis service: it derives many-to-many edges
// between the blocks of a PR by reading the head worktree (a full checkout, so
// unchanged files like EventServiceProvider are readable too). It is pure
// analysis — the workflow Activity calls buildRelations and hands the result to
// the relations module, which is the only writer (workflows-write-boundary.md).
//
// Detectors are a list so more relation types can be added without touching the
// flow. The first: event → listener.

// relationDetector produces relations from the PR's blocks + the head worktree.
type relationDetector func(headDir string, pr int, blocks []Block) []relations.Relation

var relationDetectors = []relationDetector{
	eventListenerDetector,
	routeControllerDetector,
	controllerRequestDetector,
	controllerResourceDetector,
	controllerModelDetector,
	requestPolicyDetector,
}

// buildRelations runs every detector over the PR's blocks and concatenates the
// edges. headDir is the PR's head worktree (worktreeDirs).
func buildRelations(dataDir string, pr int, blocks []Block) []relations.Relation {
	_, headDir := worktreeDirs(dataDir, pr)
	var out []relations.Relation
	for _, det := range relationDetectors {
		out = append(out, det(headDir, pr, blocks)...)
	}
	return out
}

// eventListenerDetector links a changed block that dispatches an event to the
// changed Listener::handle for that event. Both sides must be changed (both
// must be blocks of this PR) — that is the coupling rule. The event↔listener
// mapping is built robustly from three sources (union): the listener handle's
// own type-hint, the EventServiceProvider $listen array, and Event::listen
// calls. Matching is on short class names (both the dispatch site and the
// provider use short, `use`-imported names).
func eventListenerDetector(headDir string, pr int, blocks []Block) []relations.Relation {
	// Index the changed listener handle-blocks: by class short name (to combine
	// with the provider map) and by the event they handle (their type-hint).
	handleByClass := map[string]Block{}
	listenerByEvent := map[string][]Block{}
	for _, b := range blocks {
		if b.Side == SideOld || b.Name != "handle" || b.Class == "" || !isListenerBlock(b) {
			continue
		}
		short := shortName(b.Class)
		handleByClass[short] = b
		if ev := handleEventType(headDir, b); ev != "" {
			listenerByEvent[ev] = appendBlock(listenerByEvent[ev], b)
		}
	}

	// Fold in the provider mapping (event short → listener shorts) for any
	// listener whose handle is a changed block.
	for evShort, listenerShorts := range providerEventMap(headDir) {
		for _, ls := range listenerShorts {
			if hb, ok := handleByClass[ls]; ok {
				listenerByEvent[evShort] = appendBlock(listenerByEvent[evShort], hb)
			}
		}
	}
	if len(listenerByEvent) == 0 {
		return nil
	}

	// For each changed (new-side) block, scan its body for dispatched events and
	// link to any changed listener handle for that event.
	var out []relations.Relation
	seen := map[string]bool{}
	for _, b := range blocks {
		if b.Side == SideOld {
			continue
		}
		for _, site := range dispatchedEvents(headDir, b) {
			for _, listener := range listenerByEvent[site.event] {
				if listener.ID() == b.ID() {
					continue // no self-edge (a listener that re-dispatches its own event)
				}
				key := b.ID() + "\x00" + listener.ID()
				if seen[key] {
					continue
				}
				seen[key] = true
				out = append(out, relations.Relation{
					PR: pr, ParentID: b.ID(), ChildID: listener.ID(), Kind: relations.KindEventListener, Line: site.line,
				})
			}
		}
	}
	return out
}

// isListenerBlock reports whether b looks like an event listener (the class the
// handle() method lives on).
func isListenerBlock(b Block) bool {
	return b.Category == "LISTENER" ||
		strings.Contains(b.File, "Listeners") ||
		strings.HasSuffix(b.Class, "Listener") ||
		strings.HasSuffix(b.Class, "Subscriber")
}

var (
	reHandleParam = regexp.MustCompile(`function\s+handle\s*\(\s*\??([\\A-Za-z0-9_]+)\s+\$`)

	// Dispatch-site patterns. Over-collecting is harmless: a captured name that
	// is not a known event simply never matches listenerByEvent.
	reDispatchRegexes = []*regexp.Regexp{
		regexp.MustCompile(`\bevent\s*\(\s*new\s+([\\A-Za-z0-9_]+)`),                                // event(new X(
		regexp.MustCompile(`\bevent\s*\(\s*([\\A-Za-z0-9_]+)::class`),                               // event(X::class
		regexp.MustCompile(`([\\A-Za-z0-9_]+)::dispatch(?:Now|Sync|If|Unless|AfterResponse)?\s*\(`), // X::dispatch(
		regexp.MustCompile(`dispatch(?:Now|Sync|AfterResponse)?\s*\(\s*new\s+([\\A-Za-z0-9_]+)`),    // ->/Event:: dispatch(new X(
		regexp.MustCompile(`dispatch(?:Now|Sync|AfterResponse)?\s*\(\s*([\\A-Za-z0-9_]+)::class`),   // dispatch(X::class
	}
)

// handleEventType returns the short class name of the event a listener's
// handle(EventType $e) method type-hints, or "" if untyped.
func handleEventType(headDir string, b Block) string {
	src := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
	if src.Text == "" {
		return ""
	}
	m := reHandleParam.FindStringSubmatch(src.Text)
	if m == nil {
		return ""
	}
	return shortName(m[1])
}

// dispatchSite is one dispatched event found in a block's body, plus the
// absolute file line of the dispatch call — the anchor a resulting
// event_listener relation carries (relations.Relation.Line) so the frontend
// can scope/reorder the "Onderliggende code" panel by the reviewer's
// currently selected group/line (see detail-layout.md).
type dispatchSite struct {
	event string
	line  int
}

// dispatchedEvents returns the short class names (+ site line) of the events
// dispatched inside block b's (new-side) body.
func dispatchedEvents(headDir string, b Block) []dispatchSite {
	src := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
	if src.Text == "" {
		return nil
	}
	var out []dispatchSite
	seen := map[string]bool{}
	for _, re := range reDispatchRegexes {
		for _, m := range re.FindAllStringSubmatch(src.Text, -1) {
			ev := shortName(m[1])
			if ev == "" || seen[ev] {
				continue
			}
			seen[ev] = true
			out = append(out, dispatchSite{event: ev, line: matchLine(src.Text, m[0], src.Start)})
		}
	}
	return out
}

var (
	// $listen = [ Event::class => [ Listener::class, ... ], ... ]
	reListenBlock = regexp.MustCompile(`(?s)\$listen\s*=\s*\[(.*)\]\s*;`)
	reListenEntry = regexp.MustCompile(`(?s)([\\A-Za-z0-9_]+)::class\s*=>\s*\[(.*?)\]`)
	reClassRef    = regexp.MustCompile(`([\\A-Za-z0-9_]+)::class`)
	// Event::listen(Event::class, Listener::class) or ..., [Listener::class, ...]
	reEventListen = regexp.MustCompile(`(?s)Event::listen\s*\(\s*([\\A-Za-z0-9_]+)::class\s*,\s*(\[[^\]]*\]|[\\A-Za-z0-9_]+::class)`)
)

// providerEventMap scans the head worktree's *ServiceProvider.php files for
// event→listener mappings (short class names), from both the $listen array and
// Event::listen calls. Best-effort: unreadable/absent providers yield an empty
// map, and the type-hint source still carries the common case.
func providerEventMap(headDir string) map[string][]string {
	out := map[string][]string{}
	add := func(ev string, listeners []string) {
		ev = shortName(ev)
		if ev == "" {
			return
		}
		for _, l := range listeners {
			if ls := shortName(l); ls != "" {
				out[ev] = append(out[ev], ls)
			}
		}
	}

	skip := map[string]bool{"vendor": true, "node_modules": true, ".git": true, "storage": true, "public": true, "tests": true}
	_ = filepath.WalkDir(headDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skip[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), "ServiceProvider.php") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		text := string(raw)

		if lm := reListenBlock.FindStringSubmatch(text); lm != nil {
			for _, entry := range reListenEntry.FindAllStringSubmatch(lm[1], -1) {
				var listeners []string
				for _, c := range reClassRef.FindAllStringSubmatch(entry[2], -1) {
					listeners = append(listeners, c[1])
				}
				add(entry[1], listeners)
			}
		}
		for _, m := range reEventListen.FindAllStringSubmatch(text, -1) {
			var listeners []string
			for _, c := range reClassRef.FindAllStringSubmatch(m[2], -1) {
				listeners = append(listeners, c[1])
			}
			add(m[1], listeners)
		}
		return nil
	})
	return out
}

// shortName returns the last \-separated segment of a (possibly namespaced)
// class reference.
func shortName(class string) string {
	class = strings.TrimSpace(strings.TrimPrefix(class, `\`))
	if i := strings.LastIndex(class, `\`); i >= 0 {
		class = class[i+1:]
	}
	return class
}

// appendBlock appends b to list unless it is already present (by ID).
func appendBlock(list []Block, b Block) []Block {
	for _, x := range list {
		if x.ID() == b.ID() {
			return list
		}
	}
	return append(list, b)
}

// ── Laravel request-lifecycle detectors ─────────────────────────────────────
//
// Five "both-changed" detectors (like eventListenerDetector) derive the Laravel
// request chain: route → controller → request/resource/model, and request →
// policy. An edge is emitted only when BOTH endpoint blocks are changed
// (new-side) blocks of this PR — so an unchanged file never appears, and the
// highest level that IS changed becomes the tree root for free (the frontend's
// recomputeLeftList pulls every child out of the left list). Block bodies are
// read from the head worktree with extractBlockSource, exactly like the event
// detector. Middleware is deliberately out of scope.

// blockIndex indexes a PR's changed (new-side) blocks by short class name for
// quick "is this class/method a changed block?" lookups.
type blockIndex struct {
	byClass map[string][]Block
}

func indexChangedBlocks(blocks []Block) blockIndex {
	ix := blockIndex{byClass: map[string][]Block{}}
	for _, b := range blocks {
		if b.Side == SideOld {
			continue
		}
		ix.byClass[shortName(b.Class)] = append(ix.byClass[shortName(b.Class)], b)
	}
	return ix
}

// method returns the changed block for class::name, if any.
func (ix blockIndex) method(class, name string) (Block, bool) {
	for _, b := range ix.byClass[class] {
		if b.Name == name {
			return b, true
		}
	}
	return Block{}, false
}

// classMethods returns every changed method block of class whose category matches
// (category "" = any). Used where a reference names a class but no single method
// (an Eloquent model param, an apiResource, a request/resource whose changed
// methods all count as underlying code) — mirrors the model-granularity decision.
func (ix blockIndex) classMethods(class, category string) []Block {
	var out []Block
	for _, b := range ix.byClass[class] {
		if category == "" || b.Category == category {
			out = append(out, b)
		}
	}
	return out
}

// blockText reads block b's source from the head worktree (whole file for the
// whole-file ROUTE fallback block; the method body otherwise), plus the
// absolute line the returned text starts at (codeSide.Start — the real
// declaration line from a fresh scan, not b's own possibly-stale Line field).
// A detector converts a regex match's byte offset within Text to an absolute
// file line via matchLine(text, match, result.Start).
func blockText(headDir string, b Block) codeSide {
	return extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
}

// matchLine converts a byte offset within text — as blockText/
// extractBlockSource return it, starting at fromLine — to an absolute file
// line, by counting the newlines up to the first occurrence of match. This
// anchors a detector's regex match to a concrete line so the frontend can
// scope/reorder the "Onderliggende code" panel by the reviewer's selected
// group/line (see .claude/rules/detail-layout.md, "Group-herordening").
// Anchoring on the first occurrence of the literal matched text is
// approximate for a byte-identical repeated match — harmless here, since Line
// is a soft ordering/scoping hint, not an identity key.
func matchLine(text, match string, fromLine int) int {
	i := strings.Index(text, match)
	if i < 0 {
		return fromLine
	}
	return fromLine + strings.Count(text[:i], "\n")
}

// edgeEmitter dedupes parent→child edges (by ID) for one relation kind.
func edgeEmitter(out *[]relations.Relation, pr int, kind string) func(parent, child Block, line int) {
	seen := map[string]bool{}
	return func(parent, child Block, line int) {
		if parent.ID() == child.ID() {
			return
		}
		key := parent.ID() + "\x00" + child.ID()
		if seen[key] {
			return
		}
		seen[key] = true
		*out = append(*out, relations.Relation{PR: pr, ParentID: parent.ID(), ChildID: child.ID(), Kind: kind, Line: line})
	}
}

var (
	// [Foo\Bar::class, 'method'] — the modern array-callable route action.
	reArrayCallable = regexp.MustCompile(`\[\s*([\\A-Za-z0-9_]+)::class\s*,\s*['"]([A-Za-z0-9_]+)['"]`)
	// 'Foo\Bar@method' — the old string-callable action (namespace ignored via shortName).
	reStringCallable = regexp.MustCompile(`['"]([\\A-Za-z0-9_]+)@([A-Za-z0-9_]+)['"]`)
	// Route::apiResource('prefix', Foo::class) / resource(...) / apiSingleton(...),
	// including the old string-controller form Route::resource('prefix', 'Foo').
	reResourceRoute = regexp.MustCompile(`(?:api)?(?:[Rr]esource|[Ss]ingleton)\s*\(\s*['"][^'"]*['"]\s*,\s*(?:([\\A-Za-z0-9_]+)::class|['"]([\\A-Za-z0-9_]+)['"])`)

	// A FormRequest type-hinted parameter: `SomethingRequest $var`.
	reRequestParam = regexp.MustCompile(`([\\A-Za-z0-9_]*Request)\s+\$`)
	// An API Resource constructed in a controller body: new XResource( / XResource::make|collection(.
	reResourceUse = regexp.MustCompile(`new\s+([\\A-Za-z0-9_]+Resource)\s*\(|([\\A-Za-z0-9_]+Resource)::(?:make|collection)\s*\(`)
	// A Resource named as the method's return type: `): XResource` / `): ?XResource`.
	reResourceReturn = regexp.MustCompile(`\)\s*:\s*\??([\\A-Za-z0-9_]+Resource)\b`)
	// Any type-hinted parameter `Foo $var` (filtered to changed models afterwards).
	reTypedParam = regexp.MustCompile(`([\\A-Za-z0-9_]+)\s+\$`)
	// FormRequest::authorize policy check: ->can('ability', Policy::class) and the
	// array form ->can('ability', [Policy::class, ...]).
	reCanPolicy = regexp.MustCompile(`->\s*can\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*\[?\s*([\\A-Za-z0-9_]+)::class`)

	// $policies = [ Model::class => Policy::class, ... ] in an *ServiceProvider.
	rePoliciesBlock = regexp.MustCompile(`(?s)\$policies\s*=\s*\[(.*?)\]\s*;`)
	rePolicyEntry   = regexp.MustCompile(`([\\A-Za-z0-9_]+)::class\s*=>\s*([\\A-Za-z0-9_]+)::class`)
)

// routeControllerDetector links a changed route file to the changed controller
// methods it dispatches to (array-callable, string-callable, and resource routes).
func routeControllerDetector(headDir string, pr int, blocks []Block) []relations.Relation {
	ix := indexChangedBlocks(blocks)
	var out []relations.Relation
	emit := edgeEmitter(&out, pr, relations.KindRouteController)
	for _, route := range blocks {
		if route.Side == SideOld || route.Category != "ROUTE" {
			continue
		}
		src := blockText(headDir, route)
		text := src.Text
		if text == "" {
			continue
		}
		for _, m := range reArrayCallable.FindAllStringSubmatch(text, -1) {
			if b, ok := ix.method(shortName(m[1]), m[2]); ok && b.Category == "CONTROLLER" {
				emit(route, b, matchLine(text, m[0], src.Start))
			}
		}
		for _, m := range reStringCallable.FindAllStringSubmatch(text, -1) {
			if b, ok := ix.method(shortName(m[1]), m[2]); ok && b.Category == "CONTROLLER" {
				emit(route, b, matchLine(text, m[0], src.Start))
			}
		}
		// Resource routes name a controller with implicit REST methods → link to
		// every changed method of that controller.
		for _, m := range reResourceRoute.FindAllStringSubmatch(text, -1) {
			ctrl := m[1]
			if ctrl == "" {
				ctrl = m[2]
			}
			line := matchLine(text, m[0], src.Start)
			for _, b := range ix.classMethods(shortName(ctrl), "CONTROLLER") {
				emit(route, b, line)
			}
		}
	}
	return out
}

// controllerRequestDetector links a changed controller method to the changed
// FormRequest it type-hints as a parameter.
func controllerRequestDetector(headDir string, pr int, blocks []Block) []relations.Relation {
	ix := indexChangedBlocks(blocks)
	var out []relations.Relation
	emit := edgeEmitter(&out, pr, relations.KindControllerRequest)
	for _, ctrl := range blocks {
		if ctrl.Side == SideOld || ctrl.Category != "CONTROLLER" {
			continue
		}
		src := blockText(headDir, ctrl)
		text := src.Text
		if text == "" {
			continue
		}
		for _, m := range reRequestParam.FindAllStringSubmatch(text, -1) {
			line := matchLine(text, m[0], src.Start)
			for _, b := range ix.classMethods(shortName(m[1]), "REQUEST") {
				emit(ctrl, b, line)
			}
		}
	}
	return out
}

// controllerResourceDetector links a changed controller method to the changed
// API Resource it returns or builds (new XResource / XResource::make|collection /
// a `): XResource` return type).
func controllerResourceDetector(headDir string, pr int, blocks []Block) []relations.Relation {
	ix := indexChangedBlocks(blocks)
	var out []relations.Relation
	emit := edgeEmitter(&out, pr, relations.KindControllerResource)
	for _, ctrl := range blocks {
		if ctrl.Side == SideOld || ctrl.Category != "CONTROLLER" {
			continue
		}
		src := blockText(headDir, ctrl)
		text := src.Text
		if text == "" {
			continue
		}
		link := func(name string, line int) {
			for _, b := range ix.classMethods(shortName(name), "RESOURCE") {
				emit(ctrl, b, line)
			}
		}
		for _, m := range reResourceUse.FindAllStringSubmatch(text, -1) {
			line := matchLine(text, m[0], src.Start)
			if m[1] != "" {
				link(m[1], line)
			} else {
				link(m[2], line)
			}
		}
		for _, m := range reResourceReturn.FindAllStringSubmatch(text, -1) {
			link(m[1], matchLine(text, m[0], src.Start))
		}
	}
	return out
}

// controllerModelDetector links a changed controller method to the changed
// Eloquent model it route-model-binds as a parameter — every changed method of
// that model class surfaces as underlying code (the agreed model granularity).
func controllerModelDetector(headDir string, pr int, blocks []Block) []relations.Relation {
	ix := indexChangedBlocks(blocks)
	var out []relations.Relation
	emit := edgeEmitter(&out, pr, relations.KindControllerModel)
	for _, ctrl := range blocks {
		if ctrl.Side == SideOld || ctrl.Category != "CONTROLLER" {
			continue
		}
		src := blockText(headDir, ctrl)
		text := src.Text
		if text == "" {
			continue
		}
		seen := map[string]bool{}
		for _, m := range reTypedParam.FindAllStringSubmatch(text, -1) {
			short := shortName(m[1])
			if seen[short] {
				continue
			}
			seen[short] = true
			line := matchLine(text, m[0], src.Start)
			for _, b := range ix.classMethods(short, "MODEL") {
				emit(ctrl, b, line)
			}
		}
	}
	return out
}

// requestPolicyDetector links a changed FormRequest (its authorize() method) to
// the changed Policy method it checks. A direct Policy::class reference resolves
// straight away; a Model::class reference resolves to its Policy via the
// AuthServiceProvider $policies map, then the App\Policies\{Model}Policy
// convention. The policy method is the ability name (`->can('show', …)` → show).
func requestPolicyDetector(headDir string, pr int, blocks []Block) []relations.Relation {
	ix := indexChangedBlocks(blocks)
	var out []relations.Relation
	emit := edgeEmitter(&out, pr, relations.KindRequestPolicy)
	var modelPolicy map[string]string // built lazily on the first Model::class ref
	for _, req := range blocks {
		if req.Side == SideOld || req.Category != "REQUEST" {
			continue
		}
		src := blockText(headDir, req)
		text := src.Text
		if text == "" {
			continue
		}
		for _, m := range reCanPolicy.FindAllStringSubmatch(text, -1) {
			ability, cls := m[1], shortName(m[2])
			policy := cls
			if !strings.HasSuffix(cls, "Policy") {
				if modelPolicy == nil {
					modelPolicy = policiesMap(headDir)
				}
				if p, ok := modelPolicy[cls]; ok {
					policy = p
				} else {
					policy = cls + "Policy"
				}
			}
			if b, ok := ix.method(shortName(policy), ability); ok && isPolicyBlock(b) {
				emit(req, b, matchLine(text, m[0], src.Start))
			}
		}
	}
	return out
}

// isPolicyBlock reports whether b is an authorization policy method.
func isPolicyBlock(b Block) bool {
	return b.Category == "POLICY" ||
		strings.Contains(b.File, "app/Policies/") ||
		strings.HasSuffix(b.Class, "Policy")
}

// policiesMap scans the head worktree's *ServiceProvider.php files for a
// $policies = [ Model::class => Policy::class ] map (short class names).
// Best-effort — an absent/unreadable provider yields an empty map, and the
// {Model}Policy convention still covers the common case.
func policiesMap(headDir string) map[string]string {
	out := map[string]string{}
	skip := map[string]bool{"vendor": true, "node_modules": true, ".git": true, "storage": true, "public": true, "tests": true}
	_ = filepath.WalkDir(headDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skip[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), "ServiceProvider.php") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if bm := rePoliciesBlock.FindStringSubmatch(string(raw)); bm != nil {
			for _, e := range rePolicyEntry.FindAllStringSubmatch(bm[1], -1) {
				out[shortName(e[1])] = shortName(e[2])
			}
		}
		return nil
	})
	return out
}
