import { PROBE_HOSTS } from '../../shared/lookup';
import { NO_DIRECT, route, type DirectLookup } from '../../shared/route';
import type { ProxyProfile } from '../../shared/types';

// Firefox routing: one proxy.onRequest listener answers every request from the in-memory routing
// table below. Nothing here may throw into Firefox: an exception or rejected promise makes Firefox
// ignore the listener and connect directly, so every failure path answers with the dead end.

/** Minimal shape of Firefox's proxy.onRequest API (not in @types/chrome). */
export interface ProxyInfo {
  type: 'socks' | 'direct';
  host?: string;
  port?: number;
  proxyDNS?: boolean;
  username?: string;
  password?: string;
  failoverTimeout?: number;
}

export interface RequestDetails {
  url: string;
  originUrl?: string;
  documentUrl?: string;
  incognito?: boolean;
}

interface FirefoxProxyApi {
  onRequest: {
    addListener(
      fn: (d: RequestDetails) => Answer | Promise<Answer>,
      filter: { urls: string[] },
    ): void;
    hasListener(fn: unknown): boolean;
  };
  onError: { addListener(fn: (error: Error) => void): void };
}

/** What the listener gives Firefox. A trailing null ends the failover chain (see `final`). */
export type Answer = ProxyInfo | [ProxyInfo, null] | undefined;

export const firefoxProxy = (): FirefoxProxyApi =>
  (chrome as unknown as { proxy: FirefoxProxyApi }).proxy;

/**
 * Connections are refused, never sent direct: a SOCKS proxy on a closed local port, with remote
 * DNS so not even the name is resolved locally.
 */
export const DEAD_END: ProxyInfo = { type: 'socks', host: '127.0.0.1', port: 1, proxyDNS: true };
const DIRECT: ProxyInfo = { type: 'direct' };

export interface Routing {
  /** Proxy off: leave the request to Firefox's own proxy settings. */
  enabled: boolean;
  profile: ProxyProfile | null;
  blocking: boolean;
  strict: boolean;
  direct: DirectLookup;
  /** Transition guard: everything is refused except the extension's own probe requests. */
  guarded: boolean;
}

const OFF: Routing = {
  enabled: false,
  profile: null,
  blocking: false,
  strict: true,
  direct: NO_DIRECT,
  guarded: false,
};

let routing: Routing = OFF;
let proxyInfo: ProxyInfo = DEAD_END;
let ready: Promise<void> | null = null;
let markReady: () => void = () => undefined;

/** How long a request waits for the first routing table before it is refused. */
export const READY_TIMEOUT_MS = 10_000;

/** Requests that arrive before the first routing table wait for it (startup, event-page wake). */
function waitForRouting(): Promise<void> {
  ready ??= new Promise((resolve) => (markReady = resolve));
  return ready;
}

const timeout = () =>
  new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), READY_TIMEOUT_MS));

let haveRouting = false;

export function setRouting(next: Partial<Routing>): void {
  routing = { ...routing, ...next };
  const p = routing.profile;
  proxyInfo = p
    ? {
        type: 'socks',
        host: p.host,
        port: p.port,
        proxyDNS: true,
        ...(p.username ? { username: p.username, password: p.password ?? '' } : {}),
        failoverTimeout: 5,
      }
    : DEAD_END;
  haveRouting = true;
  markReady();
}

/** Transition guard only. Does not count as a routing table: waiting requests keep waiting. */
export function setGuarded(guarded: boolean): void {
  routing = { ...routing, guarded };
}

export function currentRouting(): Routing {
  return routing;
}

const extensionBase = (): string => chrome.runtime.getURL('');

/** The extension's own background lookups (exit detection), not a page. */
function fromExtension(d: RequestDetails): boolean {
  const base = extensionBase();
  return !!d.originUrl?.startsWith(base) && (!d.documentUrl || d.documentUrl.startsWith(base));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** The routing decision for one request, from the current table. Pure apart from reading it. */
export function decide(d: RequestDetails): ProxyInfo | undefined {
  if (!routing.enabled) return routing.guarded ? DEAD_END : undefined;
  const host = hostOf(d.url);
  if (host === null) return DEAD_END;
  const probe = PROBE_HOSTS.includes(host) && fromExtension(d);
  if (routing.guarded) return probe && routing.profile ? proxyInfo : DEAD_END;
  if (!routing.profile) return DEAD_END;
  const where = route(host, routing);
  // Probe hosts stay reachable through the kill switch only for the extension itself.
  if (where === 'proxy' && routing.blocking && PROBE_HOSTS.includes(host) && !probe)
    return DEAD_END;
  return where === 'proxy' ? proxyInfo : where === 'direct' ? DIRECT : DEAD_END;
}

/**
 * Firefox chains every SOCKS answer to the browser's own proxy setting (system proxy, or direct
 * with network.proxy.failover_direct) and uses it once ours refuses, so a dead proxy or the dead
 * end would quietly go out another way (issue #2). A null after it ends the chain instead.
 */
const final = (info: ProxyInfo | undefined): Answer =>
  info?.type === 'socks' ? [info, null] : info;

export function onRequest(d: RequestDetails): Answer | Promise<Answer> {
  try {
    if (haveRouting) return final(decide(d));
    return Promise.race([waitForRouting(), timeout()]).then(
      (result) => {
        if (result === 'timeout') return final(DEAD_END);
        try {
          return final(decide(d));
        } catch {
          return final(DEAD_END);
        }
      },
      () => final(DEAD_END),
    );
  } catch {
    return final(DEAD_END);
  }
}
