package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"slash/modules/callresolve"
	"slash/modules/claude"
)

// resolveCallMaxConcurrentCLI bounds the number of `claude` CLI subprocesses
// that resolveCallsWithModel may have running AT ONCE, PROCESS-WIDE — shared
// by every resolve_call run, not one semaphore per run/Activity. Without a
// shared cap, resolving several calls within one caller concurrently (see the
// goroutine loop below) and starting several callers' resolve_call Executions
// concurrently (autoStartResolveCall, workflows.go) would multiply each
// other's concurrency instead of adding to a single bounded pool.
//
// Chosen conservatively (4), not maximized, based on measured evidence rather
// than a guess: two resolve_call Executions running concurrently (PR 13381,
// 2026-08-14 13:45-13:57, ~11-12 minutes each for only 3 calls) were also
// overlapped by a live agentic code_warning run — but even so, per-call time
// there was roughly 7x the ~30s "typical" a single Haiku call takes
// (modules/claude/claude.go's contextTimeout doc). That is evidence that this
// machine/account cannot absorb a large burst of concurrent `claude`
// processes without each one slowing down — raising the cap much further
// risks amplifying exactly the contention that produced that outlier, instead
// of fixing it. 4 is a deliberate middle ground: enough to meaningfully
// parallelize a caller with a handful of unresolved calls (the common case,
// see .claude/docs/workflows-analysis.md's own examples), while still capping
// how many `claude` processes can pile up when several callers' searches
// start at once (groupUnresolvedCalls/autoStartResolveCall).
//
// resolveCallSemaphore is the shared pool resolveCallsWithModel's goroutines
// acquire a slot from before running `cl.Run` — a buffered channel used as a
// counting semaphore, process-wide by virtue of being a package-level var. A
// test that needs a different cap must replace the channel itself (its
// capacity is fixed at creation), not just re-point a separate size var.
var resolveCallSemaphore = make(chan struct{}, 4)

// This file is the LLM side of call resolution (package main; it reads the head
// worktree and shells out to the claude CLI, so it runs only inside a
// resolve_call Activity). Haiku disambiguates from the Go-built candidate
// shortlist (context-only); Sonnet searches the worktree agentically. Every
// claim is verified against the worktree before it is trusted.

// resolveArg is the payload of the resolveWithModel Activity.
type resolveArg struct {
	// Repo is the canonical repo string ("" = the primary repo, see repos.go).
	Repo        string   `json:"repo,omitempty"`
	PR          int      `json:"pr"`
	CallerID    string   `json:"callerId"`
	CallerFile  string   `json:"callerFile"`
	CallerClass string   `json:"callerClass"`
	CallerName  string   `json:"callerName"`
	Calls       []string `json:"calls"`
	Model       string   `json:"model"` // claude.ModelHaiku | claude.ModelSonnet
}

// vendorBuiltinNames is a small, curated denylist of extremely common
// PHPUnit/Laravel/PHP built-in method names that are never defined in an
// app's own worktree — their source lives in vendor/ (not committed) or is a
// PHP language builtin. A token study of PR 12895 found that these names
// (Laravel's HTTP-test DSL, the Schema migration Blueprint, native enum
// ::cases()) accounted for the overwhelming majority of resolve_call's LLM
// spend, none of which either Haiku or the agentic Sonnet pass could ever
// resolve — there is nothing in the worktree for either model to find. This
// denylist only ever applies when the Go index also found zero static
// candidates (see resolveCallsWithModel below): it can therefore never
// suppress a genuine app-defined match with the same name — if the app did
// define e.g. its own "table" method somewhere, candidates() would be
// non-empty and the call would follow the normal LLM path untouched.
var vendorBuiltinNames = map[string]bool{
	// PHPUnit/Laravel HTTP-test DSL.
	"assertStatus": true, "postJson": true, "getJson": true, "putJson": true,
	"patchJson": true, "deleteJson": true, "assertDatabaseHas": true,
	// Schema migration Blueprint.
	"nullable": true, "unique": true, "dropColumn": true, "dropIndex": true,
	"softDeletes": true, "table": true,
	// PHP language builtin (native enum method).
	"cases": true,
}

// isVendorBuiltin reports whether call is a well-known vendor/framework/PHP
// builtin method name that can never resolve to app code — either an exact
// vendorBuiltinNames match, or any "assertJson*" PHPUnit assertion.
func isVendorBuiltin(call string) bool {
	return vendorBuiltinNames[call] || strings.HasPrefix(call, "assertJson")
}

// llmAnswer is the JSON shape we ask the model to emit.
type llmAnswer struct {
	Found      bool   `json:"found"`
	File       string `json:"file"`
	Class      string `json:"class"`
	Method     string `json:"method"`
	Confidence string `json:"confidence"` // high | low
}

// resolveCallsWithModel resolves each call in arg with one model and returns one
// callresolve.Entry per call (found — verified against the worktree — or
// notfound). Never returns an error: a model/CLI failure degrades to notfound so
// the workflow always completes (best-effort, like the github activities).
//
// Each call's `claude` CLI invocation runs in its own goroutine — the calls
// are otherwise fully independent (different prompt, no shared mutable state
// beyond writing to out[i]) — bounded by resolveCallSemaphore so the actual
// number of concurrent CLI subprocesses stays capped process-wide. This is
// purely an internal speedup of a single Activity: the Activity is still
// called exactly once from resolveCallWorkflow and its (now faster) result is
// recorded as one event, same as before, so nothing about the workflow's own
// determinism (see .claude/rules/workflow-determinism.md) changes — a replay
// just returns the already-recorded result rather than re-running any of
// this. out is written by index so the result order still matches arg.Calls
// regardless of which goroutine finishes first.
func resolveCallsWithModel(ctx context.Context, cl claude.Client, dataDir string, arg resolveArg) []callresolve.Entry {
	_, headDir := worktreeDirs(dataDir, arg.Repo, arg.PR)
	idx := buildSymbolIndex(headDir)
	agentic := arg.Model == claude.ModelSonnet
	shortModel := callresolve.ModelHaiku
	if agentic {
		shortModel = callresolve.ModelSonnet
	}

	callerSrc := extractBlockSource(filepath.Join(headDir, arg.CallerFile), arg.CallerFile, arg.CallerClass, arg.CallerName)

	out := make([]callresolve.Entry, len(arg.Calls))
	var wg sync.WaitGroup
	for i, call := range arg.Calls {
		cands := idx.candidates(call)
		entry := callresolve.Entry{
			PR: arg.PR, CallerID: arg.CallerID, CallKey: call,
			Status: callresolve.StatusNotfound, Model: shortModel,
			HadCandidates: len(cands) > 0,
		}

		// A known vendor/framework builtin with zero static candidates can
		// never resolve — skip the model call entirely (saves the Haiku
		// spend too, and never shows the "Zoeken…" affordance for something
		// that will never find anything). No CLI call, so no goroutine/slot
		// needed.
		if len(cands) == 0 && isVendorBuiltin(call) {
			out[i] = entry
			continue
		}

		req := claude.RunRequest{
			Model:        arg.Model,
			Prompt:       resolvePrompt(arg, call, cands, callerSrc.Text, agentic),
			SystemPrompt: claude.ResolveCallSystemPrompt,
		}
		if agentic {
			req.WorkDir = headDir
			req.Tools = []string{"Read", "Grep", "Glob"}
		}

		if cl == nil {
			out[i] = entry
			continue
		}

		wg.Add(1)
		go func(i int, req claude.RunRequest, entry callresolve.Entry) {
			defer wg.Done()
			select {
			case resolveCallSemaphore <- struct{}{}:
			case <-ctx.Done():
				out[i] = entry
				return
			}
			defer func() { <-resolveCallSemaphore }()

			if raw, err := cl.Run(ctx, req); err == nil {
				if ans, ok := parseLLMAnswer(raw); ok && ans.Found {
					if code, cls, method, line, ok := verifyDefinition(headDir, ans); ok {
						entry.Status = callresolve.StatusFound
						entry.Confidence = ans.Confidence
						entry.ChildFile = ans.File
						entry.ChildClass = cls
						entry.ChildMethod = method
						entry.ChildLine = line
						entry.ChildCode = code
					}
				}
			}
			out[i] = entry
		}(i, req, entry)
	}
	wg.Wait()
	return out
}

// resolvePrompt builds the call-specific part of the model prompt: the call to
// resolve, the caller body for context, and the Go candidate shortlist. For
// the agentic (Sonnet) variant it invites the model to search the checked-out
// repo. The call-independent task framing and JSON contract are static across
// every call of this action, so they travel separately as
// claude.ResolveCallSystemPrompt (--append-system-prompt) instead of being
// rebuilt here — see resolveCallsWithModel and modules/claude/prompts.go.
func resolvePrompt(arg resolveArg, call string, cands []Block, callerBody string, agentic bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Call to resolve: `%s(...)` made inside %s::%s (file %s).\n\n",
		call, arg.CallerClass, arg.CallerName, arg.CallerFile)
	if callerBody != "" {
		fmt.Fprintf(&b, "Caller body:\n```php\n%s\n```\n\n", clip(callerBody, 4000))
	}
	b.WriteString("This is a Laravel/Eloquent codebase. The reference may be written **without parentheses** as a magic property — `$order->billingAddress` — which resolves to the relationship method `billingAddress()` on the model (a method whose body returns `$this->hasMany(...)`, `morphOne(...)`, `belongsTo(...)`, …), or to an accessor `getBillingAddressAttribute()`. Treat `->" + call + "` and `" + call + "()` as the same target. The receiver variable name is a strong hint for the class: `$order->" + call + "` almost always lives on the `Order` model, `$invoice->…` on `Invoice`, `$this->…` on the caller's own class. Use that to pick the right definition when several classes define `" + call + "`.\n\n")
	if len(cands) > 0 {
		b.WriteString("Candidate definitions found statically (pick the correct one if any fits):\n")
		for _, c := range cands {
			fmt.Fprintf(&b, "- %s::%s  (file %s, line %d)\n", c.Class, c.Name, c.File, c.Line)
		}
		b.WriteString("\n")
	}
	if agentic {
		b.WriteString("You may use the Read, Grep and Glob tools to search this checked-out repository for the definition (e.g. a Laravel query scope `scope" + ucfirst(call) + "`, a trait method, or a parent-class method).\n\n")
	} else if len(cands) == 0 {
		b.WriteString("No static candidates were found. If you cannot determine the definition from the caller body alone, answer found=false.\n\n")
	}
	return b.String()
}

// parseLLMAnswer extracts the first {...} JSON object from the model output
// (models sometimes wrap it in prose or fences) and unmarshals it.
func parseLLMAnswer(raw string) (llmAnswer, bool) {
	start := strings.IndexByte(raw, '{')
	end := strings.LastIndexByte(raw, '}')
	if start < 0 || end <= start {
		return llmAnswer{}, false
	}
	var ans llmAnswer
	if err := json.Unmarshal([]byte(raw[start:end+1]), &ans); err != nil {
		return llmAnswer{}, false
	}
	return ans, true
}

// verifyDefinition checks the model's claimed definition against the worktree:
// the file must stay within headDir (the model output is untrusted) and the
// (class,method) block must actually exist there. Returns the real source, the
// resolved class/method, and the declaration line.
func verifyDefinition(headDir string, ans llmAnswer) (code, class, method string, line int, ok bool) {
	full, rel, ok := resolveWithinWorktree(headDir, ans.File)
	if !ok {
		return "", "", "", 0, false
	}
	src := enrichedCodeSide(extractBlockSource(full, rel, ans.Class, ans.Method))
	if src.Text == "" {
		return "", "", "", 0, false
	}
	return src.Text, ans.Class, ans.Method, src.Start, true
}

func ucfirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n… (truncated)"
}

// resolveCallRunID derives a deterministic, filename-safe Run ID from the
// caller + the exact set of calls being searched (mirrors explainRunID).
// StartWorkflowID then dedups repeated starts for the identical request —
// whether it comes from the frontend's own "Zoek" trigger (startCallSearch,
// home.mjs) or from the automatic server-side trigger (autoStartResolveCall,
// workflows.go) — while a genuinely different Calls set (a new unresolved call
// surfaced by a rebuild) always yields a fresh Run ID/Execution. Calls is
// sorted before hashing so the ID doesn't depend on the order the caller
// happened to build the slice in (a Go map iteration, or whatever order a
// client sent). The raw key contains slashes/colons (a caller ID embeds a file
// path), so it's hashed rather than embedded — Run IDs double as JSONL store
// filenames.
//
// in.Attempt (the search generation, see maxResolveCallAttempts) joins the key
// only when it is > 0, so a generation-0 ID stays byte-identical to every Run
// ID minted before that field existed — the hash-stability requirement
// repos.go documents for exactly this reason. That single suffix is what makes
// the one extra retry round possible at all: re-asking the same call set is
// otherwise, by design, an idempotent no-op.
func resolveCallRunID(in ResolveCallInput) string {
	calls := append([]string(nil), in.Calls...)
	sort.Strings(calls)
	key := fmt.Sprintf("%d|%s|%s", in.PR, in.CallerID, strings.Join(calls, ","))
	if in.Attempt > 0 {
		key = fmt.Sprintf("%s|attempt=%d", key, in.Attempt)
	}
	sum := sha256.Sum256([]byte(key))
	return "rslv-" + hex.EncodeToString(sum[:12])
}

// maxResolveCallAttempts caps how many times ONE (callerId, callKey) pair may
// ever be submitted to a resolve_call Execution: 2, i.e. the original pass plus
// exactly one retry round. The retry exists because a `notfound` answer used to
// be forgotten by callresolve.UpsertGo on every rebuild (see its doc comment),
// leaving rows sitting at `unresolved` with no run left that would ever pick
// them up again — the frontend then showed a permanent "zoeken…" pill for a
// search nobody was running (reported on PR 13431). Those rows are given one
// more, deliberately paid-for LLM pass; with UpsertGo now preserving
// `notfound`, that answer sticks and the pair never returns here.
//
// The cap is what keeps this bounded instead of turning every rebuild into a
// fresh round: it is counted from the durable workflow history
// (resolveCallAttempts, workflows.go), so it survives a restart and cannot be
// reset by a read-model rewrite. Raising it later is a one-constant change,
// and each new generation gets its own Run ID (resolveCallRunID above).
const maxResolveCallAttempts = 2

// groupUnresolvedCalls turns the Go resolver's freshly scanned entries into one
// ResolveCallInput per caller AND search generation — the payload the automatic
// server-side search trigger (autoStartResolveCall, workflows.go) starts a
// resolve_call Execution for. A call is included when it is currently
// Unresolved and has been submitted to a resolve_call Execution FEWER than
// maxResolveCallAttempts times: attempts counts, per (callerId, callKey), how
// often that pair has appeared in a resolve_call Execution's input for this PR
// (resolveCallAttempts, workflows.go — reads the durable workflow event
// history, not the callresolve read-model's own status column). The history is
// the right source because it never forgets: a read-model status can be
// rewritten by a rebuild, and it was exactly such a rewrite (UpsertGo dropping
// an answered notfound back to unresolved, since fixed narrowly — see its doc
// comment) that stranded rows at unresolved with no run left to pick them up.
//
// A pair's own count becomes the group's Attempt, which resolveCallRunID folds
// into the Run ID — so the retry round is a real, separate Execution while
// re-asking the SAME generation stays the idempotent no-op it has always been.
// Calls are therefore grouped per (callerId, generation), not just per caller:
// every call in one input then truthfully shares that input's Attempt, which is
// what the next run's count reads back.
//
// The retry is deliberately narrow: an already-attempted call is only re-asked
// when the STORED row (stored: the read-model's current status per pair, keyed
// the same way as attempts) is still `unresolved` — i.e. genuinely STRANDED,
// with no answer to show for its earlier attempt. `calls` is this rebuild's
// fresh Go scan, which reports every unpinnable call as unresolved regardless
// of what the LLM already answered, so without the stored status a rebuild
// would hand EVERY answered call a second LLM pass instead of only the ones
// that lost their answer. A row that is `notfound`/`found` (an answer survives,
// see callresolve.UpsertGo) or `searching` (a run is in flight) is left alone.
// A never-attempted call needs no stored row at all — UpsertGo has just written
// it as unresolved anyway.
//
// A caller whose block id isn't in blocks (defensive — should not happen, Prune
// keeps callresolve's callers in lockstep with the PR's blocks) is skipped.
// Pure and deterministic (map iteration never drives the output order — `order`
// does), so it's directly unit-testable without the engine/goroutine.
func groupUnresolvedCalls(pr int, calls []callresolve.Entry, attempts map[string]int, stored map[string]string, blocks []Block) []ResolveCallInput {
	byID := make(map[string]Block, len(blocks))
	for _, b := range blocks {
		byID[b.ID()] = b
	}

	// One group per caller AND generation: a caller can hold both a
	// never-searched call (generation 0) and one that already had its first
	// pass (generation 1), and mixing those in one input would misreport the
	// Attempt of half of them.
	type callerGen struct {
		callerID string
		attempt  int
	}
	callsByGroup := map[callerGen][]string{}
	var order []callerGen
	for _, e := range calls {
		if e.Status != callresolve.StatusUnresolved {
			continue
		}
		key := e.CallerID + "\x1f" + e.CallKey
		n := attempts[key]
		if n >= maxResolveCallAttempts {
			continue // already had its search plus its one retry — never ask again
		}
		if s, ok := stored[key]; n > 0 && (!ok || s != callresolve.StatusUnresolved) {
			continue // already searched and its answer still stands — not stranded
		}
		g := callerGen{callerID: e.CallerID, attempt: n}
		if _, ok := callsByGroup[g]; !ok {
			order = append(order, g)
		}
		callsByGroup[g] = append(callsByGroup[g], e.CallKey)
	}

	out := make([]ResolveCallInput, 0, len(order))
	for _, g := range order {
		b, ok := byID[g.callerID]
		if !ok {
			continue
		}
		cs := callsByGroup[g]
		sort.Strings(cs)
		out = append(out, ResolveCallInput{
			PR: pr, CallerID: g.callerID, CallerFile: b.File,
			CallerClass: b.Class, CallerName: b.Name, Calls: cs,
			Attempt: g.attempt,
		})
	}
	return out
}
