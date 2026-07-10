---
name: new-component
description: Scaffold a new arrow.js frontend component (.mjs) in src/ following the vanilla-JS/no-build conventions of this repo. Use when adding a new UI block, page module, or reactive widget to the PR Review Tree dashboard.
---

# Nieuw frontend-component

Maak een nieuw `.mjs`-component dat past bij de stack: vanilla ES-modules, arrow.js
voor reactiviteit, Tailwind (Play CDN) voor styling. **Geen** bundler, geen JSX,
geen framework.

## Stappen

1. Bepaal het type en dus de bestandsnaam:
   - **Component/block** → PascalCase, bv. `src/Block.mjs`.
   - **Pagina-module** → lowercase, bv. `src/home.mjs`.
2. Kopieer `.claude/templates/Component.mjs` naar de juiste locatie en hernoem.
3. Vul in en verwijder ongebruikte regels. Houd je aan:
   - Default export = functie die `reactive()` state accepteert en een arrow.js
     `html\`\`` template **teruggeeft** (niet zelf mounten).
   - Reactieve waarden staan in `${() => ...}`, events als `@click="${...}"`,
     lijsten met `.map(...).key(id)`.
   - Styling met Tailwind-classes; geen losse CSS-bestanden tenzij nodig.
4. Importeer en mount het component in de parent-module met `template(el)`.
5. Voeg zo nodig een Playwright-test toe die het gerenderde gedrag checkt.

## arrow.js-valkuilen (uit de praktijk)

- **Geen HTML-comments** (`<!-- ... -->`) in een `html\`\`` template — arrow.js gooit
  dan "Invalid HTML position". Gebruik JS-comments buiten de template.
- Een reactieve **attribuut-waarde moet de hele waarde zijn**: `class="${() => ...}"`,
  niet `class="static ${() => ...}"`. Bouw de volledige string in de arrow-functie.
- Test-hooks: geef rijen een `data-testid` zodat Playwright ze stabiel kan selecteren.

## Niet doen

- Geen npm-package toevoegen voor iets dat vanilla kan.
- Geen CDN-import van een module (behalve Tailwind Play CDN); vendored libs
  importeer je relatief uit `src/vendor/`.
