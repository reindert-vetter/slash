package tembed

import (
	"fmt"
	"sync"
	"time"
)

// Run status values.
const (
	StatusRunning   = "running"   // actively advancing
	StatusWaiting   = "waiting"   // blocked on a signal or timer
	StatusCompleted = "completed" // finished successfully
	StatusFailed    = "failed"    // finished with an error
)

// RunRecord is the metadata of one workflow run (its history lives separately
// as a sequence of Events).
type RunRecord struct {
	ID        string    `json:"id"`
	Workflow  string    `json:"workflow"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Store is the durable backend for runs and their event histories. tembed
// ships three implementations — an in-memory store (tests), a JSONL store
// (one file per run, human-readable), and a SQLite store — plus MultiStore to
// combine them (e.g. SQLite for queries + JSONL for an audit trail).
//
// A Store must be safe for concurrent use; the engine already serialises
// writes per run, but ListRuns/LoadRun may be called from other goroutines.
type Store interface {
	// CreateRun persists a new run's metadata.
	CreateRun(r RunRecord) error
	// SetStatus updates a run's status and UpdatedAt.
	SetStatus(runID, status string, at time.Time) error
	// AppendEvent appends one event to a run's history.
	AppendEvent(runID string, e Event) error
	// LoadRun returns a run's metadata and full, ordered history.
	LoadRun(runID string) (RunRecord, []Event, error)
	// ListRuns returns every run's metadata (for crash recovery).
	ListRuns() ([]RunRecord, error)
	// Close releases any resources (files, DB handles).
	Close() error
}

// MemoryStore is a non-durable Store for tests and ephemeral runs.
type MemoryStore struct {
	mu     sync.Mutex
	runs   map[string]RunRecord
	events map[string][]Event
	order  []string
}

// NewMemoryStore returns an empty in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{runs: map[string]RunRecord{}, events: map[string][]Event{}}
}

func (m *MemoryStore) CreateRun(r RunRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.runs[r.ID]; !ok {
		m.order = append(m.order, r.ID)
	}
	m.runs[r.ID] = r
	return nil
}

func (m *MemoryStore) SetStatus(runID, status string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.runs[runID]
	if !ok {
		return fmt.Errorf("tembed: run %s not found", runID)
	}
	r.Status = status
	r.UpdatedAt = at
	m.runs[runID] = r
	return nil
}

func (m *MemoryStore) AppendEvent(runID string, e Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events[runID] = append(m.events[runID], e)
	return nil
}

func (m *MemoryStore) LoadRun(runID string) (RunRecord, []Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.runs[runID]
	if !ok {
		return RunRecord{}, nil, fmt.Errorf("tembed: run %s not found", runID)
	}
	evs := make([]Event, len(m.events[runID]))
	copy(evs, m.events[runID])
	return r, evs, nil
}

func (m *MemoryStore) ListRuns() ([]RunRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]RunRecord, 0, len(m.order))
	for _, id := range m.order {
		out = append(out, m.runs[id])
	}
	return out, nil
}

func (m *MemoryStore) Close() error { return nil }

// MultiStore fans writes out to every wrapped Store and reads from the first
// (the primary). Use it to keep, say, a SQLite store for querying alongside a
// JSONL store as a plain-text audit log — "de combinatie daarvan".
type MultiStore struct{ stores []Store }

// NewMultiStore returns a Store that writes to all of stores and reads from
// stores[0]. It panics if no store is given.
func NewMultiStore(stores ...Store) *MultiStore {
	if len(stores) == 0 {
		panic("tembed: NewMultiStore needs at least one store")
	}
	return &MultiStore{stores: stores}
}

func (s *MultiStore) CreateRun(r RunRecord) error {
	for _, st := range s.stores {
		if err := st.CreateRun(r); err != nil {
			return err
		}
	}
	return nil
}

func (s *MultiStore) SetStatus(runID, status string, at time.Time) error {
	for _, st := range s.stores {
		if err := st.SetStatus(runID, status, at); err != nil {
			return err
		}
	}
	return nil
}

func (s *MultiStore) AppendEvent(runID string, e Event) error {
	for _, st := range s.stores {
		if err := st.AppendEvent(runID, e); err != nil {
			return err
		}
	}
	return nil
}

func (s *MultiStore) LoadRun(runID string) (RunRecord, []Event, error) {
	return s.stores[0].LoadRun(runID)
}

func (s *MultiStore) ListRuns() ([]RunRecord, error) { return s.stores[0].ListRuns() }

func (s *MultiStore) Close() error {
	var firstErr error
	for _, st := range s.stores {
		if err := st.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
