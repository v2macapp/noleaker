import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { installFingerprint } from '../src/content/fingerprint';
import { installWebRtc } from '../src/content/webrtc';
import { installWorkerBase } from '../src/content/worker-base';
import { initWorker } from '../src/content/worker-main';
import { installWorkers } from '../src/content/workers';
import { NO_FINGERPRINT, type FingerprintConfig } from '../src/shared/fingerprint';
import { chooseGpu, GPU_MODELS } from '../src/shared/gpus';
import { SHIELD_DEFAULTS } from '../src/shared/shields';
import type { SpoofConfig } from '../src/shared/spoof-config';

const config = (
  over: Partial<SpoofConfig['shields']> = {},
  fingerprint: Partial<FingerprintConfig> = {},
): SpoofConfig => ({
  active: true,
  timezone: 'America/New_York',
  locale: 'en-US',
  acceptLanguage: 'en-US,en;q=0.9',
  languages: ['en-US', 'en'],
  whitelist: [],
  fingerprint: { ...NO_FINGERPRINT, seed: 'p1', siteSeed: 'p1:site', ...fingerprint },
  shields: { ...SHIELD_DEFAULTS, ...over },
  coordinates: null,
  stealth: false,
});

const fpConfig = (over: Partial<FingerprintConfig> = {}): FingerprintConfig => ({
  ...NO_FINGERPRINT,
  seed: 'p1',
  siteSeed: 'p1:site',
  ...over,
});

const newContext = (setup: string, globals: object = {}) => {
  const ctx = createContext({ ...globals });
  runInContext(setup, ctx);
  return {
    g: runInContext('globalThis', ctx),
    run: <T = unknown>(c: string) => runInContext(c, ctx) as T,
  };
};

describe('chooseGpu (model table)', () => {
  it('only offers GPUs that fit the core count', () => {
    for (const cores of [4, 8, 10, 12, 16]) {
      for (const os of ['mac', 'win', 'linux'] as const) {
        const gpu = chooseGpu(os, 'seed', cores, { width: 1920, height: 1080 });
        if (gpu) {
          expect(gpu.os).toBe(os);
          expect(gpu.cores).toContain(cores);
        }
      }
    }
  });
  it('returns null when nothing fits, so the real GPU is kept', () => {
    expect(chooseGpu('mac', 's', 4, { width: 1920, height: 1080 })).toBeNull(); // no 4-core Apple chip
    expect(chooseGpu('mac', 's', 8, { width: 1366, height: 768 })).toBeNull(); // too small for a Mac
    expect(chooseGpu('win', 's', 8, { width: 1366, height: 768 })?.minWidth).toBeLessThanOrEqual(
      1366,
    );
    expect(chooseGpu('win', 's', 0, null)).toBeNull();
  });
  it('respects screen minimums', () => {
    // 10-core Pro/Max machines have at least a 1512-wide screen
    expect(chooseGpu('mac', 'x', 10, { width: 1440, height: 900 })).toBeNull();
    expect(['Apple M1 Pro', 'Apple M2 Pro']).toContain(
      chooseGpu('mac', 'x', 10, { width: 1512, height: 982 })?.description,
    );
  });
  it('is stable per seed and varies across seeds', () => {
    const screen = { width: 1920, height: 1080 };
    expect(chooseGpu('win', 'a', 8, screen)).toBe(chooseGpu('win', 'a', 8, screen));
    const seen = new Set(
      Array.from({ length: 40 }, (_, i) => chooseGpu('win', `seed-${i}`, 8, screen)?.description),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
  it('keeps the table consistent', () => {
    for (const m of GPU_MODELS) {
      expect(m.renderer, m.description).toContain(
        m.description.split(' ').slice(0, 2).join(' ').slice(0, 4),
      );
      expect(m.cores.length).toBeGreaterThan(0);
    }
  });
});

describe('WebGPU and OffscreenCanvas', () => {
  const setup = `
    class GPUAdapterInfo {
      get device() { return 'real-device'; }
      get description() { return 'real-description'; }
    }
    class OffscreenCanvasRenderingContext2D {
      getImageData() { return { data: new Uint8ClampedArray(4 * 1000).fill(120) }; }
    }
    class OffscreenCanvas {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { drawImage() {}, putImageData: (img) => (globalThis.putCalls = (globalThis.putCalls || 0) + 1), __proto__: OffscreenCanvasRenderingContext2D.prototype }; }
      convertToBlob() { return Promise.resolve(this.tag || 'original'); }
    }
    Object.assign(globalThis, { GPUAdapterInfo, OffscreenCanvasRenderingContext2D, OffscreenCanvas });
  `;
  const model = GPU_MODELS.find((m) => m.description === 'Apple M2')!;

  it('WebGPU adapter info follows the chosen GPU, only when the WebGL/GPU switch is on', () => {
    const env = newContext(setup);
    const fp = installFingerprint(env.g, { gpu: model });
    const read = () =>
      env.run<string[]>('[new GPUAdapterInfo().device, new GPUAdapterInfo().description]');
    expect(read()).toEqual(['real-device', 'real-description']);
    fp.setConfig(fpConfig({ webglSpoof: true }));
    expect(read()).toEqual([model.device, model.description]);
    fp.setConfig(fpConfig({ webglSpoof: false }));
    expect(read()).toEqual(['real-device', 'real-description']);
  });
  it('keeps real WebGPU values when no GPU fits', () => {
    const env = newContext(setup);
    installFingerprint(env.g, { gpu: null }).setConfig(fpConfig({ webglSpoof: true }));
    expect(env.run('new GPUAdapterInfo().description')).toBe('real-description');
  });
  it('adds the same noise to OffscreenCanvas getImageData as to a normal canvas', () => {
    const env = newContext(setup);
    const fp = installFingerprint(env.g);
    const noisy = () =>
      env.run<number>(
        'new OffscreenCanvasRenderingContext2D().getImageData().data.filter((v) => v !== 120).length',
      );
    expect(noisy()).toBe(0);
    fp.setConfig(fpConfig({ canvasNoise: true }));
    const first = noisy();
    expect(first).toBeGreaterThan(0);
    expect(noisy()).toBe(first); // deterministic
    fp.setConfig(fpConfig({ canvasNoise: true, siteSeed: 'p1:other-site' }));
    const other = env.run<number[]>(
      'Array.from(new OffscreenCanvasRenderingContext2D().getImageData().data)',
    );
    fp.setConfig(fpConfig({ canvasNoise: true }));
    const same = env.run<number[]>(
      'Array.from(new OffscreenCanvasRenderingContext2D().getImageData().data)',
    );
    expect(other).not.toEqual(same); // differs per site
    expect(
      env.run('Function.prototype.toString.call(OffscreenCanvas.prototype.convertToBlob)'),
    ).toBe('function convertToBlob() { [native code] }');
  });
});

describe('WebRTC at API level', () => {
  const setup = `
    globalThis.RTCPeerConnection = class RTCPeerConnection {
      constructor(configuration) { this.configuration = configuration; }
      setConfiguration(configuration) { this.configuration = configuration; }
    };
  `;
  it('forces iceTransportPolicy relay, keeping the page’s other settings', () => {
    const env = newContext(setup);
    const rtc = installWebRtc(env.g);
    const policy = (code: string) => env.run<string | undefined>(code);
    expect(
      policy(
        'new RTCPeerConnection({ iceTransportPolicy: "all" }).configuration.iceTransportPolicy',
      ),
    ).toBe('all');
    rtc.setConfig(config());
    expect(
      policy(
        'new RTCPeerConnection({ iceTransportPolicy: "all" }).configuration.iceTransportPolicy',
      ),
    ).toBe('relay');
    expect(policy('new RTCPeerConnection().configuration.iceTransportPolicy')).toBe('relay');
    expect(
      env.run<string>(
        'new RTCPeerConnection({ iceServers: [{ urls: "turn:x" }] }).configuration.iceServers[0].urls',
      ),
    ).toBe('turn:x');
  });
  it('also guards setConfiguration', () => {
    const env = newContext(setup);
    installWebRtc(env.g).setConfig(config());
    expect(
      env.run<string>(
        '(() => { const c = new RTCPeerConnection(); c.setConfiguration({ iceTransportPolicy: "all" }); return c.configuration.iceTransportPolicy; })()',
      ),
    ).toBe('relay');
  });
  it('is native when the WebRTC shield is off or paused, and keeps instanceof', () => {
    const env = newContext(setup);
    const rtc = installWebRtc(env.g);
    rtc.setConfig(config({ webrtc: false }));
    expect(
      env.run(
        'new RTCPeerConnection({ iceTransportPolicy: "all" }).configuration.iceTransportPolicy',
      ),
    ).toBe('all');
    rtc.setConfig(config());
    expect(env.run('new RTCPeerConnection() instanceof RTCPeerConnection')).toBe(true);
    expect(env.run('RTCPeerConnection.prototype.constructor === RTCPeerConnection')).toBe(true);
    rtc.setConfig(null);
    expect(env.run('new RTCPeerConnection().configuration')).toBeUndefined();
  });
});

describe('Worker wrapper (page side)', () => {
  const setup = `
    globalThis.Worker = class Worker { constructor(url, options) { this.url = url; this.options = options; } };
    globalThis.Blob = class Blob { constructor(parts, options) { this.parts = parts; this.options = options; this.type = options?.type ?? ''; } };
    globalThis.created = [];
    URL.createObjectURL = (blob) => { created.push(blob); return 'blob:https://site.test/' + created.length; };
    URL.revokeObjectURL = () => {};
    globalThis.location = { origin: 'https://site.test', href: 'https://site.test/app/' };
    globalThis.document = { baseURI: 'https://site.test/app/' };
    globalThis.addEventListener = (type, fn) => { (globalThis.listeners ||= {})[type] = fn; };
  `;
  const make = (live: SpoofConfig | null = config(), prelude: string | null = '/*PRELUDE*/') => {
    // A subclass, so the mocked statics never touch Node's real URL.
    const env = newContext(setup, { URL: class extends URL {}, setTimeout: () => 0 });
    installWorkers(env.g, { config: () => live, prelude: () => prelude, gpu: () => null });
    return env;
  };
  const started = (env: ReturnType<typeof newContext>, code: string) =>
    env.run<{ url: string; options: unknown }>(code);

  it('starts a same-origin classic worker through a prelude blob', () => {
    const env = make();
    const w = started(env, 'new Worker("w.js", { name: "n" })');
    expect(w.url).toMatch(/^blob:/);
    expect(w.options).toEqual({ name: 'n' });
    const source = env.run<string>('created[0].parts.join("")');
    expect(source).toContain('self.__noleaker__=');
    expect(source.indexOf('/*PRELUDE*/')).toBeGreaterThan(source.indexOf('__noleaker__'));
    expect(source).toContain('importScripts("https://site.test/app/w.js");');
    expect(source.trimEnd().endsWith('importScripts("https://site.test/app/w.js");')).toBe(true);
    const init = JSON.parse(/__noleaker__=(\{.*\});/.exec(source)![1]!);
    expect(init.base).toBe('https://site.test/app/w.js');
    expect(init.config.timezone).toBe('America/New_York');
  });
  it('leaves module, cross-origin, data: and unknown schemes alone', () => {
    const env = make();
    expect(started(env, 'new Worker("w.js", { type: "module" })').url).toBe('w.js');
    expect(started(env, 'new Worker("https://other.test/w.js")').url).toBe(
      'https://other.test/w.js',
    );
    expect(started(env, 'new Worker("data:text/javascript,1")').url).toBe('data:text/javascript,1');
    expect(env.run('created.length')).toBe(0);
  });
  it('includes a blob worker source directly, even after its original URL is revoked', () => {
    const env = make({ ...config(), strict: true });
    env.run(`
      const original = new Blob(['postMessage("ready");'], { type: 'text/javascript' });
      const url = URL.createObjectURL(original);
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
    `);
    expect(env.run('created[1].parts[0]')).not.toContain('importScripts(');
    expect(env.run('created[1].parts[1] === original')).toBe(true);
    expect(env.run('created[1].type')).toBe('text/javascript');
    expect(env.run('worker.url !== url')).toBe(true);
  });
  it('preserves a blob MIME type so the browser still rejects non-script sources', () => {
    const env = make();
    env.run(`new Worker(URL.createObjectURL(new Blob(['<html></html>'], { type: 'text/html' })))`);
    expect(env.run('created[1].type')).toBe('text/html');
  });
  it('does not wrap unknown or revoked blob URLs and blocks them in Strict', () => {
    const env = make();
    env.run(`
      const url = URL.createObjectURL(new Blob(['postMessage("ready");']));
      URL.revokeObjectURL(new URL(url));
    `);
    expect(started(env, 'new Worker(url)').url).toBe(env.run('url'));
    expect(started(env, 'new Worker("blob:https://site.test/unknown")').url).toBe(
      'blob:https://site.test/unknown',
    );
    const strict = make({ ...config(), strict: true });
    strict.g.DOMException = DOMException;
    expect(() => started(strict, 'new Worker("blob:https://site.test/unknown")')).toThrow(
      'cannot be protected',
    );
  });
  it('is native without a prelude, when paused, or with the workers shield off', () => {
    expect(started(make(config(), null), 'new Worker("w.js")').url).toBe('w.js');
    expect(started(make(null), 'new Worker("w.js")').url).toBe('w.js');
    expect(started(make(config({ workers: false })), 'new Worker("w.js")').url).toBe('w.js');
  });
  it('stops injecting after a CSP violation on blob workers', () => {
    const env = make();
    env.run(
      'listeners.securitypolicyviolation({ violatedDirective: "worker-src", blockedURI: "blob" })',
    );
    expect(started(env, 'new Worker("w.js")').url).toBe('w.js');
  });
  it('keeps Worker native-looking', () => {
    const env = make();
    expect(env.run('new Worker("w.js") instanceof Worker')).toBe(true);
    expect(env.run('Function.prototype.toString.call(Worker)')).toBe(
      'function Worker() { [native code] }',
    );
  });
});

describe('worker prelude (worker side)', () => {
  const setup = `
    class WorkerLocation {}
    class WorkerGlobalScope {
      get location() { return 'real-blob-location'; }
      importScripts(...urls) { (globalThis.imported ||= []).push(...urls); }
      fetch(input) { (globalThis.fetched ||= []).push(String(input)); return Promise.resolve(); }
    }
    class WorkerNavigator {
      get hardwareConcurrency() { return 2; }
      get platform() { return 'MacIntel'; }
      get language() { return 'fa-IR'; }
      get languages() { return ['fa-IR']; }
    }
    class WebGLRenderingContext { getParameter(p) { return 'real-' + p; } }
    class XMLHttpRequest { open(m, u) { (globalThis.opened ||= []).push(u); } }
    Object.setPrototypeOf(globalThis, WorkerGlobalScope.prototype);
    Object.assign(globalThis, { WorkerLocation, WorkerGlobalScope, WorkerNavigator, WebGLRenderingContext, XMLHttpRequest });
    globalThis.navigator = new WorkerNavigator();
  `;
  const BASE = 'https://site.test/app/worker.js';
  const model = GPU_MODELS.find((m) => m.description === 'Apple M1')!;
  const boot = (cfg: SpoofConfig = config({}, { webglSpoof: true, hardwareConcurrency: 8 })) => {
    const env = newContext(setup, { URL });
    initWorker(env.g, { config: cfg, base: BASE, gpu: model });
    return env;
  };

  it('applies timezone, locale, hardware and the page GPU inside the worker', () => {
    const env = boot();
    expect(env.run('new Date(Date.UTC(2020, 0, 15, 12)).getHours()')).toBe(7);
    expect(env.run('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe('America/New_York');
    expect(env.run('navigator.language')).toBe('en-US');
    expect(env.run('navigator.languages.join()')).toBe('en-US,en');
    expect(env.run('navigator.hardwareConcurrency')).toBe(8);
    expect(env.run('new WebGLRenderingContext().getParameter(0x9246)')).toBe(model.renderer);
    expect(env.run('Function.prototype.toString.call(Date.prototype.getHours)')).toBe(
      'function getHours() { [native code] }',
    );
  });
  it('makes location, importScripts, fetch and XHR resolve against the original script URL', () => {
    const env = boot();
    expect(env.run('location.href')).toBe(BASE);
    expect(env.run('location.pathname')).toBe('/app/worker.js');
    expect(env.run('String(location)')).toBe(BASE);
    env.run('importScripts("lib/a.js", "https://cdn.test/b.js")');
    expect(env.run('imported')).toEqual([
      'https://site.test/app/lib/a.js',
      'https://cdn.test/b.js',
    ]);
    env.run('fetch("data.json")');
    expect(env.run('fetched')).toEqual(['https://site.test/app/data.json']);
    env.run('new XMLHttpRequest().open("GET", "/root.json")');
    expect(env.run('opened')).toEqual(['https://site.test/root.json']);
  });
  it('leaves other realms alone when installWorkerBase is not called (sanity)', () => {
    const env = newContext(setup, { URL });
    installWorkerBase(env.g, BASE);
    expect(env.run('location.href')).toBe(BASE);
  });
});
