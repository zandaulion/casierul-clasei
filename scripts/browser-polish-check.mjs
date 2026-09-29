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
let app, socket, sessionId, sequence = 0, activeRole = '', checkedViews = 0;

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
async function viewport(width, height, theme) {
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
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
  await until('!document.getElementById("invite-form") && !document.getElementById("tabs").hidden', `${role} activated`);
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
async function checkTabs(role) {
  for (const theme of ['light', 'dark']) {
    for (const [width, height] of [[320, 700], [390, 844], [768, 1024], [1440, 900]]) {
      await viewport(width, height, theme);
      for (const tab of ['children', 'expenses', 'ledger', 'reports']) {
        await click(`[data-tab="${tab}"]`);
        await settle();
        const label = `${role}-${tab}-${width}-${theme}`;
        await checkLayout(label);
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
        if (width === 390 || (role === 'treasurer' && width === 1440 && theme === 'light')) await screenshot(label);
      }
    }
  }
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
  const dock = await evaluate('(() => { const element = document.querySelector(".collection-dock"), box = element.getBoundingClientRect(); return { position: getComputedStyle(element).position, top: box.top, bottom: box.bottom, height: innerHeight }; })()');
  if (dock.position === 'fixed') assert.ok(dock.top >= -1 && dock.bottom <= dock.height + 1, `${label}: fixed dock fits the viewport ${JSON.stringify(dock)}`);
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
async function checkCollection(ana) {
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
    for (const [width, height, scale] of [[320, 480, 1], [390, 844, 1], [768, 1024, 1], [1440, 900, 1], [390, 520, 2]]) {
      await viewport(width, height, theme);
      if (scale > 1) await scaleText(scale);
      const label = `collection-${width}x${height}-${theme}-${scale}x-text`;
      await checkDock(label);
      await screenshot(label);
      if (scale > 1) await restoreText();
    }
  }
}

try {
  app = await start({ dataDir: temporary, publicBaseUrl: origin, port: 18028, adminPort: 0,
    adminToken: 'polish-test-only', cookieSecure: false });
  const { ana } = seed();
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
    if (role === 'treasurer') await checkCollection(ana);
    if (role === 'auditor') {
      await click('[data-tab=children]'); await click(`[data-child="${ana}"]`);
      assert.equal(await evaluate('!document.getElementById("tabs").hidden && !document.querySelector(".app").classList.contains("collecting")'), true, 'auditor child keeps navigation');
      await checkLayout('auditor-child-detail');
      await screenshot('auditor-child-detail');
    }
    if (role !== 'treasurer') {
      await viewport(390, 600, 'light');
      if (role === 'parent') await click('[data-tab=children]');
      await scaleText(2);
      await checkLayout(`${role}-child-2x-text`);
      await screenshot(`${role}-child-2x-text`);
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
  console.log(`Polish browser checks passed: ${checkedViews} tab/role/viewport/theme combinations, change and credit summaries, accessible collection panel on short screens and at 200% text, parent/auditor navigation, assets, and no exceptions. ${screenshots.length} screenshots saved to /tmp/casierul-polish-*.png.`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    for (const browserContextId of contexts) await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    socket.close();
  }
  await app?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
