---
name: add-api-endpoint
description: Add a new /api/* bridge endpoint to the Go HTTP server that shells out to a local CLI (gh, claude) or reads/writes the SQLite graph. Use when the frontend needs a new server capability. Enforces the no-dependency, safe-exec conventions.
---

# Nieuw `/api/*`-endpoint

De Go-server serveert de repo statisch + een dunne `/api/*`-bridge. Endpoints doen
één van twee dingen: uitshellen naar een lokale CLI (`gh`, `claude`) of de SQLite
call-graph lezen/schrijven.

## Stappen

1. Kopieer `.claude/templates/api_handler.go` als startpunt.
2. Registreer de handler op de `ServeMux` onder een `/api/<feature>`-pad.
3. Kies de bron:
   - **CLI-bridge** (`gh`/`claude`): gebruik `exec.CommandContext` met **losse
     args**, nooit een shell-string. Zet een timeout via `context`.
   - **SQLite**: `database/sql` + `modernc.org/sqlite`. Gebruik geparametriseerde
     queries (`?`), nooit string-concatenatie. Prepared statements voor hot paths.
4. **Valideer/whitelist alle input** vóór gebruik in een subproces of query
   (methode, verplichte velden, numerieke ranges, toegestane waarden).
5. Antwoord met JSON; zet `Content-Type: application/json`. Serveer deltas, niet de
   hele graph.
6. Voeg een Playwright-test toe die het endpoint via de UI-flow raakt.
7. **Herstart de server** en verifieer het endpoint (zie hieronder). Een
   browser-refresh alleen laadt de nieuwe route niet.

## Herstart na een backend-wijziging (verplicht)

De Go-server heeft **geen hot-reload**. Een draaiende server blijft het oude
binary uitvoeren; een nieuw of gewijzigd `/api/*`-pad bestaat daar dus niet en
valt door naar de statische file-server → **404** ("code load failed: 404" e.d.).
Een browser-refresh helpt niet — je moet het proces herbouwen én herstarten:

```sh
# vind + stop de oude server (voorbeeld-adres :8765)
pkill -f 'slash .*-addr 127.0.0.1:8765' || true
# herbouw en herstart op hetzelfde adres/DB
go build -o tests/.tmp/slash . && \
  tests/.tmp/slash -db data/graph.db -addr 127.0.0.1:8765 -static . &
# verifieer dat het pad nu bestaat (200, geen 404)
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8765/api/<feature>?...'
```

Symptoom dat je dit vergat: de UI toont een 404 voor een endpoint dat lokaal
(op een verse build) wél 200 geeft.

## Harde regels

- Geen nieuwe dependency zonder overleg (zie CLAUDE.md). SQLite-driver =
  `modernc.org/sqlite`, dat is de enige toegestane runtime-dependency.
- Nooit rauwe user-input in een shell-commando of SQL-string.
