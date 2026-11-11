// Chrome E2E against dist/chrome: WebRTC, kill switch, and a toggle racing a health check.
// Run: npm run build:chrome && npm run e2e:chrome
//
// Branded Chrome (stable, Dev) ignores --load-extension, so selenium downloads Chrome for Testing
// (Dev channel), which still honours it. CHROME_BIN points at another unbranded build instead,
// and CHROMEDRIVER_BIN at its matching driver.
// Leak detection: --host-resolver-rules maps fixture.e2e to 127.0.0.1, so a request that goes
// direct reaches the `direct` server. Through the SOCKS server the same host reaches `proxied`.
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Builder, type WebDriver } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
// @ts-expect-error plain .mjs script without types
import { createSocksServer } from '../../scripts/socks5-server.mjs';

const DIST = resolve('dist/chrome');
let ID = '';
const HOST = 'fixture.e2e';

// A page that gathers its WebRTC candidates, then sets its title to "done".
const FIXTURE = `<!doctype html><title>fixture</title><script>
const found = [];
const finish = () => { window.candidates = found; document.title = 'done'; };
try {
  const pc = new RTCPeerConnection();
  pc.createDataChannel('x');
  pc.onicecandidate = (e) => (e.candidate ? found.push(e.candidate.candidate) : finish());
  pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
  setTimeout(finish, 4000);
} catch { finish(); }
</script>`;

// A page that fakes the bridge's handshake to learn the private event name, then sends its own
// config. It must never get the name.
const FORGE = `<!doctype html><title>forge</title><script>
let n = null;
addEventListener('__nl__', (e) => { try { const h = JSON.parse(e.detail); if (h.k === 'main') n = h.n; } catch {} });
dispatchEvent(new CustomEvent('__nl__', { detail: '{"k":"bridge"}' }));
if (n) dispatchEvent(new CustomEvent(n, { detail: JSON.stringify({ prelude: null, config: {
  active: true, timezone: 'Pacific/Kiritimati', locale: 'en-US', languages: ['en-US'], shields: { timezone: true } } }) }));
window.result = { name: n, zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
document.title = 'done';
</script>`;

// A captcha-provider page (served through the SOCKS server): the timezone at first parse and later.
// On the captcha list but not HSTS preloaded (cloudflare.com is), so plain HTTP loads.
const CAPTCHA_HOST = 'geo.captcha-delivery.com';
const CAPTCHA = `<!doctype html><title>captcha</title><script>
window.first = Intl.DateTimeFormat().resolvedOptions().timeZone;
setTimeout(() => { window.later = Intl.DateTimeFormat().resolvedOptions().timeZone; document.title = 'done'; }, 1500);
</script>`;
const ZONE = 'Pacific/Kiritimati';

// What the first inline script and an iframe it creates at once see (B6, B7).
const STARTUP = `<!doctype html><title>startup</title><script>
const frame = document.createElement('iframe');
document.documentElement.append(frame);
window.result = {
  page: Intl.DateTimeFormat().resolvedOptions().timeZone,
  frame: frame.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone,
};
document.title = 'done';
</script>`;
const REAL = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Cloudflare allows blob workers but blocks importing blob scripts inside them.
const BLOB_WORKER = `<!doctype html><title>blob worker</title><script nonce="fixture">
const finish = (result) => { window.result = result; document.title = 'done'; };
const timeout = setTimeout(() => finish({ error: 'worker timed out' }), 8000);
const trusted = new URL(location.href).searchParams.has('trusted');
const policy = trusted ? trustedTypes.createPolicy('fixture', { createScriptURL: (url) => url }) : null;
if (trusted) trustedTypes.createPolicy('default', { createScriptURL: () => '' });
function start() {
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== '${ZONE}') return setTimeout(start, 20);
  const source = new Blob(['postMessage({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, href: location.href });'], { type: 'text/javascript' });
  window.originalUrl = URL.createObjectURL(source);
  let worker;
  try {
    worker = new Worker(policy ? policy.createScriptURL(window.originalUrl) : window.originalUrl);
  } catch (e) {
    // The startup state refuses workers until the config arrives, even when the zone is already right (B6).
    if (e.name === 'SecurityError') return setTimeout(start, 20);
    throw e;
  }
  worker.onmessage = (e) => { clearTimeout(timeout); finish(e.data); worker.terminate(); };
  worker.onerror = (e) => { clearTimeout(timeout); finish({ error: e.message }); worker.terminate(); };
  URL.revokeObjectURL(window.originalUrl);
}
start();
</script>`;

function server(body: string) {
  const s = { hits: 0, server: null as unknown as Server };
  s.server = createServer((req, res) => {
    s.hits++;
    res.setHeader('content-type', 'text/html');
    if (req.url?.startsWith('/blob-worker')) {
      res.setHeader(
        'content-security-policy',
        "script-src 'nonce-fixture'; worker-src blob:" +
          (req.url.includes('trusted')
            ? "; trusted-types fixture default; require-trusted-types-for 'script'"
            : ''),
      );
      res.end(BLOB_WORKER);
    } else if (req.url?.startsWith('/startup')) res.end(STARTUP);
    else res.end(req.url?.startsWith('/forge') ? FORGE : body);
  });
  return s;
}
const listen = (s: Server) =>
  new Promise<number>((ok) =>
    s.listen(0, '127.0.0.1', () => ok((s.address() as AddressInfo).port)),
  );

const direct = server('direct');
const proxied = server(FIXTURE);
const captcha = server(CAPTCHA);
let captchaUrl = '';
const sockets = new Set<Socket>();
let socks: Server;
let url = '';
let driver: WebDriver;

const profile = mkdtempSync(join(tmpdir(), 'noleaker-chrome-'));

/** The ID Chrome gave the unpacked extension, read from the profile's preference files. */
function extensionId(): string {
  for (const file of ['Secure Preferences', 'Preferences']) {
    const path = join(profile, 'Default', file);
    if (!existsSync(path)) continue;
    const settings = JSON.parse(readFileSync(path, 'utf8')).extensions?.settings ?? {};
    for (const [id, e] of Object.entries(settings))
      if ((e as { path?: string }).path === DIST) return id;
  }
  return '';
}

async function launch(): Promise<WebDriver> {
  const options = new chrome.Options();
  options.addArguments(
    '--headless=new',
    `--user-data-dir=${profile}`,
    `--load-extension=${DIST}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    '--no-first-run',
  );
  // Ubuntu runners block the unprivileged user namespaces Chrome's sandbox needs.
  if (process.env.CI) options.addArguments('--no-sandbox');
  if (process.env.CHROME_BIN) options.setChromeBinaryPath(process.env.CHROME_BIN);
  else {
    process.env.SE_FORCE_BROWSER_DOWNLOAD ??= 'true';
    process.env.SE_BROWSER_VERSION ??= 'dev';
  }
  const builder = new Builder().forBrowser('chrome').setChromeOptions(options);
  // CI runners put an older chromedriver on PATH; use the one that matches CHROME_BIN.
  if (process.env.CHROMEDRIVER_BIN)
    builder.setChromeService(new chrome.ServiceBuilder(process.env.CHROMEDRIVER_BIN));
  const d = await builder.build();
  const end = Date.now() + 15_000;
  while (!(ID = extensionId()) && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
  if (!ID) {
    const caps = await d.getCapabilities();
    await d.quit();
    throw new Error(
      `${caps.getBrowserName()} ${caps.getBrowserVersion()} did not load the extension from ${DIST}`,
    );
  }
  return d;
}

/** Run `body` (async code using `chrome`) on an extension page. */
async function ext<T>(body: string): Promise<T> {
  await driver.get(`chrome-extension://${ID}/options/index.html`);
  const out = await driver.executeAsyncScript<string>(`
    const done = arguments[arguments.length - 1];
    (async () => { ${body} })().then(
      (v) => done(JSON.stringify({ v })),
      (e) => done(JSON.stringify({ e: String(e) })),
    );`);
  const r = JSON.parse(out) as { v?: T; e?: string };
  if (r.e) throw new Error(r.e);
  return r.v as T;
}

const state = () =>
  ext<Record<string, unknown>>(`return (await chrome.storage.local.get('state')).state;`);

async function until(what: string, check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  const dump = await ext(`const { state, log } = await chrome.storage.local.get(['state', 'log']);
    const { profiles, ...rest } = state ?? {};
    return { state: rest, log: (log ?? []).map((l) => l.level + ': ' + l.msg) };`).catch(
    (err: Error) => `unavailable: ${err.message}`,
  );
  throw new Error(
    `Timed out waiting for: ${what} (direct hits: ${direct.hits})\n${JSON.stringify(dump, null, 2)}`,
  );
}

const verified = () =>
  until('proxy on and controls verified', async () => {
    const s = await state();
    return s.enabled === true && !!s.controlsVerifiedAt && !s.protectionError;
  });

/** Load the fixture a few times; a refused load is fine, only where it goes matters. */
async function browse(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await driver.get(`${url}?n=${i}`).catch(() => undefined);
}

before(async () => {
  const proxiedPort = await listen(proxied.server);
  const directPort = await listen(direct.server);
  const captchaPort = await listen(captcha.server);
  captchaUrl = `http://${CAPTCHA_HOST}:${captchaPort}/`;
  url = `http://${HOST}:${directPort}/`;
  socks = createSocksServer({
    route: (host: string, port: number) =>
      host === HOST
        ? ['127.0.0.1', proxiedPort]
        : host === CAPTCHA_HOST
          ? ['127.0.0.1', captchaPort]
          : [host, port],
  });
  socks.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const socksPort = await listen(socks);
  driver = await launch();
  await ext(`await chrome.storage.local.set({ state: {
    profiles: [{ id: 'e2e', name: 'e2e', host: '127.0.0.1', port: ${socksPort} }],
    activeProfileId: 'e2e',
    enabled: true,
  } });`);
  await verified();
  direct.hits = 0;
});

after(async () => {
  await driver?.quit().catch(() => undefined);
  for (const s of [direct.server, proxied.server, captcha.server, socks]) s?.close();
  for (const s of sockets) s.destroy();
});

test('a page cannot learn the private event name or forge a config', async () => {
  await driver.get(`${url}forge`);
  const result = await driver.executeScript<{ name: string | null; zone: string }>(
    'return window.result;',
  );
  assert.equal(result.name, null);
  assert.notEqual(result.zone, 'Pacific/Kiritimati');
});

test('WebRTC: no real-IP candidates', async () => {
  await driver.get(url);
  await until('fixture gathered candidates', async () => (await driver.getTitle()) === 'done');
  const candidates = await driver.executeScript<string[]>('return window.candidates || [];');
  const ip = /\b(?!0\.0\.0\.0\b)\d{1,3}(\.\d{1,3}){3}\b|\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b/i;
  assert.deepEqual(
    candidates.filter((c) => ip.test(c)),
    [],
  );
  assert.ok(proxied.hits > 0, 'the fixture was served through the proxy');
  assert.equal(direct.hits, 0);
});

/** Load the captcha page and read the zone it saw at first parse and after the config landed. */
async function captchaZones(): Promise<{ first: string; later: string }> {
  await driver.get(captchaUrl);
  await until('captcha page finished', async () => (await driver.getTitle()) === 'done');
  return driver.executeScript('return { first: window.first, later: window.later };');
}

/** Change state fields under the extension's state lock. */
const patchState = (fields: string) =>
  ext(`await navigator.locks.request('state', async () => {
    const s = (await chrome.storage.local.get('state')).state;
    await chrome.storage.local.set({ state: { ...s, ...${fields} } });
  });`);

const captchaScript = () =>
  ext<number>(
    `return (await chrome.scripting.getRegisteredContentScripts({ ids: ['noleaker-captcha-main', 'noleaker-captcha-main-path'] })).length;`,
  );

test('Strict blob worker runs under a CSP that forbids blob imports and keeps the spoofed identity', async () => {
  await patchState(`{ routingMode: 'strict', overrides: { ...s.overrides, timezone: '${ZONE}' } }`);
  await verified();
  for (const query of ['', '?trusted=1']) {
    await until('blob worker fixture loaded', async () => {
      await driver.get(`${url}blob-worker${query}`).catch(() => undefined);
      return ['blob worker', 'done'].includes(await driver.getTitle());
    });
    await driver
      .wait(async () => (await driver.getTitle()) === 'done', 10_000)
      .catch(async (e) => {
        const page = await driver.executeScript(
          'return { title: document.title, result: window.result, url: window.originalUrl };',
        );
        const logs = await driver.manage().logs().get('browser');
        throw new Error(JSON.stringify({ page, logs }), { cause: e });
      });
    const result = await driver.executeScript('return window.result;');
    const originalUrl = await driver.executeScript('return window.originalUrl;');
    assert.deepEqual(result, { zone: ZONE, href: originalUrl });
  }
  await patchState(`{ overrides: { ...s.overrides, timezone: null } }`);
  await verified();
});

test('captcha frames: neutral in Strict from the first script, untouched in Compatibility', async () => {
  assert.notEqual(REAL, ZONE, 'pick another override zone for this machine');
  assert.notEqual(REAL, 'UTC', 'this check needs a machine whose zone is not UTC');
  // A stored state without routingMode migrates to Compatibility, so choose Strict here.
  await patchState(`{ routingMode: 'strict', overrides: { ...s.overrides, timezone: '${ZONE}' } }`);
  await until('Strict captcha script registered', async () => (await captchaScript()) === 2);
  const strict = await captchaZones();
  assert.ok(['UTC', ZONE].includes(strict.first), `Strict first parse saw ${strict.first}`);
  assert.equal(strict.later, ZONE);
  // B6: a later load of the same origin starts with the identity, not UTC.
  assert.deepEqual(await captchaZones(), { first: ZONE, later: ZONE });

  await patchState(`{ routingMode: 'compatibility' }`);
  await until('captcha script removed', async () => (await captchaScript()) === 0);
  assert.deepEqual(await captchaZones(), { first: REAL, later: REAL });
  await patchState(`{ overrides: { ...s.overrides, timezone: null } }`); // later tests expect the defaults
  await verified();
  assert.ok(captcha.hits >= 2);
});

test('startup: a reload and a new iframe see the spoofed zone from the first script (B6, B7)', async () => {
  await patchState(`{ overrides: { ...s.overrides, timezone: '${ZONE}' } }`);
  await verified();
  const load = async () => {
    await driver.get(`${url}startup`);
    await until('startup page finished', async () => (await driver.getTitle()) === 'done');
    return driver.executeScript<{ page: string; frame: string }>('return window.result;');
  };
  const first = await load();
  assert.equal(first.frame, first.page, 'a new iframe agrees with its page');
  assert.deepEqual(await load(), { page: ZONE, frame: ZONE });
  await patchState(`{ overrides: { ...s.overrides, timezone: null } }`);
  await verified();
});

test('turning the proxy off during a health check stays off', async () => {
  // The popup writes `enabled` while the background is mid-check and writing its own fields.
  await ext(`void chrome.runtime.sendMessage({ type: 'refreshExit' });
    await navigator.locks.request('state', async () => {
      const s = (await chrome.storage.local.get('state')).state;
      await chrome.storage.local.set({ state: { ...s, enabled: false } });
    });`);
  await new Promise((r) => setTimeout(r, 15_000)); // let the check finish and write
  assert.equal((await state()).enabled, false);
  await ext(`await navigator.locks.request('state', async () => {
    const s = (await chrome.storage.local.get('state')).state;
    await chrome.storage.local.set({ state: { ...s, enabled: true } });
  });`);
  await verified();
});

test('kill switch: SOCKS server down, no direct request', async () => {
  socks.close();
  for (const s of sockets) s.destroy();
  await browse();
  await until(
    'kill switch active',
    async () => {
      await browse(1);
      return (await state()).killSwitchActive === true;
    },
    120_000,
  );
  await browse();
  assert.equal(direct.hits, 0);
});
