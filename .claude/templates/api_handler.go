// Template: an /api/*-bridge handler. Go built-ins only.
//
// The bridge shells out to local CLIs (gh, claude). Rules:
//   - Validate/whitelist ALL input before it goes to os/exec — never pass raw
//     user input as a shell string; use exec.Command with separate args.
//   - Set a context timeout on every subprocess.
//   - Respond with JSON; set Content-Type explicitly.

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"time"
)

// handleExample bridges an /api/<feature> request to a local CLI.
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
	// TODO: validate req (e.g. PR > 0) before using it in a subprocess.

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Separate args — no string interpolation in a shell.
	cmd := exec.CommandContext(ctx, "gh", "pr", "view", itoa(req.PR), "--json", "title,body")
	out, err := cmd.Output()
	if err != nil {
		http.Error(w, "upstream failed", http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}
