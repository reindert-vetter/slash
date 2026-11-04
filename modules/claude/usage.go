package claude

import (
	"sync"
	"time"
)

// SessionUsage is the latest 5-hour session-budget reading the claude CLI
// reported. Every `claude -p --output-format stream-json --verbose` run emits
// one `rate_limit_event` frame whose `rate_limit_info.unifiedWindows.five_hour`
// carries `utilization` (0..1, share of the 5h budget already used) and
// `resetsAt` (unix seconds). Verified against CLI 2.1.318; the frame is not
// officially documented, so a missing/renamed field is simply ignored.
//
// Purely in-memory and only as fresh as the last Claude call slash itself
// made — terminal usage outside slash only shows up on the next slash call.
type SessionUsage struct {
	Utilization float64   // 0..1, share USED
	ResetsAt    time.Time // when the 5h window resets
	SeenAt      time.Time // when this reading was taken
}

var (
	usageMu   sync.Mutex
	lastUsage *SessionUsage
)

// rateLimitInfo is the subset of a rate_limit_event frame this module reads.
type rateLimitInfo struct {
	UnifiedWindows *struct {
		FiveHour *struct {
			Utilization *float64 `json:"utilization"`
			ResetsAt    int64    `json:"resetsAt"`
		} `json:"five_hour"`
	} `json:"unifiedWindows"`
}

// recordRateLimit stores a rate_limit_event's 5h reading, if it carries one.
func recordRateLimit(info *rateLimitInfo, now time.Time) {
	if info == nil || info.UnifiedWindows == nil || info.UnifiedWindows.FiveHour == nil {
		return
	}
	fh := info.UnifiedWindows.FiveHour
	if fh.Utilization == nil || fh.ResetsAt <= 0 {
		return
	}
	u := *fh.Utilization
	if u < 0 {
		u = 0
	}
	if u > 1 {
		u = 1
	}
	usageMu.Lock()
	lastUsage = &SessionUsage{Utilization: u, ResetsAt: time.Unix(fh.ResetsAt, 0), SeenAt: now}
	usageMu.Unlock()
}

// LastSessionUsage returns the latest reading, or false when no Claude call
// has reported one since the process started.
func LastSessionUsage() (SessionUsage, bool) {
	usageMu.Lock()
	defer usageMu.Unlock()
	if lastUsage == nil {
		return SessionUsage{}, false
	}
	return *lastUsage, true
}
