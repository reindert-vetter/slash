package warnreviewed

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMarkReviewedAndHashes(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "warnreviewed.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	if err := m.MarkReviewed(ctx, "", 12, "a.php", "h1", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := m.MarkReviewed(ctx, "", 12, "b.php", "h2", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}

	hashes, err := m.Hashes(ctx, "", 12)
	if err != nil {
		t.Fatal(err)
	}
	if hashes["a.php"] != "h1" || hashes["b.php"] != "h2" {
		t.Fatalf("hashes = %+v", hashes)
	}

	// Overwriting a file's hash (a fresh review after a real change) replaces
	// it, not adds a second row — see the upsert in MarkReviewed.
	if err := m.MarkReviewed(ctx, "", 12, "a.php", "h1-new", "2026-01-02T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	hashes, err = m.Hashes(ctx, "", 12)
	if err != nil {
		t.Fatal(err)
	}
	if len(hashes) != 2 || hashes["a.php"] != "h1-new" {
		t.Fatalf("hashes after re-review = %+v", hashes)
	}
}

// Two repos sharing the same PR number and file must not collide — same
// reasoning as TestModulesAreRepoScoped for warndismiss/prmeta.
func TestReviewedFilesAreRepoScoped(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "warnreviewed.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	if err := m.MarkReviewed(ctx, "", 12, "a.php", "primary-hash", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := m.MarkReviewed(ctx, "ops/repo", 12, "a.php", "ops-hash", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}

	if hashes, err := m.Hashes(ctx, "", 12); err != nil || hashes["a.php"] != "primary-hash" {
		t.Fatalf("primary hashes = %+v (err=%v)", hashes, err)
	}
	if hashes, err := m.Hashes(ctx, "ops/repo", 12); err != nil || hashes["a.php"] != "ops-hash" {
		t.Fatalf("second-repo hashes = %+v (err=%v)", hashes, err)
	}
}

func TestHashContentIsStableAndSensitiveToContent(t *testing.T) {
	a := HashContent([]byte("hello"))
	b := HashContent([]byte("hello"))
	c := HashContent([]byte("hello!"))
	if a != b {
		t.Fatalf("same content hashed differently: %q vs %q", a, b)
	}
	if a == c {
		t.Fatalf("different content hashed identically: %q", a)
	}
}
