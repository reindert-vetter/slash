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
		for _, ev := range dispatchedEvents(headDir, b) {
			for _, listener := range listenerByEvent[ev] {
				if listener.ID() == b.ID() {
					continue // no self-edge (a listener that re-dispatches its own event)
				}
				key := b.ID() + "\x00" + listener.ID()
				if seen[key] {
					continue
				}
				seen[key] = true
				out = append(out, relations.Relation{
					PR: pr, ParentID: b.ID(), ChildID: listener.ID(), Kind: relations.KindEventListener,
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

// dispatchedEvents returns the short class names of the events dispatched inside
// block b's (new-side) body.
func dispatchedEvents(headDir string, b Block) []string {
	src := extractBlockSource(filepath.Join(headDir, b.File), b.File, b.Class, b.Name)
	if src.Text == "" {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, re := range reDispatchRegexes {
		for _, m := range re.FindAllStringSubmatch(src.Text, -1) {
			ev := shortName(m[1])
			if ev == "" || seen[ev] {
				continue
			}
			seen[ev] = true
			out = append(out, ev)
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
