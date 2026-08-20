// comment_titles.go — helpers for the comment_titles workflow: the
// deterministic Run ID that makes a repeated request for the same set of
// untitled comments an idempotent no-op (mirrors chat_summary.go's
// chatSummaryRunID), the Dutch batch prompt asking Haiku for a short title per
// comment, and the parsing/trimming of what comes back.
//
// One run titles a BATCH of comments in a single Haiku call, keyed by index
// rather than by comment id: a model reproduces "3" reliably and a
// "cmt-1a2b…" id not at all. A batch instead of one run per comment is
// deliberate — a PR with forty comments would otherwise start forty `claude`
// subprocesses for what is a one line answer each.
//
// See .claude/docs/workflows-analysis.md ("comment_titles") and
// .claude/docs/comments-panel.md for how the result is rendered.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// maxCommentTitleWords caps a title hard, on our side, so a chatty model can
// never break the single-line heading it is rendered as (the prompt asks for
// at most 6 words; this enforces it).
const maxCommentTitleWords = 6

// maxCommentTitleBatch caps how many comments one run titles. Anything left
// over is picked up by the next request: the untitled set has then shrunk, so
// its Run ID differs and the follow-up start is a real new Execution rather
// than a deduped no-op.
const maxCommentTitleBatch = 25

// maxCommentTitleBody clips one comment's body in the prompt. A six word title
// needs the gist, never the tail of a long quoted stack trace.
const maxCommentTitleBody = 1200

// commentTitleRef identifies one comment to title, plus the body length it is
// being titled FOR — see comments.Comment.TitleBodyLen: an edited body yields
// a different length, hence a different Run ID, hence a fresh title instead of
// a deduped no-op that would leave the old one in place forever.
type commentTitleRef struct {
	ID      string `json:"id"`
	BodyLen int    `json:"bodyLen"`
}

// commentTitleOut is one entry of the model's JSON answer.
type commentTitleOut struct {
	N     int    `json:"n"`
	Title string `json:"title"`
}

// sortCommentTitleRefs orders a batch by id, so the same set of comments
// always yields the same Run ID and the same prompt numbering regardless of
// the order the caller happened to send them in (and so the workflow body
// never iterates anything map-ordered — see
// .claude/rules/workflow-determinism.md).
func sortCommentTitleRefs(refs []commentTitleRef) []commentTitleRef {
	out := make([]commentTitleRef, len(refs))
	copy(out, refs)
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// commentTitlesRunID derives a deterministic, filename-safe Run ID from the PR
// plus the sorted (id, bodyLen) pairs of the batch. StartWorkflowID then dedups
// repeated starts: the frontend may fire this on every comment poll without
// ever triggering a second LLM call for the same set.
func commentTitlesRunID(pr int, refs []commentTitleRef) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d", pr)
	for _, r := range sortCommentTitleRefs(refs) {
		fmt.Fprintf(&b, "|%s:%d", r.ID, r.BodyLen)
	}
	sum := sha256.Sum256([]byte(b.String()))
	return "ctitle-" + hex.EncodeToString(sum[:12])
}

// commentTitlesPrompt builds the call-specific part of the context-only Haiku
// prompt: every comment in the batch, numbered from 1, with its body clipped.
// The task framing (Dutch, max 6 words, the JSON contract) travels separately
// as claude.CommentTitleSystemPrompt (--append-system-prompt). Numbering
// follows the given order, which the workflow keeps sorted — so index → id is
// reproducible on replay.
func commentTitlesPrompt(bodies []string) string {
	var b strings.Builder
	b.WriteString("Comments:\n\n")
	for i, body := range bodies {
		fmt.Fprintf(&b, "%d. %s\n\n", i+1, clipForPrompt(body, maxCommentTitleBody))
	}
	return b.String()
}

// parseCommentTitles extracts the first [...] JSON array from the model output
// (models sometimes wrap it in prose or fences) and returns index → title,
// already trimmed to maxCommentTitleWords. An index outside the batch, or an
// empty title, is dropped — the caller then records that comment as failed.
func parseCommentTitles(raw string, batch int) map[int]string {
	start := strings.IndexByte(raw, '[')
	end := strings.LastIndexByte(raw, ']')
	if start < 0 || end <= start {
		return nil
	}
	var out []commentTitleOut
	if err := json.Unmarshal([]byte(raw[start:end+1]), &out); err != nil {
		return nil
	}
	titles := make(map[int]string, len(out))
	for _, t := range out {
		if t.N < 1 || t.N > batch {
			continue
		}
		title := trimToTitleWords(t.Title)
		if title == "" {
			continue
		}
		titles[t.N] = title
	}
	return titles
}

// trimToTitleWords normalizes one title: collapse whitespace, drop a trailing
// period and any surrounding quotes, then keep at most maxCommentTitleWords
// words. A pure function, so it is safe to apply inside the save Activity
// without touching determinism.
func trimToTitleWords(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"'`)
	words := strings.Fields(s)
	if len(words) > maxCommentTitleWords {
		words = words[:maxCommentTitleWords]
	}
	out := strings.Join(words, " ")
	return strings.TrimRight(out, ".,;:")
}
