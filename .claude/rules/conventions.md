# Conventions

General conventions for this codebase: file naming, vendoring, syntax
highlighting/markdown, avatars and name resolution, theming, Go, language, and
git worktrees.

## Split out of this file

- **`.claude/rules/arrowjs-pitfalls.md`** — every arrow.js pitfall (template
  syntax, boolean attributes, `watch` deps, the single↔array and
  bare-toggling-expression slot rules, keyed-node reuse, orphan bindings) plus
  the LOCAL PATCH 1/2/2b notes for `src/vendor/arrow.js`, the `scrollIntoView`
  axis rule and the nested `@click`/`stopPropagation` rule. **Read it before
  writing any arrow.js template.**
- **`.claude/docs/testing-playwright.md`** — the Playwright harness: per-worker
  server/DB isolation, the hand-written worktree fixtures, `seededPr` and the
  reserved PR numbers, and the spec-writing rules (`evaluateSettled`,
  `leaveSearchBox`, never assert a transient state).

## File naming & modules

- Frontend modules are `.mjs`, one component per file, PascalCase for
  component files (`Block.mjs`), lowercase for page modules (`home.mjs`).
- Vendored libs (arrow.js, Prism, snarkdown) live in `src/vendor/` and are
  imported with a relative path, not via a CDN module. Tailwind is the exception
  (Play CDN). arrow.js is vendored in `src/vendor/arrow.js` — with three
  deliberate local patches, see `.claude/rules/arrowjs-pitfalls.md`.
- **Code (Go + JS) is English** — comments, log messages, and identifiers. The
  docs in `.claude/` and `CLAUDE.md` are also English.

## Snapshot a selection by stable ID, never by raw array index

Across an async gap the list can reindex itself, so a "did anything move the
selection while I was awaiting X?" guard must compare **identity**, not position
(see `loadBlocks`' `pristineSelectedId`/`curSelectedId` in `home.mjs`, and the
`?sel=`/`blockRef` mechanism in `CLAUDE.md`'s URL-state section, which exists for
the same reason). `recomputeLeftList` — and anything similarly id-preserving —
can legitimately reindex an unchanged selection out from under you (a PR-wide
comment item arriving at rank -1 shifts every block one slot), and an index-only
guard then wrongly concludes "the reviewer already moved the selection" and
silently skips whatever it was meant to gate (here:
`applyDefaultUnapprovedSelection`, which never got to consider the very comment
item it should have landed on). Symptom to watch for: a fresh-open
default/auto-selection landing on the wrong item whenever an async,
independently-loaded list can insert itself ahead of the current selection.

## Syntax highlighting (Prism)

Prism 1.29.0 is vendored as a single ES module in `src/vendor/prism.js` (core +
markup + clike + markup-templating + php, with `window.Prism={manual:true}` so
it doesn't auto-highlight the page). The code panes in `Block.mjs` highlight
with `Prism.highlight(...)` and show the result via the `.innerHTML` binding —
`highlight(code, lang = 'php')` defaults to PHP, and `Block.mjs`'s own
`langForFile(b.file)` picks `'typescript'` for a `.ts` block (see
`tsscan.go` in `.claude/docs/blocks-and-ingest.md`) so a TS diff gets real
TypeScript tokens instead of being force-fit into PHP's keyword list; `lang`
is threaded down through `codeDiff` → `codePane`/`unifiedCodeDiff` →
`paneHTML`/`unifiedHTML` → `rowCellHTML`/`highlightChanges`, and each pane's
outer `<code>` class becomes `language-<lang>` (the whole class-attribute
value is one `${...}` slot, per the arrow.js mixed-literal-and-dynamic rule
in `arrowjs-pitfalls.md`). Every OTHER Prism call site (the Underlying-code
cards + comment hint in `RelatedPanel.mjs`, the footer) stays on the plain
`highlight(code)` PHP default — untouched. Prism's own container CSS is
deliberately omitted; only the token colors live in `index.html`'s `<style>`,
**scoped via `:is(.language-php, .language-typescript)`** (three places: the
light block, the `@media` dark fallback, the `:root[data-theme='dark']`
mirror) so both grammars share one palette — so the diff panes, the
Underlying-code cards, the comment hint and the footer all get the same
colors regardless of which grammar tokenised them. (Scoping it to
`[data-testid=code-diff]` left everything outside the diff panes colorless.)

## Markdown rendering

`snarkdown` (v2.0.0, MIT, ~1kb) is vendored as an ES module in
`src/vendor/snarkdown.js` (verbatim upstream algorithm, only a vendoring header
added) and used out of the box: headings, lists, bold/italic/strike,
blockquotes, inline code, links, images, `---`. **No** GFM tables or task
checklists (`- [ ]`) — deliberately out of scope, snarkdown doesn't support them.

`src/markdown.mjs` is a thin wrapper (`renderMarkdown(text, startIndex) ->
safeHtmlString`) that adds three things:

1. Fenced code blocks are extracted **before** anything else and rendered as a
   small card: a slim header with a running **"Codeblok N"** number plus the
   announced language word (or "php", the pre-existing default for an
   unannounced fence), then the code via `highlightForLang(code, lang)`
   (`Block.mjs`) — every fence still carries the `.language-php` CSS-scope
   class regardless of which grammar actually highlighted it (see "Fenced code
   blocks get a language badge…" below) instead of snarkdown's bare
   `<pre><code>`.
2. A `` ```suggestion `` fence (GitHub's own "replace these lines" convention)
   gets a visually distinct header instead — **"Suggestie N"**, no language
   word, its own accent colour — so it stands out from an ordinary code
   sample. Per the colorblind rule the WORD carries the meaning, the colour is
   decoration.
3. An XSS layer: the **entire** raw Markdown text is fully HTML-escaped
   (`escapeHtml`, `&<>"`) before it reaches snarkdown — snarkdown does **not**
   escape loose HTML in the source text, only the attribute values it builds
   itself — and link/image URLs additionally pass through `sanitizeUrls`, which
   neutralizes `javascript:`/`vbscript:`/`data:text/html`.
4. Two pieces of emphasis snarkdown applies but GitHub/CommonMark does not.
   snarkdown treats every `_`/`__`/`*`/`**`/`~~` as a delimiter and its own
   `flush()` auto-CLOSES whatever is still open at the end of the text, which
   produced two reviewer-reported bugs on text nobody wrote as Markdown: an
   identifier `payment_external_id` rendered as payment*external*id, and one
   unpaired `__` in an AI risk-warning body (`wat via __toString een …`) turned
   the comment bold from there to its very end. `markdown.mjs` therefore swaps
   the offending delimiter CHARACTERS for a private-use placeholder before
   snarkdown sees them (`protectIntraWordUnderscores` — an underscore run with
   an alphanumeric on **both** sides; `neutralizeUnpairedEmphasis` — a
   delimiter that cannot pair under CommonMark's flanking rule: only a
   non-space after it lets it open, only a non-space before it lets it close)
   and swaps them back straight after snarkdown, before `applyPlaceholders`, so
   a fence's Prism HTML is never scanned. Deliberate boundaries: `_id`/`id_`
   (one side alphanumeric) are **left alone** and still pair normally, `*` may
   still emphasize intra-word (CommonMark allows that), an inline code span is
   skipped as one atom, and a leading `* ` bullet plus a `* * *` rule are
   skipped so a list/rule keeps working. `src/vendor/snarkdown.js` stays
   verbatim — don't "fix" this in the vendored file. Test:
   `tests/markdown.spec.mjs` ("keeps an intra-word underscore and an unpaired
   ** / __ literal, at every render point"), which asserts all three real
   call-site argument shapes; every render point shares this because
   `markdown.mjs` is the **only** importer of snarkdown.

### Fenced code blocks get a language badge, a running number, and a wider set of Prism grammars

`Block.mjs`'s `highlight(code)` (always `php`, used by the diff panes) got a
sibling, `highlightForLang(code, lang)`, which maps the free-form word after
` ``` ` onto one of the grammars vendored in `src/vendor/prism.js` — now
`markup`/`css`/`clike`/`javascript`/`php` (as before) **plus `sql`/`json`/
`bash`/`typescript`/`yaml`**, downloaded from the same cdnjs Prism 1.29.0
release (`yaml` last, on request: an OpenAPI fragment pasted under a comment
rendered colourless; its component registers the `yml` alias itself, so no
entry in the alias table below) —
via a small alias table (`js`→`javascript`, `ts`→`typescript`, `html`/`xml`/
`svg`→`markup`, `sh`/`shell`→`bash`, and **`vue`→`markup`**: Prism ships no
dedicated Vue grammar, upstream or vendored, so a `` ```vue `` fence gets the
outer `<template>`/`<script>`/`<style>` tags tagged and nothing more —
explicitly accepted, not a bug). A language that isn't vendored at all (e.g.
`toml`) falls back to escaped plain text, same as a genuinely missing
grammar — still labelled with the reviewer's own word in the badge, just
without token colours.

`markdown.mjs`'s `renderMarkdown`/`countCodeFences`/`annotateFenceNumbers`
number every fence sequentially, starting at an optional `startIndex` so a
caller can continue the count across several messages instead of resetting to
1 in every bubble — see "Codeblok numbering must match what Claude sees" in
`.claude/docs/claude-chat-panel.md` for why that continuity matters and how
`RelatedPanel.mjs` computes it. The numbering is deliberately the **entire**
feature here — there is no "accept this codeblock/suggestion" button or menu
action: the reviewer just refers to "codeblok 3" by number in the embedded
Claude chat and says in plain language what should happen with it (an
explicit product decision — see the same doc section).

**`renderMarkdown`'s third argument, `truncate` (default `false`)**, caps every
fence's INLINE rendering to at most 2 full lines plus one more that fades out
(`code-fence-fade-bottom`, `index.html`, a `mask-image` gradient — shape, not
colour, per the colourblind rule) — `data-fence-code` on the fence's own
`code-fence` wrapper still always carries the FULL raw code, since that
attribute is the code-preview card's only data source (see "The INLINE fence is
capped to ~2 lines, faded" in `.claude/docs/claude-chat-panel.md`). The wrapper
also carries `data-fence-context` — a short snippet of the chat text that sat
directly above the fence, omitted when empty — which the same code-preview
card shows as its own "over: …" line (see "Default-collapsed cards, a richer
title, and per-class labels" in `.claude/docs/claude-chat-panel.md`). Only
`commentBody` (`RelatedPanel.mjs`) and `ClaudeChat.mjs`'s bubble renderers pass
`true` — the two places a fence's full code is already duplicated in a
full-size preview card stacked below; `prInfoCard`'s PR summary/description
keeps the default, untruncated rendering.

**A long code line wraps instead of being silently clipped.** Both this
inline fence's `<pre>` (`extractCodeFences` above) and the full-size
code-preview card's own `<pre>` (`CodePreview.mjs`'s `highlightedPre`) carry
`whitespace-pre-wrap break-words` — without it a line wider than the bubble
(`max-w-[92%]`) just ran off the right edge with no scrollbar and no visual
cue: hidden by the fence wrapper's own `overflow-hidden` inline, or scrollable
but invisibly so (`no-scrollbar`) in the preview card. Reviewer report was
specifically about a TS block, but the clip itself isn't language-specific —
any grammar's long-enough line (a type annotation, JSDoc, a long import path)
hits it, TS/JS just gets there sooner than the historically shorter PHP
snippets this was first built around. Same fix `Footer.mjs`'s `WIDE_AT`
already applies to its own long diff lines, but unconditional here rather
than past a length threshold — this pane is already narrow and deliberately
just a few-line "taste" (see `truncate` above), so a line that already fits
never wraps and nothing changes for the common case.

It also exports **`hardBreaks(text)`** — single newlines → Markdown hard breaks
(`  \n`), fenced blocks untouched — which a caller applies **before**
`renderMarkdown` when the text is a *typed message* rather than authored
Markdown. Only the reviewer's own Claude-chat bubbles use it (see
`.claude/docs/claude-chat-panel.md`); everything else keeps Markdown's ordinary
"a lone newline is a space".

Used in `prInfoCard` (`home.mjs`) for the PR summary/description (the Jira
description box that used to render there is currently switched off, see the
comment above `prInfoCard`; the fetch of `jiraTitle`/`jiraDesc` itself is
unaffected), and in `ClaudeChat.mjs` for every chat bubble
(`claudeMessageBody`, plus the provisional streaming bubble), all via the
`.innerHTML` binding; the hand-written `.markdown-body`
typography block in `index.html` is the styling layer (Tailwind Play CDN has no
typography plugin without a build step).

**Comment bodies also render as Markdown** (`RelatedPanel.mjs`): `commentBody(c,
startIndex)` (`() => renderMarkdown(c.body, startIndex)`, `.innerHTML` binding,
`startIndex` defaulting to 0 — see "Fenced code blocks get a language badge…"
above) is the **only** place a comment body renders — reused by `commentRow`,
`reactionBubble` (every thread
bubble, block-scoped and PR-wide `prWideItem`) and therefore any future fourth
render point. The composer input is a bare text field with no restriction, so
markdown *input* was already free; only the display lacked `renderMarkdown`.
**Deliberately outside `commentBody`:** the single-line
`truncate`/`line-clamp` title contexts, where a half-cut-off `**`/code fence
looks worse than plain text — the thread-header title (`selComment().body`) and
`workflowNote`'s Tasks snippet stay plain text.

**Long words/URLs break within the word (`[overflow-wrap:anywhere]`):** each of
the three `.innerHTML="${commentBody(...)}"` containers (`commentRow`'s preview
span, `reactionBubble`'s bubble `<div>`, `prWideItem`'s body span) carries this
arbitrary-value class next to its `truncate`/`line-clamp`/no-wrap class —
without it a long spaceless token (URL, hash, path) sticks out of the
card/bubble, since the default only breaks at word boundaries.

### Markdown images: grouped side by side, click-to-fullscreen, →/← to cycle

Reviewer request ("ik wil screenshots uit readme kunnen inzien... als er
meerdere afbeeldingen achter elkaar zijn zonder tekst, laat het mooi naast
elkaar zien. als ik erop klik moet het volledig scherm en moet ik door alle
afbeeldingen kunnen gaan met pijltjes naar rechts"), confirmed to apply
**"overal waar markdown staat"** — one mechanism, every `renderMarkdown` call
site, not a per-feature reimplementation. Two pieces:

- **`enhanceImages(html)`** (`markdown.mjs`, the last step of `renderMarkdown`
  before `highlightMentions`) styles every `<img>` snarkdown produced
  (`cursor-zoom-in`, rounded border, `data-md-image="true"`) and wraps a RUN of
  **2 or more** images separated only by whitespace — no other text/tags
  between them — in a `flex flex-wrap` row, so several screenshots pasted back
  to back sit side by side as fixed-height thumbnails instead of stacking one
  full-width image per line. Reliable as a plain regex scan (not a real
  HTML/DOM parse) specifically because snarkdown never wraps a line in a
  `<p>` (`src/vendor/snarkdown.js` has no paragraph handling at all — see its
  own header comment), so two images on consecutive source lines really do
  end up as `<img>(\s*)<img>` in the output.
- **`src/imageLightbox.mjs`** — one document-level delegated click listener
  (`initImageLightbox()`, called once from `home.mjs`)
  reacting to `img[data-md-image]`, scoped to "every other image in the SAME
  rendered Markdown body" via `.closest('.markdown-body')` — the shared class
  every `renderMarkdown` render point already carries (see above), so this
  needed **no** per-call-site wiring: the PR description, comment bodies,
  Claude-chat bubbles and the `/inbox` task description all get it for free.
  Opens a fullscreen overlay (`ImageLightboxHost`, mounted top-level next to
  `MenuHost`/`App` in each page, exactly like the command palette); →/←
  **wrap around** the image list, Escape closes. `isLightboxOpen()`/
  `handleLightboxKeydown(e)` are checked FIRST in each page's own global
  `onKeydown`, mirroring the command palette's own `menu.open` guard — while
  open, the lightbox owns the keyboard completely.

Same "the shape carries the meaning" colorblind-rule reasoning as
`scrollHint`/`stepChevron`: the prev/next buttons are a bare chevron, no text
label, only a `title`/`aria-label`. Test: `tests/image-lightbox.spec.mjs`.

### A raw `<img>` HTML tag (GitHub's own screenshot paste) is also rendered as an image

Reviewer report: GitHub's drag-and-drop screenshot upload writes a literal
`<img width height alt src />` tag into the PR body instead of `![]()` syntax
— which the XSS layer above (point 3, "the **entire** raw Markdown text is
fully HTML-escaped") turned into a wall of escaped tag text instead of a
picture. `extractRawImages` (`markdown.mjs`) is a deliberate, narrow exception
to that rule: it runs in the same extraction slot as `extractCodeFences`
(before `escapeHtml`, same placeholder/`store` mechanism, so a tag *inside* a
fenced code block is left alone), and recognises **only** a tag with a
double-quoted `src` attribute — every attribute is read through a strict
allow-list (`src`/`alt`/`width`/`height`; anything else, e.g. `onerror=`, is
silently dropped) and `src` itself passes through the same
`UNSAFE_SCHEME_RE` check `sanitizeUrls` uses. A tag with no recognisable
(quoted) `src`, or an unsafe one, is returned **unchanged** and falls through
to the ordinary `escapeHtml` pipeline — this is why the existing
`<img src=x onerror="alert(1)">` XSS test still passes unchanged. The emitted
tag is a bare, unstyled `<img src alt width height>` — the same shape
snarkdown's own `![]()` renderer produces — so `enhanceImages`/
`imageLightbox.mjs` above need no change at all: a run of pasted screenshots
groups side by side exactly like a Markdown-syntax image run. Test:
`tests/markdown.spec.mjs` ("renders a raw GitHub-style `<img>` tag…", "drops
an unsafe raw `<img>` tag…").

## Shared avatar helper (`src/avatar.mjs`)

`avatarHTML(name, avatarUrl, sizeCls, extraCls)` — extracted from
`overview.mjs`'s `reviewerAvatar` — renders an `<img>` when there's an
`avatarUrl`, otherwise an initials circle (first two letters, uppercase), same
colors/shape as the PR list. `reviewerAvatar` now calls it for its own circle
(the approved/changes-requested badge around it stays local to `overview.mjs`).
An `<img>` falls back to the initials circle on a load error via a static
`onerror` attribute string, so an unreachable/offline image (e.g.
`SLASH_GITHUB=off` tests) never leaves a broken-image icon.

`RelatedPanel.mjs` uses it in `commentRow` (`h-4 w-4`), `reactionBubble` (every
thread bubble — the synthetic opening and every reaction, both carry an
`author`, see `threadMessages`) and `prWideItem`: author name + avatar on their
own line above the body/kind badge (`data-testid=comment-author`/
`reaction-author`/`pr-wide-author`, plus the matching `*-author-line` wrapper).
The author line is deliberately roomy (avatar `h-5 w-5`, name `text-[11px]`;
`h-6 w-6`/`text-sm` on the PR-comment detail card) so a long login/bot name
isn't cramped next to its badges.

**`Block.mjs` stays on `avatarHtmlString`** — its pane HTML is a plain string
assigned via `.innerHTML`, so an arrow.js template would leak as text (see the
statically-interpolated-template pitfall in
`.claude/rules/arrowjs-pitfalls.md`). No change was needed there, because the
name reaching it is already a plain string from `identityOf`.

### Data model: a github-sourced message carries a real avatar URL, an app-placed one doesn't

`modules/github` threads the author's `user.avatar_url` (a shared `ghUser`
sub-struct) through `Reply`/`ReviewComment`/`GeneralComment`;
`comment_import.go`/the reply poller carry it on
`CodeCommentInput.AvatarURL`/`ReactionSignal.AvatarURL`, and the existing
`saveComment`/`saveReaction` Activities store it in the `avatar_url` column of
both `comments` and `reactions` (light `ALTER TABLE … ADD COLUMN` migration) →
`Comment.AvatarURL`/`Reaction.AvatarURL` → `avatarUrl` in `/api/comments`. The
frontend needed no change: `avatarHTML` renders an `<img>` as soon as a URL is
present. Deliberately the **real API field**, never a URL derived from the login
— a GitHub App bot (`kilo-code-bot[bot]`) has no `github.com/<login>.png`
shorthand, and those bot avatars are exactly the ones a reviewer wants to
recognize.

### An own (`source: 'ui'`) message gets the local reviewer's identity at DISPLAY time

The UI posts a placeholder author (`'reviewer'`) and no avatar for a message
written in this app, so such a bubble used to sit as a bare `RE` initials circle
next to real profile pictures. `avatar.mjs` therefore fetches the authenticated
user once from the read-only **`GET /api/me`** (`handleMe` →
`TaskManager.CurrentUser` → `github.Client.CurrentUser`, i.e. `gh api user`,
cached in-memory for the process lifetime — the same operational carve-out as
the heartbeat map, see `.claude/rules/workflows-write-boundary.md`), and
`identityOf(source, author, avatarUrl)` substitutes `{name, avatarUrl}` for
`source === 'ui'` (or missing) only; every other message renders what it carries.

**`identityOf` treats a missing `source` the same as `'ui'`
(`(source || 'ui') === 'ui'`)**, because a genuinely in-app-placed comment
stores an empty `Source` and Go's `json:"source,omitempty"` drops it from the
response — so the value reaching `identityOf` is `undefined`, not `'ui'`. A bare
`source === 'ui'` check therefore never matched a placed comment's own root
message and it kept showing `RE` + the literal name `"reviewer"`. Every other
call site already normalized this the same way (`c.source || 'ui'`, see
`threadMessages`'s synthetic opening message and `commentActivitySummary` in
`RelatedPanel.mjs`); `identityOf` had been overlooked. A genuinely foreign
message (`github`/`ai`) always carries a real, non-empty `source`, so this can
never misclassify one as an own message.

Call sites: `reactionBubble`, `compactConversation` and `commentDetailCard`
(`RelatedPanel.mjs`) — always for **both** the avatar and the name text, so they
never name different people. Deliberately display-time rather than a write-time
author/avatar column: it also fixes every own message **already** stored with
`'reviewer'`, which a write-time fix could only repair through a per-thread
backfill Signal.

### Who am I: `data/settings.json` wins over `/api/me`

`src/mentions.mjs` answers "does this comment `@`-mention **me**?". The spellings
that count come from `<dataDir>/settings.json` (`GET /api/settings`,
`settings.go`) — `{"me": {"login": "reindert-vetter", "aliases": ["reindert"]}}`
— and that file **wins** over the authenticated login from `GET /api/me`, which
stays the fallback: with no file at all, `@<your-login>` is matched and the
feature works out of the box. The file exists for the two things `/api/me`
cannot give: overriding that login, and adding the **shorter forms people
actually type**. Those aliases are deliberately **explicit**, never derived from
the login — a "first segment before the dash" heuristic would turn the login
`dev-tools` into a stray `@dev` match. Matching is case-insensitive with a
`(?![\w-])` tail guard (so `@reindert` does not match inside `@reindert-vetter`,
which the login itself covers) and longest-alias-first.

`settings.json` is **gitignored** — it names one person, unlike the team-wide,
committed `data/names.json` — with a committed `data/settings.example.json` as
the template. It sits **next to** `names.json`/`praise-words.json` rather than
swallowing them (one is committed team data, the other pre-existing with its own
endpoint/tests; merging would be a migration for no functional gain), but any new
**per-user** setting belongs in it. Same read-once-per-data-dir + in-memory-cache
shape and the same read-only write-boundary carve-out as those two.

**The highlight is the LAST step of `renderMarkdown`** (`markdown.mjs` →
`highlightMentions`), so it runs on the finished, already-escaped HTML and only
*adds* a `<mark>` around inert text — the XSS layer is untouched, and every
render point (comment bodies via the single `commentBody`, the PR description,
the chat bubbles) gets it without a signature change. Only the **non-tag**
segments are transformed (split on `(<[^>]*>)`), so an `@name` inside an
`href`/class value is out of reach; Prism code fences are still opaque
placeholders at that point and stay untouched on purpose. Styling is background
**plus bold plus a ring** (`data-testid=mention`) — never colour alone, per the
colorblind rule. Timing rule as always: `ensureSettings()` is **awaited** next to
`ensureMe()` in `loadComments` before the rows are pushed, because `cfg` is plain
non-reactive state. Where the mention *also* changes the index (the "Mentioned"
section): `.claude/docs/comments-panel.md`.

### Real names instead of logins

The same module resolves a login to a real name (`ensureNames`/`fullNameOf`/
`firstNameOf`/`displayNameOf`/`avatarUrlOf`) so the UI can say "Dennis" instead
of "dennissloove", fed by the read-only `GET /api/names` (local `names.json`
override → GitHub profile `name` → the bare login). It lives here because it
answers the same "who is this" question as `identityOf`. Full mechanism
(precedence, caching, skip-list, write-boundary carve-out): "Real names instead
of logins" in `.claude/docs/pages-and-routing.md`.

`identityOf` resolves the name itself, so every existing call site got real
first names for free — the comment/reply bubbles, the compact conversation, the
PR-comment detail card (`RelatedPanel.mjs`), and the comment-activity avatars in
`BlockList.mjs`/`Block.mjs`. Only the places reading a raw `author` field
needed touching: `BlockList.mjs`'s `categoryOrAvatar` and `RelatedPanel.mjs`'s
`lastReplyNote`. `identityOf` also falls back to `avatarUrlOf(author)` when a
message carries no avatar of its own, so a comment stored before the
`avatar_url` column existed now shows a real picture. An author that isn't a
GitHub login (`AI check`, the `reviewer` sentinel) resolves to nothing and is
shown verbatim.

### Timing is load-bearing: await before pushing the rows

Both `me` and `names` are plain **non-reactive** objects/`Map`s, and arrow.js
reuses a keyed node without re-running its bindings (see
`.claude/rules/arrowjs-pitfalls.md`), so a late arrival would never repaint.
Therefore `await` them **before** pushing the rows that render them:
`loadComments` (`RelatedPanel.mjs`) awaits `ensureMe()` and then
`ensureNames(commentAuthors(list))` before pushing `cs.list`. One batched
request per list, cached afterwards, so the comment poll costs nothing extra. A failed
lookup (offline, `SLASH_GITHUB=off` → `{ok:false}`) leaves `me`/`names` empty,
which makes `identityOf` a no-op — an own comment then keeps the initials
circle, as in every offline test run. Tests:
`tests/comment-author-avatar.spec.mjs`, plus `TestAvatarURLRoundTrip`
(`modules/comments`) and `TestImportCarriesAuthorAvatars`
(`comment_import_test.go`) for the backend chain.

## Theme: system/light/dark with a manual cycle button (`src/theme.mjs`)

The theme once followed **exclusively** the system setting
(`prefers-color-scheme`, Tailwind `darkMode:'media'`, no toggle); that was
reversed — a reviewer sometimes wants to force light/dark independent of the OS.
`src/theme.mjs` is a shared pure utility (like `urlState.mjs`, not a component)
used by both pages.

- **Three states**, not a binary toggle: `theme.pref` ∈
  `'system'|'light'|'dark'` (default `'system'`). A binary toggle would leave a
  reviewer who picked "light" while the OS is dark with no way back to "follow
  system" without changing the OS setting.
- **Tailwind runs on `darkMode: 'selector'`** (in the same `tailwind.config`
  `<script>` before the CDN styles) — every existing `dark:` utility keeps
  working, only the trigger changes from the media query to the presence of a
  `.dark` class on `<html>`.
- `applyTheme(pref)` sets that `.dark` class **plus** a
  `data-theme="light"|"dark"` attribute on `<html>` (for the separate CSS below,
  which can't read a class), computed as
  `pref==='system' ? matchMedia(...).matches : pref==='dark'`. `initTheme()`
  (a module side effect in both `home.mjs` and `overview.mjs`) applies it
  initially, subscribes `watch(() => theme.pref, applyTheme)` and a
  `matchMedia('(prefers-color-scheme: dark)')` `'change'` listener that only
  intervenes while `pref === 'system'` — so "system" keeps following the OS
  **live** while the page is open.
- **Anti-flash:** before the Tailwind CDN `<script>`, both shells
  (`index.html`/`overview.html`) have an **inline** `<script>` duplicating the
  same localStorage-read + class/attribute-set logic (not imported — ES modules
  load async and this must run before first paint). `initTheme()` then takes
  over reactively.
- **Persistence:** `localStorage` key `'theme'` — deliberately outside
  `bindUrlState`/the query string (not a navigation position, doesn't belong in a
  shared link) but also not ephemeral like `state.showApproved` (a theme choice
  should survive a refresh).
- **The button** (`themeToggleButton(cls)`, `data-testid=theme-toggle`, one
  shared component both pages import): a click cycles
  `system → light → dark → system` (`cycleTheme()`, persists immediately) and
  shows a monitor/sun/moon icon. On `/pr/<id>` it sits in a narrow row in
  `prInfoCard` (`data-testid=pr-info-theme-row`), directly before
  `data-testid=pr-info-summary`. The earlier always-visible fixed corner element
  (`ThemeToggleCorner`, `bottom-6 left-6 z-30`) has been **removed**, and it is
  deliberately **not** in `Footer.mjs` (that footer only shows when there's
  something to preview, see `.claude/docs/footer.md`). Accepted consequence,
  explicitly agreed: `prInfoCard` only exists while `state.showDescription` is
  true (stop 1 of the nav chain, see `.claude/docs/detail-layout.md`), so the
  button is **not** visible by default — `tests/theme.spec.mjs` presses `←` to
  stop 1 first. On `/pr-overview` it stays in the overview header
  (`overview.mjs`'s `headerBlock`, next to the PR-count pill); that page has no
  `showDescription` gating.
- **A second, unrelated toggle sits in the same `pr-info-theme-row`:**
  `autoWarnToggleButton` (`src/autowarn.mjs`, `data-testid=auto-warn-toggle`),
  labelled **"Live AI assistent aan/uit"** — it turns off *every* automatic
  Claude call the review tree makes on its own: the AI risk check
  (`code_warning`), the footer's AI description (`explain_code`, hidden
  as well as unrequested — see `.claude/docs/footer.md`) **and** the short
  title a long comment gets (`comment_titles`, see
  `.claude/docs/comments-panel.md`). Deliberately NOT
  `resolve_call`/`resolve_test_covers`: those build the navigation structure
  rather than describing anything, so switching them off would break the tree
  instead of quietening it; a manual "Diepgravend onderzoek" is never gated
  either. It only shares the row/style with the theme button — its state is
  **not** `localStorage` like the theme, because it gates backend behaviour
  the server must read at trigger time; see "AI risk check of the whole PR" in
  `.claude/docs/workflows-analysis.md` for the full mechanism. The store,
  endpoint and workflow keep the original `autowarn` name.

`overview.html` once forced dark mode (`<html class="dark">` +
`darkMode:'class'`, bare `zinc-*` classes with no `dark:` variant); removed —
`overview.mjs` got a light base class before every previously bare dark class
(the latter gained a `dark:` prefix), symmetric with how
`index.html`/`home.mjs`/`Block.mjs`/`BlockList.mjs`/`RelatedPanel.mjs`/
`CommandMenu.mjs`/`Footer.mjs` (previously light-only) gained a `dark:` variant
behind every existing color class.

### Color palette

Neutrals map 1-to-1 between the two families already in the codebase: light
`slate-*` (`bg-white`/`bg-slate-50/100/200`, `text-slate-900..400`,
`border-slate-100/200/300`) ↔ dark `zinc-*` (`bg-zinc-900/950/800/700`,
`text-zinc-100..500`, `border-zinc-800/700`, usually with a `/NN` opacity suffix
for a subtler card tint than `overview.mjs`'s solid dark tints). Semantic accents
(emerald/rose/amber/sky/red, and `BlockList.mjs`'s `CATEGORY_STYLE` hues) keep
their hue but get a contrast-appropriate shade per mode: `bg-emerald-50`/
`text-emerald-700` ↔ `dark:bg-emerald-500/15 dark:text-emerald-300`, and vice
versa. Solid saturated accent buttons/badges (`bg-indigo-500`,
`bg-emerald-600` + `text-white`) and low-opacity rings (`ring-emerald-500/30`)
work in both modes and are deliberately untouched — only backgrounds/text that
sit *on* the page or card background need per-mode shading.

**Diff-row backgrounds** (`Block.mjs`, `paneHTML`) are arbitrary-value hex
classes (`bg-[#fed7dc]` etc., "20% toward white" mixed with the Tailwind
rose/emerald shade — see `.claude/docs/diff-render.md`); those got a
`dark:bg-{color}-500/{opacity}` counterpart (e.g. `dark:bg-rose-500/25` for the
active del row, `dark:bg-rose-500/10` for the filler tint) instead of a second
hardcoded hex.

### What can't use a Tailwind `dark:` variant

The Prism token colors and the `.markdown-body` typography in `index.html`'s
`<style>` block. Those live in **two** matching blocks: the existing
`@media (prefers-color-scheme: dark) { … }` block (the pre-JS/no-JS fallback)
and a **`:root[data-theme="dark"] …` mirror** next to it — every selector
literally duplicated with that attribute prefix, deliberately **no** CSS
nesting, for maximum browser compatibility — which wins once the manual toggle
overrides the OS. Both share the same palette (a GitHub-dark-inspired Prism
palette + the zinc/indigo dark-mode colors).

**The native scrollbar colour is the same category.** `color-scheme` (a CSS
property, not a Tailwind utility) drives Chromium's choice between a light and
a dark native scrollbar, independent of background colours or the `.dark`
class — without it, the scrollbar stays light even in a dark UI. Same
three-piece shape (`:root { color-scheme: light }` base,
`:root:not([data-theme='light']) { color-scheme: dark }` inside the `@media`
block, `:root[data-theme='dark'] { color-scheme: dark }` mirror), but it
applies on **every** page with a native scrollbar — `index.html`,
`settings.html` and `overview.html` each carry it in their own `<style>`
block, even `settings.html`/`overview.html`, which otherwise have no (or a
much smaller) Prism/markdown block.

**Every selector inside the `@media` block carries a
`:root:not([data-theme='light'])` gate** (in `index.html` AND `inbox.html` —
keep it when editing): a media query only sees the OS preference, so without the
gate an OS on dark + the manual **light** toggle (`data-theme="light"`, no
`.dark` class, all Tailwind light) still applied these dark Prism/markdown
colors, leaving near-black `pre` blocks and lavender inline-code pills inside
white cards. With the gate the media block stays the fallback (attribute absent →
OS wins) but loses to an explicit light choice.

**arrow.js-compliant:** wherever a class string runs through a reactive
`class="${() => ...}"` binding, the `dark:` class sits **in the same template
string** as the rest of that value — no separate loose binding, so no new
pitfall on top of the whole-value rule in
`.claude/rules/arrowjs-pitfalls.md`.

## Go

`net/http` `ServeMux`, handlers per feature. The `/api/` bridge shells out to
`gh`/`claude` via `os/exec` — **always validate input before handing it to a
subprocess.**

## Git worktrees

**Git worktrees are allowed** — Claude/agents may set up a git worktree to work
isolated or in parallel (e.g. the Agent tool with `isolation: worktree`). An
earlier agreement forbade this; that is withdrawn. Not to be confused with the
**app's own** base/head worktrees under `data/worktrees/` from the ingest
pipeline — those stay as described in `.claude/docs/blocks-and-ingest.md`.
