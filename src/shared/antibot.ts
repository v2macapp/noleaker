/**
 * Captcha and bot-check providers. Spoofing and header changes are switched off for their
 * pages and requests, because a challenge that sees a rewritten browser (or headers it did not
 * expect) can fail or loop.
 */
export const CAPTCHA_DOMAINS = [
  'challenges.cloudflare.com',
  'hcaptcha.com',
  'recaptcha.net',
  'arkoselabs.com',
  'funcaptcha.com',
  'geetest.com',
  'captcha-delivery.com',
] as const;

/** reCAPTCHA also lives on a path of www.google.com, which a domain list cannot express. */
export const RECAPTCHA_HOST = 'www.google.com';
export const RECAPTCHA_PATH = '/recaptcha/';
/** DNR url filter for the path above (domain anchored). */
export const RECAPTCHA_URL_FILTER = `||${RECAPTCHA_HOST}${RECAPTCHA_PATH}`;

/** True for a page or frame served by a captcha provider. */
export function isCaptchaPage(hostname: string, pathname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (CAPTCHA_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  return host === RECAPTCHA_HOST && pathname.startsWith(RECAPTCHA_PATH);
}

/** Match patterns for the pages above; the manifest keeps content/main.js off them. */
export const CAPTCHA_DOMAIN_MATCHES = CAPTCHA_DOMAINS.map((d) => `*://*.${d}/*`);
export const RECAPTCHA_MATCH = `*://${RECAPTCHA_HOST}${RECAPTCHA_PATH}*`;
export const CAPTCHA_MATCHES = [...CAPTCHA_DOMAIN_MATCHES, RECAPTCHA_MATCH];
