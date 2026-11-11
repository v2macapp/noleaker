import type { ExitInfo } from './types';

export const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace';
export const IPWHO_URL = 'https://ipwho.is/';
/** Hosts that stay reachable through the proxy while the kill switch is blocking everything else. */
export const PROBE_HOSTS = ['cloudflare.com', 'ipwho.is'];

const COUNTRY = /^[A-Z]{2}$/;

export function parseTrace(text: string): { ip: string; countryCode: string } | null {
  const fields = Object.fromEntries(
    text
      .split('\n')
      .map((l) => l.split('=') as [string, string?])
      .filter(([, v]) => v !== undefined),
  );
  const { ip, loc } = fields;
  if (!ip || !loc || !COUNTRY.test(loc)) return null;
  return { ip, countryCode: loc };
}

export function parseIpwho(
  data: unknown,
): { ip: string; countryCode: string; timezone: string } | null {
  const d = data as {
    success?: boolean;
    ip?: string;
    country_code?: string;
    timezone?: { id?: string };
  };
  if (!d?.success || !d.ip || !d.country_code || !COUNTRY.test(d.country_code)) return null;
  return { ip: d.ip, countryCode: d.country_code, timezone: d.timezone?.id ?? '' };
}

async function get(url: string): Promise<Response> {
  const res = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/**
 * Detect the exit: Cloudflare trace and ipwho.is, either one alone is enough. A source whose host
 * `viaProxy` says goes direct is not asked: its answer would be the real IP.
 * When they see different IPs, one of them did not go through the tunnel, and nothing tells which.
 * ipwho.is is kept for the identity (a VPN's direct rule usually hits Cloudflare, issue #3), but the
 * result is marked `uncertain` so the popup says so instead of showing it as verified.
 * Only ipwho.is gives a timezone, so while Cloudflare still sees the stored, certain exit `known`
 * its timezone is reused and ipwho.is is not asked (B4: a failed or rate-limited ipwho.is lookup
 * used to wipe the timezone).
 * Returns null when both lookups fail, which means the proxy is unreachable.
 */
export async function detectExit(
  viaProxy: (host: string) => boolean = () => true,
  known: ExitInfo | null = null,
): Promise<ExitInfo | null> {
  let trace: ReturnType<typeof parseTrace> = null;
  if (viaProxy(new URL(TRACE_URL).hostname))
    try {
      trace = parseTrace(await (await get(TRACE_URL)).text());
    } catch {
      // ipwho.is alone is enough
    }
  if (trace && known?.timezone && !known.uncertain && known.ip === trace.ip)
    return { ...trace, timezone: known.timezone, detectedAt: Date.now() };
  let who: ReturnType<typeof parseIpwho> = null;
  if (viaProxy(new URL(IPWHO_URL).hostname))
    try {
      who = parseIpwho(await (await get(IPWHO_URL)).json());
    } catch {
      // no timezone from the lookup; the country table is the fallback
    }
  if (who && trace && who.ip !== trace.ip)
    return { ...who, detectedAt: Date.now(), uncertain: true };
  if (who && !trace) return { ...who, detectedAt: Date.now() };
  if (!trace) return null;
  return { ...trace, timezone: who?.timezone ?? '', detectedAt: Date.now() };
}

/** One failed check is often a wake from sleep or a short hiccup (B2): ask once more before giving up. */
export async function retryOnce<T>(
  task: () => Promise<T | null>,
  delayMs: number,
): Promise<T | null> {
  const first = await task();
  if (first) return first;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return task();
}
