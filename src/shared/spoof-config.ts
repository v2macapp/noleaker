import { effectiveExit } from './exit';
import { buildFingerprintConfig, type FingerprintConfig, NO_FINGERPRINT } from './fingerprint';
import { resolveIdentity } from './identity';
import { connected } from './profiles';
import { SHIELD_DEFAULTS } from './shields';
import type { ShieldToggles, State } from './types';

/** What the page-level scripts need. `active` is false whenever spoofing must be paused. */
export interface SpoofConfig {
  active: boolean;
  /** Strict routing disables automatic captcha exemptions. */
  strict?: boolean;
  timezone: string;
  locale: string;
  /** The Accept-Language header value; `languages` are its tags. */
  acceptLanguage: string;
  languages: string[];
  /** Sites (and their subdomains) where spoofing is disabled. */
  whitelist: string[];
  /** Optional fingerprint spoofing; every flag is off by default. */
  fingerprint: FingerprintConfig;
  /** Which shields are on. Each shield reads only its own flag. */
  shields: ShieldToggles;
  /** A point in the exit country, for geolocation. Null when the country is unknown. */
  coordinates: { latitude: number; longitude: number } | null;
  /**
   * Stealth mode. Unlike everything else it does not pause with the proxy or on whitelisted sites:
   * the patches stay installed there, and their function shapes must stay native too.
   */
  stealth: boolean;
}

export const CONFIG_KEY = 'effectiveConfig';
/** Key of the worker prelude script text, written by the service worker for the bridge. */
export const PRELUDE_KEY = 'workerPrelude';
export const LOCALE = 'en-US';
export const LANGUAGES = ['en-US', 'en'];
export const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

export const INACTIVE_CONFIG: SpoofConfig = {
  active: false,
  strict: false,
  timezone: '',
  locale: LOCALE,
  acceptLanguage: ACCEPT_LANGUAGE,
  languages: LANGUAGES,
  whitelist: [],
  fingerprint: NO_FINGERPRINT,
  shields: SHIELD_DEFAULTS,
  coordinates: null,
  stealth: false,
};

/**
 * Key rule: spoof only while the proxy (or system VPN) is on, reachable, and the exit is known.
 * Otherwise a fake timezone could be paired with the real IP. A manual country counts only after
 * a check has seen the exit (B18), which proves the proxy works.
 */
export function buildSpoofConfig(state: State): SpoofConfig {
  const exit = effectiveExit(state);
  const ok = connected(state) && !state.killSwitchActive;
  const identity = resolveIdentity(state);
  if (!ok || !exit || !state.detectedExit || !identity.timezone) {
    return {
      ...INACTIVE_CONFIG,
      stealth: state.stealth,
      strict: connected(state) && state.routingMode === 'strict',
      shields: state.shields,
    };
  }
  return {
    active: true,
    strict: state.routingMode === 'strict',
    timezone: identity.timezone,
    locale: identity.locale,
    acceptLanguage: identity.acceptLanguage,
    languages: identity.languages,
    whitelist: state.whitelist,
    fingerprint: buildFingerprintConfig(state),
    shields: state.shields,
    coordinates: identity.coordinates,
    stealth: state.stealth,
  };
}
