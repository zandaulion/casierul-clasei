# Operare

## Adrese și procese

- Public: `https://casierul-clasei.zandaulion.com`, prin Cloudflare Tunnel către `http://127.0.0.1:8018`.
- Aplicația Node rulează ca serviciu systemd de utilizator: `casierul-clasei.service`.
- API-ul de administrare ascultă separat pe `127.0.0.1:8118`. Portul public răspunde întotdeauna cu 404 pentru `/api/admin` și subrutele lui.
- Consola privată folosește prefixul `/casierul-clasei`; Caddy injectează credentialul de administrare din configurația privată. Acesta nu este trimis în paginile aplicației sau ale consolei.
- Serviciul `casierul-clasei-preview.service` păstrează previzualizarea în directorul `preview/`, ca variantă de revenire pentru instalarea inițială.

## Instalare pe alt server

Aplicația nu depinde de consola privată sau de Caddy. Variantele generice:

- **Docker**: creează fișierul privat `.env` ca în README, apoi `docker compose up -d`. Serverul este publicat numai pe `127.0.0.1:8018`, datele rămân în volumul `data`, iar invitațiile se emit cu `docker compose exec app node scripts/admin.mjs …`. Publicarea prin HTTPS rămâne în sarcina unui reverse proxy.
- **systemd**: după `npm ci`, `./deploy.sh https://origine-publica` detectează directorul clonei și executabilele Node/Python, generează unitățile în `~/.config/systemd/user` și pornește aplicația chiar și fără consola privată. Clona poate fi amplasată în orice director accesibil utilizatorului serviciului.
- Variabile: `PUBLIC_BASE_URL` (obligatorie), `ADMIN_TOKEN` (fără el API-ul de administrare răspunde 404), `DATA_DIR`, `HOST`/`PORT` (implicit `127.0.0.1:8018`), `ADMIN_PORT` (implicit `8118`) și `COOKIE_SECURE` (`false` doar pentru teste locale fără HTTPS). API-ul de administrare ascultă întotdeauna pe `127.0.0.1`.

Serviciul systemd de utilizator trebuie să poată porni după restart fără autentificare interactivă. `deploy.sh` avertizează dacă această opțiune nu este activă; administratorul serverului o poate activa o singură dată:

```
sudo loginctl enable-linger numele-utilizatorului
```

## Publicare

```
./deploy.sh https://casierul-clasei.zandaulion.com
```

Scriptul rulează testele, pregătește configurația, generează serviciile pentru directorul curent, instalează și serviciul de previzualizare folosit la revenire, pornește aplicația pe portul 8018 și verifică `/api/health`. Dacă serverul are consola privată și Caddy, instalează și ruta acestei aplicații; altfel omite pasul. Instalările următoare pot folosi `./deploy.sh` fără URL. Configurația Caddy este salvată înainte de modificare și validată înainte de reîncărcare.

Scriptul nu instalează Node.js, npm, Python, systemd, un reverse proxy sau certificatul HTTPS. Verifică prezența comenzilor necesare și se oprește înainte de schimbarea serviciilor dacă lipsește una dintre ele.

Fișierele din `web/` sunt încărcate de server la pornire. După orice modificare, repornește serviciul prin deploy. Versiunea workerului este derivată din conținutul fișierelor, prin mecanismul pwa-kit.

## Date și acces

- Configurație: `~/.config/casierul-clasei/app.env` (permisiuni 0600).
- Clasa migrată/inițială: `~/.local/share/casierul-clasei/ledger.sqlite`.
- Clasele adăugate: câte un `~/.local/share/casierul-clasei/classroom-<uuid>.sqlite`.
- Invitații, dispozitive, catalogul claselor și drepturile: `~/.local/share/casierul-clasei/auth.sqlite`.
- Documentele justificative sunt stocate în baza SQLite a clasei, împreună cu amprenta SHA-256 și vizibilitatea lor. Limitele sunt 10 MB per fișier, 25 de documente per cheltuială/plată și 200 MB per clasă.
- Cele maximum două contacte WhatsApp ale fiecărui copil sunt stocate în baza SQLite a clasei. Numerele sunt normalizate la format internațional și sunt trimise numai dispozitivelor cu rol de casier; nu apar la părinte, auditor, în PDF-uri sau în exportul JSON.
- Directorul de date este privat (0700); nu se află în directorul public.
- Fiecare invitație acordă un rol numai pentru clasa aleasă. Rolurile sunt casier, părinte sau auditor; părintele este limitat și la copilul ales.
- Dispozitivele de casier existente la migrare devin proprietari și pot crea clase. Pe o instalare nouă, primul casier activat devine proprietar.
- Proprietarul care creează o clasă primește automat drept de casier în ea. Ceilalți proprietari nu primesc automat acces și trebuie invitați separat.
- Expirarea este verificată pentru fiecare drept pe clasă. Revocarea sau ștergerea din consolă afectează întregul dispozitiv și toate drepturile lui.

Pentru accesuri pe clase și pentru rolurile părinte/auditor, folosește consola PWA privată (alege rolul, apoi clasa întreagă sau copilul) sau comanda locală, care acoperă aceleași operațiuni:

```
node scripts/admin.mjs options                                   # clasele și copiii care pot primi invitații
node scripts/admin.mjs invite "Telefonul meu"                    # casier pentru clasa implicită
node scripts/admin.mjs invite --role auditor --for classroom:ID_CLASĂ
node scripts/admin.mjs invite --role parent --for child:ID_CLASĂ:ID_COPIL --expires 2027-06-30
node scripts/admin.mjs invites
node scripts/admin.mjs devices
node scripts/admin.mjs revoke-invite ID_INVITAȚIE
node scripts/admin.mjs revoke-device ID_DISPOZITIV
node scripts/admin.mjs restore-device ID_DISPOZITIV
node scripts/admin.mjs delete-device ID_DISPOZITIV
```

Scriptul citește `~/.config/casierul-clasei/app.env` sau variabilele `ADMIN_TOKEN` și `ADMIN_PORT` din mediu. Se conectează numai la API-ul local de pe `127.0.0.1`. Consola privată este instalată de `deploy.sh` numai dacă există pe server; pe alte instalări pasul este sărit.

Codurile de invitație permit două activări și expiră la șapte zile de la emitere; prima folosire nu prelungește termenul. Deschiderea unui link nu consumă o activare. O activare reușită prin **Deschide registrul clasei** sau **Adaugă acces din invitație** folosește una dintre cele două activări. Cererile eșuate, inclusiv adăugarea unei clase deja accesibile, nu consumă activări.

După prima activare, codul și linkul rămân disponibile în consola privată pentru al doilea dispozitiv. După a doua, invitația apare folosită și codul/linkul sunt șterse. Numărul exact de activări este disponibil prin `node scripts/admin.mjs invites` sau API, în câmpurile `use_count` și `max_uses`. Consola comună afișează invitația parțial folosită ca fiind în așteptare.

Fiecare dispozitiv are o sesiune separată, păstrată într-un cookie Secure și HttpOnly. Un alt browser sau profil reprezintă un dispozitiv separat pentru această limită. Pentru adăugarea unei a doua clase pe un dispozitiv deja activat, codul se introduce din **Adaugă acces din invitație**; deschiderea linkului de activare ar crea o sesiune nouă. Deconectarea, revocarea sau ștergerea unui dispozitiv nu eliberează activarea folosită.

Revocarea unei invitații blochează activările rămase și păstrează accesul dispozitivelor deja activate. Revocarea unui dispozitiv oprește toate drepturile lui la următoarea cerere online; celălalt dispozitiv rămâne activ. Rolul, clasa, copilul și expirarea accesului se aplică identic ambelor activări. Dreptul de proprietar rămâne separat: pe o instalare nouă îl primește numai primul casier activat.

La actualizare, invitațiile vechi nefolosite permit două activări, cu același termen de expirare. Cele deja consumate rămân închise, cu o activare din una; pentru încă un dispozitiv se emite o invitație nouă. Invitațiile revocate sau expirate nu sunt reactivate.

Fluxul complet pentru creare, invitații și comutare este documentat în [Mai multe școli, clase și drepturi de acces](multiple-classrooms.md).

## Copii de siguranță

`casierul-clasei-backup.timer` produce zilnic copii SQLite consistente, inclusiv datele aflate în WAL, contactele copiilor și conținutul integral al documentelor atașate, folosind API-ul de backup din Node 24 (`scripts/backup.mjs`). Mai întâi salvează catalogul din `auth.sqlite`, apoi toate bazele claselor active din acel catalog. Fiecare bază este verificată cu `PRAGMA integrity_check` și `PRAGMA foreign_key_check`; setul complet apare apoi într-un subdirector datat din `~/.local/share/casierul-clasei/backups/`. Fișierele salvate nu necesită WAL/SHM pentru restaurare, iar copiile incomplete sunt eliminate. Copiile sunt locale, pe același server; nu există transfer extern sau ștergere automată a copiilor vechi. Monitorizează spațiul ocupat de directorul `backups/`, mai ales după adăugarea documentelor.

Backup manual:

```
systemctl --user start casierul-clasei-backup.service
```

În Docker, creează copia consistentă în volum și export-o într-un director privat de pe gazdă, mai ales înainte de upgrade:

```
docker compose exec app node scripts/backup.mjs
mkdir -p docker-backups
chmod 700 docker-backups
docker compose cp app:/data/backups/. ./docker-backups/
```

Automatizează aceste comenzi cu planificatorul gazdei și copiază periodic `docker-backups/` pe alt disc sau server. Volumul Docker și copiile din același volum se pot pierde împreună.

Pentru restaurare, oprește aplicația, păstrează o copie a întregului director curent de date, apoi înlocuiește `auth.sqlite` și toate bazele claselor cu fișierele din aceeași copie datată. Catalogul și registrele trebuie să provină din același subdirector de backup. Fișierele WAL și SHM vechi nu trebuie păstrate lângă bazele restaurate. Păstrează utilizatorul serviciului ca proprietar și permisiunile private, pornește aplicația și verifică soldurile fiecărei clase. Nu restaura peste o bază deschisă de un proces activ. Pentru Docker, oprește mai întâi serviciul `app` și copiază setul în `/data`; nu modifica volumul cât timp serverul rulează.

Exportul JSON din aplicație conține datele registrului și istoricul, fără credentiale sau contactele copiilor. Pentru documente include metadatele și amprentele SHA-256, nu conținutul fișierelor. Este util pentru verificare și păstrarea unei copii lizibile; restaurarea automată din JSON nu este implementată. Pentru restaurarea contactelor este necesară copia SQLite privată.

## Verificări

```
npm test
systemctl --user status casierul-clasei.service
systemctl --user list-timers casierul-clasei-backup.timer
curl -fsS http://127.0.0.1:8018/api/health
```

Testele folosesc baze temporare, nu registrul de producție. Pentru un browser blocat pe o versiune veche, `/bust` golește cache-ul aplicației și reîncarcă versiunea curentă, fără a șterge registrul de pe server.

După o migrare sau restaurare, verifică și că `auth.sqlite` conține clasa `default`, că există câte un fișier pentru fiecare clasă din catalog și că dispozitivul proprietar vede selectorul după adăugarea celei de-a doua clase. Nu redenumi manual fișierele `classroom-<uuid>.sqlite`; numele lor este legat de catalogul din `auth.sqlite`.
