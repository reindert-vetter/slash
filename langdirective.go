package main

import (
	"context"

	"slash/modules/langpref"
)

// langdirective.go turns the reviewer's per-type language preference
// (modules/langpref, set on the settings page) into the small instruction tail
// that is APPENDED to a Claude call's system prompt — the one place that
// decides in which language Claude writes.
//
// Why a tail instead of translated prompt files: every prompt in
// modules/claude/prompts/ is a Dutch instruction block, and duplicating each
// one per language would double the surface that has to stay in sync. A short,
// explicit override at the END of the system prompt is the cheapest thing that
// works, and it keeps the "nl" case byte-identical to what it has always been:
//
//	explainLangTail(LangNL) == ""
//
// so an install that never touched the setting sends exactly the same prompts
// as before this feature existed (which is also why claude.Fake's
// model+SystemPrompt keying in the existing tests still matches).
//
// Three deliberate boundaries:
//   - A chat ANSWER never follows a preference at all: it mirrors the language
//     the reviewer typed in (an explicit reviewer decision), which is why
//     chatLangTail only names the language of a drafted comment reply.
//   - An internal, machine-read answer (resolve_call, comment_removal,
//     chat_conflict) gets no tail: nobody reads that prose, and its JSON
//     contract must not wobble.
//   - Code, identifiers, code comments and commit messages are ALWAYS
//     English, whatever the settings say — see commitLanguageRule and the
//     "Taal" section of prompts/chat_shell.md.

// langLabelNL maps a language code to its Dutch name, for a tail written in
// Dutch (the prompt files' own language).
func langLabelNL(lang string) string {
	if lang == langpref.LangEN {
		return "Engels"
	}
	return "Nederlands"
}

// explainLangTail is the tail for every AI action that writes prose ABOUT the
// code for the reviewer to read: explain_code, code_warning, pr_summary,
// since_review, chat_summary, comment_titles, test_run, comment_batch. Empty
// for the default (Dutch), so nothing changes unless the reviewer really
// picked English.
func explainLangTail(lang string) string {
	if lang != langpref.LangEN {
		return ""
	}
	return "\n\nLANGUAGE OVERRIDE: write every sentence the reviewer reads in " +
		"ENGLISH, ignoring any instruction above that asks for Dutch. This " +
		"applies to the prose only: JSON keys, field names, marker lines and " +
		"code stay exactly as specified above."
}

// chatLangTail is the tail for the reviewer-facing conversation
// (claude_chat's three system prompts). Always appended, in both languages,
// because it says two different things: the ANSWER follows the reviewer's own
// language (no preference involved), while the body of a drafted comment
// reply follows the "reply" preference — that text ends up on GitHub under
// the reviewer's own name, so its audience is the PR's other readers.
func chatLangTail(replyLang string) string {
	return "\n\nTAAL: schrijf je antwoord in dezelfde taal als het bericht van de " +
		"reviewer; wisselt de reviewer van taal, dan wissel je mee. De `body` van " +
		"een comment_action-reactie is de enige uitzondering: die schrijf je altijd " +
		"in het " + langLabelNL(replyLang) + ", ongeacht de taal van het gesprek, " +
		"want die tekst komt op GitHub te staan onder de naam van de reviewer."
}

// langFor reads one output type's language for the current repo, tolerating a
// nil TaskManager (several run* helpers take one that a test may leave nil)
// and falling back to Dutch — the same default modules/langpref itself uses.
func langFor(ctx context.Context, tm *TaskManager, kind string) string {
	if tm == nil {
		return langpref.LangNL
	}
	return tm.LangFor(ctx, kind)
}
