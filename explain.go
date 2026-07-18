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

// explainPrompt builds the context-only Haiku prompt: explain, in Dutch and in
// 1-2 sentences, what the if-condition in the selected lines checks and when
// its branch runs. The unit code plus the surrounding block source travel in
// the prompt — no tools, no worktree access.
func explainPrompt(in ExplainCodeInput) string {
	var b strings.Builder
	b.WriteString("Je helpt een code-reviewer. De geselecteerde regel(s) hieronder bevatten een if-statement.\n")
	b.WriteString("Leg in het Nederlands, in 1-2 korte zinnen, uit wat de conditie controleert en wanneer de tak loopt.\n")
	b.WriteString("Antwoord met alleen die zinnen — geen opsomming, geen markdown, geen aanhalingstekens.\n\n")
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
