package main

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"slash/modules/callresolve"
	"slash/modules/claude"
)

// This file is the LLM side of call resolution (package main; it reads the head
// worktree and shells out to the claude CLI, so it runs only inside a
// resolve_call Activity). Haiku disambiguates from the Go-built candidate
// shortlist (context-only); Sonnet searches the worktree agentically. Every
// claim is verified against the worktree before it is trusted.

// resolveArg is the payload of the resolveWithModel Activity.
type resolveArg struct {
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
func resolveCallsWithModel(ctx context.Context, cl claude.Client, dataDir string, arg resolveArg) []callresolve.Entry {
	_, headDir := worktreeDirs(dataDir, arg.PR)
	idx := buildSymbolIndex(headDir)
	agentic := arg.Model == claude.ModelSonnet
	shortModel := callresolve.ModelHaiku
	if agentic {
		shortModel = callresolve.ModelSonnet
	}

	callerSrc := extractBlockSource(filepath.Join(headDir, arg.CallerFile), arg.CallerFile, arg.CallerClass, arg.CallerName)

	out := make([]callresolve.Entry, 0, len(arg.Calls))
	for _, call := range arg.Calls {
		cands := idx.candidates(call)
		entry := callresolve.Entry{
			PR: arg.PR, CallerID: arg.CallerID, CallKey: call,
			Status: callresolve.StatusNotfound, Model: shortModel,
			HadCandidates: len(cands) > 0,
		}

		// A known vendor/framework builtin with zero static candidates can
		// never resolve — skip the model call entirely (saves the Haiku
		// spend too, and never shows the "Zoeken…" affordance for something
		// that will never find anything).
		if len(cands) == 0 && isVendorBuiltin(call) {
			out = append(out, entry)
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

		if cl != nil {
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
		}
		out = append(out, entry)
	}
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
