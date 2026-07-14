# Detail-layout & gerelateerd paneel (placeholder)

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
diff aan.

## Drillen: Onderliggende code als eigen kolom (`state.drill`)

`Enter` op een **resolved** kind in de Onderliggende-code-kaart (een relatie-child
of een opgeloste method-call — zie `isCodeFocused`/`focusedRelatedChild` in
`RelatedPanel.mjs`) opent dat kind als een volwaardige diff-kolom rechts naast de
bestaande kolommen, i.p.v. alleen de platte code-excerpt te tonen. `home.mjs` houdt
daarvoor een **stack** bij, `state.drill`: elke `drillIntoChild(child)` (aangeroepen
vanuit de `Enter`-tak in `onKeydown`, ná de bestaande "Zoek"-precedentie voor
onopgeloste calls) pusht er één entry op, en `popDrill()` (aangeroepen zodra
`←`/`Escape` het paneel op het diepste niveau zou **verlaten** — `handleRelatedKey`
geeft dan `'exit'` terug — en de stack niet leeg is) haalt er één af, zodat
terugstappen de kolommen één-voor-één sluit i.p.v. in één klap helemaal terug naar
de top-level diff te springen.

Een drill-entry is **één van twee vormen**:
- **Een echt PR-block** — zit het kind al in `state.allBlocks` (een relatie-child,
  of de definitie van een resolved method-call die zelf in deze PR wijzigt), dan
  wordt dát bestaande block-object hergebruikt (geen kopie): het draagt al
  `code`/`approvedRows`/etc., en `relatedChildren`/`resolvedCallChildren`/`callRows`
  werken generiek op elk block-id — dus dit kind krijgt **out-of-the-box** zijn
  eigen volledige, navigeerbare Onderliggende-code-paneel (recursie werkt gratis).
- **Een synthetisch frame** — een resolved method-call naar een bestand dat de PR
  niet wijzigt (geen PR-block, dus niets om te hergebruiken): een minimaal object
  (`{ id, label, file, class, name, status:'modified', code:null, synthetic:true }`,
  class/name gesplitst uit `child.label` op `::`), waarvan `ensureCode` de oud/nieuw-
  broncode ophaalt zoals voor elk ander block. Dit niveau toont **alleen** zijn diff
  — geen eigen Onderliggende-code-kaart (geen caller-scan ooit gedraaid voor een
  synthetisch frame).

**Interactie-scope:** alleen het **diepste** (meest recent gedrilde) niveau —
`focusedBlock()`, `state.drill.length ? state.drill[state.drill.length-1] :
curBlock()` — drijft het actieve Onderliggende-code-paneel + taken/chat eronder:
`relatedChildren`/`unresolvedCalls`/`startCallSearch` nemen nu een block-argument
i.p.v. impliciet `state.blocks[state.selected]` te lezen, en elke aanroepplek geeft
`focusedBlock()` door. Eerdere niveaus (de oorspronkelijke selectie + eerder
gedrilde kinderen) renderen **alleen** hun `Block`-kaart (`data-testid=drill-column`,
`shrink-0`, gedimd via `preview:true` — hetzelfde `preview`-effect als de
look-ahead-kaart) — géén eigen `activeGroup`/hints/RelatedPanel: die kolommen
hebben geen eigen navigeerbare cursor (`state.change`/`gran` blijven van de
top-level geselecteerde block). Er is dus altijd precies één `RelatedPanel`-
instantie (`cs`/`rc` blijven singletons); `drillIntoChild` reset 'm met
`enterRelated()` zodat het verse niveau op zijn eerste kind start. De kolom-`.key`
codeert positie in de stack + code-status (`load`/`code`/`err`, hetzelfde patroon
als de bestaande `sel`/`prev`-key) zodat een nieuwe drill altijd een verse kaart
forceert; een nieuwe kolom scrollt zichzelf in beeld
(`scrollIntoView({inline:'end',block:'nearest'})`, `<main>` scrolt horizontaal).

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

`RelatedPanel` is **puur placeholder met dummy data** — nog geen `/api`-koppeling.
Twee gestapelde kaarten:

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
  **eerste** blokje (`cs.codeSel=0`). Vanaf het eerste blokje stapt `→` de
  **rechter-stapel** in (het 2e blokje) en `↓` verlaat de lijst naar de comments;
  in de rechter-stapel lopen `↑`/`↓` langs de blokjes (zie
  `.claude/rules/keyboard-navigation.md`). Het geselecteerde blokje krijgt een
  indigo ring (`data-active=true`). Het **eerste** blokje staat op volle breedte;
  **daaronder** staat een pijltjes-hint (`data-testid=related-hint`, verticaal
  gestapeld) met het **2e en verdere** blokje als groep **rechts náást** die
  hint. De kaart heeft **geen vaste hoogte-cap** (eerder `max-h-[40%]`): hij
  groeit met zijn inhoud mee en pakt alle verticale ruimte die de comments-kaart
  eronder niet nodig heeft; pas als beide samen niet passen krimpt hij
  (flex-shrink, `min-h-0`) en scrollt zijn lijst, waarbij de comments-kaart
  altijd zijn `min-h-[16rem]` houdt. De hint toont **de bewegingen die vanaf de
  huidige positie kunnen**: op
  het eerste blokje `→` (volgend blok) / `↓` (naar comments); zit je in de
  rechter-stapel (2e+ blokje) dan schakelt hij naar `↑` (vorig blok) / `←` (naar
  diff) / `↓` (volgend blok). De hint kleurt feller (`text-indigo-400`) zolang de
  kaart de toetsen bezit. De code-excerpts **wrappen** (geen horizontale scroll:
  `whitespace-pre-wrap break-words`).
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
  Aanroepen die de Go-resolver niet kon pinnen
  geven een **"Zoek (N)"**-knop (`data-testid=related-search`) die de LLM-zoektocht
  start (`startCallSearch` → `POST /api/workflows/resolve_call`; ook via `Enter` op
  het code-blok, `isCodeFocused`); tijdens het zoeken toont de kaart "zoeken…"
  (`data-testid=related-searching`). Een door een LLM gevonden child draagt een
  **`bron: haiku/sonnet`**-badge (`source`); Go-resolved children tonen geen bron.
  Zie `.claude/rules/tembed-workflows.md` (sectie "Aangeroepen … methodes resolven").
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
