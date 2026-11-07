import { CAPTCHA_DOMAIN_MATCHES, RECAPTCHA_MATCH } from '../shared/antibot';
import { log } from '../shared/log';

export const CAPTCHA_SCRIPT_IDS = ['noleaker-captcha-main', 'noleaker-captcha-main-path'] as const;

/**
 * Captcha frames get content/main.js (with its neutral startup state) only in Strict mode. The
 * manifest excludes them, so in Compatibility a challenge sees an untouched browser.
 */
export async function syncCaptchaScript(strict: boolean): Promise<void> {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({
      ids: [...CAPTCHA_SCRIPT_IDS],
    });
    if (strict && registered.length === CAPTCHA_SCRIPT_IDS.length) return;
    // Wrong mode or half registered: start clean.
    if (registered.length > 0)
      await chrome.scripting.unregisterContentScripts({ ids: registered.map((s) => s.id) });
    if (!strict) return;
    const script = (id: string, matches: string[], fallback: boolean) => ({
      id,
      matches,
      js: ['content/main.js'],
      runAt: 'document_start' as const,
      allFrames: true,
      world: 'MAIN' as const,
      persistAcrossSessions: true,
      // Firefox has no origin fallback here (nor in its manifest).
      ...(__BROWSER__ === 'chrome' && { matchOriginAsFallback: fallback }),
    });
    await chrome.scripting.registerContentScripts([
      script(CAPTCHA_SCRIPT_IDS[0], CAPTCHA_DOMAIN_MATCHES, true),
      // Chrome refuses the origin fallback on a pattern with a path, hence two registrations.
      script(CAPTCHA_SCRIPT_IDS[1], [RECAPTCHA_MATCH], false),
    ]);
  } catch (e) {
    log('error', 'Could not register the Strict captcha script', e);
  }
}
