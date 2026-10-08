// qa_checkout_guard.go — "qa mag geen bestanden toevoegen of aanpassen,
// behalve als je het daarna weer terugzet" (reviewer rule). The QA prompt says
// so too, but a qa_run has a real shell in the PR's checkout, so this is the
// safety net: runQARun snapshots the checkout's git status right before the
// Claude call and, after it (also after a cancel or a failure), puts back
// everything the run itself added or changed. Changes the user ALREADY had
// open stay exactly as they were — their content is snapshotted too, so even
// a run that touched one of them gets it back. What was put back is recorded
// on the result and listed under the report's deviations.
//
// Runs inside the runQARun Activity (side effects only there), so the workflow
// body stays deterministic (.claude/rules/workflow-determinism.md). See
// "The checkout guard" in .claude/docs/qa-page.md.
package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// qaGuardMaxFile bounds how big a pre-existing dirty file may be for its
// content to be snapshotted; a bigger one is left alone (and reported).
const qaGuardMaxFile = 8 << 20

// qaCheckoutSnapshot is the checkout's state right before the run.
type qaCheckoutSnapshot struct {
	Head string
	// Dirty maps every path git reported as changed/untracked to its porcelain
	// status code ("??", " M", "A ", …).
	Dirty map[string]string
	// Content holds the bytes of each pre-existing dirty FILE (a regular file
	// that exists), so it can be restored if the run touched it. A missing
	// entry for a dirty path = deleted before the run, a directory/submodule,
	// or too big.
	Content map[string][]byte
}

func qaGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

// qaGitStatus parses `git status --porcelain=v1 -z --untracked-files=all`.
// A rename/copy entry carries the old path as an extra NUL-separated token;
// both paths count as dirty.
func qaGitStatus(ctx context.Context, dir string) (map[string]string, error) {
	out, err := qaGit(ctx, dir, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	res := map[string]string{}
	toks := strings.Split(string(out), "\x00")
	for i := 0; i < len(toks); i++ {
		tok := toks[i]
		if len(tok) < 4 {
			continue
		}
		code, path := tok[:2], tok[3:]
		res[path] = code
		if code[0] == 'R' || code[0] == 'C' {
			if i+1 < len(toks) && toks[i+1] != "" {
				res[toks[i+1]] = code
			}
			i++
		}
	}
	return res, nil
}

// snapshotQACheckout records the checkout's state before the run.
func snapshotQACheckout(ctx context.Context, dir string) (*qaCheckoutSnapshot, error) {
	head, err := qaGit(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	dirty, err := qaGitStatus(ctx, dir)
	if err != nil {
		return nil, err
	}
	snap := &qaCheckoutSnapshot{Head: strings.TrimSpace(string(head)), Dirty: dirty, Content: map[string][]byte{}}
	for path := range dirty {
		full := filepath.Join(dir, path)
		fi, err := os.Lstat(full)
		if err != nil || !fi.Mode().IsRegular() || fi.Size() > qaGuardMaxFile {
			continue
		}
		if b, err := os.ReadFile(full); err == nil {
			snap.Content[path] = b
		}
	}
	return snap, nil
}

// restoreQACheckout puts back everything the run changed since snap and
// returns a human line per path that was put back (sorted), plus notes about
// what could NOT be put back. Never touches a path whose pre-run state it
// cannot reproduce (a pre-existing dirty directory/submodule, a too-big file).
func restoreQACheckout(ctx context.Context, dir string, snap *qaCheckoutSnapshot) (restored, notes []string) {
	if snap == nil {
		return nil, nil
	}
	now, err := qaGitStatus(ctx, dir)
	if err != nil {
		return nil, []string{"Kon de werkmap na de run niet controleren: " + err.Error()}
	}
	paths := map[string]bool{}
	for p := range now {
		paths[p] = true
	}
	for p := range snap.Dirty {
		paths[p] = true
	}
	sorted := make([]string, 0, len(paths))
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	for _, p := range sorted {
		before, wasDirty := snap.Dirty[p]
		code, isDirty := now[p]
		full := filepath.Join(dir, p)
		if !wasDirty {
			// Clean before the run: whatever the run did to it goes.
			if !isDirty {
				continue
			}
			if code == "??" {
				if err := os.RemoveAll(full); err != nil {
					notes = append(notes, "Kon "+p+" niet verwijderen: "+err.Error())
					continue
				}
				removeEmptyParents(dir, full)
				restored = append(restored, p+" (toegevoegd, verwijderd)")
				continue
			}
			// Not in HEAD (staged as new, or the new side of a rename/copy):
			// it was added by the run, so it goes.
			if _, err := qaGit(ctx, dir, "cat-file", "-e", "HEAD:"+p); err != nil {
				_, _ = qaGit(ctx, dir, "rm", "--cached", "-q", "-f", "--", p)
				if err := os.RemoveAll(full); err != nil {
					notes = append(notes, "Kon "+p+" niet verwijderen: "+err.Error())
					continue
				}
				removeEmptyParents(dir, full)
				restored = append(restored, p+" (toegevoegd, verwijderd)")
				continue
			}
			if _, err := qaGit(ctx, dir, "restore", "--source=HEAD", "--staged", "--worktree", "--", p); err != nil {
				notes = append(notes, "Kon "+p+" niet terugzetten: "+err.Error())
				continue
			}
			restored = append(restored, p+" (gewijzigd, teruggezet)")
			continue
		}
		// Dirty before the run (the user's own change): put its content back
		// if the run touched it.
		want, have := snap.Content[p]
		if !have {
			if isDirty && code != before {
				notes = append(notes, p+" stond al open en is tijdens de run veranderd, maar kon niet automatisch worden teruggezet.")
			}
			continue
		}
		cur, err := os.ReadFile(full)
		if err == nil && bytes.Equal(cur, want) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err == nil {
			err = os.WriteFile(full, want, 0o644)
		}
		if err != nil {
			notes = append(notes, "Kon "+p+" niet terugzetten: "+err.Error())
			continue
		}
		restored = append(restored, p+" (al open gewijzigd bestand, teruggezet naar de staat van vóór de run)")
	}
	if head, err := qaGit(ctx, dir, "rev-parse", "HEAD"); err == nil && strings.TrimSpace(string(head)) != snap.Head {
		notes = append(notes, fmt.Sprintf("De werkmap staat na de run op een andere commit (%s → %s); dat is niet automatisch teruggedraaid.",
			shortSHA(snap.Head), shortSHA(strings.TrimSpace(string(head)))))
	}
	return restored, notes
}

// qaGuardDeviation is the one deviation line naming what was put back.
func qaGuardDeviation(restored []string) string {
	const max = 12
	list := restored
	more := ""
	if len(list) > max {
		more = fmt.Sprintf(" en nog %d", len(list)-max)
		list = list[:max]
	}
	return fmt.Sprintf("slash heeft na de run %d bestand(en) in de werkmap teruggezet die de run had toegevoegd of gewijzigd: %s%s.",
		len(restored), strings.Join(list, ", "), more)
}

// removeEmptyParents drops the directories a removed file leaves empty, up to
// (not including) the checkout root — git does not track directories, so an
// emptied one only ever existed for the file the run added.
func removeEmptyParents(root, file string) {
	root = filepath.Clean(root)
	for d := filepath.Dir(file); d != root && strings.HasPrefix(d, root+string(filepath.Separator)); d = filepath.Dir(d) {
		if os.Remove(d) != nil {
			return
		}
	}
}
