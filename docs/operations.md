# Operare

## Adrese și procese

- Public: `https://casierul-clasei.zandaulion.com`, prin Cloudflare Tunnel către `http://127.0.0.1:8018`.
- Aplicația Node rulează ca serviciu systemd de utilizator: `casierul-clasei.service`.
- API-ul de administrare ascultă separat pe `127.0.0.1:8118`. Portul public răspunde întotdeauna cu 404 pentru `/api/admin` și subrutele lui.
- Consola privată folosește prefixul `/casierul-clasei`; Caddy injectează credentialul de administrare din configurația privată. Acesta nu este trimis în paginile aplicației sau ale consolei.
- Serviciul `casierul-clasei-preview.service` păstrează previzualizarea în directorul `preview/`, ca variantă de revenire pentru instalarea inițială.

## Publicare

```
./deploy.sh https://casierul-clasei.zandaulion.com
```

Scriptul rulează testele, pregătește configurația, instalează ruta privată în consolă, pornește aplicația pe același port 8018 și verifică `/api/health`. Instalările următoare pot folosi `./deploy.sh` fără URL. Actualizarea consolei adaugă doar intrarea acestei aplicații și păstrează celelalte intrări existente. Configurația Caddy este salvată înainte de modificare și validată înainte de reîncărcare.

Fișierele din `web/` sunt încărcate de server la pornire. După orice modificare, repornește serviciul prin deploy. Versiunea workerului este derivată din conținutul fișierelor, prin mecanismul pwa-kit.

## Date și acces

- Configurație: `~/.config/casierul-clasei/app.env` (permisiuni 0600).
- Clasa migrată/inițială: `~/.local/share/casierul-clasei/ledger.sqlite`.
- Clasele adăugate: câte un `~/.local/share/casierul-clasei/classroom-<uuid>.sqlite`.
- Invitații, dispozitive, catalogul claselor și drepturile: `~/.local/share/casierul-clasei/auth.sqlite`.
- Documentele justificative sunt stocate în baza SQLite a clasei, împreună cu amprenta SHA-256 și vizibilitatea lor. Limitele sunt 10 MB per fișier, 25 de documente per cheltuială/plată și 200 MB per clasă.
- Directorul de date este privat (0700); nu se află în directorul public.
- Fiecare invitație acordă un rol numai pentru clasa aleasă. Rolurile sunt casier, părinte sau auditor; părintele este limitat și la copilul ales.
- Dispozitivele de casier existente la migrare devin proprietari și pot crea clase. Pe o instalare nouă, primul casier activat devine proprietar.
- Proprietarul care creează o clasă primește automat drept de casier în ea. Ceilalți proprietari nu primesc automat acces și trebuie invitați separat.
- Expirarea este verificată pentru fiecare drept pe clasă. Revocarea sau ștergerea din consolă afectează întregul dispozitiv și toate drepturile lui.

Pentru accesuri pe clase și pentru rolurile părinte/auditor, folosește consola PWA privată: alege rolul, apoi clasa întreagă sau copilul. Comanda locală de mai jos păstrează compatibilitatea operațională și emite numai un acces de casier pentru clasa implicită:

```
node scripts/admin.mjs invite "Telefonul meu"
node scripts/admin.mjs devices
```

Codurile de invitație sunt de unică folosință și expiră în șapte zile. Deschiderea unui link nu consumă codul; apăsarea **Activează** sau confirmarea din **Adaugă acces din invitație** îl consumă. Sesiunea este păstrată într-un cookie Secure și HttpOnly. Pentru adăugarea unei a doua clase pe același dispozitiv se introduce codul în aplicația deja activată; deschiderea linkului de activare ar crea un dispozitiv nou. Revocarea din consolă oprește toate drepturile dispozitivului la următoarea cerere online.

Fluxul complet pentru creare, invitații și comutare este documentat în [Mai multe școli, clase și drepturi de acces](multiple-classrooms.md).

## Copii de siguranță

`casierul-clasei-backup.timer` produce zilnic copii SQLite consistente, inclusiv datele aflate în WAL și conținutul integral al documentelor atașate, folosind API-ul de backup din Node 24 (`scripts/backup.mjs`). Mai întâi salvează catalogul din `auth.sqlite`, apoi toate bazele claselor active din acel catalog. Fiecare bază este verificată cu `PRAGMA integrity_check` și `PRAGMA foreign_key_check`; setul complet apare apoi într-un subdirector datat din `~/.local/share/casierul-clasei/backups/`. Fișierele salvate nu necesită WAL/SHM pentru restaurare, iar copiile incomplete sunt eliminate. Copiile sunt locale, pe același server; nu există transfer extern sau ștergere automată a copiilor vechi. Monitorizează spațiul ocupat de directorul `backups/`, mai ales după adăugarea documentelor.

Backup manual:

```
systemctl --user start casierul-clasei-backup.service
```

Pentru restaurare, oprește aplicația, păstrează o copie a întregului director curent de date, apoi înlocuiește `auth.sqlite` și toate bazele claselor cu fișierele din aceeași copie datată. Catalogul și registrele trebuie să provină din același subdirector de backup. Fișierele WAL și SHM vechi nu trebuie păstrate lângă bazele restaurate. Păstrează proprietarul `opc` și permisiunile private, pornește aplicația și verifică soldurile fiecărei clase. Nu restaura peste o bază deschisă de un proces activ.

Exportul JSON din aplicație conține datele registrului și istoricul, fără credentiale. Pentru documente include metadatele și amprentele SHA-256, nu conținutul fișierelor. Este util pentru verificare și păstrarea unei copii lizibile; restaurarea automată din JSON nu este implementată.

## Verificări

```
npm test
systemctl --user status casierul-clasei.service
systemctl --user list-timers casierul-clasei-backup.timer
curl -fsS http://127.0.0.1:8018/api/health
```

Testele folosesc baze temporare, nu registrul de producție. Pentru un browser blocat pe o versiune veche, `/bust` golește cache-ul aplicației și reîncarcă versiunea curentă, fără a șterge registrul de pe server.

După o migrare sau restaurare, verifică și că `auth.sqlite` conține clasa `default`, că există câte un fișier pentru fiecare clasă din catalog și că dispozitivul proprietar vede selectorul după adăugarea celei de-a doua clase. Nu redenumi manual fișierele `classroom-<uuid>.sqlite`; numele lor este legat de catalogul din `auth.sqlite`.
