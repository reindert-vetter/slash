package warndismiss

import (
	"context"
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

// A dismissal is remembered per PR + file + finding text, and re-adding the
// same one is a no-op (so replaying the Activity that writes it is safe).
func TestAddAndLookup(t *testing.T) {
	m := open(t)
	ctx := context.Background()
	fp := Fingerprint("Dit tarief hoort een constante te zijn.")

	if err := m.Add(ctx, "", 7, "app/Foo.php", fp, "2026-08-09T10:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if err := m.Add(ctx, "", 7, "app/Foo.php", fp, "2026-08-09T11:00:00Z"); err != nil {
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
	if err := m.Add(ctx, "", 7, "app/Foo.php", "", ""); err != nil {
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
