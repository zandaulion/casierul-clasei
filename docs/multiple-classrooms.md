# Mai multe școli, clase și drepturi de acces

Fiecare clasă este un registru independent. Are propria listă de copii, propriile cheltuieli și încasări, propriul sold, propriile sume avansate temporar, propriile documente justificative, sigle și rapoarte. Numele școlii este parte din identitatea clasei; două clase cu același nume de școală nu împart automat date sau drepturi.

## Roluri

| Rol | Ce poate vedea | Ce poate modifica |
| --- | --- | --- |
| Casier | Tot registrul clasei, toate documentele, rapoartele și exportul JSON | Copii, cheltuieli, încasări, bani dați mai departe, sume avansate, documente, corecții, setări și rapoarte |
| Auditor | Tot registrul clasei, toate documentele și rapoartele | Nimic; nu poate descărca exportul JSON brut |
| Părinte | Totalurile generale, cheltuielile agregate, banii dați mai departe, documentele marcate pentru clasă și situația copilului asociat | Nimic |

Dreptul se acordă pentru o singură clasă. Același dispozitiv poate fi, de exemplu, casier într-o clasă și auditor în alta. Un drept de părinte este legat și de copilul ales; numele și tranzacțiile celorlalți copii nu sunt trimise acelui dispozitiv.

## Adăugarea unei clase

Numai un dispozitiv proprietar poate crea clase. Dispozitivele de casier existente la migrarea de la versiunea cu o singură clasă devin proprietari. Pe o instalare nouă, primul casier activat devine proprietar.

1. Deschide rotița de setări din antet.
2. Apasă **Adaugă altă clasă**.
3. Completează școala, clasa și anul școlar.
4. Apasă **Creează clasa**.

Clasa pornește cu un registru gol, iar dispozitivul care a creat-o primește automat rolul de casier. Crearea unei clase nu copiază elevi, cheltuieli, solduri, sigle sau drepturi din altă clasă.

## Emiterea unei invitații

În consola PWA privată, alege tipul de acces și apoi destinația:

- pentru **Casier** sau **Auditor**, alege opțiunea care se termină cu „întreaga clasă”;
- pentru **Părinte**, alege copilul din clasa potrivită;
- pentru accesurile doar pentru citire, alege și data expirării.

Invitația permite două activări, de exemplu pe telefon și pe laptop. Ambele acordă același rol, pentru aceeași clasă și, în cazul părintelui, același copil. Codul expiră la șapte zile de la emitere, inclusiv dacă a fost folosit o singură dată. Data de expirare a dreptului este separată de expirarea invitației și se păstrează pentru ambele dispozitive.

## Același cod pe telefon și laptop

1. Deschide linkul invitației pe telefon sau introdu codul în pagina de acces.
2. Poți da dispozitivului un nume, de exemplu „Telefon Ana”, apoi apasă **Deschide registrul clasei**.
3. În cele șapte zile de valabilitate, deschide același link pe laptop sau introdu același cod și activează-l cu un nume distinct, de exemplu „Laptop Ana”.

După prima activare, codul poate fi copiat în continuare din consola privată. După a doua, el nu mai poate activa alt dispozitiv. Simplul acces la link nu folosește o activare.

Accesul este recunoscut prin cookie-ul sesiunii. Un alt browser sau profil, chiar pe același aparat, are nevoie de o activare separată. Continuă să folosești același browser/profil după activare. Cele două sesiuni sunt independente; prima activare de casier pe o instalare nouă păstrează în plus dreptul de proprietar, care permite crearea claselor.

## Adăugarea accesului pe un dispozitiv deja activat

Pentru a păstra accesurile deja existente și a adăuga încă o clasă pe același dispozitiv:

1. Copiază codul invitației fără să deschizi linkul de activare.
2. În aplicație, deschide setările clasei curente.
3. Apasă **Adaugă acces din invitație**.
4. Introdu codul și apasă **Adaugă accesul**.

Aplicația păstrează drepturile vechi și deschide clasa adăugată. Adăugarea reușită folosește una dintre cele două activări ale invitației. O invitație pentru o clasă la care dispozitivul are deja acces este refuzată, nu înlocuiește rolul existent și nu folosește o activare.

## Schimbarea clasei

Când dispozitivul are acces la cel puțin două clase, în antet apare selectorul de clasă. Selectarea altei clase încarcă numai registrul și rolul acelei clase. Poziția de navigare și formularele clasei anterioare nu sunt transferate.

O salvare aflată în așteptarea confirmării blochează schimbarea clasei. Cererea reținută include identificatorul clasei, astfel încât o reîncercare după pierderea conexiunii nu poate ajunge în alt registru.

## Expirare și revocare

Expirarea se aplică dreptului din clasa pentru care a fost emisă invitația. Celelalte clase ale aceluiași dispozitiv rămân disponibile. Când ultimul drept activ expiră, dispozitivul trebuie activat din nou.

Revocarea sau ștergerea unui dispozitiv din consola privată afectează toate clasele acelui dispozitiv. Pentru eliminarea unui singur drept pe clasă nu există încă o acțiune în interfață; în acest caz se emite un dispozitiv separat sau se revocă dispozitivul complet.

Celălalt dispozitiv activat cu același cod își păstrează accesul. Deconectarea, revocarea sau ștergerea unui dispozitiv nu eliberează activarea folosită; când codul este epuizat sau expirat, emite o invitație nouă. Anularea invitației oprește doar activările rămase, fără să retragă drepturile deja acordate.

Codurile consumate înainte de introducerea limitei de două activări rămân închise. Pentru al doilea dispozitiv emite o invitație nouă. Codurile vechi nefolosite permit două activări până la termenul inițial; cele revocate sau expirate rămân închise.

## Migrarea clasei existente

Registrul anterior rămâne în `ledger.sqlite` și este înscris în catalog cu identificatorul intern `default`. Copiii, soldul, cheltuielile, tranzacțiile, siglele și rapoartele nu sunt mutate sau rescrise. Dispozitivele existente își păstrează rolul pentru această clasă.

Clasele create ulterior folosesc fișiere `classroom-<uuid>.sqlite`. Copiile de siguranță includ `auth.sqlite`, registrul implicit și toate registrele claselor active din catalog.
