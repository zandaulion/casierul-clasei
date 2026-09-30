# Roadmap de produs

Acest document urmărește lucrurile care mai merită adăugate după acoperirea fluxurilor zilnice de bază. Ordinea reflectă utilitatea practică pentru casier, claritatea registrului și ușurința recuperării datelor.

Legendă: `[ ]` de făcut · `[x]` implementat și verificat.

## Prioritatea 1

- [ ] **Acoperire oferită direct, într-un singur pas.** Astăzi, o sumă oferită fondului trebuie înregistrată mai întâi ca avans personal și apoi folosită din **Nu mai colectez**. Noul flux trebuie să permită **Acoperă cu o sumă oferită acum**, să precizeze dacă banii intră în fond sau au fost plătiți direct furnizorului, să nu creeze o datorie de restituire și să păstreze sursa separată de plata părintelui. Operațiunea trebuie să fie reversibilă.

- [ ] **Reconcilierea numerarului fizic.** Casierul introduce suma numărată la o anumită dată, iar aplicația o compară cu soldul scriptic. Diferența, observația și autorul rămân în istoric; o eventuală corecție se înregistrează separat, fără rescrierea operațiunilor existente.

- [ ] **Închiderea și trecerea în noul an școlar.** Fluxul trebuie să emită situația finală, să arhiveze anul, să transfere explicit soldul aprobat și, opțional, copiii și setările de plată. Contactele și accesurile vechi trebuie revizuite sau eliminate, nu prelungite implicit.

- [ ] **Copie externă criptată și restaurare ghidată.** Copiile SQLite locale includ registrul, documentele și contactele, însă rămân pe același server. Este necesară o destinație externă criptată, o politică de retenție, verificarea periodică a copiilor și un flux documentat sau asistat de restaurare. Exportul JSON rămâne util pentru inspecție, dar nu înlocuiește copia completă.

## Prioritatea 2

- [ ] **Temeiul deciziei pentru o cheltuială.** Câmpuri simple pentru data ședinței sau discuției, o notă și un document asociat ar face mai clar de ce a fost creată cheltuiala. Dacă este nevoie, participarea poate primi stările opționale „invitat”, „acceptat” și „refuzat”, fără a transforma aplicația într-un sistem de vot.

- [ ] **Istoricul contactării părinților.** După deschiderea mesajului WhatsApp, casierul poate marca manual „Contactat” cu dată și observație. Aplicația nu trebuie să pretindă că mesajul a fost trimis sau livrat, deoarece WhatsApp nu îi oferă această confirmare.

- [ ] **Filtre în registru și arhivă completă.** Filtre după copil, cheltuială, tip și perioadă, plus un pachet de arhivă cu exportul de date, PDF-urile emise, documentele justificative și un fișier de verificare cu amprentele lor.

## Prioritatea 3

- [ ] **Criptarea datelor stocate.** Implementarea etapizată este descrisă în [planul de criptare](encryption.md). Include cheile, migrarea, rotația, copiile de siguranță și procedura de recuperare; nu este doar o schimbare a fișierului SQLite.

## Capabilități deja existente pe care roadmap-ul le extinde

- [x] O contribuție poate fi recalculată înainte de prima încasare sau acoperită parțial/integral dintr-un avans personal existent, cu sursa afișată separat și fără mișcare dublă de numerar.
- [x] Operațiunile financiare se corectează prin înregistrări de anulare, cu motiv și istoric păstrat.
- [x] Sunt create zilnic copii locale consistente ale bazelor SQLite, iar procedurile manuale de backup și restaurare sunt documentate.
- [x] Accesurile pot avea termen de expirare, iar dispozitivele pot fi revocate separat.
- [x] Mesajele WhatsApp sunt precompletate, dar rămân sub controlul casierului; aplicația nu le trimite automat și nu afirmă că au fost livrate.
