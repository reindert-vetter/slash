package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestIsAllowedAttachmentURL(t *testing.T) {
	ok := []string{
		"https://github.com/user-attachments/assets/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf",
		"https://github.com/plug-and-pay/plug-and-pay/assets/54842665/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf",
	}
	bad := []string{
		"",
		"http://github.com/user-attachments/assets/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf",
		"https://evil.com/user-attachments/assets/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf",
		"https://github.com.evil.com/user-attachments/assets/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf",
		"https://user@github.com/user-attachments/assets/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf",
		"https://github.com/user-attachments/assets/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf?x=1",
		"https://github.com/user-attachments/assets/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf#f",
		"https://github.com/user-attachments/assets/../../settings/tokens",
		"https://github.com/plug-and-pay/plug-and-pay/pull/13936",
		"https://github.com/plug-and-pay/plug-and-pay/assets/x/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf",
		"https://github.com/a/b/c/assets/1/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf",
	}
	for _, u := range ok {
		if !isAllowedAttachmentURL(u) {
			t.Errorf("expected allowed: %q", u)
		}
	}
	for _, u := range bad {
		if isAllowedAttachmentURL(u) {
			t.Errorf("expected refused: %q", u)
		}
	}
}

func TestHandleAttachmentRefusesAndStaysOffline(t *testing.T) {
	t.Setenv("SLASH_GITHUB", "off")
	s := &server{}
	get := func(raw string) int {
		rec := httptest.NewRecorder()
		s.handleAttachment(rec, httptest.NewRequest(http.MethodGet, "/api/attachment?url="+url.QueryEscape(raw), nil))
		return rec.Code
	}
	if c := get("https://example.com/x.png"); c != http.StatusBadRequest {
		t.Errorf("foreign url: got %d, want 400", c)
	}
	if c := get("https://github.com/user-attachments/assets/cc9bcda0-5e48-451d-8a2a-0fe212c54cbf"); c != http.StatusNotFound {
		t.Errorf("offline: got %d, want 404", c)
	}
}
