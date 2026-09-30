# Fluxuri implementate

Inventarul descrie comportamentul disponibil în aplicație la 30 septembrie 2026. Etichetele îngroșate reproduc, pe cât posibil, denumirile din interfața în limba română.

## 1. Activarea și accesul

1. Casierul generează o invitație din consola privată pentru o clasă și un rol.
2. Codul poate activa două dispozitive în cele șapte zile de valabilitate. Fiecare browser sau profil are propria sesiune și poate fi revocat separat.
3. **Adaugă acces din invitație** atașează încă o clasă dispozitivului curent, fără să elimine accesurile existente.
4. Rolurile sunt **Casier**, **Părinte** și **Auditor**. Accesul părintelui sau auditorului poate avea o dată de expirare.
5. Proprietarul poate crea clase noi. Selectorul din antet schimbă clasa activă atunci când dispozitivul are mai multe accesuri.

## 2. Configurarea clasei

- Se configurează școala, clasa, anul școlar și soldul inițial. Soldul inițial poate fi schimbat numai înainte de prima operațiune financiară.
- Se pot încărca sigla școlii și sigla clasei; acestea apar în aplicație și în rapoartele PDF emise ulterior.
- Se pot salva separat linkul Revolut.me, numele beneficiarului și IBAN-ul, cu validare pentru link și IBAN.

## 3. Copiii și contactele

- Copiii se adaugă individual sau în bloc dintr-o listă `Nume de familie; Prenume`.
- Un copil poate fi editat sau arhivat. Lista permite căutarea și afișarea copiilor arhivați.
- Pentru fiecare copil se pot salva zero, unul sau două contacte WhatsApp, cu etichetă și număr normalizat. Lista arată casierului dacă lipsește telefonul sau câte contacte sunt configurate.
- Fișa copilului reunește contribuțiile, suma totală de achitat, avansul disponibil, istoricul, încasarea și instrumentele WhatsApp.

## 4. Crearea și administrarea cheltuielilor

- Sunt disponibile trei calcule: sumă fixă per copil, total împărțit exact între participanți și cantitate per copil înmulțită cu prețul unitar.
- Casierul selectează participanții, data, termenul și comentariul. Împărțirea lucrează în bani întregi și distribuie determinist ultimii bani.
- La o cheltuială împărțită, participanții pot fi schimbați și sumele recalculate până la prima contribuție alocată, chiar dacă există deja o plată către furnizor sau un avans personal asociat.
- După încasări, câmpurile descriptive rămân editabile. La calculul pe cantități sunt permise doar corecțiile care nu coboară contribuția sub suma deja stinsă și nu fac totalul incompatibil cu plățile legate.
- O cheltuială poate fi anulată după ce nu mai are încasări, acoperiri sau plăți active asociate.

## 5. Încasarea de la un copil

1. Casierul atinge cardul copilului și alege totalul de achitat sau o singură contribuție.
2. Poate introduce suma primită, folosi rotunjirea în sus la 5, 10, 50 sau 100 lei și repartiza suma automat sau manual.
3. Pentru surplus alege **Dau rest** sau **Păstrez în avans**. Înainte de salvare vede numerarul primit, suma acoperită, restul, avansul nou și cât rămâne de achitat.
4. Dacă există deja avans la copil, **Folosește avansul copilului** îl poate aplica în aceeași operațiune, inclusiv fără numerar nou când acoperă tot.
5. Pentru un rest de cel mult 1 leu sunt disponibile păstrarea datoriei, acoperirea din avansul copilului și o ajustare de rotunjire fără mișcare de numerar.
   Dacă încasarea parțială a fost deja salvată, restul poate fi închis ulterior din **Nu mai colectez** ca ajustare de rotunjire.
6. Salvarea este idempotentă. După pierderea răspunsului, **Verifică / reîncearcă** nu dublează încasarea; o modificare concurentă cere reîmprospătarea și verificarea sumelor.

### Plata directă către beneficiar

- Din fișa copilului, **Înregistrează plata directă** stinge integral sau parțial o singură contribuție atunci când părintele a predat banii direct doamnei diriginte, fotografului sau altui beneficiar.
- Se păstrează contribuția, suma, beneficiarul, data și comentariul. Numerarul clasei nu se modifică și nu este creată o încasare fictivă urmată de o plată fictivă.
- Operațiunea apare distinct în registru, situația cheltuielii, fișa copilului și tabelul contribuțiilor și poate fi anulată prin corecție.

## 6. Renunțarea la colectarea unei contribuții

- Din **Nu mai colectez**, un copil poate fi scos dintr-o cheltuială împărțită atunci când recalcularea încă este permisă. Totalul cheltuielii rămâne același, iar părțile celorlalți participanți se refac automat.
- Dacă există un avans personal nerestituit fondului, contribuția poate fi acoperită parțial sau integral din el. Copilul nu apare ca plătit de părinte, datoria clasei față de persoana care a avansat banii scade, iar numerarul nu se mișcă din nou.
- După o încasare parțială, un rest de cel mult 1 leu poate fi închis ca **Ajustare de rotunjire**. Suma primită rămâne cea reală, diferența apare separat, iar numerarul nu se modifică.
- Acoperirea și ajustarea sunt operațiuni separate, vizibile în registru și rapoarte, și pot fi anulate cu motiv.

## 7. Registrul financiar

- Registrul arată soldul de numerar, avansurile copiilor, sumele avansate personal fondului, datoriile de restituit și soldul net după aceste datorii.
- Casierul poate înregistra bani dați, cu destinație, dată, comentariu și asociere opțională la o cheltuială.
- Un avans personal adaugă numerar și o datorie egală a clasei. Poate fi restituit parțial sau integral ori folosit pentru acoperirea unor contribuții.
- Avansul unui copil poate fi aplicat contribuțiilor sau restituit.
- Operațiunile confirmate nu se șterg. **Corecție** adaugă o anulare cu motiv și inversează efectele o singură dată.
- Istoricul este ordonat descrescător după data operațiunii, cu cele mai recente înregistrări primele.

## 8. Documentele justificative

- La cheltuieli și plăți se pot atașa PDF-uri și imagini JPG, PNG sau WebP.
- Vizibilitatea este **internă** pentru casier și auditor sau **clasă** și pentru părinții autorizați.
- Fișierele sunt imuabile și au amprentă SHA-256. Limitele sunt 10 MB per fișier, 25 de documente per înregistrare și 200 MB per clasă.

## 9. WhatsApp și detaliile de plată

- Contactul salvat deschide conversația directă cu situația copilului și detaliile de plată precompletate. Trimiterea rămâne manuală în WhatsApp.
- **Remindere WhatsApp** afișează copiii activi cu sume restante și evidențiază contactele lipsă.
- După generarea raportului individual, casierul alege între **Doar mesajul** și **Copiază mesajul + PDF**. Pentru PDF, textul este copiat înainte de deschiderea selectorului, astfel încât să poată fi lipit în conversație dacă WhatsApp îl omite când primește fișierul.
- Rapoartele agregate au texte de partajare potrivite tipului lor și pot fi trimise prin același selector.
- Linkul Revolut.me, beneficiarul și IBAN-ul au acțiuni separate de copiere sau partajare. Mesajul Revolut precizează că linkul acceptă plata cu cardul și fără cont Revolut.

## 10. Rapoartele

- Se emit PDF-uri imuabile pentru situația clasei, o cheltuială, un copil și **Tabelul contribuțiilor**.
- Situația clasei, raportul cheltuielii și tabelul arată procentul de acoperire. Banii încasați în fond, plățile directe către beneficiari și sumele acoperite din fond apar separat.
- Dacă toate contribuțiile unei cheltuieli sunt identice, situația clasei și raportul cheltuielii afișează explicit **Contribuție per copil**. Pentru un total împărțit cu diferență de un ban, raportul folosește suma de bază mai mică pentru toți, iar registrul păstrează repartizarea exactă.
- Tabelul contribuțiilor afișează lângă numele fiecărui copil totalul rămas de plată pentru toate contribuțiile active.
- Detaliile de plată apar în rapoartele clasei, cheltuielii și copilului. Tabelul intern al contribuțiilor le omite.
- Fiecare raport păstrează datele, siglele și culorile de la emitere. O corecție de raport creează o versiune nouă legată de cea înlocuită.
- Rapoartele pot fi previzualizate adaptiv, descărcate și partajate.

## 11. Vizualizarea pentru părinte și auditor

- Părintele vede doar situația generală și propriul copil: contribuții, termene, avansuri și rapoartele permise. Nu primește numele, tranzacțiile sau contactele altor copii.
- Auditorul vede situația financiară completă, documentele și rapoartele autorizate, fără contacte. Nu poate modifica registrul și nu poate exporta datele brute.

## 12. Adaptarea la dispozitiv și funcționarea PWA

- Pe telefon, încasarea rămâne la baza ecranului. Pe tabletă și laptop, listele și panourile folosesc spațiul în coloane, iar previzualizarea PDF se redesenează la rotire sau redimensionare.
- Rotirea ecranului păstrează schița încasării, selecția și repartizarea manuală.
- Aplicația poate fi instalată ca PWA. Actualizarea evită întreruperea unui formular modificat sau a unei salvări în curs.
- Interfața instalată și resursele statice pot porni din cache, dar datele API nu sunt păstrate pentru lucru offline. Orice salvare necesită internet și nu există coadă de operațiuni offline.

## 13. Ajutorul general și contextual

- Semnul întrebării din antet deschide ghidul general pentru toate rolurile. Acesta arată traseul principal prin Copii, Cheltuieli, Încasări, Registru și Rapoarte.
- Ghidul casierului desenează toate cele 16 fluxuri: activare, configurare, copii, cheltuieli, încasare, plată directă beneficiarului, **Nu mai colectez**, avansul copilului, registru, corecții, documente, WhatsApp, rapoarte, mai multe clase și roluri, funcționarea cu probleme de conexiune și exportul/backup-ul.
- Aceleași fluxuri sunt disponibile în repository ca patru [planșe SVG statice](workflows/README.md), alături de sursele Mermaid din [ghidul vizual](visual-flow-guide.md).
- Fiecare ecran principal deschide direct fluxul său. Formularele pentru activare, configurare, cheltuieli, contacte, documente, avansuri și rapoarte includ ajutorul contextual în aceeași fereastră.
- **Cum încasez?** deschide fluxul relevant fără să șteargă suma sau repartizarea deja introduse. În **Nu mai colectez**, diagrama afișează numai variantele disponibile în acel moment.
- Părintele și auditorul primesc ghiduri distincte, potrivite accesului lor doar pentru citire.
- Diagramele pentru toate fluxurile sunt păstrate și în [ghidul vizual](visual-flow-guide.md).

## 14. Exportul, backup-ul și operarea

- Exportul JSON conține datele de business și istoricul, fără credentiale, contacte sau conținutul documentelor. Nu este un format de restaurare automată.
- Backup-ul operațional salvează consistent bazele SQLite, inclusiv contactele și documentele. Serviciul instalat creează zilnic copii locale.
- Procedurile de instalare, verificare, backup și restaurare manuală sunt descrise în [ghidul de operare](operations.md).
