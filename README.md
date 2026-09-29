# Casierul clasei

PWA pentru evidența fondurilor mai multor clase și școli. Interfață în română, sume în lei, date persistente pe server în SQLite.

O atmosferă de comunitate școlară, cu ilustrații discrete, culori calde și situații de plată explicate pe înțelesul tuturor. Pe telefon, încasarea rămâne la îndemână; pe ecrane mari, registrul așază soldul și istoricul alături.

Aplicația: https://casierul-clasei.zandaulion.com

## Capturi de ecran

Datele afișate în capturi sunt integral sintetice.

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/01-copii-mobile-390x844.png" alt="Lista copiilor pe telefon" width="300"><br><strong>Lista copiilor · 390×844</strong></td>
    <td align="center"><img src="docs/screenshots/02-incasare-mobile-412x915.png" alt="Încasare rapidă pe telefon" width="300"><br><strong>Încasare rapidă · 412×915</strong></td>
  </tr>
</table>

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/03-cheltuieli-tableta-768x1024.png" alt="Cheltuieli pe tabletă" width="440"><br><strong>Cheltuieli · 768×1024</strong></td>
    <td align="center"><img src="docs/screenshots/04-rapoarte-tableta-1024x768.png" alt="Rapoarte pe tabletă" width="440"><br><strong>Rapoarte · 1024×768</strong></td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/05-registru-desktop-1440x900.png" alt="Registrul clasei pe desktop" width="900"><br>
  <strong>Registru · 1440×900</strong>
</p>

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/06-documente-tableta-768x1024.png" alt="Document justificativ atașat unei plăți" width="440"><br><strong>Documente justificative · 768×1024</strong></td>
    <td align="center"><img src="docs/screenshots/07-raport-pdf-tableta-1024x768.png" alt="Previzualizarea PDF a Tabelului contribuțiilor" width="440"><br><strong>Raport PDF în aplicație · 1024×768</strong></td>
  </tr>
</table>

## Începe

1. Generează o invitație în consola PWA privată și activează telefonul.
2. Configurează școala, clasa, anul școlar și eventualul sold inițial.
3. Din **Copiii clasei → Gestionează copiii**, adaugă copiii individual sau lipește lista, câte un `Nume de familie; Prenume` pe linie.
4. Creează cheltuielile și selectează participanții: sumă fixă/copil, total împărțit sau cantitate/copil × preț unitar.

Invitațiile pot acorda trei tipuri de acces. **Casierul** vede și modifică întregul registru. **Părintele** are acces doar pentru citire la situația generală și la datele copilului asociat, fără numele sau tranzacțiile celorlalți copii. **Auditorul** vede registrul complet și rapoartele, dar nu poate modifica sau exporta datele brute. Accesul doar pentru citire poate expira automat la data aleasă în consola PWA.

Părintele cu un singur copil asociat ajunge direct la situația lui: contribuții, termene, avansuri și rapoarte disponibile.

Proprietarul poate adăuga alte clase din setări. Fiecare clasă are bază de date, copii, cheltuieli, rapoarte, sigle și drepturi proprii. Selectorul din antet apare când dispozitivul are acces la mai multe clase. Invitațiile se emit pentru o singură clasă și un singur rol; pentru părinte se alege și copilul. **Adaugă acces din invitație** păstrează accesurile existente, astfel încât același dispozitiv poate avea roluri diferite în clase diferite. Pașii compleți sunt în [ghidul pentru mai multe clase și drepturi](docs/multiple-classrooms.md).

## Încasare rapidă

Atinge copilul din lista alfabetică, apoi alege totalul de achitat sau o singură cheltuială. Butoanele mari rotunjesc în sus la multiplu de 10, 50 sau 100 lei, pornind mereu de la suma selectată. Un multiplu exact rămâne neschimbat.

Pentru diferență, alege **Dau rest** sau **Păstrez în avans**. Dacă ai selectat o singură cheltuială, diferența nu se repartizează automat către alte datorii. Poți introduce suma primită și repartizarea manual. Rezumatul de lângă salvare arată suma primită, restul și suma înregistrată. Verifică-l și salvează; aplicația revine la lista copiilor și confirmă încasarea pentru copilul ales.

Avansul poate acoperi ulterior alte contribuții sau poate fi restituit. Folosirea avansului nu înregistrează încă o intrare de bani.

## Evidență

- **Copii:** contribuții, restanțe, avansuri și istoricul fiecărui copil.
- **Cheltuieli:** participanți, contribuții calculate, termen, sume încasate și plătite. O cheltuială poate fi editată; suma, calculul și participanții se blochează cât timp are operațiuni financiare active, iar denumirea, datele și comentariile rămân editabile. Pentru calculul pe cantități, cantitatea unui participant existent poate fi corectată dacă noua contribuție nu scade sub suma deja achitată.
- **Registru:** numerar disponibil, încasări, bani dați, restituiri, corecții și sume avansate temporar fondului. O sumă plătită personal poate fi asociată unei cheltuieli și restituită apoi parțial sau integral; aplicația arată separat cât îi mai datorează clasa persoanei care a avansat banii.
- **Documente justificative:** atașează PDF-uri sau fotografii la cheltuieli și la plățile din registru. Fiecare document are amprentă SHA-256 și poate rămâne doar pentru casier/auditori sau poate fi făcut vizibil părinților cu acces la clasă. Limitele sunt 10 MB per fișier, 25 de documente per înregistrare și 200 MB per clasă.
- **Corecții:** operațiunile confirmate se anulează printr-o înregistrare separată, cu motiv, păstrând istoricul. O cheltuială fără încasări sau plăți active poate fi anulată și recreată.
- **Export:** copie JSON a datelor și istoricului, fără credentiale. Restaurarea automată din JSON nu este inclusă.
- **Identitate vizuală:** sigla școlii și sigla clasei configurate din aplicație apar compact în antetul aplicației și în antetul PDF-urilor.
- **Rapoarte PDF:** situația clasei, **Tabelul contribuțiilor** și rapoarte pentru fiecare copil sau cheltuială, cu vizualizare directă în aplicație, partajare și descărcare; verde pentru achitat, galben pentru parțial, roșu pentru neachitat, albastru pentru solduri și bani dați mai departe. Fiecare PDF păstrează siglele și culorile de la momentul emiterii.

Rapoartele au mici accente de papetărie: caiet, avion de hârtie și culori pastelate pentru fiecare tip. PDF-urile nou emise folosesc aceleași motive discrete în antet și subsol, păstrând sumele și tabelele clare. PDF-urile deja arhivate rămân exact în forma în care au fost emise.

În situația clasei, în raportul unei cheltuieli și în antetul Tabelului contribuțiilor, fiecare cheltuială are o bară și un procent de acoperire: contribuțiile încasate împărțite la necesarul total. Plățile către furnizori, sumele avansate temporar și avansurile nealocate ale copiilor nu intră în acest procent.

Sumele sunt stocate în bani întregi; împărțirea unui total distribuie exact și ultimii bani. Contribuțiile confirmate nu se recalculează automat; modificările permise se fac explicit prin editarea cheltuielii. Numerarul disponibil include avansurile copiilor și sumele avansate temporar fondului, iar datoriile aferente sunt afișate separat. „Sold după restituirea sumelor avansate” arată ce ar rămâne după stingerea lor. Documentele sunt incluse în copiile de siguranță SQLite; exportul JSON conține numai metadatele lor.

Salvarea necesită internet. La pierderea răspunsului, **Verifică / reîncearcă** confirmă aceeași cerere fără dublarea încasării. Modificările făcute pe alt dispozitiv cer verificarea sumelor înainte de salvare. Nu există coadă de operațiuni offline.

## Tehnic și operare

Node.js 24+ și `node:sqlite`; PDF-urile sunt generate cu PDFKit, iar previzualizarea folosește o copie locală PDF.js. Interfața nu încarcă biblioteci, fonturi sau alte resurse de pe CDN-uri. Aplicația folosește mecanismul de actualizări din `../pwa-kit` și administrarea invitațiilor/dispozitivelor din `../pwa-invite-console`.

Ilustrațiile rapoartelor sunt vectoriale: SVG în interfață și desen direct cu PDFKit în PDF, fără dependențe sau servicii externe suplimentare.

```
npm test
./deploy.sh https://casierul-clasei.zandaulion.com
```

Cloudflare Tunnel folosește `http://127.0.0.1:8018`. API-ul privat de administrare ascultă separat pe `127.0.0.1:8118`. Publicarea instalează serviciul systemd, integrarea consolei și copii de siguranță locale zilnice.

Detalii: [mai multe clase și drepturi](docs/multiple-classrooms.md), [operare și backup](docs/operations.md), [contract API](docs/api.md), [planul de criptare](docs/encryption.md).

Testele folosesc baze temporare și verifică registrul, autentificarea, calculele interfeței și integrarea HTTP. `scripts/browser-check.mjs` verifică fluxurile complete într-un context Chromium separat, cu server temporar pe portul 18018 și Chromium disponibil prin debugging pe portul 9222.

`node scripts/browser-polish-check.mjs` verifică aspectul și navigarea casierului, părintelui și auditorului pe telefoane, tablete și desktop, în ambele teme și cu text mărit. Folosește date sintetice, un server temporar pe portul 18028 și același Chromium pe portul 9222. Paleta, ilustrația și regulile de prezentare sunt documentate în [identitatea vizuală a clasei](design/community-style.md).

Schița interactivă inițială rămâne în `design/collection-flow.html`; `preview/` păstrează exportul ei pentru revenire la instalarea inițială. Aplicația funcțională este în `web/` și `server/`.

## Licență

Acest proiect este distribuit sub licența [GNU General Public License v3.0](LICENSE).
