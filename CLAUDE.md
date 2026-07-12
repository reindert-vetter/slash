# PR Review Tree

Een dashboard dat uit een GitHub-PR (voor nu `plug-and-pay/plug-and-pay`) een
**functie-call-graph** bouwt die je in de browser als boom bekijkt. De boom helpt
bij het reviewen: je ziet welke functies door de PR geraakt worden en hoe ze elkaar
aanroepen.

## De stack is bewust minimalistisch en zonder build-step

Dit is een harde ontwerpkeuze, geen toevalligheid. Voeg **niets** toe dat een
bundler, transpiler of build-stap vereist. Bij twijfel: kies de saaiere, kleinere
oplossing.

### Runtime & server (Go)

- **Golang, geen framework.** Eigen kleine HTTP-server.
- De server serveert de repo **statisch** + een dunne **`/api/*`-bridge** naar
  lokale CLI's:
  - `gh` — voor PR-comments (lezen/plaatsen).
  - `claude` — voor consult en om code te laten aanpassen.
- **Vrijwel geen dependencies in productie — alleen Go built-ins** (`net/http`,
  `os/exec`, `encoding/json`, `database/sql`, …). Wil je een nieuwe dependency
  toevoegen? **Vraag het eerst aan Reindert.**
- **Goedgekeurde uitzondering:** `modernc.org/sqlite` — de pure-Go SQLite-driver
  (geen cgo, dus geen build-step). Dit is de enige toegestane runtime-dependency.
  (Wil je liever de cgo-driver `mattn/go-sqlite3`? Overleg dat eerst.)

### Frontend

- **Vanilla JS ES-modules** in `src/` (`.mjs`). Geen React/Vue/bundler.
- **[arrow.js](https://www.arrow-js.com/)** voor reactiviteit — componenten als
  `dashboard.mjs`, `home.mjs`, `Block.mjs`, etc.
- **Tailwind via Play CDN** (in-browser, geen build-stap).
- **Prism** vendored onder `src/vendor/` voor syntax-highlighting van code.

### Data

- **SQLite** als opslag voor de call-graph (nodes + edges), via `database/sql` +
  `modernc.org/sqlite`. Eén DB-bestand onder `data/` (bv. `data/graph.db`).
- Voordeel boven losse JSON: een update van één klein stukje is een simpele
  row-`UPDATE`/`INSERT` — je hoeft niet een heel bestand te herschrijven of alles
  te herladen. Serveer deltas via de `/api/*`-bridge, niet door de hele graph te
  dumpen.
- Schema-template: `.claude/templates/schema.sql`.

### Test

- **Playwright** (`@playwright/test`) — de enige echte npm-dependency, staat in
  `devDependencies`. Alleen voor tests, nooit in productie.

## Blocks & ingest

De eerste feature: een PR omzetten in een lijst **blocks** (een block = één
PHP-functie/method, of het hele bestand als parsen faalt) en die links als
navigeerbare lijst tonen.

- **Opslag:** de `blocks`-tabel (dit ís de `nodes`/functie-tabel uit de graph,
  hernoemd + uitgebreid met `class/category/end_line/status/side/pr`). De kolom
  `approved` (0/1) markeert of de reviewer een block heeft goedgekeurd. Goedkeuring
  is echter **granulair** (voorlopig client-side): niet één blok-vlag maar een set
  goedgekeurde **gewijzigde regels** — `b.approvedRows`, een array van rij-indices
  in `blockRows(b)`. Elke granulariteit reduceert daartoe (een groep keurt al zijn
  regels goed, een `line`/`call` de ene rij waarop hij staat), zodat "is het hele
  block goedgekeurd?" simpelweg "zijn álle gewijzigde regels goedgekeurd?" is
  (`blockApproved`/`blockPartlyApproved`/`changedRows`/`approvedRowSet` in
  `Block.mjs`). De top-checkbox op de block-kaart is dus **afgeleid**: aangevinkt bij
  `blockApproved`, indeterminate bij deels, met een `approve <done>/<total>`-teller;
  klikken keurt alles goed of wist alles. Een volledig goedgekeurde rij toont een
  klein emerald **vinkje** in de linker-marge (de actieve indigo-balk wint zolang de
  cursor erop staat). Op `call`-niveau kan één rij **meerdere** call-segmenten
  bevatten (`segmentCalls`); goedkeuring is daar dus fijnmaziger dan de rij:
  `b.approvedCalls`, een array van `${row}:${segStart}`-keys (`callKey`/
  `approvedCallSet`/`rowCallSegments` in `Block.mjs`) naast `b.approvedRows`. Zijn
  alle segmenten van een rij goedgekeurd, dan **gradueert** die rij in
  `b.approvedRows` (en verdwijnen zijn keys uit `approvedCalls`) zodat de grovere
  group/line-goedkeuring en de blok-checkbox het gewoon zien; het omgekeerde
  (één segment van een volledig goedgekeurde rij intrekken) splitst 'm weer terug
  in expliciete keys (`toggleCallApprove` in `home.mjs`). Zolang een rij *deels*
  goedgekeurd is (niet 0, niet alles) toont hij per segment een bolletje op een
  tweede, compacte rij eronder — uitgelijnd onder de segment-kolom via
  letterlijke spaties (werkt zonder JS-meting omdat de code monospace is): een
  reeds goedgekeurd segment krijgt een **vol groen** bolletje, een nog wachtend
  segment een **open** bolletje, zodat de rij in één oogopslag als
  voortgangsstrip leest. Is niks goedgekeurd, dan tonen we niks; is alles
  goedgekeurd, dan verdwijnen de bolletjes en komt het vinkje terug
  (`partialCallApproval`/`circleRowHTML` in `Block.mjs`). Beide panes berekenen
  die bolletjes-rij met exact dezelfde (deterministische) input, dus ze voegen
  'm op dezelfde rij-index
  toe en blijven regel-voor-regel uitgelijnd. `b.approvedRows`/`b.approvedCalls`
  worden altijd **hertoegewezen** (nooit in-place gemuteerd) zodat arrow.js de
  checkbox en de indicators her-rendert. `edges` blijft voor de latere call-graph.
  Schema: `.claude/templates/schema.sql` (in sync met de `schemaDDL`-constante in
  `db.go`).
- **Pipeline:** `gh pr view` → `git fetch` (pull-ref + develop, fallback by-sha) →
  twee detached worktrees onder `data/worktrees/pr-<pr>-{base,head}` (**absolute
  paden**!) → `git diff --unified=0` → PHP-scanner (`phpscan.go`, brace-lexer, geen
  externe parser) → classificeren (`classify.go`) → opslaan. Zie skill `ingest-pr`.
- **Draaien:** `go run . ingest <pr> [-db data/graph.db]` (headless) of
  `POST /api/ingest {"pr":N}`. Server: `go run . [-db path] [-addr host:port]
  [-static dir]`. DB-pad ook via `SLASH_DB`. Serve: `GET /api/blocks?pr=N`
  (delta) en `GET /api/code?pr=N&file=..&class=..&name=..` (de oude + nieuwe
  source van één block, uit de base/head worktrees — voor de side-by-side diff
  onder de block-info; `file` moet een opgeslagen block van die PR zijn). De
  front-end (`Block.mjs`) lijnt die oud/nieuw-source **regel-voor-regel** uit met
  een eigen LCS-line-diff (`alignRows`/`diffLines`, puur JS — géén AI): gelijke
  regels delen een rij, een verwijderde regel laat rechts een lege filler-rij, een
  toegevoegde regel laat links een lege filler-rij, en gewijzigde regels krijgen
  rood (oud) / groen (nieuw). Beide panes renderen evenveel rijen op dezelfde
  regelhoogte, dus ze lijnen vanzelf verticaal uit. De line-diff matcht regels
  **whitespace-ongevoelig** (`diffLines` vergelijkt op `s.replace(/\s+/g,'')`, à la
  `git diff -w`): een regel die alléén her-ingesprongen is (bv. een array die een
  niveau dieper in `array_merge(…)` belandt) paart nog met zijn tegenhanger en
  toont als whitespace-only re-alignment (`wsOnly`) — enkel de verschoven
  whitespace krijgt een zachte tint, het woord zelf wordt nooit char-gemarkeerd —
  i.p.v. door de positionele del/ins-pairing te schuiven en ongewijzigde woorden
  als "gewijzigd" te markeren.

## Toetsenbord-navigatie (twee modes)

De keyboard-flow zit in `home.mjs` (`onKeydown`) en heeft twee modes via
`state.mode`.

**`Enter`** opent een **command-palette** (`src/CommandMenu.mjs`,
`data-testid=command-menu`): een doorzoekbaar commando-menu dat als **drijvende
popover net onder de huidige selectie** verschijnt, over de rest van de pagina heen
— overal in de tree, in welk block dan ook. `home.mjs` (`menuOverlay`) rendert het
één keer op `<main>`-niveau als `position:fixed` element (`data-testid=
command-anchor`) met een full-screen catch-laag (`data-testid=command-overlay`) die
bij een klik buiten het menu sluit. `positionMenu` ankert het net **onder** de
selectie én geeft het de **breedte van de rechter (NEW) pane** — dus **halve
breedte, over de rechterkant** (de nieuwe code die je reviewt). De verticale positie
komt van `menuAnchor()` (de actieve wijzigings-rij `[data-change-active]`, aanwezig
in zowel list-preview als diff-mode; anders de block-kaart, anders de sidebar-rij);
de breedte + linkerrand van `menuRegion()` (de `[data-pane="new"]`-pane van het
geselecteerde block; fallback `[data-pane="old"]` voor een verwijderd block, dan de
hele block-kolom — de `data-pane`-hook zit op `codePane` in `Block.mjs`). **Past het
niet onder het scherm, dan klapt het erboven** (en wordt sowieso in de viewport
geklemd). Het start `visibility:hidden` tot `positionMenu` het geplaatst heeft (geen
flits linksboven), en herpositioneert bij resize, scroll (capture, ook
inner-scrollers), na elke toets (de filter-lijst verandert de hoogte) en 220ms na
openen (de panel-breedte animeert 200ms bij het instappen in de diff). Het menu
leeft in een losse `reactive({ open, query, sel })` in `home.mjs` (bewust **niet**
in de URL — efemeer, dus buiten `bindUrlState`). Terwijl het open is **bezit het menu het
toetsenbord**: `onKeydown` handelt `↑`/`↓` (selectie), `Enter` (uitvoeren via
`runCommand`, dat eerst sluit en dan de actie draait), `Esc` (sluiten) af en de
block-navigatie is opgeschort; getypte tekens vloeien in de gefocuste input
(`data-testid=command-input`, two-way met `menu.query`). Filteren gaat via een
**subsequence-fuzzy-match** (`filterCommands`, geëxporteerd uit `CommandMenu.mjs`
zodat de keyboard-handler exact dezelfde gefilterde lijst als de render doorloopt —
`menu.sel` en de zichtbare rijen blijven in sync). De `COMMANDS`-lijst leeft in
`home.mjs` en bevat **block-acties**: approve togglen en comment op deze regel (via
`startComment` uit `RelatedPanel.mjs`) en **Open GitHub**. De approve-actie is
**gescoped op de huidige navigatie-unit** (`toggleApprove`/`approveTargetRows`): in
list-mode het hele block, in diff-mode de geselecteerde groep/regel/call — hij
keurt exact de rijen van die unit goed (of trekt ze in als ze al goedgekeurd zijn).
Het label is een functie zodat het live meebeweegt én de unit benoemt
(`approveNoun`): "Keur dit block goed" (list), "Keur deze regels goed" (group),
"Keur deze regel goed" (line), "Keur deze call goed" (call), en "Trek goedkeuring
van … in" wanneer die unit al goedgekeurd is. Zie de granulaire-goedkeuring-uitleg
in de Blocks-sectie. Bewust **géén** navigatie-items (stap in diff / volgende /
vorige) — die doe je met de pijltjes/`f`/`d`/`s`, niet via het menu. Een commando
mag **`children`** hebben: kiezen opent dan geen actie maar een **submenu** met die
kinderen i.p.v. de menu te sluiten (`runCommand` → `enterSubmenu`, die query/selectie
reset en herpositioneert). `Esc` stapt eerst terug naar de root en sluit pas daarna
het menu; `menu.sub` (in de efemere `menu`-reactive) houdt de open kinderlijst vast,
`resolveCommands` filtert die i.p.v. `COMMANDS` (zonder de comment-fallback). Zo hangt
**Open GitHub** twee targets onder zich: *Regel in Files changed* — deep-linkt naar de
actieve regel in de Files-changed-diff (`openGithubLine`: het GitHub-anker
`#diff-<sha256(pad)><R|L><regel>`, waarbij de regel de `start` van de code-side plus de
offset van de actieve unit is; nieuwe kant = `R`, verwijderd block = `L`) — en
*PR-pagina* (de PR-overzichtspagina, zoals voorheen). Levert het
filter **niets** op voor een niet-lege query, dan valt het menu terug op één item
**"Maak hiermee een comment"** dat de gettypte tekst rechtstreeks als comment-task
op de geselecteerde regel start (`createComment` uit `RelatedPanel.mjs` → `POST
/api/workflows/task_code_comment`, dus binnen de write-boundary). De filter +
fallback zitten in `resolveCommands(query)` in `home.mjs`, gedeeld door de
menu-render én de keyboard-handler zodat beide dezelfde lijst zien. `CommandMenu`
zelf is puur presentatie: het krijgt `menu`, een `resolve(query)`-functie en `onRun`,
en bevat geen filter- of navigatielogica.

Hetzelfde menu-mechanisme bedient ook een **comment-scoped** variant: staat de
keyboard op een geplaatste comment-rij in `RelatedPanel` (`cs.focus === 'comment'`,
vóór het instappen in de thread) én is het reply-veld nog **leeg**, dan opent
`Enter` niet de block-palette maar een menu met alleen **"Verwijder comment"**
(`menu.mode = 'comment'`, `COMMENT_COMMANDS` in `home.mjs`; `resolveCommands`
schakelt op `menu.mode` om, `openMenu(mode)` zet 'm, `closeMenu` reset 'm terug
naar `'block'`). Een **niet-leeg** reply-veld laat `Enter` met rust — dan wint het
eigen `keydown` van het reply-veld (`sendReaction`), zodat "typ een snelle reactie,
druk Enter" blijft werken (`isCommentFocused`/`commentReplyEmpty` in
`RelatedPanel.mjs` bewaken dat onderscheid). `menuAnchor`/`menuRegion` ankeren in
die mode op de gefocuste comment-rij resp. de thread-pane i.p.v. de diff. Kiezen
van **"Verwijder comment"** roept `deleteFocusedComment` aan: die stuurt een
**`delete`-Signal** (`POST /api/workflows/{runID}/signals/delete`) naar de
comment's Workflow Execution — de enige schrijf-weg, binnen de write-boundary.
De workflow (`taskCodeCommentWorkflow` in `workflows.go`) zet de comment eerst op
status **`deleting`** (Activity `markCommentDeleting`), verwijdert 'm dan van
GitHub (Activity `deleteGithubComment`, best-effort, net als het posten) en tot
slot uit het eigen read-model (Activity `deleteComment`, cascadeert de reacties),
en rondt de Execution af. Een `delete`-verzoek rijdt mee op hetzelfde
`reply`-Signal als een reactie (`ReactionSignal.Action`, "" = reactie, "delete" =
verwijderen) — een workflow kan namelijk maar op één Signal-naam tegelijk
`WaitSignal`-en, dus dit moet als een te onderscheiden variant van de bestaande
reacties-lus binnenkomen, niet als een eigen Signal-naam.

**`/`** opent een **algemeen, PR-breed tree-menu** (`menu.mode = 'pr'`,
`PR_COMMANDS` in `home.mjs`) — hetzelfde `CommandMenu`-overlay als `Enter`, maar
i.p.v. block-acties zijn dit acties op de **hele PR**. Drie root-items: **"Naar
PR-overzicht"** (navigeert naar `/pr-overview`), **"GitHub"** en **"Jira"**, de
laatste twee als **submenu** (via het bestaande `children`-mechanisme). Onder
GitHub: *Open op GitHub* (opent de PR-pagina) en *Comment plaatsen* (hergebruikt
de regel-comment-composer `startComment`, net als de block-palette). Onder Jira:
*Openen in nieuw tab* (deep-link naar het ticket), *Comment plaatsen* en *Subtask
maken* — die laatste twee zijn **placeholders** (nog geen Jira-write-integratie).
Een getypt `/` in een gefocust invoerveld (comment-composer/reply) bereikt deze
handler niet — de `relatedActive()`-tak vangt 'm eerder af, dus het teken vloeit
gewoon in het veld. De Jira/GitHub-links leunen op **PR-metadata** (titel + URL,
en de daaruit afgeleide `KEY-123`-ticket-key): die komt uit het **`prmeta`-read-
model** via `GET /api/pr?pr=N`, gevuld door het `pr_status`-workflow (zie de
tembed-sectie). `home.mjs` (`loadPRMeta`) zorgt bij het laden dat de tracker draait
(`POST /api/workflows/pr_status`) en leest daarna de metadata; ontbreekt die (nog),
dan vallen de links terug op de kale PR-URL resp. de Jira-base.

- **`'list'`** (start): `↑`/`↓` kiezen een block in de sidebar, `→` stapt de diff
  van het geselecteerde block in.
- **`'diff'`**: `↑`/`↓` lopen door de **wijzigingen** van dat block, `←` stapt
  terug naar de lijst. Loop je voorbij de **laatste** wijziging (`↓`) of de
  **eerste** (`↑`) — je kunt niet verder binnen dit block — dan stap je door
  naar het **volgende** resp. **vorige** block, **mits dat block uit hetzelfde
  bestand komt** (dezelfde blokken die met het gestippelde connector-lijntje aan
  elkaar hangen); land je op een bestandsgrens dan stopt de navigatie daar. Bij
  het overstappen land je op de eerste resp. laatste wijziging (`stepBlock`, dat
  via `sameFileNeighbour(delta)` de bestands-check doet), zodat je zonder terug
  te gaan naar de lijst door alle diffs van één bestand loopt. Als het buurblock
  zijn code nog laadt onthoudt `pendingLast` dat je op de laatste wijziging wilt
  landen; `ensureCode` lost dat op zodra de rijen bekend zijn. Sta je op de
  **laatste** (resp. **eerste**) wijziging én is er een volgend (resp. vorig)
  **same-file** block, dan verschijnt een **grijs step-chevron _buiten_ de
  block-kaart** — onder de kaart (bij `↓`) net boven het gestippelde
  connector-lijntje, of erboven (bij `↑`) — als hint dat de pijl je naar het
  buurblock brengt (`stepChevron`/`canStep(delta)` in `home.mjs`, in de
  block-kolom náást de kaarten gerenderd). Dit staat los van het **groene
  scroll-chevron _binnen_ de kaart** (`scrollHint`/`updateHints` in `Block.mjs`),
  dat enkel nog "er zijn wijzigingen buiten beeld — scroll verder in dít block"
  betekent. Grijs + buiten = je verlaat het block; groen + binnen = blijf scrollen.
  Op een bestandsgrens (geen same-file buur) blijft het grijze step-chevron uit.

Bij het instappen (`→`) springt de selectie naar de **eerste gewijzigde regel**
(toegevoegd, verwijderd of gewijzigd) — `state.change` is de index. De
navigatie-eenheden komen uit `changeGroups(rows)` in `Block.mjs`: opeenvolgende
gewijzigde rijen (del/ins) tellen als **één** groep, maar een run langer dan 5
rijen wordt in stukken van 5 opgeknipt (`MAX_GROUP`). Die knip gebeurt alleen op
een rij die een **letter (A-z)** bevat: een gewijzigde rij die enkel uit
haakjes/leestekens bestaat (bv. `}` of `{`) wordt bij de huidige groep
getrokken i.p.v. een nieuwe te starten (`hasLetter`), zodat een groep nooit
vlak vóór — of op — een kale haakjes-regel eindigt. `blockRows(b)` levert exact
dezelfde aligned rijen als de render, zodat navigatie en highlight nooit
uiteenlopen. Het geselecteerde block krijgt de actieve groep als een reactieve
`activeGroup`-functie mee (leest `state.mode/selected/change`), zodat de pane
her-highlight zonder dat de hele `DetailPanel` opnieuw rendert. De actieve rijen
krijgen een fellere tint + een inset-linkerbalk (`shadow-[inset_3px_0_0_…]`, geen
layout-shift) en de eerste rij een `data-change-active`-anchor; `home.mjs`
scrollt die met `scrollIntoView({block:'center'})` naar het midden van de
diff-viewport.

### Selectie-granulariteit (`f` inzoomen / `s` uitzoomen / `d` terug)

Binnen een block zoom je met **`f`** (inzoomen) en **`s`** (uitzoomen) langs drie
niveaus (`home.mjs`, `GRANS`). **`d`** is de "terug"-toets die op het fijnste
niveau als vorige-call fungeert (zie onder):

- **`'group'`** (start bij instappen): een hele run gewijzigde regels
  (`changeGroups`) — meerdere regels tegelijk.
- **`'line'`**: één gewijzigde regel per keer (`changeLines`).
- **`'call'`**: één **aanroep-segment binnen** die regel (`changeCalls`). Anders
  dan de grovere niveaus knipt dit niet op *wat* er gewijzigd is maar op de
  **structuur** — de aanroepen die de regel doet — zodat je later elk segment aan
  de functie die het aanroept kunt koppelen (een edge in de call-graph). Een regel
  wordt gesplitst op `->`, `.`, `;` en de **binaire scheiders** `??`, `&&`, `||`
  en de vergelijkers (`==`/`===`/`!=`/`!==`/`<=`/`>=`) (`segmentCalls`; de `;`
  blijft aan zijn aanroep vast, de scheiders leiden — net als `->`/`.` — het
  volgende segment in): `$order->customer()->name();` wordt `$order` /
  `->customer()` / `->name();`, en `$a->x ?? $b->y` wordt `$a` / `->x ` / `?? $b` /
  `->y` zodat de twee callers rond de `??` gescheiden blijven. **Géén** scheider
  (zou echte chains kapotknippen): `=>` (array `key => value` blijft één segment),
  `::` (static call, hoort bij de chain), de ternary `?`/`:` (botsen met `?->` en
  `::`) en een kale `<`/`>` (botst met `->`/`=>`). De `.`-grens is er vooral voor
  Vue/JS property-access (`order.customer.name`), naast PHP-concatenatie. De gekozen
  segment-tekens krijgen een **smalle underline** in dezelfde indigo (`#6366f1`,
  `UNDERLINE_CLS`) als de inset-linkerbalk van de actieve rij.

**Alleen nieuwe/aangepaste regels zijn selecteerbaar op de fijnere niveaus, maar
op `'call'` loop je door de héle regel.** `'line'` navigeert enkel langs de
**nieuwe kant** (het rechter/`ins`-paneel) en slaat een pure verwijdering over.
`'call'` splitst de **hele** nieuwe regel in segmenten — **élk** segment is
landbaar, gewijzigd of niet (later hangt daar een relatie aan), niet alleen het
diff-stuk. Eén uitzondering: een **verwijderde** regel zonder vervanging blijft
óók landbaar — als één leeg nieuw-segment (niets rechts) met de hele oude regel
onderstreept op de oude kant, zodat je erop kunt landen als een lege rechter-regel
die markeert wat weg is. (`'group'` blijft een hele run inclusief verwijderde
regels, zodat het instappen en de connector-flow onveranderd blijven.)

Alle diff-navigatie loopt via `unitsFor(rows, gran)` (nu geëxporteerd uit
`Block.mjs`, gedeeld met de footer) → `unitsOf(b)`; `state.change`
indexeert de units van het **huidige** niveau. Bij een niveauwissel her-ankert
`setGran` de selectie op de unit die de huidige rij dekt (`unitAtRow`): `f` vanaf
een groep landt op zijn eerste regel, `f` vanaf een regel op zijn eerste
call-segment, en `s`/`d` lopen langs dezelfde rijen terug omhoog.

De drie navigatietoetsen (`fKey`/`dKey`/`sKey` in `home.mjs`):

- **`f`** — inzoomen. Vanuit `'list'` stapt hij eerst de diff in (`enterDiff`, dat
  `gran` naar `'group'` reset). In de diff verfijnt hij één niveau
  (`group → line → call`); staat hij al op **`'call'`**, dan stapt hij i.p.v.
  verder in te zoomen naar de **volgende call** (`nextChange` — dezelfde flow als
  `↓`, dus doorstromend naar de eerste call van het volgende **same-file** block).
- **`d`** — terug. Op **`'call'`** stapt hij naar de **vorige call** (`prevChange`,
  doorstromend naar het vorige same-file block, net als `↑`); sta je op de
  **allereerste** call zónder vorige om naartoe te stromen, dan zoomt hij terug uit
  naar `'line'`. Op de grovere niveaus zoomt `d` gewoon één stap uit.
- **`s`** — altijd één niveau uitzoomen (`call → line → group`), geklemd op
  `'group'`. Anders dan `d` gaat `s` op `'call'` nooit langs vorige calls maar
  direct terug naar `'line'`, zodat je betrouwbaar uit de call-selectie ontsnapt.

`d`/`s` doen niets in `'list'`-mode (er is dan niets om uit te zoomen); alleen `f`
stapt van daaruit in. `nextChange`/`prevChange` worden gedeeld met `↑`/`↓`, zodat
pijlen en `f`/`d` de diff identiek doorlopen. Verfijn je een groep die precies
**één regel** beslaat (`cur.end === cur.start`), dan slaat `f` het `'line'`-niveau
over en springt direct naar `'call'` (er is dan geen zinvolle line-stap: de regel
ís de groep); `s`/`d` lopen wél stap-voor-stap terug (`call → line → group`). De
call-underline
rijdt mee op de bestaande char-diff: `paneHTML` geeft de underline-set van het
actieve segment door aan `highlightChanges`, dat samen met de bestaande
achtergrond-markering via `markChars` (per-teken class-functie, opvolger van
`wrapChangedChars`) in één pass gerenderd wordt. Een lege toegevoegde regel heeft
geen tekens en dus geen underline (correct: niets te markeren).

### Footer: inline preview van de geselecteerde regel

Onder de panels zit een vaste footer (`src/Footer.mjs`, `data-testid=footer`, de
panels reserveren er 100px voor). Zodra de **geselecteerde unit precies één regel**
beslaat toont hij die regel als inline diff (`- oud` / `+ nieuw`,
Prism-highlighted). De footer volgt het **huidige granulariteitsniveau** via
dezelfde `unitsFor(rows, state.gran)` als de navigatie (in `'list'`-mode de eerste
groep, in `'diff'`-mode `state.change`): omdat een `'line'`- of `'call'`-unit
altijd één rij is, verschijnt de regel dus **altijd** in de footer zodra je met
`f` tot één regel (of één edit) verfijnt. Meer-regelige selecties (b.v. een brede
groep) geven `null` → geen inline diff. Lange regels (>`WIDE_AT` tekens) laten de
`max-w` los zodat de footer de volle breedte gebruikt. Op `'call'`-niveau
onderstreept de footer het **actieve segment** in dezelfde indigo als de panes:
`activeUnit` geeft de `left`/`right`-underline-sets van de unit mee aan `line()`,
dat via het geëxporteerde `markChars` + `UNDERLINE_CLS` (uit `Block.mjs`) precies
die tekens onderstreept (op `'group'`/`'line'` hebben de units geen set → geen
underline).

## Detail-layout & gerelateerd paneel (placeholder)

Rechts van de sidebar staat de `DetailPanel` (`home.mjs`): een `<main>` als
**flex-row** die zijn kolommen **vanaf links inpakt** (`justify-start`, geen
uitrekken) en horizontaal scrolt (`overflow-x-auto`) zodra ze samen breder zijn
dan het scherm. Links de **block-kolom** (`data-testid=block-column`,
**`shrink-0`** — niet `flex-1`, dus op zijn **natuurlijke diff-breedte**
(`w-[76rem]`, of `w-[42rem]` voor een één-zijdig block) i.p.v. de resterende
ruimte op te vullen) met de kaart van het geselecteerde block plus de
look-ahead-preview van het volgende block (dashed connector als ze uit hetzelfde
bestand komen). **Direct náást** die kolom (niet aan de rechterrand van het
scherm) `RelatedPanel` (`src/RelatedPanel.mjs`, `data-testid=related-panel`,
`w-[38rem] shrink-0`). Zo lijnt het comment/gerelateerd-paneel altijd tegen de
diff aan; er is bewust ruimte rechts voor **latere extra blokken** (elk een eigen
`shrink-0`-kolom die van links verder inpakt).

`RelatedPanel` is **puur placeholder met dummy data** — nog geen `/api`-koppeling.
Twee gestapelde kaarten:

- **Onderliggende code** (boven, `data-testid=related-code`): de **child-blokken**
  van het geselecteerde block — de blokken waaraan het gekoppeld is (nu: de
  `Listener::handle` van een event dat het dispatcht). Elk als kleine
  Prism-highlighted PHP-excerpt (`data-testid=related-item`) met een `kind`-badge.
  Gevoed uit het relations-read-model via `GET /api/relations?pr=N`; `home.mjs`
  (`childrenOf`/`relatedChildren`) haalt de children uit `state.allBlocks` en laadt
  hun code lazy. Een child wordt **uit de linkerlijst gehaald** (`state.blocks` =
  `allBlocks` minus alle `childId`s) en hier getoond; wat overblijft staat links.
  Zie de sectie **Relaties tussen blokken**.
- **Taken + chat** (onder, `data-testid=tasks`): een **flex-row**. Links een
  takenlijst (`data-testid=task-list`, rijen met `data-testid=task-row`). Elke
  rij is twee-regelig: een status-dot + **titel** en daaronder een **note-label**
  (`data-testid=task-note`) met wat er als laatst gebeurde of wat er nu van de
  reviewer verwacht wordt (b.v. "Claude wacht op je antwoord"); later afgeleid uit
  de thread. Het note-label mag tot **3 regels** beslaan (`line-clamp-3`) en de
  rij groeit met zijn tekst mee, daarna wordt de omschrijving afgekapt. Boven de
  takenlijst staat als **eerste item** een gestippelde **"+ Nieuwe taak"**-knop
  (`data-testid=new-task`) om een nieuwe review-taak te starten — placeholder, nog
  niet gekoppeld. De geselecteerde rij is gehighlight (indigo ring). Rechts de
  **chat** van de gekozen taak (`data-testid=chat`): de taaktitel als kop, dummy
  bubbles (`data-testid=chat-bubble`, rechts = reviewer, links = claude) en een
  **uitgeschakelde** composer onderaan. De chat hoort dus bij een taak — klik een
  andere taak en de thread wisselt. De selectie leeft in een gedeelde `reactive`
  (`ui.task`), niet in de URL. Koppelt later aan echte work-items + de
  `/api/claude`-bridge (één thread per taak).

De block-kaart houdt zijn vaste `w-[76rem]`/`w-[42rem]`-breedte (geen `flex-1`
meer), zodat de diff niet uitrekt en het paneel er strak naast blijft liggen. In
`'list'`-mode start `<main>` op `left-[29rem]` (naast de sidebar), in `'diff'`-mode
op `left-6` (meer ruimte); de kolommen blijven in beide gevallen vanaf links
inpakken.

## Pagina's & routing

De app heeft twee pagina's, beide statische HTML-shells zonder build-stap; de
Go-server (`api.go`, `routes`) bepaalt welke shell een route krijgt:

- **`/pr/<id>`** — de review-pagina van één PR (`index.html` → `home.mjs`). De
  PR-id komt uit het **pad**, niet uit de query-string: `home.mjs` leest 'm met
  `prFromPath()` (regex `^/pr/(\d+)`) en zet 'm in `state.pr`. Zonder geldige
  id in het pad doet `home.mjs` een `location.replace('/pr-overview')`.
- **`/pr-overview`** — de **PR-inbox**: een live GitHub-dashboard van PR's die je
  aandacht nodig hebben (`overview.html` → `src/overview.mjs`). Zie de sectie
  **PR-inbox** hieronder. Een geïngeste PR (`hasGraph`) linkt naar `/pr/<id>`; de
  read-only "recent gegenereerd"-lade voedt nog steeds uit **`GET /api/prs`**
  (`handlePRs` → `listPRs`, block/file-counts per PR uit `PRSummary`).
- **`/`** redirect (302) naar `/pr-overview`; alle overige paden
  (`/src/*`, `/overview.html`, …) worden statisch geserveerd door de
  `http.FileServer`. De `/pr/`- en `/pr-overview`-routes serveren hun shell via
  `serveFile(staticDir, name)`.

## PR-inbox (`/pr-overview`)

De startpagina is een **GitHub-inbox**, nagebouwd op GitHub's eigen
`github.com/pulls`-dashboard: dezelfde secties en taal ("Ready to merge", "Needs
your review", …), met per rij review-status, CI-checks, reviewers en diff-stats.
Hij is **volledig read-only** — de inbox muteert nooit state (conform
`workflows-write-boundary.md`). Een geïngeste PR opent de tree op `/pr/<n>`; een
niet-geïngeste rij biedt alleen *Open op GitHub* / *Open Jira-ticket* (géén
ingest-actie vanuit de overview).

### GitHub-toegang loopt via een workflow (niet rechtstreeks)

**De pagina roept GitHub nooit zelf aan.** De PR-lijst wordt gefetcht en beheerd
door het **`pr_inbox`-Workflow** (één Execution per repo, zie tembed-sectie); dat
schrijft de laatste staat in de **`inbox`-module** (een read-model), en de
HTTP-handlers lezen **alleen** dat read-model. Dit is de kanonieke
write-boundary-vorm: alleen een workflow praat met GitHub en muteert state.

- **`pr_inbox`-workflow** (`workflows.go`): een `for`-lus op een `refresh`-**Signal**
  → één `refreshInbox`-**Activity**. De Activity draait `buildInboxSnapshot`
  (fetch + `statusesFor`), slaat het op in de `inbox`-module, en geeft alléén een
  klein `{updatedAt, prs}`-summary terug — de data zelf staat in de module, dus de
  event-history blijft compact ook al refresht de workflow eindeloos.
- **Poller-cadans (heartbeat-gedreven, net als de comment-poller):** `pollInbox`
  stuurt een `refresh`-Signal op de **snelle** cadans (`pollInterval`, 1 min)
  zolang er binnen `heartbeatWindow` een heartbeat kwam, anders op de **trage**
  cadans (`idlePollInterval`, 10 min). Bij startup stuurt `EnsureInbox` één
  **synchrone** refresh, zodat het read-model gevuld is vóór de server serveert;
  na herstart hergebruikt `EnsureInbox` de bestaande Execution (`findInboxRun`).
- **De UI drijft de cadans:** bij laden stuurt `overview.mjs` een `refresh`-Signal
  (`POST /api/workflows/{runID}/signals/refresh`) zodat de workflow meteen opnieuw
  checkt, plus een **heartbeat** (`POST …/heartbeat`) — maar **alleen als het
  tabblad zichtbaar én gefocust is** (`activeTab()`), zodat een geparkeerd tabblad
  vanzelf naar de trage cadans zakt. Daarna pollt de UI het read-model periodiek
  (`reloadSnapshot`) om de nieuwste snapshot te tonen. De heartbeat mutert geen
  durable state (alleen in-memory poll-timing) en valt dus buiten de
  write-boundary — precies zoals bij de comments.

De GitHub-fetch zelf (`inbox.go`): `gh api graphql`-`search`-calls (géén nieuwe
dependency). `lightFields` tekent de rij, `heavyFields` (`mergeable
reviewDecision`, `reviewRequests`, `latestReviews`, `statusCheckRollup`) vult de
pills. `hasGraph` wordt overlayd uit de `blocks`-tabel (`ingestedSet`).
`inboxSections` spiegelen `/pulls` (qualifiers 1-op-1 uit dash' `INBOX_SECTIONS`,
incl. `archived:false`, de copilot-query en de **COMMENTED-catch** `keep`-filter);
queries draaien parallel en worden deterministisch hersamengesteld.
`mergeReviewers` en `statusesFor` (één aliased call) zoals voorheen.

**Endpoints:**

| Endpoint | Doet |
|---|---|
| `GET /api/inbox` | Leest het read-model → `{ok,live,repo,generatedFor,updatedAt,runId,sections}`. `runId` = het `pr_inbox`-Run ID (voor refresh/heartbeat). Nog geen snapshot → `{ok:false}`. |
| `GET /api/inbox/status?prs=12,13` | De pills, óók uit het read-model-snapshot (géén GitHub-call). |
| `POST /api/workflows/{runID}/signals/refresh` | Refresh-Signal (UI bij laden). Start alleen de fetch-Activity. |
| `POST /api/workflows/{runID}/heartbeat` | Operationele ping (poll-cadans), geen state-write. |
| `GET /api/prs/search?q=…` | **Nog wél een directe** live gh-`search` (`inbox_api.go`) — een ephemere, geparametriseerde read, geen persistente lijst. Kaal getal → `<n> in:title`. |
| `GET /api/prs` | (bestaand) geïngeste PR's + counts, voor de recent-lade. |

### Offline / test-modus

Onder **`SLASH_GITHUB=off`** raakt niets het netwerk: `buildInboxSnapshot` (de
Activity) serveert de **fixture** uit `SLASH_INBOX` (`tests/fixtures/inbox.json`,
shape `{repo,generatedFor,sections,statuses}`). Bij startup vult de synchrone
refresh het read-model, dus `GET /api/inbox` heeft meteen data (geen race in
tests). `hasGraph` komt uit de DB, dus de geseedde PR (12903) linkt naar
`/pr/12903`. Faalt de eerste fetch (geen fixture, geen snapshot) → `/api/inbox`
`{ok:false}` → client valt terug op `GET /data/inbox.json` (label "cached").

### Client (`src/overview.mjs`, arrow.js, dark-zinc, Nederlands)

Twee-fasen render via een reactieve `state.statuses` (skeleton → pills, geen
layout-shift). Features: gesecteerde lijst, debounced zoeken (aparte
resultaten-regio, sequence-guard), **stacks** (PR wiens `baseRefName` = een
in-view PR's `headRefName` → ingesprongen groep bovenaan), reviewer-avatars,
review/CI-chips, "recent gegenereerd"-lade (lazy `GET /api/prs`), en
toetsenbord-nav (↑/↓/Home/End/Enter/`/`/→, met de hover-vs-keyboard-flag zodat
`scrollIntoView` de selectie niet kaapt). UI-proza is Nederlands; de
GitHub-sectietitels blijven Engels.

## URL-state (refresh-restore & deep-links)

De navigatie-positie leeft in de **query-string** zodat een refresh of gedeelde
link precies terugkomt waar je was. `src/urlState.mjs` biedt `bindUrlState(state,
fields, { ns })`: het herstelt bij load de opgegeven keys uit de URL naar de
reactive `state` en schrijft daarna elke wijziging terug via
`history.replaceState` (een arrow.js `watch`, dus geen history-spam). `home.mjs`
bindt de hoofd-navigatie (`selected`→`sel`, `mode`, `change`→`chg`,
`gran`→`gran`); de **PR zit in het pad** (`/pr/<id>`, zie hierboven), niet in de
query. Een `default`-waarde wordt uit de URL weggelaten zodat die
kort/canoniek blijft (dus `gran` verschijnt alleen bij `line`/`call`, niet bij de
default `group`).
Elk **extra venster/paneel** krijgt een eigen `ns` (b.v. `{ ns: 'diff' }` →
`?..&diff.file=..`) zodat zijn params náást de hoofd-navigatie in dezelfde URL
staan zonder te botsen. Herstelde waarden die door async-load buiten bereik
vallen worden geclamped (`loadBlocks` clamp't `selected`, `ensureCode` clamp't
`change` en valt terug naar `mode:'list'` bij een block zonder wijzigingen). Zie
skill `url-state`.

## Tembed: durable workflows (`tembed/`)

`tembed/` is een **embeddable durable-workflow engine** — "Temporal, maar een Go-
package". Het staat als **git subtree** (prefix `tembed/`) in deze repo en is
tegelijk zijn eigen module (`github.com/reindert-vetter/tembed`), zodat andere
projecten het los kunnen inladen. **`tembed/` is bewust abstract** — het weet
niets van PR's, blocks of gh; hou het zo.

- **Subtree-flow:** binnenhalen met `git subtree add --prefix=tembed
  https://github.com/reindert-vetter/tembed main --squash`; wijzigingen
  terugduwen naar de tembed-repo met `git subtree push --prefix=tembed <url>
  main`, updates ophalen met `git subtree pull`. slash importeert het via een
  `replace github.com/reindert-vetter/tembed => ./tembed` in `go.mod`.
- **Kern (event-sourcing + replay):** elke run heeft een append-only
  event-history; de engine draait de workflow-functie telkens **vanaf het begin**
  opnieuw tegen die history. Een `ExecuteActivity` waarvan het resultaat al in de
  history staat geeft de opgeslagen waarde terug (activity draait dus **één keer**),
  anders draait de activity nú en wordt het resultaat weggeschreven. Een
  `WaitSignal` die zijn signaal nog niet heeft **yield't** (interne panic-
  sentinel), wordt als `waiting` gepersisteerd en opnieuw gedreven zodra het
  signaal/timer binnenkomt. **Workflow-code moet deterministisch zijn** — alle
  non-determinisme via het `*Workflow`-handle (`ExecuteActivity`, `WaitSignal`,
  `Sleep`, `SideEffect`, `Now`).
- **Signals** zijn gebufferd: een signaal dat vóór de `WaitSignal` aankomt wacht
  tot de workflow erom vraagt. **Timers** (`Sleep`) zijn durable (absolute
  fire-time in de history, herpland bij `Recover`).
- **Opslag** via de `Store`-interface: `MemoryStore` (tests), `JSONLStore` (één
  leesbaar bestand per run), `SQLiteStore` (pure-Go `modernc.org/sqlite`, geen
  cgo) en `MultiStore` om te combineren (SQLite voor queries + JSONL als
  audit-trail). Enige runtime-dependency is `modernc.org/sqlite`.
- **Recovery:** `engine.Recover()` bij startup dry-vt elke `running`/`waiting`
  run opnieuw (herplant timers, her-blokkeert op signals).
- **Tests:** `tembed/*_test.go` (activity-replay, signals, buffered signal,
  durable timer, activity-failure, SQLite+JSONL combinatie).

### Harde regel: alleen workflows muteren state

**Workflows zijn de enige schrijvers.** State verandert uitsluitend via een
Workflow Execution; al het andere is **read-only van buitenaf**:

- **Modules** (`modules/*`, b.v. `comments`, `github`, `inbox`) zijn de dingen die "kunnen
  gebeuren in een workflow" — ze worden **alleen** door workflow-Activities
  aangeroepen. Hun schrijf-methodes (`Save`, `AddReaction`, `PostLineComment`, …)
  hoor je nergens anders aan te roepen; hun **read**-methodes (`List`, …) voeden
  de UI.
- De **HTTP-API** schrijft alleen via workflow-endpoints (een Execution starten
  of een Signal sturen). Alle andere endpoints en de **UI zijn read-only**.
- Waarom: de workflow-event-history is de bron van waarheid (durable, herspeelbaar,
  overleeft herstart). Een module-tabel is een afgeleide read-model. Zie
  `.claude/rules/workflows-write-boundary.md` en `…/workflow-determinism.md`.

### De eerste slash-task: `task_code_comment` (`workflows.go` + `modules/`)

De eerste concrete taak draait op tembed: **een comment op een regel code
plaatsen** en de thread levend houden. Termen volgen Temporal — een **Workflow
Type** `task_code_comment`, gestart als **Workflow Execution** (met een **Run ID**,
dat tevens de comment-id is), die **Activities** draait en op **Signals** reageert.

- **Twee modules** die de workflow als Activity aandrijft:
  - `modules/comments` — de comments-module met een **eigen SQLite read-model**
    (`comments`/`reactions`, `data/comments.db`). "Doet zijn eigen ding": telt
    reacties (`reaction_count`) en zet `status` op `resolved` bij `/resolve`.
    Write (`Save`/`AddReaction`) = workflow-only; `List` = read voor de UI. Elke
    comment bewaart ook het **codefragment** waarop hij hangt (`code`/`gran`/
    `label`-kolommen, meegegeven in `CodeCommentInput`) — de exacte navigatie-unit
    op het moment van plaatsen — zodat de thread later dezelfde code toont als de
    composer. `RelatedPanel.mjs` deelt daarvoor één `composeTargetHint`-box (het
    kader met granulariteit + `class::method` + Prism-highlighted fragment): de
    composer voedt 'm uit `commentTarget()` (live navigatie), de geplaatste-comment-
    thread uit de opgeslagen `code`/`gran`/`label`. Een comment zónder `code` (b.v.
    oude of geseede) toont geen kader. Een lichte `migrate` voegt die kolommen toe
    aan een bestaande DB (`ALTER TABLE … ADD COLUMN`, dubbele-kolom-fout genegeerd).
    Naast het fragment bewaart een comment ook zijn **navigatie-anker**
    (`row_start`/`row_end`/`seg`, meegegeven in `CodeCommentInput`): de aligned-row-
    range binnen het block plus — voor een `call`-comment — de segment-sleutel
    (`segKey` in `home.mjs`). Daarmee is de **comment-index gescoped op het
    geselecteerde block én genest op de selectie-unit** (call ⊂ line ⊂ group ⊂
    block): staat de cursor op een call dan toont de index enkel die call, op een
    line die line + zijn calls, op een group al zijn lines/calls, en in list-mode
    het hele block. `RelatedPanel.mjs` filtert via `commentUnder`/`visibleComments`
    (gedeeld door render én keyboard-nav; `cs.view` is de gefilterde lijst,
    `cs.scope` de huidige unit). De scope komt uit `home.mjs`: een `watch` op de
    navigatie-state duwt 'm via `setCommentScope` naar `RelatedPanel` (de index kan
    `state` niet cross-module observeren vanuit z'n eigen list-binding). `row_start
    < 0` = onbekend anker (oude/geseede comment) → altijd zichtbaar binnen z'n
    block. **Let op:** de index herfiltert betrouwbaar bij (her)laden/deep-link
    (`?sel=`), maar arrow.js her-patcht de keyed comment-lijst niet altijd bij een
    *live* block-wissel met pijltjes — dit hangt samen met hoe `RelatedPanel` maar
    één keer (op `pr`) rendert i.p.v. mee te renderen met de selectie. Los dit op
    wanneer de RelatedPanel-render herzien wordt. Los van de index markeert de diff
    zelf elke regel met een comment met een **💬** (`commentRowSet` → `Block`'s
    `commentedRows` → `paneHTML`, presence-only, aantal maakt niet uit).
    De **thread** opent bovendien met de comment zélf als **eerste bericht**: de
    body die de comment titelt verschijnt óók als eerste chat-bubble (aan de kant
    van de reviewer), gevolgd door de reacties. `RelatedPanel.mjs` bouwt dat met
    `threadMessages(c)` = de synthetische opening (`{source:'ui', body:c.body}`,
    key `origin:<id>`) + `c.reactions`; de keyboard-nav (`reactionCount`/`threadPos`)
    telt die opening mee, dus `↑` loopt door tot de opening bovenaan. Een **klik**
    op een comment-rij landt er ook echt op (`toComment()` → highlight + thread
    open + reply-veld gefocust), net als de toetsenbord-landing.
  - `modules/github` — de GitHub-communicatie (`gh api`): `PostLineComment`,
    `Reply`, `FetchReplies`, `PRState` (`open`/`merged`/`closed`). Interface
    `github.Client` + `github.Fake` (met `SetPRState`) voor tests.
- **Flow:** `saveComment` (comments) + `postGithubComment` (github, best-effort),
  dan een lus op `reply`-**Signals**. Een reactie komt binnen via de **UI**
  (`POST /api/workflows/{runID}/signals/reply`) én via een **per-thread poller**;
  beide worden als hetzelfde Signal geleverd. Elke reactie wordt opgeslagen
  (comments) en een UI-reactie wordt gespiegeld naar GitHub; `Done`/`/resolve`
  sluit de thread.
- **Poller-cadans (heartbeat-gedreven):** de poller checkt GitHub **snel**
  (`pollInterval = time.Minute`) zolang er in de laatste `heartbeatWindow`
  (10 min) een **heartbeat** binnenkwam — de UI pingt
  `POST /api/workflows/{runID}/heartbeat` voor de **taak die je op dat moment
  bekijkt** (per-actieve-taak, geen state-mutatie: enkel in-memory poll-timing,
  dus buiten de write-boundary). De UI pingt **alleen bij echte activiteit**:
  tabblad zichtbaar **én** gefocust **én** input in de laatste `ACTIVITY_WINDOW`
  (2 min) — een open-maar-verlaten tabblad stopt dus vanzelf met heartbeaten
  (`tabActive`/`beat` in `RelatedPanel.mjs`). Zonder recente heartbeat valt hij terug op een
  **trage** cadans (`idlePollInterval = 10 min`); **alleen** op die trage cadans
  checkt hij ook of de PR gemerged/closed is en **stopt** hij dan. De poller
  waakt op de snelle tick maar gate't de echte GitHub-calls op de gewenste cadans,
  zodat een heartbeat mid-idle meteen naar snel schakelt.
- **`pr_status`-workflow (per PR):** een tweede Workflow Type, één Execution per
  PR, die `state`-**Signals** van de pollers ontvangt en **completet** zodra de PR
  merged/closed is. Dat is de durabele bron-van-waarheid die pollers lezen om te
  stoppen (schrijven blijft dus binnen een workflow). `ensurePRStatus(pr)` start/
  hergebruikt één tracker per PR (ook na herstart, via `Runs()`+`Input()`).
  **Bij start** (synchroon in `StartWorkflow`, vóór de signal-lus) draait hij één
  keer de **`fetchPRMeta`-Activity**: die haalt de **PR-titel + URL** op via de
  github-module (`PRMeta`, best-effort — geen gh = leeg) en schrijft ze in de
  **`prmeta`-module** (`modules/prmeta`, `data/prmeta.db`, read-model met
  `Save`/`Get`). De UI (`/`-menu, zie Toetsenbord-navigatie) leest dat via
  `GET /api/pr?pr=N` voor de Jira/GitHub-deep-links; de titel levert de
  `KEY-123`-ticket-key. `EnsurePRStatus` is de geëxporteerde ensure-wrapper die de
  UI via `POST /api/workflows/pr_status {pr}` bij het laden aanroept (een Execution
  starten = sanctioned write-weg).
- **`pr_inbox`-workflow (per repo):** een derde Workflow Type dat de PR-inbox
  bezit — het is de **enige** die GitHub voor het overzicht leest. Een
  `refresh`-Signal (van de UI bij laden én van `pollInbox` op de
  heartbeat-cadans) drijft de `refreshInbox`-Activity, die de inbox fetcht en in
  de **`inbox`-module** (read-model) schrijft. `EnsureInbox` start/hergebruikt één
  Execution per repo en doet een synchrone eerste refresh bij startup. Zie de
  sectie **PR-inbox**.
- **Opslag:** de tembed-engine gebruikt `MultiStore(SQLite data/workflows.db,
  JSONL data/workflows/)` — comments leven dus zowel in de workflow-history als in
  **jsonl-bestanden**. Daarnaast houdt de comments-module zijn eigen read-model.
- **Endpoints** (`tasks_api.go`): `POST /api/workflows/task_code_comment` (start),
  `GET` (lijst), `POST /api/workflows/{runID}/signals/reply` (UI-reactie),
  `POST /api/workflows/{runID}/heartbeat` (UI-heartbeat, geen state-write),
  `GET /api/workflows/{runID}` (status), en read-only `GET /api/comments?pr=N`.
  Voor de PR-metadata: `POST /api/workflows/pr_status {pr}` (ensure de tracker,
  die synchroon de titel fetcht) + read-only `GET /api/pr?pr=N` (leest het
  `prmeta`-read-model: `{ok,pr,title,url,updatedAt}`; `{ok:false}` zolang nog niet
  gefetcht). Voor de inbox: `POST /api/workflows/{runID}/signals/refresh` +
  read-only `GET /api/inbox` (leest het `inbox`-read-model).
  Bootstrap + recovery + hervatten van pollers + `EnsureInbox`:
  `newTasks(ctx, db, dataDir, repo)` in `tasks_api.go`, aangeroepen in `runServe`.
- **Nieuwe workflow of module toevoegen:** skills `add-workflow` / `add-module`
  (+ templates `.claude/templates/workflow.go` / `module.go`).
- Tests: `workflows_test.go` (UI-reactie + gh-poll→signal + resolve, een
  restart-durability-test, `pr_status`-stop-bij-merge, heartbeat-houdt-snel,
  `pr_status`-fetcht-PR-meta, plus `pr_inbox`-refresh-vult-read-model);
  `tests/pr-menu.spec.mjs` (Playwright: het `/`-menu en zijn submenu's); modules
  zijn puur en los testbaar.

### Relaties tussen blokken (`build_relations` + `modules/relations`)

Een vierde Workflow Type, **`build_relations`** (één Execution per PR), leidt
**many-to-many relaties** tussen blokken af — de call-graph-edges, maar
betekenis-gedreven i.p.v. tekstueel. De eerste relatie-`kind`:
**`event_listener`** — een gewijzigd blok dat een event dispatcht wordt de
**parent** van de `Listener::handle` voor dat event, **mits die handle óók in
deze PR gewijzigd is** (beide kanten moeten wijzigen om te koppelen).

- **`modules/relations`** (`data/relations.db`): het read-model,
  `relations(pr, parent_id, child_id, kind)` (block-id = `<pr>:<file>:<symbol>`).
  Write `Replace(pr, rels)` (workflow-only, full-swap per PR → replay-safe), read
  `List(pr)`. `kind` houdt de tabel open voor latere relatietypes.
- **Analyse-service `relations.go`** (package main, géén module — leest de
  head-worktree = side-effect): `buildRelations(dataDir, pr, blocks)` draait een
  lijst **detectors** (nu `eventListenerDetector`). De event→listener-map komt
  robuust uit drie bronnen (union): de `handle(EventType $e)`-type-hint, het
  `$listen`-array in een `*ServiceProvider.php`, en `Event::listen(...)`-calls;
  dispatch-sites worden per blok-body gescand (`event(new X`, `X::dispatch(`, …).
  Herbruikt `extractBlockSource` (code.go) om block-bodies te lezen.
- **Workflow** (`workflows.go`): `buildRelationsWorkflow` draait de
  `buildRelations`-Activity één keer bij start (synchroon in `StartWorkflow`) en
  opnieuw op elk **`rebuild`**-Signal. `EnsureRelations(ctx, pr)` (spiegelt
  `ensurePRStatus`) start/hergebruikt één Execution per PR; **na een geslaagde
  ingest** roept `handleIngest` (`api.go`) 'm aan.
- **Endpoints:** read-only `GET /api/relations?pr=N` (leest het read-model);
  `POST /api/workflows/{runID}/signals/rebuild`. Block-JSON draagt nu een
  computed **`id`** (`model.go` `MarshalJSON`) zodat de frontend `parentId`/
  `childId` aan blokken matcht.
- **Frontend:** `home.mjs` laadt de relaties in `loadBlocks`, splitst
  `state.blocks` (top-level = `allBlocks` minus children) van `state.allBlocks`;
  de sidebar + navigatie draaien op `state.blocks`, children renderen in de
  **Onderliggende code**-kaart (zie boven).
- Tests: `relations_test.go` (detector met beide mapping-bronnen, de
  beide-kanten-eis, module round-trip, en de workflow-end-to-end);
  `tests/relations.spec.mjs` (Playwright: child weg uit de lijst, wél in het
  paneel — geseed via `slash seed -relations`).

## Conventies (ingevuld door dit scaffold — corrigeer waar nodig)

- Frontend-modules zijn `.mjs`, één component per bestand, PascalCase voor
  component-bestanden (`Block.mjs`), lowercase voor pagina-modules (`home.mjs`).
- Vendored libs (arrow.js, Prism) leven in `src/vendor/` en worden met een relatief
  pad geïmporteerd, niet via een CDN-module. Tailwind is de uitzondering (Play CDN).
  arrow.js staat gevendord in `src/vendor/arrow.js`.
- **arrow.js-valkuilen** (uit de praktijk): géén HTML-comments (`<!-- -->`) in een
  `html`` `` template (gooit "Invalid HTML position"); een reactieve attribuut-waarde
  moet de **hele** waarde zijn (`class="${() => ...}"`, niet `class="x ${...}"`).
  Ruwe HTML injecteer je via de `.innerHTML`-binding
  (`.innerHTML="${() => htmlString}"`) — arrow.js zet dan de property i.p.v. te
  escapen. Zorg dat de string veilig is (bv. Prism.highlight, dat zelf escapet).
- **Syntax-highlighting:** Prism 1.29.0 staat gevendord als één ES-module in
  `src/vendor/prism.js` (core + markup + clike + markup-templating + php, met
  `window.Prism={manual:true}` zodat het niet de hele pagina auto-highlightt). De
  code-panes in `Block.mjs` highlighten PHP met `Prism.highlight(...)` en tonen het
  resultaat via de `.innerHTML`-binding. Prism's eigen container-CSS is bewust
  weggelaten; alleen de token-kleuren staan (scoped onder `[data-testid=code-diff]`)
  in de `<style>` van `index.html`.
- Go: `net/http` `ServeMux`, handlers per feature. De `/api/`-bridge shelt uit naar
  `gh`/`claude` via `os/exec` — valideer altijd input voordat je het aan een
  subproces geeft.
- **Code (Go + JS) is Engels** — comments, log-berichten en identifiers. De docs in
  `.claude/` en `CLAUDE.md` blijven Nederlands.

## `.claude/` bijhouden

Deze `.claude/`-map (rules, templates, skills, agents) is onderdeel van het project
en moet **meegroeien**. Komt er een nieuwe regel, conventie of terugkerende taak bij:
werk het bijbehorende bestand bij (of maak een nieuw skill/template/agent aan) in
dezelfde change. Laat conventies niet alleen in een chat achter.
