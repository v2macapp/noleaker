import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectExit, parseIpwho, parseTrace, retryOnce } from '../src/shared/lookup';
import { effectiveExit } from '../src/shared/exit';
import { DEFAULT_STATE } from '../src/shared/storage';

describe('parseTrace', () => {
  it('reads ip and loc', () => {
    expect(parseTrace('fl=1\nip=1.2.3.4\nloc=DE\nts=1\n')).toEqual({
      ip: '1.2.3.4',
      countryCode: 'DE',
    });
  });
  it('rejects missing or non-country loc', () => {
    expect(parseTrace('ip=1.2.3.4\n')).toBeNull();
    expect(parseTrace('ip=1.2.3.4\nloc=XXX\n')).toBeNull();
  });
});

describe('parseIpwho', () => {
  it('reads ip, country and timezone', () => {
    expect(
      parseIpwho({
        success: true,
        ip: '1.1.1.1',
        country_code: 'FR',
        timezone: { id: 'Europe/Paris' },
      }),
    ).toEqual({ ip: '1.1.1.1', countryCode: 'FR', timezone: 'Europe/Paris' });
  });
  it('rejects failures', () => {
    expect(parseIpwho({ success: false })).toBeNull();
    expect(parseIpwho(null)).toBeNull();
  });
});

describe('effectiveExit', () => {
  const exit = { ip: '1.1.1.1', countryCode: 'FR', timezone: 'Europe/Paris', detectedAt: 0 };
  it('is null without detection or override', () => {
    expect(effectiveExit(DEFAULT_STATE)).toBeNull();
  });
  it('uses detection', () => {
    expect(effectiveExit({ ...DEFAULT_STATE, detectedExit: exit })?.timezone).toBe('Europe/Paris');
  });
  it('falls back to the country table when the lookup has no timezone', () => {
    const s = { ...DEFAULT_STATE, detectedExit: { ...exit, timezone: '' } };
    expect(effectiveExit(s)?.timezone).toBe('Europe/Paris');
  });
  it('override wins and uses the country default timezone', () => {
    const e = effectiveExit({ ...DEFAULT_STATE, detectedExit: exit, countryOverride: 'JP' });
    expect(e).toMatchObject({ countryCode: 'JP', timezone: 'Asia/Tokyo', overridden: true });
  });
});

describe('detectExit', () => {
  const trace = 'ip=5.5.5.5\nloc=IR\n';
  const who = (ip: string) => ({
    success: true,
    ip,
    country_code: ip === '5.5.5.5' ? 'IR' : 'DE',
    timezone: { id: 'Europe/Berlin' },
  });
  const stub = (traceBody: string | null, whoBody: object | null) =>
    vi.stubGlobal('fetch', async (url: string) => {
      const body = url.includes('cloudflare') ? traceBody : whoBody && JSON.stringify(whoBody);
      if (body === null) throw new Error('down');
      return new Response(body);
    });
  afterEach(() => vi.unstubAllGlobals());

  it('prefers ipwho.is but marks the exit uncertain when the two disagree (issue #3)', async () => {
    stub(trace, who('9.9.9.9'));
    expect(await detectExit()).toMatchObject({
      ip: '9.9.9.9',
      countryCode: 'DE',
      timezone: 'Europe/Berlin',
      uncertain: true,
    });
  });
  it('does not ask a lookup host that would go direct', async () => {
    stub(trace, who('9.9.9.9'));
    const exit = await detectExit((host) => host !== 'cloudflare.com');
    expect(exit).toMatchObject({ ip: '9.9.9.9' });
    expect(exit?.uncertain).toBeUndefined();
    expect(await detectExit(() => false)).toBeNull();
  });
  it('keeps the stored timezone while Cloudflare sees the same exit, without asking ipwho.is (B4)', async () => {
    const known = { ip: '5.5.5.5', countryCode: 'IR', timezone: 'Asia/Tehran', detectedAt: 0 };
    stub(trace, null);
    expect(await detectExit(undefined, known)).toMatchObject({ timezone: 'Asia/Tehran' });
    stub(trace, who('5.5.5.5'));
    expect(await detectExit(undefined, { ...known, ip: '6.6.6.6' })).toMatchObject({
      timezone: 'Europe/Berlin',
    });
    expect(await detectExit(undefined, { ...known, uncertain: true })).toMatchObject({
      timezone: 'Europe/Berlin',
    });
  });
  it('keeps the trace country and adds the timezone when both see one IP', async () => {
    stub(trace, who('5.5.5.5'));
    expect(await detectExit()).toMatchObject({
      ip: '5.5.5.5',
      countryCode: 'IR',
      timezone: 'Europe/Berlin',
    });
  });
  it('works with either lookup alone and is null when both fail', async () => {
    stub(trace, null);
    expect(await detectExit()).toMatchObject({ ip: '5.5.5.5', timezone: '' });
    stub(null, who('9.9.9.9'));
    expect(await detectExit()).toMatchObject({ ip: '9.9.9.9', countryCode: 'DE' });
    stub(null, null);
    expect(await detectExit()).toBeNull();
  });
});

describe('retryOnce (B2)', () => {
  it('a first failure is retried; only a second one gives up', async () => {
    const answers = [null, 'ok'];
    expect(await retryOnce(async () => answers.shift() ?? null, 0)).toBe('ok');
    let calls = 0;
    expect(await retryOnce(async () => (calls++, null), 0)).toBeNull();
    expect(calls).toBe(2);
  });
});
