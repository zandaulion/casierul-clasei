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
- Directorul de date este privat (0700); nu se află în directorul public.
- Fiecare invitație acordă un rol numai pentru clasa aleasă. Rolurile sunt casier, părinte sau auditor; părintele este limitat și la copilul ales.
- Dispozitivele de casier existente la migrare devin proprietari și pot crea clase. Pe o instalare nouă, primul casier activat devine proprietar.

Invitațiile se generează din consola PWA existentă sau local:

```
node scripts/admin.mjs invite "Telefonul meu"
node scripts/admin.mjs devices
```

Codurile de invitație sunt de unică folosință și expiră în șapte zile. Deschiderea unui link nu consumă codul; apăsarea „Activează” îl consumă. Sesiunea este păstrată într-un cookie Secure și HttpOnly. Revocarea din consolă oprește accesul la următoarea cerere online.

## Copii de siguranță

`casierul-clasei-backup.timer` produce zilnic copii SQLite consistente, inclusiv datele aflate în WAL, folosind API-ul de backup din Node 24 (`scripts/backup.mjs`). Mai întâi salvează catalogul din `auth.sqlite`, apoi toate bazele claselor active din acel catalog. Fiecare bază este verificată cu `PRAGMA integrity_check` și `PRAGMA foreign_key_check`; setul complet apare apoi într-un subdirector datat din `~/.local/share/casierul-clasei/backups/`. Fișierele salvate nu necesită WAL/SHM pentru restaurare, iar copiile incomplete sunt eliminate. Copiile sunt locale, pe același server; nu există transfer extern automat.

Backup manual:

```
systemctl --user start casierul-clasei-backup.service
```

Pentru restaurare, oprește aplicația, păstrează o copie a întregului director curent de date, apoi înlocuiește `auth.sqlite` și toate bazele claselor cu fișierele din aceeași copie datată. Fișierele WAL și SHM vechi nu trebuie păstrate lângă bazele restaurate. Păstrează proprietarul `opc` și permisiunile private, pornește aplicația și verifică soldurile fiecărei clase. Nu restaura peste o bază deschisă de un proces activ.

Exportul JSON din aplicație conține datele registrului și istoricul, fără credentiale. Este util pentru verificare și păstrarea unei copii lizibile; restaurarea automată din JSON nu este implementată.

## Verificări

```
npm test
systemctl --user status casierul-clasei.service
systemctl --user list-timers casierul-clasei-backup.timer
curl -fsS http://127.0.0.1:8018/api/health
```

Testele folosesc baze temporare, nu registrul de producție. Pentru un browser blocat pe o versiune veche, `/bust` golește cache-ul aplicației și reîncarcă versiunea curentă, fără a șterge registrul de pe server.
