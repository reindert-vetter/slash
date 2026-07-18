# Detail-layout & gerelateerd paneel (placeholder)

Rechts van de sidebar staat de `DetailPanel` (`home.mjs`): een `<main>` als
**flex-row** die zijn kolommen **vanaf links inpakt** (`justify-start`, geen
uitrekken) en horizontaal scrolt (`overflow-x-auto`) zodra ze samen breder zijn
dan het scherm.

**PR-info-kolom, stop 1 van de nav-keten, standaard verborgen, fysiek links van
de pr-index** (`data-testid=pr-info-column`, `w-[26rem]`, gerenderd door
`prInfoCard(state)` binnen een eigen `PrInfoPanel(state)`-component in
`home.mjs`). Deze kolom is de meest-linkse stop van de links→rechts
navigatieketen beschreven in `.claude/rules/keyboard-navigation.md`, en staat
ook **visueel** op de meest-linkse plek van het scherm — niet als eerste kind
van `<main>` (dat was 'm eerder, maar dan verscheen hij pas ná de pr-index i.p.v.
ervoor), maar als een **eigen `position:fixed`-paneel**, sibling van `<aside>`
(de pr-index, `BlockList.mjs`) en `<main>`, gemount vóór beide in
`home.mjs`. Reden: `<aside>` is zelf `position:fixed` en zit dus **buiten**
`<main>`'s flex-flow — om de PR-info-kolom er echt links vóór te krijgen (i.p.v.
erná, zoals een flex-child van `<main>` zou doen) moet hij op hetzelfde niveau
zitten en de vaste `left-6`-plek van de pr-index overnemen, terwijl de pr-index
zelf naar rechts opschuift.

`state.showDescription` (default `false`) bepaalt of de kolom bestaat — dicht
neemt hij **geen ruimte** in (het hele `${() => state.showDescription ? html\`…\`
: ''}`-blok valt weg, net als voorheen). Open (alleen mogelijk in
`state.mode==='list'`, zie hieronder) gebeurt er twee dingen tegelijk, beide
gedreven door dezelfde `state.showDescription`-vlag, dus altijd in lockstep:
- `PrInfoPanel` verschijnt op `left-6` (de plek waar `<aside>` normaal staat).
- `<aside>` (de pr-index) schuift zichzelf `27.5rem` naar rechts
  (`translate-x-[27.5rem]` i.p.v. `translate-x-0`, in `BlockList.mjs`'s eigen
  class-ternary — vóór de bestaande `mode==='diff'`-check, die voorrang houdt:
  in diff-mode schuift de pr-index nog steeds volledig weg, ongeacht
  `showDescription`). 27.5rem = de breedte van de PR-info-kolom (26rem) plus de
  1.5rem gap ertussen, zodat beide kolommen strak tegen elkaar aan staan — net
  zo'n gat als tussen de pr-index en `<main>` normaal.
- `<main>` (`DetailPanel`) schuift op zijn beurt **ook** 27.5rem naar rechts
  (`left-[56.5rem]` i.p.v. het gebruikelijke `left-[29rem]`, in dezelfde
  class-ternary als de bestaande `mode==='diff' → left-6`-tak), zodat de
  block-kolom niet onder de opgeschoven pr-index komt te zitten. Dit is
  **losgekoppeld van** `<aside>`'s eigen transitie maar gebruikt dezelfde
  27.5rem-afstand, dus beide bewegen in dezelfde 200ms CSS-transitie in sync.

Bereikt vanuit de pr-index (stop 2, `state.mode==='list'`) met `←`; `→` sluit 'm
weer. Terwijl hij open is negeert `onKeydown` `↑`/`↓` (geen interne cursor). Zowel
deze kaart als de pr-index `<aside>` tonen de **zelfde aan/uit indigo focus-rand**
als de block-diff-kaart terwijl ze de keyboard hebben — zie "Focus-highlight per
stop" in `.claude/rules/keyboard-navigation.md` voor het volledige patroon. Een
witte kaart met titel + Jira-badge, meta-regel (auteur, `+add −del`,
bestandenaantal, branch, "op GitHub ›"), een **Samenvatting**-sectie
(Claude-tekst), een **Omschrijving**-sectie (PR-body + eventueel een
Jira-kadertje), en onderaan review/CI-pills.
**Omschrijving-truncatie (`state.descriptionExpanded`, efemeer):** een **lange**
PR-body (> `DESC_TRUNCATE_AT` = 280 tekens) wordt standaard afgekapt
(`max-h-40 overflow-hidden`) met onderaan een klikbare fade-affordance
(`data-testid=pr-info-body-toggle`, "meer…") die de body volledig uitklapt; open
wordt het een gewone "Inklappen"-link. Een **korte** body rendert altijd
volledig (geen misleidende toggle — puur op karakter-lengte, dus deterministisch,
geen DOM-meting). Dezelfde vlag wordt ook getoggeld door het PR-menu-item **"Toon
volledige omschrijving" / "Omschrijving inklappen"** (`PR_COMMANDS`, `/`-menu, zie
`.claude/rules/keyboard-navigation.md`), dus in-card-klik en menu blijven in
lockstep. `state.descriptionExpanded` (default `false`) leeft **buiten de URL**
(efemeer, net als `showDescription`). De class-strings van de body + toggle zijn
**hele-waarde** function-bindings (geen deel-interpolatie — arrow.js-valkuil in
`conventions.md`). De review/CI-pills zijn gestyled als de dark-zinc pills in
`overview.mjs` maar dan in het lichte kaart-thema (`bg-emerald-50`/`bg-rose-50`/
`bg-amber-50` i.p.v. `bg-emerald-500/15` etc.). De kaart leest **uitsluitend**
`state.prMeta`/`state.pr`/`state.prUrl`/`state.jiraKey` — nooit `b.code` —
zodat hij niet co-subscribed raakt met de diff-render (zie de "stuck on
loading"-valkuil in `conventions.md`).
**Progressief laden:** `state.prMeta` (leeg object bij start) wordt door
`pollPRMeta` in `home.mjs` **wholesale hertoegewezen** op elke poll van
`GET /api/pr?pr=N` (elke 1.5s, tot de statussen er zijn of na een max van 20
pollingen) — het `pr_status`-workflow vult het `prmeta`-read-model in **3 stages**
(basics → Claude-`summary` → review/checks-statussen), dus elke sectie verschijnt
zodra zijn stage klaar is (placeholder ("samenvatting genereren…", een pulserende
skeleton-pill) tot dan). `loadPRMeta` vuurt de `POST /api/workflows/pr_status`
**fire-and-forget** (niet awaited — die POST blokkeert tot alle 3 stages klaar
zijn) en start daarna meteen de poll-lus. Dit alles laadt/pollt ongeacht of de
kolom op dit moment zichtbaar is — `state.showDescription` bepaalt alleen of hij
gerenderd wordt, niet of de data er is tegen de tijd dat je 'm opent.

**PR-brede comments (`PrWideComments`, onder `prInfoCard` in dezelfde
`pr-info-column`):** een tweede kaart (`data-testid=pr-wide-comments`, eigen
interne scroll), **onder** `prInfoCard` in dezelfde
`state.showDescription`-gated container in `PrInfoPanel` — hij heeft dus
**geen eigen zichtbaarheids-toggle**, hij bestaat simpelweg niet totdat de
kolom zelf gemount wordt.
**Hoogte-verdeling volgt wie van de twee kaarten de keyboard bezit
(`isPrWideFocused()`, leest `pw.focus`):** staat de keyboard op de
omschrijving (`pw.focus === null`) dan krijgt `prInfoCard` `flex-[3]` (3/5) en
deze kaart `flex-[2]` (2/5); navigeer je in dit blok (`pw.focus !== null`) dan
draait het nog sterker om — deze kaart krijgt `flex-[5]` (5/6), `prInfoCard`
zakt naar `flex-1` (1/6). Het aandeel van deze kaart is in **beide** staten
groter dan voorheen (was 1/3 resp. 3/4) — de comments zijn vaak te kort
afgekapt om prettig te lezen, dus ze krijgen structureel meer ruimte, niet
alleen zodra ze de focus hebben; een `min-h-[14rem]` op de kaart zelf
garandeert bovendien een leesbare vloer, ongeacht hoe smal de kolom in de
praktijk uitvalt. Beide class-bindingen zijn reactieve hele-waarde-functies
(`${() => ...}`, conform de arrow.js-class-binding-conventie) die dezelfde
`isPrWideFocused()` lezen — `flex-1`/`flex-[n]` zetten allebei een 0%
flex-basis, dus de verhouding komt puur uit de twee grow-getallen. Vervangt de
eerdere vaste `shrink-0 max-h-[16rem]`-cap. Toont de comments met
**`kind !== ''`** —
GitHub-geïmporteerde issue-comments en review(-summary)-comments zonder
regel-anker — uit dezelfde `cs.list` die het blok-gescopeerde comments-paneel
(zie "Comments/taken-sidebar" hieronder) al laadt/pollt (`syncComments`, geen
tweede fetch); `recomputeView` filtert die daar bewust wég (`!c.kind`), dus
deze kaart is hun enige plek. Elke rij (`data-testid=pr-wide-item`) toont een
status-stip (dezelfde `CSTATUS_DOT` als het blok-gescopeerde paneel), een
kind-badge (`data-testid=pr-wide-kind`, "PR-comment" voor `issue`/`review`,
"Review" voor `review_summary`), de bestaande `sourceBadge` ("bron: github")
en een relatieve tijd (`relTime`). Een klik (of `Enter`, zie hieronder) opent
de thread **inline onder de rij** — anders dan het blok-gescopeerde paneel
(dat lijst en thread naast elkaar toont) is hier één kolom, dus het
geselecteerde item toont zijn `threadMessages`/`reactionBubble`'s (hergebruikt,
ongewijzigd) plus een reply-textarea (`data-testid=pr-wide-compose`) en een
losse resolve-knop (`data-testid=pr-wide-resolve`) direct onder zijn eigen
rij. Reply/resolve gaan via **exact hetzelfde** `POST
/api/workflows/{runId}/signals/reply`-Signal als het blok-gescopeerde paneel
(`done:false`/`done:true`) — de backend zet een reply op een PR-brede thread
al om in een nieuwe GitHub-issue-comment en behandelt resolve als
local-only, dus de frontend heeft geen aparte casus nodig.
De comment-body-tekst wordt door één kleine gedeelde helper gerenderd
(`commentBody(c)`, `RelatedPanel.mjs`, hergebruikt door zowel deze kaart als
het blok-gescopeerde `commentRow`) — puur platte tekst, bewust nog geen
markdown, maar wél de ene plek waar een latere markdown-pas moet wijzigen.
**Eigen cursor `pw`** (`RelatedPanel.mjs`, los van `cs.focus`/`cs.sel` van het
blok-gescopeerde paneel én los van `state.showDescription` zelf): `pw.focus`
(`null`/`'item'`/`'thread'`) + `pw.sel` + `pw.threadPos` — zie
`.claude/rules/keyboard-navigation.md` (sectie "PR-brede comments, stop 1")
voor het volledige toetsenbord-mechanisme (`handlePrWideKey`/
`isPrWideFocused`, aangeroepen vanuit `home.mjs`'s `onKeydown`).

Daarna de **block-kolom** (`data-testid=block-column`,
**`shrink-0`** — niet `flex-1`, dus op zijn **natuurlijke diff-breedte**
(`w-[70rem] 2xl:w-[82rem]` voor een tweezijdig `modified` block; een **één-zijdig
added/removed block** toont maar één pane (`singleSide` in `Block.mjs`) en krijgt
daarom **dezelfde smalle 60%-breedte** `w-[42rem] 2xl:w-[49.2rem]` als de `a`-toggle
— eenzijdig is altijd smal, ongeacht `a`, want er valt niets naast te tonen)
i.p.v. de resterende
ruimte op te vullen) met de kaart van het geselecteerde block plus de
look-ahead-preview van het volgende block (dashed connector als ze uit hetzelfde
bestand komen). **Direct náást** die kolom (niet aan de rechterrand van het
scherm) de kaart **Onderliggende code** (`RelatedPanel.mjs`'s default export,
`data-testid=related-code`, `w-[34rem] 2xl:w-[41rem] shrink-0` — op `2xl` net zo
breed als één pane van de side-by-side diff, de helft van diens
`2xl:w-[82rem]`) — stop 5 van de nav-keten,
ongewijzigd inline in `<main>`'s horizontaal scrollende kolom-flow (zie
"Onderliggende code" verderop). Comments en Taken zitten **niet** meer in deze
kolom-flow — zie de sectie "Comments/taken-sidebar" hieronder.

## Comments/taken-sidebar (vast, getoggeld met `g`)

Comments en Taken vormen samen een **eigen `position:fixed` paneel aan de
rechterkant van het scherm** (`RelatedPanel.mjs`'s `CommentsSidebar`-export,
`data-testid=comments-sidebar`, `right-6 top-6 w-[36rem]`, met een **reactieve**
bottom-reservering — `bottom-[90px]`, of `bottom-[140px]` zolang de footer een
AI-omschrijving toont (`state.footerExplain`, zie de Footer-sectie in
`.claude/rules/keyboard-navigation.md`); de collapsed hint-rail spiegelt dat) —
mirror van hoe `PrInfoPanel` een vast paneel links is (zie de sectie
hierboven), **los van** `<main>`'s horizontaal scrollende kolom-flow. Gemount
als eigen top-level component naast `PrInfoPanel`/`BlockList`/`DetailPanel` in
`home.mjs`, niet genest in `DetailPanel`. Binnen de sidebar staat het
**comment-blok** (`data-testid=comments-panel`, `flex-1`) **boven** het
**taken-blok** (`data-testid=workflows-panel`, `shrink-0 max-h-[16rem]`) —
verticaal gestapeld, comments krijgt de meeste ruimte en scrollt intern zodra
hij groeit, taken houdt een kleinere, eigen-scrollende hoogte eronder.

**Getoggeld met `g`** (`toggleSidebar`, geëxporteerd uit `RelatedPanel.mjs`,
aangeroepen vanuit `home.mjs`'s `onKeydown` — globaal, in zowel `'list'`- als
`'diff'`-mode, ongeacht of de diff, de Onderliggende-code-kaart of de sidebar
zelf op dat moment de keyboard heeft): dicht → open + **herstel de laatste
comment-plek van deze sessie** (`restoreLastSidebarFocus`, zie hieronder), of —
zonder zo'n herinnering — highlight op de "+ Comment op deze regel"-rij
(`enterComments`, een deterministisch ankerpunt — mirror van hoe `enterRelated`
altijd op het eerste kind landt); open maar de keyboard zit elders (diff/
Onderliggende code) → highlight terug naar die rij, blijft open; open én de
keyboard zit al in de sidebar (composer/comment-rij/thread/taak) → sluiten,
keyboard terug naar de diff. **`enterComments` opent bewust nog niet de
composer/focust nog geen textarea** (anders dan `toNew`, dat
`startComment`/arrow-navigatie naar rij 0/de restore-flow nog wél gebruiken) —
alleen highlighten, zodat een **tweede `g`** de sidebar meteen weer
dichtklapt i.p.v. dat de toets als een letterlijke "g" in het al-gefocuste
tekstveld belandt (de `isEditableFocused`-guard zou 'm anders opeten). Pas
**`Enter`** op die gehighlighte rij (`isNewFocused()` + `openComposer()` in
`home.mjs`, mirror van de `isCommentFocused`/`isCodeFocused`/
`isTaskFocused`-Enter-branches) opent de composer echt en focust de textarea.
Zichtbaarheid leeft in een eigen, **efemere** vlag `cs.sidebarOpen` (niet in de
URL — net als `state.showDescription` — een refresh start altijd
dichtgeklapt), losgekoppeld van `cs.focus`: de sidebar kan open blijven staan
terwijl de diff de keyboard heeft (na `←`, zie hieronder). Een klik op de
collapsed hint-rail (zie hieronder) volgt dezelfde open+focus-logica als `g`
(`openSidebar`).

**`g`-uit → `g`-terug herstelt binnen dezelfde sessie de laatste
comment-/thread-rij** (niet enkel "open op rij 0"). Elke keer dat de sidebar de
keyboard verlaat via `exitRelated` (`←` vanuit de sidebar, of de sluitende
`g`-tak hierboven) en `cs.focus` op dat moment `'new'`/`'comment'`/`'thread'`
was, snapshot't `exitRelated` dat in de module-`let` `lastSidebarFocus`
(`{focus, sel, threadPos}` — bewust **niet** `'code'` of `'task'`, en bewust
**niet** op `cs`/in de URL: dit is een puur binnen-sessie geheugen, geen
navigatiepositie-restore — die bestaat al apart voor `cs.focus`/`sel`/
`threadPos` via de `rel`-URL-namespace, en `cs.sidebarOpen` zelf blijft
gewoon buiten de URL, dus een refresh start nog altijd dichtgeklapt). Een
volgende `openSidebar` (`g`, of een klik op de hint-rail) roept
`restoreLastSidebarFocus` aan: was de laatste plek een comment-rij of een
thread, dan landt de keyboard daar weer (rij-index geklemd op de actueel
zichtbare comment-lijst, `threadPos` geklemd op de thread-lengte — mirror van
`applyRelRestore`'s clamping); was de laatste plek de composer-rij zelf, of
bestaat er nog geen herinnering, of is de onthouden comment/thread niet meer
zichtbaar (verwijderd, of de reviewer zit inmiddels op een ander block/unit
waarvan de comment-scope leeg is), dan valt het terug op de bestaande
`enterComments()`-landing (rij 0, alleen highlighten). Mirrort het
`preTaskFocus`-patroon. Test: `tests/sidebar-focus-restore.spec.mjs`.

**Dichtgeklapt** (`!cs.sidebarOpen`) rendert de sidebar als een smalle
hint-rail op de rechterrand (`data-testid=sidebar-collapsed`, `right-0 w-12`,
klikbaar): twee getallen, een spraakbel-icoon met het **aantal comments**
(`visibleComments().length` — gescoped op het geselecteerde block/de
navigatie-unit, dezelfde scope als de comment-index zelf) en een klok-icoon
met het **aantal actieve (draaiende/wachtende) taken**
(`runningTaskCount(state)`, dezelfde `running`/`waiting`-filter als
`taskRuns`). Puur een hint — geen eigen klik-acties per getal, alleen de hele
rail is klikbaar.

**`<main>` reserveert een reactieve rechter-marge om niet achter de rail/
sidebar te verdwijnen.** Beide zijn losse `position:fixed`-overlays met een
**hogere** z-index dan `<main>` (`z-20` vs. `<main>`'s `z-10`), dus zonder marge
zou `<main>`'s meest-rechtse kolom (de Onderliggende-code-kaart, of de
meest-rechtse gedrilde kolom) er zichtbaar achter/onder verdwijnen zodra je
`<main>` volledig naar rechts scrolt — `<main>`'s eigen `overflow-x-auto` clipt
toch niets voorbij zijn eigen rechterrand, dus wat je ziet blijft altijd binnen
die rand. `DetailPanel`'s class-binding (`home.mjs`) leest daarvoor
`sidebarOpen()` (geëxporteerd uit `RelatedPanel.mjs`, een dunne lezer op
`cs.sidebarOpen` — `cs` is module-privé, dus `home.mjs` kan het niet direct
lezen, hetzelfde patroon als `isCodeFocused`/`relatedActive`) in dezelfde
functie-binding als de bestaande `state.showDescription`-ternary voor de
linker-marge: dicht (de rail, `right-0 w-12` = 3rem) → `right-[4.5rem]`; open
(`right-6 w-[36rem]`, dus de linkerrand van de sidebar ligt op `1.5rem + 36rem
= 37.5rem`) → `right-[39rem]`. Beide tellen er bovenop nog 1.5rem
ademruimte bij — dezelfde gap-conventie als de PR-info-kolom-marge
(`left-[56.5rem]` = 26rem + 1.5rem, zie boven). Omdat de klasse-string één
geheel blijft (geen deel-interpolatie) en dit een gewone attribute-function-
binding is (geen keyed array-item), is hier geen arrow.js-valkuil uit
`conventions.md` van toepassing.

**Toetsenbord binnen de sidebar:** comments is een platte rij-lijst (de lege
composer op rij 0, dan één rij per comment — zie `rowCount`/`currentRow`/
`gotoRow` in `RelatedPanel.mjs`), taken een eigen rij-lijst
(`cs.taskSel`/`taskRuns`). **`↓`/`↑` lopen binnen zo'n lijst, en kruisen ook
ertussen** — het gestapelde-layout-equivalent van wat vroeger `→`/`←` deed
tussen comments en Taken: `↓` op de laatste comment-rij (of de lege composer
als er geen comments zijn), of op de onderkant van een geopende thread
(`threadPos === 0`, het reply-veld), daalt af naar de eerste taak-rij; `↑` op
de eerste taak-rij klimt terug naar waar hij vandaan kwam
(`preTaskFocus`/`toTask` — de composer, een comment-rij, of dezelfde thread).
`→` op een comment-rij gaat nog steeds dieper de thread in
(`enterThread`, ongewijzigd); binnen een thread lopen `↑`/`↓` nog steeds door
de berichten-historie (`threadPos`), niet tussen comments/taken — alleen de
**onderkant** van de thread (`threadPos === 0`) daalt verder af naar taken.
**`←` sluit **geen** kolom en pelt **niets** laag voor laag terug** — vanuit
**elke** plek in de sidebar (comment-rij, thread, taak) gaat `←` in **één
klap** terug naar de diff van het laatst-actieve blok/kolom
(`state.focusLevel` blijft ongewijzigd), en de **sidebar blijft open** (alleen
de keyboard-focus verlaat 'm, `cs.sidebarOpen` blijft `true`) — dit vervangt
het oudere stap-voor-stap-patroon (`toComment`/`toCode` als tussenstap) volledig
voor dit pad.

Het **taken-blok** (`<section data-testid=workflows-panel>`, titel **"Taken"**)
toont de **workflow-runs van de huidige PR** (`state.workflows`, gevuld door
`pollWorkflows` in `home.mjs` via `GET /api/workflows?pr=N`, elke 2.5s). Dat
endpoint is **read-only** (`RunsForPR` in `tasks_api.go` filtert
`engine.Runs()` op het `pr`-veld in elke run's opgeslagen input — geen mutatie,
dus binnen de write-boundary), niet te verwarren met het bestaande, ongerelateerde
placeholder-blok `data-testid=tasks` (Taken + chat) *binnen* het comment-blok. De
kaart splitst **actief** (`running`/`waiting`, bovenaan, vol) van **recent klaar**
(`completed`/`failed`, eronder, gedimd) onder de kopjes "Actief"/"Recent"; elke rij
toont een leesbaar workflow-label (`WORKFLOW_LABELS` in `RelatedPanel.mjs`, b.v.
`build_relations`→"Relaties") plus een kleur-gecodeerde status-badge (amber/
blauw/groen/rood). De rij-key codeert **runId + status** (niet alleen runId) zodat
een statuswissel (b.v. `running`→`completed`) een **verse** node forceert i.p.v.
een keyed node te hergebruiken zonder zijn statische classes te herevalueren —
dezelfde valkuil als de block-kaart-key, zie `.claude/rules/conventions.md`. De
lege staat wikkelt in een array-van-één (`.key('no-workflows')`), conform de
"no comments"-valkuil in diezelfde conventions-regel.

Elke rij toont onder het label + de status-badge ook een korte **omschrijving**
(`data-testid=workflow-note`, grijs, `line-clamp-2`, `workflowNote` in
`RelatedPanel.mjs`): voor een `task_code_comment`-run de rijke
`class::method · regel N · "snippet"` uit de run's meegestuurde `comment`-ref
(`WorkflowRunView.comment`, zie `.claude/rules/tembed-workflows.md`); voor elk
ander type een korte Nederlandse zin die uitlegt *waarom* de run in die status
zit (`WORKFLOW_STATUS_NOTE`, een `${workflow}:${status}`-map, b.v.
`resolve_call:running` → "zoekt call-definities"), met de kale status als
fallback wanneer geen combinatie matcht. **De tekst mag nooit actieve arbeid
suggereren terwijl de badge "wacht" toont** — `build_relations` draait zijn
build-Activity één keer synchroon bij start en wacht daarna eindeloos op een
`rebuild`-Signal (zie `.claude/rules/tembed-workflows.md`), dus `waiting`
betekent daar altijd "al gebouwd, idle tot de volgende rebuild", nooit "bezig".
`workflowNote` vervangt de generieke tekst voor die combinatie daarom door een
concrete samenvatting van wat er al is opgebouwd (`buildRelationsSummary`,
gelezen uit `state.relations`/`state.callResolve`/`state.testCovers` — dezelfde
arrays die de rest van het paneel al bijhoudt, geen extra fetch), b.v. "3
relaties · 5 calls opgelost — wacht op wijzigingen"; zonder bruikbare data valt
hij terug op de statische `WORKFLOW_STATUS_NOTE`-tekst. Onder de omschrijving
staat een tweede, nog kleinere regel (`data-testid=workflow-updated`,
`relTime(run.updatedAt)`) met een relatieve Nederlandse tijdsaanduiding ("net
nu" / "4 min geleden" / "2 uur geleden" / "1 dag geleden") — `updatedAt` komt al
mee in `GET /api/workflows` (`WorkflowRunView.UpdatedAt`, `tasks_api.go`), dus
dit is een pure frontend-toevoeging zonder backend-wijziging.

Een run met een `comment`-ref is **klikbaar** (`cursor-pointer`, de rest is
puur informatief): de klik roept `openTask(run)` aan, een callback die
`home.mjs` aan `CommentsSidebar(state, commentTarget, openCompose, openTask)`
meegeeft (los van `search.drill`, dat alleen nog naar het `RelatedPanel`-default-
export/Onderliggende-code-kaart gaat — zie hieronder). `openTask` (in
`home.mjs`) zoekt het block in `state.blocks` op `comment.file`+`comment.label`,
selecteert het, stapt de diff in op de opgeslagen granulariteit/rij-range
(`unitsFor`+`unitAtRow`, dezelfde walk als `setGran`), en selecteert tot slot de
comment zelf via `selectComment(runId)` (geëxporteerd uit `RelatedPanel.mjs` —
`runId` == de comment's id) zodra de comment-scope-watch heeft kunnen bijtrekken
(een paar `await Promise.resolve()`-ticks, nodig omdat arrow.js' `watch`
microtask-gedeferred draait — zie de watch-timing in `conventions.md`). Faalt
een stap (block/comment nog niet gevonden) dan doet `openTask` stil niets. Dit
opent/focust de sidebar zelf niet expliciet — het wordt alleen aangeroepen
vanuit een klik/`Enter` op een al-zichtbare taken-rij, dus de sidebar staat op
dat moment al open.

**Toetsenbord binnen Taken:** `cs.focus === 'task'` geeft de Taken-kaart de
keyboard — bereikt via `↓` vanuit comments (zie "Comments/taken-sidebar"
hierboven voor de volledige kruis-navigatie), niet meer via `→`/stop 7 van de
oude nav-keten. `↓`/`↑` lopen `cs.taskSel` door de **actief-dan-klaar**-
volgorde (`taskRuns(state)`, exported uit `RelatedPanel.mjs` — dezelfde volgorde
als `workflowsSection` rendert, dus rij-index en keyboard-cursor komen altijd
overeen); de gefocuste rij krijgt een indigo ring (`data-active=true` op
`data-testid=workflow-row`). `↑` op de eerste rij klimt terug naar waar `↓`
vandaan kwam (`preTaskFocus` in `RelatedPanel.mjs`: de composer, een
comment-rij, of dezelfde thread) — terug naar de **composer** highlight't dat
alleen de "+ Comment op deze regel"-rij (`enterComments`, net als een vers
`g`-open), zonder 'm meteen te openen/focussen; pas een expliciete `Enter`
(`isNewFocused`+`openComposer`, `home.mjs`) opent 'm. Terug naar een
**comment-rij**/**thread** focust nog steeds meteen het reply-veld, zoals de
gewone rij-navigatie binnen comments dat altijd al doet. `←` sluit de
sidebar-focus in één klap
richting de diff (zie hierboven), ongeacht `preTaskFocus`. `Enter`
(afgehandeld in `home.mjs`, niet in `RelatedPanel.mjs` — `openTask` leeft daar
omdat het de gedeelde navigatie-`state` aanstuurt) opent de gefocuste run net als
een klik erop; alleen zinvol voor een `task_code_comment`-run met een gekoppelde
comment, stil genegeerd voor de rest (zelfde `run.comment`-guard als de klik).
Een klik op een niet-klikbare rij landt de keyboard-cursor er nu ook op
(`toTask(i)`), zodat muis en toetsenbord dezelfde cursor delen.

## Drillen: Onderliggende code als eigen kolom (`state.drill`)

`Enter` op een **resolved** kind in de Onderliggende-code-kaart (een relatie-child
of een opgeloste method-call — zie `isCodeFocused`/`focusedRelatedChild` in
`RelatedPanel.mjs`) **of een muisklik op dat kind** (`@click` op
`data-testid=related-item`, via de `drill`-callback die `home.mjs` als optie aan
`RelatedPanel` meegeeft) opent dat kind als een volwaardige diff-kolom rechts naast
de bestaande kolommen (tussen de diff en `RelatedPanel`), i.p.v. alleen de platte
code-excerpt te tonen. Klik en Enter lopen allebei via dezelfde
`drillIntoChild(child)`. `home.mjs` houdt daarvoor een **stack** bij, `state.drill`:
elke `drillIntoChild(child)` (aangeroepen vanuit de `Enter`-tak in `onKeydown` —
Enter op een gefocust kind drilt, onopgeloste calls zoeken vanzelf zonder Enter —
of vanuit de klik-callback) pusht er één entry op **plus** een bijbehorende cursor-entry op
`state.drillCursor` (`{change:0}`), en zet `state.focusLevel` op dat verse
(diepste) niveau. Anders dan eerder **sluit** niets van dit meer automatisch: elke
gedrilde kolom blijft open zolang de diff-sessie duurt (zie "Kolom-navigatie"
hieronder voor hoe je 'm weer verlaat).

Een drill-entry is **één van twee vormen**:
- **Een echt PR-block** — zit het kind al in `state.allBlocks` (een relatie-child,
  of de definitie van een resolved method-call die zelf in deze PR wijzigt), dan
  wordt dát bestaande block-object hergebruikt (geen kopie): het draagt al
  `code`/`approvedRows`/etc., en `relatedChildren`/`resolvedCallChildren`/`callRows`
  werken generiek op elk block-id — dus dit kind krijgt **out-of-the-box** zijn
  eigen volledige, navigeerbare Onderliggende-code-paneel (recursie werkt gratis).
- **Een synthetisch frame** — een resolved method-call naar een bestand dat de PR
  niet wijzigt (geen PR-block, dus niets om te hergebruiken): een minimaal object
  (`{ id, label, file, class, name, status:'unchanged', code:null, synthetic:true }`
  — `unchanged`, want de PR raakt dit bestand niet, dus old === new en de diff is
  volledig gelijk; een `modified`-badge zou hier misleidend zijn,
  class/name gesplitst uit `child.label` op `::`), waarvan `ensureCode` de oud/nieuw-
  broncode ophaalt zoals voor elk ander block. Dit niveau toont **alleen** zijn diff
  — geen eigen Onderliggende-code-kaart (geen caller-scan ooit gedraaid voor een
  synthetisch frame).

## Kolom-navigatie: `state.focusLevel` (elke gedrilde kolom is een volwaardige diff)

Anders dan het "altijd het diepste niveau"-model van eerder is **elke** kolom —
de oorspronkelijke top-level block-kaart én elke gedrilde kolom — een volwaardige,
navigeerbare diff met zijn **eigen** change-group-cursor. `state.focusLevel` wijst
aan welke kolom de pijltjestoetsen op dit moment bezit: `0` is de top-level
geselecteerde block (die blijft `state.change`/`state.gran` gebruiken, zoals
altijd), `1..state.drill.length` indexeert `state.drill[level-1]` met zijn eigen
cursor in `state.drillCursor[level-1]` (`{change, gran}`, een spiegeling van
`state.change`/`state.gran`). Een gedrilde kolom zoomt dus **wél** met `f`/`d`/`s`
(group → line → call, exact dezelfde `setGran`-logica als het top-level block,
maar dan als `setDrillGran(level, delta)` op zijn eigen `drillCursor`-entry) —
alleen stroomt hij niet door naar een same-file buurblock aan de randen van zijn
change-lijst: het blijft een op zichzelf staande diff, dus op de eerste/laatste
unit (ook op `call`-niveau) stopt de navigatie binnen de kolom in plaats van
naar een ander block te springen (`drillNextChange`/`drillPrevChange` klemmen op
de units van `cursor.gran`, i.p.v. `sameFileNeighbour`/`stepBlock` zoals
`nextChange`/`prevChange` dat voor niveau 0 doen). `fKey`/`dKey`/`sKey` in
`home.mjs` vertakken op `state.focusLevel`: `> 0` bewerkt de drillCursor-entry
van dat niveau, `0` bewerkt zoals altijd `state.gran`/`state.change`.

- **Direct na het drillen staat de focus op de diff van de nieuwe kolom** —
  niet op zijn Onderliggende-code-paneel. `drillIntoChild` roept daarvoor
  `leaveRelated()` (de geëxporteerde `exitRelated` uit `RelatedPanel.mjs`) aan
  i.p.v. het vroegere `enterRelated()`: de reviewer landt op de eerste
  wijzigingsgroep van de nieuwe kolom en loopt daar met `↑`/`↓` doorheen
  (`drillNextChange`/`drillPrevChange` in `home.mjs`).
- **De gedrilde kolom hergebruikt exact dezelfde diff-render als de top-level
  block-kaart** — beide roepen dezelfde `Block(b, {...})` uit `Block.mjs` aan
  (rood/groen, char-diff, filler-uitlijning zijn dus identiek). Wat ontbrak was
  de **scroll-naar-de-actieve-wijziging**: bij een grote functie landde de
  reviewer boven aan de functie-body, met de daadwerkelijke (correct gekleurde)
  diff-hunk buiten beeld gescrold — wat oogt als "geen diff-opmaak" terwijl de
  opmaak er wél is, alleen niet zichtbaar. `drillIntoChild` roept daarom na het
  pushen van de kolom ook `scrollChangeIntoView(false)` aan (voor het cached
  geval — een synthetisch frame of een child wiens code al eerder geladen werd
  voor het Onderliggende-code-paneel); `ensureCode` doet hetzelfde zodra de code
  van een **nog niet eerder geladen** gedrilde/gefocuste child alsnog arriveert
  (mirror van de bestaande top-level-branch: `state.drill[state.focusLevel - 1]
  === b`). Zie `.claude/rules/keyboard-navigation.md` voor `scrollChangeIntoView`.
- **`←` sluit de gefocuste gedrilde kolom** en zet de focus terug op de diff van
  de **parent-kolom** — de vorige gedrilde kolom, of (vanaf niveau 1) het
  oorspronkelijke top-level block. Het gesloten kind verschijnt daarmee vanzelf
  weer in de Onderliggende-code-lijst van die parent-kolom (die lijst wordt
  gedreven door `focusedBlock()` via de `setRelated`-watch, dus dat herstelt
  zonder extra code zodra `focusLevel` daalt). Herhaald `←` pelt zo niveau voor
  niveau terug tot je weer op het top-level block staat.
- **Pas als je al op niveau `0` staat (het top-level block), sluit `←` de héle
  diff-sessie** — de bestaande diff→list-overgang (`state.mode='list'`) — en dán
  worden `state.drill`/`state.drillCursor` ook leeggemaakt: gedrilde kolommen
  hebben alleen betekenis binnen déze diff-sessie.
- **`→` opent nog steeds het Onderliggende-code-paneel** van de kolom die op dat
  moment de focus heeft (`enterRelated()`, ongewijzigd) — dat is nog altijd de
  enige weg om **dieper** te drillen (Enter/klik op een kind daarin).
- Vanuit het paneel (`relatedActive()`) geeft `←`/`Escape` op de eerste positie
  de focus terug aan de diff van **diezelfde** kolom (`handleRelatedKey`'s
  `exitRelated`) — dat sluit geen kolom meer; de kolom-voor-kolom-navigatie
  hierboven is een aparte stap die pas volgt zodra `relatedActive()` weer `false`
  is.

**Geen flicker bij een gran/change-stap binnen een gefocuste gedrilde kolom:**
de buitenste `${() => state.drill.map(...)}`-binding die de kolommen bouwt
abonneert bewust **niet** op `state.drillCursor` (alleen op `state.codeVersion`
en `state.focusLevel`, die de `.key(...)` van een kolom laten omklappen — zie
hieronder). Zou die buitenste closure ook op `drillCursor` lezen, dan herbouwt
elke `f`/`d`/`s`/`↑`/`↓`-stap **alle** open gedrilde kolommen (elke `Block()`-call
opnieuw, dus Prism-highlighting opnieuw over elke kolom heen) — exact dezelfde
valkuil als `canStep()` voor de top-level kaart (zie `stepChevronSlot` in
`home.mjs` en de conventions.md-notitie erover). De `state.drillCursor[i]`-lezing
die er wél toe doet zit in de `activeGroup`/`hintsEnabled`/`diffActive`-functies
die aan `Block(b, {...})` worden meegegeven: dat zijn zelf al reactieve
arrow.js-bindings (ze worden pas aangeroepen ván binnen `Block`'s eigen
`${…}`-slots), dus die herevalueren op hun eigen dependency zonder de kolom te
herbouwen — precies zoals `state.change`/`state.gran` dat al deden voor de
top-level kaart.

`focusedBlock()` (het Onderliggende-code-paneel + taken/chat) volgt nu
`state.focusLevel` in plaats van altijd het diepste niveau: `state.focusLevel ===
0 ? curBlock() : state.drill[state.focusLevel - 1]`. Stap je met `←` een kolom
terug, dan schuift het paneel dus mee naar díe kolom. Er is nog altijd precies één
`RelatedPanel`-instantie (`cs`/`rc` blijven singletons).

De kolom-`.key` codeert (naast positie in de stack + code-status
`load`/`code`/`err`) ook of de kolom **op dit moment de focus heeft**
(`foc`/`unfoc`) — net als de bestaande `sel`/`prev`-key op de top-level kaart —
zodat een focus-wissel altijd een verse kaart (verse `${…}`-bindings) forceert in
plaats van dat arrow.js de bestaande node hergebruikt (zie de valkuil in
`.claude/rules/conventions.md`). Een nieuwe kolom scrollt zichzelf in beeld
(`scrollFocusIntoView`, `<main>` scrolt horizontaal) — altijd **links**
uitgelijnd (`inline:'start'`, ook voor een gedrilde kolom, niet alleen de
top-level kaart), zodat de kolommen waar je vandaan komt links buiten beeld
verdwijnen i.p.v. de nieuwe kolom aan de rechterkant te proppen; dezelfde
functie scrollt ook bij het terugstappen de nu-gefocuste kolom links uit, én
bij het verlaten van het `RelatedPanel` terug naar de diff (`onKeydown`'s
`relatedActive()`-tak in `home.mjs` roept 'm aan zodra `handleRelatedKey` de
panel-focus heeft losgelaten) — de panel-navigatie scrollt `<main>` horizontaal
opzij (`scrollIntoView` in `toTask`/`toComment` e.d.), en zonder deze
her-uitlijning bleef de diff-kaart na `→…→` dan `←…←` links buiten beeld
afgesneden staan. Elke
**gefocuste** gedrilde kolom (`state.focusLevel > 0`) toont daarbij een kleine
grijze **‹-chevron aan zijn linkerrand** (`data-testid=drill-left-hint`, buiten
de kaart, verticaal gecentreerd) als visuele hint dat er kolommen links buiten
beeld zitten — puur een cue, geen eigen klik-actie (`←` doet het echte
terugstappen). De chevron zit in de kolom-`.key` verdisconteerd via de
bestaande `foc`/`unfoc`-component, dus hij verschijnt/verdwijnt met een verse
kaart i.p.v. een hergebruikte node.

**Niet-gefocuste kolommen klappen in tot een smalle rail** — zodra
`state.focusLevel` op een gedrilde kolom staat (dus `state.drill.length > 0`),
heeft élke kolom die niet die focus heeft (de top-level block-kaart bij
`focusLevel > 0`, én elke gedrilde kolom vóór de gefocuste — nooit erna, want
`focusLevel` is altijd `state.drill.length`, dus de gefocuste kolom is altijd de
meest rechtse) geen zin meer om op volle diff-breedte te tonen: er valt niets te
reviewen op een kolom die de pijltjestoetsen niet bezit, en de ruimte kan naar de
kolom die ze wél bezit. `collapsedColumnHTML(b, level, testid, drillIdx)`
(`home.mjs`) rendert die kolom dan als een smalle knop (`w-14`, volle hoogte via
de bestaande flex-stretch van `<main>`, geen losse CSS nodig) met een pijl-icoon
+ een verticaal afgekapt label (`b.label`'s laatste `::`-segment, dus de
methode-/classnaam) — stijl geleend van `RelatedPanel.mjs`'s
`sidebarHintRail`. Testids: `data-testid=block-collapsed` (top-level) resp.
`data-testid=drill-collapsed` + `data-drill-idx` (gedrilde kolom, mirror van de
bestaande `drill-column`/`data-drill-idx`). Klikken roept **`expandColumn(level)`**
aan: functioneel identiek aan `←` herhaald indrukken tot je op dat niveau staat
— `state.drill`/`state.drillCursor` worden afgekapt tot `level` en
`state.focusLevel = level`, dus alles wat verder gedrild was dan het geklikte
niveau wordt weggegooid (bewust dezelfde semantiek als de bestaande `←`-pop, niet
een "laat het kind openstaan maar verberg 'm"-variant — dat zou het
single-focus-eigenaar-model van deze sectie breken). Beide render-plekken
vertakken hierop met **gewone JS-if's binnen hun bestaande, al-op-`focusLevel`-
geabonneerde bindingen** (de top-level `${() => {...}}`-slot in `block-column`,
en de per-item `.map()`-callback in de gedrilde-kolommenlijst) — geen nieuwe
geneste reactieve slot, dus geen nieuwe keyed-node-valkuil: de top-level slot
blijft een array retourneren (`[collapsedColumnHTML(...).key(...)]`, nooit een
los element — de single↔array-valkuil in `conventions.md`), en de gedrilde-
kolommenlijst rebuildt sowieso al bij elke `focusLevel`-wissel (de bestaande
`foc`/`unfoc`-key), dus de rail-vs-kaart-keuze daar hoeft geen eigen key-trigger.
Zie `tests/drill-collapse.spec.mjs` (één en twee niveaus diep).

De block-kaart-`.key(...)` codeert **rol** (`sel`/`prev`) **én code-status**
(`load`/`code`/`err`), zodat arrow.js een **verse** kaart bouwt zodra een block
van preview→geselecteerd gaat (↓/↑ op een al gepreviewd block) of z'n code
arriveert. Zonder die twee sleutel-onderdelen hergebruikt arrow.js de keyed node
(move+patch) zónder de `${…}`-bindings te herdraaien: de `activeGroup`-highlight
+ scroll bleven dan bevroren op de vorige selectie, en de `null→geladen`-diff-
render viel intermitterend uit (kaart bleef op "loading" hangen). Het "code
gearriveerd"-signaal loopt via `state.codeVersion` (gebumpt in `ensureCode`),
waarop **de DetailPanel-binding** abonneert zodat hij herdraait en de key omklapt
(verse diff-binding). De `setCommentScope`/`setRelated`-watches blijven
`curBlock().code` lezen (nodig om de cursor te volgen) — juist hun co-subscriptie
op `b.code` is waarom de diff-binding de update kan missen, dus herbouwen we via
de key i.p.v. nóg een `b.code`-lezer toe te voegen. Zie de arrow.js-valkuilen in
`.claude/rules/conventions.md`.

**Een gewone `state.change`-stap binnen hetzelfde block mag deze kaart-key niet
laten omklappen** (die zou anders een verse `Block()`-aanroep — en dus een
zichtbare flikkering over de hele kaart — forceren bij élke ↑/↓). Het
grijze step-chevron (`stepChevronSlot`/`canStep` verderop) leest zelf
`state.change`, maar zit daarom in zijn **eigen** geneste `${() => …}`-slot i.p.v.
rechtstreeks in de outer array-bouwende closure van `DetailPanel` — anders lekt
die lezing naar de hele closure en herbouwt elke stap alle `Block()`-kaarten met
verse `activeGroup`/`hintsEnabled`/etc.-closures. Zie de bijbehorende
arrow.js-valkuil in `.claude/rules/conventions.md`. Dat geneste slot zit
bovendien in een **stabiele element-root** (een `<div>` met een statische
`contents`-class) — niet als kale keyed `${…}`-wrapper: die liet de
chunk-`ref` stale gaan zodra het chevron toggelde en corrumpeerde daarmee de
keyed reconcile van de block-kolom (de look-ahead-preview verdween en de tab
bevroor bij herhaald ↓/↑ door same-file blocks) — zie de "kale toggelende
expressie"-valkuil in `.claude/rules/conventions.md` en
`tests/step-preview-stability.spec.mjs`.

`RelatedPanel` is **puur placeholder met dummy data** — nog geen `/api`-koppeling.
Twee naast elkaar liggende kaarten (Onderliggende code links, comment-blok
rechts — zie de layout-alinea hierboven):

- **Onderliggende code** (boven, `data-testid=related-code`): de **child-blokken**
  van het geselecteerde block — de blokken waaraan het gekoppeld is (nu: de
  `Listener::handle` van een event dat het dispatcht). Elk als kleine
  Prism-highlighted PHP-excerpt (`data-testid=related-item`). Een listener-child
  draagt een `listener`-`kind`-badge; een **methode-aanroep** heeft géén woord-badge
  maar een **diff-stat** (`data-testid=related-diffstat`): `+A −R` (groen/rood, het
  aantal toegevoegde/verwijderde regels van de aangeroepen definitie, geteld met
  `diffStat` in `Block.mjs`, git-`--stat`-stijl), of een grijze **`Ongewijzigd`**-badge
  als de aanroep naar een bestand wijst dat de PR niet wijzigt (geen diff → `r.diff`
  is `null`). Zo'n ongewijzigd child krijgt bij selectie bovendien een **grijze**
  ring i.p.v. de indigo ring — er valt niets te reviewen.
  Gevoed uit het relations-read-model via `GET /api/relations?pr=N`; `home.mjs`
  (`childrenOf`/`relatedChildren`) haalt de children uit `state.allBlocks` en laadt
  hun code lazy. Een child wordt **uit de linkerlijst gehaald** en hier getoond;
  wat overblijft staat links. `recomputeLeftList` in `home.mjs` bepaalt de
  linkerlijst: `state.blocks` = `allBlocks` minus (a) alle relation-`childId`s én
  (b) elk **PR-blok dat de definitie is van een resolved/found method-call**
  (`resolvedCallTargetIds`) — dus een functie die als "Onderliggende code" onder
  een parent verschijnt (b.v. `ProcessCartAction::buildShippingAddressAttributes`
  aangeroepen op een gewijzigde regel) staat níét óók nog los in de linkerlijst.
  Het draait bij `loadBlocks` én opnieuw na elke `loadCallResolve` (initieel +
  de poll na een zoekactie), en bewaart de selectie op **block-id** zodat een
  callResolve-reload de cursor niet verspringt.
  Zie `.claude/rules/tembed-workflows.md` (sectie "Relaties tussen blokken").
  **"code laden…" vs. "geen code gevonden":** elke child-descriptor draagt een
  `loading`-vlag (gezet in `home.mjs`, dus in de `setRelated`-watch-keten — nooit
  door `RelatedPanel` zelf `b.code` te laten lezen): voor een **lazy** PR-blok-
  child (relatie-child/`covered_by`) is dat `!kid.code` — `ensureCode` zet
  `kid.code` altijd op een object zodra de `/api/code`-fetch afrondt, óók bij
  een fout (`{error}`) — voor een **embedded**-code child
  (`method_call`/`covers`, code zit synchroon in de callresolve/testcovers-rij)
  hard `false`. `relatedCard` rendert daarop drie-weg: code → excerpt; leeg +
  `loading` → "code laden…"; leeg + niet-loading (afgeronde load die leeg/error
  bleek, of een lege embedded `childCode`) → de eind-staat **"geen code
  gevonden"** (`data-testid=related-empty`, zelfde grijze stijl). De item-key
  codeert die staat mee (`related:<id>:code|load|empty`) — het block-kaart-
  precedent uit `conventions.md`, anders kan de laden→code/leeg-transitie op
  een hergebruikte keyed node bevriezen. Regressietest:
  `tests/related-empty-code.spec.mjs` (PR 96, embedded leeg; PR 90, lazy load
  die leeg afrondt).
  De kaart is een **navigeerbare lijst**: `→` vanuit de diff selecteert het
  **eerste** blokje (`cs.codeSel=0`); `↓`/`↑` lopen daarna langs de blokjes
  (klemt op het eerste/laatste — `↑` op het eerste blokje stapt terug uit naar
  de diff), `←` stapt vanaf elk blokje terug naar de diff (zie
  `.claude/rules/keyboard-navigation.md`). Deze lijst is volledig **losstaand**
  van de comments/taken-sidebar (zie hierboven) — er is geen `→`/`↓` meer die
  hiervandaan naar comments/taken springt; dat gaat alleen nog via `g`. Het
  geselecteerde blokje krijgt een indigo ring (`data-active=true`). Alle
  blokjes staan **verticaal onder elkaar** op volle breedte (geen
  pijltjes-hint meer — die is verwijderd); de kaart klapt niet meer in om
  ruimte te maken náást de comments/taken-kolommen (dat gebeurde vroeger toen
  die nog in dezelfde kolom-flow zaten — nu overbodig, ze zijn een los,
  `position:fixed` overlay, zie "Comments/taken-sidebar" hieronder).

  **Laptop-breedte auto-inklap naast een open comments/taken-sidebar
  (`relatedRailActive`/`relatedRail`, `RelatedPanel.mjs`):** die sidebar is wél
  een los overlay, maar concurreert nog steeds om horizontale ruimte zodra het
  scherm te smal is om beide comfortabel naast elkaar te tonen. Onder
  Tailwind's `2xl`-breakpoint (1536px — hetzelfde punt dat de rest van de
  laag al gebruikt voor breedteschaling, bv. `Block.mjs`'s
  `w-[70rem] 2xl:w-[82rem]`) klapt de kaart daarom in tot een smalle rail
  (`data-testid=related-collapsed`, mirror van `collapsedColumnHTML`/
  `sidebarHintRail`: icoon + verticaal label + het aantal kinderen) zodra
  **twee** condities gelden: de sidebar staat open (`sidebarOpen()`) én de
  kaart bezit op dat moment niet de keyboard (`cs.focus !== 'code'`) — die
  laatste voorwaarde mirrort de bestaande regel voor gedrilde kolommen
  (`collapsedColumnHTML`, home.mjs): alleen wat de keyboard bezit blijft vol
  zichtbaar. Dat garandeert dat `→` (`enterRelated`, zet `cs.focus = 'code'`)
  altijd op de volledig uitgeklapte, navigeerbare kaart landt — nooit op
  verborgen inhoud. Verlaat je de kaart weer (`←`, `cs.focus = null`) dan
  klapt hij, zolang de sidebar nog open staat en het scherm smal is, gewoon
  weer in. Een klik op de rail roept `enterRelated()` rechtstreeks aan — de
  kaart klapt zo meteen weer uit en pakt de keyboard, net als een verse `→`
  vanuit de diff. Op een `2xl`+-scherm, of zolang de sidebar dicht is, blijft
  de kaart altijd de volledige `w-[34rem] 2xl:w-[41rem]`-kaart; `viewport.wide` (een
  `matchMedia('(min-width: 1536px)')`-listener, mirror van `theme.mjs`'s
  systeem-preference-listener) houdt dat reactief bij, ook op een resize. De
  toggle tussen rail en volledige kaart zit — conform de "kale toggelende
  expressie"-valkuil in `conventions.md` — in een **stabiele element-root**
  (`<div class="contents" data-testid=related-panel-root">`), niet in de hele
  body van de template zelf. Zie `tests/related-code-narrow.spec.mjs`.
  De kaart heeft **geen vaste hoogte-cap**: hij groeit met zijn inhoud mee tot
  de volle beschikbare hoogte van de block-kolom en scrollt dan intern
  (`min-h-0`, body `flex-1 overflow-auto`). De code-excerpts **wrappen** (geen
  horizontale scroll: `whitespace-pre-wrap break-words`).
  Elke child die zelf een PR-block is (relatie-child of een method-call wiens
  definitie in de PR wijzigt) draagt een **goedkeurings-badge**
  (`data-testid=related-approval`, `done/total`, groen + ✓ bij volledig
  goedgekeurd), en de kaart-header toont een **rollup** over de getoonde children
  (`data-testid=related-approval-total`, "… · X/Y goedgekeurd"). Een aanroep naar
  een ongewijzigd bestand heeft geen goedkeurings-concept en dus geen badge. De
  counts komen mee in de child-descriptor (`approve`, gevuld door
  `relatedChildren`/`resolvedCallChildren` in `home.mjs` via `blockApproveCount`);
  dezelfde rollup zit als combinatie-pill op de sidebar-rij — zie de
  gecombineerde-goedkeuring-uitleg in `.claude/rules/blocks-and-ingest.md`.
  **Drill-hint-chips (streepje naar rechts, recursieve mini-boom):** elk kind
  waarvan het blok **zélf** nog gewijzigde onderliggende code heeft, toont
  rechts van zijn kaart een kort **gestippeld streepje** naar een smalle
  chip-kolom (`data-testid=related-nested`, `w-36`): per gewijzigd
  (achter)kleinkind één chip (`data-testid=related-nested-chip`) met het
  **volledige `class::method`-label** (kale naam als er geen class is — de
  gedeelde `blockLabel`-helper in `Block.mjs`, "class::method overal"), een
  eigen **diffstat `+A −B`** (groen/rood, `data-testid=related-nested-diffstat`,
  `diffStat` over de lazy-ge-`ensureCode`de kid; een grijze **`…`**-placeholder
  zolang die code nog laadt — nooit "Ongewijzigd", elk chip-target is per
  definitie een gewijzigd PR-blok) en de **approval `done/total`**
  (`data-testid=related-nested-approval`, `blockApproveCount` van het blok
  zelf — bewust niet subtree; ✓-prefix bij volledig; verborgen bij `total 0`).
  Géén file-regel in de chip (het volledige `label · file` zit in `title`).
  **Recursief**: elke chip toont ingesprongen (`data-testid=
  related-nested-sub`) zijn eigen gewijzigde kinderen, tot een **diepte-cap
  van 2 chip-niveaus** onder de kaart (`NESTED_DEPTH`, `home.mjs` — de kolom
  is smal, elk niveau multipliceert `ensureCode`-fetches, en dieper kijken is
  waar drillen voor is); per niveau gecapt op **3 chips + "+N meer"**
  (`data-testid=related-nested-more`), cycle-safe via een gedeelde `seen`-set
  (het `nestedPrBlocks`-patroon). De data komt uit
  `nestedChangedKids(prBlock, parentId, seen, depth)` in `home.mjs` (platte
  descriptors op `r.nested` + een recursieve key-signatuur `r.nestedSig` via
  `nestedSigOf`, gebouwd in dezelfde descriptor-builders/`setRelated`-watch
  als de rest — nooit in een render-binding, dus geen `b.code`-race):
  `directChildBlocks` levert per definitie alleen **PR-blokken**, dus een
  `Ongewijzigd`/synthetisch call-target krijgt nooit een chip (een call-child
  zonder `prBlock` krijgt expliciet `nested: []`). Chips liften mee op de
  descriptor, dus ze verschijnen op elke granulariteit waar het kind zelf
  zichtbaar is (ook `line`/`call`). Een **klik op een chip op diepte d drilt
  d+1 niveaus in één keer** (het kaart-kind, dan elke ancestor-chip, dan de
  chip zelf — sequentiële `drillIntoChild`-stappen via dezelfde
  `drill`-callback, met `stopPropagation` zodat de kaart-klik er niet óók
  één-niveau overheen drilt); `Enter` op de kaart blijft de gewone
  één-niveau-drill. arrow.js-details: de kaart-root van `relatedCard` is een
  flex-rij (kaart `min-w-0 flex-1`); de approval-teller is een **vooraf
  berekende string** (`approveText`) in een altijd-aanwezig element, en elke
  conditionele sub-template (chip-kolom, diffstat, sub-lijst) loopt via een
  **`${() => …}`-functie-binding** — nooit een statische template↔string-
  ternary, die lekte arrow's template-functie (`i=>je(n,i)`) als tekst bij
  chunk-hergebruik, zie de "statische template↔string slot"-valkuil in
  `.claude/rules/conventions.md`. De kaart-`.key` in `fullCard` draagt
  `r.nestedSig` zodat elke boom-wijziging (set/approval/diff-geladen) een
  verse node bouwt; chip-keys zijn het **id-pad** (zelfde id kan onder twee
  parents hangen). `data-child-id` blijft op de binnenste kaart, dus de
  call-pijl-overlay (die op de **linker**rand van de kaart mikt) heeft geen
  last van de chips rechts. Het `tests_group`-balkje (zie hieronder) krijgt
  géén chips. De ingeklapte kolom-rails (`collapsedColumnHTML`, `home.mjs`)
  tonen sinds deze change óók het volledige `class::method`-label via dezelfde
  `blockLabel`-helper. Zie `tests/related-nested-chip.spec.mjs`.
  Náást de listener-children toont dezelfde kaart ook de **methode-aanroepen** die
  het block doet, gekoppeld aan hun **definitie** — ook uit ongewijzigde bestanden
  (`kind=method_call`, uit `GET /api/callresolve`, code + descriptor zitten in de
  rij, dus geen extra code-fetch). Alleen aanroepen op **door de PR gewijzigde
  regels** hebben zo'n rij (de resolver scant enkel de changed lines, zie
  `.claude/rules/tembed-workflows.md`); ook **enum-cases**
  (`AddressType::BILLING`) resolven — naar hun enum-declaratie.
  Een **derde** kind-bron koppelt een PHPUnit-test aan de methode die hij test,
  in **beide richtingen**: `kind=covers` (een test-blok toont de geteste
  methode — diffstat/`Ongewijzigd`-badge net als `method_call`) en
  `kind=covered_by` (een geteste productiemethode toont "gedekt door
  TestX::testY" — de test zelf, hergebruikt als bestaand PR-blok). Uit
  `GET /api/testcovers`; beide zijn **block-level** (zoals de listener-
  children) en vallen dus ook weg op `gran==='line'`/`'call'` (zie de
  scoping/herordening-alinea hieronder). Ontbreekt een bruikbare
  coverage-annotatie op een test, dan toont de kaart-header i.p.v. een child
  een **warning** (`data-testid=related-covers-warning`, custom inline SVG +
  uitleg — nooit een AI-gok). Zie `.claude/rules/tembed-workflows.md` (sectie
  "Testdekking koppelen").
  **Dekkende tests groeperen in een horizontaal balkje** (`groupTestChildren`
  in `home.mjs` + `testsBar` in `RelatedPanel.mjs`): zodra een blok naast zijn
  `covered_by`-kinderen (de dekkende tests) óók **andere** (niet-test)
  kinderen toont, klappen die tests samen tot één horizontale rij
  (`data-testid=related-tests-bar`: chevron + "N tests"-pill + één compacte
  chip per testmethode, `data-testid=related-tests-chip`) op de plek waar de
  eerste test in de sortering stond — zo duwen ze de echte onderliggende code
  niet omlaag. Klik of `Enter` op het balkje **toggelt** de uitklap
  (`state.testsExpanded`, efemeer — niet in de URL, reset naar dicht bij een
  blok-wissel via `lastRelatedBlockId` in de `setRelated`-watch-callback;
  `state.testsExpanded` staat als inline dep in die watch-getter): uitgeklapt
  verschijnen de tests als **gewone kind-kaarten direct onder het balkje**
  (het balkje blijft staan als inklap-toggle). Zijn er **geen** andere
  kinderen (of geen tests), dan is dit een no-op — de tests renderen als
  gewone kaarten, zoals voorheen. Het groep-item rijdt mee **in** de
  kind-lijst zelf (een synthetische `kind:'tests_group'`-descriptor), dus de
  paneel-cursor (`cs.codeSel` indexeert `rc.children` 1-op-1) heeft geen
  aparte casus: `Enter`/klik landen in `drillIntoChild`, dat op de kind
  vertakt (toggle i.p.v. drillen); `orderedChildBlocks` filtert 'm er — net
  als `covered_by` — uit. De `.key` van het balkje codeert open/dicht + de
  test-ids (verse node per toggle, conform de keyed-node-valkuil in
  `conventions.md`). Test: `tests/related-tests-group.spec.mjs` (fixture-PR
  99, `testsgroup-*.json` + `materializeTestsGroupWorktrees`).
  **Call-pijl-overlay (`src/callArrows.mjs`):** een **vloeiende indigo
  bezier-pijl** loopt van de gewijzigde call-site in de **actieve
  navigatie-unit** (rechterrand van de new-pane, op de hoogte van de
  call-site-rij) naar de bijbehorende **gewijzigde** kind-kaart in deze kaart —
  uitsluitend voor een `method_call`-child wiens definitie zélf een PR-blok is
  (een `Ongewijzigd`-target krijgt nooit een pijl), één pijl per matchend kind
  (de eerste in-scope call-site), alleen in diff-mode en alleen op de top-level
  cursor (`focusLevel === 0`, niet gedrild — een gedrilde kolom heeft geen
  cursor-gescoped paneel, zie `callScopeMethods`). De scope spiegelt de
  paneel-scoping exact: op `call` het ene actieve segment, op `line`/`group`
  elke site binnen de unit-range — een pijl wijst dus altijd naar een kaart
  die het paneel toont. **Bewust een imperatieve teken-laag**, geen reactieve
  template (het `updateHints`/`positionMenu`-model): `callArrowPairs` in
  `home.mjs` berekent de paren in de **callback** van de bestaande
  `setRelated`-watch (untracked — geen nieuwe reactieve `b.code`-lezer, dus
  geen stuck-on-loading-race) en duwt ze via `setCallArrows` naar
  `callArrows.mjs`, dat puur DOM leest (`getBoundingClientRect` op de
  `data-row`-rij in `paneHTML` resp. de `data-child-id`-kaart op
  `relatedCard` — twee statische attributen) en één **statisch gemount**
  `position:fixed` `<svg data-testid=call-arrows>` (top-level naast
  `MenuHost`, `z-[15]`: boven `<main>`'s z-10, onder de sidebar-z-20 en het
  command-menu; `pointer-events:none`) imperatief hertekent (path
  `data-testid=call-arrow`, stroke `#6366f1` op 0.45 opacity + arrowhead-
  marker). De svg wordt per draw exact over `<main>`'s rect gelegd en clipt
  zichzelf — pijlen tekenen nooit over de pr-index/PR-info/sidebar/footer
  heen. Hertekenen: rAF-gecoalesced op de watch zelf, `resize`, capture-
  `scroll` (ook inner scrollers — het `repositionMenu`-precedent) en een
  250ms-settle na elke push (de 200ms breedte-transities, à la `openMenu`).
  Een call-site-rij die uit de diff-viewport is gescrold verliest zijn pijl
  (dezelfde zichtbaarheidsregel als `updateHints`); een kind-kaart die intern
  is weggescrold houdt een op de paneelrand **geclampte** pijl. Test:
  `tests/call-arrows.spec.mjs` (fixture-PR 100, `arrow-*.json` +
  `materializeArrowWorktrees` in `tests/_setup.mjs`).
  De kaart **volgt de cursor**: `home.mjs` (`callScopeMethods`/`findCallSites`)
  koppelt elke resolved call aan het diff-segment waar hij staat. Op het fijnste
  niveau (`gran==='call'`) toont de kaart **precies de method van die ene call** —
  land op `->billingAddress` en je ziet `Order::billingAddress`; een segment
  zonder resolved call geeft een lege kaart. Op `gran==='line'` scope't hij op de
  **regels van de geselecteerde unit**: alleen de calls waarvan de call-site binnen
  `[unit.start, unit.end]` valt. Op **`line`/`call` is dit een harde filter (verbergen)**
  — je ziet nooit een call, listener-, `covers`-/`covered_by`-child van een regel
  die je níét hebt geselecteerd (`relatedChildren`'s `scoped`-vlag in `home.mjs`,
  precies wat "als ik een line/call selecteer wil ik alleen de onderliggende code
  van die line/call" vraagt). Alleen in **list-mode** (geen diff) toont hij **alle**
  resolved calls van het block.
  **Op `gran==='group'` wordt niet verborgen maar geherordend:** een group omvat
  vaak meerdere regels/aanroepen, dus een relatie-/`covers`-/`method_call`-child
  die niet exact op de geselecteerde regel(s) zit, verdwijnt niet — hij zakt alleen
  onder de kinderen die er wél op zitten. Elke relatie/annotatie draagt daarvoor
  sinds kort een **absolute broncoderegel** (server-side vastgelegd door de
  detector die 'm vond — `relations.Relation.Line` resp. `testcovers.Entry.Line`,
  zie `.claude/rules/tembed-workflows.md`); `groupLineRange(b, rows)` in `home.mjs`
  zet de geselecteerde group-unit om naar diezelfde absolute regelrange
  (`unitLineRange`, ongewijzigd hergebruikt) en `relatedChildren` sorteert eerst op
  die **`groupTier`** (0 = binnen de group, 1 = erbuiten) vóór de bestaande
  `prio`/`size`-sort — dus binnen elke tier blijft de onderstaande ordening gewoon
  gelden. Een `covered_by`-child (de test die een productiemethode dekt) heeft
  **geen** aanknopingspunt binnen de bekeken block — de annotatie staat in het
  testbestand, niet in de productiecode — en zit dus altijd in tier 1; zijn eigen
  `prio 0` houdt 'm daarbinnen nog steeds boven een `prio 2` (ongewijzigde) call:
  "onderaan, maar boven ongewijzigd". Een LLM-`found`-`covers`-rij die van een
  class-only-annotatie escaleerde draagt om dezelfde reden ook geen `Line`
  (`resolve_test_covers.go` threadt 'm bewust niet door) en degradeert zo naar
  diezelfde tier 1. Buiten `gran==='group'` (list-mode, of op line/call waar de
  filter toch al alleen in-scope items overlaat) is `groupTier` overal `0` — een
  no-op, de sortering is dan exact zoals vóór deze herordening.
  De getoonde calls zijn (binnen hun tier)
  **geordend**: eerst een call waarvan de definitie zélf in deze PR wijzigt (een
  echt child-blok, `prio 0`), dan calls op een recent gewijzigde regel (`prio 1`),
  dan de rest (`prio 2`). **Binnen dezelfde prio** wint de **grootste** child
  (meeste niet-lege regels, `codeSize` op de child-broncode — `childCode` voor
  een call, geladen `code` voor een listener): zo staat de substantiële
  aangepaste code bovenaan en zakken triviale one-liners eronder. Dat is
  load-bearing want relatie-accessors (b.v. Eloquent `Order::billingAddress`,
  een 3-regelige `MorphOne`) zijn óók `added` PR-blokken en dus óók `prio 0` — ze
  zouden anders op bron-volgorde vóór een echt gewijzigde method kunnen landen. Een
  child wiens code nog niet binnen is telt als `size 0` en zakt tot hij laadt;
  gelijke prio+size houdt de bron-volgorde (stabiele sort). De listener-children
  (block-niveau) vallen op `line`/`call`-niveau weg. In de kaart-header is de **titel (`class::method`) altijd
  zichtbaar** (krijgt de eerste regel, truncat pas bij extreme lengte); het
  **bestandspad** staat eronder op een eigen regel en truncat als het niet past.
  **Reactiviteit:** de lijst wordt **niet** in de render-binding van `RelatedPanel`
  berekend maar in een `watch` in `home.mjs` en via `setRelated` het paneel in
  geduwd — dezelfde ontkoppeling als `setCommentScope`. Dat is **load-bearing**:
  zou de render-binding zelf de `b.code` van het geselecteerde block lezen (via
  `blockRows`), dan racet dat met de diff-render van `home.mjs` over diezelfde
  `b.code` en blijft de diff op "loading" hangen. **Even load-bearing: de
  watch-getter moet de navigatie-state _inline_ opsommen** (`state.selected`,
  `mode`, `change`, `gran`, de block-lijsten, `callResolve`, `relations`,
  `curBlock().code`) — precies zoals de `setCommentScope`-watch. De children pas
  in de _callback_ berekenen (`() => setRelated(relatedChildren(),
  unresolvedCalls())`). Bereken je ze in de getter zelf, dan zijn álle reactieve
  reads verstopt in `relatedChildren`/`unresolvedCalls`, en door hun early-returns
  (leeg block bij load, `resolved.length === 0`, scope-shortcuts) laat de
  uitgekristalliseerde run `state.selected` uit zijn dependency-set vallen: de
  `watch` her-abonneert niet meer en het paneel **bevriest** op het block dat bij
  het laden geselecteerd was — het volgt de cursor niet meer naar een ander block.
  **Refresh-restore van de paneel-cursor:** `cs.focus`/`codeSel`/`sel`/`threadPos`
  leven in de URL onder de eigen `rel`-namespace (`bindUrlState(cs, …, { ns:'rel' })`
  in `RelatedPanel.mjs`), zodat een refresh je terugzet op hetzelfde
  Onderliggende-code-kind resp. dezelfde comment-thread. Omdat de data-pushes
  (`setRelated`/`loadComments`) `cs` tijdens het laden clampen — en de mirror-`watch`
  dat meteen naar de URL zou spiegelen — snapshot `RelatedPanel` de herstelde waarden
  in `restorePending` en past ze via **`applyRelRestore`** één keer geclampt opnieuw
  toe zodra de kinderen/comments binnen zijn (een focus alleen als z'n doel bestaat,
  daarna clear zodat latere navigatie vrij blijft). Zie skill `url-state` en de
  URL-state-sectie in `CLAUDE.md`.
  Aanroepen die de Go-resolver niet kon pinnen starten **automatisch** de
  LLM-zoektocht — **geen knop meer**: `home.mjs` roept in de `setRelated`-watch
  `startCallSearch(focusedBlock())` aan zodra het paneel een blok met `unresolved`
  calls toont (`POST /api/workflows/resolve_call`, gededupt per caller+callKey in
  `searchRequested` zodat het één keer vuurt). Het lost de **hele** unresolved-set
  van het blok op (niet gescoped op de geselecteerde unit), dus je hoeft nergens
  heen te navigeren. Tijdens het zoeken toont de kaart "zoeken…"
  (`data-testid=related-searching`, ook zolang er nog `unresolved` in de wachtrij
  staat). Een door een LLM gevonden child draagt een
  **`bron: haiku/sonnet`**-badge (`source`); Go-resolved children tonen geen bron.
  Zie `.claude/rules/tembed-workflows.md` (sectie "Aangeroepen … methodes resolven").
- **Taken** — dit was ooit een placeholder-kolom met een dummy takenlijst +
  chat (`ui.task`, `data-testid=task-list`/`chat`/`chat-bubble`/`new-task`).
  Die placeholder bestaat niet meer: de "Taken"-kaart is inmiddels de echte,
  werkende `workflows-panel` beschreven hierboven (`data-testid=
  workflows-panel`, gevoed door `GET /api/workflows?pr=N`) — geen chat, geen
  `ui.task`. Zie ook de toetsenbord-koppeling verderop in deze sectie en
  `.claude/rules/keyboard-navigation.md`.

De block-kaart houdt zijn vaste `w-[70rem] 2xl:w-[82rem]`-breedte (geen `flex-1`
meer, en ongeacht of het block één- of tweezijdig is), zodat de diff niet uitrekt
en het paneel er strak naast blijft liggen. In
`'list'`-mode start `<main>` op `left-[29rem]` (naast de sidebar), in `'diff'`-mode
op `left-6` (meer ruimte); de kolommen blijven in beide gevallen vanaf links
inpakken.

**Uitzondering: de `a`-toggle (`state.diffViewMode`, zie
`.claude/rules/keyboard-navigation.md`) krimpt ELKE zichtbare kaart naar 60%
breedte, ongeacht of hij daadwerkelijk een pane verbergt.** Staat `viewMode
==='new'`, dan krimpt de kaart naar `w-[42rem] 2xl:w-[49.2rem]` (60% van
`w-[70rem] 2xl:w-[82rem]`) — voor een tweezijdig (`modified`) block dat dan
ook echt zijn oude/linker pane verbergt, maar **net zo goed** voor een al
eenzijdig `added`/`removed`-block dat niets te verbergen heeft. Dit was eerder
beperkt tot het tweezijdige geval (de bewuste breedte-stabiliteit voor
eenzijdige blocks won dan); dat is bewust losgelaten: de reviewer wil dat
`a` **alles wat op dat moment zichtbaar is** even smal maakt, zodat de layout
niet per block-type verschilt zolang de toggle aanstaat. Twee aparte,
losgekoppelde voorwaarden in `Block.mjs`: `forcedNewOnly(b, viewMode)` blijft
ongewijzigd en bepaalt nog altijd **welke pane(s)** `codeDiff` toont (alleen
relevant voor een echt tweezijdig block — een eenzijdig block toonde toch al
maar één kant); de nieuwe, simpelere `narrowed(viewMode)` (enkel
`viewMode()==='new'`, geen `singleSide`-check) bepaalt de **breedte** in
`Block()`'s eigen kaart-`class`-binding. Geldt automatisch voor **elke**
zichtbare kaart (top-level geselecteerd/preview én elke gedrilde kolom), want
ze delen allemaal dezelfde `Block()`-component en dezelfde `viewMode`-opt
(`() => state.diffViewMode`).
