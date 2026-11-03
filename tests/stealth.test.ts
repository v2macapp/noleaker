/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { installAudio } from '../src/content/audio';
import { installFingerprint } from '../src/content/fingerprint';
import { installFonts } from '../src/content/fonts';
import { installGeolocation } from '../src/content/geolocation';
import { installKeyboard } from '../src/content/keyboard';
import { createNative, scrubStack } from '../src/content/native';
import { installRects } from '../src/content/rects';
import { installSpoof } from '../src/content/spoof';
import { installVoices } from '../src/content/voices';
import { installWebRtc } from '../src/content/webrtc';
import { installWorkers } from '../src/content/workers';
import { NO_FINGERPRINT } from '../src/shared/fingerprint';
import { SHIELD_DEFAULTS } from '../src/shared/shields';
import { buildSpoofConfig, CONFIG_KEY, type SpoofConfig } from '../src/shared/spoof-config';
import { DEFAULT_STATE } from '../src/shared/storage';
import type { State } from '../src/shared/types';

const profile = { id: 'a', name: 'a', host: 'h.com', port: 1 };
const live = (over: Partial<State> = {}): State => ({
  ...DEFAULT_STATE,
  enabled: true,
  profiles: [profile],
  activeProfileId: 'a',
  detectedExit: { ip: '1.1.1.1', countryCode: 'DE', timezone: 'Europe/Berlin', detectedAt: 0 },
  ...over,
});

// --- the real built scripts, started in either order, with nothing fixed left for the page --------
describe.skipIf(
  !existsSync('dist/chrome/content/main.js') || !existsSync('dist/chrome/content/bridge.js'),
)('built scripts: unguessable event names', () => {
  function boot(order: 'bridge-first' | 'main-first', state: State, hostname = 'news.example.com') {
    const target = new EventTarget();
    const seen: string[] = [];
    const config = buildSpoofConfig(state);
    const ctx = createContext({
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: (e: Event) => {
        seen.push(e.type);
        return target.dispatchEvent(e);
      },
      CustomEvent,
      TextEncoder,
      Event,
      URL,
      crypto: webcrypto,
      setTimeout: () => 0,
      location: {
        hostname,
        pathname: '/',
        href: `https://${hostname}/`,
        ancestorOrigins: [],
      },
      navigator: {},
      performance: { getEntriesByType: () => [] },
      chrome: {
        storage: {
          local: { get: async () => ({ [CONFIG_KEY]: config, workerPrelude: '/*p*/' }) },
          onChanged: { addListener: () => undefined },
        },
        runtime: { sendMessage: async () => undefined },
      },
    });
    runInContext('globalThis.window = globalThis; globalThis.top = globalThis;', ctx);
    const main = readFileSync('dist/chrome/content/main.js', 'utf8');
    const bridge = readFileSync('dist/chrome/content/bridge.js', 'utf8');
    for (const code of order === 'bridge-first' ? [bridge, main] : [main, bridge]) {
      runInContext(code, ctx);
    }
    const settled = new Promise((r) => setTimeout(r, 30));
    return {
      target,
      seen,
      ctx,
      settled,
      run: <T = unknown>(c: string) => runInContext(c, ctx) as T,
    };
  }
  const hours = 'new Date(Date.UTC(2020, 0, 15, 12)).getHours()';
  it('uses UTC before async configuration delivery and switches to the exit afterward', async () => {
    const env = boot('main-first', live());
    expect(env.run('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe('UTC');
    expect(env.run(hours)).toBe(12);
    await env.settled;
    expect(env.run('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe('Europe/Berlin');
  });

  it('leaves captcha frames untouched before configuration delivery', () => {
    const env = boot('main-first', live(), 'challenges.cloudflare.com');
    const real = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(env.run('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe(real);
  });

  for (const order of ['bridge-first', 'main-first'] as const) {
    it(`works when the ${order.replace('-', ' ')} script starts first`, async () => {
      const env = boot(order, live());
      await env.settled;
      expect(env.run(hours)).toBe(13); // Berlin: the config reached the MAIN-world script
    });
  }

  it('uses one fixed name only for the start-up handshake, and invents the rest per page load', async () => {
    const a = boot('bridge-first', live());
    const b = boot('main-first', live());
    await Promise.all([a.settled, b.settled]);
    for (const env of [a, b]) {
      const names = [...new Set(env.seen)];
      const fixed = names.filter((n) => !/^[0-9a-f]{16}a?$/.test(n));
      expect(fixed).toEqual(['__nl__']);
      expect(names.some((n) => /noleaker/i.test(n))).toBe(false);
      expect(names.filter((n) => /^[0-9a-f]{16}$/.test(n))).toHaveLength(1); // the config channel
      expect(names.filter((n) => /^[0-9a-f]{16}a$/.test(n))).toHaveLength(1); // its acknowledgement
    }
    const channel = (env: typeof a) => env.seen.find((n) => /^[0-9a-f]{16}$/.test(n));
    expect(channel(a)).not.toBe(channel(b));
  });

  it('stops answering the handshake once it is done (a late page script learns nothing)', async () => {
    const env = boot('bridge-first', live());
    await env.settled;
    const before = env.seen.length;
    env.target.dispatchEvent(
      new CustomEvent('__nl__', { detail: JSON.stringify({ k: 'bridge' }) }),
    );
    expect(env.seen.length).toBe(before); // nobody replies: the MAIN script no longer listens
  });
});

// --- every patched API against a pristine realm --------------------------------------------------
describe('patched APIs are indistinguishable from a pristine realm', () => {
  const def = `
    const def = (name, cls) => Object.defineProperty(globalThis, name,
      { value: cls, writable: true, configurable: true, enumerable: false });
    def('Navigator', class Navigator {
      get hardwareConcurrency() { return 4; } get deviceMemory() { return 2; }
      get language() { return 'fa-IR'; } get languages() { return ['fa-IR']; }
      get platform() { return 'MacIntel'; }
    });
    globalThis.navigator = new Navigator();
    def('Screen', class Screen {
      get width() { return 1000; } get height() { return 700; }
      get availWidth() { return 1000; } get availHeight() { return 680; }
    });
    globalThis.screen = new Screen();
    def('WebGLRenderingContext', class WebGLRenderingContext { getParameter(p) { return p; } });
    def('WebGL2RenderingContext', class WebGL2RenderingContext { getParameter(p) { return p; } });
    def('GPUAdapterInfo', class GPUAdapterInfo { get device() { return ''; } get description() { return ''; } });
    def('HTMLCanvasElement', class HTMLCanvasElement { toDataURL() { return ''; } toBlob(cb) {} });
    def('CanvasRenderingContext2D', class CanvasRenderingContext2D {
      getImageData() { return { data: new Uint8ClampedArray(4) }; }
      get font() { return ''; } set font(v) {}
    });
    def('OffscreenCanvas', class OffscreenCanvas {
      constructor(w, h) {} convertToBlob(o) { return Promise.resolve(); } getContext(t) {}
    });
    def('OffscreenCanvasRenderingContext2D', class OffscreenCanvasRenderingContext2D {
      getImageData() { return { data: new Uint8ClampedArray(4) }; }
      get font() { return ''; } set font(v) {}
    });
    def('AudioBuffer', class AudioBuffer { getChannelData(c) { return new Float32Array(1); } copyFromChannel(d, c, o) {} });
    def('AnalyserNode', class AnalyserNode {
      getFloatFrequencyData(a) {} getFloatTimeDomainData(a) {}
      getByteFrequencyData(a) {} getByteTimeDomainData(a) {}
    });
    def('Element', class Element {
      getBoundingClientRect() { return {}; } getClientRects() { return []; } setAttribute(n, v) {}
    });
    def('Range', class Range { getBoundingClientRect() { return {}; } getClientRects() { return []; } });
    def('SVGGraphicsElement', class SVGGraphicsElement { getBBox() { return {}; } });
    def('SVGTextContentElement', class SVGTextContentElement {
      getComputedTextLength() { return 1; } getSubStringLength(a, b) { return 1; }
    });
    def('TextMetrics', class TextMetrics {
      get width() { return 1; } get actualBoundingBoxLeft() { return 1; } get actualBoundingBoxRight() { return 1; }
      get actualBoundingBoxAscent() { return 1; } get actualBoundingBoxDescent() { return 1; }
      get fontBoundingBoxAscent() { return 1; } get fontBoundingBoxDescent() { return 1; }
      get emHeightAscent() { return 1; } get emHeightDescent() { return 1; }
      get hangingBaseline() { return 1; } get alphabeticBaseline() { return 1; } get ideographicBaseline() { return 1; }
    });
    def('CSSStyleDeclaration', class CSSStyleDeclaration {
      get fontFamily() { return ''; } set fontFamily(v) {}
      get font() { return ''; } set font(v) {}
      get cssText() { return ''; } set cssText(v) {}
      setProperty(n, v, p) {}
    });
    def('FontFaceSet', class FontFaceSet { forEach(cb) {} check(font, text) { return true; } });
    globalThis.document = { fonts: new FontFaceSet() };
    def('SpeechSynthesis', class SpeechSynthesis { getVoices() { return []; } });
    def('Keyboard', class Keyboard { getLayoutMap() { return Promise.resolve(new Map()); } });
    def('Geolocation', class Geolocation {
      getCurrentPosition(s, e, o) {} watchPosition(s, e, o) { return 1; } clearWatch(i) {}
    });
    def('Permissions', class Permissions { query(d) { return Promise.resolve({}); } });
    def('RTCPeerConnection', class RTCPeerConnection { constructor(c) {} setConfiguration(c) {} });
    def('Worker', class Worker { constructor(u, o) {} });
  `;

  const INTERFACES = [
    'Function',
    'Date',
    'Number',
    'String',
    'Intl.DateTimeFormat',
    'Intl.NumberFormat',
    'Intl.Collator',
    'Intl.PluralRules',
    'Intl.RelativeTimeFormat',
    'Intl.ListFormat',
    'Intl.Segmenter',
    'Navigator',
    'Screen',
    'WebGLRenderingContext',
    'WebGL2RenderingContext',
    'GPUAdapterInfo',
    'HTMLCanvasElement',
    'CanvasRenderingContext2D',
    'OffscreenCanvas',
    'OffscreenCanvasRenderingContext2D',
    'AudioBuffer',
    'AnalyserNode',
    'Element',
    'Range',
    'SVGGraphicsElement',
    'SVGTextContentElement',
    'TextMetrics',
    'CSSStyleDeclaration',
    'FontFaceSet',
    'SpeechSynthesis',
    'Keyboard',
    'Geolocation',
    'Permissions',
    'RTCPeerConnection',
    'Worker',
  ];

  /** Runs inside a realm, so it sees that realm's own Function.prototype.toString. */
  const snapshot = `(() => {
    const names = ${JSON.stringify(INTERFACES)};
    const toStr = (f) => Function.prototype.toString.call(f);
    const fnShape = (f) => ({
      name: f.name, length: f.length,
      keys: Reflect.ownKeys(f).map(String),
      ownPrototype: Object.prototype.hasOwnProperty.call(f, 'prototype'),
      str: toStr(f), native: /\\[native code\\]/.test(toStr(f)),
    });
    const desc = (d) => d && ({
      flags: ['writable', 'enumerable', 'configurable'].map((k) => (k in d ? d[k] : null)),
      value: typeof d.value === 'function' ? fnShape(d.value) : d.value === undefined ? null : typeof d.value,
      get: d.get ? fnShape(d.get) : null,
      set: d.set ? fnShape(d.set) : null,
    });
    const members = (o) => Object.fromEntries(Reflect.ownKeys(o).map((k) => [String(k), desc(Object.getOwnPropertyDescriptor(o, k))]));
    const out = {};
    for (const path of names) {
      const parts = path.split('.');
      const parent = parts.slice(0, -1).reduce((o, k) => o[k], globalThis);
      const key = parts[parts.length - 1];
      const C = parent[key];
      if (!C) continue;
      out[path] = {
        ownDescriptor: desc(Object.getOwnPropertyDescriptor(parent, key)),
        ctor: fnShape(C),
        statics: members(C),
        prototype: C.prototype ? members(C.prototype) : null,
        constructorIsItself: C.prototype ? C.prototype.constructor === C : null,
      };
    }
    return JSON.stringify(out);
  })()`;

  const sandbox = () => ({
    setTimeout,
    clearTimeout,
    URL: class extends URL {
      static createObjectURL() {
        return 'blob:x';
      }
      static revokeObjectURL() {}
    },
  });

  function realms(stealth: boolean) {
    const pristine = createContext(sandbox());
    runInContext(def, pristine);
    const patched = createContext(sandbox());
    runInContext(def, patched);

    const g = runInContext('globalThis', patched);
    const config: SpoofConfig = {
      ...buildSpoofConfig(live()),
      shields: {
        ...SHIELD_DEFAULTS,
        canvas: true,
        webgl: true,
        audio: true,
        clientRects: true,
        screen: true,
        hardwareConcurrency: true,
        deviceMemory: true,
      },
      fingerprint: {
        ...NO_FINGERPRINT,
        seed: 's',
        siteSeed: 's:x',
        canvasNoise: true,
        audioNoise: true,
        rectNoise: true,
        webglSpoof: true,
        screenSpoof: true,
        hardwareConcurrency: 8,
        deviceMemory: 8,
      },
      coordinates: { latitude: 1, longitude: 2 },
      stealth,
    };
    const spoof = installSpoof(g);
    const fingerprint = installFingerprint(g);
    const geolocation = installGeolocation(g);
    const fonts = installFonts(g);
    const voices = installVoices(g);
    const keyboard = installKeyboard(g);
    const webrtc = installWebRtc(g);
    const audio = installAudio(g);
    const rects = installRects(g);
    installWorkers(g, { config: () => config, prelude: () => '/*p*/', gpu: () => null });
    // The settings arrive after the patches exist; stealth switches on afterwards.
    spoof.setConfig(config);
    fingerprint.setConfig(config.fingerprint);
    audio.setConfig(config.fingerprint);
    rects.setConfig(config.fingerprint);
    for (const s of [geolocation, fonts, voices, keyboard, webrtc]) s.setConfig(config);
    createNative(g, { strict: stealth });
    return {
      pristine: JSON.parse(runInContext(snapshot, pristine) as string) as Record<string, any>,
      patched: JSON.parse(runInContext(snapshot, patched) as string) as Record<string, any>,
    };
  }

  function expectSameFunction(a: any, b: any, where: string) {
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      expect(a, where).toEqual(b);
      return;
    }
    expect(a.name, `${where} name`).toBe(b.name);
    expect(a.length, `${where} length`).toBe(b.length);
    expect(a.keys, `${where} own keys`).toEqual(b.keys);
    expect(a.ownPrototype, `${where} own prototype`).toBe(b.ownPrototype);
    // Untouched or truly native functions must print exactly as before. A stand-in class in this
    // test realm has source text, so when the patched one differs it must print the native form.
    if (a.str !== b.str)
      expect(a.str, `${where} toString`).toBe(`function ${a.name}() { [native code] }`);
    if (b.native) expect(a.str, `${where} toString`).toBe(b.str);
  }

  function expectSameDescriptor(a: any, b: any, where: string) {
    expect(a?.flags, `${where} flags`).toEqual(b?.flags);
    expectSameFunction(a?.value, b?.value, `${where} value`);
    expectSameFunction(a?.get, b?.get, `${where} getter`);
    expectSameFunction(a?.set, b?.set, `${where} setter`);
  }

  for (const stealth of [false, true]) {
    it(`finds no difference in toString, own property names, prototype or descriptors (stealth ${stealth ? 'on' : 'off'})`, () => {
      const { pristine, patched } = realms(stealth);
      expect(Object.keys(patched)).toEqual(Object.keys(pristine));
      let compared = 0;
      for (const path of Object.keys(pristine)) {
        const p = pristine[path];
        const q = patched[path];
        expectSameDescriptor(q.ownDescriptor, p.ownDescriptor, `${path} (property of its owner)`);
        expectSameFunction(q.ctor, p.ctor, `${path} constructor`);
        expect(q.constructorIsItself, `${path}.prototype.constructor`).toBe(p.constructorIsItself);
        for (const group of ['statics', 'prototype'] as const) {
          if (p[group] === null) {
            expect(q[group]).toBeNull();
            continue;
          }
          expect(Object.keys(q[group]), `${path}.${group} members`).toEqual(Object.keys(p[group]));
          for (const key of Object.keys(p[group])) {
            expectSameDescriptor(q[group][key], p[group][key], `${path}.${group}.${key}`);
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(150); // the comparison really covered the patched surface
    });
  }
});

// --- strict mode and stack scrubbing --------------------------------------------------------------
describe('stealth: strict shapes and clean stacks', () => {
  const frame = '    at inner (chrome-extension://abcdefghijklmnop/content/main.js:10:5)';
  const page = '    at page (https://site.test/app.js:2:2)';

  it('scrubStack drops extension frames and nothing else', () => {
    const e = new Error('boom');
    e.stack = ['Error: boom', frame, page, frame].join('\n');
    scrubStack(e);
    expect(e.stack).toBe(['Error: boom', page].join('\n'));
    expect(() => scrubStack(undefined)).not.toThrow();
    expect(() => scrubStack(Object.freeze(new Error('x')))).not.toThrow();
  });

  const throwing = () => {
    const ctx = createContext({});
    const g = runInContext('globalThis', ctx);
    const native = createNative(g);
    const fn = native.method('probe', 0, () => {
      const e = new Error('boom');
      e.stack = ['Error: boom', frame, page].join('\n');
      throw e;
    });
    return { native, fn };
  };
  const stackOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as Error).stack;
    }
    return undefined;
  };

  it('an error that passes through a patch keeps its frames until stealth is on', () => {
    const { native, fn } = throwing();
    expect(stackOf(fn)).toContain('chrome-extension://');
    native.setStrict(true);
    expect(stackOf(fn)).toBe(['Error: boom', page].join('\n'));
    native.setStrict(false);
    expect(stackOf(fn)).toContain('chrome-extension://'); // it follows the switch both ways
  });
  it('errors still propagate unchanged in type and message', () => {
    const { native, fn } = throwing();
    native.setStrict(true);
    expect(() => fn()).toThrow('boom');
  });
  it('turning strict on re-shapes functions that were patched earlier', () => {
    const ctx = createContext({});
    runInContext(
      `globalThis.orig = Object.defineProperty({ orig() {} }.orig, 'name', { value: 'orig', writable: true, configurable: true });`,
      ctx,
    );
    const g = runInContext('globalThis', ctx);
    const native = createNative(g);
    const fn = native.method('orig', 0, () => 1, g.orig);
    const writable = () => Object.getOwnPropertyDescriptor(fn, 'name')!.writable;
    expect(writable()).toBe(false);
    native.setStrict(true);
    expect(writable()).toBe(true); // copied from the function it replaced
    expect(Reflect.ownKeys(fn)).toEqual(Reflect.ownKeys(g.orig));
  });
  it('records every patched member', () => {
    const { native } = throwing();
    const ctx = createContext({});
    runInContext('globalThis.T = class T { m() {} get x() { return 1; } set x(v) {} }', ctx);
    const g = runInContext('globalThis', ctx);
    const n = createNative(g);
    n.patch(g.T.prototype, 'm', (o: any) => o);
    n.patchGetter(g.T.prototype, 'x', (o: any) => o());
    n.patchSetter(g.T.prototype, 'x', (o: any) => o);
    n.patchCtor(g, 'T', g.T, (a: any) => a);
    expect(n.patched.map((p) => `${p.kind}:${p.key}`)).toEqual([
      'method:m',
      'getter:x',
      'setter:x',
      'constructor:T',
    ]);
    expect(native.patched).toEqual([]);
  });
});
