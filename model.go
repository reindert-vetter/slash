package main

import (
	"encoding/json"
	"fmt"
)

// Status of a block relative to the PR.
const (
	StatusAdded    = "added"
	StatusRemoved  = "removed"
	StatusModified = "modified"
)

// Side indicates which worktree line/endLine refer to.
const (
	SideNew = "new"
	SideOld = "old"
)

// Block is one function/method from a changed file — or the whole file if it
// could not be parsed. This is exactly one `blocks` row in the call-graph.
type Block struct {
	// Repo is the canonical repo string this block's PR belongs to: "" for the
	// primary repo — which is why every pre-multi-repo row and every stored
	// block id stays valid untouched — and "owner/name" for any other (see
	// repos.go).
	Repo     string `json:"repo,omitempty"`
	PR       int    `json:"pr"`
	File     string `json:"file"`
	Class    string `json:"class"` // "" for free functions / whole-file fallback
	Name     string `json:"name"`  // symbol (method/function) or file name for the fallback
	Category string `json:"category"`
	Line     int    `json:"line"`    // declaration line
	EndLine  int    `json:"endLine"` // line of the closing brace
	Status   string `json:"status"`  // added|removed|modified
	// FileDeleted marks a block whose whole file was deleted by the PR (the
	// file is absent from the head worktree — git's `+++ /dev/null` case), as
	// opposed to a single removed method in a file that still exists.
	FileDeleted bool `json:"fileDeleted"`
	// OldFile is the pre-rename path of this block's file when the PR moved it
	// (a git-detected rename, `git diff --find-renames`), "" otherwise. File
	// stays the NEW path (so the block id/diff key live on the head path); the
	// old source is read from OldFile in the base worktree (/api/code,
	// blockstats). See .claude/docs/blocks-and-ingest.md.
	OldFile  string `json:"oldFile"`
	Side     string `json:"side"`     // new|old
	Approved bool   `json:"approved"` // approved by the reviewer?
	Label    string `json:"label"`    // "Class::method" or "name" — for the frontend
	// Description is the free-text summary extracted from a PHPDoc comment
	// (`/** ... */`, tag lines like @param/@return stripped) directly above
	// the function/method declaration — deterministic, no AI. "" if there was
	// no such PHPDoc. See phpscan.go's phpDocDescription and
	// .claude/docs/blocks-and-ingest.md.
	Description string `json:"description"`
	// IsInterface marks a method declared directly inside an `interface`
	// body (set by phpscan.go's scanPHP, via the enclosing classFrame's
	// kind). It's a transient classification signal consumed by
	// classify.go (which overrides Category to "INTERFACE" regardless of
	// the file's path) — not needed by the frontend, hence json:"-".
	// See .claude/docs/blocks-and-ingest.md.
	IsInterface bool `json:"-"`
	// IsTrait mirrors IsInterface for a method declared directly inside a
	// `trait` body — classify.go overrides Category to "TRAIT" regardless
	// of the file's path, since a trait file isn't confined to a `Traits/`
	// directory. See .claude/docs/blocks-and-ingest.md.
	IsTrait bool `json:"-"`
}

// ID is stable per (repo, pr, file, symbol) so re-ingest is idempotent. For the
// PRIMARY repo the id is byte-identical to the pre-multi-repo form
// ("<pr>:<file>:<symbol>") — every stored comment/approval/relation/callresolve
// row keyed by a block id keeps matching, and the frontend keeps rebuilding ids
// the same way. A block from another repo gets that repo's short key in front
// ("ops#12:app/Foo.php:Foo::bar"), so two repos can each have a PR 12 without
// their blocks colliding on one id.
func (b Block) ID() string {
	return fmt.Sprintf("%s%d:%s:%s", blockIDRepoPrefix(b.Repo), b.PR, b.File, b.symbol())
}

// blocksRepo is the canonical repo string a set of blocks belongs to. Every
// block handed around in this app comes from ONE PR (they are always loaded per
// PR, see blocksByPR), so the first block answers for all of them — which lets
// the whole analysis layer (call resolve, test covers, blockstats, re-anchor,
// warnings) stay on its existing signatures and still find the right worktree.
// An empty set answers "the primary repo", the same safe default an unknown repo
// canonicalizes to.
func blocksRepo(blocks []Block) string {
	if len(blocks) == 0 {
		return ""
	}
	return blocks[0].Repo
}

// blockIDRepoPrefix is the "<key>#" a non-primary repo's block ids carry, and ""
// for the primary repo. Also used by anything that builds a block-id PREFIX to
// match rows with (see resolve_test_covers.go).
func blockIDRepoPrefix(repo string) string {
	if repo == "" {
		return ""
	}
	return repoKeyOf(repo) + "#"
}

// MarshalJSON emits the block plus its computed "id" so the frontend can match
// relation parent/child ids to blocks.
func (b Block) MarshalJSON() ([]byte, error) {
	type alias Block
	return json.Marshal(struct {
		alias
		ID string `json:"id"`
	}{alias(b), b.ID()})
}

// oldPath is the base-worktree path to read this block's OLD source from: its
// pre-rename path when the PR moved the file, else its current File. Used by
// /api/code and blockstats so the old diff side is read from where the file
// actually was before the rename.
func (b Block) oldPath() string {
	if b.OldFile != "" {
		return b.OldFile
	}
	return b.File
}

// symbol is the key old and new blocks are matched on.
func (b Block) symbol() string {
	if b.Class != "" {
		return b.Class + "::" + b.Name
	}
	return b.Name
}

// makeLabel fills Label based on class/name.
func (b *Block) makeLabel() {
	b.Label = b.symbol()
}
