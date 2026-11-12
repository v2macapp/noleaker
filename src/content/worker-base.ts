/* eslint-disable @typescript-eslint/no-explicit-any */
import { createNative } from './native';

/** The object that owns `key` somewhere on the prototype chain of `obj`. */
function ownerOf(obj: any, key: string): any {
  let o = obj;
  while (o && !Object.prototype.hasOwnProperty.call(o, key)) o = Object.getPrototypeOf(o);
  return o ?? null;
}

/**
 * A worker we start from a blob URL would see that blob URL as its location, and relative URLs
 * would resolve against it. This makes `self.location`, `importScripts`, `fetch`, XHR and nested
 * workers behave as if the worker had been started from `base` (the original script URL).
 */
export function installWorkerBase(g: any, base: string): void {
  const { patch, patchGetter, patchCtor, method, define } = createNative(g);

  const resolve = (input: unknown): unknown => {
    if (typeof input !== 'string' && !(g.URL && input instanceof g.URL)) return input;
    try {
      return new g.URL(String(input), base).href;
    } catch {
      return input;
    }
  };

  // self.location
  const scope: any = g.WorkerGlobalScope?.prototype;
  if (scope) {
    const url = new g.URL(base);
    const fake = Object.create(g.WorkerLocation?.prototype ?? Object.prototype);
    for (const key of [
      'href',
      'origin',
      'protocol',
      'host',
      'hostname',
      'port',
      'pathname',
      'search',
      'hash',
    ]) {
      Object.defineProperty(fake, key, {
        get: method(`get ${key}`, 0, () => url[key as keyof URL]),
        enumerable: true,
        configurable: true,
      });
    }
    define(
      fake,
      'toString',
      method('toString', 0, () => url.href),
    );
    patchGetter(scope, 'location', () => fake);
  }

  const rewriteFirst = (key: string, owner: any) => {
    if (owner) {
      patch(
        owner,
        key,
        (orig) =>
          function (this: any, first: unknown, ...rest: unknown[]) {
            return orig.call(this, resolve(first), ...rest);
          },
      );
    }
  };
  rewriteFirst('fetch', ownerOf(g, 'fetch'));

  const importOwner = ownerOf(g, 'importScripts');
  if (importOwner) {
    patch(
      importOwner,
      'importScripts',
      (orig) =>
        function (this: any, ...urls: unknown[]) {
          return orig.apply(this, urls.map(resolve));
        },
    );
  }

  const xhr: any = g.XMLHttpRequest?.prototype;
  if (xhr?.open) {
    patch(
      xhr,
      'open',
      (orig) =>
        function (this: any, method: unknown, url: unknown, ...rest: unknown[]) {
          return orig.call(this, method, resolve(url), ...rest);
        },
    );
  }

  // shortcut: dynamic import('./x.js') cannot be patched and resolves against the blob URL; a
  // worker that needs it must be started natively (shields.workers off for the site).
  for (const name of ['Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'Request']) {
    if (typeof g[name] === 'function') {
      patchCtor(g, name, g[name], (args) => [resolve(args[0]), ...args.slice(1)]);
    }
  }
}
