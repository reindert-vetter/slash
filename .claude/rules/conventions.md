# Conventies (ingevuld door dit scaffold — corrigeer waar nodig)

- Frontend-modules zijn `.mjs`, één component per bestand, PascalCase voor
  component-bestanden (`Block.mjs`), lowercase voor pagina-modules (`home.mjs`).
- Vendored libs (arrow.js, Prism) leven in `src/vendor/` en worden met een relatief
  pad geïmporteerd, niet via een CDN-module. Tailwind is de uitzondering (Play CDN).
  arrow.js staat gevendord in `src/vendor/arrow.js`.
- **Lokale patch op arrow.js (`src/vendor/arrow.js`)** — er staat één bewuste
  wijziging in de gevendorde arrow.js, gemarkeerd met een `LOCAL PATCH`-comment in
  de header: de template-expressie-evaluator `rt` skipt een **vrijgegeven slot**
  (`typeof W[t]=="function"`-guard) i.p.v. 'm aan te roepen. Zonder die guard crasht
  een reactief effect dat ná het opruimen van zijn keyed-node nog in de
  microtask-flush vuurt met `W[t] is not a function` (use-after-free) — o.a. bij het
  **drillen** (een Onderliggende-code-kind als eigen kolom openen re-scope't het
  paneel en breekt kaarten af midden in de flush). Bij een arrow.js-upgrade moet
  deze patch **opnieuw** worden aangebracht (zie het comment voor de originele
  regel).
- **arrow.js-valkuilen** (uit de praktijk): géén HTML-comments (`<!-- -->`) in een
  `html`` `` template (gooit "Invalid HTML position"); een reactieve attribuut-waarde
  moet de **hele** waarde zijn (`class="${() => ...}"`, niet `class="x ${...}"`).
  Ruwe HTML injecteer je via de `.innerHTML`-binding
  (`.innerHTML="${() => htmlString}"`) — arrow.js zet dan de property i.p.v. te
  escapen. Zorg dat de string veilig is (bv. Prism.highlight, dat zelf escapet).
- **arrow.js `watch(getter, cb)` — som je reactieve deps _inline_ in de getter op.**
  Verstop je alle reads in een geroepen functie met early-returns/conditionele
  paden (b.v. `watch(() => buildStuff(), …)`), dan varieert de dependency-set per
  run en kan de uitgekristalliseerde run een key laten vallen waar hij eerder wél
  op abonneerde — de watch her-abonneert niet en stopt met vuren. Lijst daarom de
  state die het moet volgen letterlijk op (`() => [state.a, state.b, obj && obj.x]`)
  en doe het echte werk in de _callback_. Zo doen de `setCommentScope`- en
  `setRelated`-watches in `home.mjs` het; een eerdere `setRelated`-watch die dat
  níét deed liet het gerelateerd-paneel op het bij load geselecteerde block
  bevriezen (zie `.claude/rules/detail-layout.md`).
- **arrow.js — een `${() => …}`-slot dat wisselt tussen een enkel element en een
  keyed array (`.map()`) bevriest na een lege render.** Waargenomen in de
  comment-lijst van `RelatedPanel.mjs`: de slot gaf óf `visibleComments().map(...)`
  (keyed rijen) óf een enkel `<p>Nog geen comments</p>`. Navigeer je naar een block
  zónder comments (de slot rendert het enkele `<p>`) en dan terug naar een block
  mét een comment, dan draaide de slot-binding wel opnieuw en gaf een niet-lege
  array terug, maar arrow.js rende de rijen niet meer — de lijst bleef leeg terwijl
  `cs.view` wél gevuld was (de comment stond nog wel in de thread-header, die een
  string teruggeeft). **Oplossing:** geef **altijd hetzelfde soort** uit die slot —
  wikkel de lege-staat in een **array van één** (`[html\`<p …>…</p>\`.key('no-comments')]`)
  zodat de slot-vorm stabiel een keyed array blijft. Re-keyen van het paneel of een
  scalar-versieteller hielpen niet; alleen de stabiele array-vorm.
- **arrow.js — key nooit een template waarvan de hele body één toggelende
  expressie is (`` html`${() => cond ? sub() : ''}` ``).** Verwant aan de
  single↔array-valkuil hierboven, maar erger: arrow.js zet de DOM-grenzen van
  een chunk (`ref.f`/`ref.l`) alleen bij **hydration**; wisselt de geneste
  reconciler die inhoud later om (template ↔ `''`), dan vervangt hij de DOM
  **zonder** de `ref` van de eigenaar-chunk bij te werken. Bij een template
  waarvan de expressie de héle body is, ís die expressie de chunk-grens — de
  `ref` wijst na één toggle dus naar verwijderde nodes. Staat zo'n template
  als **keyed item in een lijst**, dan ontspoort de keyed reconcile daarna
  stap voor stap: `patchKeyedList` bailt op de stale ref (parent `null`), het
  generieke fallback-pad verliest de chunk (tekst-placeholder i.p.v. de
  chunk), en een volgende run gebruikt de stale ref als **anchor** — nieuw
  gemounte items belanden in een detached fragment en verdwijnen uit beeld,
  waarna twee reconciler-administraties om dezelfde chunks vechten (oneindige
  microtask-loop, tab bevriest). Zo verdween de look-ahead-preview-kaart bij
  herhaald ↓/↑ door same-file blocks: `stepChevronSlot` (`home.mjs`) was zo'n
  kale wrapper, gekeyed als `step-up`/`step-down` in de block-kolom.
  (Ongepatchte upstream 1.0.6 crasht op hetzelfde scenario al eerder met
  `expressionPool[effect] is not a function` — LOCAL PATCH 1 maskeert die
  crash tot stille render-corruptie.) **Oplossing:** geef zo'n slot een
  **stabiele element-root** en toggle bínnen die root, bv.
  `` html`<div class="contents">${() => cond ? sub() : ''}</div>` `` — de
  `ref` wijst dan permanent naar het element. De **statische**
  `contents`-class is dubbel bewust: `display:contents` haalt de wrapper-box
  uit de layout (inhoud toont → die is zelf het flex-item; leeg → géén
  flex-item, dus ook geen `gap`-artefact), én een statische class vermijdt een
  reactieve attribuut-binding die bij elke navigatiestap opnieuw zou zetten
  (de flicker-test in `navigate.spec.mjs` eist nul attribuut-mutaties per
  stap). Regressietest: `tests/step-preview-stability.spec.mjs`.
  **Neveneffect, apart bevestigd:** dezelfde ontsporing corrumpeerde ook een
  héél andere geneste `${() => componentAanroep(...)}`-embedding in dezelfde
  block-kolomlijst — `Block.mjs`'s `${() => codeDiff(...)}` — met een
  zichtbaar, stil symptoom: na een same-file ↓/↑-cyclus toonde de
  geselecteerde kaart de **juiste titel** (`class::method`, een gewone
  reactieve tekst-binding, dus zelf niet aangetast) maar de **code van het
  vórige geselecteerde block** — geen crash, gewoon foutieve inhoud, tenzij je
  toevallig ook de eerder beschreven `Cannot read properties of null (reading
  'after')`-crash raakte. Bevestigd door de exacte fix-commit te bracketen met
  een git-worktree-vergelijking (vóór/na) tegen dezelfde echte PR-data: vóór de
  `stepChevronSlot`-fix reproduceerde de mismatch + crash betrouwbaar, erna
  niet meer — dus **geen aparte fix nodig**, dezelfde stabiele-element-root
  loste 'm mee op. Regressietest: `tests/diff-code-vs-title.spec.mjs` (dezelfde
  ↓/↑-cyclus als `step-preview-stability.spec.mjs`, maar verifieert i.p.v. de
  preview-kaart-aanwezigheid dat de gerenderde diff-tekst van de geselecteerde
  kaart altijd bij dát block's eigen `/api/code`-bron hoort — nooit bij een
  buurblock).
- **arrow.js — een STATISCH geïnterpoleerde waarde die per instantie template
  óf string is (`` ${cond ? html`…` : ''} `` zonder `() =>`) lekt bij
  chunk-hergebruik de template-functie als tekst.** Waargenomen in de
  drill-hint-chips van `RelatedPanel.mjs`: op de plek van de approval-teller
  verscheen letterlijk **`i=>je(n,i)`** — dat is (in de gevendorde,
  geminificeerde build) de template-functie zelf: `html`` ` retourneert
  `const n=(i=>je(n,i)); n.isT=!0` (`bt` in `vendor/arrow.js`). Mechanisme:
  hydrateert een chunk zo'n statisch slot met de **string**-tak (`''`), dan
  registreert `Ve` een **Text-node-binding** voor dat slot en blijft het chunk
  herbruikbaar (`r` blijft true); arrow cachet chunks per template-shape (`g`)
  en hergebruikt zo'n gecacht chunk voor een latere instantie met dezelfde
  shape (`U`→`pe`). Het statische patch-pad `pe` kent maar drie gevallen —
  attribuut, functie-binding, of **`textNode.data = waarde`** — dus is de
  nieuwe waarde een **template**, dan wordt de template-functie naar
  `Text.data` geschreven en gestringificeerd. (Hydrateert de template-tak
  eerst, dan zet die juist `r=false` — vandaar dat de bug intermitterend is en
  een verse eerste render 'm niet toont.) **Oplossing, twee toegestane
  vormen:** (1) maak het slot **altijd een string** — bereken de tekst vooraf
  als platte string op de descriptor (bv. `approveText` in
  `nestedChangedKids`, `home.mjs`) en rendeer in een altijd-aanwezig element
  (verbergen kan met een vooraf berekende hele-waarde class); of (2) maak er
  een **`${() => …}`-functie-binding** van — arrow's reactieve pad (`re`)
  handelt template↔`''`-wissels wél correct af, en een closure die alleen een
  plat (niet-reactief) descriptor-object leest registreert geen deps en kan
  dus niets co-subscriben. Statisch een template interpoleren mag alléén als
  dat slot in élke instantie van die shape een template is (zoals `testsBar`'s
  altijd-gevulde chip-`.map()`). Regressietest: de `=>`-assert in
  `tests/related-nested-chip.spec.mjs`.
- **arrow.js hergebruikt een keyed node zonder z'n function-bindings te
  herdraaien — en verliest soms een `.innerHTML`/attribuut-update bij
  co-subscribers.** Twee samenhangende valkuilen, beide waargenomen in de
  block-kaarten van `DetailPanel` (`home.mjs`):
  1. Wisselt een keyed node van rol maar blijft z'n `.key(...)` gelijk (b.v. een
     block dat van *preview* naar *geselecteerd* gaat bij ↓/↑), dan **verplaatst
     + patcht** arrow.js de bestaande node i.p.v. 'm opnieuw op te bouwen: de
     `${() => …}`-function-bindings binnenin draaien niet opnieuw en een bevroren
     binding (b.v. de `activeGroup`-highlight) vuurt nooit voor de nieuwe staat.
  2. Abonneren **meerdere** reactieve consumers op dezelfde property (b.v. de
     diff-render leest `b.code` én een `watch`-getter leest `curBlock().code`),
     dan laat arrow.js de `null→geladen`-update van de diff-binding er
     **intermitterend** uitvallen — de diff blijft op "loading" hangen terwijl de
     code er al is.
  Oplossing (beide): laat niet-navigatie-transities een **verse** node forceren
  via de key, en herbouw de kaart van buitenaf i.p.v. te vertrouwen op de fragiele
  `b.code`-binding. Concreet in `home.mjs`: de block-kaart-key codeert rol
  (`sel`/`prev`) **én** code-status (`load`/`code`/`err`). De DetailPanel-binding
  abonneert op `state.codeVersion` (gebumpt door `ensureCode` zodra code arriveert)
  — een teller náást `b.code` — zodat hij betrouwbaar herdraait en de key
  omklapt, wat een **verse** diff-binding oplevert die de geladen code leest. De
  `setCommentScope`/`setRelated`-watches blijven wél `curBlock().code` lezen (dat
  moeten ze, om de cursor te volgen); dat maakt ze co-subscribers en is exact
  waarom de diff-binding zélf de update kan missen — vandaar de herbouw-via-key
  i.p.v. wéér een `b.code`-lezer toe te voegen. Zie
  `.claude/rules/detail-layout.md`.
- **Een `state.x`-lezing die je synchroon binnen een outer array-bouwende
  `${() => {...}}`-closure aanroept (i.p.v. in een eigen geneste reactieve slot),
  maakt de HELE closure afhankelijk van `state.x`** — ook als de uitkomst zelf
  slechts één klein element betreft. Gezien in `home.mjs`'s `DetailPanel`: de
  block-kolom-closure die alle `Block(...)`-kaarten bouwt riep `canStep(-1)`/
  `canStep(1)` (voor het grijze step-chevron) **direct** aan; `canStep` leest
  `state.change`/`mode`/`focusLevel`. Daardoor draaide de hele closure — en dus
  elke `Block()`-aanroep met **verse** `activeGroup`/`hintsEnabled`/`diffActive`/
  etc.-closures — opnieuw bij **elke** ↑/↓-stap. De `.key(...)` voorkwam een
  volledige DOM-node-vervanging (arrow matcht 'm en hergebruikt de node via
  `move+patch`), maar elke functie-gebonden attribute-slot (`class`, checkbox
  `.indeterminate`, category-badge, enz.) werd daarbij toch **opnieuw gezet**
  (`setAttribute` vergelijkt niet met de oude waarde) — een meetbare
  `MutationObserver`-cascade over de HELE kaart bij iedere stap, wat als
  zichtbare flikkering oogde (niet alleen de highlight verschoof, de hele kaart
  "ademde" mee). **Oplossing:** verplaats de `state.change`-lezing naar een eigen
  geneste `${() => canStep(...) ? … : ''}`-binding (dezelfde vorm als de bestaande
  `${() => menu.open ? menuOverlay() : ''}`-toggle) zodat alléén dat kleine slot
  op de navigatie-state reageert; de outer closure blijft beperkt tot de deps die
  hij expliciet noemt (`selected`/`codeVersion`/`focusLevel`). Zie
  `stepChevronSlot` in `home.mjs` en `.claude/rules/detail-layout.md`.
- **arrow.js ruimt een weggevallen (conditioneel gerenderde) subtree niet volledig
  op — z'n reactieve expressions blijven geabonneerd (use-after-free).** Gezien bij
  het **command-menu** (`home.mjs` + `CommandMenu.mjs`): het overlay hangt aan een
  `${() => menu.open ? menuOverlay() : ''}`-binding. Bij sluiten geeft die `''`
  terug en verdwijnt de overlay uit de DOM, **maar** de list/row-bindings van die
  `CommandMenu`-instantie blijven geabonneerd op het state-object waartegen ze
  gebouwd zijn. Muteert een **latere** open dat object (een andere `mode`, of het
  betreden van een submenu dat `sub` zet), dan vuren die **wees-bindings** tegen
  inmiddels vrijgegeven expression-slots → arrow gooit `W[t] is not a function`
  (een teller-index in arrow's slot-pool wijst naar een gerecyclede slot). Same-mode
  heropenen crasht niet (geen dep verandert), cross-mode of submenu wél. Het is een
  **latente** bug: de oude flow opende nooit een tweede menu (Enter/`/` werden
  opgeslokt zolang de composer open was), dus hij werd pas zichtbaar toen de
  comment-soort-`compose`-mode een menu **over** de composer opende.
  **Oplossing:** splits de menu-state in een **stabiele** `menu` (alleen `open`,
  waar de top-level binding aan hangt) en een **wegwerp** `let ms = reactive({query,
  sel, sub, mode})` die `openMenu` bij **elke** open **vervangt** door een vers
  object. Wees-bindings van een vorige open wijzen dan naar het **oude** `ms` dat we
  nooit meer aanraken, dus ze vuren nooit; alleen de live-bindings (tegen de huidige
  `ms`) draaien. `closeMenu` zet enkel `menu.open=false` — het laat `ms` bewust met
  rust. (Altijd-gemount-met-CSS-verbergen werkt níét: dan rendert `CommandMenu` al
  bij page-load — vóór er een block geselecteerd is — en gooien de label-functies
  die `curBlock()` lezen alsnog, wat de slot-pool corrumpeert.) Zie
  `.claude/rules/keyboard-navigation.md`.
- **Dezelfde disposal-gap is ook een geheugenlek, niet alleen een crash-risico —
  en de `ms`-swap hierboven verhelpt alleen de crash.** De `ms`-swap voorkomt dat
  een wees-binding **crasht** (hij hangt aan een object dat nooit meer verandert,
  dus vuurt nooit meer), maar arrow.js's `Ft`-teardown (het opruimen van een
  weggevallen keyed node) ruimt **alleen** de expression-slots op die de node
  **zelf direct** bezit — hij cascadeert nooit naar een genest stuk template dat
  via `${() => componentAanroep(...)}` is ingebed (zoals `${CommandMenu(ms, ...)}`
  in `menuOverlay()`, of `${() => codeDiff(...)}` in `Block.mjs`). Zo'n geneste
  reconciler-boom (elke rij, elke `.innerHTML`-binding erin) blijft dus **voor
  altijd** een levend, DOM-loos (detached) stuk template — precies "Detached
  `<span>`/`<div>`/Text"-groei in een heap-snapshot. Dat is op zich al een
  (langzaam groeiend, per-open) lek, maar wordt een **actief, steeds sneller
  groeiend** probleem zodra een wees-binding **niet** alleen van de weggeworpen
  `ms` afhangt maar ook van **globale, blijvend veranderende** state: zo'n
  binding blijft na sluiten geregistreerd tegen die globale property en
  her-evalueert dus bij **elke** latere, ongerelateerde wijziging — voor élke
  ooit-geopende menu-instantie. Concreet gevonden: `COMMANDS[0]`'s "Keur … goed"-
  label (leest `curBlock()`/`state.mode`/`state.gran`/`state.change`/
  `b.approvedRows`/`b.approvedCalls`), plus vergelijkbare labels in
  `COMPOSE_COMMANDS`/`PR_COMMANDS` — precies de **standaard, meest-gebruikte**
  Enter-palette, en de automatische postApprove-vervolgmenu na élke
  groeps-goedkeuring (`afterApproveAction`). Elke open+close-cyclus liet zo een
  steeds duurdere geest achter die bij iedere navigatie-/approve-stap opnieuw
  meerekende — een met Playwright gemeten, reproduceerbare ~3.6× vertraging van
  60 `f`/`s`-toetsaanslagen na 200 open/close-cycli op de ongepatchte code
  (0.9–1.0× — vlak, geen groei — na de fix), wat zich in de praktijk uitte als
  "de tab loopt op een gegeven moment vast" na genoeg goedkeur+navigeer-cycli.
  **Fix (toegepast, laag risico):** laat nooit een `label`-**functie** de
  geneste, nooit-opgeruimde `CommandMenu`-boom bereiken. `resolveLabel`/
  `snapshotCommands` (`home.mjs`) roepen zo'n functie **eenmalig** aan vanuit
  gewone, niet-reactieve code (`openMenu`, dus buiten elke arrow.js-`Te()/Ae()`-
  tracking-bracket) en zetten het resultaat vast als platte string op
  `ms.commands`/`ms.sub` — CommandMenu's eigen `${() => labelOf(c)}`-binding ziet
  dan nooit meer iets dan een string, registreert dus geen dependency op iets
  buiten `ms`, en een wees-binding die daaruit voortkomt vuurt (net als de
  bestaande `ms`-only bindings) nooit meer.
- **Root-cause fix: `Ft` cascadeert nu genest-gemonteerde reconciler-subtrees
  op (`LOCAL PATCH 2` in `src/vendor/arrow.js`).** De `CommandMenu`-fix
  hierboven is een gerichte, app-niveau band-aid (nooit een `label`-functie de
  boom laten bereiken); hetzelfde disposal-gap-patroon zat **ook** onder de
  kaart-hertekening in `DetailPanel`/`Block.mjs` (elke keer dat een block-kaart
  een **nieuwe key** krijgt — preview→selected, code net geladen,
  focus-niveau-wissel, zie `.claude/rules/detail-layout.md` — werd de oude
  `<article>` afgebroken, maar zijn geneste `${() => codeDiff(...)}`-subtree,
  met zijn `b.approvedRows`/`state.diffViewMode`-lezende `.innerHTML`-bindings,
  bleef op dezelfde manier hangen). Dat gebeurde al bij **gewoon navigeren**
  (niet alleen bij goedkeuren) en was de grootste losse bijdrage aan
  onbegrensde geheugengroei tijdens een reviewsessie (met Playwright/CDP
  heap-snapshots gemeten: +4600 detached DOM-nodes per 60 kaart-hertekeningen
  vóór de patch, tegen ±30 — ruis — erna; een tweede, timing-gebaseerde proef
  liet een ~7-8× vertraging zien van een begrensde `b.approvedRows`-mutatie na
  60 hertekeningen vóór de patch, tegen ~0.85-0.93× — vlak — erna). In plaats
  van dit per component te blijven pleisteren (elke nieuwe geneste
  `${() => componentAanroep(...)}`-embedding zou hetzelfde lek weer
  introduceren) is de daadwerkelijke oorzaak in arrow.js zelf gepatcht: `re(t)`
  (upstream `createRenderFn`, de reconciler-factory die `Ve`/upstream
  `createNodeBinding` gebruikt voor élke geneste component/array/template-
  waarde — `CommandMenu`'s rijen, `Block.mjs`'s `${() => codeDiff(...)}`,
  `RelatedPanel`'s `.map()`-lijsten, …) registreert nu, via zijn eerste
  parameter (upstream de SSR-`capture`-vlag, in deze build dood — esbuild
  tree-shaked elke `if(capture)`-tak weg, bevestigd door de hele functie-body op
  een losstaand `t`-token te grepen vóórdat 'm werd hergebruikt), één cleanup
  op de **eigenaar**-node: zodra die eigenaar via `Ft` wordt afgebroken, ruimt
  deze cleanup ook op wat de reconciler op dat moment gemonteerd houdt, via
  **dezelfde** bestaande dispatch (`qt`/upstream `removeUnmounted` — cache-voor-
  hergebruik vs. volledig vernietigen, chunk-of-array) die top-level content
  altijd al kreeg. Puur additief (3 kleine inserties, geen bestaande regel
  gewijzigd) en **recursief vanzelf correct**: een geneste reconciler die zelf
  weer iets nest, registreert zijn eigen cleanup op zijn eigen eigenaar op
  dezelfde manier. Geverifieerd tegen de echte, niet-geminificeerde upstream-
  bron (`@arrow-js/core@1.0.6`, `dist/index.mjs` + `dist/chunks/internal-*.mjs`
  via jsDelivr) om de minified namen (`re`=`createRenderFn`, `Ve`=
  `createNodeBinding`, `Ft`=`destroyChunk`, `qt`=`removeUnmounted`, `n.u`=
  `chunk.u`) met zekerheid te herleiden i.p.v. op minified tekst te gokken —
  zie het `LOCAL PATCH 2`-commentaarblok in `vendor/arrow.js` voor het volledige
  mechanisme en de exacte herstelinstructie bij een arrow.js-upgrade.
- **`Element.scrollIntoView({block: 'nearest'|'center'})` beweegt ook de
  horizontale as als je `inline` weglaat — dat is de DOM-default, geen
  arrow.js-eigenaardigheid, maar hij beet hier omdat een verticale "houd deze
  rij in beeld"-scroll (Onderliggende-code-kaart, chips, Taken, comment-
  reacties) toevallig binnen `<main>`'s horizontaal scrollende kolom-flow
  hangt: elke stap ↓/↑/→ in zo'n lijst kon zo ongewild `<main>`'s eigen
  `scrollLeft` verschuiven en de kaart die de keyboard-focus draagt (links van
  het paneel) buiten beeld duwen — precies de klacht "na → en dan ← staat de
  selectie niet meer volledig in beeld". **Oplossing:** `scrollIntoViewVertical`
  (`RelatedPanel.mjs`, geëxporteerd) loopt vanaf het element omhoog naar de
  eerste voorouder die daadwerkelijk verticaal scrolt
  (`scrollHeight > clientHeight` — een horizontaal scrollende `<main>` matcht
  dat nooit, dus de walk stopt er vanzelf één niveau vóór) en zet alleen diens
  `scrollTop` — nooit `scrollIntoView()` zelf aanroepen voor een
  "blijf-in-beeld-tijdens-lijst-navigeren"-scroll. Gebruikt door
  `scrollCodeIntoView`/`scrollChipIntoView`/`scrollTaskIntoView`/
  `scrollReactionIntoView` (`RelatedPanel.mjs`) en de `scrollChangeIntoView`-
  fallback (`home.mjs`). `scrollFocusIntoView` (dat de gefocuste kolom bij een
  `←`/`→`-focuswissel bewust wél links uitlijnt met `inline:'start'`) blijft
  ongewijzigd — dat is de ene plek waar een horizontale scroll juist gewenst
  is. Zie `tests/scroll-focus-vertical-only.spec.mjs`.
- **Syntax-highlighting:** Prism 1.29.0 staat gevendord als één ES-module in
  `src/vendor/prism.js` (core + markup + clike + markup-templating + php, met
  `window.Prism={manual:true}` zodat het niet de hele pagina auto-highlightt). De
  code-panes in `Block.mjs` highlighten PHP met `Prism.highlight(...)` en tonen het
  resultaat via de `.innerHTML`-binding. Prism's eigen container-CSS is bewust
  weggelaten; alleen de token-kleuren staan in de `<style>` van `index.html`,
  **gescoped op de `.language-php`-class** die elk code-fragment draagt — dus niet
  alleen de diff-panes maar ook de Onderliggende-code-kaarten + de comment-hint
  (`RelatedPanel.mjs`) en de footer krijgen dezelfde kleuren. (Was eerder gescoped
  op `[data-testid=code-diff]`, waardoor alles buiten de diff-panes kleurloos bleef.)
- **Markdown-rendering:** `snarkdown` (v2.0.0, MIT, ~1kb) staat gevendord als
  ES-module in `src/vendor/snarkdown.js` (verbatim upstream-algoritme, alleen een
  vendoring-headercomment toegevoegd) — gebruikt precies zoals het uit de doos
  komt: koppen, lijsten, bold/italic/strike, blockquotes, inline code, links,
  afbeeldingen, `---`. `src/markdown.mjs` is een dunne wrapper
  (`renderMarkdown(text) -> safeHtmlString`) die er twee dingen omheen legt: (1)
  fenced code blocks worden er **vóór** alles uitgehaald en met dezelfde Prism
  `highlight()` als de diff-panes (`Block.mjs`) gerenderd i.p.v. snarkdown's eigen
  kale `<pre><code>` — vandaar ook de `.language-php`-class op elk code-fragment
  (dezelfde CSS-scope hierboven); (2) een XSS-veiligheidslaag: de **hele** ruwe
  Markdown-tekst wordt eerst volledig HTML-ge-escaped (`escapeHtml`, `&<>"`) vóórdat
  hij naar snarkdown gaat — snarkdown zelf escapet **geen** losse HTML in de
  brontekst, alleen de attribuut-waarden die het zelf opbouwt (link/image-URL's) —
  en link/image-URL's gaan daarna nog door `sanitizeUrls`, dat een
  `javascript:`/`vbscript:`/`data:text/html`-schema neutraliseert als extra laag
  (snarkdown's eigen `encodeAttr` escapet al de quote in een URL, dus een
  `<img src>` kan sowieso geen los `onerror=`-attribuut injecteren). Gebruikt in
  `prInfoCard` (`home.mjs`) voor de PR-samenvatting/-omschrijving/Jira-omschrijving
  via de `.innerHTML`-binding; een klein `.markdown-body`-stijlblok in
  `index.html` (koppen/lijsten/links/blockquote/code/afbeeldingen) is de
  hand-geschreven typography-laag — Tailwind Play CDN heeft geen
  typography-plugin zonder build-stap. **Geen** GFM-tabellen of
  taak-checklists (`- [ ]`) — bewust buiten scope gehouden, snarkdown ondersteunt
  ze niet en er is geen extensie voor gebouwd.
  **Ook comment-bodies renderen als Markdown** (`RelatedPanel.mjs`): `commentBody(c)`
  is de **enige** plek die een comment-body rendert (`() => renderMarkdown(c.body)`,
  `.innerHTML`-binding) — hergebruikt door `commentRow` (de comment-rij-preview),
  `reactionBubble` (elke thread-bubble, zowel het block-scoped comment-paneel als
  het PR-brede `prWideItem`) en dus automatisch ook een toekomstig vierde render-punt.
  De input (composer-`<textarea>`/`<input>`) is een kaal tekstveld zonder
  restrictie — "markdown-input ondersteunen" was dus al gratis, alleen de
  weergave miste `renderMarkdown`. **Bewust buiten `commentBody` gehouden:** de
  eenregelige, `truncate`/`line-clamp`-titel-contexten waar opgemaakte structuur
  weinig toevoegt en een halfafgekapte `**`/code-fence lelijker oogt dan kale
  tekst — de thread-header-titel (`selComment().body`) en `workflowNote`'s
  Taken-snippet blijven daarom platte tekst.
  **Lange woorden/URL's breken binnen het woord af (`[overflow-wrap:anywhere]`):**
  elk van de drie `.innerHTML="${commentBody(...)}"`-containers
  (`commentRow`'s preview-span, `reactionBubble`'s bubble-`<div>`, `prWideItem`'s
  body-span) draagt deze arbitrary-value Tailwind-class naast zijn bestaande
  `truncate`/`line-clamp`/geen-wrap-class. Zonder deze class breekt tekst alleen
  op woordgrenzen (`break-words`/browser-default), zodat een lange, spatieloze
  token (URL, hash, aaneengeschreven pad) buiten de kaart/bubble kan uitsteken;
  `overflow-wrap:anywhere` breekt zo'n woord alleen bij overloop, midden in het
  woord, zonder normale tekst anders te wrappen.
- **Gedeelde avatar-helper (`src/avatar.mjs`), auteur+avatar bij elke
  comment/reply.** `avatarHTML(name, avatarUrl, sizeCls, extraCls)` is
  geëxtraheerd uit `overview.mjs`'s `reviewerAvatar` (de reviewer-avatars in
  de PR-lijst): een `<img>` als er een `avatarUrl` is, anders een
  initialen-cirkel (eerste twee letters, uppercase) — exact dezelfde kleuren/
  vorm als de PR-lijst. `reviewerAvatar` roept 'm nu zelf aan voor zijn eigen
  cirkel (de goedgekeurd/wijzigingen-gevraagd-badge eromheen blijft lokaal in
  `overview.mjs`). Een `<img>` valt bij een laad-fout terug op dezelfde
  initialen-cirkel via een statische `onerror`-attribuut-string (geen
  reactieve binding nodig — dat is geen arrow.js-valkuil, `onerror` wordt hier
  nooit door arrow.js zelf gezet) zodat een onbereikbare/offline afbeelding
  (bv. `SLASH_GITHUB=off`-tests) nooit een broken-image-icoon achterlaat.
  `RelatedPanel.mjs` gebruikt 'm in `commentRow` (comment-rij, `h-4 w-4`),
  `reactionBubble` (elke thread-bubble — de synthetische opening én elke
  reactie, beide dragen al een `author`, zie `threadMessages`) en `prWideItem`
  (de PR-brede comments): auteur-naam + avatar op een eigen regel boven de
  body/kind-badge (`data-testid=comment-author`/`reaction-author`/
  `pr-wide-author`, plus de bijbehorende `*-author-line`-wrapper). **Datamodel-
  kanttekening:** comments/reacties (`modules/comments`) dragen wél een
  `author`-login (`Comment.Author`/`Reaction.Author`, ook gevuld voor
  GitHub-geïmporteerde comments/replies, zie `comment_import.go`), maar
  **geen avatar-URL** — de GitHub-fetch (`modules/github`) threadt alleen
  `user.login` door, nooit `user.avatar_url`. Elke comment-/reply-avatar
  rendert dus vandaag altijd als initialen-cirkel; een latere backend-
  uitbreiding (avatar-URL meenemen in `ghComment`/`Reply`/`ReviewComment`/
  `GeneralComment` + een nieuwe kolom in `comments.db`) zou de echte
  GitHub-profielfoto laten verschijnen zonder de frontend te hoeven wijzigen
  (`avatarHTML` ondersteunt het al). Zie `tests/comment-author-avatar.spec.mjs`.
- **Thema: systeem/licht/donker, met een handmatige rondloop-knop
  (`src/theme.mjs`).** Het thema volgde ooit **uitsluitend** de
  systeeminstelling (`prefers-color-scheme`, Tailwind `darkMode:'media'`,
  geen eigen toggle); die keuze is teruggedraaid — een reviewer wil soms
  bewust licht/donker forceren, los van de OS-instelling. `src/theme.mjs` is
  de gedeelde (geen component, pure utility, zoals `urlState.mjs`) module voor
  beide pagina's:
  - **Drie staten**, geen binaire aan/uit: `theme.pref` ∈
    `'system'|'light'|'dark'` (default `'system'`). Een binaire toggle zou een
    reviewer die op "licht" klikte terwijl de OS op dark staat geen weg terug
    naar "volg systeem" geven zonder de OS-instelling zelf te wijzigen.
  - **Tailwind draait op `darkMode: 'selector'`** (niet meer `'media'`, in
    hetzelfde `tailwind.config`-`<script>` vóór de CDN-styles) — elke
    bestaande `dark:`-utility blijft ongewijzigd werken, alleen de trigger
    verandert van de media-query naar de **aanwezigheid van een `.dark`-class**
    op `<html>`.
  - `theme.mjs`'s `applyTheme(pref)` zet die `.dark`-class **plus** een
    `data-theme="light"|"dark"` attribuut op `<html>` (voor de losse CSS
    hieronder, die geen class kan lezen), berekend als `pref==='system' ?
    matchMedia(...).matches : pref==='dark'`. `initTheme()` (aangeroepen als
    module-side-effect vanuit zowel `home.mjs` als `overview.mjs`) past 'm
    initieel toe, abonneert een `watch(() => theme.pref, applyTheme)` (de
    toggle) én een `matchMedia('(prefers-color-scheme: dark)')`
    `'change'`-listener die alleen ingrijpt zolang `pref === 'system'` — zo
    blijft "systeem" ook **live** volgen als de OS-instelling wijzigt terwijl
    de pagina open staat.
  - **Anti-flash:** vóór de Tailwind-CDN-`<script>` staat in beide shells
    (`index.html`/`overview.html`) een **inline** `<script>` dat dezelfde
    localStorage-lees + class/attribuut-zet-logica dupliceert (niet
    importeert — ES-modules laden async, en dit moet vóór de eerste paint
    draaien). `theme.mjs`'s `initTheme()` neemt het daarna gewoon reactief
    over; geen zichtbare flits van het verkeerde thema bij page-load.
  - **De knop** (`themeToggleButton(cls)`, `data-testid=theme-toggle`, één
    gedeelde component-functie die beide pagina's importeren): een klik cyclet
    `system → light → dark → system` (`cycleTheme()`, persisteert meteen naar
    `localStorage`) en toont een monitor/zon/maan-icoon voor de huidige staat.
    Plek op `/pr/<id>`: een **smalle rij in `prInfoCard`** (`home.mjs`,
    `data-testid=pr-info-theme-row`), direct vóór de PR-samenvatting
    (`data-testid=pr-info-summary`) — **niet** meer een eigen, altijd-
    zichtbaar `position:fixed`-hoekelement (de oudere `ThemeToggleCorner`,
    `bottom-6 left-6 z-30`, is verwijderd) en ook niet in `Footer.mjs` (die
    footer toont zich sinds kort alleen nog als er daadwerkelijk iets te
    previewen is, `state.footerVisible`, zie "Footer" in
    `.claude/rules/keyboard-navigation.md` — geen betrouwbare plek voor een
    permanent bereikbare knop). Bewuste consequentie: `prInfoCard` bestaat
    alleen terwijl `state.showDescription` waar is (stop 1 van de
    links→rechts-navigatieketen, zie `detail-layout.md`), dus de knop is
    **niet** meer standaard zichtbaar — dat is hier expliciet akkoord
    bevonden, anders dan de eerdere `ThemeToggleCorner`-oplossing die juist
    was ingevoerd om de knop *wél* altijd bereikbaar te maken (de knop zat
    daarvóór in de rechterbovenhoek van de footer-strip en was daardoor
    onbereikbaar in list-mode — zie `tests/theme.spec.mjs`, dat nu andersom
    eerst `←` naar stop 1 drukt vóór het de knop verwacht). Op `/pr-overview`
    (geen footer, geen `state.mode`) staat de knop ongewijzigd in de
    **overview-header** (`overview.mjs`'s `headerBlock`, naast de bestaande
    PR-teller-pill) — die pagina heeft geen `showDescription`-gating.
  - **Persistentie:** `localStorage.getItem/setItem('theme', ...)` —
    bewust **buiten** `bindUrlState`/de query-string (geen navigatiepositie,
    hoort niet in een deelbare link) maar ook niet efemeer zoals
    `state.showApproved` (een thema-keuze wil je onthouden over een refresh).
  `overview.html` had ooit een **geforceerde** dark-modus (`<html
  class="dark">` + `darkMode:'class'`, en `overview.mjs` gebruikte kale
  `zinc-*`-klassen zonder enige `dark:`-variant); dat is verwijderd —
  `overview.mjs` kreeg een lichte basis-klasse vóór elke voorheen-kale
  dark-klasse (die laatste kreeg een `dark:`-prefix), symmetrisch met hoe
  `index.html`/`home.mjs`/`Block.mjs`/`BlockList.mjs`/`RelatedPanel.mjs`/
  `CommandMenu.mjs`/`Footer.mjs` (voorheen licht-only) een `dark:`-variant
  achter elke bestaande kleur-klasse kregen.
  **Kleurenpalet:** neutrals mappen 1-op-1 tussen de twee families die al in de
  codebase bestonden — licht `slate-*` (`bg-white`/`bg-slate-50/100/200`,
  `text-slate-900..400`, `border-slate-100/200/300`) ↔ donker `zinc-*`
  (`bg-zinc-900/950/800/700`, `text-zinc-100..500`,
  `border-zinc-800/700`, meestal met een `/NN`-opacity-suffix voor een
  subtielere kaart-tint dan de solide `overview.mjs`-dark-tinten). Semantische
  accentkleuren (emerald/rose/amber/sky/red/de category-badge-hues in
  `BlockList.mjs`'s `CATEGORY_STYLE`) behouden hun hue maar krijgen een
  contrast-passende schakering per modus: een lichte kaart-tint
  (`bg-emerald-50`/`text-emerald-700`) wordt `dark:bg-emerald-500/15
  dark:text-emerald-300`, en omgekeerd (`overview.mjs`'s
  `text-emerald-300`-op-donker wordt licht `text-emerald-700`). Solide,
  verzadigde accent-knoppen/badges (`bg-indigo-500`, `bg-emerald-600` met
  `text-white`) en laag-opaciteit rings (`ring-emerald-500/30` e.d.) werken in
  beide modi zonder wijziging en zijn bewust ongemoeid gelaten — alleen
  achtergrond/tekst-vlakken die *op de pagina- of kaart-achtergrond* rusten
  hebben een aparte licht/donker-schakering nodig.
  **Wat geen Tailwind-`dark:`-variant kan gebruiken** (losse CSS, geen
  utility-klasse): de Prism-tokenkleuren en de `.markdown-body`-typography in
  `index.html`'s `<style>`-blok. Die staan in **twee** gelijke blokken: het
  bestaande `@media (prefers-color-scheme: dark) { … }`-blok (fallback voor
  het moment vóór `theme.mjs` heeft gedraaid) én een **`:root[data-theme=
  "dark"] …`-mirror** ernaast (elke selector letterlijk gedupliceerd met dat
  attribuut-prefix — bewust géén CSS-nesting, voor maximale
  browser-compatibiliteit) die daadwerkelijk wint zodra de handmatige toggle
  de OS-instelling overridet. Beide delen hetzelfde palet: een
  GitHub-dark-geïnspireerd Prism-palet + de zinc/indigo-kleuren van de rest
  van de dark-modus.
  **Diff-rij-achtergronden** (`Block.mjs`, `paneHTML`) zijn arbitrary-value
  hex-klassen (`bg-[#fed7dc]` etc., "20% richting wit" gemixt met de
  Tailwind-rose/emerald-shade — zie `blocks-and-ingest.md`); die kregen een
  `dark:bg-{kleur}-500/{opacity}`-tegenhanger (bv. `dark:bg-rose-500/25` voor
  de actieve del-rij, `dark:bg-rose-500/10` voor de filler-tint) in plaats van
  een tweede hardcoded hex — eenvoudiger en consistent met de rest van het
  donkere palet.
  **arrow.js-conform:** waar een class-string via een reactieve
  `class="${() => ...}"`-functie-binding loopt, zit de `dark:`-klasse gewoon
  **in dezelfde template-string** als de rest van die waarde (geen aparte
  losse binding) — dus geen nieuwe valkuil bovenop de bestaande
  "hele-waarde-in-één-binding"-regel verderop in dit bestand.
- Go: `net/http` `ServeMux`, handlers per feature. De `/api/`-bridge shelt uit naar
  `gh`/`claude` via `os/exec` — valideer altijd input voordat je het aan een
  subproces geeft.
- **Code (Go + JS) is Engels** — comments, log-berichten en identifiers. De docs in
  `.claude/` en `CLAUDE.md` blijven Nederlands.
- **Git worktrees mogen** — Claude/agents mogen gerust een git-worktree opzetten om
  geïsoleerd of parallel aan een taak te werken (b.v. de Agent-tool met
  `isolation: worktree`). Een eerdere afspraak verbood dit; die is hierbij
  ingetrokken. (Niet te verwarren met de **app-eigen** base/head-worktrees onder
  `data/worktrees/` uit de ingest-pipeline — die blijven zoals beschreven in
  `.claude/rules/blocks-and-ingest.md`.)

## Playwright-test-infra (per-worker geïsoleerde server)

- De Go-binary wordt **één keer** gebouwd in `globalSetup` (`tests/_setup.mjs` →
  `go build -o tests/.tmp/slash .`), nooit per test.
- Er is **geen gedeelde `webServer`** meer. Elke Playwright-worker krijgt via de
  worker-scoped fixture in **`tests/_fixtures.mjs`** zijn **eigen** geseede
  SQLite-DB én **eigen** server op **poort `4200 + workerIndex`**. Omdat `newTasks`
  álle module-DB's (comments/workflows/relations/callresolve/inbox/prmeta) **naast**
  het `-db`-pad zet (`filepath.Dir`), isoleert één `-db tests/.tmp/w<n>/test.db`
  meteen **alle write-state** per worker. De read-only base/head-worktrees onder
  `data/` blijven gedeeld (server-`dataDir` is hardcoded `"data"`). Dit haalt de
  cross-worker **write-races** weg (comment/workflow-SQLite-contention gaf eerder
  een lege `runId`) én de page-load-contentie die de suite flaky maakte.
- **Spec-imports:** elke spec importeert `{ test, expect }` uit **`./_fixtures.mjs`**
  (niet `@playwright/test`), zodat `page.goto('/pr/…')` de eigen worker-server raakt
  (de fixture overschrijft `baseURL`).
- **Workers = 4** op deze 8-core-box: elke worker draait een Go-server **plus** een
  Chromium, dus hoger (6+) verzadigt de machine en gaf flaky assertion-timeouts.
  `expect`-timeout staat op **15s** (ruimte voor een trage render tijdens een
  startup-piek; geslaagde tests blijven <1s) en `retries: 1` vangt de resterende
  cold-start **mount-race** op (een paar specs mounten een component via een
  dynamische `import()` in `page.evaluate()` tegen de live app-pagina — nodig voor
  de Tailwind/Prism-CSS van `index.html` — en de `history.replaceState`-burst van de
  app tijdens load kan die mount kort verstoren). Een echte fout faalt beide pogingen.
- **Data-kanttekening:** de diff-inhoud (`/api/code`) komt uit de **gitignored**
  `data/worktrees/pr-<n>-{base,head}` — géén gecommitte fixture. Zijn die lokaal naar
  een andere commit gedreven (b.v. base+head op twee náást elkaar liggende commits
  i.p.v. base=merge-base), dan tonen de meeste blokken **geen** wijzigingen en falen
  diff-inhoud-afhankelijke tests. Anker diff-navigatie-tests daarom op een blok dat
  betrouwbaar een wijziging draagt (blok 0 van PR 12903).
- **Een nieuwe fixture-PR die écht diff-inhoud nodig heeft** (niet alleen
  child-listing/drill-mechaniek zoals PR 90/91/92/93/94, die bewust géén
  worktree op disk hebben) kan zijn eigen kleine `data/worktrees/pr-<n>-
  {base,head}` **programmatisch materialiseren in `globalSetup`**
  (`tests/_setup.mjs`) i.p.v. op een echte, lokaal-aanwezige `gh`/`git`-ingest
  te leunen (die niet reproduceerbaar is op een andere machine/CI) — zie
  `materializeTreeWorktrees` (PR 95, `tests/postapprove-tree.spec.mjs`): een
  paar hand-geschreven PHP-bestandjes met één echt gewijzigde regel, geschreven
  vóór elke worker start (shared, read-only, net als de bestaande worktrees),
  met de bijbehorende `blocks.json`/`relations.json` toegevoegd aan `seed()`
  in `tests/_fixtures.mjs`.
- **De harness forceert offline altijd, ongeacht de shell-omgeving:** de
  worker-fixture (`tests/_fixtures.mjs`) start elke server met **zowel
  `SLASH_GITHUB=off` als `SLASH_CLAUDE=off`** hardcoded in de `spawn`-`env`
  (`{ ...process.env, SLASH_GITHUB:'off', SLASH_CLAUDE:'off', … }`) — het spreidt
  wel de rest van `process.env`, maar deze twee liggen vast. Zonder de
  hardcoded `SLASH_CLAUDE=off` shelde een worker die vanuit een shell zónder die
  var werd gestart, echt uit naar de `claude`-CLI voor de automatische
  call-resolution-search (`resolve_call`); dat stalt/timeout't en liet
  comment-flow-specs (b.v. `repro-live-comment.spec.mjs`) niet-deterministisch
  falen, afhankelijk van hoe de suite toevallig werd aangeroepen. Geen enkele
  spec verwacht een echte (niet-Fake) `claude`-client — de LLM-resolved paden
  worden via seed-fixtures getest (`tests/fixtures/callresolve.json`) — dus de
  Fake overal forceren is veilig. **Draai de suite dus nooit met losse
  `SLASH_GITHUB`/`SLASH_CLAUDE`-env-vars om 'm offline te krijgen** — dat doet de
  harness al; die vars zijn alleen nog relevant voor `go run .`/`slash`
  buiten Playwright om.
