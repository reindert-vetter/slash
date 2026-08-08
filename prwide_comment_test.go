package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestHandleTaskCodeCommentFileRequirement pins the validation boundary that
// made PR-wide ("algemene") comments impossible to place at all: the handler
// used to reject EVERY comment without a file, but a PR-wide comment has no
// file:line by definition (an imported general PR comment carries File "" too,
// see mapGeneralComment). A block-scoped comment must still name one.
func TestHandleTaskCodeCommentFileRequirement(t *testing.T) {
	for _, tc := range []struct {
		name     string
		body     string
		wantCode int
	}{
		{
			name:     "pr-wide without a file is accepted",
			body:     `{"pr":42,"file":"","body":"Algemene opmerking over deze PR","kind":"issue"}`,
			wantCode: http.StatusOK,
		},
		{
			name:     "block-scoped without a file is still rejected",
			body:     `{"pr":42,"file":"","body":"Deze regel klopt niet"}`,
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "an empty body is rejected for a pr-wide comment too",
			body:     `{"pr":42,"file":"","body":"","kind":"issue"}`,
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "a traversing file is still rejected",
			body:     `{"pr":42,"file":"../etc/passwd","body":"nope"}`,
			wantCode: http.StatusBadRequest,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, _, cs := newTestManager(t)
			s := &server{tasks: &tasks{manager: m, engine: m.engine}}

			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodPost, "/api/workflows/task_code_comment", strings.NewReader(tc.body))
			s.handleTaskCodeComment(rec, req)

			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.wantCode, rec.Body.String())
			}
			if tc.wantCode != http.StatusOK {
				return
			}
			// The accepted PR-wide comment really landed in the read-model as a
			// PR-wide one — that Kind is exactly what turns it into a navigable
			// "PR-comments" index row instead of an invisible line comment.
			var out map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			list, err := cs.List(context.Background(), 42)
			if err != nil {
				t.Fatal(err)
			}
			if len(list) != 1 || list[0].ID != out["runId"] || list[0].Kind != "issue" || list[0].File != "" {
				t.Fatalf("comments = %+v, want one Kind:issue comment with no file", list)
			}
		})
	}
}
