package main

import (
	"strings"
	"testing"

	"slash/modules/langpref"
)

// The Dutch default must append NOTHING: every existing prompt (and every
// claude.Fake keyed on model+SystemPrompt in the other tests here) has to stay
// byte-identical for an install that never touched the setting.
func TestExplainLangTailEmptyForDutch(t *testing.T) {
	if got := explainLangTail(langpref.LangNL); got != "" {
		t.Fatalf("explainLangTail(nl) = %q, want an empty string", got)
	}
	if got := explainLangTail(""); got != "" {
		t.Fatalf("explainLangTail(unset) = %q, want an empty string", got)
	}
}

func TestExplainLangTailOverridesToEnglish(t *testing.T) {
	got := explainLangTail(langpref.LangEN)
	if got == "" {
		t.Fatal("explainLangTail(en) is empty — English output would never be requested")
	}
	if !strings.Contains(got, "ENGLISH") {
		t.Fatalf("explainLangTail(en) does not name English:\n%s", got)
	}
	// It must be an override, since every prompt file it is appended to asks
	// for Dutch in its own body.
	if !strings.Contains(strings.ToLower(got), "dutch") {
		t.Fatalf("explainLangTail(en) does not override the Dutch instruction above it:\n%s", got)
	}
}

// A chat ANSWER always follows the reviewer's own language (no preference), and
// only the drafted comment reply follows the "reply" setting — so this tail is
// appended in both languages and must name the reply language explicitly.
func TestChatLangTailNamesReplyLanguage(t *testing.T) {
	nl := chatLangTail(langpref.LangNL)
	en := chatLangTail(langpref.LangEN)
	if !strings.Contains(nl, "Nederlands") || !strings.Contains(en, "Engels") {
		t.Fatalf("chatLangTail does not name the reply language:\nnl=%s\nen=%s", nl, en)
	}
	for _, tail := range []string{nl, en} {
		if !strings.Contains(tail, "dezelfde taal als het bericht van de reviewer") {
			t.Fatalf("chatLangTail drops the answer-mirrors-the-reviewer rule:\n%s", tail)
		}
		if !strings.Contains(tail, "comment_action") {
			t.Fatalf("chatLangTail does not scope the exception to a comment_action body:\n%s", tail)
		}
	}
}

// langFor tolerates a nil TaskManager (several run* helpers take one a test may
// leave nil) and a manager without a store, both as Dutch.
func TestLangForFallsBackToDutch(t *testing.T) {
	if got := langFor(t.Context(), nil, langpref.KindExplain); got != langpref.LangNL {
		t.Fatalf("langFor(nil manager) = %q, want %q", got, langpref.LangNL)
	}
	var m *TaskManager
	if got := m.LangFor(t.Context(), langpref.KindReply); got != langpref.LangNL {
		t.Fatalf("(*TaskManager)(nil).LangFor = %q, want %q", got, langpref.LangNL)
	}
}
