package main

import (
	"net/http"
	"strconv"
)

// approval_summary.go serves the PR-overview approval badge:
//   GET /api/approvalsummary?prs=12,13 — per PR a {done,total} reviewer-approval
// rollup over the WHOLE PR (every block once): total = the number of approvable
// changed rows across all blocks of the PR (the same server-side count as
// /api/blockstats, blockstats.go), done = how many of those a reviewer has
// ticked off (from the approvals read-model). This mirrors the /pr/<id> sidebar
// PR-wide counter (home.mjs state.approvalTotal), but summed server-side over
// blocksByPR so the overview needs no block/relation data of its own.
//
// READ-only: it only reads the blocks table, the approvals read-model, and the
// base/head worktrees (a side effect, no mutation — exactly like /api/blockstats),
// so it is fine from a read handler per the write-boundary rule. Bounded to the
// requested PRs (?prs=, the overview's visible ingested rows) so the
// worktree/LCS work stays small.
func (s *server) handleApprovalSummary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	numbers := parsePRList(r.URL.Query().Get("prs"))
	summaries := map[string]map[string]int{}
	for _, pr := range numbers {
		blocks, err := blocksByPR(s.db, pr)
		if err != nil || len(blocks) == 0 {
			continue
		}
		// Approved-row count per block id, from the read-model. This is the
		// "code-not-loaded" branch of the frontend's blockApproveCount: done is
		// the approved-row count clamped to the block's total (approvedRows only
		// ever holds changed-row indices, so len is the right measure here).
		approvedByID := map[string]int{}
		if list, err := s.tasks.approvals.List(r.Context(), pr); err == nil {
			for _, a := range list {
				approvedByID[a.BlockID] = len(a.Rows)
			}
		}
		baseDir, headDir := worktreeDirs(s.dataDir, pr)
		done, total := 0, 0
		for _, b := range blocks {
			t := blockChangedRowCount(baseDir, headDir, b)
			total += t
			if d := approvedByID[b.ID()]; d > 0 {
				if d > t {
					d = t
				}
				done += d
			}
		}
		summaries[strconv.Itoa(pr)] = map[string]int{"done": done, "total": total}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "summaries": summaries})
}
