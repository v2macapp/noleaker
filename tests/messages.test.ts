import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fromExtensionPage, listen, type Handlers } from '../src/shared/messages';

type Listener = (m: unknown, s: unknown, send: (r: unknown) => void) => boolean | undefined;
let installed: Listener;

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: (fn: Listener) => (installed = fn) } },
  });
});

const ask = (message: unknown) =>
  new Promise<unknown>((resolve) => {
    expect(installed(message, {}, resolve)).toBe(true); // keeps the channel open
  });

describe('listen', () => {
  it('answers with the handler result, sync or async', async () => {
    listen({
      ping: () => 'pong',
      getState: async () => ({ ok: true }) as never,
    } as unknown as Handlers);
    expect(await ask({ type: 'ping' })).toBe('pong');
    expect(await ask({ type: 'getState' })).toEqual({ ok: true });
  });
  it('still answers when a handler throws or rejects, so the sender never gets undefined', async () => {
    listen({
      ping: () => {
        throw new Error('boom');
      },
      updateIranList: () => Promise.reject(new Error('later')),
    } as unknown as Handlers);
    expect(await ask({ type: 'ping' })).toEqual({ ok: false, error: 'boom' });
    expect(await ask({ type: 'updateIranList' })).toEqual({ ok: false, error: 'later' });
  });
  it('ignores messages it has no handler for', () => {
    listen({ ping: () => 'pong' } as unknown as Handlers);
    expect(installed({ type: 'nope' }, {}, () => undefined)).toBe(false);
    expect(installed({ type: 'constructor' }, {}, () => undefined)).toBe(false);
    expect(installed({ type: '__proto__' }, {}, () => undefined)).toBe(false);
  });
});

describe('fromExtensionPage', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'x', getURL: (p: string) => `chrome-extension://x/${p}` },
    });
  });
  const page = 'options/index.html';
  it('accepts the page with a sidebar fragment or query', () => {
    for (const url of ['', '#tools', '?a=1#proxies'])
      expect(fromExtensionPage({ id: 'x', url: `chrome-extension://x/${page}${url}` }, page)).toBe(
        true,
      );
  });
  it('rejects other pages, other extensions and missing URLs', () => {
    expect(fromExtensionPage({ id: 'x', url: 'chrome-extension://x/popup/index.html' }, page)).toBe(
      false,
    );
    expect(fromExtensionPage({ id: 'y', url: `chrome-extension://x/${page}` }, page)).toBe(false);
    expect(fromExtensionPage({ id: 'x', url: `chrome-extension://y/${page}` }, page)).toBe(false);
    expect(fromExtensionPage({ id: 'x' }, page)).toBe(false);
  });
});
