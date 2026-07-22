package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// envFile is the local, gitignored config file loaded into the environment at
// startup. See .env.example for the documented variables.
const envFile = ".env"

// loadDotEnv loads KEY=VALUE pairs from a .env file into the process
// environment (built-ins only, no dependency). A variable already set in the
// real environment wins — .env only fills the gaps. A missing .env is not an
// error (fresh checkout, CI, tests).
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue // the real environment takes precedence
		}
		_ = os.Setenv(key, val)
	}
}

// isInteractive reports whether stdin is a real terminal, so a non-interactive
// run (CI, tests, piped stdin, a spawned server) is never blocked by — nor
// pollutes the tree with — a setup prompt.
func isInteractive() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	if fi.Mode()&os.ModeCharDevice == 0 {
		return false // pipe, regular file or socket — not a terminal
	}
	// A char device that is /dev/null is not a real terminal: it's the common
	// stdin for spawned/CI processes (e.g. Playwright's per-worker server), and
	// on macOS /dev/null itself is a char device, so the ModeCharDevice check
	// alone lets it through. os.SameFile is portable and dependency-free.
	if devnull, derr := os.Stat(os.DevNull); derr == nil && os.SameFile(fi, devnull) {
		return false
	}
	return true
}

// ensureEnvSetup runs a one-time interactive setup when the machine-specific
// config is missing. It asks the user for the target repo clone path, writes it
// to .env (gitignored) and loads it into the environment. It is skipped — the
// built-in default (~/dev/plug-and-pay) then applies — when a .env already
// exists, when SLASH_REPO_DIR is already set (real env or an earlier .env
// load), or when not attached to a terminal.
func ensureEnvSetup() {
	if _, err := os.Stat(envFile); err == nil {
		return // already configured
	}
	if _, ok := os.LookupEnv("SLASH_REPO_DIR"); ok {
		return // provided via the real environment
	}
	if !isInteractive() {
		return // don't block CI/tests; defaults apply
	}

	printFirstRunIntro()
	reader := bufio.NewReader(os.Stdin)
	repo := promptRepoDir(reader)

	if err := writeEnvFile(envFile, [][2]string{{"SLASH_REPO_DIR", repo}}); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not write %s: %v\n", envFile, err)
	} else {
		fmt.Printf("Wrote %s — edit it later to change these values.\n\n", envFile)
	}
	_ = os.Setenv("SLASH_REPO_DIR", repo)
}

// printFirstRunIntro shows a short, friendly introduction on the very first
// interactive run — for a developer or a Claude Code agent who has never
// started the server before. Interactive-only (callers gate on isInteractive),
// so it never appears in CI / non-TTY output.
func printFirstRunIntro() {
	fmt.Print("\n" +
		"Welcome to the PR Review Tree.\n" +
		"It turns a GitHub PR into a function call-graph you browse as a review tree in\n" +
		"the browser. The server serves the frontend statically plus a thin /api bridge\n" +
		"to your local `gh` and `claude` CLIs.\n" +
		"\n" +
		"To ingest a PR it needs a local clone of the target repo (plug-and-pay). Give\n" +
		"the path below — this one-time setup writes a gitignored " + envFile + ".\n" +
		"\n")
}

// promptRepoDir asks for the local clone path of the target repo, validating
// that it looks like a git checkout. Empty input accepts the default; a path
// that does not exist / is not a git checkout asks for confirmation rather than
// silently accepting a typo.
func promptRepoDir(reader *bufio.Reader) string {
	for {
		fmt.Printf("Path to your local %s clone [%s]: ", repoSlug, defaultRepoDir)
		line, _ := reader.ReadString('\n')
		val := strings.TrimSpace(line)
		if val == "" {
			val = defaultRepoDir
		}
		expanded := expandTilde(val)

		fi, err := os.Stat(expanded)
		switch {
		case err == nil && fi.IsDir():
			if _, gerr := os.Stat(filepath.Join(expanded, ".git")); gerr == nil {
				return val
			}
			if confirm(reader, fmt.Sprintf("  %s exists but is not a git checkout — use it anyway?", expanded)) {
				return val
			}
		default:
			if confirm(reader, fmt.Sprintf("  %s does not exist — use it anyway?", expanded)) {
				return val
			}
		}
	}
}

// confirm asks a yes/no question, defaulting to no.
func confirm(reader *bufio.Reader, question string) bool {
	fmt.Printf("%s [y/N] ", question)
	ans, _ := reader.ReadString('\n')
	return strings.EqualFold(strings.TrimSpace(ans), "y")
}

// writeEnvFile writes KEY=VALUE lines (in the given order) with a short header.
func writeEnvFile(path string, vals [][2]string) error {
	var b strings.Builder
	b.WriteString("# slash local config (gitignored). See .env.example / README for all vars.\n")
	for _, kv := range vals {
		fmt.Fprintf(&b, "%s=%s\n", kv[0], kv[1])
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}
