package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// TestAvatarCacheServesFromCacheOnSecondGet proves the in-memory cache: a
// second Get for the same URL never hits the (fake) upstream again.
func TestAvatarCacheServesFromCacheOnSecondGet(t *testing.T) {
	var requests int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("fake-avatar-bytes"))
	}))
	defer upstream.Close()

	cache := newAvatarCache()
	client := upstream.Client()

	first, err := cache.Get(context.Background(), client, upstream.URL+"/u/1")
	if err != nil {
		t.Fatalf("first Get: %v", err)
	}
	if string(first.body) != "fake-avatar-bytes" {
		t.Fatalf("unexpected body: %q", first.body)
	}
	if requests != 1 {
		t.Fatalf("want 1 upstream request after first Get, got %d", requests)
	}

	second, err := cache.Get(context.Background(), client, upstream.URL+"/u/1")
	if err != nil {
		t.Fatalf("second Get: %v", err)
	}
	if string(second.body) != "fake-avatar-bytes" || second.contentType != "image/png" {
		t.Fatalf("second Get returned different data: %+v", second)
	}
	if requests != 1 {
		t.Fatalf("want still 1 upstream request after cache hit, got %d", requests)
	}

	// A different URL is a genuine cache miss and does hit the upstream again.
	if _, err := cache.Get(context.Background(), client, upstream.URL+"/u/2"); err != nil {
		t.Fatalf("Get for a different URL: %v", err)
	}
	if requests != 2 {
		t.Fatalf("want 2 upstream requests after a different URL, got %d", requests)
	}
}

// TestAvatarCacheUpstreamError proves a non-200 upstream response surfaces as
// an error instead of being cached.
func TestAvatarCacheUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer upstream.Close()

	cache := newAvatarCache()
	if _, err := cache.Get(context.Background(), upstream.Client(), upstream.URL+"/missing"); err == nil {
		t.Fatal("want an error for a non-200 upstream response")
	}
}

// TestHandleAvatarRejectsDisallowedHost proves the handler never even
// attempts to fetch a URL whose host isn't avatars.githubusercontent.com —
// the SSRF/open-proxy guard — without touching any (fake) upstream.
func TestHandleAvatarRejectsDisallowedHost(t *testing.T) {
	var upstreamHit bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	s := &server{avatars: newAvatarCache(), avatarHTTPClient: upstream.Client()}

	for _, disallowed := range []string{
		upstream.URL + "/evil",                     // wrong host entirely
		"https://evil.example.com/avatar.png",      // not a github host
		"http://avatars.githubusercontent.com/u/1", // right host, wrong scheme
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/avatar?url="+url.QueryEscape(disallowed), nil)
		rr := httptest.NewRecorder()
		s.handleAvatar(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("url=%q: want 400, got %d", disallowed, rr.Code)
		}
	}
	if upstreamHit {
		t.Fatal("a disallowed host must never reach the upstream fetch")
	}
}

// TestHandleAvatarServesAndCaches proves the full handler path: a genuinely
// allowed URL (host swapped in via avatarHTTPClient against a fake upstream)
// is fetched, cached, and served with a long-lived Cache-Control.
func TestHandleAvatarServesAndCaches(t *testing.T) {
	var requests int
	// httptest.Server.Client() routes plain http:// requests to the fake
	// upstream, but our handler requires https:// + the real GitHub host —
	// so instead we point the client's Transport at the fake server directly.
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("bytes"))
	}))
	defer upstream.Close()

	client := upstream.Client()
	client.Transport = rewriteHostTransport{upstream: upstream.URL, inner: client.Transport}

	s := &server{avatars: newAvatarCache(), avatarHTTPClient: client}
	target := "https://avatars.githubusercontent.com/u/42"

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/avatar?url="+url.QueryEscape(target), nil)
		rr := httptest.NewRecorder()
		s.handleAvatar(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("attempt %d: want 200, got %d (%s)", i, rr.Code, rr.Body.String())
		}
		if rr.Body.String() != "bytes" {
			t.Fatalf("attempt %d: unexpected body %q", i, rr.Body.String())
		}
		if got := rr.Header().Get("Cache-Control"); !strings.Contains(got, "max-age") {
			t.Fatalf("attempt %d: want a Cache-Control with max-age, got %q", i, got)
		}
	}
	if requests != 1 {
		t.Fatalf("want exactly 1 upstream request across both handler calls, got %d", requests)
	}
}

// rewriteHostTransport redirects every request to upstream regardless of the
// original host — lets a test exercise the real https://avatars.
// githubusercontent.com host-allowlist check while still hitting a local
// httptest.Server as the actual network target.
type rewriteHostTransport struct {
	upstream string
	inner    http.RoundTripper
}

func (t rewriteHostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	u, err := url.Parse(t.upstream)
	if err != nil {
		return nil, err
	}
	req = req.Clone(req.Context())
	req.URL.Scheme = u.Scheme
	req.URL.Host = u.Host
	inner := t.inner
	if inner == nil {
		inner = http.DefaultTransport
	}
	return inner.RoundTrip(req)
}
