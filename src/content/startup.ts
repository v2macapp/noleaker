import { INACTIVE_CONFIG, type SpoofConfig } from '../shared/spoof-config';

/**
 * The identity a page starts with before the bridge's asynchronous config arrives (B6, B7).
 * The bridge keeps the last active identity in sessionStorage, which same-origin frames share,
 * so later loads and new same-origin frames start with the right values instead of UTC/en-US.
 * The page can read and write it. So it only chooses which spoofed values to start with; it
 * never turns spoofing off, and anything invalid falls back to the neutral UTC start.
 */
export const STARTUP_KEY = 'k7f3q9';

type Identity = Pick<SpoofConfig, 'timezone' | 'locale' | 'languages'>;

const NEUTRAL: SpoofConfig = { ...INACTIVE_CONFIG, active: true, timezone: 'UTC' };

// Reading sessionStorage throws in opaque-origin frames, so it is read inside the try.
const session = (): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> => sessionStorage;

export function startupConfig(storage = session): SpoofConfig {
  try {
    const raw = storage().getItem(STARTUP_KEY);
    if (!raw) return NEUTRAL;
    const { timezone, locale, languages } = JSON.parse(raw) as Identity;
    if (
      typeof timezone !== 'string' ||
      typeof locale !== 'string' ||
      !Array.isArray(languages) ||
      languages.length === 0 ||
      !languages.every((l) => typeof l === 'string')
    )
      return NEUTRAL;
    // Throws on an unknown zone or a malformed tag; an invalid zone would leave spoofing paused.
    new Intl.DateTimeFormat(locale, { timeZone: timezone });
    Intl.getCanonicalLocales(languages);
    return { ...NEUTRAL, timezone, locale, languages };
  } catch {
    return NEUTRAL;
  }
}

/** Called by the bridge with every config it pushes. */
export function rememberStartup(config: SpoofConfig, storage = session): void {
  try {
    if (!config.active) storage().removeItem(STARTUP_KEY);
    else {
      const { timezone, locale, languages } = config;
      storage().setItem(STARTUP_KEY, JSON.stringify({ timezone, locale, languages }));
    }
  } catch {
    // storage blocked (sandboxed frame, privacy settings): the neutral start remains
  }
}
