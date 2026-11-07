import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeGroups } from '../src/shared/iranlist';
import { directLookup, NO_DIRECT } from '../src/shared/route';

const BASE = 'moz-extension://abc/';
const profile = { id: 'p', name: 'p', host: 'proxy.example', port: 1080 };
const SOCKS_INFO = {
  type: 'socks',
  host: 'proxy.example',
  port: 1080,
  proxyDNS: true,
  failoverTimeout: 5,
};
// Every SOCKS answer ends with null so Firefox cannot fail over to its own proxy setting (#2).
const SOCKS = [SOCKS_INFO, null];
const DEAD = [{ type: 'socks', host: '127.0.0.1', port: 1, proxyDNS: true }, null];
const page = (url: string) => ({
  url,
  originUrl: 'https://site.example/',
  documentUrl: 'https://site.example/',
});
const ext = (url: string) => ({ url, originUrl: `${BASE}_generated_background_page.html` });

let r: typeof import('../src/platform/firefox/routing');

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => BASE + p } });
  r = await import('../src/platform/firefox/routing');
});

const on = (over: object = {}) =>
  r.setRouting({
    enabled: true,
    profile,
    blocking: false,
    strict: false,
    direct: directLookup(encodeGroups(['site.ir']), ['mine.example']),
    guarded: false,
    ...over,
  });

describe('Firefox proxy.onRequest routing', () => {
  it('proxies normal sites over SOCKS5 with remote DNS, and sends direct hosts direct', () => {
    on();
    expect(r.onRequest(page('https://example.com/'))).toEqual(SOCKS);
    expect(r.onRequest(page('https://www.site.ir/'))).toEqual({ type: 'direct' });
    expect(r.onRequest(page('https://a.mine.example/'))).toEqual({ type: 'direct' });
    expect(r.onRequest(page('http://192.168.1.1/'))).toEqual({ type: 'direct' });
    expect(r.onRequest(page('http://[::1]:8080/'))).toEqual({ type: 'direct' });
  });
  it('strict mode refuses local hosts and ignores the direct lists', () => {
    on({ strict: true, direct: NO_DIRECT });
    expect(r.onRequest(page('http://localhost:3000/'))).toEqual(DEAD);
    expect(r.onRequest(page('http://10.0.0.1/'))).toEqual(DEAD);
    expect(r.onRequest(page('https://www.site.ir/'))).toEqual(SOCKS);
  });
  it('kill switch: refuses everything proxied; probe hosts only for the extension itself', () => {
    on({ blocking: true });
    expect(r.onRequest(page('https://example.com/'))).toEqual(DEAD);
    expect(r.onRequest(page('https://cloudflare.com/cdn-cgi/trace'))).toEqual(DEAD);
    expect(r.onRequest(ext('https://cloudflare.com/cdn-cgi/trace'))).toEqual(SOCKS);
    expect(r.onRequest(ext('https://ipwho.is/'))).toEqual(SOCKS);
    expect(r.onRequest(page('http://192.168.1.1/'))).toEqual({ type: 'direct' });
  });
  it('transition guard: refuses everything, direct hosts included, except extension probes', () => {
    on({ guarded: true });
    expect(r.onRequest(page('https://example.com/'))).toEqual(DEAD);
    expect(r.onRequest(page('http://192.168.1.1/'))).toEqual(DEAD);
    expect(r.onRequest(ext('https://ipwho.is/'))).toEqual(SOCKS);
    // A page that frames itself as the extension origin only by originUrl is not enough.
    expect(
      r.onRequest({
        url: 'https://ipwho.is/',
        originUrl: BASE,
        documentUrl: 'https://evil.example/',
      }),
    ).toEqual(DEAD);
  });
  it('proxy off: leaves requests to Firefox (no answer)', () => {
    r.setRouting({ enabled: false, profile: null, guarded: false });
    expect(r.onRequest(page('https://example.com/'))).toBeUndefined();
  });
  it('passes SOCKS5 credentials when the profile has them', () => {
    on({ profile: { ...profile, username: 'u', password: 'p' } });
    expect(r.onRequest(page('https://example.com/'))).toEqual([
      { ...SOCKS_INFO, username: 'u', password: 'p' },
      null,
    ]);
  });
  it('unparseable URLs and internal failures answer with the dead end, never throw', () => {
    on();
    expect(r.onRequest(page('not a url'))).toEqual(DEAD);
    on({
      direct: () => {
        throw new Error('boom');
      },
    });
    expect(r.onRequest(page('https://example.com/'))).toEqual(DEAD);
  });
  it('requests before the first routing table wait for it', async () => {
    const pending = r.onRequest(page('https://example.com/'));
    expect(pending).toBeInstanceOf(Promise);
    r.setGuarded(false); // the guard alone is not a routing table
    on();
    await expect(pending).resolves.toEqual(SOCKS);
  });
  it('and are refused if it never comes', async () => {
    vi.useFakeTimers();
    const pending = r.onRequest(page('https://example.com/'));
    await vi.advanceTimersByTimeAsync(r.READY_TIMEOUT_MS);
    await expect(pending).resolves.toEqual(DEAD);
    vi.useRealTimers();
  });
});

describe('Firefox syncProxy', () => {
  let local: Record<string, unknown>;
  let session: Record<string, unknown>;
  const area = (store: () => Record<string, unknown>) => ({
    get: async (key: string) => (key in store() ? { [key]: store()[key] } : {}),
    set: async (items: Record<string, unknown>) => void Object.assign(store(), items),
    remove: async (key: string) => void delete store()[key],
  });

  beforeEach(() => {
    local = {};
    session = {};
    vi.doMock('../src/background/icons', () => ({ setStatusIcon: vi.fn() }));
    vi.stubGlobal('chrome', {
      runtime: { getURL: (p: string) => BASE + p },
      storage: { local: area(() => local), session: area(() => session) },
    });
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }));
  });

  const sync = async () => {
    const { syncProxy } = await import('../src/platform/firefox/proxy');
    await syncProxy();
    return (await import('../src/platform/firefox/routing')).currentRouting();
  };
  const enabled = (over: object = {}) => ({
    schemaVersion: 9,
    enabled: true,
    profiles: [profile],
    activeProfileId: 'p',
    routingMode: 'strict',
    ...over,
  });

  it('starts guarded until the controls are verified, then keeps the released guard', async () => {
    local.state = enabled();
    expect(await sync()).toMatchObject({ enabled: true, guarded: true, strict: true });
    const { setGuard } = await import('../src/platform/firefox/guard');
    await setGuard(false);
    local.state = enabled({ controlsVerifiedAt: Date.now() });
    expect(await sync()).toMatchObject({ guarded: false });
  });
  it('follows the kill switch and turns routing off with the proxy', async () => {
    local.state = enabled({ killSwitchActive: true, controlsVerifiedAt: 1 });
    session.requestGuard = false;
    expect(await sync()).toMatchObject({ blocking: true, guarded: false });
    local.state = enabled({ enabled: false });
    expect(await sync()).toMatchObject({ enabled: false, guarded: false });
  });
});
