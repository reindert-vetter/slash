package jira

// transition.go — the second WRITE this module can do, next to AddComment
// (comments.go): moving an issue to another workflow status.
//
// WHY `acli` AND NOT REST, unlike AddComment next door: the documented REST
// route needs the numeric TRANSITION id of the target status
// (GET /rest/api/3/issue/{key}/transitions, then POST that id), so it is two
// round trips plus a name→id match that differs per project workflow. `acli
// jira workitem transition --key K --status "In Progress"` does exactly that
// match server-side, on the same CLI credentials Issue()/Search() already use.
// A status the issue's own workflow cannot reach from where it is fails there,
// which is what the one caller treats as best-effort.
//
// Only called from the plan tracker's jiraStartProgress Activity — never from
// an HTTP handler or the UI (.claude/rules/workflows-write-boundary.md).

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

// statusNamePattern bounds the status name before it reaches exec: Jira's own
// status names are words, digits, spaces and the odd dash/slash. Same
// "validate before it leaves the process" rule keyPattern applies to a key —
// the argument is passed as one argv entry (never a shell string), so this is
// belt and braces, but the caller's own constants must stay the only shapes
// that ever get through.
var statusNamePattern = regexp.MustCompile(`^[A-Za-z0-9 /_-]{1,60}$`)

// Transition moves key to the status named status. It returns an error when
// `acli` refuses — most commonly because that status is not reachable from the
// issue's current one (including "it is already there"), which the caller
// treats as nothing to do rather than as a failure worth sinking a workflow
// for.
func (m *Module) Transition(ctx context.Context, key, status string) error {
	if !keyPattern.MatchString(key) {
		return fmt.Errorf("jira: invalid issue key %q", key)
	}
	status = strings.TrimSpace(status)
	if !statusNamePattern.MatchString(status) {
		return fmt.Errorf("jira: invalid status %q", status)
	}
	ctx, cancel := context.WithTimeout(ctx, cliTimeout)
	defer cancel()
	// --yes so acli never waits for an interactive confirmation (there is no
	// TTY to answer it, and a workflow Activity runs inline — see cliTimeout).
	cmd := exec.CommandContext(ctx, "acli", "jira", "workitem", "transition",
		"--key", key, "--status", status, "--yes")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if _, err := cmd.Output(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("acli jira workitem transition: %w: %s", err, msg)
		}
		return fmt.Errorf("acli jira workitem transition: %w", err)
	}
	return nil
}
