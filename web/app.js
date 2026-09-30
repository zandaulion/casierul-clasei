import { installUpdates } from '/pwa-update.js';
import { name, money, decimal, parseMoney, sortChildren, sortTransactionsNewestFirst, unpaid, roundUp, automaticAllocations, collectionResult, creditSettlement, smallSettlement, expensePreview, whatsappReminder, whatsappUrl, whatsappShareUrl, paymentShareItems, reportShareMessage } from './helpers.mjs';
import { icon } from './icons.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const field = (label, key, value = '', options = '') => `<label>${label}<input name="${key}" value="${esc(value)}" ${options}></label>`;
const moneyField = (label, key, value = '') => field(label, key, value, 'inputmode="decimal" autocomplete="off" required');
const comments = (value = '') => `<label>Comentarii (opțional)<textarea name="comment" maxlength="2000">${esc(value)}</textarea></label>`;
const localDateTime = (value = new Date()) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const localNow = () => localDateTime();
const timestampField = (value = localNow()) => field('Data și ora', 'occurredAt', value, 'type="datetime-local" required');
const dateText = value => value ? new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium', ...(value.includes('T') ? { timeStyle: 'short' } : {}) }).format(new Date(value.includes('T') ? value : `${value}T12:00:00`)) : 'Fără termen';
const labels = { collection: 'Încasare', direct_payment: 'Plată directă beneficiarului', payment: 'Bani dați', credit_apply: 'Avans repartizat', rounding_adjustment: 'Ajustare de rotunjire', refund: 'Avans restituit',
  fund_advance: 'Sumă avansată fondului', advance_repayment: 'Restituire sumă avansată',
  advance_waiver: 'Acoperire din sumă avansată', reversal: 'Corecție' };
const typeLabels = { fixed: 'Sumă fixă / copil', split: 'Total împărțit', quantity: 'Cantitate × preț' };
const reportTypeLabels = { class: 'Situația clasei', matrix: 'Tabelul contribuțiilor', expense: 'Situația unei cheltuieli', child: 'Fișa copilului' };
const writeActions = new Set(['add-child', 'edit-child', 'edit-contacts', 'edit-reminder-contact', 'whatsapp-reminders', 'create-child-report', 'bulk-children', 'add-expense', 'edit-expense', 'payment', 'direct-payment', 'fund-advance', 'repay-advance', 'attach-document',
  'expense-payment', 'stop-collection', 'apply-credit', 'refund', 'report-class', 'report-matrix', 'report-expense', 'report-child',
  'replace-report', 'reverse', 'cancel-expense', 'remove-logo', 'add-classroom']);
const pendingKey = 'casierul.pending.v1';
const navigationKey = 'casierulNavigation';
const classroomKey = 'casierul.classroom.v1';
const storedNavigation = history.state?.[navigationKey];
let state = null, device = null, classrooms = [], classroomId = null, tab = 'children', childId = null, draft = null, dirty = false;
let modal = null, modalDirty = false, saving = false, conflict = false, disconnected = false, pending = null;
let navigationIndex = Number.isSafeInteger(storedNavigation?.index) ? storedNavigation.index : 0;
let navigationOverlay = false, restoringNavigation = false;
let toastTimer, inviteCode = new URL(location.href).searchParams.get('invite') || '';
let search = '', showArchived = false, rosterScrollY = 0;
let pdfModulePromise = null;
if (['children', 'expenses', 'ledger', 'reports'].includes(storedNavigation?.tab)) tab = storedNavigation.tab;
if (tab === 'children' && typeof storedNavigation?.childId === 'string') childId = storedNavigation.childId;
try { pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); } catch { /* Browser storage can be unavailable. */ }
const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete('invite');
history.replaceState({ ...(history.state || {}), [navigationKey]: { index: navigationIndex, tab, childId, overlay: false } }, '', cleanUrl);
const busy = () => dirty || modalDirty || saving || !!pending;
const child = () => state?.children.find(c => c.id === childId);
const activeChildren = () => sortChildren(state.children.filter(c => c.active));
const classroomAccess = () => classrooms.find(item => item.id === classroomId);
const canWrite = () => classroomAccess()?.role === 'treasurer';
const contactsFor = id => (state?.contacts || []).filter(contact => contact.childId === id).sort((a, b) => a.position - b.position);
const accessLabel = () => ({ parent: 'Părinte · doar citire', auditor: 'Auditor · doar citire' }[classroomAccess()?.role] || 'Casier');
const fileSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 0 }).format(bytes / 1024)} KB`
  : `${new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)} MB`;
const accessBanner = () => canWrite() ? '' : `<div class="access-indicator"><span>${icon('eye')}${classroomAccess()?.role === 'parent' ? 'Acces de părinte' : 'Acces de auditor'}</span><button type="button" data-action="settings">Detalii acces</button></div>`;
const welcomeBanner = (title = 'Lucruri frumoase, împreună.', subtitle = 'Fondul clasei, cu grijă pentru fiecare.') => `<section class="welcome-banner" aria-label="Clasa noastră"><div class="welcome-copy"><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><img src="/illustrations/school-community.webp" width="384" height="256" alt="" decoding="async"></section>`;
const pageHeading = (title, subtitle, type) => `<div class="page-heading"><span class="section-icon tone-${type}">${icon(type)}</span><div><h1>${esc(title)}</h1><p class="caption">${esc(subtitle)}</p></div></div>`;
const helpArrow = '<div class="help-arrow" aria-hidden="true">↓</div>';
const simpleHelpFlows = {
  access: { label: 'Activarea și accesul la clasă', steps: [
    ['Primești invitația', 'Codul este emis pentru o clasă, un rol și, pentru părinte, un copil.'],
    ['Introduci codul', 'Dispozitivul primește acces fără ca aplicația să păstreze codul în clar.'],
    ['Deschizi registrul', 'Același cod poate activa încă un dispozitiv în cele șapte zile de valabilitate.'],
    ['Adaugi alte accesuri', '„Adaugă acces din invitație” păstrează clasele deja existente pe dispozitiv.'],
    ['Alegi clasa', 'Selectorul din antet apare când ai acces la mai multe clase.'],
  ] },
  settings: { label: 'Configurarea clasei', steps: [
    ['Deschizi Setări', 'Completezi școala, clasa și anul școlar.'],
    ['Introduci soldul inițial', 'Poate fi schimbat numai înainte de prima operațiune financiară.'],
    ['Adaugi detaliile de plată', 'Link Revolut.me, beneficiar și IBAN.'],
    ['Alegi siglele', 'Sigla școlii și a clasei vor apărea în rapoartele emise ulterior.'],
    ['Salvezi configurația', 'Clasa este pregătită pentru copii și cheltuieli.'],
  ] },
  children: { label: 'Copiii și contactele', steps: [
    ['Deschizi Copii', 'Lista este ordonată alfabetic și poate fi căutată.'],
    ['Adaugi copilul sau lista', 'Individual ori în bloc, câte un copil pe rând.'],
    ['Verifici fișa copilului', 'Contribuții, sume de achitat, avans și istoric.'],
    ['Adaugi contactele', 'Zero, unul sau două numere WhatsApp, vizibile numai casierilor.'],
    ['Editezi sau arhivezi', 'Istoricul și soldurile copilului rămân păstrate.'],
  ] },
  expenses: { label: 'Crearea și administrarea cheltuielilor', steps: [
    ['Alegi „Cheltuială nouă”', 'Scrii denumirea, data și termenul.'],
    ['Alegi calculul', 'Sumă fixă/copil, total împărțit sau cantitate × preț.'],
    ['Selectezi participanții', 'Pentru cantități, completezi și valoarea fiecărui copil.'],
    ['Verifici previzualizarea', 'Aplicația distribuie exact inclusiv ultimii bani.'],
    ['Salvezi cheltuiala', 'Contribuțiile apar imediat în fișele copiilor.'],
    ['Urmărești încasările noi', 'După o plată asociată, vezi separat cât s-a strâns în fond de la acel moment.'],
    ['Editezi sau anulezi explicit', 'Operațiunile existente protejează sumele deja confirmate.'],
  ] },
  credit: { label: 'Avansul copilului', steps: [
    ['Primești mai mult decât este datorat', 'Alegi „Păstrez în avans” pentru diferență.'],
    ['Avansul apare în fișă', 'Numerarul a intrat deja în fond o singură dată.'],
    ['Îl folosești la o contribuție', 'Din încasare sau prin „Folosește avansul”.'],
    ['Sau îl restitui', 'Restituirea scade avansul copilului și numerarul fondului.'],
    ['Verifici istoricul', 'Fiecare folosire sau restituire rămâne o operațiune separată.'],
  ] },
  directPayment: { label: 'Plata directă către beneficiar', steps: [
    ['Deschizi fișa copilului', 'Alegi „A plătit direct beneficiarului”.'],
    ['Alegi contribuția', 'Poți înregistra suma integrală sau o plată parțială.'],
    ['Completezi beneficiarul', 'De exemplu, doamna dirigintă sau fotograful.'],
    ['Confirmi plata', 'Contribuția scade, iar numerarul clasei rămâne neschimbat.'],
    ['Verifici registrul', 'Plata directă apare separat și poate fi corectată.'],
  ] },
  ledger: { label: 'Plățile și sumele avansate fondului', steps: [
    ['Deschizi Registru', 'Vezi numerarul, datoriile și soldul net.'],
    ['Alegi operațiunea', '„Bani dați mai departe” sau „Sumă avansată fondului”.'],
    ['Completezi suma și persoana', 'Poți asocia opțional o cheltuială.'],
    ['Salvezi', 'Plata scade numerarul; avansul personal adaugă numerar și o datorie egală.'],
    ['Stingi avansul personal', 'Îl restitui sau îl folosești pentru a acoperi contribuții.'],
  ] },
  corrections: { label: 'Corectarea unei operațiuni', steps: [
    ['Deschizi istoricul', 'Alegi operațiunea introdusă greșit.'],
    ['Alegi „Corectează”', 'Operațiunea originală nu este ștearsă.'],
    ['Scrii motivul', 'Motivul devine parte din istoricul verificabil.'],
    ['Confirmi inversarea', 'Efectele financiare sunt anulate o singură dată.'],
    ['Înregistrezi varianta corectă', 'Noua operațiune păstrează registrul reconciliat.'],
  ] },
  documents: { label: 'Documentele justificative', steps: [
    ['Deschizi cheltuiala sau plata', 'Documentele se atașează în contextul operațiunii.'],
    ['Alegi „Atașează document”', 'PDF, JPG, PNG sau WebP.'],
    ['Stabilești vizibilitatea', 'Intern pentru casier/auditor sau vizibil clasei.'],
    ['Încarci fișierul', 'Aplicația verifică tipul, limita și amprenta SHA-256.'],
    ['Consulți documentul', 'Fișierul rămâne imuabil și inclus în backup-ul SQLite.'],
  ] },
  whatsapp: { label: 'WhatsApp și detaliile de plată', steps: [
    ['Configurezi contactele și plata', 'Numerele copilului, Revolut.me, beneficiar și IBAN.'],
    ['Deschizi reminderul', 'Mesajul include situația copilului și detaliile de plată.'],
    ['Verifici mesajul', 'Aplicația nu îl trimite și nu pretinde că a fost livrat.'],
    ['Alegi ce partajezi', 'Doar mesajul sau mesajul copiat împreună cu raportul individual.'],
    ['Alegi conversația', 'Contact direct pentru copil sau selectorul telefonului.'],
    ['Apeși Trimite în WhatsApp', 'Expedierea rămâne sub controlul tău.'],
  ] },
  reports: { label: 'Emiterea și partajarea rapoartelor', steps: [
    ['Deschizi Rapoarte', 'Alegi situația clasei, tabelul, cheltuiala sau copilul.'],
    ['Alegi subiectul', 'Pentru raportul unei cheltuieli sau al unui copil.'],
    ['Generezi PDF-ul', 'Datele, siglele și revizia sunt înghețate la emitere.'],
    ['Previzualizezi', 'Verifici sumele și procentul de acoperire.'],
    ['Partajezi sau descarci', 'Mesajul potrivit raportului este deja completat.'],
    ['Emiți corecție dacă este nevoie', 'Raportul nou rămâne legat de cel înlocuit.'],
  ] },
  classrooms: { label: 'Mai multe clase și roluri', steps: [
    ['Primești sau creezi accesul', 'Fiecare permisiune are o clasă și un rol.'],
    ['Adaugi accesul pe dispozitiv', 'Accesurile existente nu sunt eliminate.'],
    ['Schimbi clasa din antet', 'Copiii, registrul și rapoartele rămân izolate.'],
    ['Lucrezi în limitele rolului', 'Casierul modifică, părintele și auditorul doar consultă.'],
    ['Revoci dispozitivul când este necesar', 'Fiecare sesiune poate fi oprită separat.'],
  ] },
  reliability: { label: 'Conexiunea, reîncercarea și actualizarea PWA', steps: [
    ['Deschizi pe telefon, tabletă sau laptop', 'Listele, formularele și previzualizarea PDF folosesc automat spațiul disponibil.'],
    ['Lucrezi cu datele încărcate', 'Interfața semnalează când conexiunea lipsește.'],
    ['Salvezi numai online', 'Operațiunile financiare nu intră într-o coadă offline.'],
    ['Răspunsul se pierde?', '„Verifică / reîncearcă” folosește aceeași cerere și nu dublează operațiunea.'],
    ['Datele s-au schimbat?', 'Actualizezi și verifici sumele înainte de o nouă salvare.'],
    ['Actualizezi aplicația', 'PWA așteaptă închiderea formularelor modificate și a salvărilor în curs.'],
  ] },
  export: { label: 'Exportul și copiile de siguranță', steps: [
    ['Deschizi Registru sau Setări', 'Casierul poate descărca exportul JSON.'],
    ['Păstrezi exportul pentru inspecție', 'Conține datele de business, fără contacte și fără conținutul documentelor.'],
    ['Backup-ul rulează zilnic', 'Bazele SQLite păstrează registrul, contactele și documentele.'],
    ['Restaurezi administrativ', 'Restaurarea completă folosește backup-ul SQLite și procedura de operare.'],
  ] },
};

function simpleHelpFlow(id, compact = false) {
  const flow = simpleHelpFlows[id];
  if (!flow) return '';
  return `<div class="help-flow ${compact ? 'compact' : ''}" aria-label="${esc(flow.label)}">${flow.steps.map((step, index) => {
    const last = index === flow.steps.length - 1;
    return `<div class="help-step ${index === 0 ? 'tone-green' : ''} ${last ? 'help-finish' : ''}"><span>${last ? icon('check') : index + 1}</span><div><strong>${esc(step[0])}</strong><small>${esc(step[1])}</small></div></div>${last ? '' : helpArrow}`;
  }).join('')}</div>`;
}

function collectionHelpFlow(compact = false) {
  return `<div class="help-flow ${compact ? 'compact' : ''}" aria-label="Pașii pentru încasarea banilor de la un copil">
    <div class="help-step tone-green"><span>1</span><div><strong>Atinge cardul copilului</strong><small>Fișa se deschide direct la încasare.</small></div></div>${helpArrow}
    <div class="help-step"><span>2</span><div><strong>Alege ce încasezi</strong><small>Totalul de plată sau o singură contribuție.</small></div></div>${helpArrow}
    <div class="help-step"><span>3</span><div><strong>Introdu suma primită</strong><small>Poți rotunji la 5, 10, 50 sau 100 lei și poți folosi avansul copilului.</small></div></div>${helpArrow}
    <div class="help-step help-decision"><span>?</span><div><strong>Cum se potrivește suma?</strong><small>Aplicația calculează diferența înainte de salvare.</small></div></div>${helpArrow}
    <div class="help-branches three">
      <div class="help-branch"><span class="help-branch-label">Mai puțin</span><strong>Rămâne de achitat</strong><small>Pentru cel mult 1 leu: lași diferența, folosești avansul sau ajustezi rotunjirea.</small></div>
      <div class="help-branch help-success"><span class="help-branch-label">Exact</span><strong>Contribuția se stinge</strong><small>Nu există rest sau avans nou.</small></div>
      <div class="help-branch"><span class="help-branch-label">Mai mult</span><strong>Alegi diferența</strong><small>Dai rest sau o păstrezi ca avans al copilului.</small></div>
    </div>${helpArrow}
    <div class="help-step"><span>4</span><div><strong>Verifică rezumatul</strong><small>Numerar primit, rest, avans și suma rămasă.</small></div></div>${helpArrow}
    <div class="help-step help-finish"><span>${icon('check')}</span><div><strong>Înregistrează încasarea</strong><small>Registrul și situația copilului se actualizează împreună.</small></div></div>
  </div>`;
}

function stopCollectionHelpFlow(compact = false, { canRecalculate = true, canCover = true, canRound = true } = {}) {
  const branches = `${canRecalculate ? '<div class="help-branch help-success"><span class="help-branch-label">Nu participă</span><strong>Exclude și recalculează</strong><small>Pentru o cheltuială împărțită eligibilă, totalul rămâne același și părțile celorlalți se refac.</small></div>' : ''}
    ${canRound ? '<div class="help-branch"><span class="help-branch-label">Diferență mică</span><strong>Ajustează rotunjirea</strong><small>Închizi un rest de cel mult 1 leu după o încasare parțială, fără să modifici numerarul.</small></div>' : ''}
    ${canCover ? '<div class="help-branch"><span class="help-branch-label">Suma este acoperită</span><strong>Alege avansul personal</strong><small>Acoperi parțial sau integral; numerarul nu se schimbă, iar datoria clasei scade.</small></div>' : ''}`;
  const branchCount = Number(canRecalculate) + Number(canRound) + Number(canCover);
  const branchClass = branchCount === 3 ? 'three' : branchCount === 2 ? 'two' : '';
  return `<div class="help-flow ${compact ? 'compact' : ''}" aria-label="Pașii pentru o contribuție care nu mai este colectată">
    <div class="help-step tone-green"><span>1</span><div><strong>Deschide contribuția neachitată</strong><small>Din fișa copilului.</small></div></div>${helpArrow}
    <div class="help-step"><span>2</span><div><strong>Apasă „Nu mai colectez”</strong><small>Vezi numai opțiunile disponibile pentru acea contribuție.</small></div></div>${helpArrow}
    <div class="help-step help-decision"><span>?</span><div><strong>Alege situația reală</strong><small>Alege varianta care descrie sursa reală a închiderii contribuției.</small></div></div>${helpArrow}
    <div class="help-branches ${branchClass}">${branches}</div>${helpArrow}
    <div class="help-step help-finish"><span>${icon('check')}</span><div><strong>Verifică și confirmă</strong><small>Numerarul și sursa închiderii rămân distincte în istoric și rapoarte.</small></div></div>
  </div>`;
}

function helpTopic(title, subtitle, content, open = false, id = '') {
  return `<details class="help-topic" ${id ? `id="help-topic-${esc(id)}"` : ''} ${open ? 'open' : ''}><summary><span>${icon('help')}</span><span><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span></summary>${content}</details>`;
}

function helpModal(topic = 'overview') {
  if (!canWrite()) {
    const parent = classroomAccess()?.role === 'parent';
    const title = parent ? 'Ghidul părintelui' : 'Ghidul auditorului';
    const journey = parent
      ? '<div><span>1</span><strong>Situație</strong><small>Vezi totalurile</small></div><div><span>2</span><strong>Contribuții</strong><small>Verifici termenele</small></div><div><span>3</span><strong>Rapoarte</strong><small>Deschizi PDF-urile</small></div>'
      : '<div><span>1</span><strong>Cheltuieli</strong><small>Verifici necesarul</small></div><div><span>2</span><strong>Registru</strong><small>Urmărești operațiunile</small></div><div><span>3</span><strong>Rapoarte</strong><small>Consulți arhiva</small></div>';
    const topics = parent
      ? `${helpTopic('Cum citesc situația copilului?', 'Contribuții, avans și sume de achitat.', '<p><strong>De achitat</strong> este totalul contribuțiilor încă nestinse. <strong>Avans disponibil</strong> reprezintă bani deja primiți care pot fi folosiți ulterior sau restituiți.</p><p class="caption">În fiecare contribuție vezi suma achitată, suma acoperită din fond și ce mai rămâne.</p>', true)}${helpTopic('Rapoarte și documente', 'Ce poți deschide din accesul de părinte.', '<p>Poți consulta situația clasei, rapoartele cheltuielilor și fișa propriului copil. Documentele justificative apar numai dacă au fost marcate ca vizibile pentru clasă.</p>')}${helpTopic('Date protejate', 'Accesul rămâne limitat la copilul asociat.', '<p>Nu primești numele, tranzacțiile sau contactele celorlalți copii. Dacă accesul ori asocierea nu este corectă, contactează casierul clasei.</p>')}`
      : `${helpTopic('Ce poate verifica auditorul?', 'Registrul financiar complet, fără modificări.', '<p>Poți consulta copiii, cheltuielile, operațiunile, documentele și rapoartele clasei. Contactele părinților nu sunt afișate.</p>', true)}${helpTopic('Acces doar pentru citire', 'Registrul rămâne protejat.', '<p>Nu poți adăuga, modifica, corecta sau exporta datele brute. Pentru o neconcordanță, notează raportul ori operațiunea și transmite observația casierului.</p>')}`;
    openModal('help', 'Ajutor', `<section class="help-intro"><span class="help-intro-icon">${icon('help')}</span><div><strong>${title}</strong><p>Informația disponibilă este adaptată rolului acestui dispozitiv.</p></div></section><div class="help-journey" aria-label="Traseul principal">${journey}</div><div class="help-topics">${topics}</div>`, null, { closeLabel: 'Închide' });
    return;
  }
  const openTopic = topic === 'overview' ? 'access' : topic;
  const topics = [
    ['Pornire și organizare', 'access', 'Cum activez un dispozitiv?', 'Invitație, două activări și selectorul clasei.', simpleHelpFlow('access')],
    ['Pornire și organizare', 'settings', 'Cum configurez clasa?', 'Identitate, sold inițial, plată și sigle.', simpleHelpFlow('settings')],
    ['Pornire și organizare', 'children', 'Cum gestionez copiii?', 'Adăugare, contacte, căutare și arhivare.', simpleHelpFlow('children')],
    ['Pornire și organizare', 'expenses', 'Cum creez o cheltuială?', 'Calcul, participanți, previzualizare și editare.', simpleHelpFlow('expenses')],
    ['Bani și corecții', 'collection', 'Cum încasez bani?', 'Suma primită, rotunjire, rest și avans.', collectionHelpFlow()],
    ['Bani și corecții', 'directPayment', 'Cum înregistrez o plată directă?', 'Contribuția se stinge fără să intre bani în fond.', simpleHelpFlow('directPayment')],
    ['Bani și corecții', 'stop-collection', 'Ce face „Nu mai colectez”?', 'Recalculare, diferență mică sau acoperire din fond.', stopCollectionHelpFlow()],
    ['Bani și corecții', 'credit', 'Cum folosesc avansul copilului?', 'Păstrare, repartizare și restituire.', simpleHelpFlow('credit')],
    ['Bani și corecții', 'ledger', 'Cum înregistrez plățile și avansurile personale?', 'Numerar, datorii și restituiri.', simpleHelpFlow('ledger')],
    ['Bani și corecții', 'corrections', 'Cum corectez o greșeală?', 'Inversare explicită și istoric păstrat.', simpleHelpFlow('corrections')],
    ['Documente și comunicare', 'documents', 'Cum atașez un document?', 'Fișier, vizibilitate și verificare.', simpleHelpFlow('documents')],
    ['Documente și comunicare', 'whatsapp', 'Cum trimit prin WhatsApp?', 'Contacte, mesaje și detalii de plată.', simpleHelpFlow('whatsapp')],
    ['Documente și comunicare', 'reports', 'Cum emit și partajez un raport?', 'PDF imuabil, previzualizare și corecție.', simpleHelpFlow('reports')],
    ['Acces și siguranță', 'classrooms', 'Cum lucrez cu mai multe clase și roluri?', 'Permisiuni izolate și schimbarea clasei.', simpleHelpFlow('classrooms')],
    ['Acces și siguranță', 'reliability', 'Ce se întâmplă fără conexiune?', 'Reîncercare sigură, conflicte și actualizare PWA.', simpleHelpFlow('reliability')],
    ['Acces și siguranță', 'export', 'Cum păstrez și recuperez datele?', 'Export JSON și backup SQLite.', simpleHelpFlow('export')],
  ];
  let previousGroup = '';
  const topicContent = topics.map(([group, id, title, subtitle, content]) => {
    const heading = group === previousGroup ? '' : `<h3 class="help-group-title">${esc(group)}</h3>`;
    previousGroup = group;
    return `${heading}${helpTopic(title, subtitle, content, id === openTopic, id)}`;
  }).join('');
  openModal('help', 'Ajutor', `<section class="help-intro"><span class="help-intro-icon">${icon('help')}</span><div><strong>Ghidul Casierului clasei</strong><p>Urmează pașii în ritmul tău. Denumirile sunt aceleași ca în aplicație.</p></div></section>
    <div class="help-journey" aria-label="Fluxul general al aplicației">
      <div><span>1</span><strong>Copii</strong><small>Adaugi copiii</small></div>
      <div><span>2</span><strong>Cheltuieli</strong><small>Stabilești contribuțiile</small></div>
      <div><span>3</span><strong>Încasări</strong><small>Primești și repartizezi</small></div>
      <div><span>4</span><strong>Registru</strong><small>Urmărești banii</small></div>
      <div><span>5</span><strong>Rapoarte</strong><small>Comunici situația</small></div>
    </div>
    <div class="help-topics">${topicContent}</div>`, null, { closeLabel: 'Închide' });
  if (topic !== 'overview') requestAnimationFrame(() => $(`#help-topic-${topic}`)?.scrollIntoView({ block: 'start' }));
}

// Reserve only fixed controls; wide-screen rails and panels stay in the layout.
// The toast is outside .app, so it shares these values through the root element.
function updateDockHeight() {
  const dock = $('.collection-dock');
  const height = dock && getComputedStyle(dock).position === 'fixed' ? Math.ceil(dock.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--collection-dock-height', `${height}px`);
  const tabs = $('#tabs');
  const navigationHeight = tabs && !tabs.hidden && getComputedStyle(tabs).position === 'fixed' ? Math.ceil(tabs.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--navigation-height', `${navigationHeight}px`);
}
const dockObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateDockHeight) : null;
function observeCollectionDock() {
  dockObserver?.disconnect();
  const dock = $('.collection-dock');
  if (dock) dockObserver?.observe(dock);
  dockObserver?.observe($('#tabs'));
  updateDockHeight();
}
window.addEventListener('resize', updateDockHeight);

function navigationState(overlay = navigationOverlay) {
  return { index: navigationIndex, classroomId, tab, childId, overlay };
}
function replaceNavigation(overlay = navigationOverlay) {
  navigationOverlay = overlay;
  history.replaceState({ ...(history.state || {}), [navigationKey]: navigationState() }, '');
}
function pushNavigation(overlay = false) {
  navigationIndex += 1; navigationOverlay = overlay;
  history.pushState({ ...(history.state || {}), [navigationKey]: navigationState() }, '');
}
function rememberRosterScroll() {
  if (tab === 'children' && !childId && $('#roster-list')) rosterScrollY = window.scrollY;
}
function restoreScreenScroll() {
  $('#main').focus({ preventScroll: true });
  const top = tab === 'children' && !childId ? rosterScrollY : 0;
  requestAnimationFrame(() => window.scrollTo(0, top));
}
function showScreen(nextTab, nextChildId = null, { push = true } = {}) {
  rememberRosterScroll();
  closeModal(true, true);
  tab = ['children', 'expenses', 'ledger', 'reports'].includes(nextTab) ? nextTab : 'children';
  const parentChildId = classroomAccess()?.role === 'parent' && state?.children.length === 1 ? state.children[0].id : null;
  childId = tab === 'children' ? (state?.children.some(c => c.id === nextChildId) ? nextChildId : parentChildId) : null;
  draft = null;
  if (childId) resetDraft(child());
  if (push) pushNavigation(false); else replaceNavigation(false);
  render(); restoreScreenScroll();
}

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function setPending(value) {
  pending = value;
  try { if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); } catch { /* In-memory retry still protects this session. */ }
}
async function api(path, options = {}) {
  let response;
  try { response = await fetch(scopedUrl(path), { credentials: 'same-origin', cache: 'no-store', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(20000) }); }
  catch { disconnected = true; updateNotices(); const error = new Error('Conexiunea nu a putut fi confirmată.'); error.network = true; throw error; }
  let data;
  try { data = await response.json(); } catch { const error = new Error('Răspunsul serverului nu a putut fi citit.'); error.network = true; throw error; }
  disconnected = false;
  if (!response.ok) { const error = new Error(data.error || 'Operațiunea nu a putut fi efectuată.'); error.status = response.status; throw error; }
  return data;
}
function scopedUrl(path) {
  if (!classroomId || !path.startsWith('/api/') || path.startsWith('/api/auth/') || ['/api/health', '/api/classrooms'].includes(path.split('?')[0])) return path;
  const url = new URL(path, location.origin); url.searchParams.set('classroom', classroomId);
  return `${url.pathname}${url.search}`;
}
function applySession(session) {
  device = session.device; classrooms = session.classrooms || [];
  let stored = null;
  try { stored = localStorage.getItem(classroomKey); } catch { /* Selection remains in memory. */ }
  const pendingClassroom = pending?.classroomId;
  classroomId = classrooms.some(item => item.id === pendingClassroom) ? pendingClassroom
    : classrooms.some(item => item.id === classroomId) ? classroomId
    : classrooms.some(item => item.id === stored) ? stored : classrooms[0]?.id || null;
}
function updateNotices() {
  const connection = $('#connection');
  connection.hidden = navigator.onLine && !disconnected;
  connection.innerHTML = 'Conexiune indisponibilă. Poți consulta datele încărcate; salvarea necesită internet.<br><button data-action="reconnect">Verifică conexiunea</button>';
  const notice = $('#pending-notice');
  notice.hidden = !pending && !conflict;
  if (pending) notice.innerHTML = `<strong>${saving ? 'Se confirmă salvarea…' : 'Salvarea așteaptă confirmarea serverului.'}</strong><div>Nu înregistra încă o dată aceeași operațiune. Reîncercarea verifică aceeași înregistrare.</div><button data-action="retry" ${saving ? 'disabled' : ''}>Verifică / reîncearcă</button>`;
  else if (conflict) notice.innerHTML = '<strong>Registrul s-a schimbat pe alt dispozitiv.</strong><div>Încarcă datele actuale și verifică sumele înainte să salvezi din nou.</div><button data-action="review">Actualizează și verifică</button>';
  $('#modal-submit').disabled = (!canWrite() && modal?.type !== 'add-access') || saving || !!pending || conflict || !!modal?.logoProcessing || !navigator.onLine || disconnected;
  if ($('#collection-save')) {
    const result = collectionResult(child(), draft), credit = creditSettlement(child(), draft, result);
    $('#collection-save').disabled = saving || !!pending || conflict || !navigator.onLine || disconnected || !!result.error || (result.netMinor <= 0 && !credit);
  }
  if ($('#dialog').open && (pending || conflict)) {
    const error = $('#modal-error'); error.hidden = false;
    error.innerHTML = pending ? `Salvarea așteaptă confirmarea. <button type="button" data-action="retry" ${saving ? 'disabled' : ''}>Verifică / reîncearcă</button>` : 'Datele s-au schimbat. <button type="button" data-action="review">Actualizează și verifică</button>';
  }
  if ($('#dialog').open && !pending && !conflict && (!navigator.onLine || disconnected)) { $('#modal-error').hidden = false; $('#modal-error').innerHTML = 'Salvarea necesită internet. <button type="button" data-action="reconnect">Verifică conexiunea</button>'; }
  $$('[data-write-control], #modal-content input, #modal-content textarea, #modal-content select').forEach(el => {
    const unusedQuantity = el.dataset.quantity && ($('#modal-form').elements.type?.value !== 'quantity' || !$$('[data-participant]').find(p => p.dataset.participant === el.dataset.quantity)?.checked);
    el.disabled = saving || !!pending || el.hasAttribute('data-locked') || !!unusedQuantity;
  });
}
function canLeave() {
  if (saving || pending) { toast('Verifică mai întâi salvarea în așteptare.'); return false; }
  if ((dirty || modalDirty) && !confirm('Ai modificări nesalvate. Renunți la ele?')) return false;
  dirty = false; modalDirty = false; return true;
}
function closeModal(force = false, fromHistory = false) {
  if (!force && (saving || pending)) { toast('Verifică mai întâi salvarea în așteptare.'); return false; }
  if (!force && modalDirty && !confirm('Renunți la modificările din formular?')) return false;
  if (modal?.type === 'report-preview') {
    modal.pdfCleanup?.();
  }
  if ($('#dialog').open) $('#dialog').close();
  modal = null; modalDirty = false;
  if (navigationOverlay && !fromHistory) history.back();
  return true;
}
function openModal(type, title, content, submit = 'Salvează', extra = {}) {
  const alreadyOpen = $('#dialog').open;
  modal = { type, ...extra }; modalDirty = false;
  $('#dialog').classList.toggle('pdf-dialog', type === 'report-preview');
  $('#dialog').classList.toggle('help-dialog', type === 'help');
  $('#dialog-title').textContent = title; $('#modal-content').innerHTML = content;
  $('#modal-error').hidden = true; $('#modal-submit').textContent = submit; $('#modal-submit').hidden = !submit;
  $('.dialog-actions [data-action="close-modal"]').textContent = extra.closeLabel || (submit ? 'Renunță' : 'Închide');
  if (!alreadyOpen) { pushNavigation(true); $('#dialog').showModal(); }
  else replaceNavigation(true);
  updateNotices();
}
function renderGate(message = '') {
  state = null; classrooms = []; classroomId = null; $('.app').classList.remove('collecting', 'child-detail'); $('.app').dataset.screen = 'welcome'; $('#tabs').hidden = true; $('#help-button').hidden = true; $('#settings-button').hidden = true; $('#header-logos').hidden = true; $('#classroom-selector').hidden = true; $('#class-label').hidden = false; $('#class-label').textContent = 'Fondul clasei, la îndemână';
  if ($('.brand-mark')) $('.brand-mark').hidden = false;
  $('#main').innerHTML = `${welcomeBanner()}<div class="empty"><h1>Bine ai venit în clasa ta!</h1><p>Introdu codul din invitația primită pentru a deschide registrul clasei pe acest dispozitiv.</p></div><form id="invite-form">${field('Cod de invitație', 'code', inviteCode, 'required autocomplete="off" autocapitalize="none" spellcheck="false"')}${field('Numele dispozitivului (opțional)', 'label', '', 'maxlength="120" placeholder="De exemplu: telefonul meu sau laptopul meu"')}<p class="caption">Un cod poate activa două dispozitive, de exemplu telefonul și laptopul tău, în cele 7 zile de la emitere.</p><p id="invite-error" class="error" role="alert">${esc(message)}</p><button class="primary wide" type="submit">Deschide registrul clasei</button><details class="context-help"><summary>${icon('help')}Cum funcționează activarea?</summary>${simpleHelpFlow('access', true)}</details></form>`;
  observeCollectionDock();
  updateNotices();
}
function renderHeaderBranding() {
  const container = $('#header-logos');
  const entries = [['school', state.settings.hasSchoolLogo, state.settings.schoolLogoVersion],
    ['class', state.settings.hasClassLogo, state.settings.classLogoVersion]];
  container.hidden = !entries.some(([, present]) => present);
  if ($('.brand-mark')) $('.brand-mark').hidden = !container.hidden;
  for (const [kind, present, version] of entries) {
    const image = $(`#header-${kind}-logo`);
    const cacheKey = `${classroomId}:${version || ''}`;
    if (!present) { image.hidden = true; image.removeAttribute('src'); delete image.dataset.version; continue; }
    if (image.dataset.version === cacheKey && image.complete && image.naturalWidth) { image.hidden = false; continue; }
    image.hidden = true;
    image.onload = () => { image.hidden = false; container.hidden = false; if ($('.brand-mark')) $('.brand-mark').hidden = true; };
    image.onerror = () => {
      image.hidden = true;
      container.hidden = entries.every(([entryKind]) => $(`#header-${entryKind}-logo`).hidden);
      if ($('.brand-mark')) $('.brand-mark').hidden = !container.hidden;
    };
    image.dataset.version = cacheKey;
    image.src = scopedUrl(`/api/branding/${kind}?v=${encodeURIComponent(version || '')}`);
  }
}
function renderClassroomSelector() {
  const selector = $('#classroom-selector'), label = $('#class-label');
  if (classrooms.length <= 1) {
    selector.hidden = true; label.hidden = false;
    label.textContent = [state.settings.schoolName, state.settings.className, state.settings.schoolYear].filter(Boolean).join(' · ') || 'Configurează clasa pentru a începe';
    return;
  }
  selector.innerHTML = classrooms.map(item => `<option value="${esc(item.id)}" ${item.id === classroomId ? 'selected' : ''}>${esc([item.schoolName, item.className, item.schoolYear].filter(Boolean).join(' · ') || 'Clasă neconfigurată')}</option>`).join('');
  selector.hidden = false; label.hidden = true;
}
function render() {
  if (!state) return;
  if (tab === 'children' && classroomAccess()?.role === 'parent' && state.children.length === 1 && !child()) {
    childId = state.children[0].id;
    replaceNavigation();
  }
  const showingChild = tab === 'children' && !!childId && !!child();
  const collecting = showingChild && canWrite();
  $('.app').classList.toggle('collecting', collecting);
  $('.app').classList.toggle('child-detail', showingChild);
  $('.app').dataset.screen = tab;
  renderClassroomSelector();
  renderHeaderBranding();
  $('#help-button').hidden = false; $('#settings-button').hidden = false; $('#tabs').hidden = collecting;
  $$('[data-tab]').forEach(button => { if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (!state.settings.className) {
    $('#main').innerHTML = `${welcomeBanner()}<div class="empty"><h1>Pregătim clasa împreună</h1><p>Începe cu școala și clasa, apoi adaugă copiii și prima cheltuială.</p><button class="primary wide" data-action="settings">Configurează clasa</button></div>`;
  } else if (tab === 'children') childId && child() ? renderChild() : renderRoster();
  else if (tab === 'expenses') renderExpenses();
  else if (tab === 'ledger') renderLedger();
  else renderReports();
  if (!canWrite()) $('#main').insertAdjacentHTML('afterbegin', accessBanner());
  observeCollectionDock();
  updateNotices();
}
function renderRoster() {
  const parent = classroomAccess()?.role === 'parent', hasChildren = state.children.length > 0;
  $('#main').innerHTML = `${welcomeBanner()}<div class="roster-heading"><div><h1>${parent ? 'Situația copilului' : 'Copiii clasei'}</h1><p class="caption">${canWrite() ? 'Alege un copil pentru a înregistra o contribuție.' : 'Contribuții, sume de achitat și avansuri.'}</p>${canWrite() ? `<button type="button" class="context-help-link" data-action="help" data-help-topic="children">${icon('help')}Cum gestionez copiii?</button>` : ''}</div>${canWrite() ? `<details class="roster-tools" ${hasChildren ? '' : 'open'}><summary>${icon('plus')}<span>Gestionează copiii</span></summary><div class="toolbar"><button data-action="add-child">+ Adaugă un copil</button><button data-action="bulk-children">Adaugă lista</button></div></details>` : ''}</div>
  ${hasChildren ? `${canWrite() ? `<button class="reminder-queue-button" data-action="whatsapp-reminders" ${state.children.some(item => item.active && item.dueMinor > 0) ? '' : 'disabled'}>${icon('message')}<span><strong>Remindere WhatsApp</strong><small>Copiii cu sume de achitat</small></span></button>` : ''}<label class="caption" for="child-search">Caută un copil</label><div class="roster-search">${icon('search')}<input id="child-search" type="search" placeholder="Nume sau prenume" value="${esc(search)}" autocomplete="off"></div><div id="roster-list" class="children"></div>${canWrite() ? `<label class="check caption"><input id="show-archived" type="checkbox" ${showArchived ? 'checked' : ''}>Arată și copiii arhivați</label>` : ''}` : `<div class="empty"><h2>${canWrite() ? 'Începem cu copiii clasei' : 'Situația copilului va apărea aici'}</h2><p>${canWrite() ? 'Adaugă primul copil sau lipește lista clasei folosind butoanele de mai sus.' : 'Nu există încă un copil disponibil pentru acest acces. Casierul clasei te poate ajuta.'}</p></div>`}`;
  renderRosterList();
}
function renderRosterList() {
  if (!$('#roster-list')) return;
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('ro');
  const children = sortChildren(state.children).filter(c => (showArchived || c.active) && normalize(name(c)).includes(normalize(search)));
  $('#roster-list').innerHTML = children.length ? children.map(c => {
    const contactCount = contactsFor(c.id).length;
    const contactStatus = canWrite() ? `<span class="child-contact-status ${contactCount ? '' : 'missing'}" data-contact-count="${contactCount}">${icon('phone')}${contactCount ? (contactCount === 1 ? '1 telefon' : `${contactCount} telefoane`) : 'Fără telefon'}</span>` : '';
    const covered = c.contributions.some(item => item.coveredMinor > 0);
    return `<button class="child" data-child="${esc(c.id)}"><span><span class="child-name">${esc(c.lastName)}</span><span class="child-first-name">${esc(c.firstName)}</span>${c.active ? '' : '<span class="caption">Arhivat</span>'}${contactStatus}</span><span class="child-side">${c.dueMinor ? `<span class="amount due-status">${money(c.dueMinor)}</span><span class="caption">De achitat</span>` : `<span class="amount paid-status">${icon('check')}${covered ? 'Închis' : 'Achitat'}</span>`}${c.creditMinor ? `<span class="caption">Avans ${money(c.creditMinor)}</span>` : ''}</span></button>`;
  }).join('') : '<div class="empty"><p>Nu am găsit acest nume. Încearcă numele de familie sau prenumele.</p></div>';
}
function resetDraft(c) {
  draft = { target: 'all', amount: c.dueMinor ? decimal(c.dueMinor) : '', round: null, excess: 'change', settlement: 'none', useCredit: false, cashBeforeCredit: null, manual: false, allocations: {}, occurredAt: localNow(), comment: '' };
  dirty = false;
}
function whatsappLinks(c, compact = false) {
  const message = whatsappReminder(c, state.settings.className, state.settings);
  return contactsFor(c.id).map(contact => `<a class="whatsapp-link ${compact ? 'compact' : ''}" href="${esc(whatsappUrl(contact.phone, message))}" target="_blank" rel="noopener noreferrer" aria-label="Deschide conversația WhatsApp cu ${esc(contact.label)} pentru ${esc(name(c))}">${icon('message')}<span>${esc(contact.label)}<small>${esc(contact.phone)}</small></span></a>`).join('');
}
function contactPanel(c) {
  const contacts = contactsFor(c.id);
  const latestReport = [...(state.reports || [])].filter(item => item.type === 'child' && item.subjectId === c.id && !item.replacedById)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const report = latestReport?.stateRevision === state.revision ? latestReport : null;
  const reportAction = report
    ? `<div class="child-report-option"><div><strong>Mesaj și raport individual</strong><span class="caption">${esc(report.code)} · emis ${dateText(report.createdAt)}. Pentru PDF, mesajul se copiază automat; dacă WhatsApp nu îl atașează, îl poți lipi în câmpul mesajului.</span></div><div class="report-actions"><button type="button" data-action="share-child-text" data-id="${esc(c.id)}">Doar mesajul</button><button type="button" class="primary" data-action="share-child-report" data-id="${esc(report.id)}">Copiază mesajul + PDF</button><button type="button" data-action="create-child-report">Generează unul actualizat</button></div></div>`
    : `<div class="child-report-option"><div><strong>Mesaj + raport individual</strong><span class="caption">${latestReport ? `${esc(latestReport.code)} este dintr-o versiune anterioară a registrului. Generează fișa actuală înainte de partajare.` : 'Generează întâi fișa actuală; apoi o poți partaja împreună cu același mesaj.'}</span></div><button type="button" data-action="create-child-report">Generează raportul PDF</button></div>`;
  return `<section class="contact-panel" aria-labelledby="contact-panel-title"><div class="row"><div><h2 id="contact-panel-title">Contacte WhatsApp</h2><p class="caption">Conversația se deschide cu mesajul completat. Verifici și apeși Trimite în WhatsApp.</p><button type="button" class="context-help-link" data-action="help" data-help-topic="whatsapp">${icon('help')}Cum trimit?</button></div><button type="button" data-action="edit-contacts">${contacts.length ? 'Editează' : 'Adaugă'}</button></div>${contacts.length ? `<div class="whatsapp-actions">${whatsappLinks(c)}</div>` : '<p class="caption">Poți salva până la două contacte pentru acest copil.</p>'}${reportAction}</section>`;
}
function renderChild() {
  const c = child(); if (!draft) resetDraft(c);
  if (!canWrite()) {
    const parent = classroomAccess()?.role === 'parent';
    const nextContribution = unpaid(c).find(item => item.dueDate);
    const contributionRows = c.contributions.map(item => `<div class="card"><div class="row"><h3>${esc(item.title)}</h3><span class="amount">${money(item.paidMinor)} în fond</span></div>${item.directMinor ? `<div class="caption">Plătit direct beneficiarului: ${money(item.directMinor)}</div>` : ''}${item.coveredMinor ? `<div class="caption">Acoperită din fond: ${money(item.coveredMinor)}</div>` : ''}${item.adjustedMinor ? `<div class="caption">Ajustare de rotunjire: ${money(item.adjustedMinor)}</div>` : ''}<div class="caption">${item.remainingMinor ? `De achitat ${money(item.remainingMinor)}` : item.coveredMinor ? `<span class="paid-status">${icon('check')}Nu se mai colectează</span>` : `<span class="paid-status">${icon('check')}Achitat</span>`}${item.dueDate ? ` · termen ${dateText(item.dueDate)}` : ''}</div></div>`).join('');
    $('#main').innerHTML = `${parent ? welcomeBanner('Aproape de clasa ta', 'Contribuțiile și noutățile din registru, la îndemână.') : '<button class="back" data-action="back">‹ Copii</button>'}<div class="child-layout"><section class="child-overview" aria-labelledby="child-title"><h1 id="child-title">${esc(name(c))}</h1><p class="caption">Situația contribuțiilor</p><div class="summary parent-summary"><dl><div><dt>De achitat</dt><dd><strong>${money(c.dueMinor)}</strong></dd></div><div><dt>Avans disponibil</dt><dd>${money(c.creditMinor)}</dd></div></dl>${nextContribution ? `<p class="caption">Primul termen de achitat: ${dateText(nextContribution.dueDate)} · ${esc(nextContribution.title)}</p>` : c.dueMinor ? '' : '<p class="caption">Nu mai sunt contribuții de achitat.</p>'}</div></section><section class="child-contributions" aria-labelledby="contributions-title"><h2 id="contributions-title">Contribuții</h2><div class="stack">${contributionRows || '<p class="caption">Contribuțiile vor apărea aici după ce sunt adăugate de casier.</p>'}</div><details class="history"><summary>Istoricul copilului</summary><div class="stack">${transactionRows(state.transactions.filter(t => t.childId === c.id))}</div></details></section></div>`;
    return;
  }
  const contributions = unpaid(c);
  const contributionChoices = contributions.map(e => {
    const expense = state.expenses.find(item => item.id === e.expenseId);
    const matchingAdvance = (state.advances || []).some(item => !item.reversed && item.outstandingMinor > 0
      && (!item.expenseId || item.expenseId === e.expenseId));
    const canRecalculate = expense?.type === 'split' && expense.contributions.length > 1
      && expense.collectedMinor === 0 && (expense.directMinor || 0) === 0 && (expense.adjustedMinor || 0) === 0 && (expense.coveredMinor || 0) === 0;
    const canRound = e.remainingMinor <= 100 && e.paidMinor > 0;
    return `<div class="contribution-choice"><button type="button" class="choice" data-target="${esc(e.expenseId)}" aria-pressed="false"><span>${esc(e.title)}<span class="caption" style="display:block">${e.dueDate ? `Termen ${dateText(e.dueDate)}` : 'Fără termen'}${e.coveredMinor ? ` · acoperit din fond ${money(e.coveredMinor)}` : ''}</span></span><span class="choice-money">${money(e.remainingMinor)}</span></button>${matchingAdvance || canRecalculate || canRound ? `<button type="button" class="stop-collection" data-action="stop-collection" data-id="${esc(e.expenseId)}">Nu mai colectez</button>` : ''}</div>`;
  }).join('');
  $('#main').innerHTML = `<button class="back" data-action="back">‹ Copii</button><div class="row"><h1>${esc(name(c))}</h1><button data-action="edit-child" aria-label="Editează copilul">Editează</button></div><div class="collection-heading"><div class="caption">Încasare rapidă${c.active ? '' : ' · Copil arhivat'}</div><button type="button" class="context-help-link" data-action="help" data-help-topic="collection">${icon('help')}Cum încasez?</button></div>${c.creditMinor ? `<div class="summary"><div class="row"><span>Avans disponibil</span><strong>${money(c.creditMinor)}</strong></div><div class="toolbar"><button data-action="apply-credit" ${c.dueMinor ? '' : 'disabled'}>Folosește avansul</button><button data-action="refund">Restituie</button></div></div>` : ''}
  <form id="collection-form"><div class="collection-options">
  ${c.dueMinor ? `<button type="button" class="choice total-choice" data-target="all" aria-pressed="true"><span>Total de achitat</span><span class="total-number">${money(c.dueMinor)}</span></button><div class="section-label" id="round-label">Alege rapid suma primită</div><div class="rounds" id="rounds">${[5, 10, 50, 100].map(unit => `<button type="button" class="round" data-round="${unit}" aria-pressed="false"><span class="round-value"></span><span class="caption">multiplu de ${unit}</span></button>`).join('')}</div><div class="section-label">Sau alege o singură contribuție</div><div class="stack">${contributionChoices}</div>` : '<div class="empty"><h2>Nu mai sunt sume de colectat.</h2><p>Poți primi bani în avans. Introdu suma și alege „Păstrez în avans”.</p></div>'}
  <div class="summary" id="collection-summary" aria-live="polite" aria-atomic="true"></div>
  <details id="allocation-details" ${draft.manual ? 'open' : ''}><summary>Ajustează repartizarea</summary><label class="check"><input type="checkbox" id="manual" ${draft.manual ? 'checked' : ''} data-write-control>Aleg manual sumele pentru cheltuieli</label>${contributions.map(e => `<label class="allocation"><span>${esc(e.title)}<small style="display:block">De achitat ${money(e.remainingMinor)}</small></span><input inputmode="decimal" aria-label="${esc(e.title)}: repartizare în lei" data-allocation="${esc(e.expenseId)}" value="0" data-write-control></label>`).join('')}<p class="caption">Repartizarea automată acoperă mai întâi termenele cele mai apropiate. O cheltuială selectată primește doar suma datorată; diferența rămâne rest sau avans.</p></details>
  <details><summary>Data, ora și comentarii</summary><label>Data și ora<input id="collection-date" type="datetime-local" value="${esc(draft.occurredAt)}" required data-write-control></label><label>Comentarii<textarea id="collection-comment" maxlength="2000" data-write-control>${esc(draft.comment)}</textarea></label></details></div>
  <div class="collection-confirmation"><section class="collection-dock" aria-label="Confirmarea încasării"><div class="collection-dock-amount"><label for="received">Primesc</label><div class="money-input"><input id="received" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(draft.amount)}" aria-label="Suma primită în lei" data-write-control><span>lei</span></div></div>
  ${c.creditMinor && c.dueMinor ? `<button type="button" class="use-credit" data-use-credit aria-pressed="${draft.useCredit}"><span>${icon('check')}Folosește avansul copilului</span><strong data-use-credit-amount>${money(Math.min(c.creditMinor, c.dueMinor))}</strong></button>` : ''}
  <fieldset class="excess" id="excess" hidden><legend id="excess-label"></legend><div class="switch"><button type="button" data-excess="change" aria-pressed="true">Dau rest</button><button type="button" data-excess="credit" aria-pressed="false">Păstrez în avans</button></div></fieldset>
  <div id="collection-dock-summary" class="collection-dock-summary"></div><div id="small-settlement" class="small-settlement" hidden></div><p class="error" id="collection-error" role="alert" hidden></p><button type="submit" class="primary wide" id="collection-save">Înregistrează încasarea</button></section></div></form>
  ${c.dueMinor ? `<section class="summary direct-payment-prompt"><div><strong>A plătit direct altcuiva?</strong><p class="caption">Stinge contribuția fără să modifici numerarul clasei.</p></div><button type="button" data-action="direct-payment">Înregistrează plata directă</button></section>` : ''}
  ${contactPanel(c)}
  <details class="history"><summary>Istoricul copilului</summary><div class="stack">${transactionRows(state.transactions.filter(t => t.childId === c.id))}</div></details>`;
  updateCollection();
}
function updateCollection() {
  if (!$('#collection-form') || !draft) return;
  const c = child(), result = collectionResult(c, draft);
  const credit = creditSettlement(c, draft, result);
  const settlement = draft.useCredit ? null : smallSettlement(c, draft, result);
  if (!settlement || (draft.settlement === 'credit' && c.creditMinor < settlement.amountMinor)) draft.settlement = 'none';
  const settlementMinor = credit?.amountMinor || (settlement && draft.settlement !== 'none' ? settlement.amountMinor : 0);
  const finalDueMinor = Math.max(0, (result.dueMinor || 0) - settlementMinor);
  const base = draft.target === 'all' ? c.dueMinor : c.contributions.find(e => e.expenseId === draft.target)?.remainingMinor || 0;
  $$('[data-target]').forEach(b => b.setAttribute('aria-pressed', String(!draft.manual && b.dataset.target === draft.target)));
  $$('[data-round]').forEach(b => { b.querySelector('.round-value').textContent = money(roundUp(base, Number(b.dataset.round))); b.setAttribute('aria-pressed', String(draft.round === Number(b.dataset.round))); });
  if ($('#rounds')) { $('#rounds').hidden = draft.manual; $('#round-label').hidden = draft.manual; }
  $$('[data-excess]').forEach(b => {
    b.setAttribute('aria-pressed', String(draft.excess === b.dataset.excess));
    b.textContent = b.dataset.excess === 'change' ? `Dau rest · ${money(result.excessMinor || 0)}` : `Păstrez avans · ${money(result.excessMinor || 0)}`;
  });
  if ($('#received').value !== draft.amount) $('#received').value = draft.amount;
  if ($('[data-use-credit]')) $('[data-use-credit]').setAttribute('aria-pressed', String(draft.useCredit));
  if ($('[data-use-credit-amount]')) $('[data-use-credit-amount]').textContent = money(Math.min(c.creditMinor, base));
  $('#manual').checked = draft.manual;
  $$('[data-allocation]').forEach(input => { input.readOnly = !draft.manual; const value = draft.manual ? draft.allocations[input.dataset.allocation] || '0' : decimal(result.allocations?.find(a => a.expenseId === input.dataset.allocation)?.amountMinor || 0); if (input.value !== value) input.value = value; });
  const error = result.error || (!result.netMinor && !credit ? 'Pentru a încasa un avans, alege „Păstrez în avans”.' : '');
  $('#collection-error').hidden = !error || !draft.amount; $('#collection-error').textContent = error;
  $('#excess').hidden = !!result.error || !result.excessMinor;
  $('#excess-label').textContent = `Diferență: ${money(result.excessMinor || 0)}`;
  $('#small-settlement').hidden = !settlement;
  if (settlement) {
    const creditOption = c.creditMinor >= settlement.amountMinor
      ? `<option value="credit">Acoperă din avansul copilului</option>` : '';
    $('#small-settlement').innerHTML = `<label for="small-settlement-choice"><span>Diferență mică · ${money(settlement.amountMinor)}</span><select id="small-settlement-choice" data-write-control><option value="none">Rămâne de achitat</option>${creditOption}<option value="rounding">Închide ca ajustare de rotunjire</option></select></label>`;
    $('#small-settlement-choice').value = draft.settlement;
  }
  $('#collection-summary').hidden = !!result.error;
  $('#collection-dock-summary').hidden = !!result.error;
  const settlementRow = settlementMinor ? `<div><dt>${credit || draft.settlement === 'credit' ? 'Acoperă din avans' : 'Ajustare de rotunjire'}</dt><dd>${money(settlementMinor)}</dd></div>` : '';
  if (!result.error) $('#collection-dock-summary').innerHTML = `<dl><div><dt>Acoperă din numerar</dt><dd>${money(result.coveredMinor)}</dd></div>${settlementRow}<div><dt>Rămâne de achitat</dt><dd>${money(finalDueMinor)}</dd></div></dl>`;
  if (!result.error) $('#collection-summary').innerHTML = `<dl><div><dt>Acoperă din numerar</dt><dd>${money(result.coveredMinor)}</dd></div>${settlementRow}${result.changeMinor ? `<div><dt>Rest de dat</dt><dd>${money(result.changeMinor)}</dd></div>` : ''}${result.creditMinor ? `<div><dt>Avans nou</dt><dd>${money(result.creditMinor)}</dd></div>` : ''}<div><dt>Rămâne de achitat</dt><dd>${money(finalDueMinor)}</dd></div><div><dt>Intră în fondul clasei</dt><dd><strong>${money(result.netMinor)}</strong></dd></div></dl>`;
  $('#collection-save').textContent = result.netMinor > 0 ? `Înregistrează · ${money(result.netMinor)} numerar` : credit ? `Folosește avansul · ${money(credit.amountMinor)}` : 'Înregistrează încasarea';
  updateNotices();
  updateDockHeight();
}
function renderExpenses() {
  const expenses = [...state.expenses].reverse();
  const expenseCards = expenses.map(e => {
    const coveredTotal = e.collectedMinor + (e.directMinor || 0) + (e.coveredMinor || 0);
    const progress = e.totalMinor > 0 ? Math.min(100, Math.max(0, coveredTotal / e.totalMinor * 100)) : 0;
    return `<button class="card card-button expense-card ${e.cancelled ? 'transaction-muted' : ''}" data-expense="${esc(e.id)}">
      <div class="row"><h3>${esc(e.title)}</h3>${e.cancelled ? '<span class="badge">Anulată</span>' : ''}</div>
      <div class="caption">${e.dueDate ? `Termen ${dateText(e.dueDate)}` : 'Fără termen de plată'}</div>
      <div class="expense-totals">Acoperit <strong class="amount">${money(coveredTotal)}</strong> din <span class="amount">${money(e.totalMinor)}</span></div>
      ${e.cancelled ? '' : `<div class="expense-progress" aria-hidden="true"><span class="expense-progress-fill" style="width:${progress}%"></span></div>`}
      ${e.directMinor || e.coveredMinor ? `<div class="caption">În fond: <span class="amount">${money(e.collectedMinor)}</span>${e.directMinor ? ` · direct beneficiarului: <span class="amount">${money(e.directMinor)}</span>` : ''}${e.coveredMinor ? ` · acoperit din fond: <span class="amount">${money(e.coveredMinor)}</span>` : ''}</div>` : ''}
      ${e.adjustedMinor ? `<div class="caption">Ajustări de rotunjire: <span class="amount">${money(e.adjustedMinor)}</span></div>` : ''}
      <div class="caption">Plătit mai departe: <span class="amount">${money(e.paidOutMinor)}</span></div>
      ${e.latestPayment ? `<div class="expense-after-payment-brief"><span>Strâns în fond după ultima plată</span><strong class="amount">${money(e.collectedAfterLatestPaymentMinor || 0)}</strong></div>` : ''}
      <div class="caption">${typeLabels[e.type]} · ${e.participantCount ?? e.contributions.length} participanți</div>
    </button>`;
  }).join('');
  $('#main').innerHTML = `${pageHeading('Cheltuieli pentru clasa noastră', 'Contribuții, termene și plăți, într-un singur loc.', 'expenses')}
    ${canWrite() ? `<button type="button" class="context-help-link page-help-link" data-action="help" data-help-topic="expenses">${icon('help')}Cum creez o cheltuială?</button>` : ''}
    ${canWrite() ? `<button class="primary wide" data-action="add-expense" ${activeChildren().length ? '' : 'disabled'}>+ Cheltuială nouă</button>${activeChildren().length ? '' : '<p class="caption">Adaugă întâi copiii clasei, apoi poți crea prima cheltuială.</p>'}` : ''}
    <div class="expense-grid">${expenseCards || `<div class="empty"><h2>Ce pregătim pentru clasă?</h2><p>${canWrite() ? 'Adaugă prima cheltuială și alege copiii care participă.' : 'Cheltuielile vor apărea aici după ce sunt adăugate de casier.'}</p></div>`}</div>`;
}
function transactionRows(transactions) {
  return sortTransactionsNewestFirst(transactions).map(t => {
    const c = state.children.find(c => c.id === t.childId);
    const directRecipient = t.type === 'direct_payment' && t.destination ? ` · Beneficiar: ${esc(t.destination)}` : '';
    return `<button class="card ${t.reversed ? 'transaction-muted' : ''}" data-transaction="${esc(t.id)}"><div class="row"><strong>${labels[t.type] || esc(t.type)}</strong><span class="amount">${money(t.amountMinor)}</span></div><div>${esc(c ? name(c) : t.destination || '')}</div><div class="caption">${dateText(t.occurredAt)}${directRecipient}${t.reversed ? ' · Corectată' : ''}${t.changeMinor ? ` · Rest ${money(t.changeMinor)}` : ''}</div>${t.comment ? `<div class="caption">${esc(t.comment)}</div>` : ''}</button>`;
  }).join('') || '<p class="caption">Nu există operațiuni înregistrate.</p>';
}
function renderLedger() {
  const s = state.summary;
  const openAdvances = (state.advances || []).filter(item => !item.reversed && item.outstandingMinor > 0)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const advances = openAdvances.length ? `<h2>Sume de restituit</h2><div class="stack">${openAdvances.map(item => {
    const expense = state.expenses.find(entry => entry.id === item.expenseId);
    return `<article class="card"><div class="row"><strong>${esc(item.person)}</strong><span class="amount">${money(item.outstandingMinor)}</span></div><div class="caption">Avansat ${money(item.amountMinor)} · restituit ${money(item.repaidMinor)}${item.waivedMinor ? ` · acoperit din fond ${money(item.waivedMinor)}` : ''}${expense ? ` · ${esc(expense.title)}` : ''}</div>${canWrite() ? `<button type="button" class="primary wide" style="margin-top:14px" data-action="repay-advance" data-id="${esc(item.id)}">Restituie</button>` : ''}</article>`;
  }).join('')}</div>` : '';
  $('#main').innerHTML = `${pageHeading('Registrul clasei', 'O imagine clară a banilor din fond.', 'ledger')}
    ${canWrite() ? `<button type="button" class="context-help-link page-help-link" data-action="help" data-help-topic="ledger">${icon('help')}Cum funcționează registrul?</button>` : ''}
    <div class="ledger-layout"><section class="ledger-overview" aria-label="Situația fondului">
      <div class="balance"><span>Numerar disponibil în fond</span><strong class="amount">${money(s.balanceMinor)}</strong>
        <div class="balance-grid"><div><span class="caption">De restituit pentru sume avansate</span><span class="amount">${money(s.totalAdvanceOutstandingMinor || 0)}</span></div><div><span class="caption">Sold după restituirea sumelor avansate</span><span class="amount">${money(s.netBalanceMinor ?? s.balanceMinor)}</span></div></div>
        <p class="caption">Soldul include ${money(s.totalCreditMinor)} primiți în avans de la copii.</p>
      </div>
      <div class="summary"><dl><div><dt>De încasat de la copii</dt><dd>${money(s.totalDueMinor)}</dd></div><div><dt>Încasări în fond</dt><dd>${money(s.totalReceivedMinor)}</dd></div><div><dt>Plătit direct beneficiarilor</dt><dd>${money(s.totalDirectMinor || 0)}</dd></div><div><dt>Acoperit din fond</dt><dd>${money(s.totalCoveredMinor || 0)}</dd></div><div><dt>Bani ieșiți</dt><dd>${money(s.totalPaidMinor)}</dd></div><div><dt>Sold inițial</dt><dd>${money(state.settings.openingBalanceMinor)}</dd></div></dl></div>
      ${canWrite() ? '<div class="toolbar"><button class="primary" data-action="payment">+ Bani dați mai departe</button><button data-action="fund-advance">+ Sumă avansată fondului</button></div>' : ''}
      ${advances}
      <div class="toolbar"><button data-action="refresh">Actualizează</button>${canWrite() ? `<a href="${esc(scopedUrl('/api/export'))}" download="casierul-clasei.json">Export JSON</a>` : ''}</div>
    </section><section class="ledger-history" aria-labelledby="ledger-history-title"><h2 id="ledger-history-title">Istoricul operațiunilor</h2><p class="caption">Cele mai recente apar primele.</p><div class="stack">${transactionRows(state.transactions)}</div></section></div>`;
}
function renderReports() {
  const reports = state.reports || [];
  const paymentItems = paymentShareItems(state.settings);
  const debtors = state.children.filter(item => item.dueMinor > 0);
  const hasExpenses = state.expenses.some(expense => !expense.cancelled);
  const reportTypes = [
    { type: 'class', icon: 'reports', title: 'Situația clasei', description: 'Sold, cheltuieli și contribuții de primit, fără numele copiilor.', available: true },
    { type: 'matrix', icon: 'table', title: 'Tabelul contribuțiilor', description: 'Fiecare copil și fiecare cheltuială. Pentru verificare internă.', available: hasExpenses && state.children.length },
    { type: 'expense', icon: 'receipt', title: 'Situația unei cheltuieli', description: 'Necesar, încasat și plătit, fără numele copiilor.', available: hasExpenses },
    { type: 'child', icon: 'child', title: 'Fișa copilului', description: `${debtors.length} copii au de achitat ${money(debtors.reduce((total, item) => total + item.dueMinor, 0))}. Pentru trimitere privată.`, available: state.children.length },
  ];
  const stationery = `<svg class="reports-illustration" viewBox="0 0 156 116" fill="none" aria-hidden="true" focusable="false">
    <g transform="rotate(-8 51 68)" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <rect x="16" y="35" width="73" height="66" rx="6" fill="var(--surface)"/><path d="M31 36v64" stroke="var(--peach)" stroke-width="3"/>
      <path d="M12 48h9m-9 16h9m-9 16h9"/><path d="M42 54h32M42 65h26M42 76h30M42 87h19" opacity=".35"/>
    </g>
    <path d="M91 26 143 10l-17 49-11-21-24-12Z" fill="var(--sky)" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="m115 38 28-28m-28 28-4 14 9-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M119 68c10 18-11 32-22 16-6-9 7-15 13-7 10 16-9 28-24 29" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 5" opacity=".45"/>
    <path d="m67 10 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="var(--sunshine)" stroke="currentColor" stroke-width="1.2"/>
    <circle cx="140" cy="87" r="4" fill="var(--peach)"/>
  </svg>`;
  $('#main').innerHTML = `<section class="reports-intro" aria-labelledby="reports-title"><div class="reports-intro-copy"><h1 id="reports-title">Rapoarte de împărtășit</h1><p>Fiecare contribuție, la locul ei. Situații clare, pregătite pentru consultare și partajare.</p>${canWrite() ? `<button type="button" class="context-help-link" data-action="help" data-help-topic="reports">${icon('help')}Cum emit un raport?</button>` : ''}</div>${stationery}</section>
    ${canWrite() ? `<section class="payment-details card" aria-labelledby="payment-details-title"><div class="row"><div><h2 id="payment-details-title">Detalii de plată</h2><p class="caption">Trimite fiecare informație separat, ca părinții să poată deschide linkul sau copia ușor datele bancare.</p></div><button data-action="settings">${paymentItems.length ? 'Editează' : 'Configurează'}</button></div>${paymentItems.length ? `<div class="payment-detail-list">${paymentItems.map(item => `<article class="payment-detail"><div><strong>${esc(item.label)}</strong>${item.key === 'revolut' ? `<a href="${esc(item.value)}" target="_blank" rel="noopener noreferrer">${esc(item.value)}</a>` : `<span class="payment-detail-value">${esc(item.value)}</span>`}</div><div class="payment-detail-actions"><a class="whatsapp-link compact" href="${esc(whatsappShareUrl(item.message))}" target="_blank" rel="noopener noreferrer" aria-label="Trimite ${esc(item.label)} prin WhatsApp">${icon('message')}WhatsApp</a><button type="button" data-copy-payment="${esc(item.key)}">Copiază</button></div></article>`).join('')}</div>` : '<div class="empty"><p>Adaugă linkul Revolut.me, numele beneficiarului și IBAN-ul în setările clasei.</p></div>'}</section>` : ''}
    ${canWrite() ? `<div class="report-types">${reportTypes.map(item => `<button class="card card-button report-type report-type-${item.type}" data-action="report-${item.type}" ${item.available ? '' : 'disabled'}><span class="report-icon">${icon(item.icon)}</span><span class="report-type-copy"><h3>${item.title}</h3><span class="caption">${item.description}</span></span></button>`).join('')}</div>` : '<p>Consultă, descarcă sau partajează rapoartele emise de casier la care ai acces.</p>'}
    <section class="report-archive" aria-labelledby="report-archive-title"><div class="report-archive-heading"><h2 id="report-archive-title">${icon('reports')}Rapoarte emise</h2></div><p class="caption">„Partajează PDF” deschide selectorul telefonului; de acolo poți alege WhatsApp și grupul părinților.</p>
      <div class="stack report-archive-list">${reports.length ? reports.map(report => `<article class="card report-card ${report.replacedById ? 'replaced' : ''}">
        <div class="row"><h3>${esc(reportTypeLabels[report.type])}</h3><span class="badge">${report.replacedById ? 'Înlocuit' : 'Emis'}</span></div>
        <div>${esc(report.subjectLabel)}</div><div class="caption">${dateText(report.createdAt)}</div>
        <div class="caption">${esc(report.code)} · revizia ${report.stateRevision}${report.replacesId ? ' · Raport corectiv' : ''}</div>
        <div class="report-actions"><button class="primary" data-action="view-report" data-id="${esc(report.id)}">Vizualizează</button><button data-action="share-report" data-id="${esc(report.id)}">Partajează PDF</button><a href="${esc(scopedUrl(`/api/reports/${encodeURIComponent(report.id)}/pdf`))}" download="${esc(report.filename)}">Descarcă</a>${canWrite() && !report.replacedById ? `<button data-action="replace-report" data-id="${esc(report.id)}">Emite corecție</button>` : ''}</div>
      </article>`).join('') : `<div class="empty report-empty"><span class="report-empty-icon">${icon('reports')}</span><p>${canWrite() ? 'Alege un tip de raport de mai sus. PDF-urile emise se păstrează aici, împreună cu istoricul lor.' : 'Rapoartele vor apărea aici după ce sunt emise de casier.'}</p></div>`}</div>
    </section>`;
}
function reportModal(type, replacesId = null, subjectId = null) {
  const replaced = replacesId ? (state.reports || []).find(report => report.id === replacesId) : null;
  const fixedSubject = replaced?.subjectId || subjectId || null;
  let selector = '';
  if (type === 'expense') {
    const expenses = [...state.expenses].filter(expense => !expense.cancelled).reverse();
    selector = replaced ? `<p><strong>${esc(replaced.subjectLabel)}</strong></p>` : `<label>Cheltuiala<select name="subjectId" required>${expenses.map(expense => `<option value="${esc(expense.id)}">${esc(expense.title)}</option>`).join('')}</select></label>`;
  } else if (type === 'child') {
    const fixedChild = fixedSubject ? state.children.find(item => item.id === fixedSubject) : null;
    selector = fixedSubject ? `<p><strong>${esc(replaced?.subjectLabel || (fixedChild ? name(fixedChild) : 'Copil'))}</strong></p>` : `<label>Filtrează lista<select name="debtFilter"><option value="due">Doar copiii cu sume de achitat</option><option value="all">Toți copiii</option><option value="paid">Doar copiii cu totul achitat</option></select></label><label>Copilul<select name="subjectId" required></select></label><p id="report-child-count" class="caption"></p>`;
  }
  const privacy = type === 'child' ? 'Fișa conține numele copilului și este destinată trimiterii private.' : type === 'matrix' ? 'Raportul conține numele tuturor copiilor și este destinat verificării interne de către tine și dirigintă.' : 'Restanțele apar doar ca număr de copii și sumă totală, fără nume sau inițiale.';
  openModal('report', replaced ? 'Emite raport corectiv' : reportTypeLabels[type], `${selector}<div class="summary"><strong>Situație la momentul emiterii</strong><p class="caption">PDF-ul va păstra exact datele și revizia actuală a registrului.</p></div><p class="caption">${privacy}</p>${replaced ? `<p class="caption">Noul raport va marca faptul că înlocuiește ${esc(replaced.code)}. Raportul vechi rămâne în arhivă.</p>` : ''}<details class="context-help"><summary>${icon('help')}Cum se emite raportul?</summary>${simpleHelpFlow('reports', true)}</details>`, 'Generează PDF', {
    reportType: type, replacesId, subjectId: fixedSubject, requestId: crypto.randomUUID(),
  });
  if (type === 'child' && !replaced) updateChildReportOptions();
}
function updateChildReportOptions() {
  if (modal?.type !== 'report' || modal.reportType !== 'child' || !$('#modal-form').elements.debtFilter) return;
  const form = $('#modal-form'), filter = form.elements.debtFilter.value, select = form.elements.subjectId;
  const previous = select.value;
  const alphabetical = (a, b) => a.id === b.id ? 0 : sortChildren([a, b])[0] === a ? -1 : 1;
  const children = [...state.children].filter(item => filter === 'all' || (filter === 'due' ? item.dueMinor > 0 : item.dueMinor === 0))
    .sort((a, b) => (filter === 'due' ? b.dueMinor - a.dueMinor : 0) || alphabetical(a, b));
  select.innerHTML = children.map(item => `<option value="${esc(item.id)}">${esc(name(item))} · ${item.dueMinor ? `De achitat ${money(item.dueMinor)}` : `Fără sume de achitat${item.creditMinor ? ` · Avans ${money(item.creditMinor)}` : ''}`}</option>`).join('');
  if (children.some(item => item.id === previous)) select.value = previous;
  select.disabled = !children.length;
  $('#modal-submit').disabled = saving || !children.length;
  $('#report-child-count').textContent = children.length ? `${children.length} ${children.length === 1 ? 'copil afișat' : 'copii afișați'}. Sumele cele mai mari de achitat apar primele.` : 'Niciun copil pentru acest filtru.';
}
async function createReport(form) {
  if (saving) return;
  const subjectId = ['class', 'matrix'].includes(modal.reportType) ? null : modal.subjectId || form.elements.subjectId?.value;
  saving = true; updateNotices();
  try {
    const result = await api('/api/reports', { method: 'POST', body: JSON.stringify({
      requestId: modal.requestId, type: modal.reportType, ...(subjectId ? { subjectId } : {}), ...(modal.replacesId ? { replacesId: modal.replacesId } : {}),
    }) });
    state.reports = result.reports;
    closeModal(true); render(); toast(`${result.report.code} a fost generat. Îl poți vizualiza sau partaja acum.`);
  } catch (error) { $('#modal-error').textContent = error.message; $('#modal-error').hidden = false; }
  finally { saving = false; updateNotices(); }
}
async function shareReport(reportId, message = null) {
  const report = (state.reports || []).find(item => item.id === reportId);
  if (!report) return;
  const shareMessage = message ?? reportShareMessage(report, state.settings.className);
  saving = true; updateNotices();
  try {
    const response = await fetch(scopedUrl(`/api/reports/${encodeURIComponent(report.id)}/pdf`), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('PDF-ul nu a putut fi descărcat.');
    const file = new File([await response.blob()], report.filename, { type: 'application/pdf' });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ title: `${report.code} · ${reportTypeLabels[report.type]}`, text: shareMessage, files: [file] });
    } else {
      const url = URL.createObjectURL(file), link = document.createElement('a');
      link.href = url; link.download = report.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('PDF descărcat. Atașează-l în WhatsApp.');
    }
  } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'PDF-ul nu a putut fi partajat.'); }
  finally { saving = false; updateNotices(); }
}
async function shareChildReport(reportId) {
  const report = (state.reports || []).find(item => item.id === reportId && item.type === 'child');
  const c = report ? state.children.find(item => item.id === report.subjectId) : null;
  if (!c) return;
  const message = whatsappReminder(c, state.settings.className, state.settings);
  const copied = await copyText(message);
  toast(copied ? 'Mesaj copiat. Dacă WhatsApp îl omite, lipește-l lângă PDF.' : 'PDF-ul va fi partajat, dar mesajul nu a putut fi copiat.');
  await shareReport(report.id, message);
}
async function shareChildText(id) {
  const c = state.children.find(item => item.id === id);
  if (!c) return;
  const message = whatsappReminder(c, state.settings.className, state.settings);
  saving = true; updateNotices();
  try {
    if (navigator.share) await navigator.share({ title: `Situația contribuțiilor · ${name(c)}`, text: message });
    else window.open(whatsappShareUrl(message), '_blank', 'noopener,noreferrer');
  } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'Mesajul nu a putut fi partajat.'); }
  finally { saving = false; updateNotices(); }
}
async function copyText(value) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard indisponibil');
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = value; input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { /* The caller can explain that copying failed. */ }
    input.remove();
    return copied;
  }
}
async function copyPaymentDetail(key) {
  const item = paymentShareItems(state.settings).find(entry => entry.key === key);
  if (!item) return;
  if (!await copyText(item.value)) { toast('Textul nu a putut fi copiat.'); return; }
  toast(`${item.label} a fost copiat.`);
}
async function loadReportPreview(currentModal, report) {
  const status = $('#pdf-preview-status'), pages = $('#pdf-preview-pages'), dialog = $('#dialog');
  const abort = new AbortController(); currentModal.pdfAbort = abort;
  const timeout = setTimeout(() => abort.abort(), 20000);
  const pageEntries = [];
  let disposed = false, observer = null, resizeTimer = null;
  let rendering = false, renderAgain = false, renderedSize = '', scheduledSize = '';
  const active = () => modal === currentModal && !disposed;
  const dimensions = () => {
    const width = Math.max(1, Math.min(1120, pages.clientWidth));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    return { width, ratio, key: `${width}:${ratio}` };
  };
  const queueResize = () => {
    if (!active()) return;
    const { key } = dimensions();
    if (key === scheduledSize) return;
    scheduledSize = key;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (active()) void renderPages(); }, 120);
  };
  currentModal.pdfCleanup = () => {
    if (disposed) return;
    disposed = true;
    abort.abort(); clearTimeout(timeout); clearTimeout(resizeTimer);
    observer?.disconnect();
    window.removeEventListener('resize', queueResize);
    try { currentModal.pdfRenderTask?.cancel(); } catch { /* The page may already be rendered. */ }
    // Destroying the loading task also releases its document and worker.
    const loadingTask = currentModal.pdfLoadingTask;
    currentModal.pdfRenderTask = null; currentModal.pdfLoadingTask = null; currentModal.pdfDocument = null;
    Promise.resolve().then(() => loadingTask?.destroy()).catch(() => {});
  };
  const showError = error => {
    if (!active()) return;
    currentModal.pdfCleanup();
    status.hidden = false; status.classList.add('error');
    status.textContent = error.name === 'AbortError' ? 'Încărcarea raportului a durat prea mult. Încearcă din nou.' : (error.message || 'Raportul nu a putut fi afișat.');
  };
  async function renderPages() {
    if (!active()) return;
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    try {
      do {
        renderAgain = false;
        const size = dimensions(); scheduledSize = size.key;
        if (size.key === renderedSize) continue;
        for (const { page, natural, wrapper, pageNumber } of pageEntries) {
          if (!active()) return;
          if (!renderedSize) status.textContent = `Se afișează pagina ${pageNumber} din ${pageEntries.length}…`;
          const viewport = page.getViewport({ scale: (size.width / natural.width) * size.ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          canvas.style.width = '100%';
          canvas.setAttribute('aria-label', `Pagina ${pageNumber} din ${pageEntries.length}`);
          const renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
          currentModal.pdfRenderTask = renderTask;
          await renderTask.promise;
          currentModal.pdfRenderTask = null;
          if (!active()) return;
          if (renderAgain) break;
          // Keep the previous canvas visible while repainting. The figure's
          // aspect ratio keeps its place in the document throughout a resize.
          const scrollTop = dialog.scrollTop;
          wrapper.replaceChildren(canvas); wrapper.dataset.rendered = 'true';
          dialog.scrollTop = scrollTop;
        }
        if (!renderAgain) renderedSize = size.key;
      } while (renderAgain && active());
      if (active()) status.hidden = true;
    } catch (error) { showError(error); }
    finally { currentModal.pdfRenderTask = null; rendering = false; }
  }
  try {
    status.textContent = 'Se încarcă fișierul PDF…';
    const response = await fetch(scopedUrl(`/api/reports/${encodeURIComponent(report.id)}/pdf`), { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
    if (!response.ok) throw new Error('PDF-ul nu a putut fi încărcat.');
    status.textContent = 'Se pregătește afișarea…';
    const [pdfjs, data] = await Promise.all([pdfModulePromise ||= import('/vendor/pdfjs/pdf.min.mjs'), response.arrayBuffer()]);
    clearTimeout(timeout);
    if (!active()) return;
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const loadingTask = pdfjs.getDocument({ data });
    currentModal.pdfLoadingTask = loadingTask;
    const pdfDocument = await loadingTask.promise;
    if (!active()) return;
    currentModal.pdfDocument = pdfDocument;
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      if (!active()) return;
      const natural = page.getViewport({ scale: 1 });
      const wrapper = document.createElement('figure');
      wrapper.style.maxWidth = '1120px';
      wrapper.style.aspectRatio = `${natural.width} / ${natural.height}`;
      pages.append(wrapper);
      pageEntries.push({ page, natural, wrapper, pageNumber });
    }
    scheduledSize = dimensions().key;
    observer = typeof ResizeObserver === 'function' ? new ResizeObserver(queueResize) : null;
    observer?.observe(pages);
    window.addEventListener('resize', queueResize);
    await renderPages();
  } catch (error) { showError(error); }
}
function viewReport(reportId) {
  const report = (state.reports || []).find(item => item.id === reportId);
  if (!report) return;
  openModal('report-preview', `${report.code} · ${reportTypeLabels[report.type]}`, '<p id="pdf-preview-status" class="caption pdf-preview-status" role="status">Se încarcă raportul…</p><div id="pdf-preview-pages" class="pdf-preview-pages"></div>', null,
    { reportId, closeLabel: 'Închide' });
  loadReportPreview(modal, report);
}
function settingsModal() {
  const s = state.settings;
  if (!canWrite()) {
    const access = classroomAccess();
    openModal('access', 'Accesul acestui dispozitiv', `<div class="summary"><strong>${accessLabel()}</strong><p class="caption">${access?.role === 'parent' ? 'Vezi datele generale ale clasei și situația copilului asociat.' : 'Vezi registrul complet și rapoartele, fără drept de modificare.'}</p>${access?.access_expires_at ? `<p class="caption">Acces până la ${dateText(access.access_expires_at)}</p>` : ''}</div><button type="button" class="wide" data-action="add-access">+ Adaugă acces din invitație</button><button type="button" class="wide" data-action="logout">Deconectează dispozitivul</button>`, null);
    return;
  }
  const year = new Date().getFullYear() - (new Date().getMonth() < 8 ? 1 : 0);
  const logoPicker = (kind, label, exists) => `<div class="logo-picker"><div class="logo-preview"><img id="${kind}-logo-preview" ${exists ? `src="${esc(scopedUrl(`/api/branding/${kind}?v=${encodeURIComponent(s[`${kind}LogoVersion`] || '')}`))}"` : 'hidden'} alt="${esc(label)}"><span id="${kind}-logo-empty" ${exists ? 'hidden' : ''}>Fără siglă</span></div><strong>${esc(label)}</strong><label class="file-button">Alege imaginea<input type="file" accept="image/png,image/jpeg,image/webp" data-logo-input="${kind}" class="visually-hidden"></label><button type="button" data-action="remove-logo" data-logo-kind="${kind}" ${exists ? '' : 'hidden'}>Elimină</button></div>`;
  openModal('settings', s.className ? 'Setările clasei' : 'Configurează clasa', `${field('Școala', 'schoolName', s.schoolName, 'required maxlength="160"')}${field('Clasa', 'className', s.className, 'required maxlength="80"')}${field('An școlar', 'schoolYear', s.schoolYear || `${year}–${year + 1}`, 'required maxlength="40"')}<div class="section-label">Detalii de plată</div>${field('Link Revolut.me', 'paymentRevolutUrl', s.paymentRevolutUrl || '', 'inputmode="url" maxlength="240" autocomplete="url" placeholder="https://revolut.me/nume"')}${field('Numele beneficiarului', 'paymentBeneficiary', s.paymentBeneficiary || '', 'maxlength="160" autocomplete="name"')}${field('IBAN', 'paymentIban', s.paymentIban || '', 'maxlength="64" autocapitalize="characters" spellcheck="false" placeholder="RO00 BANK 0000 0000 0000 0000"')}<p class="caption">În Rapoarte, fiecare valoare va avea propriul buton WhatsApp și propriul buton de copiere. Pentru detaliile transferului, părintele va folosi numele elevului.</p><div class="section-label">Sigle pentru rapoarte</div><div class="logo-grid">${logoPicker('school', 'Sigla școlii', s.hasSchoolLogo)}${logoPicker('class', 'Sigla clasei', s.hasClassLogo)}</div><p class="caption">Poți alege PNG, JPG sau WebP. Imaginea este redimensionată pe dispozitiv și apare în antetul PDF-urilor emise de acum înainte.</p>${field('Sold inițial (lei)', 'openingBalance', decimal(s.openingBalanceMinor), `inputmode="decimal" required ${state.transactions.length ? 'readonly' : ''}`)}<p class="caption">Banii deja existenți în fond înainte să începi evidența. ${state.transactions.length ? 'Soldul inițial nu mai poate fi schimbat după înregistrarea operațiunilor.' : 'Avansurile individuale se înregistrează separat, prin încasări.'}</p>${state.settings.className ? `<div class="toolbar"><a href="${esc(scopedUrl('/api/export'))}" download="casierul-clasei.json">Exportă datele JSON</a><button type="button" data-action="logout">Deconectează dispozitivul</button></div>` : ''}<div class="section-label">Drepturi pe alte clase</div><button type="button" class="wide" data-action="add-access">+ Adaugă acces din invitație</button>${device?.is_owner ? '<div class="section-label">Mai multe clase</div><button type="button" class="wide" data-action="add-classroom">+ Adaugă altă clasă</button><p class="caption">Fiecare clasă are registru, rapoarte și drepturi de acces separate.</p>' : ''}<details class="context-help"><summary>${icon('help')}Cum configurez clasa?</summary>${simpleHelpFlow('settings', true)}</details>`, 'Salvează', { logoChanges: {} });
}
function accessModal() {
  openModal('add-access', 'Adaugă acces la o clasă', `${field('Cod de invitație', 'code', '', 'required autocomplete="off" autocapitalize="none" spellcheck="false"')}<p class="caption">Folosește invitația emisă pentru clasa și rolul dorite. Accesul existent pe acest dispozitiv rămâne activ.</p><details class="context-help"><summary>${icon('help')}Cum se adaugă accesul?</summary>${simpleHelpFlow('access', true)}</details>`, 'Adaugă accesul');
}
function classroomModal() {
  const year = new Date().getFullYear() - (new Date().getMonth() < 8 ? 1 : 0);
  openModal('add-classroom', 'Adaugă o clasă', `${field('Școala', 'schoolName', state.settings.schoolName, 'required maxlength="160"')}${field('Clasa', 'className', '', 'required maxlength="80"')}${field('An școlar', 'schoolYear', `${year}–${year + 1}`, 'required maxlength="40"')}<p class="caption">Clasa nouă pornește cu un registru gol și drepturi de acces independente. Vei avea automat acces de casier.</p><details class="context-help"><summary>${icon('help')}Cum funcționează clasele și rolurile?</summary>${simpleHelpFlow('classrooms', true)}</details>`, 'Creează clasa', { requestId: crypto.randomUUID() });
}

function updateLogoPreview(kind, data) {
  const image = $(`#${kind}-logo-preview`), empty = $(`#${kind}-logo-empty`), remove = $(`[data-action="remove-logo"][data-logo-kind="${kind}"]`);
  const visible = typeof data === 'string';
  if (visible) image.src = data;
  image.hidden = !visible; empty.hidden = visible; remove.hidden = !visible;
}

async function logoDataUrl(file) {
  if (!file || file.size > 10 * 1024 * 1024) throw new Error('Imaginea trebuie să aibă cel mult 10 MB.');
  let source;
  try {
    if ('createImageBitmap' in window) source = await createImageBitmap(file);
    else source = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagine invalidă.')); };
      image.src = url;
    });
  } catch { throw new Error('Imaginea nu a putut fi citită. Folosește PNG, JPG sau WebP.'); }
  try {
    for (const limit of [512, 384, 256]) {
      const scale = Math.min(1, limit / Math.max(source.width, source.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.width * scale)); canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Imaginea nu a putut fi procesată.');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (blob && blob.size <= 256 * 1024) return await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
      });
    }
  } finally { source.close?.(); }
  throw new Error('Sigla este prea complexă pentru raport. Încearcă o imagine mai simplă.');
}
function childModal(edit = false) {
  const c = edit ? child() : null;
  openModal(edit ? 'edit-child' : 'add-child', edit ? 'Editează copilul' : 'Adaugă un copil', `${field('Nume de familie', 'lastName', c?.lastName || '', 'required maxlength="80" autocomplete="family-name"')}${field('Prenume', 'firstName', c?.firstName || '', 'required maxlength="80" autocomplete="given-name"')}${c ? `<label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}>Copil activ în clasă</label><p class="caption">Arhivarea ascunde copilul din lista principală. Datoriile, avansul și istoricul rămân în registru.</p>` : ''}`, 'Salvează', { childId: c?.id });
}
function contactsModal(targetId = childId) {
  const c = state.children.find(item => item.id === targetId);
  if (!c) return;
  const contacts = contactsFor(c.id);
  const slot = index => {
    const contact = contacts[index];
    return `<fieldset class="contact-slot"><legend>Contact ${index + 1}</legend>${field('Nume sau rol', `contactLabel${index + 1}`, contact?.label || '', 'maxlength="80" placeholder="Mama, tata, tutore…"')}${field('Număr WhatsApp', `contactPhone${index + 1}`, contact?.phone || '', 'type="tel" inputmode="tel" autocomplete="tel" maxlength="40" placeholder="07xx xxx xxx"')}</fieldset>`;
  };
  openModal('contacts', `Contacte pentru ${name(c)}`, `${slot(0)}${slot(1)}<p class="caption">Datele sunt vizibile numai casierilor. Nu apar în rapoarte, exportul JSON sau accesul părinților și auditorilor.</p><details class="context-help"><summary>${icon('help')}Cum folosesc contactele?</summary>${simpleHelpFlow('whatsapp', true)}</details>`, 'Salvează contactele', { childId: c.id });
}
function remindersModal() {
  const debtors = sortChildren(state.children.filter(item => item.active && item.dueMinor > 0));
  openModal('whatsapp-reminders', 'Remindere WhatsApp', `<p class="caption">Fiecare buton deschide conversația directă cu situația copilului deja completată. Mesajul se trimite numai după ce îl confirmi în WhatsApp.</p><div class="reminder-list">${debtors.map(c => {
    const links = whatsappLinks(c, true);
    return `<article class="reminder-row"><div><strong>${esc(name(c))}</strong><span class="caption">De achitat ${money(c.dueMinor)}</span></div>${links ? `<div class="whatsapp-actions">${links}</div>` : `<button type="button" data-action="edit-reminder-contact" data-id="${esc(c.id)}">Adaugă contact</button>`}</article>`;
  }).join('')}</div>`, null, { closeLabel: 'Închide' });
}
function bulkModal() {
  openModal('bulk-children', 'Adaugă lista clasei', '<p>Un copil pe rând, cu numele de familie și prenumele separate prin punct și virgulă.</p><label>Lista copiilor<textarea name="childrenText" rows="9" required placeholder="Nume de familie; Prenume" spellcheck="false"></textarea></label><p class="caption">Păstrează numele compuse înaintea separatorului. Lista existentă rămâne în registru.</p><div id="bulk-preview" class="preview-list"></div>', 'Adaugă copiii');
}
function parseBulk(text) {
  const rows = text.split(/\r?\n/).map(row => row.trim()).filter(Boolean);
  if (!rows.length) throw new Error('Introdu cel puțin un copil.');
  return rows.map((row, i) => {
    const parts = row.split(';').map(part => part.trim());
    if (parts.length !== 2 || !parts.every(Boolean)) throw new Error(`Rândul ${i + 1}: folosește formatul Nume de familie; Prenume.`);
    return { lastName: parts[0], firstName: parts[1] };
  });
}
function expenseModal(expense = null) {
  const linked = !!expense && state.transactions.some(tx => !tx.reversed && tx.type !== 'reversal'
    && (tx.expenseId === expense.id || tx.allocations.some(allocation => allocation.expenseId === expense.id)));
  const existing = new Map(expense?.contributions.map(item => [item.childId, item]) || []);
  const participants = sortChildren(state.children.filter(c => c.active || existing.has(c.id)));
  const type = expense?.type || 'fixed';
  const formulaLockedAttribute = linked ? 'disabled data-locked' : '';
  const splitParticipantsEditable = type === 'split' && expense?.collectedMinor === 0
    && (expense?.directMinor || 0) === 0 && (expense?.adjustedMinor || 0) === 0 && (expense?.coveredMinor || 0) === 0;
  const allParticipantsLocked = linked && !splitParticipantsEditable;
  const typeOptions = [['fixed', 'Sumă fixă pentru fiecare copil'], ['split', 'Total împărțit între participanți'], ['quantity', 'Cantitate pentru fiecare copil × preț']]
    .map(([value, label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`).join('');
  const participantFields = participants.map(c => {
    const contribution = existing.get(c.id), checked = expense ? !!contribution : c.active;
    const previous = c.contributions.find(item => item.expenseId === expense?.id);
    const settledMinor = (previous?.paidMinor ?? 0) + (previous?.directMinor ?? 0) + (previous?.adjustedMinor ?? 0) + (previous?.coveredMinor ?? 0);
    const participantLocked = linked && (settledMinor > 0 || (type === 'split' && !splitParticipantsEditable));
    const participantLockedAttribute = participantLocked ? 'disabled data-locked' : '';
    const quantityLocked = linked && type !== 'quantity' ? formulaLockedAttribute : '';
    return `<div class="participant"><label class="check"><input type="checkbox" data-participant="${esc(c.id)}" ${checked ? 'checked' : ''} ${participantLockedAttribute}>${esc(name(c))}${c.active ? '' : ' · Arhivat'}</label><input type="number" data-quantity="${esc(c.id)}" min="1" max="10000" step="1" value="${contribution?.quantity || 1}" aria-label="Cantitate pentru ${esc(name(c))}" ${quantityLocked} hidden></div>`;
  }).join('');
  openModal(expense ? 'edit-expense' : 'expense', expense ? 'Editează cheltuiala' : 'Cheltuială nouă',
    `${field('Denumire', 'title', expense?.title || '', 'required maxlength="200"')}<label>Calculul contribuției<select name="type" ${formulaLockedAttribute}>${typeOptions}</select></label>${field('<span id="expense-amount-label">Suma (lei)</span>', 'amount', expense ? decimal(expense.amountMinor) : '', `inputmode="decimal" autocomplete="off" required ${formulaLockedAttribute}`)}<label>Termen de plată (opțional)<input name="dueDate" type="date" value="${esc(expense?.dueDate || '')}"></label>${timestampField(expense ? localDateTime(expense.occurredAt) : localNow())}<div class="section-label">Cine participă?</div><label class="check"><input type="checkbox" id="all-participants" ${allParticipantsLocked ? 'disabled data-locked' : ''}>Toți copiii</label><div class="participants">${participantFields}</div><p class="caption">${linked && type === 'split' && splitParticipantsEditable ? 'Poți adăuga sau exclude copii până la prima contribuție încasată. Totalul rămâne neschimbat, iar contribuțiile se recalculează automat.' : linked && type === 'quantity' ? 'Poți adăuga participanți, elimina participanții fără sume achitate și corecta cantitățile fără a coborî contribuția sub suma deja achitată.' : linked && type === 'fixed' ? 'Poți adăuga participanți și îi poți elimina pe cei fără sume achitate. Suma și participanții care au plătit rămân protejați.' : linked ? 'Participanții sunt protejați deoarece există contribuții încasate pentru această cheltuială. Denumirea, datele și comentariile pot fi editate.' : 'Copiii nebifați nu au contribuție la această cheltuială. Modificările recalculează contribuțiile înainte de salvare.'}</p><div id="expense-preview" class="summary" aria-live="polite"></div>${comments(expense?.comment || '')}<details class="context-help"><summary>${icon('help')}Cum funcționează cheltuiala?</summary>${simpleHelpFlow('expenses', true)}</details>`,
    expense ? 'Salvează modificările' : 'Creează cheltuiala', expense ? { expenseId: expense.id } : {});
  updateExpensePreview();
}
function readExpense() {
  const form = $('#modal-form'), type = form.elements.type.value;
  const amountMinor = parseMoney(form.elements.amount.value);
  if (amountMinor === null || amountMinor <= 0) throw new Error('Introdu o sumă mai mare decât zero, cu cel mult două zecimale.');
  const participants = $$('[data-participant]:checked').map(input => {
    const quantity = Number($$('[data-quantity]').find(el => el.dataset.quantity === input.dataset.participant).value);
    if (type === 'quantity' && (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000)) throw new Error('Cantitățile trebuie să fie numere întregi între 1 și 10.000.');
    return { childId: input.dataset.participant, ...(type === 'quantity' ? { quantity } : {}) };
  });
  if (!participants.length) throw new Error('Alege cel puțin un participant.');
  return { type, amountMinor, participants };
}
function updateExpensePreview() {
  if (!['expense', 'edit-expense'].includes(modal?.type)) return;
  const type = $('#modal-form').elements.type.value;
  $('#expense-amount-label').textContent = { fixed: 'Suma pentru un copil (lei)', split: 'Suma totală (lei)', quantity: 'Prețul unei bucăți (lei)' }[type];
  $$('[data-quantity]').forEach(el => { el.hidden = type !== 'quantity'; el.disabled = el.hasAttribute('data-locked') || type !== 'quantity' || !!pending || saving || !$$('[data-participant]').find(p => p.dataset.participant === el.dataset.quantity).checked; });
  const all = $$('[data-participant]'), checked = all.filter(p => p.checked).length;
  $('#all-participants').checked = checked === all.length; $('#all-participants').indeterminate = checked > 0 && checked < all.length;
  try {
    const data = readExpense(), amounts = expensePreview(data.type, data.amountMinor, data.participants);
    $('#expense-preview').innerHTML = `<strong>${amounts.length} participanți · Total ${money(amounts.reduce((sum, p) => sum + p.amountMinor, 0))}</strong><details><summary>Verifică fiecare contribuție</summary><div class="preview-list">${sortChildren(state.children.filter(c => amounts.some(p => p.childId === c.id))).map(c => `<div class="row"><span>${esc(name(c))}</span><span class="amount">${money(amounts.find(p => p.childId === c.id).amountMinor)}</span></div>`).join('')}</div></details>`;
  } catch (error) { $('#expense-preview').textContent = error.message; }
}
function attachmentSection(entityType, entityId) {
  const entries = (state.attachments || []).filter(item => item.entityType === entityType && item.entityId === entityId);
  const list = entries.length ? `<div class="document-list">${entries.map(item => {
    const url = scopedUrl(`/api/attachments/${encodeURIComponent(item.id)}`);
    const download = scopedUrl(`/api/attachments/${encodeURIComponent(item.id)}?download=1`);
    const visibility = item.visibility === 'class' ? 'Vizibil părinților' : 'Doar casier și auditor';
    return `<article class="document"><div><strong>${esc(item.filename)}</strong><span class="caption">${fileSize(item.size)} · ${visibility}<br>${dateText(item.createdAt)} · ${esc(item.createdByLabel)}</span></div><div class="document-actions"><a href="${esc(url)}" target="_blank" rel="noopener">Deschide</a><a href="${esc(download)}" download="${esc(item.filename)}">Descarcă</a></div></article>`;
  }).join('')}</div>` : '<p class="caption">Nu există documente atașate.</p>';
  return `<section class="attachments"><h3>Documente justificative</h3>${list}${canWrite() ? `<button type="button" class="wide" data-action="attach-document" data-entity-type="${entityType}" data-id="${esc(entityId)}">+ Atașează documente</button>` : ''}</section>`;
}
function attachmentModal(entityType, entityId) {
  const label = entityType === 'expense' ? state.expenses.find(item => item.id === entityId)?.title
    : state.transactions.find(item => item.id === entityId)?.destination;
  if (!label) return;
  openModal('attachment', 'Atașează documente', `<p><strong>${esc(label)}</strong></p><label>Fișiere<input type="file" name="files" accept="application/pdf,image/jpeg,image/png,image/webp" multiple required></label><p class="caption">PDF, JPG, PNG sau WebP, maximum 10 MB pentru fiecare fișier și 25 de documente per înregistrare. După încărcare, documentele devin parte imuabilă a evidenței.</p><label>Cine poate vedea documentele<select name="visibility"><option value="internal">Doar casierul și auditorii</option><option value="class">Și părinții cu acces la clasă</option></select></label><p class="caption">Documentele pot conține date personale. Alege accesul părinților numai pentru acte potrivite transparenței clasei.</p><details class="context-help"><summary>${icon('help')}Cum sunt păstrate documentele?</summary>${simpleHelpFlow('documents', true)}</details>`, 'Încarcă documentele', { entityType, entityId, requestIds: new Map(), completed: new Set() });
}
function expenseDetails(id) {
  const e = state.expenses.find(e => e.id === id);
  const financing = (state.advances || []).filter(item => !item.reversed && item.expenseId === e.id);
  const financedMinor = financing.reduce((total, item) => total + item.amountMinor, 0);
  const outstandingMinor = financing.reduce((total, item) => total + item.outstandingMinor, 0);
  const afterPayment = e.latestPayment ? `<section class="summary expense-after-payment"><h3>După ultima plată</h3><p class="caption">${money(e.latestPayment.amountMinor)} către ${esc(e.latestPayment.destination)} · ${dateText(e.latestPayment.occurredAt)}</p><dl><div><dt>Strâns în fond de atunci</dt><dd>${money(e.collectedAfterLatestPaymentMinor || 0)}</dd></div><div><dt>Plătit direct de atunci</dt><dd>${money(e.directAfterLatestPaymentMinor || 0)}</dd></div><div><dt>Mai este de colectat</dt><dd><strong>${money(e.dueMinor || 0)}</strong></dd></div></dl><p class="caption">Prima sumă include numai încasările noi repartizate acestei cheltuieli după momentul plății.</p></section>` : '';
  openModal('expense-detail', e.title, `<p class="caption">${typeLabels[e.type]} · ${e.cancelled ? 'Anulată' : `${e.participantCount ?? e.contributions.length} participanți`}</p><div class="summary"><dl><div><dt>Total contribuții</dt><dd>${money(e.totalMinor)}</dd></div><div><dt>Încasat în fond</dt><dd>${money(e.collectedMinor)}</dd></div>${e.directMinor ? `<div><dt>Plătit direct beneficiarilor</dt><dd>${money(e.directMinor)}</dd></div>` : ''}${e.coveredMinor ? `<div><dt>Acoperit din fond</dt><dd>${money(e.coveredMinor)}</dd></div>` : ''}${e.adjustedMinor ? `<div><dt>Ajustări de rotunjire</dt><dd>${money(e.adjustedMinor)}</dd></div>` : ''}<div><dt>Bani dați mai departe</dt><dd>${money(e.paidOutMinor)}</dd></div>${financing.length ? `<div><dt>Avansat temporar fondului</dt><dd>${money(financedMinor)}</dd></div><div><dt>De restituit</dt><dd>${money(outstandingMinor)}</dd></div>` : ''}</dl></div>${afterPayment}<p>${e.dueDate ? `Termen: ${dateText(e.dueDate)}` : 'Fără termen de plată'}</p><p class="caption">Data cheltuielii: ${dateText(e.occurredAt)}</p>${e.comment ? `<p>${esc(e.comment)}</p>` : ''}<div class="preview-list">${sortChildren(state.children.filter(c => e.contributions.some(p => p.childId === c.id))).map(c => { const p = e.contributions.find(p => p.childId === c.id); const contribution = c.contributions.find(p => p.expenseId === e.id); return `<div class="row"><span>${esc(name(c))}${e.type === 'quantity' ? ` × ${p.quantity}` : ''}<small style="display:block">De achitat ${money(contribution?.remainingMinor || 0)}${contribution?.directMinor ? ` · Plătit direct ${money(contribution.directMinor)}` : ''}${contribution?.coveredMinor ? ` · Acoperit din fond ${money(contribution.coveredMinor)}` : ''}${contribution?.adjustedMinor ? ` · Ajustare ${money(contribution.adjustedMinor)}` : ''}</small></span><span class="amount">${money(p.amountMinor)}</span></div>`; }).join('')}</div>${attachmentSection('expense', e.id)}${e.cancelled || !canWrite() ? '' : `<div class="toolbar"><button type="button" data-action="edit-expense" data-id="${esc(e.id)}">Editează</button><button type="button" data-action="expense-payment" data-id="${esc(e.id)}">Înregistrează bani dați</button></div>${!e.collectedMinor && !e.directMinor && !e.coveredMinor && !e.adjustedMinor && !e.paidOutMinor && !financing.length ? `<button type="button" class="danger" data-action="cancel-expense" data-id="${esc(e.id)}">Anulează cheltuiala</button><p class="caption">Anularea este posibilă doar dacă nu mai există încasări sau plăți legate de cheltuială.</p>` : ''}`}`, null);
}
function paymentModal(expenseId = '') {
  openModal('payment', 'Bani dați mai departe', `${moneyField('Suma dată (lei)', 'amount')}${field('Cui ai dat banii', 'destination', '', 'required maxlength="200" placeholder="De exemplu: dirigintă, profesoară, fotograf"')}<label>Cheltuială asociată (opțional)<select name="expenseId"><option value="">Fără asociere</option>${state.expenses.filter(e => !e.cancelled).map(e => `<option value="${esc(e.id)}" ${e.id === expenseId ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select></label>${timestampField()}${comments()}<p class="caption">Suma scade din soldul fondului. Contribuțiile copiilor rămân neschimbate.</p><details class="context-help"><summary>${icon('help')}Cum apare în registru?</summary>${simpleHelpFlow('ledger', true)}</details>`, 'Înregistrează');
}
function directPaymentModal() {
  const c = child(), contributions = unpaid(c);
  if (!contributions.length) return;
  const latestDestination = state.transactions.find(item => item.type === 'direct_payment' && !item.reversed)?.destination || '';
  openModal('direct-payment', 'Plată directă beneficiarului', `<p><strong>${esc(name(c))}</strong></p><label>Contribuția<select name="expenseId">${contributions.map(item => `<option value="${esc(item.expenseId)}">${esc(item.title)} · de achitat ${money(item.remainingMinor)}</option>`).join('')}</select></label>${moneyField('Suma plătită direct (lei)', 'amount', decimal(contributions[0].remainingMinor))}${field('Cui i-au fost dați banii', 'destination', latestDestination, 'required maxlength="200" placeholder="De exemplu: doamna dirigintă"')}${timestampField()}${comments()}<div class="summary"><p><strong>Numerarul clasei nu se modifică.</strong></p><p class="caption">Suma stinge numai contribuția aleasă și apare separat în registru și rapoarte.</p></div><details class="context-help"><summary>${icon('help')}Cum funcționează plata directă?</summary>${simpleHelpFlow('directPayment', true)}</details>`, 'Înregistrează plata directă', { childId: c.id });
}
function updateDirectPaymentModal() {
  if (modal?.type !== 'direct-payment') return;
  const form = $('#modal-form'), c = state.children.find(item => item.id === modal.childId);
  const contribution = c?.contributions.find(item => item.expenseId === form.elements.expenseId.value);
  if (contribution) form.elements.amount.value = decimal(contribution.remainingMinor);
}
function fundAdvanceModal() {
  openModal('fund-advance', 'Sumă avansată fondului', `${moneyField('Suma avansată (lei)', 'amount')}${field('Cine a avansat banii', 'person', '', 'required maxlength="200" placeholder="De exemplu: numele casierului"')}<label>Cheltuială asociată (opțional)<select name="expenseId"><option value="">Fără asociere</option>${state.expenses.filter(e => !e.cancelled).map(e => `<option value="${esc(e.id)}">${esc(e.title)}</option>`).join('')}</select></label>${timestampField()}${comments()}<p class="caption">Suma intră temporar în numerarul clasei și apare separat ca datorie față de persoana care a avansat-o.</p><details class="context-help"><summary>${icon('help')}Cum funcționează suma avansată?</summary>${simpleHelpFlow('ledger', true)}</details>`, 'Înregistrează suma avansată');
}
function repayAdvanceModal(id) {
  const advance = (state.advances || []).find(item => item.id === id && !item.reversed);
  if (!advance || advance.outstandingMinor <= 0) return;
  openModal('repay-advance', 'Restituie suma avansată', `<p><strong>${esc(advance.person)}</strong></p><div class="summary"><dl><div><dt>Sumă avansată</dt><dd>${money(advance.amountMinor)}</dd></div><div><dt>De restituit acum</dt><dd>${money(advance.outstandingMinor)}</dd></div></dl></div>${moneyField('Suma restituită (lei)', 'amount', decimal(advance.outstandingMinor))}${timestampField()}${comments()}<p class="caption">Poți face și o restituire parțială. Numerarul și datoria clasei scad cu aceeași sumă.</p>`, 'Înregistrează restituirea', { advanceId: advance.id, outstandingMinor: advance.outstandingMinor });
}
function stopCollectionModal(expenseId) {
  const c = child();
  const contribution = c.contributions.find(item => item.expenseId === expenseId && item.remainingMinor > 0);
  const expense = state.expenses.find(item => item.id === expenseId && !item.cancelled);
  if (!contribution || !expense) return;
  const advances = (state.advances || []).filter(item => !item.reversed && item.outstandingMinor > 0
    && (!item.expenseId || item.expenseId === expense.id))
    .sort((a, b) => Number(b.expenseId === expense.id) - Number(a.expenseId === expense.id) || b.occurredAt.localeCompare(a.occurredAt));
  const canRecalculate = expense.type === 'split' && expense.contributions.length > 1
    && expense.collectedMinor === 0 && (expense.directMinor || 0) === 0 && (expense.adjustedMinor || 0) === 0 && (expense.coveredMinor || 0) === 0;
  const canRound = contribution.remainingMinor <= 100 && contribution.paidMinor > 0;
  if (!advances.length && !canRecalculate && !canRound) {
    toast('Nu există încă o opțiune disponibilă pentru închiderea acestei contribuții.'); return;
  }
  const methodOptions = `${canRound ? '<option value="rounding">Închide ca ajustare de rotunjire</option>' : ''}${advances.length ? '<option value="waive">Acoperă dintr-o sumă avansată</option>' : ''}${canRecalculate ? '<option value="recalculate">Recalculează pentru ceilalți</option>' : ''}`;
  const firstAdvance = advances[0];
  const advanceOptions = advances.map(item => {
    const linkedExpense = item.expenseId ? state.expenses.find(exp => exp.id === item.expenseId)?.title : 'fără cheltuială asociată';
    return `<option value="${esc(item.id)}">${esc(item.person)} · ${money(item.outstandingMinor)} · ${esc(linkedExpense || '')}</option>`;
  }).join('');
  const remainingParticipants = expense.contributions.filter(item => item.childId !== c.id);
  const recalculated = canRecalculate ? expensePreview('split', expense.amountMinor, remainingParticipants) : [];
  const recalculatedValues = [...new Set(recalculated.map(item => item.amountMinor))].map(money).join(' / ');
  openModal('stop-collection', `Nu mai colectez · ${contribution.title}`,
    `<p><strong>${esc(name(c))}</strong> · de achitat ${money(contribution.remainingMinor)}</p><label>Cum închizi contribuția?<select name="method">${methodOptions}</select></label>
    <section id="stop-rounding-info"><div class="summary"><strong>Închizi diferența de ${money(contribution.remainingMinor)}</strong><p>Numerarul rămâne neschimbat. Diferența apare separat ca ajustare de rotunjire în registru și rapoarte.</p></div></section>
    <section id="stop-waiver-fields"><label>Suma avansată<select name="advanceId">${advanceOptions}</select></label>${field('Suma acoperită (lei)', 'amount', firstAdvance ? decimal(Math.min(contribution.remainingMinor, firstAdvance.outstandingMinor)) : '', 'inputmode="decimal" autocomplete="off"')}<div class="summary"><p>Suma se scade din ceea ce fondul trebuie să restituie persoanei care a avansat banii. Numerarul nu se modifică.</p><p class="caption">Poți acoperi integral contribuția sau doar o parte. În rapoarte apare separat ca „Acoperită din fond”.</p></div></section>
    <section id="stop-recalculate-info"><div class="summary"><strong>${remainingParticipants.length} copii vor rămâne participanți</strong><p>Noua contribuție: ${esc(recalculatedValues || '—')}</p></div><p class="caption">Totalul cheltuielii rămâne ${money(expense.totalMinor)}. Copilul este exclus, iar suma se împarte din nou între ceilalți participanți.</p></section>
    <section id="stop-financial-fields">${timestampField()}${comments()}</section>
    <details class="context-help"><summary>${icon('help')}Cum funcționează această alegere?</summary>${stopCollectionHelpFlow(true, { canRecalculate, canCover: advances.length > 0, canRound })}</details>`,
    'Confirmă', { childId: c.id, expenseId: expense.id, contributionRemainingMinor: contribution.remainingMinor,
      advances, canRecalculate, canRound });
  updateStopCollectionModal();
}
function updateStopCollectionModal() {
  if (modal?.type !== 'stop-collection') return;
  const form = $('#modal-form'), method = form.elements.method.value, waive = method === 'waive', rounding = method === 'rounding';
  $('#stop-waiver-fields').hidden = !waive;
  $('#stop-rounding-info').hidden = !rounding;
  $('#stop-recalculate-info').hidden = method !== 'recalculate';
  $('#stop-financial-fields').hidden = method === 'recalculate';
  if (waive) {
    const advance = modal.advances.find(item => item.id === form.elements.advanceId.value);
    const maximum = Math.min(modal.contributionRemainingMinor, advance?.outstandingMinor || 0);
    if (parseMoney(form.elements.amount.value) > maximum) form.elements.amount.value = decimal(maximum);
  }
}
function creditModal() {
  const c = child(), defaults = automaticAllocations(unpaid(c), c.creditMinor);
  openModal('credit', 'Folosește avansul', `<p>${esc(name(c))} · Avans disponibil <strong>${money(c.creditMinor)}</strong></p>${unpaid(c).map(e => `<label class="allocation"><span>${esc(e.title)}<small style="display:block">De achitat ${money(e.remainingMinor)}</small></span><input name="credit-${esc(e.expenseId)}" data-credit-expense="${esc(e.expenseId)}" inputmode="decimal" value="${decimal(defaults.find(a => a.expenseId === e.expenseId)?.amountMinor || 0)}" aria-label="${esc(e.title)}: avans repartizat în lei"></label>`).join('')}<div id="credit-preview" class="summary" aria-live="polite"></div>${timestampField()}${comments()}<p class="caption">Se folosesc banii deja primiți. Soldul fondului nu se schimbă.</p><details class="context-help"><summary>${icon('help')}Cum funcționează avansul copilului?</summary>${simpleHelpFlow('credit', true)}</details>`, 'Repartizează avansul', { childId: c.id }); updateCreditPreview();
}
function readCredit() {
  const c = state.children.find(c => c.id === modal.childId);
  const allocations = $$('[data-credit-expense]').map(el => ({ expenseId: el.dataset.creditExpense, amountMinor: parseMoney(el.value) }));
  for (const a of allocations) if (a.amountMinor === null || a.amountMinor > (c.contributions.find(e => e.expenseId === a.expenseId)?.remainingMinor || 0)) throw new Error('Verifică sumele: fiecare repartizare trebuie să fie cel mult cât restanța.');
  const total = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  if (total <= 0 || total > c.creditMinor) throw new Error('Repartizează o sumă mai mare decât zero, cel mult cât avansul disponibil.');
  return { childId: c.id, allocations: allocations.filter(a => a.amountMinor > 0), total };
}
function updateCreditPreview() { try { const data = readCredit(); $('#credit-preview').textContent = `Acoperă ${money(data.total)} · Avans rămas ${money(state.children.find(c => c.id === modal.childId).creditMinor - data.total)}`; } catch (error) { $('#credit-preview').textContent = error.message; } }
function refundModal() {
  const c = child();
  openModal('refund', 'Restituie din avans', `<p>${esc(name(c))} · Avans disponibil <strong>${money(c.creditMinor)}</strong></p>${moneyField('Suma restituită (lei)', 'amount', decimal(c.creditMinor))}${timestampField()}${comments()}<p class="caption">Banii restituiți scad avansul copilului și soldul fondului.</p><details class="context-help"><summary>${icon('help')}Cum funcționează avansul copilului?</summary>${simpleHelpFlow('credit', true)}</details>`, 'Înregistrează restituirea', { childId: c.id });
}
function transactionDetails(id) {
  const t = state.transactions.find(t => t.id === id), c = state.children.find(c => c.id === t.childId);
  const partyLabel = t.type === 'direct_payment' ? 'Beneficiar' : ['fund_advance', 'advance_repayment', 'advance_waiver'].includes(t.type) ? 'Persoană' : 'Destinație';
  const documents = t.type === 'payment' ? attachmentSection('payment', t.id) : '';
  openModal('transaction-detail', labels[t.type], `<div class="summary"><strong class="total-number">${money(t.amountMinor)}</strong>${t.changeMinor ? `<p>Rest restituit: ${money(t.changeMinor)}</p>` : ''}</div>${c ? `<p>${esc(name(c))}</p>` : ''}${t.destination ? `<p>${partyLabel}: ${esc(t.destination)}</p>` : ''}${t.expenseId ? `<p>Cheltuială: ${esc(state.expenses.find(e => e.id === t.expenseId)?.title || '')}</p>` : ''}<p>Data și ora: ${dateText(t.occurredAt)}</p><p class="caption">Înregistrat: ${dateText(t.createdAt)}${t.actorLabel ? ` · ${esc(t.actorLabel)}` : ''}</p>${t.comment ? `<p>${esc(t.comment)}</p>` : ''}${t.allocations?.length ? `<h3>Repartizare</h3><div class="preview-list">${t.allocations.map(a => `<div class="row"><span>${esc(state.expenses.find(e => e.id === a.expenseId)?.title || 'Cheltuială')}</span><span>${money(a.amountMinor)}</span></div>`).join('')}</div>` : ''}${documents}${t.reversed ? '<p class="caption">Operațiune corectată. Înregistrarea originală rămâne în istoric.</p>' : t.type === 'reversal' ? '<p class="caption">Această înregistrare inversează efectele operațiunii corectate.</p>' : canWrite() ? `<button type="button" class="danger wide" style="margin-top:18px" data-action="reverse" data-id="${esc(t.id)}">Corectează prin anularea operațiunii</button>` : ''}`, null);
}
function positiveMoney(value) { const amount = parseMoney(value); if (amount === null || amount <= 0) throw new Error('Introdu o sumă mai mare decât zero, cu cel mult două zecimale.'); return amount; }
function metadata(form) {
  const input = form.elements.occurredAt?.value;
  if (form.elements.occurredAt && !input) throw new Error('Completează data și ora.');
  const occurredAt = input ? new Date(input) : null;
  if (occurredAt && Number.isNaN(occurredAt.getTime())) throw new Error('Data și ora nu sunt valide.');
  return { ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}), comment: form.elements.comment?.value.trim() || '' };
}
async function uploadAttachments(form) {
  const currentModal = modal;
  const files = [...(form.elements.files.files || [])];
  if (!files.length) { form.elements.files.reportValidity(); return; }
  if (files.length > 25) { $('#modal-error').textContent = 'Poți încărca cel mult 25 de documente odată.'; $('#modal-error').hidden = false; return; }
  const types = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
  for (const file of files) {
    if (!file.size || file.size > 10 * 1024 * 1024) { $('#modal-error').textContent = `${file.name}: fișierul trebuie să aibă maximum 10 MB.`; $('#modal-error').hidden = false; return; }
    const mimeType = file.type || types[file.name.split('.').pop()?.toLowerCase()];
    if (!Object.values(types).includes(mimeType)) { $('#modal-error').textContent = `${file.name}: folosește PDF, JPG, PNG sau WebP.`; $('#modal-error').hidden = false; return; }
  }
  saving = true; updateNotices(); $('#modal-error').hidden = true;
  try {
    for (const [index, file] of files.entries()) {
      const key = `${index}:${file.name}:${file.size}:${file.lastModified}`;
      if (currentModal.completed.has(key)) continue;
      if (!currentModal.requestIds.has(key)) currentModal.requestIds.set(key, crypto.randomUUID());
      const mimeType = file.type || types[file.name.split('.').pop()?.toLowerCase()];
      const collection = currentModal.entityType === 'expense' ? 'expenses' : 'payments';
      const response = await fetch(scopedUrl(`/api/${collection}/${encodeURIComponent(currentModal.entityId)}/attachments`), { method: 'POST', credentials: 'same-origin',
        cache: 'no-store', headers: { 'Content-Type': mimeType, 'X-Request-Id': currentModal.requestIds.get(key),
          'X-Expected-Revision': String(state.revision), 'X-Filename': encodeURIComponent(file.name),
          'X-Visibility': form.elements.visibility.value }, body: file, signal: AbortSignal.timeout(60000) });
      let result;
      try { result = await response.json(); } catch { throw new Error('Răspunsul serverului nu a putut fi citit.'); }
      if (!response.ok) { const error = new Error(result.error || 'Documentul nu a putut fi încărcat.'); error.status = response.status; throw error; }
      state = result.state;
      currentModal.completed.add(key);
    }
    modalDirty = false; closeModal(true); render(); toast(files.length === 1 ? 'Documentul a fost atașat.' : `${files.length} documente au fost atașate.`);
  } catch (error) {
    if (modal === currentModal) {
      $('#modal-error').textContent = error.name === 'TimeoutError' ? 'Încărcarea a durat prea mult. Încearcă din nou; documentele deja confirmate nu vor fi duplicate.' : error.message;
      $('#modal-error').hidden = false;
    }
  } finally { saving = false; updateNotices(); }
}
async function submitModal() {
  if (!modal || saving || pending || conflict) return;
  const form = $('#modal-form');
  if (!form.reportValidity()) return;
  if (modal.type === 'add-access') {
    saving = true; updateNotices();
    try {
      const result = await api('/api/auth/access', { method: 'POST', body: JSON.stringify({ code: form.elements.code.value.trim() }) });
      applySession(result); classroomId = result.classroomId;
      try { localStorage.setItem(classroomKey, classroomId); } catch { /* Selection remains in memory. */ }
      state = await api('/api/state'); tab = 'children'; childId = null; draft = null; search = ''; rosterScrollY = 0;
      closeModal(true, true); replaceNavigation(false); render(); toast('Accesul la clasă a fost adăugat.');
    } catch (error) { $('#modal-error').textContent = error.message; $('#modal-error').hidden = false; }
    finally { saving = false; updateNotices(); }
    return;
  }
  if (!canWrite()) return;
  if (modal.type === 'report') { await createReport(form); return; }
  if (modal.type === 'attachment') { await uploadAttachments(form); return; }
  if (modal.type === 'add-classroom') {
    const currentModal = modal;
    saving = true; updateNotices();
    try {
      const result = await api('/api/classrooms', { method: 'POST', body: JSON.stringify({ requestId: currentModal.requestId,
        schoolName: form.elements.schoolName.value.trim(), className: form.elements.className.value.trim(), schoolYear: form.elements.schoolYear.value.trim() }) });
      classrooms = result.classrooms; classroomId = result.classroom.id; state = result.state;
      try { localStorage.setItem(classroomKey, classroomId); } catch { /* Selection remains in memory. */ }
      tab = 'children'; childId = null; draft = null; closeModal(true, true); replaceNavigation(false); render(); toast('Clasa a fost creată.');
    } catch (error) { $('#modal-error').textContent = error.message; $('#modal-error').hidden = false; }
    finally { saving = false; updateNotices(); }
    return;
  }
  let path, body;
  try {
    if (modal.type === 'settings') {
      const openingBalanceMinor = parseMoney(form.elements.openingBalance.value);
      if (openingBalanceMinor === null) throw new Error('Soldul inițial trebuie să fie o sumă validă, zero sau mai mare.');
      path = '/api/settings'; body = { schoolName: form.elements.schoolName.value.trim(), className: form.elements.className.value.trim(), schoolYear: form.elements.schoolYear.value.trim(), openingBalanceMinor,
        paymentRevolutUrl: form.elements.paymentRevolutUrl.value.trim(), paymentBeneficiary: form.elements.paymentBeneficiary.value.trim(), paymentIban: form.elements.paymentIban.value.trim() };
      for (const [kind, fieldName] of [['school', 'schoolLogo'], ['class', 'classLogo']]) {
        if (Object.hasOwn(modal.logoChanges, kind)) body[fieldName] = modal.logoChanges[kind];
      }
    } else if (modal.type === 'add-child' || modal.type === 'edit-child') {
      path = modal.type === 'add-child' ? '/api/children' : `/api/children/${encodeURIComponent(modal.childId)}`;
      body = { firstName: form.elements.firstName.value.trim(), lastName: form.elements.lastName.value.trim(), ...(modal.type === 'edit-child' ? { active: form.elements.active.checked } : {}) };
    } else if (modal.type === 'contacts') {
      path = `/api/children/${encodeURIComponent(modal.childId)}/contacts`;
      const contacts = [1, 2].map(index => ({ label: form.elements[`contactLabel${index}`].value.trim(), phone: form.elements[`contactPhone${index}`].value.trim() }))
        .filter(contact => contact.label || contact.phone);
      if (contacts.some(contact => !contact.label || !contact.phone)) throw new Error('Completează atât numele, cât și numărul fiecărui contact.');
      body = { contacts };
    } else if (modal.type === 'bulk-children') { path = '/api/children/bulk'; body = { children: parseBulk(form.elements.childrenText.value) }; }
    else if (modal.type === 'expense' || modal.type === 'edit-expense') {
      path = modal.type === 'expense' ? '/api/expenses' : `/api/expenses/${encodeURIComponent(modal.expenseId)}`;
      body = { ...readExpense(), title: form.elements.title.value.trim(), dueDate: form.elements.dueDate.value || null, ...metadata(form) };
    }
    else if (modal.type === 'payment') { path = '/api/payments'; body = { amountMinor: positiveMoney(form.elements.amount.value), destination: form.elements.destination.value.trim(), ...(form.elements.expenseId.value ? { expenseId: form.elements.expenseId.value } : {}), ...metadata(form) }; }
    else if (modal.type === 'direct-payment') {
      const c = state.children.find(item => item.id === modal.childId);
      const contribution = c?.contributions.find(item => item.expenseId === form.elements.expenseId.value);
      const amountMinor = positiveMoney(form.elements.amount.value);
      if (!contribution || amountMinor > contribution.remainingMinor) throw new Error('Suma depășește contribuția rămasă de achitat.');
      path = '/api/direct-payments'; body = { childId: modal.childId, expenseId: contribution.expenseId,
        amountMinor, destination: form.elements.destination.value.trim(), ...metadata(form) };
    }
    else if (modal.type === 'fund-advance') { path = '/api/fund-advances'; body = { amountMinor: positiveMoney(form.elements.amount.value), person: form.elements.person.value.trim(), ...(form.elements.expenseId.value ? { expenseId: form.elements.expenseId.value } : {}), ...metadata(form) }; }
    else if (modal.type === 'repay-advance') {
      path = `/api/fund-advances/${encodeURIComponent(modal.advanceId)}/repayments`;
      const amountMinor = positiveMoney(form.elements.amount.value);
      if (amountMinor > modal.outstandingMinor) throw new Error('Suma depășește valoarea rămasă de restituit.');
      body = { amountMinor, ...metadata(form) };
    }
    else if (modal.type === 'stop-collection') {
      const method = form.elements.method.value;
      if (method === 'waive') {
        const advance = modal.advances.find(item => item.id === form.elements.advanceId.value);
        if (!advance) throw new Error('Alege suma avansată din care acoperi contribuția.');
        const amountMinor = positiveMoney(form.elements.amount.value);
        if (amountMinor > modal.contributionRemainingMinor) throw new Error('Suma depășește contribuția rămasă de achitat.');
        if (amountMinor > advance.outstandingMinor) throw new Error('Suma depășește avansul rămas de restituit.');
        path = `/api/fund-advances/${encodeURIComponent(advance.id)}/waivers`;
        body = { childId: modal.childId, expenseId: modal.expenseId, amountMinor, ...metadata(form) };
      } else if (method === 'rounding') {
        if (!modal.canRound) throw new Error('Diferența nu mai poate fi închisă prin ajustare de rotunjire.');
        path = '/api/rounding-adjustments';
        body = { childId: modal.childId, expenseId: modal.expenseId, ...metadata(form) };
      } else {
        const expense = state.expenses.find(item => item.id === modal.expenseId);
        if (!expense || !modal.canRecalculate) throw new Error('Cheltuiala nu mai poate fi recalculată.');
        path = `/api/expenses/${encodeURIComponent(expense.id)}`;
        body = { title: expense.title, type: expense.type, amountMinor: expense.amountMinor,
          participants: expense.contributions.filter(item => item.childId !== modal.childId)
            .map(item => ({ childId: item.childId, ...(expense.type === 'quantity' ? { quantity: item.quantity } : {}) })),
          occurredAt: expense.occurredAt, dueDate: expense.dueDate, comment: expense.comment };
      }
    }
    else if (modal.type === 'credit') { path = '/api/credit/apply'; const data = readCredit(); body = { childId: data.childId, allocations: data.allocations, ...metadata(form) }; }
    else if (modal.type === 'refund') {
      path = '/api/refunds'; const amountMinor = positiveMoney(form.elements.amount.value);
      if (amountMinor > state.children.find(c => c.id === modal.childId).creditMinor) throw new Error('Suma depășește avansul disponibil.');
      body = { childId: modal.childId, amountMinor, ...metadata(form) };
    } else if (modal.type === 'reverse') { path = `/api/transactions/${encodeURIComponent(modal.transactionId)}/reverse`; body = { comment: form.elements.comment.value.trim() }; if (!body.comment) throw new Error('Scrie motivul corecției.'); }
    else if (modal.type === 'cancel-expense') { path = `/api/expenses/${encodeURIComponent(modal.expenseId)}/cancel`; body = { comment: form.elements.comment.value.trim() }; }
    else return;
    await mutate(path, body, 'Operațiunea a fost salvată.');
  } catch (error) { $('#modal-error').textContent = error.message; $('#modal-error').hidden = false; }
}
async function submitCollection() {
  if (!canWrite()) return;
  if (saving || pending || conflict) return;
  const result = collectionResult(child(), draft);
  const credit = creditSettlement(child(), draft, result);
  if (result.error || (result.netMinor <= 0 && !credit)) return;
  const occurredAt = new Date(draft.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) { $('#collection-error').textContent = 'Completează data și ora încasării.'; $('#collection-error').hidden = false; return; }
  if (result.netMinor === 0 && credit) {
    await mutate('/api/credit/apply', { childId, allocations: credit.allocations, occurredAt: occurredAt.toISOString(), comment: draft.comment.trim() },
      `Avans repartizat pentru ${name(child())}: ${money(credit.amountMinor)}.`);
    return;
  }
  const settlement = credit || smallSettlement(child(), draft, result);
  const settlementType = credit ? 'credit' : draft.settlement;
  const settlementBody = settlement && settlementType !== 'none' ? { settlement: { type: settlementType, allocations: settlement.allocations } } : {};
  const settlementMessage = settlementBody.settlement ? (settlementType === 'credit'
    ? ` Din avans au fost folosiți ${money(settlement.amountMinor)}.`
    : ` Diferența de ${money(settlement.amountMinor)} a fost închisă ca ajustare de rotunjire.`) : '';
  await mutate('/api/collections', { childId, receivedMinor: result.receivedMinor, changeMinor: result.changeMinor, allocations: result.allocations,
    ...settlementBody, occurredAt: occurredAt.toISOString(), comment: draft.comment.trim() },
  `Încasare salvată pentru ${name(child())}: ${money(result.netMinor)} în fond.${result.changeMinor ? ` Dă rest ${money(result.changeMinor)}.` : result.creditMinor ? ` Avans nou: ${money(result.creditMinor)}.` : ''}${settlementMessage}`);
}
async function mutate(path, body, successMessage) {
  if (!canWrite()) { toast('Acest dispozitiv are acces doar pentru citire.'); return; }
  if (!navigator.onLine || disconnected) { toast('Este nevoie de conexiune pentru a salva.'); return; }
  if (saving || pending || conflict) return;
  const requestId = crypto.randomUUID();
  setPending({ classroomId, path, body: { ...body, requestId, expectedRevision: state.revision }, successMessage });
  await sendPending();
}
async function sendPending() {
  if (!pending || saving) return;
  saving = true; updateNotices();
  try {
    const request = pending;
    if (request.classroomId && request.classroomId !== classroomId) {
      throw new Error('Operațiunea în așteptare aparține altei clase. Reîncarcă aplicația pentru a o verifica.');
    }
    const result = await api(request.path, { method: 'POST', body: JSON.stringify(request.body) });
    setPending(null); conflict = false; dirty = false; modalDirty = false;
    rememberRosterScroll();
    state = result.state;
    if (request.path === '/api/settings') applySession(await api('/api/auth/me'));
    closeModal(true);
    if (request.path === '/api/collections') { childId = null; draft = null; tab = 'children'; replaceNavigation(false); }
    else if (childId && child()) resetDraft(child());
    render(); restoreScreenScroll(); toast(request.successMessage || 'Salvare confirmată.');
  } catch (error) {
    if (error.status === 401) { closeModal(true); renderGate('Accesul dispozitivului a expirat. Activează-l din nou cu o invitație pentru a verifica salvarea în așteptare.'); }
    else if (error.status === 409 && error.message.includes('Datele s-au schimbat')) { setPending(null); conflict = true; }
    else if (error.status && error.status < 500) {
      setPending(null);
      if ($('#dialog').open) { $('#modal-error').textContent = error.message; $('#modal-error').hidden = false; }
      else { toast(error.message); }
    }
    // Network failures and server failures may follow a committed write. Keep its key for retry.
  } finally { saving = false; updateNotices(); }
}
async function refresh(review = false) {
  if (saving || pending || (!review && busy())) return;
  try {
    state = await api('/api/state'); conflict = false;
    render();
    if (['expense', 'edit-expense'].includes(modal?.type)) updateExpensePreview();
    if (modal?.type === 'credit') updateCreditPreview();
    if ($('#dialog').open) { $('#modal-error').textContent = review ? 'Date actualizate. Verifică sumele și apasă din nou butonul de salvare.' : ''; $('#modal-error').hidden = !review; }
    else if (review) toast('Date actualizate. Verifică sumele înainte să salvezi.');
  } catch (error) { if (error.status === 401 && !busy()) renderGate('Activează din nou acest dispozitiv.'); else toast('Datele nu au putut fi actualizate. Reîncearcă atunci când conexiunea revine.'); }
  updateNotices();
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (button.dataset.copyPayment) { await copyPaymentDetail(button.dataset.copyPayment); return; }
  if (action && writeActions.has(action) && !canWrite()) { toast('Acest dispozitiv are acces doar pentru citire.'); return; }
  if (action === 'reconnect') { try { await api('/api/health'); if ($('#dialog').open && !pending && !conflict) $('#modal-error').hidden = true; updateNotices(); toast('Conexiunea este disponibilă.'); if (state && !busy()) await refresh(); } catch { updateNotices(); } return; }
  if (action === 'retry') { await sendPending(); return; }
  if (action === 'review') { await refresh(true); return; }
  if (action === 'close-modal') { closeModal(); return; }
  if (action === 'remove-logo' && modal?.type === 'settings') {
    modal.logoChanges[button.dataset.logoKind] = null; modalDirty = true;
    updateLogoPreview(button.dataset.logoKind, null); return;
  }
  if (saving || pending) { if (button.type !== 'submit') toast('Verifică mai întâi salvarea în așteptare.'); return; }
  if (action === 'help') { helpModal(button.dataset.helpTopic || 'overview'); return; }
  if (button.dataset.target) {
    draft.target = button.dataset.target; draft.manual = false; draft.round = null; draft.settlement = 'none'; draft.useCredit = false; draft.cashBeforeCredit = null;
    draft.amount = decimal(draft.target === 'all' ? child().dueMinor : unpaid(child()).find(e => e.expenseId === draft.target).remainingMinor);
    dirty = true; updateCollection(); return;
  }
  if (button.dataset.round) {
    const base = draft.target === 'all' ? child().dueMinor : unpaid(child()).find(e => e.expenseId === draft.target)?.remainingMinor || 0;
    draft.round = Number(button.dataset.round); draft.amount = decimal(roundUp(base, draft.round)); draft.useCredit = false; draft.cashBeforeCredit = null; dirty = true; updateCollection(); return;
  }
  if (button.dataset.useCredit !== undefined) {
    const c = child();
    if (draft.useCredit) {
      draft.useCredit = false; draft.amount = draft.cashBeforeCredit || decimal(draft.target === 'all' ? c.dueMinor : unpaid(c).find(e => e.expenseId === draft.target)?.remainingMinor || 0); draft.cashBeforeCredit = null;
    } else {
      const base = draft.target === 'all' ? c.dueMinor : unpaid(c).find(e => e.expenseId === draft.target)?.remainingMinor || 0;
      draft.cashBeforeCredit = draft.amount; draft.useCredit = true; draft.manual = false; draft.round = null; draft.settlement = 'none';
      draft.amount = decimal(Math.max(0, base - Math.min(c.creditMinor, base)));
    }
    dirty = true; updateCollection(); return;
  }
  if (button.dataset.excess) { draft.excess = button.dataset.excess; dirty = true; updateCollection(); return; }
  if (button.dataset.tab) {
    if (!canLeave()) return;
    showScreen(button.dataset.tab); return;
  }
  if (button.dataset.child) {
    if (!canLeave()) return;
    showScreen('children', button.dataset.child); return;
  }
  if (button.dataset.expense) { if (canLeave()) expenseDetails(button.dataset.expense); return; }
  if (button.dataset.transaction) { if (canLeave()) { if (childId) { resetDraft(child()); updateCollection(); } transactionDetails(button.dataset.transaction); } return; }
  if (!action) return;
  if (action === 'reload') { location.reload(); return; }
  if (action === 'refresh') { await refresh(); return; }
  if (!state || !canLeave()) return;
  if (childId) { resetDraft(child()); if ($('#collection-form')) updateCollection(); }
  switch (action) {
    case 'back':
      if (navigationIndex > 0) history.back();
      else showScreen('children', null, { push: false });
      break;
    case 'settings': settingsModal(); break;
    case 'add-access': accessModal(); break;
    case 'add-classroom': classroomModal(); break;
    case 'add-child': childModal(); break;
    case 'edit-child': childModal(true); break;
    case 'edit-contacts': contactsModal(); break;
    case 'edit-reminder-contact': contactsModal(button.dataset.id); break;
    case 'whatsapp-reminders': remindersModal(); break;
    case 'create-child-report': reportModal('child', null, childId); break;
    case 'bulk-children': bulkModal(); break;
    case 'add-expense': expenseModal(); break;
    case 'edit-expense': expenseModal(state.expenses.find(expense => expense.id === button.dataset.id)); break;
    case 'payment': paymentModal(); break;
    case 'direct-payment': directPaymentModal(); break;
    case 'expense-payment': paymentModal(button.dataset.id); break;
    case 'attach-document': attachmentModal(button.dataset.entityType, button.dataset.id); break;
    case 'fund-advance': fundAdvanceModal(); break;
    case 'repay-advance': repayAdvanceModal(button.dataset.id); break;
    case 'stop-collection': stopCollectionModal(button.dataset.id); break;
    case 'apply-credit': creditModal(); break;
    case 'refund': refundModal(); break;
    case 'report-class': reportModal('class'); break;
    case 'report-matrix': reportModal('matrix'); break;
    case 'report-expense': reportModal('expense'); break;
    case 'report-child': reportModal('child'); break;
    case 'view-report': viewReport(button.dataset.id); break;
    case 'share-report': await shareReport(button.dataset.id); break;
    case 'share-child-text': await shareChildText(button.dataset.id); break;
    case 'share-child-report': await shareChildReport(button.dataset.id); break;
    case 'replace-report': {
      const report = (state.reports || []).find(item => item.id === button.dataset.id);
      if (report) reportModal(report.type, report.id);
      break;
    }
    case 'reverse': {
      const transaction = state.transactions.find(t => t.id === button.dataset.id);
      openModal('reverse', 'Corectează operațiunea', `<p>Se inversează efectele operațiunii „${labels[transaction.type]}” de ${money(transaction.amountMinor)}. Istoricul se păstrează.</p><label>Motivul corecției<textarea name="comment" required maxlength="2000"></textarea></label><p class="caption">Pentru o sumă greșită, anulează operațiunea și înregistrează apoi suma corectă. O încasare al cărei avans a fost folosit poate necesita întâi corectarea operațiunilor ulterioare.</p>`, 'Confirmă corecția', { transactionId: transaction.id }); break;
    }
    case 'cancel-expense': openModal('cancel-expense', 'Anulează cheltuiala', '<p>Contribuțiile acestei cheltuieli nu vor mai fi datorate. Cheltuiala rămâne vizibilă în istoric.</p><label>Motiv (opțional)<textarea name="comment" maxlength="2000"></textarea></label>', 'Anulează cheltuiala', { expenseId: button.dataset.id }); break;
    case 'logout':
      if (!confirm('Deconectezi acest dispozitiv? Pentru a reveni, vei avea nevoie de un cod cu o activare disponibilă.')) return;
      try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); closeModal(true); device = null; state = null; renderGate(); } catch (error) { toast(error.message); }
      break;
  }
});
document.addEventListener('input', event => {
  const input = event.target;
  if (input.id === 'child-search') { search = input.value; renderRosterList(); return; }
  if (input.id === 'small-settlement-choice') { draft.settlement = input.value; dirty = true; updateCollection(); return; }
  if (input.id === 'manual' || input.id === 'all-participants') return;
  if (input.closest('#modal-form')) {
    if (modal?.type.endsWith('-detail')) return;
    modalDirty = true;
    if (['expense', 'edit-expense'].includes(modal?.type)) updateExpensePreview();
    if (modal?.type === 'credit') updateCreditPreview();
    if (modal?.type === 'bulk-children') {
      try { const children = parseBulk(input.value); $('#bulk-preview').innerHTML = `<strong>${children.length} copii de adăugat</strong>${children.map(c => `<div>${esc(name(c))}</div>`).join('')}`; } catch (error) { $('#bulk-preview').textContent = error.message; }
    }
    return;
  }
  if (input.closest('#collection-form')) {
    dirty = true;
    if (input.id === 'received') { draft.amount = input.value; draft.round = null; draft.settlement = 'none'; draft.useCredit = false; draft.cashBeforeCredit = null; }
    if (input.dataset.allocation) { draft.allocations[input.dataset.allocation] = input.value; draft.settlement = 'none'; }
    if (input.id === 'collection-date') draft.occurredAt = input.value;
    if (input.id === 'collection-comment') draft.comment = input.value;
    updateCollection();
  }
});
document.addEventListener('change', async event => {
  const input = event.target;
  if (input.id === 'classroom-selector') {
    const previous = classroomId;
    if (!canLeave()) { input.value = previous; return; }
    classroomId = input.value;
    try {
      state = await api('/api/state');
      try { localStorage.setItem(classroomKey, classroomId); } catch { /* Selection remains in memory. */ }
      tab = 'children'; childId = null; draft = null; search = ''; rosterScrollY = 0;
      replaceNavigation(false); render(); restoreScreenScroll();
    } catch (error) {
      classroomId = previous; input.value = previous;
      toast(error.message || 'Clasa nu a putut fi încărcată.');
    }
    return;
  }
  if (input.dataset.logoInput && modal?.type === 'settings') {
    const kind = input.dataset.logoInput, currentModal = modal;
    currentModal.logoProcessing = (currentModal.logoProcessing || 0) + 1; updateNotices();
    try {
      const data = await logoDataUrl(input.files?.[0]);
      if (modal !== currentModal) return;
      currentModal.logoChanges[kind] = data; modalDirty = true;
      updateLogoPreview(kind, data);
      $('#modal-error').hidden = true;
    } catch (error) { $('#modal-error').textContent = error.message; $('#modal-error').hidden = false; }
    finally { if (modal === currentModal) { currentModal.logoProcessing -= 1; updateNotices(); } }
    input.value = ''; return;
  }
  if (input.name === 'debtFilter') { modalDirty = true; updateChildReportOptions(); return; }
  if (modal?.type === 'stop-collection' && ['method', 'advanceId'].includes(input.name)) { updateStopCollectionModal(); return; }
  if (modal?.type === 'direct-payment' && input.name === 'expenseId') { updateDirectPaymentModal(); return; }
  if (input.id === 'show-archived') { showArchived = input.checked; renderRosterList(); }
  if (input.id === 'manual') {
    const result = collectionResult(child(), draft);
    if (input.checked) draft.allocations = Object.fromEntries(unpaid(child()).map(e => [e.expenseId, decimal(result.allocations?.find(a => a.expenseId === e.expenseId)?.amountMinor || 0)]));
    draft.manual = input.checked; draft.round = null; draft.settlement = 'none'; draft.useCredit = false; draft.cashBeforeCredit = null; dirty = true; updateCollection();
  }
  if (input.id === 'all-participants') { $$('[data-participant]').forEach(el => { el.checked = input.checked; }); modalDirty = true; updateExpensePreview(); }
  if (input.dataset.participant || input.name === 'type') updateExpensePreview();
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  if (event.target.id === 'modal-form') { await submitModal(); return; }
  if (event.target.id === 'collection-form') { await submitCollection(); return; }
  if (event.target.id === 'invite-form') {
    const form = event.target, button = form.querySelector('button'); if (button.disabled) return; button.disabled = true;
    try {
      const result = await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code: form.elements.code.value.trim(), ...(form.elements.label.value.trim() ? { label: form.elements.label.value.trim() } : {}) }) });
      inviteCode = '';
      applySession(await api('/api/auth/me'));
      state = await api('/api/state'); render();
    } catch (error) { $('#invite-error').textContent = error.message; }
    finally { button.disabled = false; }
  }
});
$('#dialog').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
window.addEventListener('popstate', async event => {
  const destination = event.state?.[navigationKey];
  if (restoringNavigation) { restoringNavigation = false; return; }
  if (!destination) return;
  if (!state) {
    navigationIndex = destination.index; navigationOverlay = false;
    closeModal(true, true);
    return;
  }
  const delta = navigationIndex - destination.index;
  if (!canLeave()) {
    restoringNavigation = true;
    history.go(delta || 1);
    return;
  }
  navigationIndex = destination.index;
  closeModal(true, true);
  if (destination.classroomId && destination.classroomId !== classroomId
    && classrooms.some(item => item.id === destination.classroomId)) {
    classroomId = destination.classroomId;
    try {
      state = await api('/api/state');
      try { localStorage.setItem(classroomKey, classroomId); } catch { /* Selection remains in memory. */ }
      search = ''; rosterScrollY = 0;
    } catch (error) {
      toast(error.message || 'Clasa nu a putut fi încărcată.');
      return;
    }
  }
  // A modal entry cannot be recreated after it has been dismissed. Forward
  // navigation therefore restores its underlying screen instead.
  showScreen(destination.tab, destination.childId, { push: false });
});
window.addEventListener('beforeunload', event => { if (busy()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', () => { disconnected = false; updateNotices(); if (!busy()) refresh(); });
window.addEventListener('offline', updateNotices);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state && !busy()) refresh(); });
installUpdates({ appName: 'Casierul clasei', message: 'Aplicația a fost actualizată.', toast, isBusy: busy });
async function boot() {
  updateNotices();
  if (inviteCode) { renderGate(); return; }
  try {
    applySession(await api('/api/auth/me')); state = await api('/api/state');
    showScreen(tab, childId, { push: false });
  }
  catch (error) {
    if (error.status === 401) renderGate();
    else { $('#main').innerHTML = '<div class="empty"><h1>Registrul nu este disponibil</h1><p>Verifică conexiunea și încearcă din nou. Nicio operațiune nouă nu a fost înregistrată de pe acest ecran.</p><button class="primary wide" data-action="reload">Reîncarcă</button></div>'; updateNotices(); }
  }
}
boot();
