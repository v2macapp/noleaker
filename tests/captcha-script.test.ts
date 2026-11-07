import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTCHA_DOMAIN_MATCHES,
  CAPTCHA_MATCHES,
  isCaptchaPage,
  RECAPTCHA_MATCH,
} from '../src/shared/antibot';
import { CAPTCHA_SCRIPT_IDS, syncCaptchaScript } from '../src/background/captcha-script';

const mainEntry = (browser: string) =>
  (
    JSON.parse(readFileSync(`manifests/manifest.${browser}.json`, 'utf8')) as {
      content_scripts: { js: string[]; exclude_matches?: string[] }[];
    }
  ).content_scripts.find((c) => c.js.includes('content/main.js'))!;

describe('captcha pages and content/main.js', () => {
  it('both manifests exclude exactly the captcha pages', () => {
    for (const browser of ['chrome', 'firefox'])
      expect(mainEntry(browser).exclude_matches, browser).toEqual(CAPTCHA_MATCHES);
  });

  it('patterns cover what isCaptchaPage covers', () => {
    expect(CAPTCHA_MATCHES).toContain('*://*.hcaptcha.com/*'); // also matches hcaptcha.com itself
    expect(CAPTCHA_MATCHES).toContain('*://www.google.com/recaptcha/*');
    expect(isCaptchaPage('www.google.com', '/recaptcha/api2/anchor')).toBe(true);
  });

  describe('syncCaptchaScript', () => {
    const registered: { id: string }[] = [];
    const scripting = {
      getRegisteredContentScripts: vi.fn(async ({ ids }: { ids: string[] }) =>
        registered.filter((s) => ids.includes(s.id)),
      ),
      registerContentScripts: vi.fn(async (s: { id: string }[]) => void registered.push(...s)),
      unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => {
        for (const id of ids)
          registered.splice(
            registered.findIndex((s) => s.id === id),
            1,
          );
      }),
    };
    vi.stubGlobal('chrome', { scripting });
    afterEach(() => vi.clearAllMocks());

    it('registers main.js on captcha pages in Strict, once', async () => {
      await syncCaptchaScript(true);
      await syncCaptchaScript(true);
      expect(scripting.registerContentScripts).toHaveBeenCalledTimes(1);
      const common = {
        js: ['content/main.js'],
        world: 'MAIN',
        runAt: 'document_start',
        allFrames: true,
      };
      expect(registered).toMatchObject([
        { ...common, id: CAPTCHA_SCRIPT_IDS[0], matches: CAPTCHA_DOMAIN_MATCHES },
        { ...common, id: CAPTCHA_SCRIPT_IDS[1], matches: [RECAPTCHA_MATCH] },
      ]);
      // Chrome rejects the origin fallback on a pattern with a path.
      expect(registered[1]).not.toMatchObject({ matchOriginAsFallback: true });
    });

    it('repairs a half registration', async () => {
      registered.splice(1);
      await syncCaptchaScript(true);
      expect(registered.map((s) => s.id)).toEqual([...CAPTCHA_SCRIPT_IDS]);
    });

    it('removes it in Compatibility', async () => {
      await syncCaptchaScript(false);
      expect(registered).toEqual([]);
      vi.clearAllMocks();
      await syncCaptchaScript(false);
      expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
    });
  });
});
