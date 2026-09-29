# Plan de criptare

Criptarea datelor stocate nu este activată încă. Conexiunea publică este protejată de HTTPS, iar fișierele SQLite și configurația sunt private la nivelul sistemului de operare. Separarea actuală, cu un fișier SQLite pentru fiecare clasă, pregătește o migrare controlată fără a amesteca cheile sau copiile de siguranță.

Obiectivul este protejarea datelor dacă sunt copiate fișierele bazei de date sau copiile de siguranță. Criptarea nu protejează împotriva unui atacator care controlează procesul aplicației ori contul de sistem în timp ce cheile sunt încărcate și nu schimbă regulile de acces pe clase.

## Model propus

- Folosim SQLCipher pentru fiecare bază `ledger.sqlite` / `classroom-<uuid>.sqlite` și pentru `auth.sqlite`, după validarea suportului stabil pe Node 24.
- Generăm o cheie aleatoare de date pentru fiecare clasă. Astfel, compromiterea unei chei nu expune automat toate școlile și clasele.
- Cheile claselor sunt împachetate cu o cheie principală a serverului. Cheia principală stă în afara directorului de date și a copiilor de siguranță, ideal într-un secret manager sau într-un fișier root-only injectat serviciului.
- `auth.sqlite` necesită o cheie separată, deoarece trebuie deschis înainte ca aplicația să poată afla ce registre și chei de clasă există.
- Copiile de siguranță conțin numai baze criptate. Procedura de restaurare cere separat cheia principală și verifică deschiderea fiecărei baze înainte de repornire.
- Rotirea schimbă întâi cheia principală care împachetează cheile claselor; recriptarea completă a registrelor se face separat și cu backup verificat.

## Înainte de activare

Implementarea trebuie să includă o procedură testată de migrare în copie, revenire la versiunea anterioară, recuperare când cheia lipsește și restaurare pe un server curat. Trebuie măsurat și impactul asupra rapoartelor și backup-urilor. Criptarea la nivel de aplicație nu înlocuiește HTTPS, drepturile pe clase, actualizările serverului sau protecția contului de administrare.

Decizia privind locul cheii principale trebuie luată înainte de cod: un secret păstrat lângă bazele de date ar face criptarea inutilă în cazul furtului întregului director. Activarea va fi o schimbare de operare separată, cu fereastră de mentenanță și copie de siguranță verificată. Până atunci, documentația și interfața nu trebuie să pretindă că datele stocate sau backup-urile sunt criptate.
