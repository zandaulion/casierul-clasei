import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { start } from '../server/index.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'casierul-browser-'));
const origin = 'http://127.0.0.1:18018';
const app = await start({ dataDir: temporary, publicBaseUrl: origin, port: 18018, adminPort: 0, adminToken: 'browser-test-only', cookieSecure: false });
const invite = app.auth.createInvite('Browser verification');
const browserVersion = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const socket = new WebSocket(browserVersion.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0, contextId, targetId, sessionId;
const pending = new Map(), exceptions = [];
let loseNextCollectionResponse = false;
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.sessionId === sessionId && message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  if (message.sessionId === sessionId && message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
  if (message.sessionId === sessionId && message.method === 'Fetch.requestPaused') {
    const requestId = message.params.requestId;
    if (loseNextCollectionResponse && message.params.responseStatusCode === 200) {
      loseNextCollectionResponse = false;
      send('Fetch.failRequest', { requestId, errorReason: 'Failed' }, sessionId).catch(() => {});
    } else send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
  }
  if (!pending.has(message.id)) return;
  const { resolve, reject, timer } = pending.get(message.id);
  clearTimeout(timer); pending.delete(message.id);
  message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
};
function send(method, params = {}, session) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
}
const page = (method, params) => send(method, params, sessionId);
async function evaluate(expression) {
  const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression, label = expression) {
  for (let i = 0; i < 100; i++) {
    try { if (await evaluate(expression)) return; } catch (error) { if (!/context|navigat/i.test(error.message)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  const info = await evaluate('({page:document.body.innerText,modal:document.getElementById("modal-error")?.textContent})');
  throw new Error('Timed out: ' + label + '\n' + JSON.stringify(info));
}
const click = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()');
const fill = (selector, value) => evaluate('(() => {const el=document.querySelector(' + JSON.stringify(selector) + ');el.value=' + JSON.stringify(value) + ';el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));})()');
const getValue = selector => evaluate('document.querySelector(' + JSON.stringify(selector) + ').value');
async function saveModal() {
  await click('#modal-submit');
  await until('!document.getElementById("dialog").open', 'modal saved');
  await until('!document.getElementById("modal-submit").disabled', 'post-save state refresh finished');
}
function snapshot() { return app.ledger.getState(); }
async function screenshot(name) {
  const { data } = await page('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile('/tmp/casierul-app-' + name + '.png', Buffer.from(data, 'base64'));
}
try {
  ({ browserContextId: contextId } = await send('Target.createBrowserContext'));
  ({ targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId: contextId }));
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await page('Page.enable'); await page('Runtime.enable'); await page('Network.enable');
  await page('Network.setCacheDisabled', { cacheDisabled: true });
  await page('Network.setBypassServiceWorker', { bypass: true });
  await page('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page('Page.navigate', { url: origin + '/?invite=' + invite.code });
  await until('document.getElementById("invite-form")');
  await fill('#invite-form [name=code]', invite.code);
  await click('#invite-form button[type=submit]');
  await until('document.querySelector("[data-action=settings].wide")');
  await click('[data-action=settings].wide');
  await fill('#modal-form [name=schoolName]', 'Școala de verificare');
  await fill('#modal-form [name=className]', 'III A');
  await fill('#modal-form [name=openingBalance]', '0');
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'sigla.png', { type: 'image/png' }));
    const input = document.querySelector('[data-logo-input="school"]');
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    const classTransfer = new DataTransfer();
    classTransfer.items.add(new File([bytes], 'sigla-clasei.png', { type: 'image/png' }));
    const classInput = document.querySelector('[data-logo-input="class"]');
    classInput.files = classTransfer.files; classInput.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until('!document.getElementById("school-logo-preview").hidden', 'school logo preview');
  await until('!document.getElementById("class-logo-preview").hidden', 'class logo preview');
  await saveModal();
  assert.equal(snapshot().settings.hasSchoolLogo, true);
  assert.equal(snapshot().settings.hasClassLogo, true);
  await until('!document.getElementById("header-school-logo").hidden && !document.getElementById("header-class-logo").hidden', 'configured logos in app header');
  await click('[data-action=bulk-children]');
  await fill('#modal-form [name=childrenText]', 'Exemplu; Ioana\nAvram; Ana\nBălan; David');
  await saveModal();
  assert.equal(snapshot().children.length, 3);
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".child-name")].map(e=>e.textContent)'), ['Avram', 'Bălan', 'Exemplu']);
  const anaId = snapshot().children.find(c => c.firstName === 'Ana').id;
  const davidId = snapshot().children.find(c => c.firstName === 'David').id;
  const ioanaId = snapshot().children.find(c => c.firstName === 'Ioana').id;
  await click('[data-tab=expenses]');
  async function expense(title, type, amount, configure) {
    await click('[data-action=add-expense]');
    await fill('#modal-form [name=title]', title);
    await fill('#modal-form [name=type]', type);
    await fill('#modal-form [name=amount]', amount);
    if (configure) await configure();
    await saveModal();
    return snapshot().expenses.find(e => e.title === title).id;
  }
  const booksId = await expense('Culegeri', 'fixed', '60', async () => {
    await click('#all-participants');
    assert.equal(await evaluate('document.querySelectorAll("[data-participant]:checked").length'), 0);
    await click('#all-participants');
    assert.equal(await evaluate('document.querySelectorAll("[data-participant]:checked").length'), 3);
    await click('[data-participant="' + davidId + '"]');
  });
  const tripId = await expense('Excursie', 'split', '75', () => click('[data-participant="' + ioanaId + '"]'));
  await expense('Bilete', 'quantity', '15', async () => {
    await click('[data-participant="' + ioanaId + '"]');
    await fill('[data-quantity="' + anaId + '"]', '2');
  });
  await click('[data-expense="' + booksId + '"]');
  await click('[data-action=edit-expense]');
  await fill('#modal-form [name=title]', 'Culegeri școlare');
  await fill('#modal-form [name=dueDate]', '2026-10-15');
  await fill('#modal-form [name=comment]', 'Denumire verificată');
  await saveModal();
  assert.equal(snapshot().expenses.find(e => e.id === booksId).title, 'Culegeri școlare');
  assert.equal(snapshot().expenses.find(e => e.id === booksId).dueDate, '2026-10-15');
  assert.equal(snapshot().expenses.find(e => e.title === 'Bilete').totalMinor, 4500);
  assert.equal(snapshot().children.find(c => c.id === ioanaId).dueMinor, 6000);
  await click('[data-tab=children]');
  await evaluate('history.back()');
  await until('document.querySelector("[data-action=add-expense]")', 'back gesture restores previous tab');
  await evaluate('history.forward()');
  await until('document.querySelector(".children")', 'forward gesture restores next tab');
  await screenshot('roster');
  await page('Emulation.setDeviceMetricsOverride', { width: 412, height: 600, deviceScaleFactor: 1, mobile: true });
  const rosterPosition = await evaluate('(scrollTo(0, document.documentElement.scrollHeight), scrollY)');
  assert.ok(rosterPosition > 0, 'test roster must be scrolled before opening a child');
  await click('[data-child="' + anaId + '"]');
  await evaluate('history.back()');
  await until('document.querySelector(".children")', 'back gesture restores roster');
  await until(`Math.abs(scrollY - ${rosterPosition}) <= 1`, 'back gesture restores roster scroll position');
  await evaluate('history.forward()');
  await until('document.getElementById("collection-form")', 'forward gesture restores child screen');
  assert.equal(await evaluate('document.getElementById("tabs").hidden'), true, 'main tabs yield space to the collection action panel');
  assert.equal(await evaluate('(() => { const r=document.querySelector(".collection-dock").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; })()'), true, 'collection action panel stays inside the viewport');
  await click('[data-action=edit-child]');
  await until('document.getElementById("dialog").open');
  await evaluate('history.back()');
  await until('!document.getElementById("dialog").open && document.getElementById("collection-form")', 'back gesture closes dialog first');
  assert.equal(await getValue('#received'), '127,50');
  await evaluate('document.getElementById("allocation-details").open = true');
  await click('#manual');
  assert.equal(await evaluate('document.getElementById("manual").checked'), true);
  assert.equal(await evaluate('document.querySelectorAll("[data-allocation]:not(:disabled)").length'), 3);
  await click('#manual');
  assert.equal(await evaluate('document.getElementById("manual").checked'), false);
  await click('[data-round="50"]'); assert.equal(await getValue('#received'), '150,00');
  assert.equal(await evaluate('!document.getElementById("excess").hidden && [...document.querySelectorAll("[data-excess]")].every(button => { const r=button.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })'), true, 'change choices stay visible without scrolling');
  assert.equal(await evaluate('(() => { const r=document.getElementById("collection-save").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()'), true, 'save stays visible without scrolling');
  await page('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('(() => { const dock=document.querySelector(".collection-dock").getBoundingClientRect(); return dock.top >= 0 && dock.bottom <= innerHeight && [...document.querySelectorAll("[data-excess]")].every(button => button.scrollWidth <= button.clientWidth); })()'), true, 'fixed collection actions fit a small phone');
  await page('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await click('[data-target="' + booksId + '"]');
  assert.equal(await getValue('#received'), '60,00');
  await click('[data-round="100"]');
  await click('[data-excess=credit]');
  assert.equal(await getValue('#received'), '100,00');
  await screenshot('collection');
  await page('Emulation.setDeviceMetricsOverride', { width: 412, height: 600, deviceScaleFactor: 1, mobile: true });
  await page('Fetch.enable', { patterns: [{ urlPattern: '*api/collections', requestStage: 'Response' }] });
  loseNextCollectionResponse = true;
  await click('#collection-save');
  await until('document.querySelector("[data-action=retry]:not(:disabled)")', 'uncertain response retry visible');
  assert.equal(snapshot().transactions.filter(t => t.type === 'collection').length, 1);
  await page('Fetch.disable');
  // A committed request with a lost response must survive session renewal too.
  app.auth.setDeviceRevoked(app.auth.listDevices().devices[0].id, true);
  await click('[data-action=retry]');
  await until('document.getElementById("invite-form")', 'expired device activation gate');
  assert.ok(await evaluate('JSON.parse(sessionStorage.getItem("casierul.pending.v1")).body.requestId'));
  const renewal = app.auth.createInvite('Renewed browser');
  await fill('#invite-form [name=code]', renewal.code);
  await click('#invite-form button[type=submit]');
  await until('document.querySelector("[data-action=retry]:not(:disabled)") && !document.getElementById("invite-form")', 'pending save survives reactivation');
  await click('[data-action=retry]');
  await until('document.querySelector(".children") && document.getElementById("pending-notice").hidden', 'retry confirmation returns to roster');
  await until(`Math.abs(scrollY - ${rosterPosition}) <= 1`, 'saved collection restores roster scroll position');
  await page('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  assert.equal(snapshot().transactions.filter(t => t.type === 'collection').length, 1, 'lost response retry must not duplicate money');
  assert.equal(snapshot().children.find(c => c.id === anaId).creditMinor, 4000);
  assert.equal(snapshot().children.find(c => c.id === anaId).dueMinor, 6750);
  assert.equal(snapshot().summary.balanceMinor, 10000);
  await click('[data-tab=expenses]');
  await click('[data-expense="' + booksId + '"]');
  await click('[data-action=edit-expense]');
  assert.equal(await evaluate('document.querySelector("#modal-form [name=amount]").disabled'), true);
  assert.equal(await evaluate(`document.querySelector('[data-participant="${anaId}"]').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('[data-participant="${davidId}"]').disabled`), false);
  await click('[data-participant="' + davidId + '"]');
  await fill('#modal-form [name=comment]', 'Contribuțiile sunt deja protejate');
  await saveModal();
  assert.equal(snapshot().expenses.find(e => e.id === booksId).comment, 'Contribuțiile sunt deja protejate');
  assert.ok(snapshot().expenses.find(e => e.id === booksId).contributions.some(item => item.childId === davidId), 'new participant added after a collection');
  await click('[data-tab=ledger]');
  await click('[data-action=payment]');
  await fill('#modal-form [name=amount]', '60');
  await fill('#modal-form [name=destination]', 'Librărie');
  await fill('#modal-form [name=expenseId]', booksId);
  await fill('#modal-form [name=comment]', 'Culegerile Anei');
  await saveModal();
  assert.equal(snapshot().summary.balanceMinor, 4000);
  const paymentId = snapshot().transactions.find(t => t.type === 'payment').id;
  await click('[data-tab=children]'); await click('[data-child="' + anaId + '"]');
  await click('[data-action=refund]'); await fill('#modal-form [name=amount]', '10'); await saveModal();
  assert.equal(snapshot().summary.balanceMinor, 3000);
  assert.equal(snapshot().children.find(c => c.id === anaId).creditMinor, 3000);
  await click('[data-action=apply-credit]');
  await saveModal();
  assert.equal(snapshot().summary.balanceMinor, 3000);
  assert.equal(snapshot().children.find(c => c.id === anaId).creditMinor, 0);
  assert.equal(snapshot().children.find(c => c.id === anaId).dueMinor, 3750);
  await click('[data-tab=ledger]');
  await click('[data-transaction="' + paymentId + '"]');
  await click('[data-action=reverse]');
  await fill('#modal-form [name=comment]', 'Verificare corecție'); await saveModal();
  assert.equal(snapshot().summary.balanceMinor, 9000);
  assert.equal(snapshot().transactions.find(t => t.id === paymentId).reversed, true);
  await screenshot('ledger');
  await click('[data-tab=reports]');
  await until('document.querySelector("[data-action=report-class]")', 'reports screen');
  await click('[data-action=report-matrix]');
  assert.match(await evaluate('document.getElementById("modal-content").textContent'), /numele tuturor copiilor/u);
  await click('[data-action=close-modal]');
  await until('!document.getElementById("dialog").open', 'close exhaustive report');
  assert.match(await evaluate('document.querySelector("[data-action=report-child] .caption").textContent'), /copii au de achitat/u);
  await click('[data-action=report-child]');
  assert.equal(await getValue('#modal-form [name=debtFilter]'), 'due');
  assert.equal(await evaluate('document.querySelectorAll("#modal-form [name=subjectId] option").length'), snapshot().children.filter(child => child.dueMinor > 0).length);
  assert.equal(await evaluate('[...document.querySelectorAll("#modal-form [name=subjectId] option")].every(option => option.textContent.includes("Restant") && option.textContent.includes("lei"))'), true);
  const reportChildIds = await evaluate('[...document.querySelectorAll("#modal-form [name=subjectId] option")].map(option => option.value)');
  assert.deepEqual(reportChildIds.map(id => snapshot().children.find(child => child.id === id).dueMinor), [...snapshot().children].filter(child => child.dueMinor > 0).sort((a, b) => b.dueMinor - a.dueMinor).map(child => child.dueMinor));
  await click('[data-action=close-modal]');
  await until('!document.getElementById("dialog").open', 'close child report filter');
  await click('[data-action=report-class]');
  await saveModal();
  assert.equal(snapshot().reports.length, 1);
  assert.equal(snapshot().reports[0].code, 'R-0001');
  assert.equal(app.ledger.getReportPdf(snapshot().reports[0].id).pdf.subarray(0, 5).toString(), '%PDF-');
  await evaluate(`(() => {
    window.__sharedReport = null;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.__sharedReport = { name: data.files[0].name, type: data.files[0].type, size: data.files[0].size }; } });
  })()`);
  await click('[data-action=share-report]');
  await until('window.__sharedReport?.type === "application/pdf"', 'PDF shared through native share');
  assert.match(await evaluate('window.__sharedReport.name'), /\.pdf$/u);
  assert.ok(await evaluate('window.__sharedReport.size > 1000'));
  await screenshot('reports');
  await click('[data-tab=children]'); await click('[data-child="' + davidId + '"]');
  for (const width of [320, 412, 736]) {
    await page('Emulation.setDeviceMetricsOverride', { width, height: 915, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'horizontal overflow at ' + width);
    assert.equal(await evaluate('[...document.querySelectorAll(".choice,.round")].every(b=>b.scrollWidth<=b.clientWidth)'), true, 'clipped amount choice at ' + width);
    assert.equal(await evaluate('[...document.querySelectorAll(".header-logos img:not([hidden])")].every(image => { const box=image.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })'), true, 'header logo overflow at ' + width);
  }
  await page('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });
  await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await screenshot('dark');
  await click('[data-target="' + booksId + '"]');
  app.ledger.dispatch('collection.create', {
    requestId: randomUUID(), expectedRevision: snapshot().revision,
    childId: davidId, receivedMinor: 6000, changeMinor: 0,
    allocations: [{ expenseId: booksId, amountMinor: 6000 }]
  }, { id: 'second-test-device', label: 'Second test device' });
  await click('#collection-save');
  await until('document.querySelector("[data-action=review]")', 'stale revision detected');
  await click('[data-action=review]');
  await until('document.getElementById("pending-notice").hidden', 'review refresh finished');
  assert.equal(await evaluate('document.getElementById("collection-save").disabled'), true, 'paid earmark cannot become an unrelated collection');
  assert.ok(await evaluate('document.getElementById("collection-error").textContent.length'));
  await click('[data-target=all]');
  assert.equal(await getValue('#received'), '52,50');
  await page('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await until('document.getElementById("collection-save").disabled', 'offline save disabled');
  await page('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page('Page.reload', { ignoreCache: true });
  await until('document.getElementById("collection-form") && document.querySelector("h1")?.textContent.includes("Bălan David")', 'session, data and current screen persist on reload');
  assert.equal(snapshot().summary.balanceMinor, 15000);
  await until('navigator.serviceWorker.getRegistration().then(r => !!r?.active)', 'shared PWA worker installed');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  console.log('Browser checks passed: invitation/setup, logo upload, navigation, roster, expense editing before and after linked money, manual allocation, quick collection, lost-response retry across reauthentication, payment/refund/credit/correction, PDF report generation and sharing, stale-data protection, reload, offline protection, mobile/dark layout, and PWA worker.');
} finally {
  if (contextId) await send('Target.disposeBrowserContext', { browserContextId: contextId });
  socket.close();
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
