package main

import "fmt"

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
	PR       int    `json:"pr"`
	File     string `json:"file"`
	Class    string `json:"class"` // "" for free functions / whole-file fallback
	Name     string `json:"name"`  // symbol (method/function) or file name for the fallback
	Category string `json:"category"`
	Line     int    `json:"line"`     // declaration line
	EndLine  int    `json:"endLine"`  // line of the closing brace
	Status   string `json:"status"`   // added|removed|modified
	Side     string `json:"side"`     // new|old
	Approved bool   `json:"approved"` // approved by the reviewer?
	Label    string `json:"label"`    // "Class::method" or "name" — for the frontend
}

// ID is stable per (pr, file, symbol) so re-ingest is idempotent.
func (b Block) ID() string {
	return fmt.Sprintf("%d:%s:%s", b.PR, b.File, b.symbol())
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
