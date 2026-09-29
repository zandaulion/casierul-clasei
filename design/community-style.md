# Identitatea vizuală a clasei

Direcția aprobată: o comunitate școlară expresivă, cu hârtie caldă, accente de culoare și ilustrații mici. Fluxurile financiare păstrează sumele, explicațiile și acțiunile la vedere.

- Verde pădure pentru acțiuni principale și contribuții achitate.
- Galben cald pentru întâmpinare; piersică pentru cheltuieli, albastru pentru registru și lavandă pentru rapoarte.
- Etichetele „Achitat”, „De achitat” și „Avans” transmit situația și fără culoare. O contribuție neplătită nu este automat întârziată.
- Ilustrația apare în întâmpinare și în privirea de ansamblu. Încasarea păstrează atenția pe contribuții, suma primită, rest și avans.
- Sumele care includ bani afișează două zecimale; sumele întregi rămân compacte.
- Siglele configurate de utilizator au prioritate în antet. Semnul cu caiet este folosit când nu există sigle.

## Ilustrația

`web/illustrations/school-community.webp` este imaginea aprobată în conceptul interactiv, încorporată local (384×256, aproximativ 33 KB). A fost creată cu instrumentul integrat de generare a imaginilor și optimizată pentru afișarea mică; nu necesită servicii externe la rulare.

Promptul folosit: „Small decorative illustration for the header of Casierul clasei, a Romanian school-community contributions app for adult parents and volunteer treasurers. A compact editorial gouache / colored-pencil illustration: an open cream notebook with a tiny schoolhouse drawn on its page, coral and golden-yellow pencils, a forest-green leaf sprig, and a sky-blue paper plane. Friendly stationery illustration, tactile matte paper texture, soft imperfect edges, readable at 110px. Forest green, buttery yellow, muted coral, sky blue and warm ivory. Transparent background; no text, numbers, people, faces, coins or logos.”

## Verificare

`npm test` verifică regulile existente ale registrului. `node scripts/browser-check.mjs` verifică fluxurile complete; `node scripts/browser-polish-check.mjs` verifică aspectul și navigarea casierului, părintelui și auditorului, inclusiv telefoane înguste, ecrane mari, temă întunecată și text mărit. Verificările în browser folosesc date sintetice în baze temporare.
