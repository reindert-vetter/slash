# Toetsenbord-navigatie (twee modes)

De keyboard-flow zit in `home.mjs` (`onKeydown`) en heeft twee modes via
`state.mode`.

## De links→rechts navigatieketen (`←`/`→` door de hele layout)

Los van de losse mechanismen hieronder vormen `←`/`→` samen één doorlopende
keten van **stops**, van links naar rechts over de hele layout:

1. **Omschrijving** (`prInfoCard`/`state.showDescription`) — de PR-titel/
   samenvatting/beschrijving. **Standaard verborgen** (neemt dan geen breedte
   in — de kolom valt volledig weg, geen rail zoals de comments/taken-sidebar's
   inklap) en de meest-linkse stop. `←` hier verlaat de hele keten naar
   `/pr-overview` (zie
   onder) — er is niets links van stop 1.
2. **PR-blok-index** (`data-testid=pr-index`, de sidebar, `state.mode==='list'`)
   — schuift fysiek naar rechts zodra stop 1 open is, zodat de omschrijving er
   echt links van staat i.p.v. erna (zie `.claude/rules/detail-layout.md`).
3. **Blok met diff** (`state.mode==='diff'`, `state.focusLevel===0`).
4. **Gedrilde kolommen** (`state.drill`/`focusLevel>0`) — een **zijtak**, geen
   strikte stop: alleen bereikbaar via Enter/klik op een Onderliggende-code-kind
   (zie "Drillen" in `.claude/rules/detail-layout.md`), niet via `→`. `←` pelt
   ze wel één voor één terug af, net als de andere stops.
5. **Onderliggende code** (`RelatedPanel`, `cs.focus==='code'`) — de meest-
   rechtse stop van deze keten; er is geen `→`/`←`-stop erna.

**Comments en Taken zijn geen stops meer in deze keten.** Ze vormen samen een
losstaande, **Cmd+→-getoggelde** vaste sidebar (`CommentsSidebar`, zie
"Comments/taken-sidebar" in `.claude/rules/detail-layout.md`) die je vanuit
**elke** positie in de app kunt openen/sluiten, ongeacht welke stop van de
keten hierboven op dat moment de keyboard heeft. Binnen die sidebar lopen
`↓`/`↑` tussen comments (boven) en taken (eronder, gestapeld); `←` sluit vanaf
elke plek in de sidebar in één klap terug naar de diff (de sidebar zelf blijft
open — alleen de keyboard-focus verlaat 'm). Zie die sectie voor het volledige
mechanisme (`toggleSidebar`/`cs.sidebarOpen`/de hint-rail).

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
in de diff, kind in Onderliggende code). Concreet, met de aanpassingen die dit
vereiste t.o.v. het oudere per-mechanisme gedrag:

- **Stop 1 ↔ 2:** `←` in `'list'`-mode (buiten de zoekbox) opende vroeger de
  zoekbox (`activateSearch()`); dat is nu **de omschrijving openen**
  (`state.showDescription = true`). `→` vanuit de omschrijving sluit 'm weer
  (`state.showDescription = false`) en geeft de blok-index de keyboard terug.
  Terwijl de omschrijving open is doet `↑` niets; `↓` geeft — als er PR-brede
  comments zijn — de keyboard aan het **PR-brede-comments-blok** onder de kaart
  (zie de aparte sectie "PR-brede comments, stop 1" verderop); zonder zulke
  comments is `↓` ook een no-op (geen interne cursor om te lopen anders) — dat
  voorkomt dat ze de block-selectie eronder verschuiven.
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
  `exitRelated()`. `→` vanuit `'code'` doet niets meer — dat sprong vroeger
  door naar de comments-kolom (`gotoRow(1)`), maar die is geen stop meer in
  deze keten (zie hierboven en "Comments/taken-sidebar" in
  `.claude/rules/detail-layout.md`); comments/taken zijn alleen nog via Cmd+→
  bereikbaar, vanaf elke stop.
- `state.showDescription`/`cs.taskSel`/`cs.sidebarOpen` leven bewust **buiten**
  de URL (net als `menu`/`ui.task` elders) — efemere cursor-state, geen
  navigatiepositie die een refresh moet terugzetten.

### PR-brede comments, stop 1 (`PrWideComments`, `handlePrWideKey`)

Onder de PR-omschrijving-kaart (stop 1) zit een tweede kaart
(`data-testid=pr-wide-comments`, zie "PR-brede comments" in
`.claude/rules/detail-layout.md`) met de PR-brede comments (`kind !== ''` —
GitHub-issue-/review-comments zonder regel-anker). Die heeft een **eigen**
cursor `pw` (`RelatedPanel.mjs`, los van `cs.focus`/`cs.sel` van het
blok-gescopeerde comments/taken-paneel en los van `state.showDescription`
zelf) en een eigen keyboard-handler, `handlePrWideKey(key)`, aangeroepen
vanuit `home.mjs`'s `onKeydown` **zolang `state.showDescription` waar is** —
vóór alle generieke shortcuts (`Enter`-opent-menu, `/`, `f`/`d`/`s`), zodat die
niet per ongeluk een toetsaanslag inpikken terwijl dit blok de keyboard heeft
(zelfde volgorde-precedent als `relatedActive()` verderop in `onKeydown`).
`isPrWideFocused()` (`pw.focus !== null`) bepaalt of dit blok momenteel de
keyboard bezit:

- **`↓` vanuit de omschrijving** (stop 1 zelf, `pw.focus === null`) geeft de
  keyboard aan dit blok — landt op de **eerste** entry (`pw.focus = 'item'`,
  `pw.sel = 0`) — mits er PR-brede comments zijn; anders een no-op (de
  omschrijving houdt de keyboard).
- **`↓`/`↑`** lopen, terwijl `pw.focus === 'item'`, de platte entry-lijst
  (`pw.sel`, geklemd op begin/eind); `↑` op de **eerste** entry geeft de
  keyboard terug aan de omschrijving (`pw.focus = null`) — mirror van hoe `↑`
  op de eerste regel van de blok-gescopeerde index terug naar de diff stapt.
- **`Enter`** op een entry (`pw.focus === 'item'`) opent zijn thread
  (`pw.focus = 'thread'`, `pw.threadPos = 0`, reply-veld gefocust) —
  functioneel een klik op de rij. Binnen de thread lopen `↑`/`↓` de
  berichtgeschiedenis (`pw.threadPos`, mirror van `cs.threadPos`); `↓` op de
  onderkant (`pw.threadPos === 0`, het reply-veld) stapt door naar de
  **volgende** entry (`pw.focus` terug naar `'item'`), als die bestaat.
  **`Enter` binnen de thread** is de ontdekbare resolve-snelkoppeling: een
  **leeg** reply-veld + `Enter` **resolvet** de comment (`done:true`, dezelfde
  `POST /signals/reply` als de resolve-knop); een **niet-leeg** veld + `Enter`
  wordt afgehandeld door het veld z'n eigen `@keydown` (verstuurt de reply,
  `done:false`) — de globale `handlePrWideKey('Enter')`-tak doet in dat geval
  bewust niets (de `pwComposeEmpty()`-guard), dus geen dubbele send. Shift+Enter
  blijft een newline (de globale handler negeert `Enter` met `e.shiftKey`).
- **`←`** stapt, van waar dan ook binnen dit blok (`pw.focus !== null`), één
  niveau terug: uit een thread naar de rij-focus (`pw.focus = 'item'`), en
  vanaf de rij-focus terug naar de omschrijving (`pw.focus = null`) — de
  omschrijving blijft daarbij gewoon open (dit is geen stop-overgang, alleen
  een interne terugstap). **Pas** wanneer dit blok géén focus heeft
  (`pw.focus === null`, dus terug op de omschrijving zelf) valt `←` door naar
  de bestaande stop-1-`←`-afhandeling in `onKeydown` (weg naar `/pr-overview`,
  zie "Vóór stop 1" hierboven) — `handlePrWideKey('ArrowLeft')` geeft dan
  `false` terug en de aanroeper (`onKeydown`) doet zelf de navigatie.
- **`Escape`** sluit dit blok's focus in één klap (`pw.focus = null`), net als
  `←` vanuit de rij-focus, maar in één stap ongeacht hoe diep je zat (thread of
  rij).
- **`Enter` op stop 1 zelf** (de omschrijving-kaart, `pw.focus === null`) blijft
  ongewijzigd het **PR-brede** command-menu openen (zie hieronder) — dit blok
  claimt `Enter` alleen zolang het zelf de focus heeft.

Reply/resolve gaan via **hetzelfde** `POST /api/workflows/{runId}/signals/reply`-
Signal als het blok-gescopeerde comments-paneel — zie "Reviewer-goedkeuring
persisteren"/"De eerste slash-task" in `.claude/rules/tembed-workflows.md` voor
het onderliggende `task_code_comment`-mechanisme; er is hier geen aparte
write-weg nodig (de backend behandelt een PR-brede reply/resolve al correct).

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
hele block-kolom — de `data-pane`-hook zit op `codePane` in `Block.mjs`). **Vanuit
de blokken-index** (`state.mode==='list'`, voor de `'block'`- en
`'postApprove'`-palettes — `isIndexMenu()` in `home.mjs`) ankert het menu i.p.v.
daarop juist op de **geselecteerde sidebar-rij** (`[data-idx="${state.selected}"]`)
en neemt het de **volle sidebar-breedte** (`[data-testid="pr-index"]`) — niet de
list-mode diff-preview in `<main>`, die weliswaar ook een `[data-change-active]`
draagt maar niet is waar de reviewer net op drukte. Zo opent `Enter` vanuit de
index het menu **bij die rij**, niet ergens anders op het scherm. **Op stop 1**
(het PR-brede `'pr'`-menu terwijl `state.showDescription` waar is —
`isDescriptionMenu()` in `home.mjs`, geldt voor zowel `Enter` als `/` daar)
ankert het menu op de **omschrijving-kaart** (`[data-testid="pr-info-card"]`)
en neemt het de **volle breedte van de omschrijving-kolom**
(`[data-testid="pr-info-column"]`, 26rem) — mirror van de blokken-index-
uitzondering; omdat de kaart hoog is klapt het menu daar meestal boven/over de
kolom (de bestaande flip+clamp), maar altijd bíj de omschrijving i.p.v. bij de
diff-regio rechts. Buiten stop 1 houdt het `'pr'`-menu (`/`) gewoon de
default-diff-positionering. Test: `tests/pr-description-menu.spec.mjs`. **Past het
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
**`focusLevel`/`drillCursor`-bewust:** een gedrilde Onderliggende-code-kolom
(`state.focusLevel > 0`, zie "Drillen"/"Kolom-navigatie" in
`.claude/rules/detail-layout.md`) heeft zijn eigen block + eigen
`change`/`gran`-cursor (`state.drillCursor[focusLevel-1]`) — de approve-actie
moet dáár op werken, niet op het top-level block. `approveContext()` (`home.mjs`)
resolvt dat ene keer (`{ block, mode, gran, change }`, mirror van
`findNextUnapproved`/`fKey`/`dKey`/`setDrillGran`'s eigen `focusLevel`-branch);
`approveNoun`/`approveTargetRows`/`toggleApprove`/`toggleCallApprove` en het
`COMMANDS`-label nemen die context aan i.p.v. rechtstreeks `curBlock()`/
`state.gran`/`state.change` te lezen. Zonder dit keurde `Enter` → "Keur …
goed" terwijl een gedrilde kolom de keyboard had onzichtbaar het TOP-LEVEL
block goed/af in plaats van de gedrilde child — zie
`tests/drill-approve.spec.mjs`.
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
gewoon dicht, zoals altijd). "Volgende" volgt de review-**boom**, niet enkel de
platte sidebar-lijst, depth-first (`findNextUnapproved` in `home.mjs`, vier
stappen op elke aanroep):

1. **Verder binnen de kolom die de keyboard nu bezit** — het top-level block
   (`state.gran`/`state.change`), of — als er gedrild is (zie "Drillen"/
   "Kolom-navigatie" in `.claude/rules/detail-layout.md`) — de gedrilde kolom
   op `state.focusLevel`, met zíjn eigen `state.drillCursor`-cursor
   (`firstUnapprovedOwnUnit`, ongewijzigd voorwaarts-zoekend op de huidige
   granulariteit, nu ook toegepast op een gedrilde kolom in plaats van alleen
   het top-level block).
2. **Is die kolom klaar, dan omlaag** in zijn **Onderliggende-code**-kinderen
   (`orderedChildBlocks` — dezelfde volgorde als het paneel toont,
   `relatedChildren`'s groupTier/prio/grootte-sort, exclusief `covered_by` om
   de method↔test-cyclus te vermijden — zie `directChildBlocks`/
   `nestedPrBlocks` in `.claude/rules/blocks-and-ingest.md`), depth-first per
   kind (`firstUnapprovedInSubtree`, cyclus-veilig via een `seen`-set, mirror
   van `nestedPrBlocks`): eerst het kind zelf vanaf zijn eerste `'group'`-unit,
   anders zijn eigen kinderen, enzovoort.
3. **Is de hele subtree van de gefocuste kolom leeg, dan omhoog**: terug naar
   de ouder in de huidige drill-stack (een eerdere gedrilde kolom, of het
   top-level block) en diens **volgende, nog niet geprobeerde** sibling-kind
   proberen (weer depth-first via `firstUnapprovedInSubtree`) — herhaald
   omhoog door de hele drill-stack.
4. **Is ook de hele subtree van het huidige top-level block leeg** (of stond
   de reviewer niet eens in zijn diff), dan **verder door `state.blocks`** in
   sidebar-volgorde — nu ook **subtree-bewust** (`firstUnapprovedInSubtree`
   per kandidaat i.p.v. alleen zijn eigen `'group'`-rijen): een top-level block
   waarvan alleen een Onderliggende-code-kind nog openstaat wordt niet meer
   overgeslagen.

Met lazy `ensureCode`-fetches voor elk bezocht block, net als de
look-ahead-preview. Alleen **voorwaarts**, geen wrap en geen terugzoeken naar
eerder overgeslagen units. `findNextUnapproved` retourneert een plan
`{ root, path, gran, change }` (`root` = top-level index, `path` = de keten
PR-blokken om doorheen te drillen, leeg = het top-level block zelf) en stasht
het in `postApproveTarget`; "Ga door" past 'm toe via `applyNextUnapproved`,
dat de huidige `state.drill` naar het gemeenschappelijke voorvoegsel met
`path` trimt (mirror van `expandColumn`'s trim) en dan alleen het resterende
stuk drilt (`drillIntoChild`) — zonder de hele stack onnodig af te breken bij
een naaste sibling-stap. Bij een andere `root` (een ander top-level block)
reset hij zoals voorheen (`openTask`'s block-wissel-reset: `state.drill`/
`drillCursor`/`focusLevel` leeg). Dit alles zonder te herberekenen — de
palette bezit de keyboard zolang hij open is, dus de navigatie-state kan
intussen niet verschoven zijn. Dit is een eenmalige stap: na het navigeren
opent er **geen** nieuw vervolgmenu vanzelf — de reviewer keurt de nieuwe unit
zelf weer goed met `Enter`.

**Vanuit de blokken-index blijft "Ga door" in de index.** Drukte de reviewer
`Enter` terwijl `state.mode==='list'` was (zie hierboven: het menu ankert dan al
op de sidebar-rij, niet de diff-preview), dan zou het oude "Ga door" alsnog de
diff instappen — dat voelt als een sprong weg uit de index terwijl je daar net
zat. `afterApproveAction` capture't daarom **synchroon**, vóór de async
`findNextUnapproved()`-gap, `keepList = state.mode !== 'diff'` en stasht die mee
in `postApproveTarget` (`{ ...target, keepList }`) — synchroon omdat
`state.mode` tegen de tijd dat de promise resolvet al kan zijn veranderd, maar
op het moment van de approve-actie zelf nog exact de context is waar de
reviewer 'm vandaan drukte. `applyNextUnapproved` vertakt op `target.keepList`:
waar, dan verzet 'm **alleen** `state.selected` (naar `target.root`) +
`scrollSelectedIntoView()` — `target.path` wordt genegeerd (géén `state.mode`/
`gran`/`change`, geen diff-instap, geen drill), dus zelfs als het gevonden plan
door een Onderliggende-code-kind zou lopen blijft "Ga door" vanuit de index bij
de platte lijst-stap staan — drillen heeft alleen betekenis eenmaal in de
diff. Onwaar, dan het bestaande pad (drilt zo nodig naar `target.path` en
springt de diff van de nieuwe unit in). Het `POSTAPPROVE_COMMANDS[0]`-label
is om die reden ook een **functie** (i.p.v. de vorige kale string), gelezen op
snapshot-tijd (`openMenu` → `snapshotCommands`, vlak nadat `postApproveTarget`
gezet is — dezelfde veilige, niet-reactieve timing als het `approve`-label): "Ga
door naar het volgende niet-goedgekeurde **block**" bij `keepList`, anders de
bestaande "... **code**"-tekst.

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
comment, maar een menu met vijf keuzes wat ermee moet gebeuren: **"Plaats
comment"** (het **default/eerste** item — het menu opent met `ms.sel` op 0,
dus "typ, Enter, Enter" plaatst 'm nog steeds net zo direct als voorheen),
*Claude commando* (placeholder), *Laat Claude dit implementeren
(groep/regel/call)* — placeholder, label benoemt de huidige unit via
`granNoun()` uit `commentTarget()` —, *Alleen voor mijzelf* en *Jira* (een
submenu met *Comment op ticket* / *Subtaak aanmaken* / *Nieuwe taak aanmaken*,
alle drie placeholder). **"Plaats comment"** en **"Alleen voor mijzelf"**
plaatsen allebei écht: `placeComment(state, commentTarget)` resp.
`placeComment(state, commentTarget, { local: true })` — het eerste post een
**normale, publieke** comment (dezelfde bestaande `createComment`-weg, gewoon
zonder `opts.local`), het tweede een **privé-notitie** die wél als comment
wordt opgeslagen maar niet naar GitHub gaat (zie de `local`-vlag in
`.claude/rules/tembed-workflows.md`). Beide `run`-functies zijn `async` en
roepen na een geslaagde `placeComment` meteen `pollWorkflows()` aan — zonder
dat verschijnt de net gestarte `task_code_comment`-run pas op de eerstvolgende
`WORKFLOWS_POLL_MS`-tick (2.5s) in de Taken-kolom (`workflows-panel`, zie
`.claude/rules/detail-layout.md`) i.p.v. meteen. De Claude/Git/Jira-items
blijven placeholders (geen `pollWorkflows`-aanroep, ze schrijven niets). De
Enter-tak zit in `onKeydown` **vóór** de `relatedActive()`-tak
(`isComposeOpen()` + `composeHasText()`, beide uit `RelatedPanel.mjs`), zodat
hij werkt of de composer nu via toetsenbord (`cs.focus==='new'`) of via de
knop geopend is; **Shift+Enter**
valt erbuiten en blijft dus een newline in de composer. Belangrijk: dit was de
eerste flow die een menu **over** de open composer opent — daardoor kwam een
latente arrow.js-wees-binding-bug boven (menu-heropen-crash), opgelost met de
verse-`ms`-state-split, zie `.claude/rules/conventions.md`.

**`/`** opent een **algemeen, PR-breed tree-menu** (`menu.mode = 'pr'`,
`PR_COMMANDS` in `home.mjs`) — hetzelfde `CommandMenu`-overlay als `Enter`, maar
i.p.v. block-acties zijn dit acties op de **hele PR**. Vier root-items: **"Naar
PR-overzicht"** (navigeert naar `/pr-overview`), **"GitHub"** en **"Jira"** (de
middelste twee als **submenu** via het bestaande `children`-mechanisme), en
**"Toon volledige omschrijving" / "Omschrijving inklappen"** (het laatste item,
een label-functie die `state.descriptionExpanded` toggelt — dezelfde efemere vlag
als de in-card "meer…"-affordance in de PR-info-kolom, zie
`.claude/rules/detail-layout.md`; het label wordt op open-tijd één keer
gesnapshot door `snapshotCommands`, dus geen reactieve binding lekt de
`CommandMenu`-boom in). Onder
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
  **`↑`/`↓` slaan een verborgen (goedgekeurd) blok over** (`stepVisibleSelected`
  in `home.mjs`, gebruikt door zowel de gewone als de zoekbox-actieve
  ArrowDown/ArrowUp-tak): `state.selected` is een raw index in `state.blocks`,
  maar `BlockList.mjs`'s `renderList` rendert géén rij voor een verborgen
  (goedgekeurd) blok. Zonder deze stap landde `state.selected` soms op zo'n
  onzichtbare index — geen rij in de sidebar toonde de indigo-highlight,
  wat aanvoelde als "dit blok is niet meer selecteerbaar", vooral na veel
  ↓/↑ diep in een reviewsessie met meerdere al-goedgekeurde blokken. Is er in
  die richting geen zichtbaar blok meer, dan blijft de selectie op de huidige
  (al zichtbare) positie staan i.p.v. op de verborgen staart te landen.
  **Hetzelfde gat bestond op de load-/zoek-paden, en die lossen het elk anders
  op** (`revealSelectedIfHidden`/`clampSelectedToVisible` in `home.mjs`):
  - **Load/refresh-restore → onthullen.** Een refresh herstelt `?sel=file:line`
    óók naar een verborgen blok (`applyBlockRefRestore`) — dat is de **eigen**
    positie van de reviewer, dus i.p.v. de selectie weg te verplaatsen klapt
    `revealSelectedIfHidden` de goedgekeurde sectie open
    (`state.showApproved = true` + `scrollSelectedIntoView`): het blok wordt
    zichtbaar en blijft geselecteerd/gehighlight. Al zichtbaar → no-op.
  - **Zoeken → clampen.** `setSearch` reset naar index 0 — een synthetische
    landing, niet de eigen positie van de reviewer. Typen mag nooit ineens
    alle goedgekeurde blokken PR-breed onthullen (en typt niet terug dicht),
    dus daar verplaatst `clampSelectedToVisible` de selectie naar de **eerste
    zichtbare** match (geen zichtbaar blok → selectie blijft staan, mirror van
    `stepVisibleSelected`; de zoekfilter zelf hoeft geen aparte check — een
    weggefilterd blok zit überhaupt niet meer in `state.blocks`).
  Beide gebruiken exact hetzelfde `isFullyApproved`-criterium als `renderList`.
  Volgorde is load-bearing: op het load-pad draait de reveal pas **ná**
  `applyBlockRefRestore` (een herstelde `?sel=` naar een zichtbaar blok is een
  no-op) én nadat `loadBlocks` `loadApprovals`/`loadBlockStats` ge-await
  heeft plus een paar microtask-ticks zodat de `approvalSummaries`-watch
  geflusht is (het `openTask`-precedent) — eerder is "verborgen" nog niet
  kenbaar en zou de reveal een no-op zijn. De **live** approve-flow blijft
  bewust ongemoeid: een blok goedkeuren terwijl je erop staat houdt het
  geselecteerd (er hangt géén reveal/clamp aan de `approvalSummaries`-watch
  zelf). Regressietest: `tests/selected-reveal-hidden.spec.mjs`.
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
  block-kolom náást de kaarten gerenderd). Het slot dat dit chevron toggelt
  (`stepChevronSlot`) heeft bewust een **stabiele element-root** (een statische
  `display:contents`-wrapper) — een kale keyed `${…}`-wrapper liet hier de
  chunk-`ref` stale gaan en corrumpeerde de keyed reconcile van de
  block-kolom (verdwijnende preview-kaart + tab-hang bij herhaald ↓/↑ door
  same-file blocks); zie de "kale toggelende expressie"-valkuil in
  `.claude/rules/conventions.md`. Dit staat los van het **groene
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
**`↑`** i.p.v. verder terug naar de diff (`exitRelated`). **`←`** gaat vanaf elk
blokje terug naar de diff (`exitRelated`). Deze kaart heeft geen `→` meer die
'm verlaat — dat sprong vroeger naar de comments-kolom, maar comments/taken
zitten niet meer in deze keten (zie hierboven en "Comments/taken-sidebar" in
`.claude/rules/detail-layout.md`); die zijn alleen nog via Cmd+→ bereikbaar.
Deze paneel-cursor
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
gedrilde-kolom-state opruimt). Elke kolom die daarbij niet de focus heeft klapt
in tot een smalle rail (icoon + afgekapt label); een **muisklik op zo'n rail**
is een snelkoppeling die functioneel hetzelfde doet als herhaald `←` — het
springt direct naar dat niveau (`expandColumn`) en gooit alles wat verder
gedrild was weg. Zie de sectie
"Kolom-navigatie" in `.claude/rules/detail-layout.md` voor het volledige
`state.focusLevel`-mechanisme + de rail. `←`/`Escape` vanaf de eerste positie van het
Onderliggende-code-paneel (`cs.codeSel === 0`) geeft de keyboard-focus terug aan
de diff van **diezelfde** kolom (`handleRelatedKey`'s `exitRelated()`) — dat is
geen aparte "pop"-stap meer, de kolom-voor-kolom-navigatie hierboven volgt pas
zodra `relatedActive()` weer `false` is. Deze code-tak (`cs.focus === 'code'`)
is volledig losstaand van de comments/taken-sidebar in `handleRelatedKey` —
zie "Comments/taken-sidebar" in `.claude/rules/detail-layout.md` voor die
navigatie. Visueel: alle blokjes staan verticaal onder elkaar op volle
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
`prevChange`). Een gedrilde kolom is een op zichzelf staande diff, dus er
bestaat geen same-file buurblock om op `'call'` aan de eerste/laatste call
doorheen te stromen — maar wél een **sibling**: loopt `f`/`↓` (of `d`/`↑`)
voorbij de laatste (resp. eerste) call van de kolom, dan stapt de kolom
zijwaarts naar de volgende/vorige child in de Onderliggende-code-lijst van de
**parent**-kolom (op elk niveau, elke granulariteit — niet alleen `'call'`), en
**vervangt** zichzelf daarmee op dezelfde diepte, i.p.v. terug te zoomen naar
`'line'` zoals voorheen. Alleen als er géén sibling meer is (of nooit was — een
enige child) zoomt `f`/`d` alsnog terug naar `'line'`, zoals vanouds. Zie de
"Kolom-navigatie"-sectie in `.claude/rules/detail-layout.md`
(`drillSiblingContext`/`drillToSibling`) voor het volledige mechanisme,
inclusief de ↑-symmetrie (landt op de vorige sibling's láátste unit, mirror van
`stepBlock`) en de aangepaste `dKey`-guard. Verfijn je een groep die precies
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

## `a` — diff-weergave toggelen (side-by-side ↔ alleen nieuw, 60% breed)

**`a`** toggelt globaal, voor **elke zichtbare diff-kaart tegelijk** — de
geselecteerde/preview-kaart én elke open gedrilde kolom (`state.drill`) — tussen
de bestaande side-by-side weergave (oud+nieuw, default) en een **alleen-nieuw**-
weergave (enkel de rechter/nieuwe pane). Staat naast `f`/`d`/`s` in `onKeydown`
(`home.mjs`), dus met dezelfde eerdere guards (command-palette/zoekbox/
related-panel actief) ervoor — werkt zowel in `'list'`- als `'diff'`-mode.
**Extra guard, los van die bestaande guards:** `relatedActive()` (`cs.focus !==
null`) dekt niet elk pad waarop een tekstveld de DOM-focus heeft — `startComment()`
(o.a. het command-palette-fallback "Maak hiermee een comment") zet alleen
`cs.composing`, niet `cs.focus`, dus `relatedActive()` blijft daar `false` terwijl
de composer wél focus heeft. Een letterlijke "a" die je daar typt zou anders door
deze shortcut worden opgegeten. Vandaar checkt de `a`-handler ook rechtstreeks
`document.activeElement` (`isEditableFocused()` in `home.mjs`: TEXTAREA/INPUT →
shortcut doet niets, toets vloeit gewoon het veld in) — een generieke,
toekomstvaste guard die niet afhangt van welke navigatie-state een veld toevallig
wel/niet bijhoudt.

De state (`state.diffViewMode`, `'split'`/`'new'`) is efemeer, geen URL-binding
(net als `showDescription`/`showApproved`). Een al one-sided block
(`added`/`removed`) heeft geen andere kant om te verbergen/tonen — de toggle
heeft daar geen effect op de **pane-keuze**, `singleSide(b)` blijft leidend
(`effectiveOnly` in `Block.mjs`'s `codeDiff`). Een **echt tweezijdig**
(`modified`) block klapt in `viewMode==='new'` wél in tot zijn nieuwe pane
(`forcedNewOnly(b, viewMode)` in `Block.mjs` blijft de voorwaarde hiervoor).

**Maar de kaart-breedte volgt alleen nog `viewMode()`, niet `singleSide`:**
zodra `viewMode()==='new'` krimpt **elke** zichtbare kaart naar **60% breedte**
(`w-[42rem] 2xl:w-[49.2rem]` i.p.v. `w-[70rem] 2xl:w-[82rem]`) —
`modified`/`added`/`removed` allemaal gelijk, plus elke preview/look-ahead-
kaart en elke gedrilde kolom (ze delen allemaal dezelfde `Block()`-component +
dezelfde `viewMode`-opt). Dit was eerder beperkt tot het tweezijdige geval
(een eenzijdig block hield bewust zijn volle breedte, zie de
breedte-stabiliteitsregel in `.claude/rules/detail-layout.md`); de reviewer
wil nu dat `a` **alles** even smal maakt zolang hij aanstaat, ongeacht
block-type. De simpele `narrowed(viewMode)` in `Block.mjs` (enkel
`viewMode()==='new'`, geen `singleSide`-check) is de voorwaarde achter de
breedte-ternary; `forcedNewOnly` blijft losstaand de voorwaarde voor de
pane-keuze — de twee kunnen dus uiteenlopen (een eenzijdig block: `narrowed`
waar, `forcedNewOnly` onwaar) en dat is bewust zo.

Gelezen als `viewMode()` binnen `Block()`'s eigen per-kaart `${() =>
codeDiff(...)}`-slot (niet in de outer per-kolom closure van `home.mjs`) —
mirrort hoe die slot al op `b.code` leest, dus een toggle her-rendert alleen de
diff-structuur (via `forcedNewOnly`) en de breedte (via `narrowed`) van elke
zichtbare kaart, niet de kaart-bouwende closures zelf. De breedte-ternary zit
in dezelfde kaart-brede `${() => ...}`-`class`-binding als `diffActive()`/
`preview` (al reactief, de hele waarde in één keer — geen
deel-string-interpolatie, zie de arrow.js-class-binding-valkuil in
`conventions.md`).

## Generieke input-focus-guard (typen in een veld mag nooit door een shortcut worden opgegeten)

`relatedActive()` (`cs.focus !== null`) is de bestaande "vangnet"-branch die
onbedoelde shortcuts al onderdrukt zolang een tekstveld (composer/reply) via de
juiste weg is geopend — dat blok eindigt onvoorwaardelijk in een `return`, dus
elke toets die er niet expliciet in gematcht wordt (letters, `/`, ongematchte
Enter-varianten) vloeit gewoon door naar het gefocuste veld. Maar dat vangnet
werkt alleen als `cs.focus` daadwerkelijk in lockstep staat met de echte
DOM-focus. Eén concrete plek waar dat niet zo was: de "+ Comment op deze
regel"-knop (`data-testid=new-comment`, `RelatedPanel.mjs`) opende de composer
ooit met een kale `cs.composing = !cs.composing`-toggle, zonder `cs.focus` te
zetten — een klik erop terwijl `cs.focus` toevallig niet al `'new'` was, opende
dus een gefocust tekstveld terwijl `relatedActive()` `false` bleef. `onKeydown`
had dan geen enkel signaal dat er een editable veld met DOM-focus was, en
`s`/`d`/`f`/pijltjes/`/` werden als globale shortcuts afgevangen in plaats van
in het veld te belanden (de reviewer kon niet meer typen). Gefixt door de knop
via `openComposer()` (`toNew()`) te laten openen — precies dezelfde route als
elk ander pad naar deze composer (`toNew`/`startComment`), die `cs.focus` en
`cs.composing` altijd samen zet.

Als **extra, toekomstvaste laag** (voor elk ander/toekomstig invoerveld waarvan
de eigen app-state-focus-vlag ooit niet in sync blijkt met de echte DOM-focus —
zoals hierboven) checkt `onKeydown` na de `relatedActive()`-branch, vóór `/`,
nog één keer rechtstreeks `document.activeElement`
(`isEditableFocused()` — dezelfde helper als de `a`-guard hierboven): staat de
DOM-focus op een TEXTAREA/INPUT en heeft geen eerdere branch de toets al
geclaimd, dan doet geen enkele resterende globale shortcut (`/`, `f`/`d`/`s`,
`a`, pijltjes, de block-palette-Enter) iets — de toets vloeit gewoon het veld
in. **`Escape`** is binnen deze fallback de expliciete "haal me eruit"-toets
(roept `leaveRelated()` aan — blur + `cs.focus = null` + `cs.composing =
false`, mirror van `handleRelatedKey`'s Escape-afhandeling in de
`relatedActive()`-branch). **`Tab`** krijgt bewust geen eigen afhandeling: de
browser verplaatst de DOM-focus native naar het volgende focusbare element,
waarna de eerstvolgende toetsaanslag deze tak sowieso niet meer raakt (`isEditableFocused()`
is dan `false`). De zoekbox (`BlockList.mjs`) heeft dit patroon al langer op
zijn eigen, nog directere manier: `@focus`/`@blur` zetten `state.searchActive`
rechtstreeks op echte DOM-focus (geen los toggle-pad), dus die hoeft niet op
deze fallback te leunen.

## Footer: inline preview van de geselecteerde regel + AI-omschrijving bij een if

Onder de panels zit een vaste footer (`src/Footer.mjs`, `data-testid=footer`).
Anders dan voorheen is de footer **niet** zichtbaar zodra er een diff open
staat — hij is alleen zichtbaar zodra er **daadwerkelijk iets te tonen is**:
`state.footerVisible` (afgeleid in `home.mjs`'s `updateFooter()` als
`!!(state.footerUnit || state.footerExplain)`, zie hieronder voor wat die twee
snapshots zijn). Een meerregelige groep zónder if-statement (geen
`footerUnit`, geen `footerExplain`) laat de footer-balk dus **volledig**
verdwijnen (`hidden` i.p.v. `flex` op de stabiele `<footer>`-root — de
class-string blijft één reactieve `class="${() => …}"`-functie-binding, dus
geen keyed-node-valkuil, zie `.claude/rules/conventions.md`) in plaats van een
lege balk te tonen zoals voorheen. `footerUnitInfo` (`home.mjs`) blijft buiten
`state.mode==='diff'` `null` retourneren, dus `footerVisible` is in list-mode
altijd `false` — dat gedrag is dus ongewijzigd, alleen strenger binnen
diff-mode zelf.

**Ruimte-reservering volgt dezelfde vlag, 3-weg in plaats van de oude vaste
90/140px-vloer:** `DetailPanel`/`<main>` (`home.mjs`) en de comments/taken-
sidebar + collapsed hint-rail (`RelatedPanel.mjs`) reserveren `bottom-6` (geen
reservering) zodra `!state.footerVisible`, `bottom-[90px]` zodra alleen de
inline diff toont, en `bottom-[140px]` zodra ook de AI-omschrijving toont — nu
verdwijnt de gereserveerde ruimte dus mee met de balk zelf, in plaats van
altijd minstens 90px leeg te laten staan. De pr-index (`BlockList.mjs`) en de
PR-info-kolom (`PrInfoPanel`, `home.mjs`) reserveren sinds deze wijziging
helemaal niets meer voor de footer (`bottom-6`, was een vaste, nooit-reactieve
`bottom-[90px]`) — beide zijn alleen in list-mode zichtbaar, waar de footer
sowieso nooit toont, dus die reservering was al dode ruimte.

De theme-toggle zit niet in de footer — zie "Thema" in
`.claude/rules/conventions.md` (een smalle rij in `prInfoCard`, boven de
PR-samenvatting; de oudere `ThemeToggleCorner` — een altijd-zichtbaar fixed
element linksonder — bestaat niet meer).

**Los van de zichtbaarheid van de balk zelf** toont de footer een inline diff
(`- oud` / `+ nieuw`, Prism-highlighted) alleen als de **geselecteerde unit
precies één regel** beslaat — een meerregelige groep mét een if-statement toont
dus wél de balk (voor de AI-omschrijving) maar geen inline-diff-inhoud.
Deze inline-diff-inhoud volgt de **gefocuste kolom en diens huidige
granulariteit/cursor** — het top-level block (`state.gran`/`state.change`) op
`focusLevel 0`, of de eigen `state.drillCursor[focusLevel-1]`-cursor van een
gedrilde kolom (zie "Kolom-navigatie" in `.claude/rules/detail-layout.md`) —
via dezelfde `unitsFor(rows, gran)` als de navigatie: omdat een `'line'`- of
`'call'`-unit altijd één rij is,
verschijnt de inline diff dus altijd zodra je met `f` tot één regel (of één
edit) verfijnt. Lange regels (>`WIDE_AT`
tekens) laten de `max-w` los zodat de footer de volle breedte gebruikt. Op
`'call'`-niveau onderstreept de footer het **actieve segment** in dezelfde
indigo als de panes via het geëxporteerde `markChars` +
`UNDERLINE_CLS` (uit `Block.mjs`) — precies die tekens onderstreept (op
`'group'`/`'line'` hebben de units geen set → geen underline).

**De footer leest zelf géén `blockRows`/`b.code` meer.** `home.mjs` heeft een
eigen, ontkoppelde footer-`watch` (het `setRelated`/`setCommentScope`-patroon,
inline deps incl. `state.drillCursor` en `focusedBlock().code`) die twee platte
snapshots pusht: `state.footerUnit` (de ene aligned rij + underline-arrays van
de actieve unit, `null` bij meerregelig) en `state.footerExplain` (zie
hieronder), en daarna in dezelfde `updateFooter()` de afgeleide
`state.footerVisible` zet. Zo wordt de footer nooit een co-subscriber op de
code van het gefocuste block (de "stuck on loading"-race, zie
`conventions.md`) én volgt hij gratis de gedrilde-kolom-cursor.

**AI-omschrijving bij een if-statement (`data-testid=footer-description`):**
bevat de tekst van de gefocuste **`group`- of `line`-unit** (nooit `call`, en
alleen in diff-mode) een `if`/`elseif`/`else if` (`reIfStatement` in
`home.mjs` — een kale regex op de regeltekst, false-positives in
strings/comments bewust geaccepteerd), dan toont de footer boven de inline
diff een korte Nederlandse AI-uitleg van wat de conditie controleert en
wanneer de tak loopt. Die komt uit het `explanations`-read-model
(`GET /api/explanations?pr=N`), gegenereerd door het **`explain_code`**-workflow
(Haiku, context-only — zie `.claude/rules/tembed-workflows.md`). De generatie
start **automatisch** met een debounce (`EXPLAIN_DEBOUNCE_MS`, 600ms — doorheen
pijlen vuurt niets) via `POST /api/workflows/explain_code`, client-side
gededupt (`explainRequested`) én server-side idempotent (deterministische Run
ID per unit+code-hash, `StartWorkflowID`). Zolang de run loopt toont de regel
"AI-omschrijving genereren…" (pulserend); een `failed`-rij (offline,
`SLASH_CLAUDE=off`) verbergt de regel weer. De rij-match gaat op
`blockId|unitKey` (unitKey = `group-<start>-<end>`/`line-<row>`, dezelfde
codeRef-vorm als `commentPath`) plus een **code-hash-check** (`fnv1a` over
unit-code + context): een stale rij van vóór een nieuwe commit wordt genegeerd
en opnieuw gegenereerd; een geseede rij met lege hash matcht altijd
(test-fixtures). Terwijl de omschrijving toont groeit de footer van 90px naar
**140px** en reserveren `<main>` (`home.mjs`) en de comments/taken-sidebar +
hint-rail (`RelatedPanel.mjs`) reactief `bottom-[140px]` i.p.v.
`bottom-[90px]`, zodat niets achter de footer schuift. Zie
`tests/footer-explanation.spec.mjs` (incl. het gedrilde-kolom-geval).
