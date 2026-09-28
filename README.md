# Casierul clasei

PWA pentru evidența fondului unei clase, folosită de casier. Interfață în română, sume în lei, date persistente pe server în SQLite.

Aplicația: https://casierul-clasei.zandaulion.com

## Începe

1. Generează o invitație în consola PWA privată și activează telefonul.
2. Configurează școala, clasa, anul școlar și eventualul sold inițial.
3. Adaugă copiii individual sau lipește lista, câte un `Nume de familie; Prenume` pe linie.
4. Creează cheltuielile și selectează participanții: sumă fixă/copil, total împărțit sau cantitate/copil × preț unitar.

Toate dispozitivele activate accesează același registru. Invitațiile sunt pentru dispozitivele casierului; aplicația nu include conturi pentru părinți.

## Încasare rapidă

Atinge copilul din lista alfabetică, apoi alege totalul restant sau o singură cheltuială. Butoanele mari rotunjesc în sus la multiplu de 10, 50 sau 100 lei, pornind mereu de la suma selectată. Un multiplu exact rămâne neschimbat.

Pentru diferență, alege **Dau rest** sau **Păstrez în avans**. Dacă ai selectat o singură cheltuială, diferența nu se repartizează automat către alte datorii. Poți introduce suma primită și repartizarea manual. Verifică rezumatul și salvează; aplicația revine la lista copiilor.

Avansul poate acoperi ulterior alte contribuții sau poate fi restituit. Folosirea avansului nu înregistrează încă o intrare de bani.

## Evidență

- **Copii:** contribuții, restanțe, avansuri și istoricul fiecărui copil.
- **Cheltuieli:** participanți, contribuții calculate, termen, sume încasate și plătite. O cheltuială poate fi editată; suma, calculul și participanții se blochează cât timp are operațiuni financiare active, iar denumirea, datele și comentariile rămân editabile. Pentru calculul pe cantități, cantitatea unui participant existent poate fi corectată dacă noua contribuție nu scade sub suma deja achitată.
- **Registru:** sold, încasări, plăți efectuate, restituiri și corecții. Plățile includ destinație, data și ora, comentarii și opțional cheltuiala asociată.
- **Corecții:** operațiunile confirmate se anulează printr-o înregistrare separată, cu motiv, păstrând istoricul. O cheltuială fără încasări sau plăți active poate fi anulată și recreată.
- **Export:** copie JSON a datelor și istoricului, fără credentiale. Restaurarea automată din JSON nu este inclusă.

Sumele sunt stocate în bani întregi; împărțirea unui total distribuie exact și ultimii bani. Contribuțiile unei cheltuieli sunt fixate la creare. Soldul fondului include avansurile deținute, afișate și separat.

Salvarea necesită internet. La pierderea răspunsului, **Verifică / reîncearcă** confirmă aceeași cerere fără dublarea încasării. Modificările făcute pe alt dispozitiv cer verificarea sumelor înainte de salvare. Nu există coadă de operațiuni offline.

## Tehnic și operare

Node.js 24+, `node:sqlite`, fără dependențe runtime externe. Folosește mecanismul de actualizări din `../pwa-kit` și administrarea invitațiilor/dispozitivelor din `../pwa-invite-console`.

```
npm test
./deploy.sh https://casierul-clasei.zandaulion.com
```

Cloudflare Tunnel folosește `http://127.0.0.1:8018`. API-ul privat de administrare ascultă separat pe `127.0.0.1:8118`. Publicarea instalează serviciul systemd, integrarea consolei și copii de siguranță locale zilnice.

Detalii: [operare și backup](docs/operations.md), [contract API](docs/api.md).

Testele folosesc baze temporare și verifică registrul, autentificarea, calculele interfeței și integrarea HTTP. `scripts/browser-check.mjs` verifică fluxurile complete într-un context Chromium separat, cu server temporar pe portul 18018 și Chromium disponibil prin debugging pe portul 9222.

Schița interactivă inițială rămâne în `design/collection-flow.html`; `preview/` păstrează exportul ei pentru revenire la instalarea inițială. Aplicația funcțională este în `web/` și `server/`.
