---
name: workflow-prompt
description: Draai een reeks losse, onderling ongerelateerde prompts als één sequentiële workflow — elke prompt gaat direct en ongewijzigd naar een eigen geïsoleerde subagent, met een [x]/[*]/[ ]-overzicht en een commit per afgeronde taak. Gebruik wanneer de gebruiker "run dit als workflow", "ik geef je prompts één voor één", of iets vergelijkbaars vraagt.
---

# Prompt-workflow: losse prompts sequentieel als geïsoleerde subagents

De gebruiker voert **losse prompts** in (vaak één-voor-één). Ze hebben geen
inhoudelijke relatie, maar moeten **achter elkaar** en **elk in eigen context**
worden opgepakt. Jij (de **hoofd-assistent**) bent een **dunne orkestrator**: je
doet zelf **bijna niks** — je geeft elke prompt **direct en ongewijzigd** door aan
een **subagent** (`Agent`-tool) en houdt de volgorde + het overzicht bij. Het
denkwerk (plan maken, uitvoeren) hoort volledig bij de subagent.

**Waarom dit een skill is en géén subagent-definitie:** alleen de hoofd-assistent
kan subagents starten, ze sequentieel afwikkelen, en (als een subagent met een
vraag terugkomt) die vraag via `AskUserQuestion` aan de gebruiker voorleggen. Een
subagent kan dat niet. Deze skill instrueert dus jou, de hoofd-loop — maar houd je
rol minimaal: relayen, sequencen, overzicht. Niet zelf plannen of vragen bedenken.

## De harde regels

1. **Overzicht bijhouden.** Toon boven elke beurt een checklist en werk 'm bij:
   ```
   - [x] Taak 1 — <korte titel> — klaar (<commit-sha>)
   - [*] Taak 2 — <korte titel> — bezig
   - [ ] Taak 3 — <korte titel> — todo
   ```
   `[x]` = klaar (met commit-sha), `[*]` = bezig, `[ ]` = todo.

2. **Sequentieel, één tegelijk.** Start pas de subagent voor taak N+1 als taak N
   **gecommit** is. Zo ziet elke volgende subagent de vorige wijziging in de tree
   en ontstaat er geen race.

3. **Subagents draaien SYNCHROON** (`run_in_background: false`). Nooit in de
   achtergrond. (Achtergrond bleek een achterhaalde, in-de-war-rakende agent op
   te leveren die z'n eigen werk voor een "concurrent proces" aanzag — én de
   melding kwam pas 40 min later. Synchroon = jij wacht netjes op elk resultaat.)

4. **Prompt direct doorgeven — zelf niks bedenken.** Krijg je een nieuwe prompt,
   geef die **ongewijzigd** door aan de subagent. Stel zelf **geen** planvragen,
   bedenk zelf **geen** plan, herformuleer niet. Het plannen is de taak van de
   subagent: instrueer 'm om **eerst zijn plan uit te schrijven en dán te
   stoppen** — nog niet uitvoeren. Zo krijg je (en de gebruiker) het plan te zien
   vóór er iets gebeurt.

5. **Uitvoeren pas als de vorige taak klaar is.** Een subagent mag zijn plan
   meteen uitschrijven, maar begint pas met **uitvoeren** zodra de vorige taak
   **gecommit** is (sequentieel, zie regel 2). Is de vorige nog bezig, dan wacht
   de nieuwe subagent op het plan; geef 'm het startsein (`SendMessage`
   "voer nu uit") zodra de vorige gecommit is.

6. **Vraag-relay als vangnet.** Instrueer elke subagent expliciet: *"is iets
   onduidelijk, gok dan niet — stop en geef je vraag terug in je antwoord."* De
   subagent kan zelf géén vraag aan de gebruiker stellen. Komt hij met vragen
   terug, dan leg jij ze via `AskUserQuestion` aan de gebruiker voor en zet je
   **dezelfde** subagent voort met `SendMessage` (context blijft intact) — niet
   een verse `Agent`-call. Dit is het **enige** moment dat jij `AskUserQuestion`
   gebruikt: als relay van een vraag die de subagent zélf stelde.

7. **Commit per taak, geen worktrees.** Na elke afgeronde taak: eerst
   **verifiëren** (draai de relevante test(s) / drive de flow, zie skill
   `verify`), dan committen. Werk direct op de branch waarop de gebruiker zit
   (geen aparte worktree — de gebruiker heeft dat zo gevraagd). Volg de
   commit-message-conventie van de repo (Engelse code/commits, zie
   `.claude/rules/conventions.md`).

8. **Geef de subagent de ruimte, maar hou 'm gefocust.** Geef de prompt
   ongewijzigd door (regel 4), maar voeg wel de vaste kaders toe: "werk minimaal,
   geen brede refactor, geen uitgebreide docs-herschrijving", plus de
   relay-instructie (regel 6) en de plan-eerst-instructie (regel 4). Bedenk zelf
   geen extra scope of pointers — dat is aan de subagent en aan de prompt.

## Kies het juiste subagent-type

- Frontend (`src/*.mjs`, arrow.js) → `frontend`.
- Go-server / `/api` / SQLite → `go-server`.
- Onderzoek / breed zoeken → `Explore` of `general-purpose`.

## Verloop per prompt (samengevat)

1. Zet de taak in het overzicht op `[*]`.
2. Geef de prompt **ongewijzigd** door aan de subagent (synchroon), met de vaste
   kaders: *plan eerst uitschrijven en stoppen, nog niet uitvoeren* + *gok niet,
   kom met vragen terug* + *werk minimaal*. Zelf geen plan of planvragen bedenken.
3. Komt de subagent met vragen terug → relay via `AskUserQuestion` → `SendMessage`
   terug naar dezelfde subagent.
4. Heeft de subagent zijn plan af en is de **vorige** taak gecommit → geef het
   startsein (`SendMessage` "voer nu uit").
5. Klaar → verifiëren → committen → overzicht op `[x]` met de sha.
6. Wacht op de volgende prompt.
