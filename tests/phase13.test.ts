import { existsSync, readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeAudit, auditGate } from '../src/audit/analyze';
import type { AuditObservation } from '../src/audit/collect';
import { forgetTab, handleStaleReport, trackNavigation } from '../src/background/stale';
import { encodeGroups, isDirectHost } from '../src/shared/iranlist';
import { SHIELD_DEFAULTS } from '../src/shared/shields';
import {
  decideReload,
  describeNote,
  NOTES_KEY,
  RELOAD_WINDOW_MS,
  type ReloadInput,
  type StaleReport,
  type TabNote,
} from '../src/shared/stale';
import { buildSpoofConfig, CONFIG_KEY } from '../src/shared/spoof-config';
import { DEFAULT_STATE } from '../src/shared/storage';
import type { State } from '../src/shared/types';

const profile = { id: 'a', name: 'a', host: 'h.com', port: 1 };
const exit = { ip: '1.1.1.1', countryCode: 'DE', timezone: 'Europe/Berlin', detectedAt: 0 };
const live = (over: Partial<State> = {}): State => ({
  ...DEFAULT_STATE,
  routingMode: 'compatibility',
  enabled: true,
  profiles: [profile],
  activeProfileId: 'a',
  detectedExit: exit,
  ...over,
});

describe('decideReload guards', () => {
  const base: ReloadInput = {
    now: 100_000,
    isTopFrame: true,
    protectionActive: true,
    whitelisted: false,
    direct: false,
    captcha: false,
    serviceWorker: false,
  };
  it('reloads a protected top-level page, normally unless a Service Worker serves it', () => {
    expect(decideReload(base)).toEqual({ reload: true, hard: false, reason: 'reload' });
    expect(decideReload({ ...base, serviceWorker: true })).toMatchObject({
      reload: true,
      hard: true,
    });
  });
  it('never reloads in the cases that would lose data or loop', () => {
    expect(decideReload({ ...base, isTopFrame: false })).toEqual({
      reload: false,
      reason: 'not-top-frame',
    });
    expect(decideReload({ ...base, protectionActive: false })).toMatchObject({
      reason: 'protection-inactive',
    });
    expect(decideReload({ ...base, whitelisted: true })).toMatchObject({ reason: 'whitelisted' });
    expect(decideReload({ ...base, direct: true })).toMatchObject({ reason: 'direct-site' });
    expect(decideReload({ ...base, captcha: true })).toMatchObject({ reason: 'captcha' });
    expect(decideReload({ ...base, transitionType: 'form_submit' })).toMatchObject({
      reason: 'form-submit',
    });
    expect(decideReload({ ...base, transitionType: 'typed' }).reload).toBe(true);
  });
  it('reloads at most once per tab and URL within 20 seconds', () => {
    const just = base.now - (RELOAD_WINDOW_MS - 1);
    expect(decideReload({ ...base, lastReloadAt: just })).toMatchObject({
      reason: 'recently-reloaded',
    });
    expect(decideReload({ ...base, lastReloadAt: base.now - RELOAD_WINDOW_MS }).reload).toBe(true);
  });
  it('describes the outcome for the popup', () => {
    const note = (over: Partial<TabNote>): TabNote => ({
      url: 'u',
      outcome: 'reloaded',
      at: 0,
      ...over,
    });
    expect(describeNote(note({}))).toContain('reloaded once');
    expect(describeNote(note({ outcome: 'unprotected', reason: 'form-submit' }))).toContain(
      'form submit',
    );
    expect(describeNote(note({ outcome: 'unprotected', reason: 'recently-reloaded' }))).toContain(
      'already reloaded',
    );
  });
});

describe('isDirectHost', () => {
  const groups = encodeGroups(['digikala.com', 'shop.co.uk', 'listed.ir']);
  it('matches your domains and the Iran list with subdomains, but not .ir by itself', () => {
    for (const h of [
      'x.mine.org',
      'www.digikala.com',
      'shop.co.uk',
      'listed.ir',
      'www.listed.ir',
    ]) {
      expect(isDirectHost(h, groups, ['mine.org']), h).toBe(true);
    }
    for (const h of [
      'example.com',
      'notdigikala.com',
      'digikala.com.evil.net',
      'co.uk',
      'a.ir', // only listed .ir domains are direct
      'ir',
    ]) {
      expect(isDirectHost(h, groups, ['mine.org']), h).toBe(false);
    }
    expect(isDirectHost('example.com', undefined, [])).toBe(false);
  });
});

describe('handleStaleReport (service worker)', () => {
  let local: Record<string, unknown>;
  let session: Record<string, unknown>;
  let reloads: { tabId: number; bypassCache: boolean }[];
  const area = (store: () => Record<string, unknown>) => ({
    get: async (key: string) => (key in store() ? { [key]: store()[key] } : {}),
    set: async (items: Record<string, unknown>) => void Object.assign(store(), items),
    remove: async (key: string) => void delete store()[key],
  });
  const report = (over: Partial<StaleReport> = {}): StaleReport => ({
    type: 'staleReport',
    url: 'https://news.example.com/a',
    serviceWorker: false,
    deliveryType: '',
    navigationType: 'navigate',
    ...over,
  });
  const sender = (tabId = 7, frameId = 0) =>
    ({ tab: { id: tabId }, frameId }) as chrome.runtime.MessageSender;
  const notes = () => (session[NOTES_KEY] ?? {}) as Record<string, TabNote>;

  beforeEach(() => {
    local = { iranList: encodeGroups(['digikala.com']) };
    session = {};
    reloads = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('chrome', {
      storage: { local: area(() => local), session: area(() => session) },
      tabs: {
        reload: async (tabId: number, o: { bypassCache: boolean }) =>
          void reloads.push({ tabId, ...o }),
      },
    });
    local.state = live();
  });

  it('reloads the tab once and records it', async () => {
    const r = await handleStaleReport(report(), sender());
    expect(r).toEqual({ reloaded: true, reason: 'reload' });
    expect(reloads).toEqual([{ tabId: 7, bypassCache: false }]);
    expect(notes()[7]).toMatchObject({ outcome: 'reloaded', url: 'https://news.example.com/a' });
  });
  it('closing a tab forgets its reloads, and tabs navigating at once keep their entries', async () => {
    await handleStaleReport(report(), sender(7));
    await handleStaleReport(report(), sender(8));
    await forgetTab(7);
    expect(Object.keys(session.tabReloads as object)).toEqual(['8|https://news.example.com/a']);
    const nav = (tabId: number) => ({
      tabId,
      frameId: 0,
      url: 'https://a.com/',
      transitionType: 'link',
    });
    await Promise.all([trackNavigation(nav(1)), trackNavigation(nav(2))]);
    expect(Object.keys(session.tabNavs as object)).toEqual(['1', '2']);
  });
  it('hard-reloads a Service Worker page', async () => {
    await handleStaleReport(report({ serviceWorker: true }), sender());
    expect(reloads).toEqual([{ tabId: 7, bypassCache: true }]);
  });
  it('does not reload the same tab and URL twice, and says the page may be unprotected', async () => {
    await handleStaleReport(report(), sender());
    const second = await handleStaleReport(report(), sender());
    expect(second).toEqual({ reloaded: false, reason: 'recently-reloaded' });
    expect(reloads).toHaveLength(1);
    expect(notes()[7]).toMatchObject({ outcome: 'unprotected', reason: 'recently-reloaded' });
    // another tab, or another URL, is a separate case
    expect((await handleStaleReport(report(), sender(8))).reloaded).toBe(true);
    expect(
      (await handleStaleReport(report({ url: 'https://news.example.com/b' }), sender())).reloaded,
    ).toBe(true);
  });
  it('never reloads after a form submit', async () => {
    await trackNavigation({
      tabId: 7,
      frameId: 0,
      url: report().url,
      transitionType: 'form_submit',
    });
    const r = await handleStaleReport(report(), sender());
    expect(r).toEqual({ reloaded: false, reason: 'form-submit' });
    expect(reloads).toHaveLength(0);
    expect(notes()[7]).toMatchObject({ outcome: 'unprotected', reason: 'form-submit' });
  });
  it('ignores a form submit from an earlier page of the tab', async () => {
    await trackNavigation({
      tabId: 7,
      frameId: 0,
      url: 'https://other.example.com/',
      transitionType: 'form_submit',
    });
    expect((await handleStaleReport(report(), sender())).reloaded).toBe(true);
  });
  it('skips whitelisted, direct, captcha, paused and sub-frame reports without noting them', async () => {
    local.state = live({ whitelist: ['example.com'] });
    expect((await handleStaleReport(report(), sender())).reason).toBe('whitelisted');
    local.state = live();
    expect(
      (await handleStaleReport(report({ url: 'https://www.digikala.com/' }), sender())).reason,
    ).toBe('direct-site');
    expect(
      (await handleStaleReport(report({ url: 'https://hcaptcha.com/' }), sender())).reason,
    ).toBe('captcha');
    expect((await handleStaleReport(report(), sender(7, 3))).reason).toBe('not-top-frame');
    local.state = live({ killSwitchActive: true });
    expect((await handleStaleReport(report(), sender())).reason).toBe('protection-inactive');
    expect(reloads).toHaveLength(0);
    expect(notes()).toEqual({});
  });
  it('a note belongs to one page: navigating elsewhere clears it', async () => {
    await handleStaleReport(report(), sender());
    expect(notes()[7]).toBeDefined();
    await trackNavigation({
      tabId: 7,
      frameId: 0,
      url: 'https://other.example.com/',
      transitionType: 'link',
    });
    expect(notes()[7]).toBeUndefined();
    await trackNavigation({
      tabId: 7,
      frameId: 5,
      url: 'https://frame.example.com/',
      transitionType: 'auto_subframe',
    });
  });
  it('needs a tab', async () => {
    expect(await handleStaleReport(report(), {} as chrome.runtime.MessageSender)).toEqual({
      reloaded: false,
      reason: 'no-tab',
    });
  });
});

describe('audit gate', () => {
  const ok = live();
  it('explains each state', () => {
    expect(auditGate({ ...ok, enabled: false }, 'https://a.com/', undefined)).toMatchObject({
      ok: false,
      message: expect.stringContaining('proxy is off'),
    });
    expect(auditGate({ ...ok, killSwitchActive: true }, 'https://a.com/', undefined)).toMatchObject(
      { ok: false },
    );
    expect(auditGate({ ...ok, detectedExit: null }, 'https://a.com/', undefined)).toMatchObject({
      message: expect.stringContaining('Waiting'),
    });
    expect(auditGate(ok, 'chrome://extensions', undefined)).toMatchObject({
      message: expect.stringContaining('cannot be audited'),
    });
    expect(auditGate(ok, 'https://chromewebstore.google.com/x', undefined)).toMatchObject({
      ok: false,
    });
    expect(auditGate(ok, undefined, undefined)).toMatchObject({ ok: false });
    expect(
      auditGate({ ...ok, whitelist: ['a.com'] }, 'https://www.a.com/', undefined),
    ).toMatchObject({
      message: expect.stringContaining('whitelisted'),
    });
    expect(auditGate(ok, 'https://hcaptcha.com/', undefined)).toMatchObject({
      message: expect.stringContaining('Captcha'),
    });
    expect(auditGate(ok, 'https://x.ir/', undefined).ok).toBe(true); // proxied: audited normally
    expect(
      auditGate({ ...ok, extraDirectDomains: ['mine.org'] }, 'https://mine.org/', undefined),
    ).toMatchObject({ ok: false, message: expect.stringContaining('directly') });
    expect(
      auditGate(ok, 'https://www.digikala.com/', encodeGroups(['digikala.com'])),
    ).toMatchObject({ ok: false });
  });
  it('passes with the expected timezone', () => {
    expect(auditGate(ok, 'https://example.com/', undefined)).toEqual({
      ok: true,
      timezone: 'Europe/Berlin',
    });
  });
});

describe('audit analysis', () => {
  const NOW = Date.UTC(2020, 0, 15, 12);
  const good: AuditObservation = {
    now: NOW,
    tz: 'Europe/Berlin',
    offset: -60,
    dateString: 'Wed Jan 15 2020 13:00:00 GMT+0100',
    calendar: 'gregory',
    numbering: 'latn',
    faCalendar: 'gregory',
    faNumbering: 'latn',
    faSample: '1,234.5 1/1/1970',
    language: 'en-US',
    languages: ['en-US', 'en'],
    voiceLangs: ['en-US', 'de-DE'],
    fonts: [],
    keyA: 'a',
    iceTransportPolicy: 'relay',
  };
  const run = (
    obs: Partial<AuditObservation> = {},
    shields = SHIELD_DEFAULTS,
    policy = 'disable_non_proxied_udp',
  ) => analyzeAudit({ ...good, ...obs }, 'Europe/Berlin', shields, policy);
  const status = (r: ReturnType<typeof run>) =>
    Object.fromEntries(r.chips.map((c) => [c.id, c.status]));

  it('a fully protected page passes every chip', () => {
    const r = run();
    expect(r.level).toBe('ok');
    expect(r.summary).toBe('All checks passed');
    expect(Object.values(status(r)).every((s) => s === 'ok')).toBe(true);
    expect(r.chips.map((c) => c.id)).toEqual([
      'timezone',
      'offset',
      'calendar',
      'digits',
      'language',
      'voices',
      'fonts',
      'keyboard',
      'webrtc',
    ]);
  });
  it('a broken shield shows a red chip with what the site sees and the shield to fix it', () => {
    const r = run({ tz: 'Asia/Tehran', offset: -210 });
    expect(r.level).toBe('bad');
    const tz = r.chips.find((c) => c.id === 'timezone')!;
    expect(tz).toMatchObject({ status: 'bad', seen: 'Asia/Tehran', shield: 'timezone' });
    expect(r.chips.find((c) => c.id === 'offset')).toMatchObject({
      status: 'bad',
      shield: 'timezone',
    });
    expect(r.summary).toBe('2 of 9 checks failed');
  });
  it('detects Persian fonts, voices, keyboard, calendar, digits and language leaks', () => {
    const r = run({
      fonts: ['Vazir', 'Sahel'],
      voiceLangs: ['fa-IR', 'en-US'],
      keyA: 'ش',
      faCalendar: 'persian',
      faNumbering: 'arabext',
      faSample: '۱٬۲۳۴٫۵',
      language: 'fa-IR',
      languages: ['fa-IR'],
    });
    expect(status(r)).toMatchObject({
      fonts: 'bad',
      voices: 'bad',
      keyboard: 'bad',
      calendar: 'bad',
      digits: 'bad',
      language: 'bad',
    });
    expect(r.chips.find((c) => c.id === 'fonts')?.seen).toContain('Vazir');
    expect(r.chips.find((c) => c.id === 'keyboard')?.shield).toBe('keyboard');
  });
  it('a shield that is switched off is grey, not red', () => {
    const r = run(
      { tz: 'Asia/Tehran', offset: -210, fonts: ['Vazir'] },
      { ...SHIELD_DEFAULTS, timezone: false, fonts: false },
    );
    expect(status(r)).toMatchObject({ timezone: 'off', offset: 'off', fonts: 'off' });
    expect(r.level).toBe('warn');
    expect(r.summary).toContain('shields off');
  });
  it('unknowns are neutral', () => {
    expect(status(run({ voiceLangs: [], keyA: 'unsupported' }))).toMatchObject({
      voices: 'na',
      keyboard: 'na',
    });
  });
  it('WebRTC needs both the browser policy and relay-only ICE', () => {
    expect(status(run({}, SHIELD_DEFAULTS, 'default')).webrtc).toBe('bad');
    expect(status(run({ iceTransportPolicy: 'all' })).webrtc).toBe('bad');
  });
});

// The real built bridge, with a fake page: does it notice a missing MAIN-world script?
describe.skipIf(!existsSync('dist/chrome/content/bridge.js'))(
  'built bridge: MAIN-world handshake',
  () => {
    const HANDSHAKE = '__nl__';

    function boot(opts: {
      mainPresent: boolean;
      config?: unknown;
      hostname?: string;
      framed?: boolean;
      stored?: Record<string, unknown>;
    }) {
      const target = new EventTarget();
      const timers: (() => void)[] = [];
      const sent: unknown[] = [];
      const win: Record<string, unknown> = {
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        dispatchEvent: target.dispatchEvent.bind(target),
      };
      win.window = win;
      const config = opts.config ?? buildSpoofConfig(live());
      const stored = opts.stored ?? {};
      const ctx = createContext({
        ...win,
        CustomEvent,
        TextEncoder,
        Event,
        URL,
        JSON,
        setTimeout: (fn: () => void) => void timers.push(fn),
        location: {
          hostname: opts.hostname ?? 'news.example.com',
          pathname: '/',
          href: 'https://news.example.com/',
          origin: 'https://news.example.com',
          ancestorOrigins: [],
        },
        navigator: { serviceWorker: { controller: {} } },
        performance: { getEntriesByType: () => [{ deliveryType: 'cache', type: 'navigate' }] },
        chrome: {
          storage: {
            local: {
              get: async () => ({ [CONFIG_KEY]: config, workerPrelude: '/*p*/', ...stored }),
              set: async (v: Record<string, unknown>) => void Object.assign(stored, v),
            },
            onChanged: { addListener: () => undefined },
          },
          runtime: { sendMessage: async (m: unknown) => void sent.push(m) },
        },
      });
      runInContext(
        `globalThis.window = globalThis; globalThis.top = ${opts.framed ? '{}' : 'globalThis'};`,
        ctx,
      );
      if (opts.mainPresent) {
        // A stand-in for the MAIN-world script: answers the bridge's hello with its page-specific
        // name, then acknowledges every config message on that name.
        const name = 'abc123';
        target.addEventListener(HANDSHAKE, (e) => {
          const hello = JSON.parse((e as CustomEvent<string>).detail);
          if (hello.k === 'bridge') {
            target.dispatchEvent(
              new CustomEvent(HANDSHAKE, { detail: JSON.stringify({ k: 'main', n: name }) }),
            );
          }
        });
        target.addEventListener(name, () => target.dispatchEvent(new Event(`${name}a`)));
      }
      return {
        ctx,
        target,
        timers,
        sent,
        run: () => runInContext(readFileSync('dist/chrome/content/bridge.js', 'utf8'), ctx),
      };
    }
    const settle = async (env: ReturnType<typeof boot>) => {
      env.run();
      await new Promise((r) => setTimeout(r, 20));
      while (env.timers.length) env.timers.shift()!();
      await new Promise((r) => setTimeout(r, 20));
    };

    it('stays quiet when the MAIN-world script answers', async () => {
      const env = boot({ mainPresent: true });
      await settle(env);
      expect(env.sent).toEqual([]);
    });
    it('reports a protected page whose MAIN-world script is missing, with how it was served', async () => {
      const env = boot({ mainPresent: false });
      await settle(env);
      expect(env.sent).toEqual([
        {
          type: 'staleReport',
          url: 'https://news.example.com/',
          serviceWorker: true,
          deliveryType: 'cache',
          navigationType: 'navigate',
        },
      ]);
    });
    it('does not report when nothing is being spoofed, on whitelisted sites, or from frames', async () => {
      for (const env of [
        boot({ mainPresent: false, config: buildSpoofConfig({ ...live(), enabled: false }) }),
        boot({
          mainPresent: false,
          config: buildSpoofConfig(live({ whitelist: ['example.com'] })),
        }),
        boot({ mainPresent: false, hostname: 'hcaptcha.com' }),
        boot({ mainPresent: false, framed: true }),
      ]) {
        await settle(env);
        expect(env.sent).toEqual([]);
      }
    });
    it('remembers an origin whose CSP blocked the blob worker and sends no prelude there (B10)', async () => {
      const preludes = (env: ReturnType<typeof boot>) => {
        const seen: unknown[] = [];
        env.target.addEventListener('abc123', (e) =>
          seen.push(JSON.parse((e as CustomEvent<string>).detail).prelude),
        );
        return seen;
      };
      const stored: Record<string, unknown> = {};
      const first = boot({ mainPresent: true, stored });
      const seen = preludes(first);
      await settle(first);
      expect(seen.at(-1)).toBe('/*p*/');
      first.target.dispatchEvent(
        Object.assign(new Event('securitypolicyviolation'), {
          violatedDirective: 'worker-src',
          blockedURI: 'blob',
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(stored.blobBlockedOrigins).toHaveLength(1);
      const next = boot({ mainPresent: true, stored });
      const later = preludes(next);
      await settle(next);
      expect(later.at(-1)).toBeNull();
    });
  },
);
