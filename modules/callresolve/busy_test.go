package callresolve

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

// Dozens of resolve_call runs write to callresolve.db at once. None of those
// writes may surface SQLITE_BUSY (it would permanently fail the workflow).
func TestConcurrentWritesNeverBusy(t *testing.T) {
	m, err := Open(filepath.Join(t.TempDir(), "callresolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 1000)
	for g := 0; g < 60; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				calls := []string{"a", "b", "c", "d", "e", "f", "g", "h"}
				if err := m.SaveSearching(ctx, "o/r", 1, fmt.Sprintf("caller%d", g), calls); err != nil {
					errs <- err
				}
				if err := m.Save(ctx, Entry{Repo: "o/r", PR: 1, CallerID: fmt.Sprintf("caller%d", g), CallKey: fmt.Sprintf("k%d", i), Status: StatusFound}); err != nil {
					errs <- err
				}
				if _, err := m.List(ctx, "o/r", 1); err != nil {
					errs <- err
				}
			}
		}(g)
	}
	wg.Wait()
	close(errs)
	n := 0
	for err := range errs {
		n++
		if n < 4 {
			t.Error(err)
		}
	}
	if n > 0 {
		t.Fatalf("%d write/read errors", n)
	}
}
