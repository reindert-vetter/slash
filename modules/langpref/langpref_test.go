package langpref

import (
	"context"
	"path/filepath"
	"testing"
)

func TestLangDefaultsToDutch(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "langpref.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	for _, kind := range Kinds {
		lang, err := m.Lang(context.Background(), "test/repo", kind)
		if err != nil {
			t.Fatal(err)
		}
		if lang != LangNL {
			t.Fatalf("Lang(%q) = %q, want %q (default) for a repo that never saved one", kind, lang, LangNL)
		}
	}
}

func TestSetLangPersistsPerKindAndRepo(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "langpref.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	if err := m.SetLang(ctx, "test/repo", KindExplain, LangEN); err != nil {
		t.Fatal(err)
	}
	if lang, _ := m.Lang(ctx, "test/repo", KindExplain); lang != LangEN {
		t.Fatalf("explain = %q after SetLang(en), want %q", lang, LangEN)
	}
	// One kind's choice never leaks into another kind…
	if lang, _ := m.Lang(ctx, "test/repo", KindReply); lang != LangNL {
		t.Fatalf("reply = %q, want %q — another kind's choice must not leak", lang, LangNL)
	}
	// …nor into another repo.
	if lang, _ := m.Lang(ctx, "other/repo", KindExplain); lang != LangNL {
		t.Fatalf("other repo explain = %q, want %q", lang, LangNL)
	}

	// Re-applying the same value is a no-op (replay safety), and switching back
	// is an ordinary update.
	if err := m.SetLang(ctx, "test/repo", KindExplain, LangEN); err != nil {
		t.Fatal(err)
	}
	if err := m.SetLang(ctx, "test/repo", KindExplain, LangNL); err != nil {
		t.Fatal(err)
	}
	if lang, _ := m.Lang(ctx, "test/repo", KindExplain); lang != LangNL {
		t.Fatalf("explain = %q after switching back, want %q", lang, LangNL)
	}
}

func TestAllFillsInEveryKind(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "langpref.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()

	if err := m.SetLang(ctx, "test/repo", KindUI, LangEN); err != nil {
		t.Fatal(err)
	}
	all, err := m.All(ctx, "test/repo")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != len(Kinds) {
		t.Fatalf("All() = %v, want one entry per kind %v", all, Kinds)
	}
	if all[KindUI] != LangEN || all[KindExplain] != LangNL || all[KindReply] != LangNL {
		t.Fatalf("All() = %v, want ui=en and the other two at the nl default", all)
	}
}

func TestValidKindAndLang(t *testing.T) {
	for _, k := range Kinds {
		if !ValidKind(k) {
			t.Fatalf("ValidKind(%q) = false", k)
		}
	}
	if ValidKind("commit") || ValidKind("") {
		t.Fatal("ValidKind accepted an unknown kind — the commit language is deliberately not a preference")
	}
	if !ValidLang(LangNL) || !ValidLang(LangEN) {
		t.Fatal("ValidLang rejected a supported language")
	}
	if ValidLang("de") || ValidLang("") {
		t.Fatal("ValidLang accepted an unsupported language")
	}
}
