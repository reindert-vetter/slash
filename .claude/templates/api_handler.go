// Template: een /api/*-bridge handler. Alleen Go built-ins.
//
// De bridge shelt uit naar lokale CLI's (gh, claude). Regels:
//   - Valideer/whitelist ALLE input voordat het naar os/exec gaat — geef nooit
//     rauwe user-input door als shell-string; gebruik exec.Command met losse args.
//   - Zet een context-timeout op elk subproces.
//   - Antwoord met JSON; zet Content-Type expliciet.

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"time"
)

// handleExample bridget een /api/<feature>-request naar een lokale CLI.
func handleExample(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		PR int `json:"pr"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// TODO: valideer req (bv. PR > 0) vóór gebruik in een subproces.

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Losse args — geen string-interpolatie in een shell.
	cmd := exec.CommandContext(ctx, "gh", "pr", "view", itoa(req.PR), "--json", "title,body")
	out, err := cmd.Output()
	if err != nil {
		http.Error(w, "upstream failed", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}
