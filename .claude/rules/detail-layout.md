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
diff aan; er is bewust ruimte rechts voor **latere extra blokken** (elk een eigen
`shrink-0`-kolom die van links verder inpakt).

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
  Prism-highlighted PHP-excerpt (`data-testid=related-item`) met een `kind`-badge.
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
  dan de rest (`prio 2`). De listener-children (block-niveau) vallen op
  call-niveau weg. In de kaart-header is de **titel (`class::method`) altijd
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
