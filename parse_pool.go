package main

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
)

// fileResult is the result of parsing one file.
type fileResult struct {
	path   string
	blocks []Block
	err    error
}

// parseFiles parses all changed files concurrently and classifies the blocks.
// baseDir/headDir are the two worktrees. diffs is the per-file diff map.
// renames maps a new path to its pre-rename old path (from detectRenames, may
// be nil): a renamed file's OLD source is read from that old path in the base
// worktree so old and new blocks pair up as one logical file. The paths are
// always the NEW (head) paths.
func parseFiles(pr int, paths []string, renames map[string]string, baseDir, headDir string, diffs map[string]*fileDiff) ([]Block, []error) {
	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	if workers < 1 {
		workers = 1
	}

	jobs := make(chan string)
	results := make(chan fileResult)

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range jobs {
				results <- parseOneFile(pr, path, renames[path], baseDir, headDir, diffs[path])
			}
		}()
	}

	go func() {
		for _, p := range paths {
			jobs <- p
		}
		close(jobs)
	}()

	go func() {
		wg.Wait()
		close(results)
	}()

	var all []Block
	var errs []error
	for r := range results {
		if r.err != nil {
			errs = append(errs, r.err)
		}
		all = append(all, r.blocks...)
	}

	// Stable order for deterministic /api/blocks output.
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].File != all[j].File {
			return all[i].File < all[j].File
		}
		return all[i].Line < all[j].Line
	})
	return all, errs
}

// parseOneFile reads the old + new version, scans both and classifies. A panic
// in the scanner is recovered and handled as a whole-file fallback. oldPath is
// the file's pre-rename path (from renames[path]); "" means no rename, so the
// old source is read from `path` like the new source. Either way the blocks
// carry File=path (the new head path) — a rename only redirects where the OLD
// side is read and stamps oldFile on the blocks.
func parseOneFile(pr int, path, oldPath, baseDir, headDir string, fd *fileDiff) (res fileResult) {
	res.path = path
	oldFile := "" // display old path stamped on every block; "" unless a rename
	if oldPath != "" && oldPath != path {
		oldFile = oldPath
	} else {
		oldPath = path
	}
	defer func() {
		if rec := recover(); rec != nil {
			// Scanner panic → whole-file fallback on the new version.
			newSrc, _ := os.ReadFile(filepath.Join(headDir, path))
			fb := wholeFileBlock(newSrc, path)
			fb.PR = pr
			fb.Category = categoryFor(path)
			fb.Status = StatusModified
			fb.Side = SideNew
			fb.OldFile = oldFile
			res.blocks = []Block{fb}
		}
	}()

	oldSrc, oldErr := os.ReadFile(filepath.Join(baseDir, oldPath))
	newSrc, newErr := os.ReadFile(filepath.Join(headDir, path))

	fileAdded := oldErr != nil // file absent in base → added
	fileDeleted := newErr != nil

	var oldBlocks, newBlocks []Block
	if !fileAdded {
		oldBlocks = ScanBlocks(oldSrc, path)
	}
	if !fileDeleted {
		newBlocks = ScanBlocks(newSrc, path)
	}

	res.blocks = classifyFile(pr, path, oldFile, oldBlocks, newBlocks, fd, fileAdded, fileDeleted, string(oldSrc), string(newSrc))
	return res
}
