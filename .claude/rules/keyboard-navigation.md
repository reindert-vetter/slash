# Toetsenbord-navigatie (twee modes)

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
in `.claude/rules/blocks-and-ingest.md`. Bewust **géén** navigatie-items (stap in diff / volgende /
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

Datzelfde `CommandMenu`-mechanisme bedient ook een **comment-soort-menu**
(`menu.mode = 'compose'`, `COMPOSE_COMMANDS` in `home.mjs`): staat de composer
open én is er tekst getypt, dan opent **`Enter`** (en de composer-knop
**"Plaats…"**, via de `openCompose`-prop van `RelatedPanel`) niet meteen de
comment, maar een menu met vier keuzes wat ermee moet gebeuren: *Claude commando*
(placeholder), *Laat Claude dit implementeren (groep/regel/call)* — placeholder,
label benoemt de huidige unit via `granNoun()` uit `commentTarget()` —, *Alleen
voor mijzelf* en *Jira* (een submenu met *Comment op ticket* / *Subtaak aanmaken* /
*Nieuwe taak aanmaken*, alle drie placeholder). Alleen **"Alleen voor mijzelf"**
plaatst echt: `placeComment(state, commentTarget, { local: true })` → een
**privé-notitie** die wél als comment wordt opgeslagen maar niet naar GitHub gaat
(zie de `local`-vlag in `.claude/rules/tembed-workflows.md`). De Enter-tak zit
in `onKeydown` **vóór** de `relatedActive()`-tak (`isComposeOpen()` +
`composeHasText()`, beide uit `RelatedPanel.mjs`), zodat hij werkt of de composer
nu via toetsenbord (`cs.focus==='new'`) of via de knop geopend is; **Shift+Enter**
valt erbuiten en blijft dus een newline in de composer. Belangrijk: dit was de
eerste flow die een menu **over** de open composer opent — daardoor kwam een
latente arrow.js-wees-binding-bug boven (menu-heropen-crash), opgelost met de
verse-`ms`-state-split, zie `.claude/rules/conventions.md`.

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
model** via `GET /api/pr?pr=N`, gevuld door het `pr_status`-workflow (zie
`.claude/rules/tembed-workflows.md`). `home.mjs` (`loadPRMeta`) zorgt bij het laden dat de tracker draait
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

In `'diff'`-mode stapt **`→`** de **Onderliggende-code-kaart** in
(`enterRelated` in `RelatedPanel.mjs`, `cs.focus === 'code'`) en landt op het
**eerste** child-blokje (`cs.codeSel = 0`). Alle blokjes staan verticaal onder
elkaar op volle breedte (geen zij-aan-zij-hint meer) en de kaart is een **pure
lijst-navigatie**: **`↓`** selecteert het **volgende** blokje (blijft op het
laatste), **`↑`** het **vorige** blokje — vanaf het **eerste** blokje gaat
**`↑`** i.p.v. verder terug naar de diff (`exitRelated`). **`→`** springt vanaf
elk blokje naar de comments-kolom (de **"+ Comment op deze regel"**-knop,
`gotoRow(1)`); **`←`** gaat vanaf elk blokje terug naar de diff (`exitRelated`).
Vanuit de comments keert **`↑`** terug naar het laatst-gekozen blokje
(`cs.codeSel` blijft behouden). Deze paneel-cursor
(`cs.focus`/`codeSel`/`sel`/`threadPos`) leeft in de **URL** onder de eigen
`rel`-namespace (`rel.foc`/`rel.code`/`rel.csel`/`rel.thr`, via
`bindUrlState(cs, …, { ns:'rel' })` in `RelatedPanel.mjs`), zodat een refresh je
terugzet op precies dit blokje / deze comment-thread; `applyRelRestore` past de
herstelde cursor één keer geclampt opnieuw toe zodra de kinderen/comments geladen
zijn (zie `.claude/rules/detail-layout.md` en skill `url-state`). **`Enter`** op de
kaart **drilt** in het kind
waar de cursor op staat (`focusedRelatedChild()`) — en een **muisklik** op een
Onderliggende-code-item (`data-testid=related-item`) drilt in dát kind, langs
dezelfde weg: het kind opent als een eigen
diff-kolom rechts naast de bestaande, tussen die kolommen en `RelatedPanel` in
(`drillIntoChild`, zie de sectie "Drillen" in `.claude/rules/detail-layout.md`),
en het Onderliggende-code-paneel + de taken/chat eronder springen mee naar dát
niveau (`focusedBlock()`). Dit geldt **altijd voor het gefocuste kind**; is er
geen kind gefocust (lege lijst) dan doet `Enter` niets — onopgeloste calls
worden **automatisch** door de LLM-search opgepakt zonder toets of knop (zie
`startCallSearch` + de `setRelated`-watch in `home.mjs`). Meteen na het
drillen staat de keyboard-focus op de **diff** van de nieuwe kolom, niet op zijn
Onderliggende-code-paneel (`drillIntoChild` roept `leaveRelated()` — de
geëxporteerde `exitRelated` — i.p.v. `enterRelated()`); vandaar loop je met
`↑`/`↓` door de wijzigingsgroepen van díe kolom, en **sluit** `←` de gefocuste
gedrilde kolom, waarna de focus terugvalt op de diff van de parent-kolom (het
gesloten kind verschijnt weer in diens Onderliggende-code-lijst) — herhaald `←`
pelt zo niveau voor niveau terug tot het oorspronkelijke top-level block, waar
nóg een `←` pas de hele diff-sessie verlaat (en dan ook de resterende
gedrilde-kolom-state opruimt). Zie de sectie
"Kolom-navigatie" in `.claude/rules/detail-layout.md` voor het volledige
`state.focusLevel`-mechanisme. `←`/`Escape` vanaf de eerste positie van het
Onderliggende-code-paneel (`cs.codeSel === 0`) geeft de keyboard-focus terug aan
de diff van **diezelfde** kolom (`handleRelatedKey`'s `exitRelated()`) — dat is
geen aparte "pop"-stap meer, de kolom-voor-kolom-navigatie hierboven volgt pas
zodra `relatedActive()` weer `false` is. Deze code-tak zit vóór de generieke
`gotoRow`-walk in `handleRelatedKey`; de comment-/thread-takken blijven
ongewijzigd. Visueel: alle blokjes staan verticaal onder elkaar op volle
breedte (geen pijltjes-hint meer); het geselecteerde blokje krijgt een indigo ring
(`data-active=true`). Zie `.claude/rules/detail-layout.md`.

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

## Selectie-granulariteit (`f` inzoomen / `s` uitzoomen / `d` terug)

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
pijlen en `f`/`d` de diff identiek doorlopen.

**`f`/`d`/`s` werken ook binnen een gedrilde kolom** (`state.focusLevel > 0`,
zie "Drillen"/"Kolom-navigatie" in `.claude/rules/detail-layout.md`) — exact
dezelfde group→line→call-zoom, maar op de eigen `{change, gran}`-cursor van die
kolom in `state.drillCursor[focusLevel-1]` (`setDrillGran`/`drillNextChange`/
`drillPrevChange` in `home.mjs`, spiegelbeeld van `setGran`/`nextChange`/
`prevChange`). Het enige verschil: een gedrilde kolom is een op zichzelf staande
diff, dus op `'call'` stroomt hij aan de eerste/laatste call **niet** door naar
een same-file buurblock (dat bestaat niet voor een gedrilde kolom) — daar zoomt
`f`/`d` gewoon terug naar `'line'` i.p.v. verder te lopen. Verfijn je een groep die precies
**één regel** beslaat (`cur.end === cur.start`), dan slaat `f` het `'line'`-niveau
over en springt direct naar `'call'` (er is dan geen zinvolle line-stap: de regel
ís de groep); `s`/`d` lopen wél stap-voor-stap terug (`call → line → group`). De
call-underline
rijdt mee op `markChars` (per-teken class-functie): `paneHTML` geeft de
underline-set van het actieve segment door aan `highlightChanges`, dat 'm via
`markChars` in de Prism-highlighted HTML rendert. Gewijzigde tekens krijgen
sinds kort **geen** eigen achtergrond meer (die achtergrond-markering is
verwijderd — zie de sectie "Char-diff" in `.claude/rules/blocks-and-ingest.md`);
de regel-achtergrond (rood/groen) markeert een echte wijziging nu alleen nog op
regelniveau. Een lege toegevoegde regel heeft geen tekens en dus geen underline
(correct: niets te markeren).

## Footer: inline preview van de geselecteerde regel

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
