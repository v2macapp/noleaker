import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFonts } from '../src/content/fonts';
import { installGeolocation } from '../src/content/geolocation';
import { installKeyboard, US_LAYOUT } from '../src/content/keyboard';
import { installSpoof } from '../src/content/spoof';
import { installVoices } from '../src/content/voices';
import { isPersianFont, normalizeFamily, PERSIAN_FONTS } from '../src/shared/persian-fonts';
import { SHIELD_DEFAULTS } from '../src/shared/shields';
import { buildSpoofConfig, INACTIVE_CONFIG, type SpoofConfig } from '../src/shared/spoof-config';
import { DEFAULT_STATE } from '../src/shared/storage';
import { NO_FINGERPRINT } from '../src/shared/fingerprint';

const DE = { latitude: 52.52, longitude: 13.4 };
const config = (
  over: Partial<SpoofConfig['shields']> = {},
  extra: Partial<SpoofConfig> = {},
): SpoofConfig => ({
  active: true,
  timezone: 'Europe/Berlin',
  locale: 'en-US',
  acceptLanguage: 'en-US,en;q=0.9',
  languages: ['en-US', 'en'],
  whitelist: [],
  fingerprint: NO_FINGERPRINT,
  shields: { ...SHIELD_DEFAULTS, ...over },
  coordinates: DE,
  stealth: false,
  ...extra,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newContext = (setup: string) => {
  const ctx = createContext({ setTimeout, clearTimeout });
  runInContext(setup, ctx);
  return {
    ctx,
    g: runInContext('globalThis', ctx),
    run: <T = unknown>(code: string) => runInContext(code, ctx) as T,
  };
};

describe('Persian font list', () => {
  it('has 47 families and matches loosely', () => {
    expect(PERSIAN_FONTS).toHaveLength(47);
    // "IRANSans" and "IRAN Sans" normalise to the same key, so 46 distinct keys.
    expect(new Set(PERSIAN_FONTS.map(normalizeFamily)).size).toBe(46);
    for (const name of ['B-Nazanin', "'b nazanin'", 'VAZIRMATN', 'iran_sans', 'IRANSans']) {
      expect(isPersianFont(name), name).toBe(true);
    }
    for (const name of ['Arial', 'Tahoma', 'Helvetica Neue', ''])
      expect(isPersianFont(name), name).toBe(false);
  });
});

describe('fonts shield', () => {
  const setup = `
    class CSSStyleDeclaration {
      get fontFamily() { return this._ff || ''; } set fontFamily(v) { this._ff = v; }
      get font() { return this._f || ''; } set font(v) { this._f = v; }
      get cssText() { return this._c || ''; } set cssText(v) { this._c = v; }
      setProperty(name, value) { this['p:' + name] = value; }
    }
    class Element { setAttribute(n, v) { (this.attrs ||= {})[n] = v; } }
    class CanvasRenderingContext2D { get font() { return this._f || ''; } set font(v) { this._f = v; } }
    class FontFaceSet {
      constructor() { this.faces = []; }
      forEach(cb) { this.faces.forEach(cb); }
      check(font) { this.last = font; return true; }
      addEventListener(type, fn) { this['on' + type] = fn; }
    }
    Object.assign(globalThis, { CSSStyleDeclaration, Element, CanvasRenderingContext2D, FontFaceSet });
    globalThis.document = { fonts: new FontFaceSet() };
  `;
  let env: ReturnType<typeof newContext>;
  let fonts: ReturnType<typeof installFonts>;
  beforeEach(() => {
    env = newContext(setup);
    fonts = installFonts(env.g);
    fonts.setConfig(config());
  });
  const ff = (value: string) =>
    env.run<string>(
      `(() => { const s = new CSSStyleDeclaration(); s.fontFamily = ${JSON.stringify(value)}; return s.fontFamily; })()`,
    );

  it('removes Persian families from font-family', () => {
    expect(ff('"IRANSans", monospace')).toBe('monospace');
    expect(ff('Vazir, "B-Nazanin", Arial')).toBe('Arial');
  });
  it('patches the accessor where newer Chrome defines it (CSSStyleProperties)', () => {
    // Accessors live on a subclass, as in Chrome 2025+.
    const e = newContext(
      setup +
        `class CSSStyleProperties extends CSSStyleDeclaration {}
        for (const k of ['fontFamily', 'font']) {
          Object.defineProperty(CSSStyleProperties.prototype, k,
            Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, k));
          delete CSSStyleDeclaration.prototype[k];
        }
        globalThis.CSSStyleProperties = CSSStyleProperties;`,
    );
    installFonts(e.g).setConfig(config());
    expect(
      e.run(
        `(() => { const s = new CSSStyleProperties(); s.fontFamily = 'Vazirmatn, serif'; return s.fontFamily; })()`,
      ),
    ).toBe('serif');
  });
  it('leaves other stacks byte-for-byte unchanged', () => {
    expect(ff('Arial,   Helvetica , sans-serif')).toBe('Arial,   Helvetica , sans-serif');
  });
  it('falls back to the default font when nothing is left', () => {
    expect(ff('IRANSans')).toBe('serif');
  });
  it('handles cssText, setAttribute, setProperty and the font shorthand', () => {
    expect(
      env.run(
        `(() => { const s = new CSSStyleDeclaration(); s.cssText = 'color: red; font-family: Vazir, Arial'; return s.cssText; })()`,
      ),
    ).toBe('color: red; font-family: Arial');
    expect(
      env.run(
        `(() => { const s = new CSSStyleDeclaration(); s.cssText = 'font-size:12px; font: 12px Sahel'; return s.cssText; })()`,
      ),
    ).toBe('font-size:12px; font: 12px serif');
    expect(
      env.run(
        `(() => { const e = new Element(); e.setAttribute('style', 'font-family: Shabnam, monospace'); return e.attrs.style; })()`,
      ),
    ).toBe('font-family: monospace');
    expect(
      env.run(
        `(() => { const e = new Element(); e.setAttribute('title', 'font-family: Shabnam'); return e.attrs.title; })()`,
      ),
    ).toBe('font-family: Shabnam');
    expect(
      env.run(
        `(() => { const s = new CSSStyleDeclaration(); s.setProperty('font-family', 'Estedad, serif'); return s['p:font-family']; })()`,
      ),
    ).toBe('serif');
    expect(
      env.run(
        `(() => { const s = new CSSStyleDeclaration(); s.font = 'italic bold 14px Vazirmatn, sans-serif'; return s.font; })()`,
      ),
    ).toBe('italic bold 14px sans-serif');
  });
  it('handles canvas fonts, including size/line-height and quoted names', () => {
    const font = (v: string) =>
      env.run<string>(
        `(() => { const c = new CanvasRenderingContext2D(); c.font = ${JSON.stringify(v)}; return c.font; })()`,
      );
    expect(font('16px IRANSans, Arial')).toBe('16px Arial');
    expect(font('12px/1.5 "B Nazanin"')).toBe('12px/1.5 serif');
    expect(font('bold 10pt Verdana')).toBe('bold 10pt Verdana');
  });
  it('document.fonts.check evaluates a stack without the Persian font', () => {
    expect(
      env.run(`(() => { document.fonts.check('12px Sahel'); return document.fonts.last; })()`),
    ).toBe('12px serif');
  });
  it('never hides a family the page loaded itself', () => {
    env.run(`document.fonts.faces.push({ family: '"Vazir"' })`);
    expect(ff('Vazir, Arial')).toBe('Vazir, Arial');
    expect(ff('Sahel, Arial')).toBe('Arial'); // a different one is still hidden
  });
  it('puts a hidden family back once the page loads it or the shield turns off (B16)', () => {
    env.run(`
      const set = (v) => { const s = new CSSStyleDeclaration(); s.fontFamily = v; return s; };
      globalThis.early = set('Vazir, Arial');
      globalThis.rewritten = set('Sahel, Arial');
      globalThis.later = set('Sahel, Arial');
      rewritten.fontFamily = 'Tahoma';
      document.fonts.faces.push({ family: 'Vazir' });
      document.fonts.onloadingdone();
    `);
    expect(env.run('early.fontFamily')).toBe('Vazir, Arial'); // the page's own font arrived
    expect(env.run('later.fontFamily')).toBe('Arial'); // still hidden while the shield is on
    fonts.setConfig(config({ fonts: false }));
    expect(env.run('later.fontFamily')).toBe('Sahel, Arial');
    expect(env.run('rewritten.fontFamily')).toBe('Tahoma'); // the page's newer value stays
  });
  it('is inert when the shield is off or paused', () => {
    fonts.setConfig(config({ fonts: false }));
    expect(ff('IRANSans, monospace')).toBe('IRANSans, monospace');
    fonts.setConfig({ ...INACTIVE_CONFIG });
    expect(ff('IRANSans, monospace')).toBe('IRANSans, monospace');
  });
  it('keeps patched setters native-looking', () => {
    expect(
      env.run(
        `Function.prototype.toString.call(Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'fontFamily').set)`,
      ),
    ).toBe('function set fontFamily() { [native code] }');
  });
});

describe('voices shield', () => {
  const setup = `
    class SpeechSynthesis {
      getVoices() { return [{ lang: 'fa-IR' }, { lang: 'en-US' }, { lang: 'fa' }, { lang: 'fa_IR' }, { lang: 'de-DE' }]; }
    }
    globalThis.SpeechSynthesis = SpeechSynthesis;
  `;
  it('filters fa and fa-* voices only when on', () => {
    const env = newContext(setup);
    const voices = installVoices(env.g);
    const langs = () => env.run<string[]>('new SpeechSynthesis().getVoices().map((v) => v.lang)');
    expect(langs()).toHaveLength(5);
    voices.setConfig(config());
    expect(langs()).toEqual(['en-US', 'de-DE']);
    voices.setConfig(config({ voices: false }));
    expect(langs()).toHaveLength(5);
  });
});

describe('keyboard shield', () => {
  const setup = `
    class Keyboard { getLayoutMap() { return Promise.resolve(new Map([['KeyA', 'ش']])); } }
    globalThis.Keyboard = Keyboard;
  `;
  it('returns a US QWERTY map when on, the real one when off', async () => {
    const env = newContext(setup);
    const keyboard = installKeyboard(env.g);
    const get = (code: string) =>
      env.run<Promise<string>>(
        `new Keyboard().getLayoutMap().then((m) => m.get(${JSON.stringify(code)}))`,
      );
    expect(await get('KeyA')).toBe('ش');
    keyboard.setConfig(config());
    expect(await get('KeyA')).toBe('a');
    expect(await get('Digit5')).toBe('5');
    expect(await get('Slash')).toBe('/');
    expect(
      await env.run<Promise<number>>('new Keyboard().getLayoutMap().then((m) => m.size)'),
    ).toBe(US_LAYOUT.length);
    expect(
      await env.run<Promise<string>>('new Keyboard().getLayoutMap().then((m) => String(m))'),
    ).toBe('[object KeyboardLayoutMap]');
    keyboard.setConfig(config({ keyboard: false }));
    expect(await get('KeyA')).toBe('ش');
  });
  it('covers every printable key of a US layout exactly once', () => {
    expect(new Set(US_LAYOUT.map(([code]) => code)).size).toBe(US_LAYOUT.length);
    expect(US_LAYOUT).toHaveLength(47);
  });
});

describe('geolocation shield', () => {
  const setup = `
    class GeolocationCoordinates {}
    class GeolocationPosition {}
    class Geolocation {
      getCurrentPosition(success, error) { if (error) error({ code: 1, message: 'denied' }); }
      watchPosition(success, error) { if (error) error({ code: 1 }); return 99; }
      clearWatch(id) { (globalThis.cleared ||= []).push(id); }
    }
    class PermissionStatus { get state() { return 'denied'; } }
    class Permissions { query(d) { return Promise.resolve(new PermissionStatus()); } }
    Object.assign(globalThis, { GeolocationCoordinates, GeolocationPosition, Geolocation, Permissions, PermissionStatus });
    globalThis.log = [];
  `;
  let env: ReturnType<typeof newContext>;
  let geo: ReturnType<typeof installGeolocation>;
  beforeEach(() => {
    env = newContext(setup);
    geo = installGeolocation(env.g, { random: () => 0.5 });
  });
  const current = `new Geolocation().getCurrentPosition((p) => log.push(['ok', p]), (e) => log.push(['err', e]))`;

  it('is native when off', () => {
    env.run(current);
    expect(env.run<string>('log[0][0]')).toBe('err');
  });
  it('returns a position in the exit country after a delay, never an error', async () => {
    geo.setConfig(config());
    const start = Date.now();
    env.run(current);
    expect(env.run<number>('log.length')).toBe(0); // not synchronous
    await sleep(450);
    expect(env.run<number>('log.length')).toBe(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    expect(env.run<string>('log[0][0]')).toBe('ok');
    const [lat, lon, accuracy, altitude] = env.run<number[]>(
      '[log[0][1].coords.latitude, log[0][1].coords.longitude, log[0][1].coords.accuracy, log[0][1].coords.altitude]',
    );
    expect(Math.abs(lat! - DE.latitude)).toBeLessThan(0.002);
    expect(Math.abs(lon! - DE.longitude)).toBeLessThan(0.002);
    expect(accuracy).toBeGreaterThanOrEqual(20);
    expect(accuracy).toBeLessThanOrEqual(100);
    expect(altitude).toBeNull();
    expect(env.run('log[0][1] instanceof GeolocationPosition')).toBe(true);
    expect(env.run('log[0][1].coords instanceof GeolocationCoordinates')).toBe(true);
    expect(env.run<string>('JSON.stringify(log[0][1].coords)')).toContain('"latitude"');
  });
  it('watchPosition fires, and clearWatch stops it without touching the native one', async () => {
    geo.setConfig(config());
    const id = env.run<number>(`new Geolocation().watchPosition((p) => log.push(['watch', p]))`);
    expect(id).not.toBe(99);
    await sleep(450);
    expect(env.run<number>('log.length')).toBe(1);
    env.run(`new Geolocation().clearWatch(${id})`);
    expect(env.run('globalThis.cleared')).toBeUndefined();
    env.run('new Geolocation().clearWatch(99)'); // not ours: native handles it
    expect(env.run('globalThis.cleared')).toEqual([99]);
  });
  it('rejects a missing callback like the native API', () => {
    geo.setConfig(config());
    expect(() => env.run('new Geolocation().getCurrentPosition()')).toThrow(/not a function/);
  });
  it('permissions.query reports granted for geolocation only', async () => {
    const state = (name: string) =>
      env.run<Promise<string>>(`new Permissions().query({ name: '${name}' }).then((s) => s.state)`);
    expect(await state('geolocation')).toBe('denied');
    geo.setConfig(config());
    expect(await state('geolocation')).toBe('granted');
    expect(await state('camera')).toBe('denied');
    geo.setConfig(config({ geolocation: false }));
    expect(await state('geolocation')).toBe('denied');
  });
  it('stays native for a country without coordinates', () => {
    geo.setConfig(config({}, { coordinates: null }));
    env.run(current);
    expect(env.run<string>('log[0][0]')).toBe('err');
  });
});

describe('calendar and digits', () => {
  const NY = config({}, { timezone: 'America/New_York' });
  const persian = /[۰-۹٠-٩]/;
  let env: ReturnType<typeof newContext>;
  let spoof: ReturnType<typeof installSpoof>;
  beforeEach(() => {
    env = newContext('');
    spoof = installSpoof(env.g);
  });

  it('shows gregorian dates and latin digits for a Persian locale with no options', () => {
    spoof.setConfig(NY);
    const text = env.run<string>(
      "new Intl.DateTimeFormat('fa-IR').format(new Date(Date.UTC(2020, 0, 15, 12)))",
    );
    expect(text).not.toMatch(persian);
    expect(text).toContain('2020');
    expect(
      env.run<string>("new Date(Date.UTC(2020, 0, 15, 12)).toLocaleDateString('fa-IR')"),
    ).not.toMatch(persian);
    expect(env.run<string>("(1234.5).toLocaleString('fa-IR')")).not.toMatch(persian);
    expect(env.run<string>("new Intl.NumberFormat('ar-EG').format(123)")).not.toMatch(persian);
  });
  it('does not override options the page chose', () => {
    spoof.setConfig(NY);
    const text = env.run<string>(
      "new Intl.DateTimeFormat('fa-IR', { numberingSystem: 'arab' }).format(new Date(0))",
    );
    expect(text).toMatch(persian);
  });
  it('is native when the locale shield is off', () => {
    spoof.setConfig(config({ locale: false }, { timezone: 'America/New_York' }));
    expect(env.run<string>("new Intl.DateTimeFormat('fa-IR').format(new Date(0))")).toMatch(
      persian,
    );
  });
});

describe('buildSpoofConfig coordinates', () => {
  const profile = { id: 'a', name: 'a', host: 'h.com', port: 1 };
  const live = (countryCode: string) => ({
    ...DEFAULT_STATE,
    enabled: true,
    profiles: [profile],
    activeProfileId: 'a',
    detectedExit: { ip: '1.1.1.1', countryCode, timezone: 'Europe/Berlin', detectedAt: 0 },
  });
  it('uses the exit country point', () => {
    expect(buildSpoofConfig(live('DE')).coordinates).toEqual(DE);
  });
  it('is null for a country not in the table', () => {
    expect(buildSpoofConfig(live('ZZ')).coordinates).toBeNull();
  });
});
