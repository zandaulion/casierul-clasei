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

## Rapoarte

Ecranul rapoartelor continuă tema caietului: o ilustrație mică de papetărie în introducere, colțuri îndoite și accente pastelate pe cele patru tipuri de raport. Arhiva păstrează la vedere data, codul, revizia și acțiunile de consultare, partajare, descărcare și corectare.

PDF-urile nou emise au un antet pastelat cu un caiet, creion și avion de hârtie, marcaje discrete pentru secțiuni și un mic avion în subsol, lângă „Cu grijă pentru clasa noastră.”. Siglele școlii și clasei, codul și numărul paginii rămân distincte. Accentele decorative stau în afara datelor; culorile stărilor de plată își păstrează sensul. Titlurile și etichetele folosesc „Tabelul contribuțiilor”, „Fișa copilului” și „De achitat”; textele lungi primesc spațiu în funcție de înălțimea măsurată.

Aceste ilustrații sunt desenate în cod: SVG local în `web/app.js`, respectiv primitive vectoriale PDFKit în `server/report-art.mjs`. Rămân clare la imprimare și nu adaugă dependențe, imagini raster sau servicii externe. Prezentarea nouă se aplică la emitere; PDF-urile deja arhivate păstrează conținutul și aspectul original.

Cheltuielile din situația clasei, raportul individual al cheltuielii și antetul Tabelului contribuțiilor afișează acoperirea din contribuții: `collectedMinor / totalMinor`, cu bară vectorială și procent scris. Procentul folosește cel mult o zecimală, rotunjită în jos; 100% apare doar la acoperire integrală. O contribuție pozitivă sub 0,1% apare ca „<0,1%”. Pentru necesar zero se afișează „Fără sumă de acoperit” (în antetul tabelului: „—”). Plățile, finanțarea temporară și avansurile nealocate nu sunt contribuții încasate pentru cheltuială.

## Aspect adaptiv

- Sub 720 px, navigarea rămâne la baza ecranului și listele au o coloană. Spațiul rezervat navigării și încasării urmărește înălțimea reală a controalelor, inclusiv la text mărit.
- De la 720 px, cadrul crește fluid până la 1360 px. Copiii, cheltuielile și tipurile de raport folosesc coloane în funcție de spațiul disponibil; căutarea păstrează o lățime confortabilă.
- De la 1000 px, registrul separă sumarul și istoricul, iar situația copilului separă sumarul și contribuțiile. Încasarea are contribuțiile în stânga și un panou de confirmare în dreapta, cu derulare proprie când înălțimea ecranului este mică. Cadrul încasării se oprește la 1180 px.
- De la 1120 px, aceleași patru destinații apar într-o navigare laterală care rămâne vizibilă la derulare. Ordinea în document este antet, navigare, conținut, pentru acces consecvent cu tastatura.
- Formularele rămân la o lățime lizibilă. Dialogul PDF poate ajunge la 1180 px, cu pagina redată clar până la 1120 px; rotirea sau redimensionarea refolosește PDF-ul încărcat și păstrează poziția de derulare.
- Schimbarea dimensiunii folosește CSS, fără reconstruirea formularelor. Sumele, repartizările, comentariile și câmpul activ rămân intacte. Invitația păstrează un cadru simplu de 620 px.

## Verificare

`npm test` verifică regulile existente ale registrului. `node scripts/browser-check.mjs` verifică fluxurile complete; `node scripts/browser-polish-check.mjs` verifică aspectul și navigarea casierului, părintelui și auditorului, inclusiv telefoane înguste, ecrane mari, temă întunecată și text mărit. Verificările în browser folosesc date sintetice în baze temporare.

Testele PDF din `test/reports.test.mjs` verifică sumele, confidențialitatea, siglele și corecțiile, precum și textele lungi pe mai multe pagini, fără suprapuneri. Pentru previzualizări sintetice: `CASIERUL_REPORT_PREVIEW_DIR=/tmp/casierul-report-design node --test test/reports.test.mjs`. Exportul opțional al imaginilor necesită `pdftoppm`; testele obișnuite nu îl folosesc.
