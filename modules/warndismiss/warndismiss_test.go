package warndismiss

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func open(t *testing.T) *Module {
	t.Helper()
	m, err := Open(filepath.Join(t.TempDir(), "warndismiss.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return m
}

// sqlOpenNoText creates a DB with the pre-text schema, for
// TestMigrateTextAddsColumnToExistingDB. The sqlite driver is already
// registered by warndismiss.go's own blank import.
func sqlOpenNoText(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS dismissed_warnings (
		  repo        TEXT    NOT NULL DEFAULT '',
		  pr          INTEGER NOT NULL,
		  file        TEXT    NOT NULL,
		  fingerprint TEXT    NOT NULL,
		  created_at  TEXT    NOT NULL DEFAULT '',
		  PRIMARY KEY (repo, pr, file, fingerprint)
		);
	`); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// A dismissal is remembered per PR + file + finding text, and re-adding the
// same one is a no-op (so replaying the Activity that writes it is safe).
func TestAddAndLookup(t *testing.T) {
	m := open(t)
	ctx := context.Background()
	text := "Dit tarief hoort een constante te zijn."
	fp := Fingerprint(text)

	if err := m.Add(ctx, "", 7, "app/Foo.php", fp, text, "2026-08-09T10:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := m.Add(ctx, "", 7, "app/Foo.php", fp, text, "2026-08-09T11:00:00Z"); err != nil {
		t.Fatalf("re-adding the same dismissal must be a no-op: %v", err)
	}

	got, err := m.Fingerprints(ctx, "", 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !got[Key("app/Foo.php", fp)] {
		t.Fatalf("fingerprints = %+v, want the one dismissal", got)
	}
	// Another PR never sees it, and neither does another file.
	other, err := m.Fingerprints(ctx, "", 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(other) != 0 {
		t.Fatalf("fingerprints for another PR = %+v, want none", other)
	}
	if got[Key("app/Bar.php", fp)] {
		t.Fatal("a dismissal leaked to another file")
	}
}

// The fingerprint normalises whitespace and case, so the same finding
// re-reported with cosmetic differences still counts as dismissed — but a
// genuinely different wording does not.
func TestFingerprintNormalises(t *testing.T) {
	a := Fingerprint("Dit tarief   hoort een\nconstante te zijn.")
	b := Fingerprint("dit tarief hoort een constante te zijn.")
	if a != b {
		t.Fatalf("fingerprints differ on whitespace/case: %q vs %q", a, b)
	}
	if a == Fingerprint("Iets heel anders.") {
		t.Fatal("different texts share a fingerprint")
	}
	if Fingerprint("   ") != "" {
		t.Fatal("an empty text must have no fingerprint")
	}
}

// An empty fingerprint is never stored — it would match every other empty
// finding body.
func TestAddIgnoresEmptyFingerprint(t *testing.T) {
	m := open(t)
	ctx := context.Background()
	if err := m.Add(ctx, "", 7, "app/Foo.php", "", "", ""); err != nil {
		t.Fatal(err)
	}
	got, err := m.Fingerprints(ctx, "", 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("fingerprints = %+v, want none", got)
	}
}

// List returns every dismissed finding's own wording, scoped to its PR, so
// the code_warning prompt can hand the model the exact text it dismissed
// earlier (not just an unreadable hash) — see the package doc comment.
func TestListReturnsDismissedText(t *testing.T) {
	m := open(t)
	ctx := context.Background()

	textA := "Dit tarief hoort een constante te zijn."
	textB := "Deze query mist een index."
	if err := m.Add(ctx, "", 7, "app/Foo.php", Fingerprint(textA), textA, "2026-08-09T10:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := m.Add(ctx, "", 7, "app/Bar.php", Fingerprint(textB), textB, "2026-08-09T11:00:00Z"); err != nil {
		t.Fatal(err)
	}
	// Another PR must never see it.
	if err := m.Add(ctx, "", 8, "app/Foo.php", Fingerprint(textA), textA, "2026-08-09T12:00:00Z"); err != nil {
		t.Fatal(err)
	}

	got, err := m.List(ctx, "", 7)
	if err != nil {
		t.Fatal(err)
	}
	want := []DismissedFinding{{File: "app/Bar.php", Text: textB}, {File: "app/Foo.php", Text: textA}}
	if len(got) != len(want) {
		t.Fatalf("List = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("List[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// A pre-existing DB created before the text column existed still opens and
// reads back its rows (with an empty text), and the schema now has the
// column so a fresh Add fills it in.
func TestMigrateTextAddsColumnToExistingDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "warndismiss.db")
	ctx := context.Background()

	// Simulate the pre-text schema directly.
	old, err := sqlOpenNoText(path)
	if err != nil {
		t.Fatal(err)
	}
	fp := Fingerprint("Oude bevinding.")
	if _, err := old.ExecContext(ctx,
		`INSERT INTO dismissed_warnings (repo, pr, file, fingerprint, created_at) VALUES ('', 9, 'app/Old.php', ?, '2026-08-09T09:00:00Z')`, fp); err != nil {
		t.Fatal(err)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}

	m, err := Open(path)
	if err != nil {
		t.Fatalf("opening a pre-text DB must migrate cleanly: %v", err)
	}
	defer m.Close()

	fingerprints, err := m.Fingerprints(ctx, "", 9)
	if err != nil {
		t.Fatal(err)
	}
	if !fingerprints[Key("app/Old.php", fp)] {
		t.Fatalf("fingerprint lost across migration: %+v", fingerprints)
	}
	list, err := m.List(ctx, "", 9)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].File != "app/Old.php" || list[0].Text != "" {
		t.Fatalf("List after migration = %+v, want one row with empty text", list)
	}
}
