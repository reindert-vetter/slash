package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/reindert-vetter/tembed"
)

// fakeSUGit is a scripted git: head/origin SHAs, an ancestry relation, a dirty
// flag, and a log of every command so a test can assert what was (not) run.
type fakeSUGit struct {
	head, origin  string
	ancestors     map[string]bool // "a<b" → a is an ancestor of b
	dirty         string
	branch        string
	rebaseFails   bool
	rebasedTarget string
	worktreeStart string
	calls         []string
}

func (f *fakeSUGit) run(_ context.Context, dir string, args ...string) (string, error) {
	cmd := strings.Join(args, " ")
	f.calls = append(f.calls, cmd)
	switch {
	case strings.HasPrefix(cmd, "fetch"):
		return "", nil
	case cmd == "symbolic-ref --short HEAD":
		if f.branch != "" {
			return f.branch, nil
		}
		return "main", nil
	case cmd == "rev-parse HEAD":
		if strings.HasSuffix(dir, "src") {
			if f.rebasedTarget != "" {
				return f.rebasedTarget, nil
			}
			return f.worktreeStart, nil
		}
		return f.head, nil
	case cmd == "rev-parse refs/remotes/origin/main":
		return f.origin, nil
	case strings.HasPrefix(cmd, "merge-base --is-ancestor"):
		if f.ancestors[args[2]+"<"+args[3]] {
			return "", nil
		}
		return "", errors.New("exit 1")
	case strings.HasPrefix(cmd, "status"):
		return f.dirty, nil
	case strings.HasPrefix(cmd, "worktree add"):
		f.worktreeStart = args[len(args)-1]
		return "", nil
	case strings.HasPrefix(cmd, "rebase origin/main"):
		if f.rebaseFails {
			return "CONFLICT (content): Merge conflict in x.go", errors.New("exit 1")
		}
		return "", nil
	case strings.HasPrefix(cmd, "reset --keep"):
		f.head = args[2]
		return "", nil
	}
	return "", nil
}

func newFakeUpdater(t *testing.T, g *fakeSUGit, running string) (*selfUpdater, *[]string) {
	t.Helper()
	dir := t.TempDir()
	var renamed []string
	u := &selfUpdater{
		env:      selfUpdateEnv{Enabled: true, RepoDir: dir, ExePath: filepath.Join(dir, "slash"), RunningRev: running},
		git:      g.run,
		skipPath: filepath.Join(dir, "data", "self-update-skip.json"),
		busy:     func() int { return 0 },
		rename: func(from, to string) error {
			renamed = append(renamed, from+"->"+to)
			return nil
		},
		tempDir: func() (string, error) { return t.TempDir(), nil },
		build:   func(context.Context, string, string) (string, error) { return "", nil },
	}
	return u, &renamed
}

func TestClassifySelfUpdateEnv(t *testing.T) {
	if e := classifySelfUpdateEnv("", "abc", "/r/slash", "/r"); !e.Enabled || e.RepoDir != "/r" {
		t.Fatalf("built ./slash in repo root must be enabled: %+v", e)
	}
	for name, e := range map[string]selfUpdateEnv{
		"off":       classifySelfUpdateEnv("off", "abc", "/r/slash", "/r"),
		"go run":    classifySelfUpdateEnv("", "", "/tmp/go-build1/exe/slash", "/r"),
		"test bin":  classifySelfUpdateEnv("", "abc", "/r/tests/.tmp/slash", "/r"),
		"wrongname": classifySelfUpdateEnv("", "abc", "/r/slash-dev", "/r"),
	} {
		if e.Enabled {
			t.Errorf("%s: must be disabled, got %+v", name, e)
		}
	}
}

func TestSelfUpdatePrepareCases(t *testing.T) {
	ctx := context.Background()
	// Up to date: running == head == origin.
	g := &fakeSUGit{head: "A", origin: "A"}
	u, _ := newFakeUpdater(t, g, "A")
	if p, err := u.prepare(ctx); err != nil || !p.UpToDate {
		t.Fatalf("up to date: %+v %v", p, err)
	}
	// Dirty tree with nothing to update is NOT an error.
	g = &fakeSUGit{head: "A", origin: "A", dirty: " M .gitignore"}
	u, _ = newFakeUpdater(t, g, "A")
	if p, err := u.prepare(ctx); err != nil || !p.UpToDate {
		t.Fatalf("dirty but up to date: %+v %v", p, err)
	}
	// Fast-forward to origin.
	g = &fakeSUGit{head: "A", origin: "B", ancestors: map[string]bool{"A<B": true}}
	u, _ = newFakeUpdater(t, g, "A")
	p, err := u.prepare(ctx)
	if err != nil || p.UpToDate || p.Rebase || p.Start != "B" {
		t.Fatalf("ff: %+v %v", p, err)
	}
	// Local commit only (HEAD ahead of running and origin).
	g = &fakeSUGit{head: "C", origin: "A", ancestors: map[string]bool{"A<C": true}}
	u, _ = newFakeUpdater(t, g, "A")
	if p, err := u.prepare(ctx); err != nil || p.Start != "C" || p.Rebase {
		t.Fatalf("local ahead: %+v %v", p, err)
	}
	// Diverged → rebase.
	g = &fakeSUGit{head: "C", origin: "B"}
	u, _ = newFakeUpdater(t, g, "A")
	if p, err := u.prepare(ctx); err != nil || !p.Rebase {
		t.Fatalf("diverged: %+v %v", p, err)
	}
	// Update + dirty tree → refused with a message, never stashed.
	g = &fakeSUGit{head: "A", origin: "B", ancestors: map[string]bool{"A<B": true}, dirty: " M x.go"}
	u, _ = newFakeUpdater(t, g, "A")
	if _, err := u.prepare(ctx); err == nil || !strings.Contains(err.Error(), "niet-gecommitte") {
		t.Fatalf("dirty update must be refused, got %v", err)
	}
	for _, c := range g.calls {
		if strings.HasPrefix(c, "stash") {
			t.Fatalf("must never stash: %v", g.calls)
		}
	}
	// Not on main → refused.
	g = &fakeSUGit{head: "A", origin: "B", branch: "feature"}
	u, _ = newFakeUpdater(t, g, "A")
	if _, err := u.prepare(ctx); err == nil {
		t.Fatal("not on main must be refused")
	}
}

func TestSelfUpdateBuildFailureLeavesEverythingAlone(t *testing.T) {
	ctx := context.Background()
	g := &fakeSUGit{head: "A", origin: "B", ancestors: map[string]bool{"A<B": true}}
	u, renamed := newFakeUpdater(t, g, "A")
	u.build = func(context.Context, string, string) (string, error) {
		return "./x.go:1: syntax error", errors.New("exit 1")
	}
	p, _ := u.prepare(ctx)
	if _, err := u.buildNew(ctx, p); err == nil || !strings.Contains(err.Error(), "syntax error") {
		t.Fatalf("build failure must surface compiler output, got %v", err)
	}
	if len(*renamed) != 0 || g.head != "A" {
		t.Fatalf("failed build must not touch binary or main: renamed=%v head=%s", *renamed, g.head)
	}
	for _, c := range g.calls {
		if strings.HasPrefix(c, "reset") {
			t.Fatalf("failed build must not reset main: %v", g.calls)
		}
	}
}

func TestSelfUpdateRebaseConflictAborts(t *testing.T) {
	ctx := context.Background()
	g := &fakeSUGit{head: "C", origin: "B", rebaseFails: true}
	u, _ := newFakeUpdater(t, g, "A")
	p, _ := u.prepare(ctx)
	if _, err := u.buildNew(ctx, p); err == nil || !strings.Contains(err.Error(), "conflict") {
		t.Fatalf("rebase conflict must fail, got %v", err)
	}
	if !strings.Contains(strings.Join(g.calls, "|"), "rebase --abort") {
		t.Fatalf("rebase conflict must abort: %v", g.calls)
	}
}

func TestSelfUpdateApplyRefusesWhenMainMoved(t *testing.T) {
	ctx := context.Background()
	g := &fakeSUGit{head: "Z", origin: "B"}
	u, renamed := newFakeUpdater(t, g, "A")
	if _, err := u.apply(ctx, selfUpdateBuilt{Target: "B", Base: "A"}); err == nil {
		t.Fatal("apply must refuse when HEAD moved since the check")
	}
	if len(*renamed) != 0 {
		t.Fatal("binary must not be swapped")
	}
}

// TestSelfUpdateWorkflowEndToEnd drives the real workflow on a memory engine
// with the faked updater: notice → "now" → applied (main reset + binary
// swapped); a second run on the same state after "skip" reports skipped.
func TestSelfUpdateWorkflowEndToEnd(t *testing.T) {
	g := &fakeSUGit{head: "C", origin: "B", rebasedTarget: "R"}
	u, renamed := newFakeUpdater(t, g, "A")
	engine := tembed.New(tembed.NewMemoryStore())
	registerSelfUpdateOn(engine, func() *selfUpdater { return u })

	id, err := engine.StartWorkflowID("su-1", WorkflowSelfUpdate, nil)
	if err != nil {
		t.Fatal(err)
	}
	rs, _ := engine.Status(id)
	hist, _ := engine.History(id)
	st := deriveSelfUpdateStatus(selfUpdateStatus{Running: "A"}, rs, hist)
	if st.Phase != "notice" || st.Target != "R" || !st.Rebase || st.AutoAt.Sub(st.NoticeAt) != selfUpdateGrace {
		t.Fatalf("expected notice for R, got %+v", st)
	}
	if err := engine.SignalWorkflow(id, SignalSelfUpdateDecision, selfUpdateDecision{Action: "now"}); err != nil {
		t.Fatal(err)
	}
	var res selfUpdateResult
	if err := engine.Result(id, &res); err != nil || res.Outcome != "applied" || res.Target != "R" {
		t.Fatalf("expected applied R, got %+v %v", res, err)
	}
	if g.head != "R" || len(*renamed) != 1 {
		t.Fatalf("main must move to R and binary swap once: head=%s renamed=%v", g.head, *renamed)
	}
	rs, _ = engine.Status(id)
	hist, _ = engine.History(id)
	if st := deriveSelfUpdateStatus(selfUpdateStatus{Running: "A"}, rs, hist); st.Phase != "restarting" {
		t.Fatalf("applied run with a different running rev must read restarting, got %s", st.Phase)
	}
	if st := deriveSelfUpdateStatus(selfUpdateStatus{Running: "R"}, rs, hist); st.Phase != "idle" {
		t.Fatalf("after the restart (running == target) it must read idle, got %s", st.Phase)
	}

	// Skip: remembered per origin:head key, next check reports skipped.
	g2 := &fakeSUGit{head: "A", origin: "B", ancestors: map[string]bool{"A<B": true}}
	u2, renamed2 := newFakeUpdater(t, g2, "A")
	engine2 := tembed.New(tembed.NewMemoryStore())
	registerSelfUpdateOn(engine2, func() *selfUpdater { return u2 })
	id2, _ := engine2.StartWorkflowID("su-2", WorkflowSelfUpdate, nil)
	if err := engine2.SignalWorkflow(id2, SignalSelfUpdateDecision, selfUpdateDecision{Action: "skip"}); err != nil {
		t.Fatal(err)
	}
	if err := engine2.Result(id2, &res); err != nil || res.Outcome != "skipped" {
		t.Fatalf("expected skipped, got %+v %v", res, err)
	}
	if len(*renamed2) != 0 || g2.head != "A" {
		t.Fatal("skip must not apply anything")
	}
	b, _ := os.ReadFile(u2.skipPath)
	var v map[string]string
	_ = json.Unmarshal(b, &v)
	if v["key"] != "B:A" {
		t.Fatalf("skip key = %q", v["key"])
	}
	id3, _ := engine2.StartWorkflowID("su-3", WorkflowSelfUpdate, nil)
	if err := engine2.Result(id3, &res); err != nil || res.Outcome != "skipped" {
		t.Fatalf("same state after skip must be skipped without a build, got %+v %v", res, err)
	}
}
