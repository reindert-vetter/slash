package main

// self_update.go — slash updates ITSELF: it notices that GitHub's main (or the
// local main) is ahead of the commit the running binary was built from, builds
// the new version next to the working copy, announces it in the header bell
// and, unless the reviewer says "Doorgaan met de oude versie", swaps the
// binary and restarts in place once nothing is busy any more. Full mechanism
// and the reasoning behind each step: "Self-update (`self_update`)" in
// .claude/docs/workflows-trackers.md.
//
// Split of responsibilities, per .claude/rules/workflows-write-boundary.md:
//   - every durable write (git fetch, the build output, the rebase/reset of
//     main, the binary swap, the skip file) happens in an Activity of the
//     one-shot `self_update` Workflow;
//   - the 6-hour trigger and the "≥2 min visible and nothing busy → go"
//     decision live in a plain background goroutine (the supervisor) that only
//     STARTS or SIGNALS that workflow, same shape as StartCleanupScheduler;
//   - GET /api/update/status is derived from the run's own history — no
//     separate state to go stale;
//   - the restart (syscall.Exec) happens only AFTER the run completed, so a
//     recovery never replays into an exec.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/reindert-vetter/tembed"
)

const (
	// WorkflowSelfUpdate is the one-shot Workflow Type behind the bell's
	// "Nieuwe versie van slash" row: prepare → build → wait for a decision →
	// wait until idle → apply. See this file's header.
	WorkflowSelfUpdate = "self_update"
	// SignalSelfUpdateDecision carries {action}: "now" (the button), "auto"
	// (the supervisor, after the grace period with nothing busy), "skip"
	// ("Doorgaan met de oude versie") or "stale" (the supervisor: the running
	// binary already IS the built target, e.g. after a manual restart).
	SignalSelfUpdateDecision = "decision"

	selfUpdateRemote = "origin"
	selfUpdateBranch = "main"

	selfUpdateCheckInterval   = 6 * time.Hour
	selfUpdateFirstCheckDelay = 2 * time.Minute
	// selfUpdateGrace is how long the notice is visible before the supervisor
	// may proceed on its own — the window for "Doorgaan met de oude versie".
	selfUpdateGrace = 2 * time.Minute
	// selfUpdateIdlePoll/selfUpdateIdleMaxPolls: after a decision the workflow
	// waits (durable timer) until nothing is busy, at most ~30 minutes.
	selfUpdateIdlePoll       = 10 * time.Second
	selfUpdateIdleMaxPolls   = 180
	selfUpdateSupervisorTick = 5 * time.Second
	selfUpdateGitTimeout     = 2 * time.Minute
	selfUpdateBuildTimeout   = 10 * time.Minute
	selfUpdateMaxBuildLines  = 40
)

// selfUpdateEnv is what the running process knows about itself.
type selfUpdateEnv struct {
	Enabled    bool
	Reason     string // why disabled: "off" | "not-a-built-binary"
	RepoDir    string // the git checkout the binary lives in (== its dir)
	ExePath    string // <RepoDir>/slash
	RunningRev string // vcs.revision stamped into this binary
}

// classifySelfUpdateEnv is detectSelfUpdateEnv's pure decision: self-update
// only works for the conventional `./slash` binary in the root of its own git
// checkout. `go run .` (a temp binary), the Playwright server
// (tests/.tmp/slash, whose toplevel is the repo root, not its own dir) and a
// binary without a vcs stamp are all left alone.
func classifySelfUpdateEnv(offEnv, runningRev, exePath, toplevel string) selfUpdateEnv {
	env := selfUpdateEnv{RunningRev: runningRev, ExePath: exePath}
	if strings.EqualFold(strings.TrimSpace(offEnv), "off") {
		env.Reason = "off"
		return env
	}
	dir := filepath.Dir(exePath)
	if runningRev == "" || filepath.Base(exePath) != "slash" || toplevel == "" || filepath.Clean(toplevel) != filepath.Clean(dir) {
		env.Reason = "not-a-built-binary"
		return env
	}
	env.Enabled = true
	env.RepoDir = dir
	return env
}

// buildRevision returns the vcs.revision the Go toolchain stamped into this
// binary ("" for `go run`/tests).
func buildRevision() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, s := range bi.Settings {
		if s.Key == "vcs.revision" {
			return s.Value
		}
	}
	return ""
}

func detectSelfUpdateEnv() selfUpdateEnv {
	rev := buildRevision()
	exe, err := os.Executable()
	if err == nil {
		if r, err2 := filepath.EvalSymlinks(exe); err2 == nil {
			exe = r
		}
	}
	top := ""
	// Only ask git when the cheap checks already pass (a test binary is never
	// named "slash"), so no test ever shells out here.
	if os.Getenv("SLASH_SELF_UPDATE") != "off" && rev != "" && filepath.Base(exe) == "slash" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if out, err := realSelfUpdateGit(ctx, filepath.Dir(exe), "rev-parse", "--show-toplevel"); err == nil {
			top = out
			if r, err2 := filepath.EvalSymlinks(top); err2 == nil {
				top = r
			}
		}
	}
	return classifySelfUpdateEnv(os.Getenv("SLASH_SELF_UPDATE"), rev, exe, top)
}

// ── the updater: every git/build step, behind injectable funcs ──────────────

type selfUpdateGitFunc func(ctx context.Context, dir string, args ...string) (string, error)
type selfUpdateBuildFunc func(ctx context.Context, srcDir, outPath string) (string, error)

func realSelfUpdateGit(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, selfUpdateGitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func realSelfUpdateBuild(ctx context.Context, srcDir, outPath string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, selfUpdateBuildTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "build", "-o", outPath, ".")
	cmd.Dir = srcDir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

type selfUpdater struct {
	env      selfUpdateEnv
	git      selfUpdateGitFunc
	build    selfUpdateBuildFunc
	skipPath string
	busy     func() int
	rename   func(from, to string) error
	tempDir  func() (string, error)
}

// selfUpdatePlan is selfUpdatePrepare's recorded result.
type selfUpdatePlan struct {
	UpToDate bool   `json:"upToDate,omitempty"`
	Skipped  bool   `json:"skipped,omitempty"`
	Key      string `json:"key,omitempty"`    // "<origin>:<head>" — what a skip remembers
	Base     string `json:"base,omitempty"`   // local HEAD at check time
	Origin   string `json:"origin,omitempty"` // origin/main at check time
	Start    string `json:"start,omitempty"`  // commit the build worktree starts from
	Rebase   bool   `json:"rebase,omitempty"` // local commits get rebased onto origin/main
}

// selfUpdateBuilt is selfUpdateBuild's recorded result.
type selfUpdateBuilt struct {
	Target  string   `json:"target"`
	Base    string   `json:"base"`
	Rebase  bool     `json:"rebase,omitempty"`
	Commits []string `json:"commits,omitempty"`
}

// selfUpdateResult is the workflow's result.
type selfUpdateResult struct {
	Outcome string `json:"outcome"` // uptodate | skipped | stale | applied
	Target  string `json:"target,omitempty"`
}

type selfUpdateDecision struct {
	Action string `json:"action"`
}

func (u *selfUpdater) isAncestor(ctx context.Context, a, b string) bool {
	_, err := u.git(ctx, u.env.RepoDir, "merge-base", "--is-ancestor", a, b)
	return err == nil
}

func (u *selfUpdater) dirtyFiles(ctx context.Context) (string, error) {
	out, err := u.git(ctx, u.env.RepoDir, "status", "--porcelain", "--untracked-files=no")
	if err != nil {
		return "", fmt.Errorf("git status: %v: %s", err, out)
	}
	return strings.TrimSpace(out), nil
}

func (u *selfUpdater) readSkip() string {
	if u.skipPath == "" {
		return ""
	}
	b, err := os.ReadFile(u.skipPath)
	if err != nil {
		return ""
	}
	var v struct {
		Key string `json:"key"`
	}
	_ = json.Unmarshal(b, &v)
	return v.Key
}

// prepare fetches origin/main and decides whether there is anything to build.
// Order matters: an up-to-date or skipped state is reported BEFORE the
// dirty-tree check, so a working copy with uncommitted changes only fails a run
// when there really is an update it blocks.
func (u *selfUpdater) prepare(ctx context.Context) (selfUpdatePlan, error) {
	dir := u.env.RepoDir
	if out, err := u.git(ctx, dir, "fetch", "--quiet", selfUpdateRemote, selfUpdateBranch); err != nil {
		return selfUpdatePlan{}, fmt.Errorf("git fetch %s %s mislukt: %v: %s", selfUpdateRemote, selfUpdateBranch, err, out)
	}
	branch, err := u.git(ctx, dir, "symbolic-ref", "--short", "HEAD")
	if err != nil || branch != selfUpdateBranch {
		return selfUpdatePlan{}, fmt.Errorf("de werkmap staat niet op %s (maar op %q); bijwerken overgeslagen", selfUpdateBranch, branch)
	}
	head, err := u.git(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return selfUpdatePlan{}, fmt.Errorf("git rev-parse HEAD: %v: %s", err, head)
	}
	origin, err := u.git(ctx, dir, "rev-parse", "refs/remotes/"+selfUpdateRemote+"/"+selfUpdateBranch)
	if err != nil {
		return selfUpdatePlan{}, fmt.Errorf("git rev-parse %s/%s: %v: %s", selfUpdateRemote, selfUpdateBranch, err, origin)
	}
	p := selfUpdatePlan{Base: head, Origin: origin, Key: origin + ":" + head}
	running := u.env.RunningRev
	switch {
	case head == origin || u.isAncestor(ctx, origin, head):
		// GitHub has nothing local main doesn't: the candidate is local HEAD.
		p.Start = head
	case u.isAncestor(ctx, head, origin):
		// Plain fast-forward to GitHub's main.
		p.Start = origin
	default:
		// Local commits that are not on GitHub, AND GitHub moved on: rebase
		// the local commits onto origin/main (in the build worktree first).
		p.Start = head
		p.Rebase = true
	}
	if !p.Rebase && (p.Start == running || u.isAncestor(ctx, p.Start, running)) {
		p.UpToDate = true
		return p, nil
	}
	if u.readSkip() == p.Key {
		p.Skipped = true
		return p, nil
	}
	dirty, err := u.dirtyFiles(ctx)
	if err != nil {
		return selfUpdatePlan{}, err
	}
	if dirty != "" {
		return selfUpdatePlan{}, fmt.Errorf("er is een nieuwe versie, maar de werkmap heeft niet-gecommitte wijzigingen (%s); commit of verwijder die eerst — slash stasht nooit zelf", compactLines(dirty, 5))
	}
	return p, nil
}

// buildNew builds the candidate in a throwaway worktree, so the live working
// copy (and thus the frontend it serves from disk) only changes once the build
// succeeded. A failed build or rebase conflict leaves the running binary, the
// working copy and main untouched.
func (u *selfUpdater) buildNew(ctx context.Context, p selfUpdatePlan) (selfUpdateBuilt, error) {
	dir := u.env.RepoDir
	tmp, err := u.tempDir()
	if err != nil {
		return selfUpdateBuilt{}, err
	}
	wt := filepath.Join(tmp, "src")
	defer func() {
		_, _ = u.git(context.Background(), dir, "worktree", "remove", "--force", wt)
		_ = os.RemoveAll(tmp)
		_, _ = u.git(context.Background(), dir, "worktree", "prune")
	}()
	if out, err := u.git(ctx, dir, "worktree", "add", "--detach", wt, p.Start); err != nil {
		return selfUpdateBuilt{}, fmt.Errorf("git worktree add: %v: %s", err, out)
	}
	if p.Rebase {
		if out, err := u.git(ctx, wt, "rebase", selfUpdateRemote+"/"+selfUpdateBranch); err != nil {
			_, _ = u.git(context.Background(), wt, "rebase", "--abort")
			return selfUpdateBuilt{}, fmt.Errorf("je lokale commits rebasen op %s/%s gaf een conflict — afgebroken, er is niets veranderd: %s", selfUpdateRemote, selfUpdateBranch, compactLines(out, 8))
		}
	}
	target, err := u.git(ctx, wt, "rev-parse", "HEAD")
	if err != nil {
		return selfUpdateBuilt{}, fmt.Errorf("git rev-parse (build): %v: %s", err, target)
	}
	newBin := u.env.ExePath + ".new"
	if out, err := u.build(ctx, wt, newBin); err != nil {
		_ = os.Remove(newBin)
		return selfUpdateBuilt{}, fmt.Errorf("go build van de nieuwe versie faalde — de huidige versie blijft draaien:\n%s", compactLines(out, selfUpdateMaxBuildLines))
	}
	b := selfUpdateBuilt{Target: target, Base: p.Base, Rebase: p.Rebase}
	if u.env.RunningRev != "" {
		if out, err := u.git(ctx, dir, "log", "--format=%s", "-n", "20", u.env.RunningRev+".."+target); err == nil && out != "" {
			b.Commits = strings.Split(out, "\n")
		}
	}
	return b, nil
}

// apply moves main to the built target and swaps the binary. It refuses when
// main moved or the tree got dirty since the check — never stash, never force.
// `git reset --keep` moves the branch (a fast-forward, or onto the rebased
// commits the build worktree produced) and itself refuses to drop local
// changes.
func (u *selfUpdater) apply(ctx context.Context, b selfUpdateBuilt) (selfUpdateResult, error) {
	dir := u.env.RepoDir
	head, err := u.git(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return selfUpdateResult{}, fmt.Errorf("git rev-parse HEAD: %v: %s", err, head)
	}
	if head != b.Base {
		return selfUpdateResult{}, fmt.Errorf("main is veranderd tijdens het wachten (nieuwe lokale commit); update niet toegepast, de volgende controle probeert het opnieuw")
	}
	if branch, err := u.git(ctx, dir, "symbolic-ref", "--short", "HEAD"); err != nil || branch != selfUpdateBranch {
		return selfUpdateResult{}, fmt.Errorf("de werkmap staat niet meer op %s; update niet toegepast", selfUpdateBranch)
	}
	dirty, err := u.dirtyFiles(ctx)
	if err != nil {
		return selfUpdateResult{}, err
	}
	if dirty != "" {
		return selfUpdateResult{}, fmt.Errorf("de werkmap kreeg niet-gecommitte wijzigingen (%s); update niet toegepast", compactLines(dirty, 5))
	}
	if head != b.Target {
		if out, err := u.git(ctx, dir, "reset", "--keep", b.Target); err != nil {
			return selfUpdateResult{}, fmt.Errorf("git reset --keep %s: %v: %s", b.Target, err, out)
		}
	}
	if err := u.rename(u.env.ExePath+".new", u.env.ExePath); err != nil {
		return selfUpdateResult{}, fmt.Errorf("nieuwe binary plaatsen: %v", err)
	}
	return selfUpdateResult{Outcome: "applied", Target: b.Target}, nil
}

func (u *selfUpdater) recordSkip(key string) error {
	if u.skipPath == "" {
		return nil
	}
	_ = os.Remove(u.env.ExePath + ".new")
	if err := os.MkdirAll(filepath.Dir(u.skipPath), 0o755); err != nil {
		return err
	}
	b, _ := json.Marshal(map[string]string{"key": key})
	tmp := u.skipPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, u.skipPath)
}

func compactLines(s string, max int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > max {
		lines = append(lines[:max], fmt.Sprintf("… (%d regels meer)", len(lines)-max))
	}
	return strings.Join(lines, "\n")
}

// ── the workflow ────────────────────────────────────────────────────────────

// registerSelfUpdateOn wires the workflow + its Activities onto engine for u.
// Split out of TaskManager so a test can drive it with a faked updater.
func registerSelfUpdateOn(engine *tembed.Engine, u func() *selfUpdater) {
	engine.RegisterWorkflow(WorkflowSelfUpdate, selfUpdateWorkflow)
	// A run killed mid-build must not rebuild on the startup path.
	engine.SetWorkflowPriority(WorkflowSelfUpdate, tembed.PriorityLow)
	engine.RegisterActivity("selfUpdatePrepare", func(ctx context.Context, _ []byte) ([]byte, error) {
		p, err := u().prepare(ctx)
		if err != nil {
			return nil, err
		}
		return json.Marshal(p)
	})
	engine.RegisterActivity("selfUpdateBuild", func(ctx context.Context, in []byte) ([]byte, error) {
		var p selfUpdatePlan
		if err := json.Unmarshal(in, &p); err != nil {
			return nil, err
		}
		b, err := u().buildNew(ctx, p)
		if err != nil {
			return nil, err
		}
		return json.Marshal(b)
	})
	engine.RegisterActivity("selfUpdateBusy", func(ctx context.Context, _ []byte) ([]byte, error) {
		n := 0
		if f := u().busy; f != nil {
			n = f()
		}
		return json.Marshal(n)
	})
	engine.RegisterActivity("selfUpdateSkip", func(ctx context.Context, in []byte) ([]byte, error) {
		var key string
		_ = json.Unmarshal(in, &key)
		return nil, u().recordSkip(key)
	})
	engine.RegisterActivity("selfUpdateApply", func(ctx context.Context, in []byte) ([]byte, error) {
		var b selfUpdateBuilt
		if err := json.Unmarshal(in, &b); err != nil {
			return nil, err
		}
		r, err := u().apply(ctx, b)
		if err != nil {
			return nil, err
		}
		return json.Marshal(r)
	})
}

// selfUpdateWorkflow — deterministic: every branch follows from Activity
// results or the decision Signal, the idle loop's length from recorded busy
// counts.
func selfUpdateWorkflow(w *tembed.Workflow, _ []byte) ([]byte, error) {
	var plan selfUpdatePlan
	if err := w.ExecuteActivity("selfUpdatePrepare", nil, &plan); err != nil {
		return nil, err
	}
	if plan.UpToDate {
		return json.Marshal(selfUpdateResult{Outcome: "uptodate"})
	}
	if plan.Skipped {
		return json.Marshal(selfUpdateResult{Outcome: "skipped"})
	}
	var built selfUpdateBuilt
	if err := w.ExecuteActivity("selfUpdateBuild", plan, &built); err != nil {
		return nil, err
	}
	var d selfUpdateDecision
	w.WaitSignal(SignalSelfUpdateDecision, &d)
	switch d.Action {
	case "skip":
		if err := w.ExecuteActivity("selfUpdateSkip", plan.Key, nil); err != nil {
			return nil, err
		}
		return json.Marshal(selfUpdateResult{Outcome: "skipped", Target: built.Target})
	case "stale":
		return json.Marshal(selfUpdateResult{Outcome: "stale", Target: built.Target})
	}
	for i := 0; ; i++ {
		var busy int
		if err := w.ExecuteActivity("selfUpdateBusy", nil, &busy); err != nil {
			return nil, err
		}
		if busy == 0 {
			break
		}
		if i >= selfUpdateIdleMaxPolls {
			return nil, fmt.Errorf("slash bleef bezig (%d taken); de update is niet toegepast, de volgende controle probeert het opnieuw", busy)
		}
		w.Sleep(selfUpdateIdlePoll)
	}
	var res selfUpdateResult
	if err := w.ExecuteActivity("selfUpdateApply", built, &res); err != nil {
		return nil, err
	}
	return json.Marshal(res)
}

// ── status: derived from the latest run's history ───────────────────────────

type selfUpdateStatus struct {
	OK        bool      `json:"ok"`
	Enabled   bool      `json:"enabled"`
	Reason    string    `json:"reason,omitempty"`
	Running   string    `json:"running"`
	Phase     string    `json:"phase"` // idle|checking|building|notice|waiting|restarting|failed
	Outcome   string    `json:"outcome,omitempty"`
	Target    string    `json:"target,omitempty"`
	Commits   []string  `json:"commits,omitempty"`
	Rebase    bool      `json:"rebase,omitempty"`
	NoticeAt  time.Time `json:"noticeAt,omitempty"`
	AutoAt    time.Time `json:"autoAt,omitempty"`
	CheckedAt time.Time `json:"checkedAt,omitempty"`
	Busy      int       `json:"busy"`
	Error     string    `json:"error,omitempty"`
	RunID     string    `json:"runId,omitempty"`
}

// deriveSelfUpdateStatus is the pure mapping from one run's status + history.
func deriveSelfUpdateStatus(st selfUpdateStatus, runStatus string, hist []tembed.Event) selfUpdateStatus {
	st.Phase = "idle"
	decided := false
	built := false
	prepared := false
	for _, ev := range hist {
		switch {
		case ev.Type == tembed.EventActivityCompleted && ev.Name == "selfUpdatePrepare":
			prepared = true
			st.CheckedAt = ev.Time
		case ev.Type == tembed.EventActivityCompleted && ev.Name == "selfUpdateBuild":
			built = true
			var b selfUpdateBuilt
			if json.Unmarshal(ev.Payload, &b) == nil {
				st.Target, st.Commits, st.Rebase = b.Target, b.Commits, b.Rebase
			}
			st.NoticeAt = ev.Time
			st.AutoAt = ev.Time.Add(selfUpdateGrace)
		case ev.Type == tembed.EventSignalReceived && ev.Name == SignalSelfUpdateDecision:
			decided = true
		case ev.Type == tembed.EventWorkflowFailed:
			st.Error = ev.Error
		case ev.Type == tembed.EventWorkflowCompleted:
			var r selfUpdateResult
			if json.Unmarshal(ev.Payload, &r) == nil {
				st.Outcome = r.Outcome
				if r.Target != "" {
					st.Target = r.Target
				}
			}
		}
	}
	switch runStatus {
	case tembed.StatusRunning, tembed.StatusWaiting:
		switch {
		case decided:
			st.Phase = "waiting"
		case built:
			st.Phase = "notice"
		case prepared:
			st.Phase = "building"
		default:
			st.Phase = "checking"
		}
	case tembed.StatusFailed:
		st.Phase = "failed"
	case tembed.StatusCompleted:
		if st.Outcome == "applied" && st.Target != "" && st.Target != st.Running {
			st.Phase = "restarting"
		}
	}
	return st
}

// ── TaskManager glue ────────────────────────────────────────────────────────

type selfUpdateCtl struct {
	once     sync.Once
	updater  *selfUpdater
	mu       sync.Mutex
	runID    string
	starting bool
	scanned  bool
	execd    atomic.Bool
	// exec replaces the process; a test swaps it out.
	exec func(path string) error
}

func (m *TaskManager) selfUpdate() *selfUpdater {
	c := m.suCtl()
	c.once.Do(func() {
		env := detectSelfUpdateEnv()
		c.updater = &selfUpdater{
			env:      env,
			git:      realSelfUpdateGit,
			build:    realSelfUpdateBuild,
			skipPath: filepath.Join(m.appDataDirOrDefault(), "self-update-skip.json"),
			busy:     m.selfUpdateBusyCount,
			rename:   os.Rename,
			tempDir:  func() (string, error) { return os.MkdirTemp("", "slash-selfupdate-") },
		}
	})
	return c.updater
}

var selfUpdateCtlInit sync.Mutex

func (m *TaskManager) suCtl() *selfUpdateCtl {
	selfUpdateCtlInit.Lock()
	defer selfUpdateCtlInit.Unlock()
	if m.su == nil {
		m.su = &selfUpdateCtl{exec: execSelf}
	}
	return m.su
}

func execSelf(path string) error {
	return syscall.Exec(path, os.Args, os.Environ())
}

func (m *TaskManager) registerSelfUpdate(engine *tembed.Engine) {
	registerSelfUpdateOn(engine, m.selfUpdate)
}

// selfUpdateBusyCount is "is anything running that a restart would cut
// off?" — wider than RunningCounts: plan-page chat turns (pr 0) and held
// write-turn slots count too, and the self_update run itself does not.
func (m *TaskManager) selfUpdateBusyCount() int {
	n := 0
	if runs, err := m.engine.Runs(); err == nil {
		for _, r := range runs {
			if r.Status == tembed.StatusRunning && r.Workflow != WorkflowSelfUpdate && r.Workflow != WorkflowClaudeChat {
				n++
			}
		}
	}
	chatProgressMu.Lock()
	for _, p := range chatProgressByConv {
		if p.Running {
			n++
		}
	}
	chatProgressMu.Unlock()
	writeTurnHoldersMu.Lock()
	n += len(writeTurnHolders)
	writeTurnHoldersMu.Unlock()
	return n
}

// latestSelfUpdateRun returns the newest self_update run id (scanning the
// store once per process, then tracking starts in memory).
func (m *TaskManager) latestSelfUpdateRun() string {
	c := m.suCtl()
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.scanned {
		c.scanned = true
		if runs, err := m.engine.Runs(); err == nil {
			var mine []tembed.RunRecord
			for _, r := range runs {
				if r.Workflow == WorkflowSelfUpdate {
					mine = append(mine, r)
				}
			}
			sort.Slice(mine, func(i, j int) bool { return mine[i].CreatedAt.After(mine[j].CreatedAt) })
			if len(mine) > 0 && c.runID == "" {
				c.runID = mine[0].ID
			}
		}
	}
	return c.runID
}

// SelfUpdateStatus serves GET /api/update/status. Read-only: no git call.
func (m *TaskManager) SelfUpdateStatus() selfUpdateStatus {
	u := m.selfUpdate()
	st := selfUpdateStatus{OK: true, Enabled: u.env.Enabled, Reason: u.env.Reason, Running: u.env.RunningRev, Phase: "idle"}
	if !u.env.Enabled || m.engine == nil {
		return st
	}
	c := m.suCtl()
	c.mu.Lock()
	starting := c.starting
	c.mu.Unlock()
	runID := m.latestSelfUpdateRun()
	if runID != "" {
		if rs, err := m.engine.Status(runID); err == nil {
			hist, _ := m.engine.History(runID)
			st = deriveSelfUpdateStatus(st, rs, hist)
			st.RunID = runID
		}
	}
	if starting && (st.Phase == "idle" || st.Phase == "failed") {
		st.Phase, st.Error = "checking", ""
	}
	if st.Phase == "notice" || st.Phase == "waiting" {
		st.Busy = m.selfUpdateBusyCount()
	}
	return st
}

// StartSelfUpdateCheck starts one self_update run in the background, unless
// one is already underway (or waiting for a decision). "Nu controleren" and
// the 6-hour tick both land here.
func (m *TaskManager) StartSelfUpdateCheck() error {
	u := m.selfUpdate()
	if !u.env.Enabled {
		return fmt.Errorf("self-update uitgeschakeld (%s)", u.env.Reason)
	}
	if m.engine == nil {
		return errors.New("no engine")
	}
	prev := m.latestSelfUpdateRun()
	c := m.suCtl()
	c.mu.Lock()
	if c.starting {
		c.mu.Unlock()
		return nil
	}
	if prev != "" {
		if rs, err := m.engine.Status(prev); err == nil && (rs == tembed.StatusRunning || rs == tembed.StatusWaiting) {
			c.mu.Unlock()
			return nil
		}
	}
	id := fmt.Sprintf("self_update-%d", time.Now().UnixNano())
	c.starting = true
	c.runID = id
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			c.starting = false
			c.mu.Unlock()
		}()
		if _, err := m.engine.StartWorkflowID(id, WorkflowSelfUpdate, nil); err != nil {
			m.logf("self_update: %v", err)
		}
	}()
	return nil
}

// SelfUpdateDecide signals the waiting run: "now" or "skip" (from the bell).
func (m *TaskManager) SelfUpdateDecide(action string) error {
	if action != "now" && action != "skip" && action != "auto" && action != "stale" {
		return fmt.Errorf("invalid action %q", action)
	}
	st := m.SelfUpdateStatus()
	if st.Phase != "notice" {
		return fmt.Errorf("er staat geen update klaar (fase %s)", st.Phase)
	}
	return m.engine.SignalWorkflow(st.RunID, SignalSelfUpdateDecision, selfUpdateDecision{Action: action})
}

// selfUpdateTick is one supervisor step: auto-proceed after the grace period
// once idle, retire a notice the running binary already satisfies, and
// restart after an applied run. Split out so a test can drive it.
func (m *TaskManager) selfUpdateTick(now time.Time) {
	st := m.SelfUpdateStatus()
	switch st.Phase {
	case "notice":
		if st.Target != "" && st.Target == st.Running {
			if err := m.SelfUpdateDecide("stale"); err != nil {
				m.logf("self_update: stale: %v", err)
			}
			return
		}
		if !now.Before(st.AutoAt) && st.Busy == 0 {
			if err := m.SelfUpdateDecide("auto"); err != nil {
				m.logf("self_update: auto: %v", err)
			}
		}
	case "restarting":
		c := m.suCtl()
		u := m.selfUpdate()
		if _, err := os.Stat(u.env.ExePath); err != nil {
			return
		}
		if !c.execd.CompareAndSwap(false, true) {
			return
		}
		m.logf("self_update: restarting into %s (%s)", u.env.ExePath, shortSHA(st.Target))
		// A moment for in-flight responses (the status poll that shows
		// "herstarten") to flush.
		time.Sleep(300 * time.Millisecond)
		if err := c.exec(u.env.ExePath); err != nil {
			m.logf("self_update: exec: %v", err)
			c.execd.Store(false)
		}
	}
}

func shortSHA(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

// StartSelfUpdateSupervisor runs the 6-hour check and the per-5s supervisor
// tick. A no-op when self-update is disabled (tests, `go run`).
func (m *TaskManager) StartSelfUpdateSupervisor(ctx context.Context) {
	if !m.selfUpdate().env.Enabled {
		return
	}
	go func() {
		m.waitReady()
		tick := time.NewTicker(selfUpdateSupervisorTick)
		defer tick.Stop()
		nextCheck := time.Now().Add(selfUpdateFirstCheckDelay)
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick.C:
				if !now.Before(nextCheck) {
					nextCheck = now.Add(selfUpdateCheckInterval)
					if err := m.StartSelfUpdateCheck(); err != nil {
						m.logf("self_update: check: %v", err)
					}
				}
				m.selfUpdateTick(now)
			}
		}
	}()
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

// handleSelfUpdateStatus serves GET /api/update/status — read-only, derived
// from the latest self_update run; never shells out. `running` is also what
// every tab compares against to reload itself after a restart.
func (s *server) handleSelfUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, s.tasks.manager.SelfUpdateStatus())
}

// handleSelfUpdateStart serves POST /api/workflows/self_update {action}:
// "check" starts a run ("Nu controleren"), "now"/"skip" signal the waiting
// one ("Nu bijwerken" / "Doorgaan met de oude versie"). The action is the only
// input and is validated here; remote, branch and paths are constants.
func (s *server) handleSelfUpdateStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Action string `json:"action"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil && err != io.EOF {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	var err error
	switch body.Action {
	case "", "check":
		err = s.tasks.manager.StartSelfUpdateCheck()
	case "now", "skip":
		err = s.tasks.manager.SelfUpdateDecide(body.Action)
	default:
		http.Error(w, "invalid action", http.StatusBadRequest)
		return
	}
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
