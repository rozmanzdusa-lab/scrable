Skrebl + FRAN + pomen besede + Netlify

Struktura:
- index.html
- netlify.toml
- netlify/functions/fran-check.js

Objava na Netlify:
1. Razpakiraj projekt.
2. Povleci celotno mapo na Netlify Drop ali jo poveži z GitHub repozitorijem.
3. Netlify bo objavil index.html.
4. Funkcija bo dostopna na /.netlify/functions/fran-check.

Novosti:
- prikaz vseh besed, ki jih je FRAN preveril
- gumb za preverjanje pomena besede

Opomba:
Preverjanje in izpis pomena temeljita na iskalni strani FRAN. Če FRAN spremeni strukturo ali sporočila,
bo morda treba prilagoditi funkcijo fran-check.js.
