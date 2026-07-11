---
name: add-module
description: Add a new module/service under modules/ that a workflow can drive as an Activity (like comments or github) — its own storage/behaviour, write methods for workflows only, read methods for the UI. Use when a workflow needs a new capability (a new store, an external system, a side effect).
---

# Nieuwe module toevoegen (`modules/<naam>`)

Een **module** is "een ding dat kan gebeuren in een workflow": een capability met
zijn eigen opslag en/of externe communicatie. `modules/comments` (eigen SQLite
read-model) en `modules/github` (praat met `gh`) zijn de voorbeelden.

**Lees eerst** `.claude/rules/workflows-write-boundary.md`: een module wordt
**alleen** door workflow-Activities aangeroepen om te schrijven; read-methodes
mogen door de UI/API.

## Stappen

1. **Kopieer** `.claude/templates/module.go` naar `modules/<naam>/<naam>.go`,
   `package <naam>`. Module-pad wordt `slash/modules/<naam>`.
2. **Eigen opslag**: een module bezit zijn eigen state. Voor SQLite: eigen
   `data/<naam>.db` + schema-constante, geopend met `Open(path)` (of `New(db)` om
   een bestaande `*sql.DB` te delen). Driver = `modernc.org/sqlite`.
3. **Splits de API** duidelijk:
   - **Write** (workflow-only): `Save`, `Add…`, `Post…` — muteren state of praten
     naar buiten. Idempotent maken waar kan (`INSERT OR IGNORE`/`REPLACE`) zodat
     replay veilig is.
   - **Read** (UI/API): `List`, `Get` — puur lezen.
   "Doe je eigen ding" hoort in de write-methodes (afgeleide velden bijwerken,
   externe call doen), niet in de workflow.
4. **Interface + fake**: exporteer een `Client`-interface van het gedrag en een
   `Fake` (in-memory) zodat workflows/tests de module kunnen injecteren zonder
   netwerk of DB. Zie `modules/github` (`Client` + `Fake`).
5. **Bedraden**: de module wordt in `NewXxxManager(...)` als Activity gewrapt
   (`engine.RegisterActivity(...)`) en in `newTasks(...)` geopend + `Close`'d.
6. **Geen import-cyclus**: modules importeren `package main` niet. Deelt een type
   met de workflow? Definieer het in de module en laat `main` het importeren.

## Harde regels

- Module-writes alleen vanuit een workflow-Activity (write-boundary-regel).
- Geen nieuwe runtime-dependency zonder overleg; SQLite = `modernc.org/sqlite`.
- Valideer/whitelist input vóór een subproces (`gh`) of query (geparametriseerd,
  nooit string-concatenatie).
