---
name: prompt-workflow
description: Draai een reeks losse, onderling ongerelateerde prompts als één sequentiële workflow — elke prompt in een eigen geïsoleerde subagent-context, met een [x]/[*]/[ ]-overzicht, planvragen vooraf, en een commit per afgeronde taak. Gebruik wanneer de gebruiker "run dit als workflow", "ik geef je prompts één voor één", of iets vergelijkbaars vraagt.
---

# Prompt-workflow: losse prompts sequentieel als geïsoleerde subagents

De gebruiker voert **losse prompts** in (vaak één-voor-één). Ze hebben geen
inhoudelijke relatie, maar moeten **achter elkaar** en **elk in eigen context**
worden opgepakt. Jij (de **hoofd-assistent**) bent de orkestrator; elke prompt
draai je als een **subagent** (`Agent`-tool).

**Waarom dit een skill is en géén subagent-definitie:** de orkestrator moet
vragen aan de gebruiker stellen (`AskUserQuestion`) en zelf subagents starten —
dat kan alléén de hoofd-assistent. Een subagent kan dat niet. Deze skill
instrueert dus jou, de hoofd-loop.

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

4. **Planvragen vooraf.** Krijg je een nieuwe prompt, stel dan éérst zelf de
   openstaande verduidelijkingsvragen aan de gebruiker via `AskUserQuestion` om
   een plan te vormen — vóór je de subagent start. Gok niet bij ambiguïteit.

5. **Vraag-relay als vangnet.** Instrueer elke subagent expliciet: *"is iets
   onduidelijk, gok dan niet — stop en geef je vraag terug in je antwoord."* De
   subagent kan zelf géén vraag aan de gebruiker stellen. Komt hij met vragen
   terug, dan leg jij ze via `AskUserQuestion` aan de gebruiker voor en zet je
   **dezelfde** subagent voort met `SendMessage` (context blijft intact) — niet
   een verse `Agent`-call.

6. **Commit per taak, geen worktrees.** Na elke afgeronde taak: eerst
   **verifiëren** (draai de relevante test(s) / drive de flow, zie skill
   `verify`), dan committen. Werk direct op de branch waarop de gebruiker zit
   (geen aparte worktree — de gebruiker heeft dat zo gevraagd). Volg de
   commit-message-conventie van de repo (Engelse code/commits, zie
   `.claude/rules/conventions.md`).

7. **Houd subagents snel en klein.** Geef exacte pointers mee (bestanden,
   functies, testbestand) en de opdracht "werk minimaal, geen brede refactor,
   geen uitgebreide docs-herschrijving". Een te vrij geformuleerde opdracht leidt
   tot een overdreven grondige, trage run.

## Kies het juiste subagent-type

- Frontend (`src/*.mjs`, arrow.js) → `frontend`.
- Go-server / `/api` / SQLite → `go-server`.
- Onderzoek / breed zoeken → `Explore` of `general-purpose`.

## Verloop per prompt (samengevat)

1. Zet de taak in het overzicht op `[*]`.
2. Stel planvragen aan de gebruiker (`AskUserQuestion`) tot het scherp is.
3. Start de subagent synchroon met strakke pointers + de relay-instructie.
4. Komt de subagent met vragen terug → relay via `AskUserQuestion` → `SendMessage`
   terug naar dezelfde subagent.
5. Klaar → verifiëren → committen → overzicht op `[x]` met de sha.
6. Wacht op de volgende prompt.
