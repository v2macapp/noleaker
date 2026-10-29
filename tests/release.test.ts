import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { updatesJson } from '../scripts/updates-json.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe.each(['chrome', 'firefox'])('release metadata (%s)', (target) => {
  const manifest = JSON.parse(readFileSync(`manifests/manifest.${target}.json`, 'utf8'));
  it('manifest and package versions match', () => {
    expect(manifest.version).toBe(pkg.version);
  });
  it('every icon in the manifest exists', () => {
    const files = [
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon),
    ];
    for (const f of files as string[]) expect(existsSync(`public/${f}`), f).toBe(true);
  });
  it('requests only the permissions the code uses', () => {
    expect([...manifest.permissions].sort()).toEqual(
      [
        'alarms',
        'declarativeNetRequest',
        'privacy',
        'proxy',
        'scripting',
        'storage',
        'webNavigation',
      ].sort(),
    );
  });
  it('ships the bundled Iran list', () => {
    expect(existsSync('public/data/iran-domains.json')).toBe(true);
  });
});

describe('Firefox manifest', () => {
  const manifest = JSON.parse(readFileSync('manifests/manifest.firefox.json', 'utf8'));
  it('keeps the permanent gecko ID, ESR 140 minimum and private-window mode', () => {
    expect(manifest.browser_specific_settings.gecko).toMatchObject({
      id: 'noleaker@lordversa.github.io',
      strict_min_version: '140.0',
    });
    expect(manifest.incognito).toBe('spanning');
    expect(manifest.background.service_worker).toBeUndefined();
  });
});

describe('Firefox updates.json', () => {
  it('points the self-hosted update_url at the signed .xpi of the tagged release', () => {
    const manifest = JSON.parse(readFileSync('manifests/manifest.firefox.json', 'utf8'));
    const out = updatesJson(manifest, '1.2.3', 'noleaker-firefox-1.2.3.xpi', Buffer.from('xpi'));
    expect(out.addons['noleaker@lordversa.github.io'].updates).toEqual([
      {
        version: '1.2.3',
        update_link:
          'https://github.com/v2macapp/noleaker/releases/download/v1.2.3/noleaker-firefox-1.2.3.xpi',
        update_hash: 'sha256:d70214a04a2d194e4039403f1018689e7d3951ecc6fd2fdc39c9cc65907464b5',
        browser_specific_settings: { gecko: { strict_min_version: '140.0' } },
      },
    ]);
  });
});
