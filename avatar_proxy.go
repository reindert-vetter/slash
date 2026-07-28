package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

var errAvatarFetchFailed = errors.New("avatar fetch: upstream did not return 200")

// avatarAllowedHost is the only host this codebase ever stores as an
// avatarUrl (GitHub's user.avatar_url — see src/avatar.mjs's own comment).
// The proxy below refuses anything else, so it can never become an open
// proxy/SSRF vector for an arbitrary URL.
const avatarAllowedHost = "avatars.githubusercontent.com"

// avatarCacheMaxEntries caps the in-memory avatar cache. Avatars are small and
// few per PR, so this is generous headroom, not a tight budget — once hit we
// simply drop the whole cache and start over rather than building an LRU for
// what is, in practice, a handful of profile pictures.
const avatarCacheMaxEntries = 500

// avatarMaxBodyBytes caps how much of an upstream response we read/cache, so a
// misbehaving/huge response can't grow the in-memory cache unbounded.
const avatarMaxBodyBytes = 2 << 20 // 2 MiB

// cachedAvatar is one fetched-and-decoded avatar image.
type cachedAvatar struct {
	body        []byte
	contentType string
}

// avatarCache is a purely in-memory cache of fetched avatar images, keyed by
// their original (GitHub) URL. It never touches disk/DB/the workflow history —
// lost on restart is fine, a lookup simply re-fetches — so it falls outside
// the workflows-write-boundary rule, the same carve-out already used for
// ingestProgressByPR/the heartbeat map (see
// .claude/rules/workflows-write-boundary.md and ingest_progress.go).
type avatarCache struct {
	mu      sync.Mutex
	entries map[string]cachedAvatar
}

func newAvatarCache() *avatarCache {
	return &avatarCache{entries: map[string]cachedAvatar{}}
}

// Get returns the cached avatar for rawURL, fetching it via client on a cache
// miss. Avatars never change in practice (the whole point of this cache), so
// a hit is served forever until the process restarts.
func (c *avatarCache) Get(ctx context.Context, client *http.Client, rawURL string) (cachedAvatar, error) {
	c.mu.Lock()
	if cached, ok := c.entries[rawURL]; ok {
		c.mu.Unlock()
		return cached, nil
	}
	c.mu.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return cachedAvatar{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return cachedAvatar{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return cachedAvatar{}, errAvatarFetchFailed
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, avatarMaxBodyBytes))
	if err != nil {
		return cachedAvatar{}, err
	}
	cached := cachedAvatar{body: body, contentType: resp.Header.Get("Content-Type")}

	c.mu.Lock()
	if len(c.entries) >= avatarCacheMaxEntries {
		c.entries = map[string]cachedAvatar{}
	}
	c.entries[rawURL] = cached
	c.mu.Unlock()

	return cached, nil
}

// handleAvatar serves GET /api/avatar?url=<original avatarUrl> — a small
// caching proxy so a browser reload/re-mount never has to hit GitHub's CDN
// again for an avatar it already fetched once, and so the browser itself gets
// a long-lived Cache-Control from a host we control. Read-only: the only
// "write" is the in-memory avatarCache above, not durable state.
func (s *server) handleAvatar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if raw == "" || err != nil || u.Scheme != "https" || u.Host != avatarAllowedHost {
		http.Error(w, "invalid avatar url", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	cached, err := s.avatarCache().Get(ctx, s.avatarClient(), raw)
	if err != nil {
		http.Error(w, "avatar fetch failed", http.StatusBadGateway)
		return
	}

	if cached.contentType != "" {
		w.Header().Set("Content-Type", cached.contentType)
	}
	w.Header().Set("Cache-Control", "public, max-age=86400, immutable")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(cached.body)
}

// avatarClient returns the http.Client used to fetch avatars, defaulting to a
// plain client with no extra transport config (a test injects its own via
// server.avatarHTTPClient).
func (s *server) avatarClient() *http.Client {
	if s.avatarHTTPClient != nil {
		return s.avatarHTTPClient
	}
	return http.DefaultClient
}

// avatarCache lazily initializes s.avatars — defensive fallback for a server
// value constructed without it (main.go sets it explicitly, so this only
// matters for e.g. a future test/tool that builds a bare server{}).
func (s *server) avatarCache() *avatarCache {
	if s.avatars == nil {
		s.avatars = newAvatarCache()
	}
	return s.avatars
}
