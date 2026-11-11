import { runInContext, createContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import { installSpoof } from '../src/content/spoof';
import { SHIELD_DEFAULTS } from '../src/shared/shields';
import { NO_FINGERPRINT } from '../src/shared/fingerprint';
import { buildSpoofConfig, LANGUAGES, LOCALE } from '../src/shared/spoof-config';
import { DEFAULT_STATE } from '../src/shared/storage';

const NY = {
  active: true,
  timezone: 'America/New_York',
  locale: LOCALE,
  acceptLanguage: 'en-US,en;q=0.9',
  languages: LANGUAGES,
  whitelist: [],
  fingerprint: NO_FINGERPRINT,
  shields: SHIELD_DEFAULTS,
  coordinates: null,
  stealth: false,
};

let ctx: ReturnType<typeof createContext>;
let spoof: ReturnType<typeof installSpoof>;
const run = <T = unknown>(code: string): T => runInContext(code, ctx) as T;

beforeEach(() => {
  ctx = createContext({});
  spoof = installSpoof(runInContext('globalThis', ctx));
  spoof.setConfig(NY);
});

describe('timezone spoofing (America/New_York)', () => {
  it('shifts getters and offset, DST-correct', () => {
    expect(run('new Date(Date.UTC(2020,0,15,12)).getHours()')).toBe(7);
    expect(run('new Date(Date.UTC(2020,0,15,12)).getTimezoneOffset()')).toBe(300);
    expect(run('new Date(Date.UTC(2020,6,15,12)).getHours()')).toBe(8);
    expect(run('new Date(Date.UTC(2020,6,15,12)).getTimezoneOffset()')).toBe(240);
    expect(run('new Date(Date.UTC(2020,0,1,3)).getDate()')).toBe(31); // still Dec 31 locally
    expect(run('new Date(Date.UTC(2020,0,1,3)).getFullYear()')).toBe(2019);
  });
  it('formats toString like Chrome', () => {
    expect(run('new Date(Date.UTC(2020,0,15,12)).toString()')).toBe(
      'Wed Jan 15 2020 07:00:00 GMT-0500 (Eastern Standard Time)',
    );
    expect(run('new Date(Date.UTC(2020,6,15,12)).toTimeString()')).toBe(
      '08:00:00 GMT-0400 (Eastern Daylight Time)',
    );
    expect(run('new Date(Date.UTC(2020,0,15,12)).toDateString()')).toBe('Wed Jan 15 2020');
    expect(run('new Date(NaN).toString()')).toBe('Invalid Date');
  });
  it('Intl and toLocale* agree', () => {
    expect(run('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe('America/New_York');
    expect(run('Intl.DateTimeFormat().resolvedOptions().locale')).toBe('en-US');
    expect(run('new Date(Date.UTC(2020,0,15,12)).toLocaleString()')).toBe('1/15/2020, 7:00:00 AM');
    expect(run("new Date(Date.UTC(2020,0,15,12)).toLocaleString('en-US',{timeZone:'UTC'})")).toBe(
      '1/15/2020, 12:00:00 PM',
    );
  });
  it('local-time constructors and parsing use the spoofed zone', () => {
    const utc = Date.UTC(2020, 0, 15, 12);
    expect(run('new Date(2020,0,15,7,0,0).getTime()')).toBe(utc);
    expect(run('new Date(2020,2,8,12).getTime()')).toBe(Date.UTC(2020, 2, 8, 16)); // EDT
    expect(run("new Date('2020-01-15T07:00:00').getTime()")).toBe(utc);
    expect(run("Date.parse('2020-01-15T07:00:00')")).toBe(utc);
    expect(run("new Date('2020-01-15T12:00:00Z').getTime()")).toBe(utc);
    expect(run("new Date('2020-01-15').getTime()")).toBe(Date.UTC(2020, 0, 15));
    expect(run("new Date('Jan 15 2020 12:00:00 GMT+0000').getTime()")).toBe(utc);
    for (const tz of ['EST', 'EDT', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT']) {
      const s = `Mon, 01 Jan 2024 10:00:00 ${tz}`;
      expect(run(`new Date('${s}').getTime()`)).toBe(Date.parse(s));
    }
    // A month name after the time is still local time, so it must be shifted.
    expect(run("new Date('Jan 15 2020 07:00:00 Jan').getTime()")).toBe(utc);
  });
  it('setters work in the spoofed zone', () => {
    expect(
      run(
        '(() => { const d = new Date(Date.UTC(2020,0,15,12)); d.setHours(9); return d.getTime(); })()',
      ),
    ).toBe(Date.UTC(2020, 0, 15, 14));
    expect(
      run(
        '(() => { const d = new Date(Date.UTC(2020,0,15,12)); d.setDate(1); return d.getDate(); })()',
      ),
    ).toBe(1);
  });
  it('round-trips with the native UTC view', () => {
    expect(run('new Date(Date.UTC(2020,0,15,12)).toISOString()')).toBe('2020-01-15T12:00:00.000Z');
    expect(run('Date.UTC(2020,0,15,12)')).toBe(Date.UTC(2020, 0, 15, 12));
  });
  it('Date() as a function returns a spoofed string', () => {
    expect(run('Date()')).toMatch(/GMT-0[45]00 \(Eastern (Standard|Daylight) Time\)$/);
  });
});

describe('pausing and invalid config', () => {
  it('falls back to native behaviour when paused', () => {
    const native = new Date(Date.UTC(2020, 0, 15, 12));
    spoof.setConfig(null);
    expect(run('new Date(Date.UTC(2020,0,15,12)).getHours()')).toBe(native.getHours());
    expect(run('new Date(2020,0,15,7).getTime()')).toBe(new Date(2020, 0, 15, 7).getTime());
  });
  it('stays paused for an unknown timezone', () => {
    spoof.setConfig({ ...NY, timezone: 'Mars/Olympus' });
    expect(run('new Date(Date.UTC(2020,0,15,12)).getHours()')).toBe(
      new Date(Date.UTC(2020, 0, 15, 12)).getHours(),
    );
  });
});

describe('shield flags', () => {
  const realHour = new Date(Date.UTC(2020, 0, 15, 12)).getHours();
  const nyHour = 7;
  const hour = () => run('new Date(Date.UTC(2020,0,15,12)).getHours()');
  const tzName = () => run('Intl.DateTimeFormat().resolvedOptions().timeZone');
  const locale = () => run('Intl.DateTimeFormat().resolvedOptions().locale');

  it('timezone off changes only the timezone behaviour', () => {
    spoof.setConfig({ ...NY, shields: { ...SHIELD_DEFAULTS, timezone: false } });
    expect(hour()).toBe(realHour);
    expect(tzName()).not.toBe('America/New_York');
    expect(locale()).toBe('en-US'); // locale shield still on
  });
  it('locale off changes only the locale behaviour', () => {
    spoof.setConfig({ ...NY, shields: { ...SHIELD_DEFAULTS, locale: false } });
    expect(hour()).toBe(nyHour);
    expect(tzName()).toBe('America/New_York');
    const plain = new Intl.DateTimeFormat().resolvedOptions().locale;
    expect(locale()).toBe(plain);
  });
  it('both off is fully native', () => {
    spoof.setConfig({ ...NY, shields: { ...SHIELD_DEFAULTS, timezone: false, locale: false } });
    expect(hour()).toBe(realHour);
    expect(locale()).toBe(new Intl.DateTimeFormat().resolvedOptions().locale);
  });
  it('treats a config without shields (older stored config) as defaults', () => {
    const legacy: Partial<typeof NY> = { ...NY };
    delete legacy.shields;
    spoof.setConfig(legacy as never);
    expect(hour()).toBe(nyHour);
  });
});

describe('native-looking patches', () => {
  it('keeps names, lengths and native toString', () => {
    expect(run('Date.name')).toBe('Date');
    expect(run('Date.prototype.getHours.name')).toBe('getHours');
    expect(run('Date.prototype.setHours.length')).toBe(4);
    expect(run('Function.prototype.toString.call(Date.prototype.getHours)')).toBe(
      'function getHours() { [native code] }',
    );
    expect(run('Function.prototype.toString.call(Date)')).toBe('function Date() { [native code] }');
    expect(run('Function.prototype.toString.call(Function.prototype.toString)')).toBe(
      'function toString() { [native code] }',
    );
    expect(run('Date.prototype.getHours.hasOwnProperty("prototype")')).toBe(false);
  });
  it('keeps identity relationships', () => {
    expect(run('new Date() instanceof Date')).toBe(true);
    expect(run('Date.prototype.constructor === Date')).toBe(true);
    expect(run('Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat')).toBe(true);
    expect(run('new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat')).toBe(true);
    expect(run('class D extends Date {}; new D(0) instanceof D')).toBe(true);
  });
});

describe('buildSpoofConfig', () => {
  const profile = { id: 'a', name: 'a', host: 'h.com', port: 1 };
  const exit = { ip: '1.1.1.1', countryCode: 'DE', timezone: 'Europe/Berlin', detectedAt: 0 };
  const ok = {
    ...DEFAULT_STATE,
    enabled: true,
    profiles: [profile],
    activeProfileId: 'a',
    detectedExit: exit,
  };

  it('is active when proxy is on and exit known', () => {
    expect(buildSpoofConfig(ok)).toMatchObject({ active: true, timezone: 'Europe/Berlin' });
  });
  it('pauses when off, blocked, or without detection', () => {
    expect(buildSpoofConfig({ ...ok, enabled: false })).toMatchObject({ active: false });
    expect(buildSpoofConfig({ ...ok, killSwitchActive: true })).toMatchObject({ active: false });
    expect(buildSpoofConfig({ ...ok, detectedExit: null })).toMatchObject({ active: false });
  });
  it('a manual country waits for the first check to see the exit (B18)', () => {
    const manual = { ...ok, countryOverride: 'JP' };
    expect(buildSpoofConfig({ ...manual, detectedExit: null })).toMatchObject({ active: false });
    expect(buildSpoofConfig(manual)).toMatchObject({ active: true, timezone: 'Asia/Tokyo' });
  });
});

describe('Temporal.Now (B8)', () => {
  it('uses the spoofed zone when the caller gives none, and the real one when paused', () => {
    ctx = createContext({});
    run(`globalThis.Temporal = { Now: {
      timeZoneId() { return 'Asia/Tehran'; },
      zonedDateTimeISO(tz) { return tz ?? 'Asia/Tehran'; },
      plainDateTimeISO(tz) { return tz ?? 'Asia/Tehran'; },
      plainDateISO(tz) { return tz ?? 'Asia/Tehran'; },
      plainTimeISO(tz) { return tz ?? 'Asia/Tehran'; },
    }, Instant: class { toLocaleString(l, o) { return [l, o?.timeZone]; } },
      PlainDate: class { toLocaleString(l, o) { return [l, o?.timeZone]; } } }`);
    spoof = installSpoof(runInContext('globalThis', ctx));
    spoof.setConfig(NY);
    expect(run('Temporal.Now.timeZoneId()')).toBe('America/New_York');
    for (const f of ['zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO']) {
      expect(run(`Temporal.Now.${f}()`)).toBe('America/New_York');
      expect(run(`Temporal.Now.${f}('UTC')`)).toBe('UTC');
    }
    expect(run('new Temporal.Instant().toLocaleString()')).toEqual([LOCALE, 'America/New_York']);
    expect(run("new Temporal.Instant().toLocaleString('de', { timeZone: 'UTC' })")).toEqual([
      'de',
      'UTC',
    ]);
    expect(run('new Temporal.PlainDate().toLocaleString()')).toEqual([LOCALE, undefined]);
    spoof.setConfig({ ...NY, shields: { ...SHIELD_DEFAULTS, timezone: false } });
    expect(run('Temporal.Now.timeZoneId()')).toBe('Asia/Tehran');
    expect(run('Temporal.Now.plainDateISO()')).toBe('Asia/Tehran');
  });
});
