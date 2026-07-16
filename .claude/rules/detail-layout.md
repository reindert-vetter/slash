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
Jira-kadertje), en onderaan review/CI-pills — gestyled als de dark-zinc pills in
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

Daarna de **block-kolom** (`data-testid=block-column`,
**`shrink-0`** — niet `flex-1`, dus op zijn **natuurlijke diff-breedte**
(altijd `w-[70rem] 2xl:w-[82rem]`, óók voor een één-zijdig added/removed block —
dat laat weliswaar de lege pane weg (`singleSide` in `Block.mjs`) maar houdt
dezelfde breedte als een modified block, zodat de layout niet springt tussen
block-types) i.p.v. de resterende
ruimte op te vullen) met de kaart van het geselecteerde block plus de
look-ahead-preview van het volgende block (dashed connector als ze uit hetzelfde
bestand komen). **Direct náást** die kolom (niet aan de rechterrand van het
scherm) `RelatedPanel` (`src/RelatedPanel.mjs`, `data-testid=related-panel`).
Zo lijnt het comment/gerelateerd-paneel altijd tegen de diff aan.

De `RelatedPanel`-`<aside>` is zelf een **flex-row** (`flex-row items-start
gap-3`, geen vaste breedte meer): de kaart **Onderliggende code**
(`data-testid=related-code`, `w-[30rem] shrink-0`) staat **links** en het
**comment/taken-blok** (`data-testid=comments-panel`, `w-[36rem] shrink-0`)
**rechts ernaast** — niet meer eronder gestapeld. De `items-start` is
load-bearing: die voorkomt dat "Onderliggende code" verticaal wordt uitgerekt
naar de hoogte van het comment-blok. In combinatie met `max-h-full` op de
code-section blijft die zo hoog als zijn inhoud (korte lijst → korte kaart) maar
groeit hij bij veel onderliggende code tot de **volle beschikbare hoogte** en
scrollt dan intern (de body is `flex-1 min-h-0 overflow-auto`). Het comment-blok
houdt zijn eigen `max-h-[28rem] min-h-[16rem]` naast de code-kaart. Een **derde**
kolom, rechts van het comment-blok — `<section data-testid=workflows-panel>`,
titel **"Taken"** — toont de **workflow-runs van de huidige PR** (`state.workflows`,
gevuld door `pollWorkflows` in `home.mjs` via `GET /api/workflows?pr=N`, elke
2.5s). Dat endpoint is **read-only** (`RunsForPR` in `tasks_api.go` filtert
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
"no comments"-valkuil in diezelfde conventions-regel. `<main>`
scrollt horizontaal mee als de kolommen samen te breed worden.

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
`home.mjs` net als `drill` meegeeft in het `search`-options-object van
`RelatedPanel(state, commentTarget, { drill, openTask }, …)`. `openTask` (in
`home.mjs`) zoekt het block in `state.blocks` op `comment.file`+`comment.label`,
selecteert het, stapt de diff in op de opgeslagen granulariteit/rij-range
(`unitsFor`+`unitAtRow`, dezelfde walk als `setGran`), en selecteert tot slot de
comment zelf via `selectComment(runId)` (geëxporteerd uit `RelatedPanel.mjs` —
`runId` == de comment's id) zodra de comment-scope-watch heeft kunnen bijtrekken
(een paar `await Promise.resolve()`-ticks, nodig omdat arrow.js' `watch`
microtask-gedeferred draait — zie de watch-timing in `conventions.md`). Faalt
een stap (block/comment nog niet gevonden) dan doet `openTask` stil niets.

**Toetsenbord: de Taken-kolom is stop 7 van de nav-keten.** `cs.focus ===
'task'` (`RelatedPanel.mjs`) geeft de Taken-kaart de keyboard, bereikt via `→`
zodra comments (stop 6) nergens dieper heen kan — vanuit de lege composer
(`'new'`), of vanuit binnen een thread (`'thread'`), niet vanuit een gewone
comment-rij (die gaat eerst nog naar zijn eigen thread). Zie de sectie
"De links→rechts navigatieketen" in `.claude/rules/keyboard-navigation.md` voor
de volledige keten. `↑`/`↓` lopen `cs.taskSel` door de **actief-dan-klaar**-
volgorde (`taskRuns(state)`, exported uit `RelatedPanel.mjs` — dezelfde volgorde
als `workflowsSection` rendert, dus rij-index en keyboard-cursor komen altijd
overeen); de gefocuste rij krijgt een indigo ring (`data-active=true` op
`data-testid=workflow-row`). `←` gaat terug naar waar `→` vandaan kwam
(`preTaskFocus` in `RelatedPanel.mjs`: de composer, of dezelfde thread). `Enter`
(afgehandeld in `home.mjs`, niet in `RelatedPanel.mjs` — `openTask` leeft daar
omdat het de gedeelde navigatie-`state` aanstuurt) opent de gefocuste run net als
een klik erop; alleen zinvol voor een `task_code_comment`-run met een gekoppelde
comment, stil genegeerd voor de rest (zelfde `run.comment`-guard als de klik).
Een klik op een niet-klikbare rij landt de keyboard-cursor er nu ook op
(`toTask(i)`), zodat muis en toetsenbord dezelfde cursor delen.

**Inklappen bij comment/taken-focus:** samen met de diff-kolom is de
volle-breedte combinatie van alle drie kaarten soms te breed om alles tegelijk
te zien. Zodra de paneel-cursor (`cs.focus`) voorbij de Onderliggende-code-kaart
zit (`'new'`, `'comment'`, `'thread'` of `'task'` — `codeCardCollapsed()` in
`RelatedPanel.mjs`), klapt de Onderliggende-code-kaart in tot een smalle
verticale rail (`w-12`, geen titel/inhoud) met alleen een `</>`-code-icoon
(inline SVG, `data-testid=related-code-collapsed`). Staat de focus op `'code'`
of is er geen paneel-focus (diff/list heeft het toetsenbord) dan blijft de
kaart op volle breedte (`w-[30rem]`). Een klik op de rail roept `toCode()` aan —
dezelfde functie als een klik op een Onderliggende-code-item elders — en klapt
de kaart weer uit met de laatst-gekozen `cs.codeSel` nog intact. Verlaat de
focus de comments/taken (`←` herhaald terug naar de code-kaart, of terug naar
de diff), dan klapt hij vanzelf weer
uit omdat de conditie herevalueert.

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
arrow.js-valkuil in `.claude/rules/conventions.md`.

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
  De kaart is een **navigeerbare lijst**: `→` vanuit de diff selecteert het
  **eerste** blokje (`cs.codeSel=0`). Vanaf het eerste blokje stapt `→` naar het
  2e blokje en `↓` verlaat de lijst naar de comments; vanaf het 2e+ blokje lopen
  `↑`/`↓` langs de blokjes (zie `.claude/rules/keyboard-navigation.md`). Het
  geselecteerde blokje krijgt een indigo ring (`data-active=true`). Alle
  blokjes staan **verticaal onder elkaar** op volle breedte (geen
  pijltjes-hint meer — die is verwijderd). De kaart heeft **geen vaste
  hoogte-cap** (eerder `max-h-[40%]`): hij groeit met zijn inhoud mee en pakt
  alle verticale ruimte die de comments-kaart eronder niet nodig heeft; pas als
  beide samen niet passen krimpt hij (flex-shrink, `min-h-0`) en scrollt zijn
  lijst, waarbij de comments-kaart altijd zijn `min-h-[16rem]` houdt. De
  code-excerpts **wrappen** (geen horizontale scroll: `whitespace-pre-wrap
  break-words`).
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
  children) en vallen dus ook weg op `gran==='call'`. Ontbreekt een bruikbare
  coverage-annotatie op een test, dan toont de kaart-header i.p.v. een child
  een **warning** (`data-testid=related-covers-warning`, custom inline SVG +
  uitleg — nooit een AI-gok). Zie `.claude/rules/tembed-workflows.md` (sectie
  "Testdekking koppelen").
  De kaart **volgt de cursor**: `home.mjs` (`callScopeMethods`/`findCallSites`)
  koppelt elke resolved call aan het diff-segment waar hij staat. Op het fijnste
  niveau (`gran==='call'`) toont de kaart **precies de method van die ene call** —
  land op `->billingAddress` en je ziet `Order::billingAddress`; een segment
  zonder resolved call geeft een lege kaart. Op de grovere niveaus (line/group)
  scope't hij op de **regels van de geselecteerde unit**: alleen de calls waarvan
  de call-site binnen `[unit.start, unit.end]` valt — dus je ziet nooit een call
  van een regel die je níét hebt geselecteerd. Alleen in **list-mode** (geen diff)
  toont hij **alle** resolved calls van het block. De getoonde calls zijn
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
  (block-niveau) vallen op call-niveau weg. In de kaart-header is de **titel (`class::method`) altijd
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
