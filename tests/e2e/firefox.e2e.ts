// Firefox E2E for the four leak scenarios of Firefox-plan.md (Phase 6), against dist/firefox.
// Run: npm run build:firefox && FIREFOX_BIN=/path/to/firefox npm run e2e:firefox
//
// The extension is installed into the profile unsigned, which only Firefox ESR, Developer Edition
// and Nightly allow (xpinstall.signatures.required). It has to stay installed across a restart for
// the startup test, so a temporary add-on would not do.
//
// Leak detection: Firefox resolves fixture.e2e to 127.0.0.1 (network.dns.localDomains), so a
// request that goes direct reaches the `direct` server. Through the SOCKS server the same host is
// sent to the `proxied` server. Any hit on `direct` is a leak.
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Builder, type WebDriver } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
// @ts-expect-error plain .mjs script without types
import { createSocksServer } from '../../scripts/socks5-server.mjs';

const ID = 'noleaker@lordversa.github.io';
const UUID = '6f2b8c1e-0d4a-4e2b-9c3f-5a7d1e8b2c40';
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

// A captcha-provider page (served through the SOCKS server): the timezone at first parse and later.
// On the captcha list but not HSTS preloaded (cloudflare.com is), so plain HTTP loads.
const CAPTCHA_HOST = 'geo.captcha-delivery.com';
const CAPTCHA = `<!doctype html><title>captcha</title><script>
window.first = Intl.DateTimeFormat().resolvedOptions().timeZone;
setTimeout(() => { window.later = Intl.DateTimeFormat().resolvedOptions().timeZone; document.title = 'done'; }, 1500);
</script>`;
const ZONE = 'Pacific/Kiritimati';
const REAL = Intl.DateTimeFormat().resolvedOptions().timeZone;

function server(body: string) {
  const s = { hits: 0, server: null as unknown as Server };
  s.server = createServer((_req, res) => {
    s.hits++;
    res.setHeader('content-type', 'text/html');
    res.end(body);
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
let socksPort = 0;
let url = '';
let profile = '';
let driver: WebDriver;

function prefs(): Record<string, string | number | boolean> {
  return {
    'xpinstall.signatures.required': false,
    'extensions.autoDisableScopes': 0,
    'extensions.webextensions.uuids': JSON.stringify({ [ID]: UUID }),
    'network.dns.localDomains': HOST,
    // Without mDNS obfuscation a real-IP WebRTC leak shows up as a plain address.
    'media.peerconnection.ice.obfuscate_host_addresses': false,
    'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'browser.startup.page': 1,
    'browser.startup.homepage': url,
  };
}

function makeProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'noleaker-e2e-'));
  mkdirSync(join(dir, 'extensions'));
  execFileSync('zip', ['-qr', join(dir, 'extensions', `${ID}.xpi`), '.', '-x', '*.map'], {
    cwd: resolve('dist/firefox'),
  });
  const lines = Object.entries(prefs()).map(
    ([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`,
  );
  writeFileSync(join(dir, 'user.js'), lines.join('\n') + '\n');
  return dir;
}

async function launch(): Promise<WebDriver> {
  const options = new firefox.Options().addArguments('-headless', '-profile', profile);
  if (process.env.FIREFOX_BIN) options.setBinary(process.env.FIREFOX_BIN);
  for (const [k, v] of Object.entries(prefs())) options.setPreference(k, v);
  // Firefox only lets WebDriver open moz-extension:// pages with system access, which geckodriver
  // must grant (it refuses -remote-allow-system-access as a browser argument).
  const service = new firefox.ServiceBuilder().addArguments('--allow-system-access');
  return new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
}

/** Run `body` (async code using `api`, the extension's chrome object) on an extension page. */
async function ext<T>(body: string): Promise<T> {
  await driver.get(`moz-extension://${UUID}/options/index.html`);
  const out = await driver.executeAsyncScript<string>(`
    const done = arguments[arguments.length - 1];
    const api = (window.wrappedJSObject || window).chrome;
    (async () => { ${body} })().then(
      (v) => done(JSON.stringify({ v })),
      (e) => done(JSON.stringify({ e: String(e) })),
    );`);
  const r = JSON.parse(out) as { v?: T; e?: string };
  if (r.e) throw new Error(r.e);
  return r.v as T;
}

const state = () =>
  ext<Record<string, unknown>>(`return (await api.storage.local.get('state')).state;`);

async function until(what: string, check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

const verified = () =>
  until('proxy on and controls verified', async () => {
    const s = await state();
    return s.enabled === true && !!s.controlsVerifiedAt && !s.protectionError;
  }).catch(explain);

/** Rethrow with why: the stored state and the extension's own log. */
async function explain(e: Error): Promise<never> {
  const dump = await ext(`const { state, log } = await api.storage.local.get(['state', 'log']);
    const { profiles, ...rest } = state ?? {};
    return { state: rest, log: (log ?? []).map((l) => l.level + ': ' + l.msg) };`).catch(
    (err: Error) => `unavailable: ${err.message}`,
  );
  throw new Error(`${e.message} (direct hits: ${direct.hits})\n${JSON.stringify(dump, null, 2)}`);
}

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
  socksPort = await listen(socks);
  profile = makeProfile();
  driver = await launch();
  await ext(`await api.storage.local.set({ state: {
    profiles: [{ id: 'e2e', name: 'e2e', host: '127.0.0.1', port: ${socksPort} }],
    activeProfileId: 'e2e',
    enabled: true,
  } });`);
  await verified();
  direct.hits = 0; // the home page loaded once before the proxy was on
});

after(async () => {
  await driver?.quit().catch(() => undefined);
  for (const s of [direct.server, proxied.server, captcha.server, socks]) s?.close();
  for (const s of sockets) s.destroy();
});

test('private window without access: warning badge', async () => {
  assert.equal(await ext('return api.extension.isAllowedIncognitoAccess();'), false);
  assert.equal(await ext('return api.action.getBadgeText({});'), 'PW!');
});

test('WebRTC: no real-IP candidates', async () => {
  await driver.get(url);
  await until('fixture gathered candidates', async () => (await driver.getTitle()) === 'done');
  const candidates = await driver.executeScript<string[]>(
    'return (window.wrappedJSObject || window).candidates || [];',
  );
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
  return driver.executeScript(
    'const w = window.wrappedJSObject || window; return { first: w.first, later: w.later };',
  );
}

/** Change state fields under the extension's state lock. */
const patchState = (fields: string) =>
  ext(`await navigator.locks.request('state', async () => {
    const s = (await api.storage.local.get('state')).state;
    await api.storage.local.set({ state: { ...s, ...${fields} } });
  });`);

const captchaScript = () =>
  ext<number>(
    `return (await api.scripting.getRegisteredContentScripts({ ids: ['noleaker-captcha-main', 'noleaker-captcha-main-path'] })).length;`,
  );

test('captcha frames: neutral in Strict from the first script, untouched in Compatibility', async () => {
  assert.notEqual(REAL, ZONE, 'pick another override zone for this machine');
  assert.notEqual(REAL, 'UTC', 'this check needs a machine whose zone is not UTC');
  // A stored state without routingMode migrates to Compatibility, so choose Strict here.
  await patchState(`{ routingMode: 'strict', overrides: { ...s.overrides, timezone: '${ZONE}' } }`);
  await until('Strict captcha script registered', async () => (await captchaScript()) === 2).catch(
    explain,
  );
  const strict = await captchaZones();
  assert.ok(['UTC', ZONE].includes(strict.first), `Strict first parse saw ${strict.first}`);
  assert.equal(strict.later, ZONE);

  await patchState(`{ routingMode: 'compatibility' }`);
  await until('captcha script removed', async () => (await captchaScript()) === 0).catch(explain);
  assert.deepEqual(await captchaZones(), { first: REAL, later: REAL });
  await patchState(`{ overrides: { ...s.overrides, timezone: null } }`); // later tests expect the defaults
  await verified();
  assert.ok(captcha.hits >= 2);
});

test('startup: no request goes direct before the listener is ready', async () => {
  // The fixture is the home page, so Firefox requests it while the extension is still starting.
  await driver.quit();
  proxied.hits = 0;
  driver = await launch();
  await verified();
  await browse();
  assert.ok(proxied.hits > 0, 'browsing resumed through the proxy');
  assert.equal(direct.hits, 0);
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
  ).catch(explain);
  await browse();
  assert.equal(direct.hits, 0);
});
