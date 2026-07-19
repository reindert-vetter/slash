// explain.go — helpers for the explain_code workflow: the Dutch prompt asking
// Haiku to describe the if-statement inside a selected navigation unit, and
// the deterministic Run ID that makes a repeated start for the same unit+code
// an idempotent no-op (see StartExplainCode in workflows.go).
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// explainRunID derives a deterministic, filename-safe Run ID from the unit's
// identity + content hash. StartWorkflowID then dedups repeated starts: the
// same unit with the same code never triggers a second LLM call, while a new
// commit (new hash) yields a fresh Execution. The raw key contains slashes and
// colons (block IDs embed file paths), so it is hashed rather than embedded —
// Run IDs double as JSONL store filenames.
func explainRunID(in ExplainCodeInput) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d|%s|%s|%s", in.PR, in.BlockID, in.UnitKey, in.CodeHash)))
	return "expl-" + hex.EncodeToString(sum[:12])
}

// explainPrompt builds the call-specific part of the context-only Haiku
// prompt: the unit code plus the surrounding block source — no tools, no
// worktree access. The call-independent task framing (explain, in Dutch, in
// 1-2 sentences, what the if-condition checks and when its branch runs) is
// static across every call of this action, so it travels separately as
// claude.ExplainCodeSystemPrompt (--append-system-prompt) — see the
// generateExplanation Activity in workflows.go and modules/claude/prompts.go.
func explainPrompt(in ExplainCodeInput) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Bestand: %s\n", in.File)
	if in.Label != "" {
		fmt.Fprintf(&b, "Functie: %s\n", in.Label)
	}
	fmt.Fprintf(&b, "\nGeselecteerde regel(s):\n%s\n", in.Code)
	if in.Context != "" {
		fmt.Fprintf(&b, "\nOmringende code van de functie (context):\n%s\n", in.Context)
	}
	return b.String()
}
