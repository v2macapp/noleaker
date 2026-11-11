/* eslint-disable @typescript-eslint/no-explicit-any */
import type { GpuModel } from '../shared/gpus';
import type { SpoofConfig } from '../shared/spoof-config';
import { createNative } from './native';

export interface WorkerDeps {
  /** The live config, or null when spoofing is paused. */
  config(): SpoofConfig | null;
  /** The worker prelude script, or null until the bridge has delivered it. */
  prelude(): string | null;
  gpu(): GpuModel | null;
  pending?(): boolean;
}

const REVOKE_AFTER_MS = 60_000;

/**
 * Starts the page's classic workers through a small blob script: the prelude first, then the
 * original blob contents or script via importScripts. Anything unusual is left alone and the
 * native Worker runs: module workers, cross-origin or data: scripts, no prelude yet, a CSP that
 * blocks blob workers.
 * Strict mode blocks these fallbacks, SharedWorkers and new Service Worker registrations.
 *
 * SharedWorker is not wrapped: a blob URL differs per tab, so tabs would stop sharing a worker.
 */
export function installWorkers(g: any, deps: WorkerDeps): { refresh(): void } | undefined {
  const { patchCtor, patch } = createNative(g);
  const refuse = (): never => {
    throw new g.DOMException(
      'Worker is blocked because its realm cannot be protected.',
      'SecurityError',
    );
  };
  const restricted = () => deps.pending?.() || deps.config()?.strict;
  if (typeof g.SharedWorker === 'function')
    patchCtor(g, 'SharedWorker', g.SharedWorker, (args) => (restricted() ? refuse() : args));
  const sw = g.ServiceWorkerContainer?.prototype;
  if (sw?.register)
    patch(
      sw,
      'register',
      (orig) =>
        function (this: any, ...args: any[]) {
          if (restricted())
            return Promise.reject(
              new g.DOMException(
                'Service Worker registration is blocked in strict mode.',
                'SecurityError',
              ),
            );
          return orig.apply(this, args);
        },
    );
  const NativeWorker = g.Worker;
  if (typeof NativeWorker !== 'function') return;

  const setTimer = g.setTimeout.bind(g);
  const createObjectURL = g.URL.createObjectURL.bind(g.URL);
  const revokeObjectURL = g.URL.revokeObjectURL.bind(g.URL);
  const blobs = new Map<string, Blob>();
  patch(
    g.URL,
    'createObjectURL',
    (orig) =>
      function (this: any, object: any) {
        const url = orig.call(this, object);
        if (object instanceof g.Blob) blobs.set(url, object);
        return url;
      },
  );
  patch(
    g.URL,
    'revokeObjectURL',
    (orig) =>
      function (this: any, url: string) {
        const result = orig.call(this, url);
        blobs.delete(String(url));
        return result;
      },
  );
  let blobBlocked = false;

  // A CSP without blob: in worker-src would break our wrapper; stop injecting once seen.
  g.addEventListener?.('securitypolicyviolation', (e: any) => {
    if (
      /^(worker|child|script)-src/.test(e.violatedDirective) &&
      String(e.blockedURI).startsWith('blob')
    ) {
      blobBlocked = true;
    }
  });

  function wrap(args: any[]): any[] {
    if (deps.pending?.()) return refuse();
    const config = deps.config();
    const fallback = () => (config?.strict ? refuse() : args);
    const prelude = deps.prelude();
    if (!config?.active || !config?.shields.workers || !prelude || blobBlocked) return fallback();

    const [scriptURL, options] = args;
    if (options && typeof options === 'object' && options.type === 'module') return fallback();

    let url: URL;
    try {
      url = new g.URL(String(scriptURL), g.document?.baseURI ?? g.location.href);
    } catch {
      return fallback();
    }
    const sameOrigin = g.location.origin !== 'null' && url.origin === g.location.origin;
    if (!sameOrigin || !/^(https?|blob):$/.test(url.protocol)) return fallback();

    const blob = blobs.get(url.href.replace(/#.*$/, ''));
    if (url.protocol === 'blob:' && !blob) return fallback();
    const init = JSON.stringify({ config, base: url.href, gpu: deps.gpu() });
    const source = `self.__noleaker__=${init};\n${prelude}\n;`;
    // Blob imports can violate script-src even when worker-src allows blob workers.
    // shortcut: prepending changes a blob's directive prologue; preserve it if a worker relies on it.
    const blobUrl = createObjectURL(
      new g.Blob([source, blob ?? `importScripts(${JSON.stringify(url.href)});`], {
        type: blob ? blob.type : 'text/javascript',
      }),
    );
    setTimer(() => revokeObjectURL(blobUrl), REVOKE_AFTER_MS);
    return [blobUrl, ...args.slice(1)];
  }

  const running = new Set<WeakRef<any>>();
  let signature = JSON.stringify(deps.config());
  let wasStrict = !!deps.config()?.strict;
  const { patchProxy } = createNative(g);
  patchProxy(g, 'Worker', NativeWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, wrap(args), newTarget);
      running.add(new WeakRef(worker));
      return worker;
    },
  });
  return {
    refresh() {
      const next = JSON.stringify(deps.config());
      if (next !== signature && (wasStrict || deps.config()?.strict)) {
        for (const reference of running) reference.deref()?.terminate();
        running.clear();
      }
      signature = next;
      wasStrict = !!deps.config()?.strict;
    },
  };
}
