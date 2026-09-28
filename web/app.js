import { installUpdates } from '/pwa-update.js';
import { name, money, decimal, parseMoney, sortChildren, unpaid, roundUp, automaticAllocations, collectionResult, expensePreview } from './helpers.mjs';

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
const labels = { collection: 'Încasare', payment: 'Bani dați', credit_apply: 'Avans repartizat', refund: 'Avans restituit', reversal: 'Corecție' };
const typeLabels = { fixed: 'Sumă fixă / copil', split: 'Total împărțit', quantity: 'Cantitate × preț' };
const reportTypeLabels = { class: 'Situația clasei', matrix: 'Raport exhaustiv', expense: 'Situația unei cheltuieli', child: 'Fișa individuală' };
const pendingKey = 'casierul.pending.v1';
const navigationKey = 'casierulNavigation';
const storedNavigation = history.state?.[navigationKey];
let state = null, device = null, tab = 'children', childId = null, draft = null, dirty = false;
let modal = null, modalDirty = false, saving = false, conflict = false, disconnected = false, pending = null;
let navigationIndex = Number.isSafeInteger(storedNavigation?.index) ? storedNavigation.index : 0;
let navigationOverlay = false, restoringNavigation = false;
let toastTimer, inviteCode = new URL(location.href).searchParams.get('invite') || '';
let search = '', showArchived = false, rosterScrollY = 0;
if (['children', 'expenses', 'ledger', 'reports'].includes(storedNavigation?.tab)) tab = storedNavigation.tab;
if (tab === 'children' && typeof storedNavigation?.childId === 'string') childId = storedNavigation.childId;
try { pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); } catch { /* Browser storage can be unavailable. */ }
const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete('invite');
history.replaceState({ ...(history.state || {}), [navigationKey]: { index: navigationIndex, tab, childId, overlay: false } }, '', cleanUrl);
const busy = () => dirty || modalDirty || saving || !!pending;
const child = () => state?.children.find(c => c.id === childId);
const activeChildren = () => sortChildren(state.children.filter(c => c.active));

function navigationState(overlay = navigationOverlay) {
  return { index: navigationIndex, tab, childId, overlay };
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
  childId = tab === 'children' && state?.children.some(c => c.id === nextChildId) ? nextChildId : null;
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
  try { response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(20000) }); }
  catch { disconnected = true; updateNotices(); const error = new Error('Conexiunea nu a putut fi confirmată.'); error.network = true; throw error; }
  let data;
  try { data = await response.json(); } catch { const error = new Error('Răspunsul serverului nu a putut fi citit.'); error.network = true; throw error; }
  disconnected = false;
  if (!response.ok) { const error = new Error(data.error || 'Operațiunea nu a putut fi efectuată.'); error.status = response.status; throw error; }
  return data;
}
function updateNotices() {
  const connection = $('#connection');
  connection.hidden = navigator.onLine && !disconnected;
  connection.innerHTML = 'Conexiune indisponibilă. Poți consulta datele încărcate; salvarea necesită internet.<br><button data-action="reconnect">Verifică conexiunea</button>';
  const notice = $('#pending-notice');
  notice.hidden = !pending && !conflict;
  if (pending) notice.innerHTML = `<strong>${saving ? 'Se confirmă salvarea…' : 'Salvarea așteaptă confirmarea serverului.'}</strong><div>Nu înregistra încă o dată aceeași operațiune. Reîncercarea verifică aceeași înregistrare.</div><button data-action="retry" ${saving ? 'disabled' : ''}>Verifică / reîncearcă</button>`;
  else if (conflict) notice.innerHTML = '<strong>Registrul s-a schimbat pe alt dispozitiv.</strong><div>Încarcă datele actuale și verifică sumele înainte să salvezi din nou.</div><button data-action="review">Actualizează și verifică</button>';
  $('#modal-submit').disabled = saving || !!pending || conflict || !navigator.onLine || disconnected;
  if ($('#collection-save')) $('#collection-save').disabled = saving || !!pending || conflict || !navigator.onLine || disconnected || !!collectionResult(child(), draft).error || collectionResult(child(), draft).netMinor <= 0;
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
  if ($('#dialog').open) $('#dialog').close();
  modal = null; modalDirty = false;
  if (navigationOverlay && !fromHistory) history.back();
  return true;
}
function openModal(type, title, content, submit = 'Salvează', extra = {}) {
  const alreadyOpen = $('#dialog').open;
  modal = { type, ...extra }; modalDirty = false;
  $('#dialog-title').textContent = title; $('#modal-content').innerHTML = content;
  $('#modal-error').hidden = true; $('#modal-submit').textContent = submit; $('#modal-submit').hidden = !submit;
  if (!alreadyOpen) { pushNavigation(true); $('#dialog').showModal(); }
  else replaceNavigation(true);
  updateNotices();
}
function renderGate(message = '') {
  state = null; $('.app').classList.remove('collecting'); $('#tabs').hidden = true; $('#settings-button').hidden = true; $('#class-label').textContent = 'Fondul clasei, la îndemână';
  $('#main').innerHTML = `<div class="empty"><h1>Registrul tău de clasă</h1><p>Activează acest dispozitiv folosind o invitație din consola ta PWA.</p></div><form id="invite-form">${field('Cod de invitație', 'code', inviteCode, 'required autocomplete="off" autocapitalize="none" spellcheck="false"')}${field('Numele dispozitivului (opțional)', 'label', '', 'maxlength="120" placeholder="De exemplu: telefonul meu"')}<p id="invite-error" class="error" role="alert">${esc(message)}</p><button class="primary wide" type="submit">Activează dispozitivul</button></form>`;
  updateNotices();
}
function render() {
  if (!state) return;
  const collecting = tab === 'children' && !!childId && !!child();
  $('.app').classList.toggle('collecting', collecting);
  $('#class-label').textContent = [state.settings.schoolName, state.settings.className, state.settings.schoolYear].filter(Boolean).join(' · ') || 'Configurează clasa pentru a începe';
  $('#settings-button').hidden = false; $('#tabs').hidden = collecting;
  $$('[data-tab]').forEach(button => { if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  if (!state.settings.className) {
    $('#main').innerHTML = '<div class="empty"><h1>Bine ai venit!</h1><p>Începe cu școala și clasa, apoi adaugă copiii și prima cheltuială.</p><button class="primary wide" data-action="settings">Configurează clasa</button></div>';
  } else if (tab === 'children') childId && child() ? renderChild() : renderRoster();
  else if (tab === 'expenses') renderExpenses();
  else if (tab === 'ledger') renderLedger();
  else renderReports();
  updateNotices();
}
function renderRoster() {
  $('#main').innerHTML = `<h1>Alege copilul</h1><div class="caption">În ordine alfabetică, după numele de familie</div><div class="toolbar"><button data-action="add-child">+ Copil</button><button data-action="bulk-children">Adaugă lista</button></div>${state.children.length ? `<label class="caption" for="child-search">Caută un copil</label><input id="child-search" type="search" placeholder="Nume sau prenume" value="${esc(search)}" autocomplete="off"><div id="roster-list" class="children"></div><label class="check caption"><input id="show-archived" type="checkbox" ${showArchived ? 'checked' : ''}>Arată și copiii arhivați</label>` : '<div class="empty"><h2>Prima dată, copiii</h2><p>Adaugă un copil sau lipește întreaga listă. Apoi creează o cheltuială în fila Cheltuieli.</p></div>'}`;
  renderRosterList();
}
function renderRosterList() {
  if (!$('#roster-list')) return;
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('ro');
  const children = sortChildren(state.children).filter(c => (showArchived || c.active) && normalize(name(c)).includes(normalize(search)));
  $('#roster-list').innerHTML = children.length ? children.map(c => `<button class="child" data-child="${esc(c.id)}"><span><span class="child-name">${esc(c.lastName)}</span><span class="caption">${esc(c.firstName)}${c.active ? '' : ' · Arhivat'}</span></span><span class="child-side"><span class="amount">${c.dueMinor ? money(c.dueMinor) : 'Achitat'}</span>${c.creditMinor ? `<span class="caption">Avans ${money(c.creditMinor)}</span>` : ''}</span></button>`).join('') : '<p class="caption">Niciun copil pentru această căutare.</p>';
}
function resetDraft(c) {
  draft = { target: 'all', amount: c.dueMinor ? decimal(c.dueMinor) : '', round: null, excess: 'change', manual: false, allocations: {}, occurredAt: localNow(), comment: '' };
  dirty = false;
}
function renderChild() {
  const c = child(); if (!draft) resetDraft(c);
  const contributions = unpaid(c);
  $('#main').innerHTML = `<button class="back" data-action="back">‹ Copii</button><div class="row"><h1>${esc(name(c))}</h1><button data-action="edit-child" aria-label="Editează copilul">Editează</button></div><div class="caption">Încasare rapidă${c.active ? '' : ' · Copil arhivat'}</div>${c.creditMinor ? `<div class="summary"><div class="row"><span>Avans disponibil</span><strong>${money(c.creditMinor)}</strong></div><div class="toolbar"><button data-action="apply-credit" ${c.dueMinor ? '' : 'disabled'}>Folosește avansul</button><button data-action="refund">Restituie</button></div></div>` : ''}
  <form id="collection-form">
  ${c.dueMinor ? `<button type="button" class="choice total-choice" data-target="all" aria-pressed="true"><span>Total de achitat</span><span class="total-number">${money(c.dueMinor)}</span></button><div class="section-label">Sau doar o cheltuială</div><div class="stack">${contributions.map(e => `<button type="button" class="choice" data-target="${esc(e.expenseId)}" aria-pressed="false"><span>${esc(e.title)}<span class="caption" style="display:block">${e.dueDate ? `Termen ${dateText(e.dueDate)}` : 'Fără termen'}</span></span><span class="choice-money">${money(e.remainingMinor)}</span></button>`).join('')}</div><div class="section-label" id="round-label">Rotunjește totalul în sus</div><div class="rounds" id="rounds">${[10, 50, 100].map(unit => `<button type="button" class="round" data-round="${unit}" aria-pressed="false"><span class="round-value"></span><span class="caption">multiplu de ${unit}</span></button>`).join('')}</div>` : '<div class="empty"><h2>Totul este achitat.</h2><p>Poți primi bani în avans. Introdu suma și alege „Păstrez în avans”.</p></div>'}
  <section class="collection-dock" aria-label="Confirmarea încasării"><div class="collection-dock-amount"><label for="received">Primesc</label><div class="money-input"><input id="received" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(draft.amount)}" aria-label="Suma primită în lei" data-write-control><span>lei</span></div></div>
  <fieldset class="excess" id="excess" hidden><legend id="excess-label"></legend><div class="switch"><button type="button" data-excess="change" aria-pressed="true">Dau rest</button><button type="button" data-excess="credit" aria-pressed="false">Păstrez în avans</button></div></fieldset>
  <p class="error" id="collection-error" role="alert" hidden></p><button type="submit" class="primary wide" id="collection-save">Înregistrează încasarea</button></section>
  <div class="summary" id="collection-summary" aria-live="polite"></div>
  <details id="allocation-details" ${draft.manual ? 'open' : ''}><summary>Ajustează repartizarea</summary><label class="check"><input type="checkbox" id="manual" ${draft.manual ? 'checked' : ''} data-write-control>Aleg manual sumele pentru cheltuieli</label>${contributions.map(e => `<label class="allocation"><span>${esc(e.title)}<small style="display:block">Restant ${money(e.remainingMinor)}</small></span><input inputmode="decimal" aria-label="${esc(e.title)}: repartizare în lei" data-allocation="${esc(e.expenseId)}" value="0" data-write-control></label>`).join('')}<p class="caption">Repartizarea automată acoperă mai întâi termenele cele mai apropiate. O cheltuială selectată primește doar suma datorată; diferența rămâne rest sau avans.</p></details>
  <details><summary>Data, ora și comentarii</summary><label>Data și ora<input id="collection-date" type="datetime-local" value="${esc(draft.occurredAt)}" required data-write-control></label><label>Comentarii<textarea id="collection-comment" maxlength="2000" data-write-control>${esc(draft.comment)}</textarea></label></details></form>
  <details class="history"><summary>Istoricul copilului</summary><div class="stack">${transactionRows(state.transactions.filter(t => t.childId === c.id))}</div></details>`;
  updateCollection();
}
function updateCollection() {
  if (!$('#collection-form') || !draft) return;
  const c = child(), result = collectionResult(c, draft);
  const base = draft.target === 'all' ? c.dueMinor : c.contributions.find(e => e.expenseId === draft.target)?.remainingMinor || 0;
  $$('[data-target]').forEach(b => b.setAttribute('aria-pressed', String(!draft.manual && b.dataset.target === draft.target)));
  $$('[data-round]').forEach(b => { b.querySelector('.round-value').textContent = money(roundUp(base, Number(b.dataset.round))); b.setAttribute('aria-pressed', String(draft.round === Number(b.dataset.round))); });
  if ($('#rounds')) { $('#rounds').hidden = draft.manual; $('#round-label').hidden = draft.manual; $('#round-label').textContent = draft.target === 'all' ? 'Rotunjește totalul în sus' : 'Rotunjește cheltuiala în sus'; }
  $$('[data-excess]').forEach(b => {
    b.setAttribute('aria-pressed', String(draft.excess === b.dataset.excess));
    b.textContent = b.dataset.excess === 'change' ? `Dau rest · ${money(result.excessMinor || 0)}` : `Păstrez avans · ${money(result.excessMinor || 0)}`;
  });
  if ($('#received').value !== draft.amount) $('#received').value = draft.amount;
  $('#manual').checked = draft.manual;
  $$('[data-allocation]').forEach(input => { input.readOnly = !draft.manual; const value = draft.manual ? draft.allocations[input.dataset.allocation] || '0' : decimal(result.allocations?.find(a => a.expenseId === input.dataset.allocation)?.amountMinor || 0); if (input.value !== value) input.value = value; });
  const error = result.error || (!result.netMinor ? 'Pentru a încasa un avans, alege „Păstrez în avans”.' : '');
  $('#collection-error').hidden = !error || !draft.amount; $('#collection-error').textContent = error;
  $('#excess').hidden = !!result.error || !result.excessMinor;
  $('#excess-label').textContent = `Diferență: ${money(result.excessMinor || 0)}`;
  $('#collection-summary').hidden = !!result.error;
  if (!result.error) $('#collection-summary').innerHTML = `<dl><div><dt>Acoperă contribuții</dt><dd>${money(result.coveredMinor)}</dd></div>${result.changeMinor ? `<div><dt>Rest de dat</dt><dd>${money(result.changeMinor)}</dd></div>` : ''}${result.creditMinor ? `<div><dt>Avans nou</dt><dd>${money(result.creditMinor)}</dd></div>` : ''}<div><dt>Rămâne de achitat</dt><dd>${money(result.dueMinor)}</dd></div><div><dt>Intră în fondul clasei</dt><dd><strong>${money(result.netMinor)}</strong></dd></div></dl>`;
  $('#collection-save').textContent = result.netMinor > 0 ? `Înregistrează · ${money(result.netMinor)}` : 'Înregistrează încasarea';
  updateNotices();
}
function renderExpenses() {
  const expenses = [...state.expenses].reverse();
  $('#main').innerHTML = `<h1>Cheltuieli</h1><p class="caption">Contribuțiile copiilor și banii dați mai departe</p><button class="primary wide" data-action="add-expense" ${activeChildren().length ? '' : 'disabled'}>+ Cheltuială nouă</button><div class="stack" style="margin-top:20px">${expenses.length ? expenses.map(e => `<button class="card card-button ${e.cancelled ? 'transaction-muted' : ''}" data-expense="${esc(e.id)}"><div class="row"><h3>${esc(e.title)}</h3><span class="amount">${money(e.totalMinor)}</span></div><div class="caption">${typeLabels[e.type]} · ${e.cancelled ? 'Anulată' : `${e.contributions.length} participanți`}</div><div class="caption">Încasat ${money(e.collectedMinor)} · Dat mai departe ${money(e.paidOutMinor)}</div>${e.dueDate ? `<div class="caption">Termen ${dateText(e.dueDate)}</div>` : ''}</button>`).join('') : `<div class="empty"><h2>Nicio cheltuială încă</h2><p>${activeChildren().length ? 'Adaugă o cheltuială și alege copiii care participă. Contribuțiile apar imediat la fiecare copil.' : 'Adaugă mai întâi copiii în fila Copii.'}</p></div>`}</div>`;
}
function transactionRows(transactions) {
  return [...transactions].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt)).map(t => {
    const c = state.children.find(c => c.id === t.childId);
    return `<button class="card ${t.reversed ? 'transaction-muted' : ''}" data-transaction="${esc(t.id)}"><div class="row"><strong>${labels[t.type] || esc(t.type)}</strong><span class="amount">${money(t.amountMinor)}</span></div><div>${esc(c ? name(c) : t.destination || '')}</div><div class="caption">${dateText(t.occurredAt)}${t.reversed ? ' · Corectată' : ''}${t.changeMinor ? ` · Rest ${money(t.changeMinor)}` : ''}</div>${t.comment ? `<div class="caption">${esc(t.comment)}</div>` : ''}</button>`;
  }).join('') || '<p class="caption">Nu există operațiuni înregistrate.</p>';
}
function renderLedger() {
  const s = state.summary;
  $('#main').innerHTML = `<h1>Registru</h1><div class="balance"><span class="caption">Soldul fondului clasei</span><strong class="amount">${money(s.balanceMinor)}</strong><div class="balance-grid"><div><span class="caption">Încasări după rest</span><span>${money(s.totalReceivedMinor)}</span></div><div><span class="caption">Bani dați și restituiți</span><span>${money(s.totalPaidMinor)}</span></div><div><span class="caption">Avansuri incluse în sold</span><span>${money(s.totalCreditMinor)}</span></div><div><span class="caption">De încasat</span><span>${money(s.totalDueMinor)}</span></div></div><p class="caption" style="margin-bottom:0">Sold inițial ${money(state.settings.openingBalanceMinor)}</p></div><button class="primary wide" data-action="payment">+ Bani dați mai departe</button><div class="toolbar"><button data-action="refresh">Actualizează</button><a href="/api/export" download="casierul-clasei.json">Export JSON</a></div><h2>Istoric</h2><div class="stack">${transactionRows(state.transactions)}</div>`;
}
function renderReports() {
  const reports = state.reports || [];
  const debtors = state.children.filter(item => item.dueMinor > 0);
  $('#main').innerHTML = `<h1>Rapoarte</h1><p class="caption">PDF-uri pentru transparență, pregătite pentru WhatsApp</p>
  <div class="stack" style="margin-top:18px">
    <button class="card card-button" data-action="report-class"><h3>Situația clasei</h3><div class="caption">Sold, cheltuieli, restanțe agregate și bani dați mai departe</div></button>
    <button class="card card-button" data-action="report-matrix" ${state.expenses.some(expense => !expense.cancelled) && state.children.length ? '' : 'disabled'}><h3>Raport exhaustiv</h3><div class="caption">Copiii pe rânduri, cheltuielile pe coloane și situația fiecărei contribuții</div></button>
    <button class="card card-button" data-action="report-expense" ${state.expenses.some(expense => !expense.cancelled) ? '' : 'disabled'}><h3>Situația unei cheltuieli</h3><div class="caption">Necesar, încasat, plătit și restanțe fără numele copiilor</div></button>
    <button class="card card-button" data-action="report-child" ${state.children.length ? '' : 'disabled'}><h3>Fișa individuală</h3><div class="caption">${debtors.length} copii au de achitat ${money(debtors.reduce((total, item) => total + item.dueMinor, 0))}</div></button>
  </div>
  <h2 style="margin-top:28px">Arhivă</h2>
  <div class="stack">${reports.length ? reports.map(report => `<article class="card report-card ${report.replacedById ? 'replaced' : ''}"><div class="row"><h3>${esc(report.code)}</h3>${report.replacedById ? '<span class="badge">Înlocuit</span>' : '<span class="badge">Emis</span>'}</div><div>${esc(reportTypeLabels[report.type])} · ${esc(report.subjectLabel)}</div><div class="caption">${dateText(report.createdAt)} · revizia ${report.stateRevision}</div>${report.replacesId ? '<div class="caption">Raport corectiv</div>' : ''}<div class="report-actions"><button class="primary" data-action="share-report" data-id="${esc(report.id)}">Partajează PDF</button><a href="/api/reports/${encodeURIComponent(report.id)}/pdf" download="${esc(report.filename)}">Descarcă</a>${report.replacedById ? '' : `<button data-action="replace-report" data-id="${esc(report.id)}">Emite corecție</button>`}</div></article>`).join('') : '<div class="empty"><p>Nu ai emis încă niciun raport.</p></div>'}</div>`;
}
function reportModal(type, replacesId = null) {
  const replaced = replacesId ? (state.reports || []).find(report => report.id === replacesId) : null;
  const fixedSubject = replaced?.subjectId || null;
  let selector = '';
  if (type === 'expense') {
    const expenses = [...state.expenses].filter(expense => !expense.cancelled).reverse();
    selector = replaced ? `<p><strong>${esc(replaced.subjectLabel)}</strong></p>` : `<label>Cheltuiala<select name="subjectId" required>${expenses.map(expense => `<option value="${esc(expense.id)}">${esc(expense.title)}</option>`).join('')}</select></label>`;
  } else if (type === 'child') {
    selector = replaced ? `<p><strong>${esc(replaced.subjectLabel)}</strong></p>` : `<label>Filtrează lista<select name="debtFilter"><option value="due">Doar copiii cu restanțe</option><option value="all">Toți copiii</option><option value="paid">Doar copiii fără restanțe</option></select></label><label>Copilul<select name="subjectId" required></select></label><p id="report-child-count" class="caption"></p>`;
  }
  const privacy = type === 'child' ? 'Fișa conține numele copilului și este destinată trimiterii private.' : type === 'matrix' ? 'Raportul conține numele tuturor copiilor și este destinat verificării interne de către tine și dirigintă.' : 'Restanțele apar doar ca număr de copii și sumă totală, fără nume sau inițiale.';
  openModal('report', replaced ? 'Emite raport corectiv' : reportTypeLabels[type], `${selector}<div class="summary"><strong>Situație la momentul emiterii</strong><p class="caption">PDF-ul va păstra exact datele și revizia actuală a registrului.</p></div><p class="caption">${privacy}</p>${replaced ? `<p class="caption">Noul raport va marca faptul că înlocuiește ${esc(replaced.code)}. Raportul vechi rămâne în arhivă.</p>` : ''}`, 'Generează PDF', {
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
  select.innerHTML = children.map(item => `<option value="${esc(item.id)}">${esc(name(item))} · ${item.dueMinor ? `Restant ${money(item.dueMinor)}` : `Achitat${item.creditMinor ? ` · Avans ${money(item.creditMinor)}` : ''}`}</option>`).join('');
  if (children.some(item => item.id === previous)) select.value = previous;
  select.disabled = !children.length;
  $('#modal-submit').disabled = saving || !children.length;
  $('#report-child-count').textContent = children.length ? `${children.length} ${children.length === 1 ? 'copil afișat' : 'copii afișați'}. Restanțele cele mai mari apar primele.` : 'Niciun copil pentru acest filtru.';
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
    closeModal(true); render(); toast(`${result.report.code} a fost generat. Îl poți partaja acum.`);
  } catch (error) { $('#modal-error').textContent = error.message; $('#modal-error').hidden = false; }
  finally { saving = false; updateNotices(); }
}
async function shareReport(reportId) {
  const report = (state.reports || []).find(item => item.id === reportId);
  if (!report) return;
  saving = true; updateNotices();
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(report.id)}/pdf`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('PDF-ul nu a putut fi descărcat.');
    const file = new File([await response.blob()], report.filename, { type: 'application/pdf' });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ title: `${report.code} · ${reportTypeLabels[report.type]}`, files: [file] });
    } else {
      const url = URL.createObjectURL(file), link = document.createElement('a');
      link.href = url; link.download = report.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('PDF descărcat. Atașează-l în WhatsApp.');
    }
  } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'PDF-ul nu a putut fi partajat.'); }
  finally { saving = false; updateNotices(); }
}
function settingsModal() {
  const s = state.settings;
  const year = new Date().getFullYear() - (new Date().getMonth() < 8 ? 1 : 0);
  openModal('settings', s.className ? 'Setările clasei' : 'Configurează clasa', `${field('Școala', 'schoolName', s.schoolName, 'required maxlength="160"')}${field('Clasa', 'className', s.className, 'required maxlength="80"')}${field('An școlar', 'schoolYear', s.schoolYear || `${year}–${year + 1}`, 'required maxlength="40"')}${field('Sold inițial (lei)', 'openingBalance', decimal(s.openingBalanceMinor), `inputmode="decimal" required ${state.transactions.length ? 'readonly' : ''}`)}<p class="caption">Banii deja existenți în fond înainte să începi evidența. ${state.transactions.length ? 'Soldul inițial nu mai poate fi schimbat după înregistrarea operațiunilor.' : 'Avansurile individuale se înregistrează separat, prin încasări.'}</p>${state.settings.className ? '<div class="toolbar"><a href="/api/export" download="casierul-clasei.json">Exportă datele JSON</a><button type="button" data-action="logout">Deconectează dispozitivul</button></div>' : ''}`);
}
function childModal(edit = false) {
  const c = edit ? child() : null;
  openModal(edit ? 'edit-child' : 'add-child', edit ? 'Editează copilul' : 'Adaugă un copil', `${field('Nume de familie', 'lastName', c?.lastName || '', 'required maxlength="80" autocomplete="family-name"')}${field('Prenume', 'firstName', c?.firstName || '', 'required maxlength="80" autocomplete="given-name"')}${c ? `<label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}>Copil activ în clasă</label><p class="caption">Arhivarea ascunde copilul din lista principală. Datoriile, avansul și istoricul rămân în registru.</p>` : ''}`, 'Salvează', { childId: c?.id });
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
  const locked = !!expense && (expense.collectedMinor > 0 || expense.paidOutMinor > 0);
  const existing = new Map(expense?.contributions.map(item => [item.childId, item]) || []);
  const participants = sortChildren(state.children.filter(c => c.active || existing.has(c.id)));
  const lockedAttribute = locked ? 'disabled data-locked' : '';
  const type = expense?.type || 'fixed';
  const typeOptions = [['fixed', 'Sumă fixă pentru fiecare copil'], ['split', 'Total împărțit între participanți'], ['quantity', 'Cantitate pentru fiecare copil × preț']]
    .map(([value, label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`).join('');
  const participantFields = participants.map(c => {
    const contribution = existing.get(c.id), checked = expense ? !!contribution : c.active;
    const paidMinor = c.contributions.find(item => item.expenseId === expense?.id)?.paidMinor ?? 0;
    const participantLocked = locked && (!contribution || paidMinor > 0 || type === 'split');
    const quantityLocked = locked && type !== 'quantity' ? lockedAttribute : '';
    return `<div class="participant"><label class="check"><input type="checkbox" data-participant="${esc(c.id)}" ${checked ? 'checked' : ''} ${participantLocked ? lockedAttribute : ''}>${esc(name(c))}${c.active ? '' : ' · Arhivat'}</label><input type="number" data-quantity="${esc(c.id)}" min="1" max="10000" step="1" value="${contribution?.quantity || 1}" aria-label="Cantitate pentru ${esc(name(c))}" ${quantityLocked} hidden></div>`;
  }).join('');
  openModal(expense ? 'edit-expense' : 'expense', expense ? 'Editează cheltuiala' : 'Cheltuială nouă',
    `${field('Denumire', 'title', expense?.title || '', 'required maxlength="200"')}<label>Calculul contribuției<select name="type" ${lockedAttribute}>${typeOptions}</select></label>${field('<span id="expense-amount-label">Suma (lei)</span>', 'amount', expense ? decimal(expense.amountMinor) : '', `inputmode="decimal" autocomplete="off" required ${lockedAttribute}`)}<label>Termen de plată (opțional)<input name="dueDate" type="date" value="${esc(expense?.dueDate || '')}"></label>${timestampField(expense ? localDateTime(expense.occurredAt) : localNow())}<div class="section-label">Cine participă?</div><label class="check"><input type="checkbox" id="all-participants" ${lockedAttribute}>Toți copiii</label><div class="participants">${participantFields}</div><p class="caption">${locked && type === 'quantity' ? 'Poți elimina participanții fără sume achitate și poți corecta cantitățile fără a coborî contribuția sub suma deja achitată.' : locked && type === 'fixed' ? 'Poți elimina participanții fără sume achitate. Suma și participanții care au plătit rămân protejați.' : locked ? 'Suma, calculul și participanții sunt protejați deoarece există încasări sau plăți legate de cheltuială. Denumirea, datele și comentariile pot fi editate.' : 'Copiii nebifați nu au contribuție la această cheltuială. Modificările recalculează contribuțiile înainte de salvare.'}</p><div id="expense-preview" class="summary" aria-live="polite"></div>${comments(expense?.comment || '')}`,
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
function expenseDetails(id) {
  const e = state.expenses.find(e => e.id === id);
  openModal('expense-detail', e.title, `<p class="caption">${typeLabels[e.type]} · ${e.cancelled ? 'Anulată' : `${e.contributions.length} participanți`}</p><div class="summary"><dl><div><dt>Total contribuții</dt><dd>${money(e.totalMinor)}</dd></div><div><dt>Încasat</dt><dd>${money(e.collectedMinor)}</dd></div><div><dt>Bani dați mai departe</dt><dd>${money(e.paidOutMinor)}</dd></div></dl></div><p>${e.dueDate ? `Termen: ${dateText(e.dueDate)}` : 'Fără termen de plată'}</p><p class="caption">Data cheltuielii: ${dateText(e.occurredAt)}</p>${e.comment ? `<p>${esc(e.comment)}</p>` : ''}<div class="preview-list">${sortChildren(state.children.filter(c => e.contributions.some(p => p.childId === c.id))).map(c => { const p = e.contributions.find(p => p.childId === c.id); const contribution = c.contributions.find(p => p.expenseId === e.id); return `<div class="row"><span>${esc(name(c))}${e.type === 'quantity' ? ` × ${p.quantity}` : ''}<small style="display:block">Restant ${money(contribution?.remainingMinor || 0)}</small></span><span class="amount">${money(p.amountMinor)}</span></div>`; }).join('')}</div>${e.cancelled ? '' : `<div class="toolbar"><button type="button" data-action="edit-expense" data-id="${esc(e.id)}">Editează</button><button type="button" data-action="expense-payment" data-id="${esc(e.id)}">Înregistrează bani dați</button></div>${!e.collectedMinor && !e.paidOutMinor ? `<button type="button" class="danger" data-action="cancel-expense" data-id="${esc(e.id)}">Anulează cheltuiala</button><p class="caption">Anularea este posibilă doar dacă nu mai există încasări sau plăți legate de cheltuială.</p>` : ''}`}`, null);
}
function paymentModal(expenseId = '') {
  openModal('payment', 'Bani dați mai departe', `${moneyField('Suma dată (lei)', 'amount')}${field('Cui ai dat banii', 'destination', '', 'required maxlength="200" placeholder="De exemplu: dirigintă, profesoară, fotograf"')}<label>Cheltuială asociată (opțional)<select name="expenseId"><option value="">Fără asociere</option>${state.expenses.filter(e => !e.cancelled).map(e => `<option value="${esc(e.id)}" ${e.id === expenseId ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select></label>${timestampField()}${comments()}<p class="caption">Suma scade din soldul fondului. Contribuțiile copiilor rămân neschimbate.</p>`, 'Înregistrează');
}
function creditModal() {
  const c = child(), defaults = automaticAllocations(unpaid(c), c.creditMinor);
  openModal('credit', 'Folosește avansul', `<p>${esc(name(c))} · Avans disponibil <strong>${money(c.creditMinor)}</strong></p>${unpaid(c).map(e => `<label class="allocation"><span>${esc(e.title)}<small style="display:block">Restant ${money(e.remainingMinor)}</small></span><input name="credit-${esc(e.expenseId)}" data-credit-expense="${esc(e.expenseId)}" inputmode="decimal" value="${decimal(defaults.find(a => a.expenseId === e.expenseId)?.amountMinor || 0)}" aria-label="${esc(e.title)}: avans repartizat în lei"></label>`).join('')}<div id="credit-preview" class="summary" aria-live="polite"></div>${timestampField()}${comments()}<p class="caption">Se folosesc banii deja primiți. Soldul fondului nu se schimbă.</p>`, 'Repartizează avansul', { childId: c.id }); updateCreditPreview();
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
  openModal('refund', 'Restituie din avans', `<p>${esc(name(c))} · Avans disponibil <strong>${money(c.creditMinor)}</strong></p>${moneyField('Suma restituită (lei)', 'amount', decimal(c.creditMinor))}${timestampField()}${comments()}<p class="caption">Banii restituiți scad avansul copilului și soldul fondului.</p>`, 'Înregistrează restituirea', { childId: c.id });
}
function transactionDetails(id) {
  const t = state.transactions.find(t => t.id === id), c = state.children.find(c => c.id === t.childId);
  openModal('transaction-detail', labels[t.type], `<div class="summary"><strong class="total-number">${money(t.amountMinor)}</strong>${t.changeMinor ? `<p>Rest restituit: ${money(t.changeMinor)}</p>` : ''}</div>${c ? `<p>${esc(name(c))}</p>` : ''}${t.destination ? `<p>Destinație: ${esc(t.destination)}</p>` : ''}${t.expenseId ? `<p>Cheltuială: ${esc(state.expenses.find(e => e.id === t.expenseId)?.title || '')}</p>` : ''}<p>Data și ora: ${dateText(t.occurredAt)}</p><p class="caption">Înregistrat: ${dateText(t.createdAt)}${t.actorLabel ? ` · ${esc(t.actorLabel)}` : ''}</p>${t.comment ? `<p>${esc(t.comment)}</p>` : ''}${t.allocations?.length ? `<h3>Repartizare</h3><div class="preview-list">${t.allocations.map(a => `<div class="row"><span>${esc(state.expenses.find(e => e.id === a.expenseId)?.title || 'Cheltuială')}</span><span>${money(a.amountMinor)}</span></div>`).join('')}</div>` : ''}${t.reversed ? '<p class="caption">Operațiune corectată. Înregistrarea originală rămâne în istoric.</p>' : t.type === 'reversal' ? '<p class="caption">Această înregistrare inversează efectele operațiunii corectate.</p>' : `<button type="button" class="danger wide" style="margin-top:18px" data-action="reverse" data-id="${esc(t.id)}">Corectează prin anularea operațiunii</button>`}`, null);
}
function positiveMoney(value) { const amount = parseMoney(value); if (amount === null || amount <= 0) throw new Error('Introdu o sumă mai mare decât zero, cu cel mult două zecimale.'); return amount; }
function metadata(form) {
  const input = form.elements.occurredAt?.value;
  if (form.elements.occurredAt && !input) throw new Error('Completează data și ora.');
  const occurredAt = input ? new Date(input) : null;
  if (occurredAt && Number.isNaN(occurredAt.getTime())) throw new Error('Data și ora nu sunt valide.');
  return { ...(occurredAt ? { occurredAt: occurredAt.toISOString() } : {}), comment: form.elements.comment?.value.trim() || '' };
}
async function submitModal() {
  if (!modal || saving || pending || conflict) return;
  const form = $('#modal-form');
  if (!form.reportValidity()) return;
  if (modal.type === 'report') { await createReport(form); return; }
  let path, body;
  try {
    if (modal.type === 'settings') {
      const openingBalanceMinor = parseMoney(form.elements.openingBalance.value);
      if (openingBalanceMinor === null) throw new Error('Soldul inițial trebuie să fie o sumă validă, zero sau mai mare.');
      path = '/api/settings'; body = { schoolName: form.elements.schoolName.value.trim(), className: form.elements.className.value.trim(), schoolYear: form.elements.schoolYear.value.trim(), openingBalanceMinor };
    } else if (modal.type === 'add-child' || modal.type === 'edit-child') {
      path = modal.type === 'add-child' ? '/api/children' : `/api/children/${encodeURIComponent(modal.childId)}`;
      body = { firstName: form.elements.firstName.value.trim(), lastName: form.elements.lastName.value.trim(), ...(modal.type === 'edit-child' ? { active: form.elements.active.checked } : {}) };
    } else if (modal.type === 'bulk-children') { path = '/api/children/bulk'; body = { children: parseBulk(form.elements.childrenText.value) }; }
    else if (modal.type === 'expense' || modal.type === 'edit-expense') {
      path = modal.type === 'expense' ? '/api/expenses' : `/api/expenses/${encodeURIComponent(modal.expenseId)}`;
      body = { ...readExpense(), title: form.elements.title.value.trim(), dueDate: form.elements.dueDate.value || null, ...metadata(form) };
    }
    else if (modal.type === 'payment') { path = '/api/payments'; body = { amountMinor: positiveMoney(form.elements.amount.value), destination: form.elements.destination.value.trim(), ...(form.elements.expenseId.value ? { expenseId: form.elements.expenseId.value } : {}), ...metadata(form) }; }
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
  if (saving || pending || conflict) return;
  const result = collectionResult(child(), draft);
  if (result.error || result.netMinor <= 0) return;
  const occurredAt = new Date(draft.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) { $('#collection-error').textContent = 'Completează data și ora încasării.'; $('#collection-error').hidden = false; return; }
  await mutate('/api/collections', { childId, receivedMinor: result.receivedMinor, changeMinor: result.changeMinor, allocations: result.allocations, occurredAt: occurredAt.toISOString(), comment: draft.comment.trim() }, `Încasare salvată: ${money(result.netMinor)} în fond.${result.changeMinor ? ` Dă rest ${money(result.changeMinor)}.` : result.creditMinor ? ` Avans nou: ${money(result.creditMinor)}.` : ''}`);
}
async function mutate(path, body, successMessage) {
  if (!navigator.onLine || disconnected) { toast('Este nevoie de conexiune pentru a salva.'); return; }
  if (saving || pending || conflict) return;
  const requestId = crypto.randomUUID();
  setPending({ path, body: { ...body, requestId, expectedRevision: state.revision }, successMessage });
  await sendPending();
}
async function sendPending() {
  if (!pending || saving) return;
  saving = true; updateNotices();
  try {
    const request = pending;
    const result = await api(request.path, { method: 'POST', body: JSON.stringify(request.body) });
    setPending(null); conflict = false; dirty = false; modalDirty = false;
    rememberRosterScroll();
    state = result.state; closeModal(true);
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
  if (action === 'reconnect') { try { await api('/api/health'); if ($('#dialog').open && !pending && !conflict) $('#modal-error').hidden = true; updateNotices(); toast('Conexiunea este disponibilă.'); if (state && !busy()) await refresh(); } catch { updateNotices(); } return; }
  if (action === 'retry') { await sendPending(); return; }
  if (action === 'review') { await refresh(true); return; }
  if (action === 'close-modal') { closeModal(); return; }
  if (saving || pending) { if (button.type !== 'submit') toast('Verifică mai întâi salvarea în așteptare.'); return; }
  if (button.dataset.target) {
    draft.target = button.dataset.target; draft.manual = false; draft.round = null;
    draft.amount = decimal(draft.target === 'all' ? child().dueMinor : unpaid(child()).find(e => e.expenseId === draft.target).remainingMinor);
    dirty = true; updateCollection(); return;
  }
  if (button.dataset.round) {
    const base = draft.target === 'all' ? child().dueMinor : unpaid(child()).find(e => e.expenseId === draft.target)?.remainingMinor || 0;
    draft.round = Number(button.dataset.round); draft.amount = decimal(roundUp(base, draft.round)); dirty = true; updateCollection(); return;
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
    case 'add-child': childModal(); break;
    case 'edit-child': childModal(true); break;
    case 'bulk-children': bulkModal(); break;
    case 'add-expense': expenseModal(); break;
    case 'edit-expense': expenseModal(state.expenses.find(expense => expense.id === button.dataset.id)); break;
    case 'payment': paymentModal(); break;
    case 'expense-payment': paymentModal(button.dataset.id); break;
    case 'apply-credit': creditModal(); break;
    case 'refund': refundModal(); break;
    case 'report-class': reportModal('class'); break;
    case 'report-matrix': reportModal('matrix'); break;
    case 'report-expense': reportModal('expense'); break;
    case 'report-child': reportModal('child'); break;
    case 'share-report': await shareReport(button.dataset.id); break;
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
      if (!confirm('Deconectezi acest dispozitiv? Pentru acces va fi necesară o invitație nouă.')) return;
      try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); closeModal(true); device = null; state = null; renderGate(); } catch (error) { toast(error.message); }
      break;
  }
});
document.addEventListener('input', event => {
  const input = event.target;
  if (input.id === 'child-search') { search = input.value; renderRosterList(); return; }
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
    if (input.id === 'received') { draft.amount = input.value; draft.round = null; }
    if (input.dataset.allocation) draft.allocations[input.dataset.allocation] = input.value;
    if (input.id === 'collection-date') draft.occurredAt = input.value;
    if (input.id === 'collection-comment') draft.comment = input.value;
    updateCollection();
  }
});
document.addEventListener('change', event => {
  const input = event.target;
  if (input.name === 'debtFilter') { modalDirty = true; updateChildReportOptions(); return; }
  if (input.id === 'show-archived') { showArchived = input.checked; renderRosterList(); }
  if (input.id === 'manual') {
    const result = collectionResult(child(), draft);
    if (input.checked) draft.allocations = Object.fromEntries(unpaid(child()).map(e => [e.expenseId, decimal(result.allocations?.find(a => a.expenseId === e.expenseId)?.amountMinor || 0)]));
    draft.manual = input.checked; draft.round = null; dirty = true; updateCollection();
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
      device = result.device; inviteCode = ''; state = await api('/api/state'); render();
    } catch (error) { $('#invite-error').textContent = error.message; }
    finally { button.disabled = false; }
  }
});
$('#dialog').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
window.addEventListener('popstate', event => {
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
    device = (await api('/api/auth/me')).device; state = await api('/api/state');
    showScreen(tab, childId, { push: false });
  }
  catch (error) {
    if (error.status === 401) renderGate();
    else { $('#main').innerHTML = '<div class="empty"><h1>Registrul nu este disponibil</h1><p>Verifică conexiunea și încearcă din nou. Nicio operațiune nouă nu a fost înregistrată de pe acest ecran.</p><button class="primary wide" data-action="reload">Reîncarcă</button></div>'; updateNotices(); }
  }
}
boot();
