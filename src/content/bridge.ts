// Isolated-world content script: reads the effective config written by the service
// worker and forwards it to the MAIN-world script (as a JSON string, safe across worlds).
// On whitelisted sites it forwards the inactive config, so nothing is spoofed there.
import { isCaptchaPage } from '../shared/antibot';
import { hostMatches } from '../shared/domains';
import { scopedSeed } from '../shared/site-seed';
import { CONFIG_KEY, INACTIVE_CONFIG, PRELUDE_KEY, type SpoofConfig } from '../shared/spoof-config';
import { NO_FINGERPRINT } from '../shared/fingerprint';
import { sendMessage } from '../shared/messages';
import { rememberStartup } from './startup';
import { ackName, HANDSHAKE_EVENT, type ConfigMessage, type Hello } from './events';

let current: SpoofConfig = INACTIVE_CONFIG;
let prelude: string | null = null;
let acked = false;
let reported = false;
let configLoaded = false;
let pushVersion = 0;
/** The event name the MAIN-world script chose for this page load; null until the handshake. */
let name: string | null = null;

let topHost: Promise<string> | undefined;

// B10: an origin whose CSP blocked our blob worker is remembered (hashed), so on later page loads
// its first worker starts natively instead of being lost. Without a prelude, main.ts never wraps.
// shortcut: the first worker of the first visit is still lost, and the list only grows (capped);
// a facade worker that buffers and replays would cover that.
const CSP_KEY = 'blobBlockedOrigins';
const originHash = scopedSeed('worker-csp', String(location.origin)).catch(() => '');
let blobBlocked = false;
addEventListener('securitypolicyviolation', (e) => {
  if (
    blobBlocked ||
    !/^(worker|child|script)-src/.test(e.violatedDirective) ||
    !String(e.blockedURI).startsWith('blob')
  )
    return;
  blobBlocked = true;
  void Promise.all([originHash, chrome.storage.local.get(CSP_KEY)]).then(([hash, r]) => {
    const list = ((r[CSP_KEY] as string[] | undefined) ?? []).filter((h) => h !== hash);
    return chrome.storage.local.set({ [CSP_KEY]: [...list, hash].slice(-200) });
  });
});

/** The site the user sees: the top-level host, also from inside frames. */
function topHostname(): Promise<string> {
  return (topHost ??= findTopHostname());
}

async function findTopHostname(): Promise<string> {
  if (window === window.top) return location.hostname;
  const origins = location.ancestorOrigins;
  // Firefox before 151 has no ancestorOrigins: the background knows the tab's URL.
  if (__BROWSER__ === 'firefox' && !origins)
    return sendMessage({ type: 'topHost' }).then(
      (host) => host || location.hostname,
      () => location.hostname,
    );
  const top = origins?.[origins.length - 1];
  try {
    return top ? new URL(top).hostname : location.hostname;
  } catch {
    return location.hostname;
  }
}

function onHello(e: Event): void {
  let hello: Hello;
  try {
    hello = JSON.parse((e as CustomEvent<string>).detail) as Hello;
  } catch {
    return;
  }
  if (hello.k !== 'main' || name) return;
  name = hello.n;
  window.removeEventListener(HANDSHAKE_EVENT, onHello);
  window.addEventListener(ackName(name), () => {
    acked = true;
  });
  // The first message makes the MAIN-world script stop answering hellos. Send it now, before page
  // scripts run: otherwise a page could fake a bridge hello and learn the name.
  const empty: ConfigMessage = { config: null, prelude: null };
  window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(empty) }));
  if (configLoaded) push();
}

/** Tell the service worker that this page runs without the MAIN-world script. */
function reportStale(): void {
  if (reported || window !== window.top) return;
  reported = true;
  const nav = performance.getEntriesByType('navigation')[0] as
    (PerformanceNavigationTiming & { deliveryType?: string }) | undefined;
  void sendMessage({
    type: 'staleReport',
    url: location.href,
    serviceWorker: !!navigator.serviceWorker?.controller,
    deliveryType: nav?.deliveryType ?? '',
    navigationType: nav?.type ?? '',
  }).catch(() => undefined);
}

/** After a push that should have been answered: wait a moment, push again, then report. */
function verifyMain(): void {
  if (acked) return;
  setTimeout(async () => {
    if (!acked) await push(true);
    if (!acked) reportStale();
  }, 800);
}

async function push(retry = false): Promise<void> {
  const version = ++pushVersion;
  const host = await topHostname();
  if (version !== pushVersion) return;
  // Whitelisted sites, and captcha frames wherever they are embedded, get no spoofing.
  const skip =
    hostMatches(host, current.whitelist ?? []) ||
    (!current.strict && isCaptchaPage(location.hostname, location.pathname));
  // Derive a per-top-level-host seed without revealing the reusable profile identifier.
  const config: SpoofConfig = skip
    ? { ...INACTIVE_CONFIG, stealth: current.stealth === true }
    : {
        ...current,
        fingerprint: {
          ...(current.fingerprint ?? NO_FINGERPRINT),
          siteSeed: '',
        },
      };
  if (config.active) {
    let seed: string;
    try {
      seed = await scopedSeed(current.fingerprint?.seed ?? '', host);
    } catch {
      reportStale();
      return;
    }
    if (version !== pushVersion) return;
    config.fingerprint.seed = seed;
    config.fingerprint.siteSeed = seed;
  }
  // The prelude is only useful where something is spoofed; skip the ~30 KB elsewhere.
  // Whitelist is needed only by the isolated bridge; never disclose it to page code.
  config.whitelist = [];
  rememberStartup(config);
  const message: ConfigMessage = {
    config,
    prelude: config.active && !blobBlocked ? prelude : null,
  };
  if (name) {
    acked = false;
    window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(message) }));
  }
  // The MAIN-world script answers synchronously. No answer (or no handshake) on a protected page
  // means it is missing.
  if (config.active && !retry) verifyMain();
}

// The MAIN-world script may start before or after this one; each answers the other's hello.
window.addEventListener(HANDSHAKE_EVENT, onHello);
window.dispatchEvent(
  new CustomEvent(HANDSHAKE_EVENT, { detail: JSON.stringify({ k: 'bridge' } satisfies Hello) }),
);
// A page restored from the back/forward cache missed any config change made while it was frozen.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) push();
});

chrome.storage.local.get([CONFIG_KEY, PRELUDE_KEY, CSP_KEY]).then(async (r) => {
  current = (r[CONFIG_KEY] as SpoofConfig | undefined) ?? INACTIVE_CONFIG;
  prelude = (r[PRELUDE_KEY] as string | undefined) ?? null;
  blobBlocked ||= ((r[CSP_KEY] as string[] | undefined) ?? []).includes(await originHash);
  configLoaded = true;
  push();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes[CONFIG_KEY] || changes[PRELUDE_KEY])) return;
  if (changes[CONFIG_KEY]) {
    current = (changes[CONFIG_KEY].newValue as SpoofConfig | undefined) ?? INACTIVE_CONFIG;
  }
  if (changes[PRELUDE_KEY]) prelude = (changes[PRELUDE_KEY].newValue as string | undefined) ?? null;
  push();
});
