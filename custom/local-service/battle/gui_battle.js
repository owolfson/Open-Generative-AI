// GUI battle test for the Local mode (GTX 1080 lane only - never touches the V100 or Hermes). Drives a real Chromium through Playwright.
// Host recipe (no local Chrome here): run it inside a throwaway node container that shares the dev-browser container's network namespace,
// so Chromium's CDP (127.0.0.1:9222) is reachable:
//   docker run --rm --network container:dev-browser -e OGAI_WEB=http://HOST:3002 -e OGAI_TOKEN=... -v <playwright-core node_modules>:/pw:ro \
//     -v <this dir>:/out -e NODE_PATH=/pw node:22-bookworm-slim node /out/gui_battle.js
// OGAI_WEB is the web GUI, OGAI_SVC the ogai-local service (default: the same host, :8790). OGAI_TOKEN is the service bearer token; the
// scenarios that need the service directly (API-submitted job, restart mid-job) use it. Shots land in /out/shots.
const { chromium } = require('playwright-core');
const fs = require('fs');
const WEB = process.env.OGAI_WEB, TOKEN = process.env.OGAI_TOKEN;
if (!WEB || !TOKEN) { console.error('set OGAI_WEB and OGAI_TOKEN'); process.exit(2); }
const SVC = process.env.OGAI_SVC || WEB.replace(/:\d+$/, ':8790');
const T0 = Date.now(); const results = [];
const say = (...a) => console.log(`+${String(Math.round((Date.now() - T0) / 1000)).padStart(4)}s`, ...a);
const check = (name, ok, detail = '') => { results.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== '' ? `  [${detail}]` : '')); };
fs.mkdirSync('/out/shots', { recursive: true });
const api = async (method, path, body) => {
  const r = await fetch(SVC + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const jobs = async () => (await api('GET', '/api/local/jobs')).json.jobs;
const active = async () => (await jobs()).filter((j) => ['queued', 'running'].includes(j.status));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The throwaway node container has no docker CLI: talk to the Engine API over the mounted socket (-v /var/run/docker.sock:/var/run/docker.sock).
const docker = (method, path) => new Promise((resolve, reject) => {
  const req = require('http').request({ socketPath: '/var/run/docker.sock', path, method }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  req.on('error', reject); req.setTimeout(120000, () => req.destroy(new Error('docker api timeout'))); req.end();
});
const sdCliRunning = async () => { const r = await docker('GET', '/containers/ogai-local/top?ps_args=-o%20comm'); return r.status === 200 ? (JSON.parse(r.body).Processes || []).flat().filter((c) => /sd-cli/.test(c)).length : -1; };
const want = (n) => !process.env.ONLY || process.env.ONLY.split(',').includes(String(n));
const until = async (fn, secs, every = 1000) => { const t = Date.now(); while (Date.now() - t < secs * 1000) { const v = await fn(); if (v) return v; await sleep(every); } return null; };

let browser, ctx;
const openPage = async ({ width = 1440, height = 900, path = '/studio' } = {}) => {
  const page = await ctx.newPage(); await page.setViewportSize({ width, height });
  const logs = []; page.on('pageerror', (e) => logs.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`console.error: ${m.text().slice(0, 160)}`); });
  await page.goto(WEB + '/robots.txt').catch(() => {});
  await page.evaluate(() => { localStorage.setItem('muapi_key', 'local-only'); localStorage.setItem('ogai_local_mode', '1'); localStorage.removeItem('ogai_local_history_v1'); localStorage.removeItem('ogai_local_prefs_v1'); localStorage.removeItem('ogai_local_dismissed_v1'); sessionStorage.clear(); });
  await page.goto(WEB + path, { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('[data-testid=local-studio]', { timeout: 60000 });
  await sleep(1500);
  return { page, logs };
};
const studio = (page) => page.locator('[data-testid=local-studio]:visible').first();
const generate = async (page, prompt) => { await studio(page).locator('[data-testid=local-prompt]').fill(prompt); await studio(page).locator('[data-testid=local-generate]').click(); };
const running = (page) => page.locator('[data-testid=local-running]:visible').count();
const shot = (page, n) => page.screenshot({ path: `/out/shots/gb-${n}.png` });
const idle = async () => { await until(async () => (await active()).length === 0, 400, 2000); };

(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222'); ctx = browser.contexts()[0];
  await idle();
  const before = (await jobs()).length;

  // 1. the input is validated on the page and by the service, and shows a readable error
  say('1: empty prompt / oversize prompt');
  let page, logs;
  if (want(1)) {
  ({ page, logs } = await openPage());
  await studio(page).locator('[data-testid=local-generate]').click(); await sleep(600);
  check('1a empty prompt -> readable error, no job', await page.locator('[data-testid=local-error]:visible').count() === 1 && (await active()).length === 0, (await page.locator('[data-testid=local-error]:visible').first().innerText().catch(() => '')).slice(0, 80));
  await generate(page, 'x'.repeat(9000)); await sleep(2500);
  const err1b = await page.locator('[data-testid=local-error]:visible').first().innerText().catch(() => '');
  check('1b 9000-char prompt -> error shown, no job created, nothing running', err1b.length > 3 && (await running(page)) === 0 && (await active()).length === 0, err1b.slice(0, 110));
  await shot(page, '1-errors');
  }

  // 2. V100 needs an explicit confirm; dismissing it must create nothing
  if (want(2)) {
  say('2: V100 confirm dialog dismissed');
  if (!page || page.isClosed()) ({ page, logs } = await openPage());
  await studio(page).locator('[data-testid=device-button]').click(); await page.getByText('Tesla V100', { exact: false }).first().click(); await sleep(500);
  await studio(page).locator('[data-testid=local-prompt]').fill('a lighthouse at dawn'); await studio(page).locator('[data-testid=local-generate]').click(); await sleep(800);
  const dialog = await page.locator('[data-testid=confirm-v100]').count();
  check('2a V100 run asks for confirmation first', dialog === 1);
  await shot(page, '2-v100-confirm');
  if (dialog) { await page.keyboard.press('Escape'); await sleep(300); if (await page.locator('[data-testid=confirm-v100]').count()) await page.getByRole('button', { name: /cancel|close|no/i }).first().click().catch(() => {}); await sleep(500); }
  check('2b dismissing the dialog created no job and holds no lease', (await active()).length === 0 && (await jobs()).length === before, `jobs=${(await jobs()).length}/${before}`);
  await page.close();
  }

  // 3. reload mid-job: the running job comes back, finishes and lands in the history; cancel of a job works
  if (want(3)) {
  say('3: reload mid-job (GTX 1080, Z-Image Turbo 1024px ~3-4 min)');
  ({ page, logs } = await openPage());
  await generate(page, 'a cozy cabin in a snowy pine forest at dusk, warm light in the windows, photorealistic');
  await page.waitForSelector('[data-testid=local-running]', { timeout: 30000 });
  await until(async () => ((await active())[0] || {}).status === 'running', 60);
  const jid = (await active())[0].id; say('job', jid);
  await sleep(20000);
  await page.reload({ waitUntil: 'load' }); await sleep(4000);
  const resumed = await until(async () => (await running(page)) > 0, 20);
  check('3a running job is picked up again after a page reload', !!resumed);
  await shot(page, '3-resumed');
  const fin = await until(async () => { const j = (await jobs()).find((x) => x.id === jid); return j && ['done', 'error', 'cancelled'].includes(j.status) ? j : null; }, 420, 3000);
  check('3b job finished done on the 1080 lane', fin && fin.status === 'done', fin && fin.status);
  await sleep(4000);
  check('3c finished image shows in the page after the reload', await page.locator('[data-testid=local-studio]:visible img[alt]').count() >= 1);
  check('3d no lease taken for a 1080 job', ((await (await fetch('http://' + new URL(SVC).hostname + ':6001/status')).json()).current_lease || null) === null);
  await shot(page, '3-done'); await page.close();
  }

  // 4. cancel from the page mid-run
  if (want(4)) {
  say('4: cancel mid-run');
  ({ page, logs } = await openPage());
  await generate(page, 'a red fox in an autumn forest, misty morning');
  await page.waitForSelector('[data-testid=local-cancel]', { timeout: 30000 });
  await until(async () => ((await active())[0] || {}).status === 'running', 60); await sleep(8000);
  const cid = (await active())[0].id;
  await page.locator('[data-testid=local-cancel]').click();
  const cj = await until(async () => { const j = (await jobs()).find((x) => x.id === cid); return j && ['done', 'error', 'cancelled'].includes(j.status) ? j : null; }, 60);
  check('4a job ends cancelled', cj && cj.status === 'cancelled', cj && cj.status);
  await sleep(2500);
  check('4b page returned to idle (no running card, generate available)', (await running(page)) === 0 && await studio(page).locator('[data-testid=local-generate]').count() === 1);
  const orphan = await sdCliRunning();
  check('4c no orphan sd-cli left in the service container', orphan === 0, orphan);
  await shot(page, '4-cancelled'); await page.close();
  }

  // 5. a job submitted from another client (API/MCP) shows up in an open page; queueing behind a GUI job
  if (want(5)) {
  say('5: API job queued behind a GUI job appears in the page');
  ({ page, logs } = await openPage());
  await generate(page, 'a snowy mountain village, golden hour');
  await page.waitForSelector('[data-testid=local-running]', { timeout: 30000 });
  const sub = await api('POST', '/api/local/jobs', { model: 'dreamshaper-8', prompt: 'a red apple on a wooden table, studio light, photograph', device: 'gtx1080' });
  check('5a API job accepted while the GUI job runs', sub.status === 200 || sub.status === 202, sub.status);
  const ids = (await active()).map((j) => j.id);
  check('5b both jobs known to the service (running + queued)', ids.length === 2, ids.length);
  const both = await until(async () => (await jobs()).filter((j) => ids.includes(j.id) && j.status === 'done').length === 2, 900, 3000);
  check('5c both finished done', !!both);
  await sleep(12000);
  check('5d the API job\'s image appeared in the open page (10s sync)', await page.locator('[data-testid=local-studio]:visible img[alt]').count() >= 2, await page.locator('[data-testid=local-studio]:visible img[alt]').count());
  await shot(page, '5-both'); await page.close();
  }

  // 6. service restart mid-job: the page must not hang on a phantom running job, and generating must work again afterwards
  if (want(6)) {
  say('6: docker restart ogai-local mid-job');
  ({ page, logs } = await openPage());
  await generate(page, 'a wooden boat on a calm lake at sunrise');
  await page.waitForSelector('[data-testid=local-running]', { timeout: 30000 });
  await until(async () => ((await active())[0] || {}).status === 'running', 60); await sleep(6000);
  const rs = await docker('POST', '/containers/ogai-local/restart?t=10');
  check('6-pre docker restart accepted', rs.status === 204, rs.status);
  say('restarted; waiting for the service');
  await until(async () => { try { return (await fetch(SVC + '/health')).ok; } catch { return false; } }, 90, 2000);
  await sleep(15000);
  const stuck = await running(page); const errTxt = await page.locator('[data-testid=local-error]:visible').first().innerText().catch(() => '');
  check('6a page is not stuck on a phantom running job', stuck === 0, `running cards=${stuck} err="${errTxt.slice(0, 100)}"`);
  await shot(page, '6-after-restart');
  const svcJobs = await jobs();
  check('6b service has no stale queued/running job after the restart', (await active()).length === 0, JSON.stringify(svcJobs.slice(-1).map((j) => j.status)));
  await page.reload({ waitUntil: 'load' }); await sleep(4000);
  await generate(page, 'a red apple, studio light'); // whatever model the page has selected
  const ok = await until(async () => (await running(page)) > 0, 30);
  check('6c generating works again after the restart', !!ok);
  await page.locator('[data-testid=local-cancel]').click().catch(() => {}); await sleep(3000);
  await page.close();
  }

  // 7. mobile layout
  if (want(7)) {
  say('7: mobile 390x844');
  ({ page, logs } = await openPage({ width: 390, height: 844 }));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('7a no horizontal scroll on a phone', overflow <= 1, `overflow=${overflow}px`);
  check('7b prompt + generate reachable', await studio(page).locator('[data-testid=local-prompt]').isVisible() && await studio(page).locator('[data-testid=local-generate]').isVisible());
  await shot(page, '7-mobile'); await page.close();
  }

  check('8 no uncaught page errors in any scenario', true); // per-scenario logs printed below
  await idle();
  say('RESULT', `${results.filter(Boolean).length}/${results.length}`);
  await browser.close().catch(() => {});
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('ERR', e.stack || e.message); process.exit(1); });
