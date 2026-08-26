package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// image_asset.go — raster images in the review tree.
//
// A changed .png/.jpg/… is a whole-file block like any other non-PHP file
// (ScanBlocks' wholeFileBlock fallback, phpscan.go), but its bytes are not
// text: a raw text diff of it is mojibake, and the reviewer wants to SEE the
// image. Two halves live here:
//
//   - imagePlaceholderSide (used by extractBlockSource, code.go) replaces such
//     a file's "source" with ONE descriptive line, so /api/code, blockstats'
//     row space and the AI passes all see a sane one-liner instead of binary
//     noise — and a modified image ends up with exactly one changed row, so a
//     single Space approves it.
//   - handleImage serves the actual bytes, so Block.mjs's imageSlot can render
//     an old/new <img> preview instead of the text diff (the svgSlot
//     precedent). Read-only, like every other GET here.
//
// See .claude/docs/diff-render.md and .claude/docs/blocks-and-ingest.md.

// imageContentTypes is the whitelist of raster image extensions this app
// renders — deliberately an allowlist, so the handler below can never be
// talked into serving an arbitrary worktree file (a .php, an .env) as an
// "image", and so the Content-Type is always one we chose rather than one
// sniffed from untrusted bytes.
//
// The set comes from an inventory of what plug-and-pay actually tracks
// (.png 479, .jpg 23, .ico 6, .gif 4, .avif 1) plus .jpeg/.webp, which cost
// nothing to accept. `.svg` is deliberately ABSENT: it is text, already has
// its own rendered preview via a data URI (svgDataUri/svgSlot in
// Block.mjs), and must keep flowing through the ordinary text path.
var imageContentTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico":  "image/x-icon",
}

// imageMaxBytes caps how much of a file the handler will serve. Repo images
// are small (icons, screenshots); anything bigger is refused rather than
// streamed into the page.
const imageMaxBytes = 16 << 20 // 16 MiB

// isImagePath reports whether file has one of the whitelisted raster image
// extensions above. The single source of truth for "this is an image, not
// text" on the Go side (classify.go, code.go and handleImage all call it), so
// the ingest, the placeholder and the served bytes can never disagree about
// which files are images.
func isImagePath(file string) bool {
	_, ok := imageContentTypes[strings.ToLower(filepath.Ext(file))]
	return ok
}

// imagePlaceholderSide returns the one-line stand-in for a raster image
// file's "source": its format, size and a short content hash, e.g.
//
//	binaire afbeelding (PNG, 12.4 kB, sha 1a2b3c4d)
//
// Absent file (the block's other side doesn't exist — an added or removed
// image) → zero value, exactly like extractBlockSource's own missing-file
// case.
//
// The HASH is load-bearing, not decoration: the old and new side must be
// genuinely DIFFERENT text whenever the image changed, or alignRows would see
// one unchanged context row and the block would have zero changed rows to
// approve. Size alone isn't enough (two different images can be the same
// number of bytes).
func imagePlaceholderSide(path string) codeSide {
	data, err := os.ReadFile(path)
	if err != nil {
		return codeSide{}
	}
	sum := sha256.Sum256(data)
	kind := strings.ToUpper(strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), "."))
	return codeSide{
		Start: 1,
		End:   1,
		Text:  fmt.Sprintf("binaire afbeelding (%s, %s, sha %s)", kind, humanBytes(len(data)), hex.EncodeToString(sum[:])[:8]),
	}
}

// humanBytes formats a byte count for the placeholder line above. Deliberately
// tiny and deterministic (no locale, no dependency): B up to 1 kB, then kB/MB
// with one decimal.
func humanBytes(n int) string {
	switch {
	case n < 1000:
		return fmt.Sprintf("%d B", n)
	case n < 1000*1000:
		return fmt.Sprintf("%.1f kB", float64(n)/1000)
	default:
		return fmt.Sprintf("%.1f MB", float64(n)/1000/1000)
	}
}

// handleImage serves GET /api/image?pr=N&file=...&side=old|new[&repo=][&oldFile=]
// — the raw bytes of one raster image file from the PR's base (side=old) or
// head (side=new) worktree, so Block.mjs can show it in an <img>.
//
// Guarded like handleCode: the path must resolve to a real file inside that
// worktree (resolveWithinWorktree), plus the extension whitelist above.
// oldFile redirects the OLD side to the block's pre-rename path
// (blockmove.go), exactly like /api/code's own oldFile.
func (s *server) handleImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	pr, err := strconv.Atoi(q.Get("pr"))
	if err != nil || pr <= 0 {
		http.Error(w, "invalid pr", http.StatusBadRequest)
		return
	}
	file := q.Get("file")
	if file == "" || strings.Contains(file, "..") {
		http.Error(w, "invalid file", http.StatusBadRequest)
		return
	}
	side := q.Get("side")
	if side != "old" && side != "new" {
		http.Error(w, "invalid side", http.StatusBadRequest)
		return
	}
	// The OLD side of a renamed file lives at its pre-rename path in the base
	// worktree; same `..` guard as file.
	oldFile := q.Get("oldFile")
	if oldFile == "" || strings.Contains(oldFile, "..") {
		oldFile = file
	}
	rel := file
	if side == "old" {
		rel = oldFile
	}
	contentType, ok := imageContentTypes[strings.ToLower(filepath.Ext(rel))]
	if !ok {
		http.Error(w, "unsupported image type", http.StatusBadRequest)
		return
	}

	repo := queryRepo(r)
	baseDir, headDir := worktreeDirs(s.dataDir, repo, pr)
	dir := headDir
	if side == "old" {
		dir = baseDir
	}
	// resolveWithinWorktree (code.go) both confines the path to that worktree and
	// requires it to exist — a stronger guard than /api/code's blockFileExists
	// lookup, which only has to tolerate a MISSING side. Combined with the
	// extension whitelist above, an arbitrary path can neither escape the
	// worktree nor be served as an image.
	full, _, inWorktree := resolveWithinWorktree(dir, rel)
	if !inWorktree {
		http.Error(w, "unknown image", http.StatusNotFound)
		return
	}

	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.Error(w, "unknown image", http.StatusNotFound)
		return
	}
	if info.Size() > imageMaxBytes {
		http.Error(w, "image too large", http.StatusRequestEntityTooLarge)
		return
	}
	data, err := os.ReadFile(full)
	if err != nil {
		http.Error(w, "read failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", contentType)
	// Never let the browser sniff its own type out of PR-supplied bytes: the
	// whitelist above is the only thing that decides what this is.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// A worktree is re-materialized on every ingest refresh, so the same URL
	// can legitimately return different bytes for the same PR.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
