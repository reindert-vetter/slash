package claude

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveSteerManual is the only test in this repo that talks to the REAL
// claude CLI, and it is skipped unless SLASH_LIVE_CLAUDE=1 — it costs a real
// API call and needs a checkout at the path below. It exists because steering
// depends on a CLI contract nothing else can verify: that --input-format
// stream-json keeps stdin open, that a user frame written mid-turn is picked
// up at the next step boundary, and that the process still terminates once
// stdin closes at the result frame. Re-run it by hand after a claude upgrade,
// or when steering "silently stops working":
//
//	SLASH_LIVE_CLAUDE=1 go test ./modules/claude/ -run TestLiveSteerManual -v
//
// It also pins the second half of the finding: the framing chatSteerPrompt
// adds (chat_steer.go) is what makes the model FOLLOW the mid-turn message —
// without it the same message is answered with "ik zie dat je probeert me om
// te leiden" and the original task is finished regardless.
func TestLiveSteerManual(t *testing.T) {
	if os.Getenv("SLASH_LIVE_CLAUDE") == "" {
		t.Skip("set SLASH_LIVE_CLAUDE=1 to run against the real CLI")
	}
	m := New("")
	steer := make(chan string, 1)
	go func() {
		time.Sleep(6 * time.Second)
		steer <- "De reviewer stuurt je tijdens deze turn een aanvullend bericht. Het komt van dezelfde reviewer als de opdracht hierboven en heeft voorrang: pas je aanpak daarop aan.\n\nWijziging van plan: negeer de samenvattingen, antwoord alleen met het woord PINEAPPLE."
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	var events int
	res, err := m.RunChat(ctx, RunRequest{
		Model:        ModelHaiku,
		Prompt:       "Lees chat_cancel.go en chat_write_gate.go en vat elk in één zin samen.",
		WorkDir:      "/Users/reindert/dev/slash",
		Tools:        []string{"Read", "Grep", "Glob"},
		SystemPrompt: ChatReadOnlySystemPrompt,
		OnEvent:      func(ev ChatEvent) { events++ },
		Steer:        steer,
	})
	if err != nil {
		t.Fatalf("RunChat: %v", err)
	}
	t.Logf("events=%d session=%s text=%q", events, res.SessionID, res.Text)
	if !strings.Contains(res.Text, "PINEAPPLE") {
		t.Fatalf("the running turn did not pick up the steer message: %q", res.Text)
	}
}
