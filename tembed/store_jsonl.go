package tembed

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// JSONLStore persists each run as two append-only JSONL files under a
// directory: "<id>.meta.jsonl" (run metadata, last line wins) and
// "<id>.events.jsonl" (one Event per line). Append-only means a status change
// or a new event is a single line write — no file rewrite — and the history
// stays human-readable for later inspection.
type JSONLStore struct {
	mu  sync.Mutex
	dir string
}

// NewJSONLStore creates (if needed) dir and returns a JSONL-backed store.
func NewJSONLStore(dir string) (*JSONLStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("tembed: mkdir %s: %w", dir, err)
	}
	return &JSONLStore{dir: dir}, nil
}

func (s *JSONLStore) metaPath(id string) string   { return filepath.Join(s.dir, id+".meta.jsonl") }
func (s *JSONLStore) eventsPath(id string) string { return filepath.Join(s.dir, id+".events.jsonl") }

func appendLine(path string, v any) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

func (s *JSONLStore) CreateRun(r RunRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return appendLine(s.metaPath(r.ID), r)
}

func (s *JSONLStore) SetStatus(runID, status string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, _, err := s.loadLocked(runID)
	if err != nil {
		return err
	}
	r.Status = status
	r.UpdatedAt = at
	return appendLine(s.metaPath(runID), r)
}

func (s *JSONLStore) AppendEvent(runID string, e Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return appendLine(s.eventsPath(runID), e)
}

func (s *JSONLStore) LoadRun(runID string) (RunRecord, []Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked(runID)
}

// loadLocked folds the meta file to its last line and reads all events.
func (s *JSONLStore) loadLocked(runID string) (RunRecord, []Event, error) {
	metaLines, err := readLines(s.metaPath(runID))
	if err != nil {
		return RunRecord{}, nil, err
	}
	if len(metaLines) == 0 {
		return RunRecord{}, nil, fmt.Errorf("tembed: run %s not found", runID)
	}
	var r RunRecord
	if err := json.Unmarshal(metaLines[len(metaLines)-1], &r); err != nil {
		return RunRecord{}, nil, err
	}
	evLines, err := readLines(s.eventsPath(runID))
	if err != nil {
		return RunRecord{}, nil, err
	}
	evs := make([]Event, 0, len(evLines))
	for _, l := range evLines {
		var e Event
		if err := json.Unmarshal(l, &e); err != nil {
			return RunRecord{}, nil, err
		}
		evs = append(evs, e)
	}
	return r, evs, nil
}

func (s *JSONLStore) ListRuns() ([]RunRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	matches, err := filepath.Glob(filepath.Join(s.dir, "*.meta.jsonl"))
	if err != nil {
		return nil, err
	}
	sort.Strings(matches)
	var out []RunRecord
	for _, p := range matches {
		id := filepath.Base(p)
		id = id[:len(id)-len(".meta.jsonl")]
		r, _, err := s.loadLocked(id)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, nil
}

func (s *JSONLStore) Close() error { return nil }

// readLines returns the non-empty lines of a file, or nil if it does not exist.
func readLines(path string) ([][]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	var out [][]byte
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		cp := make([]byte, len(line))
		copy(cp, line)
		out = append(out, cp)
	}
	return out, sc.Err()
}
