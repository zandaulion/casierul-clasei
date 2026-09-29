import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { start } from '../server/index.mjs';

// This check owns its temporary databases and isolated browser contexts. It never
// uses the installed service, existing browser tabs, or production invitations.
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'casierul-polish-'));
const origin = 'http://127.0.0.1:18028';
const actor = { id: 'polish-fixture', label: 'Date sintetice pentru verificare' };
const contexts = new Set(), pending = new Map(), exceptions = [], failedAssets = [];
const loadedAssets = new Set(), screenshots = [];
const viewports = [[320, 700], [390, 844], [768, 1024], [834, 1194], [1024, 768],
  [1280, 720], [1366, 768], [1440, 900], [1920, 1080]];
let app, socket, sessionId, sequence = 0, activeRole = '', checkedViews = 0, pdfResponses = 0;

function send(method, params = {}, session) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
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
async function until(expression, label = expression, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    try { if (await evaluate(expression)) return; }
    catch (error) { if (!/context|navigat/i.test(error.message)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}\n${await evaluate('document.body.innerText')}`);
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const fill = (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  input.value = ${JSON.stringify(value)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function screenshot(name) {
  const filename = `/tmp/casierul-polish-${name}.png`;
  const { data } = await page('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(filename, Buffer.from(data, 'base64'));
  screenshots.push(filename);
}
async function viewport(width, height, theme, deviceScaleFactor = 1) {
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: width < 768 });
  await page('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' },
  ] });
  await settle();
}
function seed() {
  const post = (operation, fields) => app.ledger.dispatch(operation, {
    requestId: randomUUID(), expectedRevision: app.ledger.getState().revision, ...fields,
  }, actor);
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  post('settings.update', { schoolName: 'Școala demonstrativă', className: 'III A', schoolYear: '2026–2027',
    openingBalanceMinor: 5000, schoolLogo: logo, classLogo: logo });
  post('children.create', { children: [
    { lastName: 'Avram', firstName: 'Ana' }, { lastName: 'Bălan', firstName: 'David' },
    { lastName: 'Constantinescu-Popescu', firstName: 'Alexandru-Gabriel' },
    { lastName: 'Dumitrescu', firstName: 'Ioana' }, { lastName: 'Șerban', firstName: 'Mara' },
    { lastName: 'Țepeș', firstName: 'Vlad' },
  ] });
  const children = app.ledger.getState().children;
  const participants = children.map(child => ({ childId: child.id }));
  const expense = fields => {
    post('expense.create', { participants, ...fields });
    return app.ledger.getState().expenses.find(item => item.title === fields.title).id;
  };
  const photos = expense({ title: 'Fotografii de clasă', type: 'fixed', amountMinor: 3000, dueDate: '2026-10-10' });
  const museum = expense({ title: 'Vizită la muzeu și atelier de explorare', type: 'split', amountMinor: 36000, dueDate: '2026-10-25' });
  const materials = expense({ title: 'Materiale pentru atelier', type: 'quantity', amountMinor: 3750,
    participants: participants.map(item => ({ ...item, quantity: 1 })), dueDate: '2026-11-01' });
  const ana = children.find(child => child.firstName === 'Ana').id;
  const david = children.find(child => child.firstName === 'David').id;
  post('collection.create', { childId: david, receivedMinor: 15000, changeMinor: 0,
    allocations: [{ expenseId: photos, amountMinor: 3000 }, { expenseId: museum, amountMinor: 6000 },
      { expenseId: materials, amountMinor: 3750 }] });
  post('collection.create', { childId: children.find(child => child.firstName === 'Ioana').id,
    receivedMinor: 3000, changeMinor: 0, allocations: [{ expenseId: photos, amountMinor: 3000 }] });
  post('payment.create', { expenseId: photos, amountMinor: 5000, destination: 'Fotograful clasei', comment: 'Prima tranșă' });
  post('fund_advance.create', { amountMinor: 5000, person: 'Casier demonstrativ', expenseId: museum });
  return { ana, david, photos };
}
async function openRole(role, childId) {
  activeRole = role;
  const invite = app.auth.createInvite(`Verificare aspect: ${role}`, {
    classroomId: 'default', role, ...(role === 'parent' ? { childId } : {}),
  });
  const { browserContextId } = await send('Target.createBrowserContext');
  contexts.add(browserContextId);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await page('Page.enable'); await page('Runtime.enable'); await page('Network.enable');
  await page('Network.setCacheDisabled', { cacheDisabled: true });
  await page('Network.setBypassServiceWorker', { bypass: true });
  await viewport(390, 844, 'light');
  await page('Page.navigate', { url: `${origin}/?invite=${invite.code}` });
  await until('document.getElementById("invite-form")');
  await fill('#invite-form [name=code]', invite.code);
  await click('#invite-form button[type=submit]');
  await until('!document.getElementById("invite-form") && document.getElementById("tabs")?.hidden === false', `${role} activated`);
  await until('[...document.querySelectorAll(".header-logos img:not([hidden])")].length === 2 && [...document.querySelectorAll(".header-logos img:not([hidden])")].every(image => image.complete && image.naturalWidth > 0)', 'branding images loaded');
  await evaluate('document.fonts.ready.then(() => true)');
  return browserContextId;
}
async function checkLayout(label, { navigation = true } = {}) {
  await until('[...document.images].filter(image => image.getClientRects().length).every(image => image.complete)', `${label}: images finished loading`);
  const layout = await evaluate(`(() => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
    const rect = element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; };
    return {
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      overflow: [...document.querySelectorAll('#main button, .collection-dock button, .collection-dock-summary')]
        .filter(visible).filter(element => element.scrollWidth > element.clientWidth + 2)
        .map(element => ({ text: element.textContent.trim(), width: element.clientWidth, content: element.scrollWidth })),
      tabsHidden: document.getElementById('tabs').hidden,
      tabsFit: [...document.querySelectorAll('#tabs button')].every(element => { const box = rect(element); return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1; }),
      brokenImages: [...document.images].filter(visible).filter(image => !image.complete || !image.naturalWidth).map(image => image.src),
    };
  })()`);
  assert.ok(layout.documentWidth <= layout.width + 1, `${label}: horizontal page overflow ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.overflow, [], `${label}: clipped control text`);
  assert.deepEqual(layout.brokenImages, [], `${label}: failed image`);
  if (navigation) {
    assert.equal(layout.tabsHidden, false, `${label}: navigation is available`);
    assert.equal(layout.tabsFit, true, `${label}: navigation fits the viewport`);
  }
}
async function checkAdaptiveGeometry(role, tab, width, label) {
  const geometry = await evaluate(`(() => {
    const rect = selector => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const firstPair = selector => [...document.querySelectorAll(selector)].slice(0, 2).map(element => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom };
    });
    return { app: rect('.app'), main: rect('#main'), nav: rect('#tabs'),
      children: firstPair('.children > .child'), expenses: firstPair('.expense-grid > .expense-card'),
      reports: firstPair('.report-types > .report-type'),
      ledger: [rect('.ledger-overview'), rect('.ledger-history')],
      child: [rect('.child-overview'), rect('.child-contributions')] };
  })()`);
  const columns = (pair, description) => {
    assert.equal(pair.length, 2, `${label}: ${description} has two populated sections`);
    assert.ok(pair.every(Boolean), `${label}: ${description} sections exist`);
    assert.ok(pair[0].right <= pair[1].left + 1, `${label}: ${description} uses separate columns ${JSON.stringify(pair)}`);
  };
  if (width >= 720) {
    if (tab === 'children' && role !== 'parent') columns(geometry.children, 'class roster');
    if (tab === 'expenses') columns(geometry.expenses, 'expenses');
    if (tab === 'reports' && role === 'treasurer') columns(geometry.reports, 'report choices');
  }
  if (width >= 1000) {
    if (tab === 'ledger') columns(geometry.ledger, 'fund summary and history');
    if (tab === 'children' && role === 'parent') columns(geometry.child, 'child summary and contributions');
  }
  if (width >= 1120) {
    assert.ok(geometry.nav.right <= geometry.main.left + 1, `${label}: navigation is beside the content`);
    assert.ok(geometry.nav.height > geometry.nav.width, `${label}: navigation runs vertically`);
    assert.ok(geometry.app.width > 1000, `${label}: the shell makes use of the wider screen`);
  } else {
    assert.ok(geometry.nav.width > geometry.nav.height, `${label}: compact navigation stays horizontal`);
  }
}
async function checkTabs(role) {
  for (const theme of ['light', 'dark']) {
    for (const [width, height] of viewports) {
      await viewport(width, height, theme);
      for (const tab of ['children', 'expenses', 'ledger', 'reports']) {
        await click(`[data-tab="${tab}"]`);
        await settle();
        const label = `${role}-${tab}-${width}-${theme}`;
        await checkLayout(label);
        await checkAdaptiveGeometry(role, tab, width, label);
        assert.equal(await evaluate(`document.querySelector('[data-tab="${tab}"]').getAttribute('aria-current')`), 'page', `${label}: active tab`);
        if (tab === 'children' && role === 'parent') {
          assert.equal(await evaluate('!!document.querySelector(".parent-summary") && !document.getElementById("child-search")'), true, 'parent lands directly on own child');
          assert.match(await evaluate('document.querySelector("#main h1").textContent'), /Ana/u);
          assert.equal(await evaluate('document.getElementById("main").textContent.includes("David")'), false, 'parent does not see another child');
          assert.equal(await evaluate('document.querySelector(".app").classList.contains("collecting")'), false, 'read-only child does not use collection layout');
        }
        if (tab === 'children' && role === 'treasurer') assert.equal(await evaluate('!!document.querySelector(".welcome-banner")'), true, 'treasurer sees class overview');
        if (tab === 'expenses') assert.ok(await evaluate('document.querySelectorAll(".expense-progress").length > 0'), `${label}: expense progress is shown`);
        if (role !== 'treasurer') assert.equal(await evaluate('!!document.querySelector("#collection-save, [data-action=add-child], [data-action=payment], [data-action=report-class]")'), false, `${label}: no write controls`);
        checkedViews++;
        if (width === 390 || (role === 'treasurer' && [768, 1024, 1366, 1920].includes(width) && theme === 'light')) await screenshot(label);
      }
    }
  }
}
async function checkAdaptivePdf(reportId) {
  const reportSelector = `[data-action="view-report"][data-id="${reportId}"]`;
  const downloadsBefore = pdfResponses;
  const ready = 'document.querySelector("#pdf-preview-status").hidden && document.querySelectorAll("#pdf-preview-pages figure[data-rendered=true]").length === document.querySelectorAll("#pdf-preview-pages figure").length && document.querySelectorAll("#pdf-preview-pages figure").length > 0';
  const sharp = `(() => {
    const canvases = [...document.querySelectorAll('#pdf-preview-pages canvas')];
    const ratio = Math.min(devicePixelRatio || 1, 2);
    return canvases.length > 0 && canvases.every(canvas => Math.abs(canvas.width - canvas.getBoundingClientRect().width * ratio) <= 1.5);
  })()`;
  await viewport(390, 844, 'light');
  await click('[data-tab=reports]');
  await click(reportSelector);
  await until(ready, 'first PDF render', 400);
  await until(sharp, 'first PDF sharp render');
  const narrowWidth = await evaluate('document.querySelector("#pdf-preview-pages canvas").getBoundingClientRect().width');
  const pageCount = await evaluate('document.querySelectorAll("#pdf-preview-pages figure").length');
  for (const [width, height, density = 1] of [[1366, 768, 2], [1024, 768], [834, 1194], [1194, 834], [320, 700], [1440, 900]]) {
    await viewport(width, height, 'light', density);
    const scrollTop = await evaluate('document.querySelector("#dialog").scrollTop');
    await until(sharp, `PDF sharp render at ${width}px and ${density}x density`, 400);
    assert.ok(Math.abs(await evaluate('document.querySelector("#dialog").scrollTop') - scrollTop) <= 2, 'PDF repaint preserves the dialog scroll position');
    assert.equal(await evaluate('document.querySelectorAll("#pdf-preview-pages figure").length'), pageCount, 'PDF resizing never duplicates page containers');
    assert.equal(await evaluate('document.querySelectorAll("#pdf-preview-pages canvas").length'), pageCount, 'PDF preview keeps one canvas per page');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth && document.querySelector("#dialog").scrollWidth <= document.querySelector("#dialog").clientWidth'), true, 'PDF preview fits the viewport without horizontal scrolling');
    if (width === 1366) assert.ok(await evaluate('document.querySelector("#pdf-preview-pages canvas").getBoundingClientRect().width') > narrowWidth * 2, 'PDF preview uses the available laptop width');
    await evaluate('document.querySelector("#dialog").scrollTop = 250');
  }
  assert.equal(pdfResponses - downloadsBefore, 1, 'resizing reuses the loaded PDF without another download');
  await screenshot('adaptive-pdf-desktop');
  // Close during pending resize work, reopen, then close another preview while
  // it is loading. Disposed renderers must never modify a later dialog.
  for (const [width, height] of [[900, 700], [1100, 750], [768, 1024]]) await viewport(width, height, 'light');
  await click('#dialog .dialog-actions [data-action=close-modal]');
  await until('!document.querySelector("#dialog").open');
  await new Promise(resolve => setTimeout(resolve, 250));
  await click(reportSelector);
  await until(ready, 'reopened PDF preview', 400);
  await until(sharp, 'reopened PDF sharp render', 400);
  assert.equal(pdfResponses - downloadsBefore, 2, 'reopening downloads the PDF once');
  await click('#dialog .dialog-actions [data-action=close-modal]');
  await until('!document.querySelector("#dialog").open');
  await click(reportSelector);
  await click('#dialog .dialog-actions [data-action=close-modal]');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await evaluate('document.querySelector("#dialog").open'), false, 'canceled PDF load leaves the dialog closed');
  assert.deepEqual(exceptions, [], 'PDF resize, close and canceled loads cause no browser errors');
  await click('[data-tab=children]');
}
async function scaleText(factor) {
  await evaluate(`(() => {
    window.__polishTextSizes = [...document.querySelectorAll('body, body *')].map(element => {
      const style = getComputedStyle(element);
      return { element, fontSize: element.style.fontSize, lineHeight: element.style.lineHeight,
        pixels: parseFloat(style.fontSize), line: parseFloat(style.lineHeight) };
    });
    for (const item of window.__polishTextSizes) {
      item.element.style.fontSize = (item.pixels * ${factor}) + 'px';
      if (Number.isFinite(item.line)) item.element.style.lineHeight = (item.line * ${factor}) + 'px';
    }
  })()`);
  await settle();
}
async function restoreText() {
  await evaluate('for (const item of window.__polishTextSizes || []) { item.element.style.fontSize = item.fontSize; item.element.style.lineHeight = item.lineHeight; }');
  await settle();
}
async function checkDock(label) {
  await checkLayout(label, { navigation: false });
  assert.equal(await evaluate('document.getElementById("tabs").hidden'), true, 'treasurer collection keeps its focused layout');
  const dock = await evaluate('(() => { const element = document.querySelector(".collection-dock"), box = element.getBoundingClientRect(), choices = document.querySelector("[data-target]").getBoundingClientRect(); return { position: getComputedStyle(element).position, left: box.left, top: box.top, bottom: box.bottom, height: innerHeight, width: innerWidth, choicesRight: choices.right }; })()');
  if (dock.position === 'fixed') assert.ok(dock.top >= -1 && dock.bottom <= dock.height + 1, `${label}: fixed dock fits the viewport ${JSON.stringify(dock)}`);
  if (dock.width >= 1000) {
    assert.notEqual(dock.position, 'fixed', `${label}: the wide payment panel participates in the page layout`);
    assert.ok(dock.left >= dock.choicesRight - 1, `${label}: contributions and payment panel occupy separate columns ${JSON.stringify(dock)}`);
  }
  // Short screens may scroll within the action panel or put it in normal page
  // flow. Each control must remain reachable without another layer covering it.
  for (const selector of ['#received', '[data-excess=change]', '[data-excess=credit]', '#collection-save']) {
    const reachable = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'nearest' });
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.top >= -1 && box.bottom <= innerHeight + 1 && (hit === element || element.contains(hit));
    })()`);
    assert.equal(reachable, true, `${label}: ${selector} remains reachable`);
  }
}
const collectionDraft = () => evaluate(`(() => ({
  amount: document.querySelector('#received').value,
  target: document.querySelector('[data-target][aria-pressed=true]')?.dataset.target || null,
  excess: document.querySelector('[data-excess][aria-pressed=true]')?.dataset.excess,
  manual: document.querySelector('#manual').checked,
  allocations: [...document.querySelectorAll('[data-allocation]')].map(input => ({
    expense: input.dataset.allocation, value: input.value, readOnly: input.readOnly,
  })),
  date: document.querySelector('#collection-date').value,
  comment: document.querySelector('#collection-comment').value,
  summary: document.querySelector('#collection-dock-summary').textContent,
  save: document.querySelector('#collection-save').textContent,
}))()`);
async function checkDraftResizing(photos) {
  await viewport(390, 844, 'light');
  await click(`[data-target="${photos}"]`);
  await fill('#received', '45.50');
  await fill('#collection-comment', 'Schiță păstrată la rotirea tabletei');
  await fill('#collection-date', '2026-09-29T17:30');
  const singleExpense = await collectionDraft();
  assert.equal(singleExpense.target, photos, 'draft has a selected contribution');
  assert.equal(singleExpense.amount, '45.50', 'draft has a typed amount including bani');
  for (const [width, height] of [[834, 1194], [1194, 834], [1366, 768], [768, 1024], [390, 844]]) {
    await evaluate('document.querySelector("#received").focus()');
    await viewport(width, height, 'light');
    assert.deepEqual(await collectionDraft(), singleExpense, `selected contribution, amount and details survive resizing to ${width}x${height}`);
    assert.equal(await evaluate('document.activeElement.id'), 'received', 'resizing preserves the focused amount input');
    await checkDock(`selected-contribution-resize-${width}`);
  }
  await evaluate('document.querySelector("#allocation-details").open = true');
  await click('#manual');
  const allocations = await evaluate('[...document.querySelectorAll("[data-allocation]")].map(input => input.dataset.allocation)');
  for (const id of allocations) await fill(`[data-allocation="${id}"]`, '0');
  await fill(`[data-allocation="${photos}"]`, '12.50');
  await fill(`[data-allocation="${allocations.find(id => id !== photos)}"]`, '10');
  const manualExpense = await collectionDraft();
  assert.equal(manualExpense.manual, true, 'draft has manual allocations');
  assert.ok(manualExpense.allocations.every(input => !input.readOnly), 'manual allocation fields are editable');
  for (const [width, height] of [[1280, 600], [1024, 768], [768, 1024], [320, 700], [1366, 768]]) {
    await viewport(width, height, 'dark');
    assert.deepEqual(await collectionDraft(), manualExpense, `manual allocations and typed details survive resizing to ${width}x${height}`);
    await checkDock(`manual-contribution-resize-${width}`);
  }
  await evaluate('document.querySelector("#received").focus()');
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate('document.activeElement.dataset.excess'), 'change', 'keyboard focus moves from amount to the change choice');
  assert.equal(await evaluate('(() => { const element = document.activeElement, box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return box.top >= 0 && box.bottom <= innerHeight && (hit === element || element.contains(hit)); })()'), true, 'keyboard focus is visible within the wide payment panel');
}
async function checkCollection(ana, photos) {
  await click('[data-tab=children]'); await click(`[data-child="${ana}"]`);
  await fill('#received', '150');
  const summaryText = () => evaluate('document.querySelector("#collection-dock-summary").textContent.replace(/\\s+/g, " ")');
  const assertAmounts = (text, values, label) => {
    for (const value of values) assert.match(text, new RegExp(`(?:^|[^\\d])${value}(?:0)?(?:[^\\d]|$)`), `${label}: ${text}`);
  };
  assert.equal(await evaluate('document.getElementById("received").value'), '150', 'received amount remains visible');
  assertAmounts(await summaryText(), ['127[,.]5', '0'], 'covered and remaining amounts beside confirmation');
  const selectedExcess = () => evaluate('document.querySelector("[data-excess][aria-pressed=true]").textContent');
  assertAmounts(await selectedExcess(), ['22[,.]5'], 'change amount beside confirmation');
  assert.match(await selectedExcess(), /rest/iu, 'change is the selected outcome');
  assertAmounts(await evaluate('document.getElementById("collection-save").textContent'), ['127[,.]5'], 'net collection excludes returned change');
  await click('[data-excess=credit]');
  assertAmounts(await summaryText(), ['127[,.]5', '0'], 'retained credit does not change covered contributions');
  assertAmounts(await selectedExcess(), ['22[,.]5'], 'credit amount beside confirmation');
  assert.match(await selectedExcess(), /avans/iu, 'new credit is the selected outcome');
  assertAmounts(await evaluate('document.getElementById("collection-save").textContent'), ['150'], 'net collection includes retained credit');
  for (const theme of ['light', 'dark']) {
    for (const [width, height, scale] of [[320, 480, 1], [390, 844, 1], [768, 1024, 1], [834, 1194, 1],
      [1024, 768, 1], [1280, 600, 1], [1366, 768, 1], [1920, 1080, 1], [390, 520, 2], [1280, 600, 2]]) {
      await viewport(width, height, theme);
      if (scale > 1) await scaleText(scale);
      const label = `collection-${width}x${height}-${theme}-${scale}x-text`;
      await checkDock(label);
      await screenshot(label);
      if (scale > 1) await restoreText();
    }
  }
  await checkDraftResizing(photos);
}

try {
  app = await start({ dataDir: temporary, publicBaseUrl: origin, port: 18028, adminPort: 0,
    adminToken: 'polish-test-only', cookieSecure: false });
  const { ana, photos } = seed();
  await app.ledger.createReport({ requestId: randomUUID(), type: 'class' }, actor);
  await app.ledger.createReport({ requestId: randomUUID(), type: 'child', subjectId: ana }, actor);
  const before = app.ledger.getState();
  const browser = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  socket = new WebSocket(browser.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.sessionId === sessionId) {
      if (message.method === 'Runtime.exceptionThrown') exceptions.push({ role: activeRole, ...message.params.exceptionDetails });
      if (message.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
      if (message.method === 'Network.responseReceived') {
        const { type, response } = message.params;
        if (new URL(response.url).pathname.endsWith('/pdf')) pdfResponses++;
        if (['Script', 'Stylesheet', 'Image', 'Font'].includes(type)) {
          loadedAssets.add(new URL(response.url).pathname);
          if (response.status >= 400) failedAssets.push({ role: activeRole, type, url: response.url, status: response.status });
        }
      }
      if (message.method === 'Network.loadingFailed' && !message.params.canceled && ['Script', 'Stylesheet', 'Image', 'Font'].includes(message.params.type)) failedAssets.push({ role: activeRole, ...message.params });
    }
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer); pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  };
  for (const role of ['treasurer', 'parent', 'auditor']) {
    const context = await openRole(role, ana);
    await checkTabs(role);
    if (role === 'treasurer') {
      await checkAdaptivePdf(before.reports.find(report => report.type === 'class').id);
      await checkCollection(ana, photos);
    }
    if (role === 'auditor') {
      await click('[data-tab=children]'); await click(`[data-child="${ana}"]`);
      assert.equal(await evaluate('!document.getElementById("tabs").hidden && !document.querySelector(".app").classList.contains("collecting")'), true, 'auditor child keeps navigation');
      await checkLayout('auditor-child-detail');
      await screenshot('auditor-child-detail');
    }
    if (role !== 'treasurer') {
      if (role === 'parent') await click('[data-tab=children]');
      for (const [width, height] of [[390, 600], [1280, 720]]) {
        await viewport(width, height, 'light');
        await scaleText(2);
        await checkLayout(`${role}-child-${width}-2x-text`);
        await screenshot(`${role}-child-${width}-2x-text`);
        await restoreText();
      }
    }
    await click('[data-tab=reports]');
    for (const [width, height] of [[320, 700], [1280, 600]]) {
      await viewport(width, height, 'light');
      await scaleText(2);
      await checkLayout(`${role}-reports-${width}-2x-text`);
      await screenshot(`${role}-reports-${width}-2x-text`);
      await restoreText();
    }
    console.log(`Polish views passed for ${role}.`);
    await send('Target.disposeBrowserContext', { browserContextId: context });
    contexts.delete(context); sessionId = null;
  }
  assert.ok(loadedAssets.has('/app.js') && loadedAssets.has('/styles.css'), 'application script and stylesheet loaded');
  assert.deepEqual(failedAssets, [], 'all requested UI assets loaded');
  assert.deepEqual(exceptions, [], 'no browser exceptions');
  assert.deepEqual(app.ledger.getState(), before, 'appearance checks never change ledger values');
  console.log(`Polish browser checks passed: ${checkedViews} tab/role/viewport/theme combinations, tablet columns and laptop navigation, adaptive PDF rendering and cleanup, change and credit summaries, accessible collection panel on short screens and at 200% text, drafts retained across resizing, keyboard focus, parent/auditor navigation, assets, and no exceptions. ${screenshots.length} screenshots saved to /tmp/casierul-polish-*.png.`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    for (const browserContextId of contexts) await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    socket.close();
  }
  await app?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
