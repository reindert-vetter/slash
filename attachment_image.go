package main

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// attachment_image.go — GET /api/attachment?url=<github attachment url>.
//
// A screenshot pasted into a PR body/comment on GitHub becomes a URL like
// https://github.com/user-attachments/assets/<uuid> (or the older
// https://github.com/<owner>/<repo>/assets/<n>/<uuid>). For a PRIVATE repo
// that URL answers 404 without a GitHub login; with one it 302s to a signed,
// 5-minute S3 URL. The browser on 127.0.0.1 never sends github.com's
// (SameSite) session cookies along with a cross-site <img>, so every such
// image rendered as a broken-image icon. This handler fetches it server-side
// with the local `gh` token instead; markdown.mjs (proxyGithubAttachments)
// rewrites those srcs to point here.
//
// Read-only: no module, no read-model, no workflow history — only an
// in-memory token cache. See .claude/docs/diff-render.md.

// attachmentURLRE is the strict allowlist: only the two GitHub attachment
// URL shapes, nothing else on github.com (so this can never be used to fetch
// arbitrary authenticated GitHub pages, and no other host at all — not an
// open proxy). No query string or fragment is allowed either.
var attachmentURLRE = regexp.MustCompile(
	`^https://github\.com/(?:user-attachments/assets/[0-9a-fA-F-]{36}|[A-Za-z0-9-]+/[A-Za-z0-9._-]+/assets/[0-9]+/[0-9a-fA-F-]{36})$`)

// isAllowedAttachmentURL reports whether raw is one of the two GitHub
// attachment URL shapes above, and parses as exactly that (no userinfo,
// query, fragment or path tricks).
func isAllowedAttachmentURL(raw string) bool {
	if !attachmentURLRE.MatchString(raw) {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil ||
		u.RawQuery != "" || u.Fragment != "" || strings.Contains(u.Path, "..") {
		return false
	}
	return true
}

// attachmentHTTPClient fetches the image. Go's client drops the
// Authorization header itself on the cross-host redirect to S3 (which would
// otherwise reject the request).
var attachmentHTTPClient = &http.Client{Timeout: 20 * time.Second}

var (
	ghTokenMu  sync.Mutex
	ghTokenVal string
)

// ghToken returns the local `gh auth token`, cached in memory for the process
// lifetime once it succeeds (a failure is retried on the next request).
func ghToken(ctx context.Context) string {
	ghTokenMu.Lock()
	defer ghTokenMu.Unlock()
	if ghTokenVal != "" {
		return ghTokenVal
	}
	out, err := exec.CommandContext(ctx, "gh", "auth", "token").Output()
	if err != nil {
		return ""
	}
	ghTokenVal = strings.TrimSpace(string(out))
	return ghTokenVal
}

func (s *server) handleAttachment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	raw := r.URL.Query().Get("url")
	if !isAllowedAttachmentURL(raw) {
		http.Error(w, "invalid attachment url", http.StatusBadRequest)
		return
	}
	if ghDisabled() {
		http.Error(w, "github disabled", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	token := ghToken(ctx)
	if token == "" {
		http.Error(w, "no gh token", http.StatusNotFound)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		http.Error(w, "invalid attachment url", http.StatusBadRequest)
		return
	}
	req.Header.Set("Authorization", "token "+token)
	resp, err := attachmentHTTPClient.Do(req)
	if err != nil {
		http.Error(w, "attachment fetch failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(ct, "image/") {
		http.Error(w, "attachment not available", http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, imageMaxBytes+1))
	if err != nil {
		http.Error(w, "attachment fetch failed", http.StatusBadGateway)
		return
	}
	if len(body) > imageMaxBytes {
		http.Error(w, "image too large", http.StatusRequestEntityTooLarge)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// The asset behind a given URL never changes; private, since it came
	// through the reviewer's own credentials.
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
