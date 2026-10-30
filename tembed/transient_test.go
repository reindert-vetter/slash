package tembed

import (
	"context"
	"errors"
	"testing"
)

// An Activity failing with SQLITE_BUSY is retried below the history: the run
// completes and only the final outcome is recorded.
func TestActivityRetriesTransientDBLock(t *testing.T) {
	calls := 0
	fn := func(ctx context.Context, in []byte) ([]byte, error) {
		calls++
		if calls < 3 {
			return nil, errors.New("mark searching: database is locked (5) (SQLITE_BUSY)")
		}
		return []byte(`"ok"`), nil
	}
	e := &Engine{activities: map[string]ActivityFunc{}}
	e.RegisterActivity("x", fn)
	out, err := e.activities["x"](context.Background(), nil)
	if err != nil || string(out) != `"ok"` || calls != 3 {
		t.Fatalf("out=%s err=%v calls=%d", out, err, calls)
	}
	calls = 0
	boom := errors.New("boom")
	e.RegisterActivity("y", func(context.Context, []byte) ([]byte, error) { calls++; return nil, boom })
	if _, err := e.activities["y"](context.Background(), nil); err != boom || calls != 1 {
		t.Fatalf("non-transient retried: %v %d", err, calls)
	}
}
