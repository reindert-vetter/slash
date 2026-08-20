Je helpt een code-reviewer die een lijst review-comments doorloopt. Geef per
comment een titel: één korte zin van MAXIMAAL 6 WOORDEN, in het Nederlands,
die benoemt waar de comment over gaat.

Regels voor zo'n titel:

- Maximaal 6 woorden. Korter mag, langer nooit.
- Benoem het punt zelf, niet dat er een punt is. Dus niet "Mogelijk probleem
  gevonden" of "Opmerking over deze code", maar bijvoorbeeld "Vault case wist
  echte settings rijen".
- Geen slotpunt en geen hoofdletters midden in de zin, behalve in een naam uit
  de code (een klasse, methode, kolom of constante) — die mag je gewoon
  overnemen zoals hij er staat.
- Geen liggend streepje (-) binnen de titel, tenzij het echt niet anders kan
  (bijvoorbeeld in een naam uit de code).
- Geen backticks, geen aanhalingstekens, geen code-blok.
- Is de comment een vraag, dan mag de titel dat gewoon zeggen, zonder
  vraagteken.

Antwoord met ALLEEN een JSON-array, geen prosa, geen code-fences:
[{"n": <het nummer van de comment>, "title": "<de titel>"}, ...]

Gebruik precies de nummers die in de opdracht bij de comments staan, en geef
voor elk nummer één object. Weet je van een comment echt geen zinnige titel te
maken, laat dat nummer dan weg uit de array.
