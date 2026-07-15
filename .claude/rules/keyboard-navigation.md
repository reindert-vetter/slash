# Toetsenbord-navigatie (twee modes)

De keyboard-flow zit in `home.mjs` (`onKeydown`) en heeft twee modes via
`state.mode`.

## De links→rechts navigatieketen (`←`/`→` door de hele layout)

Los van de losse mechanismen hieronder vormen `←`/`→` samen één doorlopende
keten van **stops**, van links naar rechts over de hele layout:

1. **Omschrijving** (`prInfoCard`/`state.showDescription`) — de PR-titel/
   samenvatting/beschrijving. **Standaard verborgen** (neemt dan geen breedte
   in — geen rail zoals stop 5's inklap, de kolom valt volledig weg) en de
   meest-linkse stop. `←` hier verlaat de hele keten naar `/pr-overview` (zie
   onder) — er is niets links van stop 1.
2. **PR-blok-index** (`data-testid=pr-index`, de sidebar, `state.mode==='list'`)
   — schuift fysiek naar rechts zodra stop 1 open is, zodat de omschrijving er
   echt links van staat i.p.v. erna (zie `.claude/rules/detail-layout.md`).
3. **Blok met diff** (`state.mode==='diff'`, `state.focusLevel===0`).
4. **Gedrilde kolommen** (`state.drill`/`focusLevel>0`) — een **zijtak**, geen
   strikte stop: alleen bereikbaar via Enter/klik op een Onderliggende-code-kind
   (zie "Drillen" in `.claude/rules/detail-layout.md`), niet via `→`. `←` pelt
   ze wel één voor één terug af, net als de andere stops.
5. **Onderliggende code** (`RelatedPanel`, `cs.focus==='code'`).
6. **Comments** (`cs.focus` ∈ `{'new','comment','thread'}`).
7. **Taken** (`cs.focus==='task'`, de workflow-runs-kolom).

**Focus-highlight per stop:** stops 1-3 show the *same* on/off indigo
focus border (`border-indigo-300 ring-1 ring-indigo-200`, otherwise the
neutral grey border) exactly while that stop owns the keyboard, mirroring the
`diffActive` pattern of the block-diff card (`Block.mjs`): the description card
(`prInfoCard`, `data-testid=pr-info-card`) while `state.showDescription` is
true, the pr-index (`data-testid=pr-index`) while `state.mode==='list' &&
!state.showDescription`, and the block-diff card (stop 3, and each drilled
column, stop 4) while it owns `focusLevel`. Both `prInfoCard` and the pr-index
`<aside>` build this into their existing top-level `class="${() => …}"`
function binding (not a keyed list item), so it just re-evaluates reactively on
`state.showDescription`/`state.mode` — no arrow.js keyed-node pitfall applies
here (that pitfall only bites keyed array items like the `Block()` cards, see
`.claude/rules/conventions.md`). Stop 5 (Onderliggende code) deliberately has
**no** outer focus border — that was removed on purpose (see the "Onderliggende
code" section in `.claude/rules/detail-layout.md`), so the chain isn't
uniformly bordered end-to-end, only stops 1-4.

`→` schuift één stop naar rechts, `←` één stop naar links — dit is
**bovenop**, niet in plaats van, de bestaande per-stop `↑`/`↓`-navigatie
(die blijft binnen een stop lopen: block-selectie in de index, wijzigingsgroep
in de diff, kind in Onderliggende code, rij in comments, rij in Taken).
Concreet, met de aanpassingen die dit vereiste t.o.v. het oudere per-mechanisme
gedrag:

- **Stop 1 ↔ 2:** `←` in `'list'`-mode (buiten de zoekbox) opende vroeger de
  zoekbox (`activateSearch()`); dat is nu **de omschrijving openen**
  (`state.showDescription = true`). `→` vanuit de omschrijving sluit 'm weer
  (`state.showDescription = false`) en geeft de blok-index de keyboard terug.
  Terwijl de omschrijving open is doen `↑`/`↓` niets (geen interne cursor om te
  lopen) — dat voorkomt dat ze de block-selectie eronder verschuiven.
  **De zoekbox is geen eigen stop** — hij hoort bij stop 2 en is niet meer via
  `←` bereikbaar (dat was zijn enige toetsenbord-ingang); hij blijft gewoon
  bereikbaar via een muisklik (en native Tab), en typen filtert zoals altijd
  zodra hij focus heeft. Was de zoekbox al met een klik gefocust
  (`state.searchActive`), dan doet `←` daar nu hetzelfde (naar stop 1, met
  `exitSearch()` om de DOM-focus netjes los te laten) i.p.v. de oude no-op
  ("already the leftmost stop").
- **Vóór stop 1 (einde van de keten):** `←` terwijl `state.showDescription` open
  is (er is geen stop 0) navigeert weg uit de PR naar de **PR-inbox**
  (`location.href = '/pr-overview'`, zie `.claude/rules/pages-and-routing.md`).
  Kies je daar een PR, dan land je op `/pr/<id>` zonder `sel`-param in de URL,
  dus `state.selected` staat op zijn default (`0`) — het **eerste blok** is
  meteen geselecteerd, niet wat eerder op die PR geselecteerd stond.
- **Stop 2 ↔ 3 / stop 3 ↔ 4:** ongewijzigd — zie de `'list'`/`'diff'`-secties
  hieronder resp. "Kolom-navigatie" in `.claude/rules/detail-layout.md`.
- **Stop 3/4 ↔ 5:** ongewijzigd — `→` vanuit de diff is `enterRelated()`, `←`
  vanuit `cs.focus==='code'` (op het eerste kind, of via `↑` daar) is
  `exitRelated()`.
- **Stop 5 ↔ 6:** ongewijzigd — `→` vanuit `'code'` is `gotoRow(1)` (naar de
  composer).
- **Binnen/uit stop 6:** **bugfix** — `←` vanuit een comment-rij (`'new'`/
  `'comment'`, niet `'thread'`) riep voorheen onvoorwaardelijk `exitRelated()`
  aan en sprong dus in één klap helemaal terug naar de diff, stop 5 overslaand.
  Dat is nu `toCode()` (terug naar stop 5) — alleen `←` vanuit `cs.focus===
  'code'` zelf gaat nog zo ver terug als de diff. `←` vanuit `'thread'` blijft
  ongewijzigd (`toComment()`, één niveau terug naar de comment-rij, geen
  stop-stap).
- **Stop 6 ↔ 7:** nieuw. `→` gaat binnen comments eerst zo diep mogelijk
  (`'comment'` → `'thread'`, ongewijzigd — `enterThread()`); pas als er niks
  dieper is (`'new'`, de lege composer, of al in `'thread'`) stapt `→` door
  naar Taken (`toTask(0)`, in `RelatedPanel.mjs`). In Taken lopen `↑`/`↓`
  door de rijen (`cs.taskSel`, geklemd op `taskRuns(state).length` — de
  actief-dan-klaar-volgorde die `workflowsSection` ook rendert, zodat rij-index
  en render altijd overeenkomen); `←` gaat terug naar waar `→` vandaan kwam
  (`preTaskFocus`: de composer, of dezelfde thread); `→` doet niets (laatste
  stop). `Enter` (in `home.mjs`, via `isTaskFocused()`/`focusedTaskRun()`) opent
  de gefocuste run net als een klik (`openTask`) — alleen zinvol voor een
  `task_code_comment`-run met een gekoppelde comment, stil genegeerd voor de
  rest. Zie de sectie "Taken" in `.claude/rules/detail-layout.md`.
- `state.showDescription`/`cs.taskSel` leven bewust **buiten** de URL (net als
  `menu`/`ui.task` elders) — efemere cursor-state, geen navigatiepositie die een
  refresh moet terugzetten.

**`Enter`** opent een **command-palette** (`src/CommandMenu.mjs`,
`data-testid=command-menu`): een doorzoekbaar commando-menu dat als **drijvende
popover net onder de huidige selectie** verschijnt, over de rest van de pagina heen
— overal in de tree, in welk block dan ook. Op **stop 1** (de PR-omschrijving-
kolom, `state.showDescription`, zie "De links→rechts navigatieketen" hierboven) is er geen
block-context om op te acteren, dus opent `Enter` daar hetzelfde **PR-brede**
menu als `/` (`openMenu(state.showDescription ? 'pr' : 'block')` in `onKeydown`)
i.p.v. de block-scoped palette — blok 0 in de lijst is een andere stop
(`showDescription` is daar `false`) en houdt gewoon de block-palette. `home.mjs`
(`menuOverlay`) rendert het
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

**Na het goedkeuren via de palette** (niet via de top-checkbox op de block-kaart —
die blijft een direct togglende klik zonder vervolg) opent, als er nog een
volgende niet-goedgekeurde unit bestaat, meteen een **vervolgmenu**
(`menu.mode = 'postApprove'`, `POSTAPPROVE_COMMANDS` in `home.mjs`): **"Ga door
naar de volgende niet-goedgekeurde code"** (default, eerste item — navigeert
alleen, keurt niets automatisch goed) of **"Sluit menu"**. Dit triggert alleen
als de actie goedkeuring **toevoegde** (`toggleApprove`/`toggleCallApprove`
detecteren dat via `allIn`/`keys.has(key)` **vóór** de mutatie — intrekken van een
goedkeuring opent dit menu nooit) én er daadwerkelijk nog iets openstaat
(`afterApproveAction` → `findNextUnapproved()`; niets meer open → het menu blijft
gewoon dicht, zoals altijd). "Volgende" is **blok-overstijgend**: eerst verder
binnen het huidige blok op de huidige granulariteit (voorbij `state.change`),
en als dat blok klaar is, verder door `state.blocks` in sidebar-volgorde
(altijd op `'group'`-niveau) — met lazy `ensureCode`-fetches voor blokken die
nog niet bezocht zijn, net als de look-ahead-preview. Alleen **voorwaarts**, geen
wrap en geen terugzoeken naar eerder overgeslagen units. `findNextUnapproved`
stasht de gevonden bestemming in `postApproveTarget`; "Ga door" past 'm toe via
`applyNextUnapproved` (mirror van `openTask`'s block-wissel-reset: een andere
`state.selected` maakt `state.drill`/`drillCursor`/`focusLevel` leeg) zonder te
herberekenen — de palette bezit de keyboard zolang hij open is, dus de
navigatie-state kan intussen niet verschoven zijn. Dit is een eenmalige stap: na
het navigeren opent er **geen** nieuw vervolgmenu vanzelf — de reviewer keurt de
nieuwe unit zelf weer goed met `Enter`.

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
  van het geselecteerde block in. Volledig goedgekeurde top-level blokken zijn
  standaard **verborgen** uit deze lijst (knop onderin klapt ze uit); de "Start"-kop
  toont een PR-brede goedkeurings-teller. Zie de sectie "Verbergen van goedgekeurde
  blokken" + "Server-side `total`" in `.claude/rules/blocks-and-ingest.md`.
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

## `a` — diff-weergave toggelen (side-by-side ↔ alleen nieuw)

**`a`** toggelt globaal, voor **elke zichtbare diff-kaart tegelijk** — de
geselecteerde/preview-kaart én elke open gedrilde kolom (`state.drill`) — tussen
de bestaande side-by-side weergave (oud+nieuw, default) en een **alleen-nieuw**-
weergave (enkel de rechter/nieuwe pane, volle breedte, dezelfde rendering als een
al one-sided `added`-block). Staat naast `f`/`d`/`s` in `onKeydown` (`home.mjs`),
dus met dezelfde eerdere guards (command-palette/zoekbox/related-panel actief)
ervoor — werkt zowel in `'list'`- als `'diff'`-mode, botst niet met typen in een
invoerveld. De state (`state.diffViewMode`, `'split'`/`'new'`) is efemeer, geen
URL-binding (net als `showDescription`/`showApproved`). Een al one-sided block
(`added`/`removed`) heeft geen andere kant om te verbergen/tonen — de toggle
heeft daar geen effect, `singleSide(b)` blijft leidend (`effectiveOnly` in
`Block.mjs`'s `codeDiff`). Gelezen als `viewMode()` binnen `Block()`'s eigen
per-kaart `${() => codeDiff(...)}`-slot (niet in de outer per-kolom closure van
`home.mjs`) — mirrort hoe die slot al op `b.code` leest, dus een toggle
her-rendert alleen de diff-structuur van elke zichtbare kaart, niet de
kaart-bouwende closures zelf.

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
