import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePac, BLOCK_PROXY } from '../src/platform/chrome/pac';
import { encodeGroups } from '../src/shared/iranlist';
import { DEFAULT_STATE, migrateState } from '../src/shared/storage';
import { exportSettings, parseSettings } from '../src/shared/settings';
import { summarize } from '../src/shared/status';
import { coreRules } from '../src/background/rules';
import { LOCAL_RULE_IDS, setGuard, setLocalGuard } from '../src/platform/chrome/guard';
import { scopedSeed, sha256Hex } from '../src/shared/site-seed';
import { syncProxy } from '../src/platform/chrome/proxy';
import { installGeolocation } from '../src/content/geolocation';
import { installWebRtc } from '../src/content/webrtc';
import { installWorkers } from '../src/content/workers';
import { buildSpoofConfig } from '../src/shared/spoof-config';

vi.mock('../src/background/icons', () => ({ setStatusIcon: vi.fn() }));
const profile = { id: 'secret-profile', name: 'test', host: 'proxy.example', port: 1080 };
const state = { ...DEFAULT_STATE, enabled: true, profiles: [profile], activeProfileId: profile.id };
let local: Record<string, unknown>;
let session: Record<string, unknown>;
let rules: chrome.declarativeNetRequest.Rule[];
let effective: chrome.proxy.ProxyConfig;
let owner: string;
const area = (store: () => Record<string, unknown>) => ({
  get: async (key: string) => ({ [key]: store()[key] }),
  set: async (items: Record<string, unknown>) => Object.assign(store(), items),
  remove: async (key: string) => {
    delete store()[key];
  },
});
beforeEach(() => {
  local = { state };
  session = {};
  rules = [];
  effective = { mode: 'direct' };
  owner = 'controllable_by_this_extension';
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension-id' },
    storage: { local: area(() => local), session: area(() => session) },
    proxy: {
      settings: {
        get: async () => ({ value: effective, levelOfControl: owner }),
        set: vi.fn(async ({ value }: { value: chrome.proxy.ProxyConfig }) => {
          effective = value;
          if (owner !== 'controlled_by_other_extensions') owner = 'controlled_by_this_extension';
        }),
        clear: async () => {
          effective = { mode: 'direct' };
          owner = 'controllable_by_this_extension';
        },
      },
    },
    declarativeNetRequest: {
      updateDynamicRules: async ({
        removeRuleIds,
        addRules,
      }: {
        removeRuleIds: number[];
        addRules: chrome.declarativeNetRequest.Rule[];
      }) => {
        rules = [...rules.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
      },
    },
  });
});
const route = (host: string, blocking = false) =>
  new Function(
    `${generatePac(profile, { strict: true, blocking, extraDirect: ['listed.com'], iranGroups: encodeGroups(['iran.com']) })}; return FindProxyForURL;`,
  )()(`https://${host}/`, host);

describe('strict routing and migration', () => {
  it('ignores public bypasses, even when listed by an upstream update', () => {
    for (const host of [
      'listed.com',
      'www.listed.com',
      'iran.com',
      'other.ir',
      '8.8.8.8',
      '2001:4860::8888',
    ])
      expect(route(host)).toBe('SOCKS5 proxy.example:1080');
  });
  it('blocks local destinations and blocks public browsing during failure', () => {
    for (const host of [
      'localhost',
      'nas',
      'a.local',
      '127.0.0.1',
      '10.2.3.4',
      '172.16.1.1',
      '192.168.1.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:7f00:1]',
      'LOCALHOST.',
      'a.local.',
    ])
      expect(route(host)).toBe(BLOCK_PROXY);
    expect(route('listed.com', true)).toBe(BLOCK_PROXY);
    expect(route('cloudflare.com', true)).toBe('SOCKS5 proxy.example:1080');
  });
  it('uses strict for fresh installs but preserves old routing', () => {
    expect(migrateState(undefined).routingMode).toBe('strict');
    expect(migrateState({ schemaVersion: 7 }).routingMode).toBe('compatibility');
    expect(migrateState({ schemaVersion: 8, routingMode: 'strict' }).routingMode).toBe('strict');
    expect(migrateState({ schemaVersion: 7 }).listUpdates).toBe(false);
  });
  it('round-trips privacy choices without exporting runtime verification', () => {
    const exported = exportSettings({ ...state, controlsVerifiedAt: 123, protectionError: 'test' });
    expect(JSON.parse(exported)).not.toHaveProperty('controlsVerifiedAt');
    expect(parseSettings(exported)).toMatchObject({
      ok: true,
      patch: {
        routingMode: 'strict',
        listUpdates: false,
        controlsVerifiedAt: null,
        protectionError: null,
      },
    });
  });
  it('removes captcha header allow rules in strict mode', () => {
    expect(
      coreRules(
        { strict: true, altSvc: true, acceptLanguage: true, headers: true },
        'en-US',
        [],
      ).map((r) => r.id),
    ).toEqual([1, 2]);
  });
});

describe('guard and proxy ownership', () => {
  it('makes PAC mandatory and caches only verified application', async () => {
    await syncProxy();
    expect(effective.pacScript?.mandatory).toBe(true);
    expect(session.appliedPac).toBeTypeOf('string');
    expect(rules.find((r) => r.id === 90)?.action.type).toBe('block');
  });
  it('retains the guard and does not cache when another extension owns the proxy', async () => {
    owner = 'controlled_by_other_extensions';
    await expect(syncProxy()).rejects.toThrow('could not be verified');
    expect(session.appliedPac).toBeUndefined();
    expect(rules.find((r) => r.id === 90)?.action.type).toBe('block');
  });
  it('repairs lost effective settings despite an unchanged cached PAC', async () => {
    await syncProxy();
    effective = { mode: 'direct' };
    await syncProxy();
    expect(effective.mode).toBe('pac_script');
    expect(chrome.proxy.settings.set).toHaveBeenCalledTimes(2);
  });
  it('restricts health exceptions to extension-origin exact paths', async () => {
    await setGuard(true);
    expect(
      rules
        .find((rule) => rule.id === 90)!
        .condition.resourceTypes?.some((type) => String(type) === 'main_frame'),
    ).toBe(true);
    const allow = rules.find((r) => r.id === 92)!;
    expect(allow.condition.initiatorDomains).toEqual(['extension-id']);
    const re = new RegExp(allow.condition.regexFilter!);
    expect(re.test('https://cloudflare.com/cdn-cgi/trace')).toBe(true);
    expect(re.test('https://cloudflare.com/arbitrary')).toBe(false);
    expect(allow.priority!).toBeGreaterThan(rules.find((r) => r.id === 90)!.priority!);
    await setGuard(false);
    expect(rules.some((r) => r.id === 90 || r.id === 92)).toBe(false);
  });
  it('local guard matches browser-canonicalized private addresses without matching public hosts', async () => {
    await setLocalGuard(true);
    const local = rules.filter((r) => LOCAL_RULE_IDS.includes(r.id));
    expect(local).toHaveLength(12);
    expect(
      local.every((rule) =>
        rule.condition.resourceTypes?.some((type) => String(type) === 'main_frame'),
      ),
    ).toBe(true);
    const re = {
      test: (url: string) =>
        local.some((rule) => new RegExp(rule.condition.regexFilter!, 'i').test(url)),
    };
    for (const host of [
      'localhost',
      'nas',
      '10.1.1.1',
      '127.0.0.1',
      '192.168.1.1',
      '172.31.1.1',
      '[::1]',
      '[fd00::1]',
      '[::ffff:7f00:1]',
      'localhost.',
      'printer.local.',
    ])
      expect(re.test(`http://${host}/`), host).toBe(true);
    for (const host of [
      'example.com',
      '172.32.1.1',
      '192.169.1.1',
      'localhost.example.com',
      '[2001:4860::1]',
    ])
      expect(re.test(`https://${host}/`), host).toBe(false);
    expect(re.test('http://127.0.0.1:10808/')).toBe(true);
    expect(local.every((rule) => rule.priority! > 10001)).toBe(true);
    await setLocalGuard(false);
    expect(rules.some((rule) => LOCAL_RULE_IDS.includes(rule.id))).toBe(false);
  });
  it('reports failed and stale verification honestly', () => {
    expect(summarize({ ...state, protectionError: 'ownership lost' }).label).toBe(
      'Protection failed',
    );
    expect(summarize({ ...state, controlsVerifiedAt: Date.now() - 151_000 }).label).toBe(
      'Unverified',
    );
  });
});

describe('page configuration and realm restrictions', () => {
  it('keeps strict API safeguards while exit is unknown or the proxy is down', () => {
    expect(buildSpoofConfig(state)).toMatchObject({ active: false, strict: true });
    expect(buildSpoofConfig({ ...state, killSwitchActive: true })).toMatchObject({
      active: false,
      strict: true,
    });
  });
  it('derives stable distinct per-host seeds without exposing the profile identifier', async () => {
    const a = await scopedSeed(profile.id, 'a.github.io');
    expect(a).toHaveLength(64);
    expect(a).not.toContain(profile.id);
    expect(await scopedSeed(profile.id, 'A.GITHUB.IO.')).toBe(a);
    expect(await scopedSeed(profile.id, 'b.github.io')).not.toBe(a);
    expect(await scopedSeed('another-profile', 'a.github.io')).not.toBe(a);
  });
  it('blocks worker creation before config and unsupported realms in strict mode', async () => {
    class Worker {
      terminate() {}
    }
    class ServiceWorkerContainer {
      register() {
        return Promise.resolve('native');
      }
    }
    const g = runInNewContext('globalThis', {
      Worker,
      SharedWorker: Worker,
      ServiceWorkerContainer,
      DOMException,
      URL,
      Blob,
      setTimeout,
      location: { origin: 'https://example.com', href: 'https://example.com/' },
    });
    let pending = true;
    let configured!: () => void;
    installWorkers(g, {
      config: () => buildSpoofConfig(state),
      prelude: () => null,
      gpu: () => null,
      pending: () => pending,
      ready: new Promise<void>((r) => (configured = r)),
    });
    // B6: a registration during startup waits, then follows the config (strict here: refused).
    const early = new g.ServiceWorkerContainer().register();
    expect(() => new g.Worker()).toThrow('cannot be protected');
    pending = false;
    expect(() => new g.SharedWorker()).toThrow('cannot be protected');
    expect(() => new g.Worker()).toThrow('cannot be protected');
    configured();
    await expect(early).rejects.toThrow('blocked in strict mode');
    return expect(new g.ServiceWorkerContainer().register()).rejects.toThrow(
      'blocked in strict mode',
    );
  });
});

it('software seed derivation matches SHA256 across padding and Unicode cases', () => {
  for (const text of [
    '',
    'abc',
    'a'.repeat(55),
    'b'.repeat(56),
    'c'.repeat(64),
    'd'.repeat(129),
    'Persian: فارسی',
  ]) {
    expect(sha256Hex(new TextEncoder().encode(text))).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
  }
});

describe('early sensitive APIs', () => {
  it('withholds initial native geolocation calls and filters an in-flight native callback after strict activation', () => {
    const g = runInNewContext('globalThis', { setTimeout: (fn: () => void) => fn() });
    g.nativeCalls = 0;
    g.Geolocation = class {
      watchPosition() {
        return 0;
      }
      clearWatch() {}
      getCurrentPosition(success: (position: unknown) => void) {
        g.nativeCalls++;
        g.callback = success;
      }
    };
    const shield = installGeolocation(g, { pending: true });
    let errorCode = 0;
    const results: unknown[] = [];
    new g.Geolocation().getCurrentPosition(
      (p: unknown) => results.push(p),
      (error: { code: number }) => {
        errorCode = error.code;
      },
    );
    expect(g.nativeCalls).toBe(0);
    expect(errorCode).toBe(0); // it waits for the config instead of failing (B6)
    shield.setConfig(null);
    expect(g.nativeCalls).toBe(1); // the waiting call runs with that config
    shield.setConfig(buildSpoofConfig(state));
    g.callback({ coords: { latitude: 35, longitude: 51 } });
    expect(results).toEqual([]);
  });
  it('a watch or permission query made during startup waits for the config (B6)', async () => {
    const g = runInNewContext('globalThis', { setTimeout: () => 1, clearTimeout: () => {} });
    const watched: unknown[] = [];
    const cleared: unknown[] = [];
    g.Geolocation = class {
      getCurrentPosition() {}
      watchPosition(fn: unknown) {
        watched.push(fn);
        return 7;
      }
      clearWatch(id: unknown) {
        cleared.push(id);
      }
    };
    g.Permissions = class {
      query() {
        return Promise.resolve({ state: 'prompt' });
      }
    };
    const shield = installGeolocation(g, { pending: true });
    const geo = new g.Geolocation();
    const id = geo.watchPosition(() => undefined);
    const gone = geo.watchPosition(() => undefined);
    geo.clearWatch(gone); // cleared before the config came: never starts
    const state = new g.Permissions().query({ name: 'geolocation' });
    expect(id).toBeLessThan(0);
    expect(watched).toHaveLength(0);
    shield.setConfig(null);
    expect(watched).toHaveLength(1);
    await expect(state).resolves.toMatchObject({ state: 'prompt' });
    geo.clearWatch(id);
    expect(cleared).toEqual([7]);
  });
  it('cancels native watches on strict activation without reviving them after disabling', () => {
    const g = runInNewContext('globalThis', { setTimeout: () => 1, clearTimeout: () => {} });
    const clear = vi.fn();
    g.Geolocation = class {
      getCurrentPosition() {}
      watchPosition(callback: (position: unknown) => void) {
        g.callback = callback;
        return 7;
      }
      clearWatch(id: number) {
        clear(id);
      }
    };
    const shield = installGeolocation(g);
    const results: unknown[] = [];
    const geo = new g.Geolocation();
    expect(geo.watchPosition((p: unknown) => results.push(p))).toBe(7);
    shield.setConfig(buildSpoofConfig(state));
    expect(clear).toHaveBeenCalledExactlyOnceWith(7);
    g.callback({ coords: { latitude: 35 } });
    expect(results).toEqual([]);
    shield.setConfig(null);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it('restricts WebRTC before configuration and retains relay in inactive strict config', () => {
    const g = runInNewContext('globalThis', {});
    g.RTCPeerConnection = class {
      configuration: unknown;
      constructor(configuration: unknown) {
        this.configuration = configuration;
      }
    };
    const shield = installWebRtc(g, true);
    expect(
      new g.RTCPeerConnection({ iceTransportPolicy: 'all' }).configuration.iceTransportPolicy,
    ).toBe('relay');
    shield.setConfig(buildSpoofConfig(state));
    expect(
      new g.RTCPeerConnection({ iceTransportPolicy: 'all' }).configuration.iceTransportPolicy,
    ).toBe('relay');
    shield.setConfig(null);
    expect(
      new g.RTCPeerConnection({ iceTransportPolicy: 'all' }).configuration.iceTransportPolicy,
    ).toBe('all');
  });
  it('terminates tracked workers when a strict config changes, without terminating on identical delivery', () => {
    const g = runInNewContext('globalThis', { DOMException, URL, Blob, setTimeout: () => 0 });
    g.location = { origin: 'https://example.com', href: 'https://example.com/' };
    g.Worker = class {
      terminate = vi.fn();
    };
    let config = buildSpoofConfig({
      ...state,
      detectedExit: { ip: '1.1.1.1', countryCode: 'DE', timezone: 'Europe/Berlin', detectedAt: 0 },
    });
    const control = installWorkers(g, {
      config: () => config,
      prelude: () => '/*prelude*/',
      gpu: () => null,
    });
    const worker = new g.Worker('/worker.js');
    control?.refresh();
    expect(worker.terminate).not.toHaveBeenCalled();
    const active = config;
    config = { ...config, active: false, whitelist: ['x.test'] }; // a pause and a settings change
    control?.refresh();
    config = active;
    control?.refresh();
    expect(worker.terminate).not.toHaveBeenCalled(); // B5: nothing the worker holds changed
    config = { ...config, timezone: 'Asia/Tokyo' };
    control?.refresh();
    expect(worker.terminate).toHaveBeenCalledOnce();
    const tokyo = config;
    config = { ...config, active: false, strict: false };
    const native = new g.Worker('/worker.js'); // started unwrapped during a pause
    control?.refresh();
    expect(native.terminate).not.toHaveBeenCalled();
    config = tokyo;
    control?.refresh();
    expect(native.terminate).toHaveBeenCalledOnce();
    const kept = new g.Worker('/worker.js');
    config = { ...config, shields: { ...config.shields, canvas: !config.shields.canvas } };
    control?.refresh();
    expect(kept.terminate).toHaveBeenCalledOnce(); // a shield change counts too
  });
});
