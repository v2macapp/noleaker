import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncProtection } from '../src/background/protection';
import { encodeGroups } from '../src/shared/iranlist';
import { RULES_STATUS_KEY, type RulesStatus } from '../src/shared/rules-status';
import { CONFIG_KEY } from '../src/shared/spoof-config';

interface Rule {
  id: number;
  condition: { excludedRequestDomains?: string[] };
  action?: { requestHeaders?: { value?: string }[] };
}

let local: Record<string, unknown>;
let session: Record<string, unknown>;
let installed: Rule[];
let calls: Rule[][];
let limit: number;
let rejectAll: boolean;

const area = (store: () => Record<string, unknown>) => ({
  get: async (key: string) => (key in store() ? { [key]: store()[key] } : {}),
  set: async (items: Record<string, unknown>) => void Object.assign(store(), items),
  remove: async (key: string) => void delete store()[key],
});

const profile = { id: 'a', name: 'a', host: 'h.com', port: 1 };
const baseState = (shields: object) => ({
  schemaVersion: 3,
  enabled: true,
  profiles: [profile],
  activeProfileId: 'a',
  detectedExit: { ip: '1.1.1.1', countryCode: 'DE', timezone: 'Europe/Berlin', detectedAt: 0 },
  whitelist: ['whitelisted.com'],
  extraDirectDomains: ['mine.org'],
  shields,
});

beforeEach(() => {
  local = {};
  session = {};
  installed = [];
  calls = [];
  limit = Infinity;
  rejectAll = false;
  vi.stubGlobal('fetch', async () => ({ text: async () => '/*prelude*/' }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('chrome', {
    storage: { local: area(() => local), session: area(() => session) },
    runtime: { getURL: (p: string) => `chrome-extension://x/${p}` },
    proxy: {
      settings: {
        get: async () => ({
          value: { mode: 'pac_script', pacScript: { mandatory: true } },
          levelOfControl: 'controlled_by_this_extension',
        }),
      },
    },
    privacy: {
      network: {
        webRTCIPHandlingPolicy: {
          get: async () => ({
            value: 'disable_non_proxied_udp',
            levelOfControl: 'controlled_by_this_extension',
          }),
          set: async () => undefined,
          clear: async () => undefined,
        },
        networkPredictionEnabled: {
          get: async () => ({ value: false, levelOfControl: 'controlled_by_this_extension' }),
          set: async () => undefined,
          clear: async () => undefined,
        },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => installed,
      updateDynamicRules: async ({
        removeRuleIds,
        addRules,
      }: {
        removeRuleIds: number[];
        addRules: Rule[];
      }) => {
        if (removeRuleIds.includes(1)) calls.push(addRules);
        if (rejectAll) throw new Error('Rule limit');
        if (addRules.some((r) => (r.condition.excludedRequestDomains?.length ?? 0) > limit)) {
          throw new Error('Rule too large');
        }
        installed = [...installed.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
      },
    },
  });
  // The Iran list lives in storage; a big one to exercise the fallback.
  const domains = Array.from({ length: 3000 }, (_, i) => `iran${i}.com`);
  local.iranList = encodeGroups(domains);
  local.iranListMeta = { count: 3000, updatedAt: 1, source: 'bundled' };
});

const status = () => local[RULES_STATUS_KEY] as RulesStatus;
const ids = () => installed.map((r) => r.id).sort();

describe('syncProtection: network rules', () => {
  it('default shields: Alt-Svc, language and the reCAPTCHA allow rule; no header rule', async () => {
    local.state = baseState({});
    await syncProtection();
    expect(ids()).toEqual([1, 2, 4]);
    expect(status().headers).toBeNull();
    expect(status().core).toMatchObject({ ok: true });
    expect((local[CONFIG_KEY] as { active: boolean }).active).toBe(true);
  });

  it('headers shield on: adds the header rule excluding whitelist, extras and the Iran list', async () => {
    local.state = baseState({ headers: true });
    await syncProtection();
    expect(ids()).toEqual([1, 2, 3, 4]);
    const header = installed.find((r) => r.id === 3)!;
    const excluded = header.condition.excludedRequestDomains!;
    expect(excluded).toEqual(
      expect.arrayContaining(['whitelisted.com', 'hcaptcha.com', 'mine.org', 'iran0.com']),
    );
    expect(excluded.indexOf('whitelisted.com')).toBeLessThan(excluded.indexOf('iran0.com'));
    expect(status().headers).toMatchObject({
      ok: true,
      installed: excluded.length,
      requested: excluded.length,
    });
  });

  it('shortens an oversized exclusion list, keeps captcha and whitelist, and records it', async () => {
    limit = 1000;
    local.state = baseState({ headers: true });
    await syncProtection();
    const header = installed.find((r) => r.id === 3)!;
    const excluded = header.condition.excludedRequestDomains!;
    expect(excluded.length).toBeLessThanOrEqual(1000);
    expect(excluded).toEqual(
      expect.arrayContaining(['whitelisted.com', 'hcaptcha.com', 'mine.org']),
    );
    expect(status().headers!.installed).toBeLessThan(status().headers!.requested);
    expect(status().headers!.ok).toBe(true);
    expect(status().core).toMatchObject({ ok: true }); // core rules unaffected
  });

  it('a rejected rule set is reported, not hidden, and retried on the next sync', async () => {
    rejectAll = true;
    local.state = baseState({});
    await expect(syncProtection()).rejects.toThrow('Required network rules');
    expect(status().core.ok).toBe(false);
    expect(status().core.error).toBe('Rule limit');
    expect(session.rulesSig).toBeUndefined();
    const first = calls.length;
    rejectAll = false;
    await syncProtection();
    expect(calls.length).toBeGreaterThan(first);
    expect(status().core.ok).toBe(true);
    expect(ids()).toEqual([1, 2, 4]);
  });

  it('skips reinstalling when nothing changed, and reinstalls when the whitelist changes', async () => {
    local.state = baseState({});
    await syncProtection();
    const after = calls.length;
    await syncProtection();
    expect(calls.length).toBe(after);
    local.state = { ...(local.state as object), whitelist: ['other.com'] };
    await syncProtection();
    expect(calls.length).toBeGreaterThan(after);
  });

  it('removes the header rule when the shield is turned off', async () => {
    local.state = baseState({ headers: true });
    await syncProtection();
    expect(ids()).toContain(3);
    local.state = baseState({});
    await syncProtection();
    expect(ids()).toEqual([1, 2, 4]);
    expect(status().headers).toBeNull();
  });

  it('proxy off removes every rule', async () => {
    local.state = baseState({ headers: true });
    await syncProtection();
    local.state = { ...baseState({ headers: true }), enabled: false };
    await syncProtection();
    expect(ids()).toEqual([]);
  });

  it('the Accept-Language rule carries the configured value and is reinstalled when it changes', async () => {
    const value = () => installed.find((r) => r.id === 2)!.action!.requestHeaders![0]!.value;
    local.state = baseState({});
    await syncProtection();
    expect(value()).toBe('en-US,en;q=0.9'); // automatic: unchanged behaviour

    const before = calls.length;
    local.state = { ...baseState({}), overrides: { locale: 'de-DE' } };
    await syncProtection();
    expect(value()).toBe('de-DE,de;q=0.9,en;q=0.8');
    expect(calls.length).toBeGreaterThan(before);

    local.state = { ...baseState({}), overrides: { acceptLanguage: 'fr-FR,fr;q=0.8' } };
    await syncProtection();
    expect(value()).toBe('fr-FR,fr;q=0.8');

    local.state = { ...baseState({}), localeMode: 'country' };
    await syncProtection();
    expect(value()).toBe('de-DE,de;q=0.9,en;q=0.8');
    expect((local[CONFIG_KEY] as { languages: string[] }).languages).toEqual(['de-DE', 'de', 'en']);
  });
});

describe('verified privacy controls', () => {
  it('rejects unverifiable network prediction instead of publishing a protected config', async () => {
    local.state = baseState({});
    chrome.privacy.network.networkPredictionEnabled.get = vi.fn(async () => ({
      value: true,
      levelOfControl: 'controlled_by_other_extensions' as const,
    }));
    await expect(syncProtection()).rejects.toThrow('Network prediction control');
    expect(local[CONFIG_KEY]).toBeUndefined();
  });
  it('rejects a WebRTC policy owned by another extension', async () => {
    local.state = baseState({});
    chrome.privacy.network.webRTCIPHandlingPolicy.get = vi.fn(async () => ({
      value: 'default' as const,
      levelOfControl: 'controlled_by_other_extensions' as const,
    }));
    await expect(syncProtection()).rejects.toThrow('WebRTC policy');
    expect(local[CONFIG_KEY]).toBeUndefined();
  });
  it('accepts settings another extension holds when they have the right value (B1)', async () => {
    local.state = baseState({});
    const other = 'controlled_by_other_extensions' as const;
    const set = vi.fn(async () => undefined);
    chrome.privacy.network.networkPredictionEnabled.get = vi.fn(async () => ({
      value: false,
      levelOfControl: other,
    }));
    chrome.privacy.network.networkPredictionEnabled.set = set;
    chrome.privacy.network.webRTCIPHandlingPolicy.get = vi.fn(async () => ({
      value: 'disable_non_proxied_udp' as const,
      levelOfControl: other,
    }));
    chrome.privacy.network.webRTCIPHandlingPolicy.set = vi.fn(async () => {
      throw new Error('cannot take control');
    });
    await syncProtection();
    expect(set).toHaveBeenCalled(); // still tries to take control
    expect(local[CONFIG_KEY]).toMatchObject({ active: true });
  });
});

it('does not release an existing request guard if proxy control is lost before release', async () => {
  local.state = baseState({});
  installed.push({ id: 90, condition: {} });
  chrome.proxy.settings.get = vi.fn(async () => ({
    value: { mode: 'direct' as const },
    levelOfControl: 'controlled_by_other_extensions' as const,
  }));
  await expect(syncProtection()).rejects.toThrow('proxy control was lost');
  expect(ids()).toContain(90);
  expect(local[CONFIG_KEY]).toBeUndefined();
});
