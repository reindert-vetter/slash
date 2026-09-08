package jira

import "testing"

// TestParseSprintViewReadsTheCustomField pins the shape a real `acli jira
// workitem view --fields key,customfield_10020 --json` returns (captured live):
// the sprints come back as full objects on that one custom field, which is the
// only way to learn an issue's sprint at all — the JQL search rejects both
// `sprint` and the custom-field id. A payload without the field is not an
// error; it simply means "no sprint".
func TestParseSprintViewReadsTheCustomField(t *testing.T) {
	out := []byte(`{"key":"STAT-1124","fields":{"customfield_10020":[
		{"boardId":93,"id":8024,"name":"Team Core Sprint 69","state":"closed","startDate":"2026-08-03T10:59:35.351Z"},
		{"boardId":93,"id":8556,"name":"Team Core Sprint 71","state":"active","startDate":"2026-08-31T09:01:45.040Z"}]}}`)
	got, err := parseSprintView(out)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("sprints = %+v, want 2", got)
	}
	if got[1].Name != "Team Core Sprint 71" || got[1].State != "active" || got[1].ID != 8556 {
		t.Fatalf("second sprint = %+v", got[1])
	}

	none, err := parseSprintView([]byte(`{"key":"STAT-9","fields":{"summary":"x"}}`))
	if err != nil || len(none) != 0 {
		t.Fatalf("no sprint field: got %+v, err %v; want empty and no error", none, err)
	}
	if empty, err := parseSprintView(nil); err != nil || len(empty) != 0 {
		t.Fatalf("empty output: got %+v, err %v", empty, err)
	}
}
