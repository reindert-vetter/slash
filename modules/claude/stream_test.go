package claude

import (
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
	res, err := readChatStream(strings.NewReader(sampleStream), func(ev ChatEvent) { got = append(got, ev) })
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
	res, err := readChatStream(strings.NewReader(sampleStream), nil)
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
	if _, err := readChatStream(strings.NewReader(partial), nil); err == nil {
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
	res, err := readChatStream(strings.NewReader(stream), func(ev ChatEvent) { got = append(got, ev) })
	if err != nil {
		t.Fatalf("readChatStream: %v", err)
	}
	if res.Text != "ok" {
		t.Fatalf("result text = %q", res.Text)
	}
	if len(got) != 1 || got[0].Tool != "Bash" {
		t.Fatalf("events = %+v", got)
	}
	// The hint is truncated before it ever reaches a status label.
	if len(got[0].Detail) > maxEventDetail+len("…") {
		t.Fatalf("detail not truncated: %d chars", len(got[0].Detail))
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
