package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestVueTranslationKeysIn(t *testing.T) {
	tests := []struct {
		name string
		scan string
		want []string
	}{
		{
			name: "single and double quoted $t",
			scan: `<h2>{{ $t("checkouts.show.general.seo.title") }}</h2>` + "\n" +
				`:label="$t('checkouts.show.general.seo.page_title')"`,
			// vueTranslationKeysIn (like translationKeysIn) runs the single-
			// and double-quote regexes separately, so results are grouped by
			// quote style, not by position in the source text.
			want: []string{"checkouts.show.general.seo.page_title", "checkouts.show.general.seo.title"},
		},
		{
			name: "$tc pluralization form",
			scan: `{{ $tc('home.subscriptions.count', n) }}`,
			want: []string{"home.subscriptions.count"},
		},
		{
			name: "concatenation makes the key dynamic — skipped",
			scan: `$t('includes.' + this.value)`,
			want: nil,
		},
		{
			name: "template literal — matches neither regex, skipped",
			scan: "$t(`_base.${plugin.status}`)",
			want: nil,
		},
		{
			name: "bare t(...) is out of scope, only $t/$tc are matched",
			scan: `const label = t('save')`,
			want: nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := vueTranslationKeysIn(tc.scan)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("vueTranslationKeysIn(%q) = %v, want %v", tc.scan, got, tc.want)
			}
		})
	}
}

func TestSliceJSONKey(t *testing.T) {
	src := `{
  "checkouts": {
    "show": {
      "general": {
        "seo": {
          "title": "Zoekmachineoverzicht",
          "page_title": "Paginatitel"
        }
      }
    }
  },
  "home": {
    "subscriptions": {
      "count": ["geen", "{n} abonnement", "{n} abonnementen"]
    }
  }
}`

	value, line, found := sliceJSONKey(src, []string{"checkouts", "show", "general", "seo", "title"})
	if !found {
		t.Fatal("expected key to be found")
	}
	if value != `"Zoekmachineoverzicht"` {
		t.Errorf("value = %q, want %q", value, `"Zoekmachineoverzicht"`)
	}
	wantLine := 6
	if line != wantLine {
		t.Errorf("line = %d, want %d", line, wantLine)
	}

	// An array leaf (a vue-i18n pluralization form) is returned as its raw
	// source text, same as an object leaf would be — no type restriction.
	arrValue, _, found := sliceJSONKey(src, []string{"home", "subscriptions", "count"})
	if !found {
		t.Fatal("expected array leaf to be found")
	}
	if arrValue != `["geen", "{n} abonnement", "{n} abonnementen"]` {
		t.Errorf("array value = %q", arrValue)
	}

	if _, _, found := sliceJSONKey(src, []string{"checkouts", "show", "general", "seo", "missing"}); found {
		t.Error("expected missing key to report not found")
	}
	if _, _, found := sliceJSONKey(src, []string{"checkouts", "show", "general", "seo", "title", "too_deep"}); found {
		t.Error("expected descending into a string leaf to report not found")
	}
}

// TestCandidateVueLocaleDirsNearestWinsWithFallback covers the one genuinely
// new/regression-sensitive piece of vuetranslations.go: a domain's own
// locales directory (merged into the app-wide i18n instance at runtime, see
// candidateVueLocaleDirs' own doc comment) must be tried FIRST, but a key
// missing there must still resolve against the farther, app-wide directory.
func TestCandidateVueLocaleDirsNearestWinsWithFallback(t *testing.T) {
	headDir := t.TempDir()

	mustWriteJSON := func(rel, content string) {
		full := filepath.Join(headDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// App-wide locales (resources/admin/src/locales).
	mustWriteJSON("resources/admin/src/locales/en.json", `{"_base": {"save": "Save"}}`)
	mustWriteJSON("resources/admin/src/locales/nl.json", `{"_base": {"save": "Opslaan"}}`)
	// Domain-scoped locales, nearer to the .vue file below, overriding only
	// ONE key and otherwise relying on the app-wide fallback.
	mustWriteJSON("resources/admin/src/domains/MediaLibrary/locales/en.json", `{"media": {"title": "Media library"}}`)
	mustWriteJSON("resources/admin/src/domains/MediaLibrary/locales/nl.json", `{"media": {"title": "Mediabibliotheek"}}`)

	fileDir := "resources/admin/src/domains/MediaLibrary/components"
	dirs := candidateVueLocaleDirs(headDir, fileDir)
	wantDirs := []string{
		"resources/admin/src/domains/MediaLibrary/locales",
		"resources/admin/src/locales",
	}
	if !reflect.DeepEqual(dirs, wantDirs) {
		t.Fatalf("candidateVueLocaleDirs = %v, want %v", dirs, wantDirs)
	}

	targets := vueLocaleTargets(headDir, dirs)
	targetsByLocale := map[string]vueLocaleTarget{}
	for _, tgt := range targets {
		targetsByLocale[tgt.locale] = tgt
	}
	if len(targetsByLocale) != 2 {
		t.Fatalf("expected 2 locale targets (en, nl), got %v", targets)
	}
	nl, ok := targetsByLocale["nl"]
	if !ok {
		t.Fatal("expected an nl target")
	}
	wantFiles := []string{
		"resources/admin/src/domains/MediaLibrary/locales/nl.json",
		"resources/admin/src/locales/nl.json",
	}
	if !reflect.DeepEqual(nl.files, wantFiles) {
		t.Fatalf("nl.files = %v, want %v", nl.files, wantFiles)
	}

	// A key that only exists in the domain-local file resolves there.
	for _, f := range nl.files {
		text, err := os.ReadFile(filepath.Join(headDir, f))
		if err != nil {
			t.Fatal(err)
		}
		if v, _, found := sliceJSONKey(string(text), []string{"media", "title"}); found {
			if v != `"Mediabibliotheek"` {
				t.Errorf("media.title = %q", v)
			}
			break
		}
	}

	// A key missing from the nearer (domain) file falls back to the farther
	// (app-wide) one.
	var resolved bool
	for _, f := range nl.files {
		text, err := os.ReadFile(filepath.Join(headDir, f))
		if err != nil {
			t.Fatal(err)
		}
		if v, _, found := sliceJSONKey(string(text), []string{"_base", "save"}); found {
			if v != `"Opslaan"` {
				t.Errorf("_base.save = %q", v)
			}
			resolved = true
			break
		}
	}
	if !resolved {
		t.Error("expected _base.save to fall back to the app-wide locales file")
	}
}
