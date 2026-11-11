import { describe, expect, it } from 'vitest';
import { rememberStartup, STARTUP_KEY, startupConfig } from '../src/content/startup';
import { INACTIVE_CONFIG } from '../src/shared/spoof-config';

const memory = () => {
  const items = new Map<string, string>();
  const store = {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
  return () => store;
};
const tokyo = {
  ...INACTIVE_CONFIG,
  active: true,
  timezone: 'Asia/Tokyo',
  locale: 'ja-JP',
  languages: ['ja-JP', 'ja'],
};

describe('startup identity (B6, B7)', () => {
  it('starts neutral without a cache, and with the last active identity after one', () => {
    const s = memory();
    expect(startupConfig(s)).toMatchObject({ active: true, timezone: 'UTC' });
    rememberStartup(tokyo, s);
    expect(startupConfig(s)).toMatchObject({
      active: true,
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
      languages: ['ja-JP', 'ja'],
    });
    expect(JSON.parse(s().getItem(STARTUP_KEY)!)).not.toHaveProperty('fingerprint');
  });
  it('an inactive config clears it; the page can never start native from it', () => {
    const s = memory();
    rememberStartup(tokyo, s);
    rememberStartup(INACTIVE_CONFIG, s);
    expect(startupConfig(s)).toMatchObject({ active: true, timezone: 'UTC' });
    rememberStartup(tokyo, s);
    rememberStartup({ ...tokyo, stealth: true }, s); // a page could spot the key
    expect(s().getItem(STARTUP_KEY)).toBeNull();
    s().setItem(STARTUP_KEY, JSON.stringify({ ...tokyo, active: false, shields: {} }));
    expect(startupConfig(s)).toMatchObject({ active: true, shields: INACTIVE_CONFIG.shields });
  });
  it('falls back to neutral on junk a page wrote, or when storage throws', () => {
    const s = memory();
    for (const bad of [
      '{',
      '{"timezone":"Mars/Olympus","locale":"en-US","languages":["en-US"]}',
      '{"timezone":"UTC","locale":"","languages":["en-US"]}',
      '{"timezone":"UTC","locale":"en-US","languages":[]}',
      '{"timezone":"UTC","locale":"en-US","languages":[1]}',
    ]) {
      s().setItem(STARTUP_KEY, bad);
      expect(startupConfig(s)).toMatchObject({ timezone: 'UTC', locale: INACTIVE_CONFIG.locale });
    }
    const blocked = () => {
      throw new Error('SecurityError');
    };
    expect(startupConfig(blocked)).toMatchObject({ timezone: 'UTC' });
    expect(() => rememberStartup(tokyo, blocked)).not.toThrow();
  });
});
