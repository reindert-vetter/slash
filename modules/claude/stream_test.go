package claude

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A realistic (abridged) capture of `claude -p --output-format stream-json
// --verbose --include-partial-messages`, trimmed to the frame types this
// module reacts to plus a few it must ignore. Kept verbatim in shape — the
// point of this test is that a change to readChatStream stays true to what the
// real CLI emits.
const sampleStream = `{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup","session_id":"s-1"}
{"type":"system","subtype":"init","cwd":"/tmp","session_id":"s-1","tools":["Read","Grep"]}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}},"session_id":"s-1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"even nadenken"}},"session_id":"s-1"}
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}},"session_id":"s-1"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/Foo.php"}}]},"session_id":"s-1"}
not json at all
{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Hal"}},"session_id":"s-1"}
{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"lo"}},"session_id":"s-1"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}
{"type":"result","subtype":"success","is_error":false,"result":"Hallo\n","session_id":"s-1"}
`

func TestReadChatStreamParsesResultAndEvents(t *testing.T) {
	var got []ChatEvent
	res, err := readChatStream(strings.NewReader(sampleStream), func(ev ChatEvent) { got = append(got, ev) }, nil, nil)
	if err != nil {
		t.Fatalf("readChatStream: %v", err)
	}
	// The result frame carries exactly what the old non-streaming json format
	// returned, so a caller's behaviour is unchanged by streaming.
	if res.Text != "Hallo\n" || res.SessionID != "s-1" {
		t.Fatalf("result = %+v", res)
	}

	want := []ChatEvent{
		{Kind: ChatEventStatus},
		{Kind: ChatEventThinking},
		{Kind: ChatEventTool, Tool: "Read"},
		// The "assistant" frame fires ChatEventTurn once (one agentic step),
		// alongside its ordinary ChatEventTool for the same tool_use block.
		{Kind: ChatEventTurn},
		{Kind: ChatEventTool, Tool: "Read", Detail: "src/Foo.php"},
		{Kind: ChatEventText, TextDelta: "Hal"},
		{Kind: ChatEventText, TextDelta: "lo"},
	}
	if len(got) != len(want) {
		t.Fatalf("events = %+v, want %d of them", got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("event %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// Nothing listening must still work (and must not need the partial frames at
// all) — that is the path every non-chat caller takes.
func TestReadChatStreamWithoutListener(t *testing.T) {
	res, err := readChatStream(strings.NewReader(sampleStream), nil, nil, nil)
	if err != nil {
		t.Fatalf("readChatStream: %v", err)
	}
	if res.Text != "Hallo\n" {
		t.Fatalf("result text = %q", res.Text)
	}
}

// A stream that ends without a result frame (a killed CLI) is a real error —
// it must never look like an empty but successful turn, which the workflow
// would happily persist as an empty assistant message.
func TestReadChatStreamWithoutResultIsAnError(t *testing.T) {
	partial := `{"type":"system","subtype":"init","session_id":"s-2"}` + "\n"
	if _, err := readChatStream(strings.NewReader(partial), nil, nil, nil); err == nil {
		t.Fatal("expected an error when the stream carries no result frame")
	}
}

// A line far larger than any scanner token limit must still parse — the init
// frame and tool results legitimately get big.
func TestReadChatStreamHandlesVeryLongLines(t *testing.T) {
	huge := strings.Repeat("x", 200000)
	stream := `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"` + huge + `"}}]}}` + "\n" +
		`{"type":"result","result":"ok","session_id":"s-3"}` + "\n"
	var got []ChatEvent
	res, err := readChatStream(strings.NewReader(stream), func(ev ChatEvent) { got = append(got, ev) }, nil, nil)
	if err != nil {
		t.Fatalf("readChatStream: %v", err)
	}
	if res.Text != "ok" {
		t.Fatalf("result text = %q", res.Text)
	}
	// The "assistant" frame fires ChatEventTurn once, then ChatEventTool for
	// its one tool_use block.
	if len(got) != 2 || got[0].Kind != ChatEventTurn || got[1].Tool != "Bash" {
		t.Fatalf("events = %+v", got)
	}
	// The hint is truncated before it ever reaches a status label.
	if len(got[1].Detail) > maxEventDetail+len("…") {
		t.Fatalf("detail not truncated: %d chars", len(got[1].Detail))
	}
}

// A result frame can carry is_error:true — the CLI's own verdict that the
// turn failed (an API-level error, e.g. an invalid model, a billing problem,
// or a usage limit) — with a real, human-readable explanation in Result. This
// must parse into ChatResult.IsError rather than being silently indistinguishable
// from a normal success (verified against a real `claude -p --model
// <invalid>` run — see ChatCallError's doc comment in claude.go).
func TestReadChatStreamParsesIsError(t *testing.T) {
	stream := `{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached.","session_id":"s-4"}` + "\n"
	res, err := readChatStream(strings.NewReader(stream), nil, nil, nil)
	if err != nil {
		t.Fatalf("readChatStream: %v", err)
	}
	if !res.IsError {
		t.Fatal("expected IsError to be true")
	}
	if res.Text != "Claude AI usage limit reached." {
		t.Fatalf("result text = %q", res.Text)
	}
}

// lastNonEmptyLine is used to pull one readable diagnostic line out of the
// CLI's captured stderr when the stream never produced a result frame at
// all.
func TestLastNonEmptyLine(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"\n\n", ""},
		{"single line", "single line"},
		{"first\nsecond\n", "second"},
		{"first\n\n  \nlast line  \n", "last line"},
	}
	for _, c := range cases {
		if got := lastNonEmptyLine(c.in); got != c.want {
			t.Fatalf("lastNonEmptyLine(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestRunChatSurfacesTheCLIsOwnReasonOnANonZeroExit reproduces, with a fake
// `claude` binary, the exact real-CLI behaviour observed with a genuinely
// invalid --model: the process still writes a complete, well-formed result
// frame (is_error:true, a real human-readable Result) to stdout and THEN
// exits non-zero. Before ChatCallError existed, RunChat's cmd.Wait() error
// check ran BEFORE the parsed result was ever looked at, so this real text
// was thrown away in favor of a bare "exit status 1" — this test guards that
// bug fix rather than the general case in TestReadChatStreamParsesIsError.
func TestRunChatSurfacesTheCLIsOwnReasonOnANonZeroExit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	script := "#!/bin/sh\n" +
		`echo '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached.","session_id":"s-5"}'` + "\n" +
		"exit 1\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	m := New("")
	_, err := m.RunChat(context.Background(), RunRequest{Model: ModelSonnet, Prompt: "hi"})
	if err == nil {
		t.Fatal("expected an error for is_error:true")
	}
	var cce *ChatCallError
	if !errors.As(err, &cce) {
		t.Fatalf("expected a *ChatCallError, got %T: %v", err, err)
	}
	if !cce.Definitive {
		t.Fatalf("expected Definitive (the CLI's own completed verdict), got %+v", cce)
	}
	if cce.Reason != "Claude AI usage limit reached." {
		t.Fatalf("Reason = %q, want the CLI's own result text, not a bare exit-status message", cce.Reason)
	}
}

func TestToolInputHintPrefersAStableField(t *testing.T) {
	// Several usable keys at once must always yield the same one, never map
	// iteration order (which would make the status line flicker).
	in := map[string]any{"command": "ls", "file_path": "src/Foo.php", "pattern": "handle("}
	for i := 0; i < 20; i++ {
		if got := toolInputHint(in); got != "src/Foo.php" {
			t.Fatalf("toolInputHint = %q", got)
		}
	}
	if got := toolInputHint(map[string]any{"unknown": 3}); got != "" {
		t.Fatalf("expected no hint, got %q", got)
	}
	if got := toolInputHint(map[string]any{"query": "a\nb"}); got != "a b" {
		t.Fatalf("newlines must not reach a one-line label: %q", got)
	}
}

// A steered turn can produce a SECOND result frame — a steer message the CLI
// only got to after the running turn's own answer runs as a follow-up turn.
// Both halves must survive (joined), not the last one silently winning.
func TestReadChatStreamJoinsASecondResultFrame(t *testing.T) {
	stream := `{"type":"result","result":"Eerste antwoord","session_id":"s1"}
{"type":"result","result":"PINEAPPLE","session_id":"s1"}
`
	closed := 0
	res, err := readChatStream(strings.NewReader(stream), nil, func() { closed++ }, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "Eerste antwoord\n\nPINEAPPLE" {
		t.Fatalf("expected both result frames joined, got %q", res.Text)
	}
	// Exactly once: onResult closes the CLI's stdin, which must happen at the
	// FIRST result frame (that is what lets the process exit at all).
	if closed != 1 {
		t.Fatalf("expected onResult to fire once, got %d", closed)
	}
}

// The stdin frame shape --input-format stream-json accepts. A change here
// silently breaks steering (the CLI ignores an unknown frame), so it is
// pinned.
func TestWriteUserFrame(t *testing.T) {
	var buf strings.Builder
	if err := writeUserFrame(&buf, "kan je het mocken?"); err != nil {
		t.Fatal(err)
	}
	want := `{"message":{"content":[{"text":"kan je het mocken?","type":"text"}],"role":"user"},"type":"user"}` + "\n"
	if buf.String() != want {
		t.Fatalf("unexpected stdin frame:\n got %s\nwant %s", buf.String(), want)
	}
}
