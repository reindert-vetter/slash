package claude

import (
	"encoding/json"
	"testing"
	"time"
)

// TestRecordRateLimitFromStreamFrame parses a real rate_limit_event frame
// (captured from CLI 2.1.318) and checks the 5h reading lands in the snapshot.
func TestRecordRateLimitFromStreamFrame(t *testing.T) {
	usageMu.Lock()
	lastUsage = nil
	usageMu.Unlock()

	if _, ok := LastSessionUsage(); ok {
		t.Fatal("expected no reading before any frame")
	}

	// A frame without unifiedWindows (older CLI) is ignored.
	var old chatStreamLine
	if err := json.Unmarshal([]byte(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}`), &old); err != nil {
		t.Fatal(err)
	}
	recordRateLimit(old.RateLimitInfo, time.Now())
	if _, ok := LastSessionUsage(); ok {
		t.Fatal("frame without unifiedWindows must not produce a reading")
	}

	frame := `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1793814000,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.71,"resetsAt":1793814000,"status":"allowed"},"seven_day":{"utilization":0.55,"resetsAt":1794063600,"status":"allowed"}}}}`
	var l chatStreamLine
	if err := json.Unmarshal([]byte(frame), &l); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1793800000, 0)
	recordRateLimit(l.RateLimitInfo, now)

	got, ok := LastSessionUsage()
	if !ok {
		t.Fatal("expected a reading")
	}
	if got.Utilization != 0.71 || !got.ResetsAt.Equal(time.Unix(1793814000, 0)) || !got.SeenAt.Equal(now) {
		t.Fatalf("unexpected reading: %+v", got)
	}
}
