import { describe, expect, it } from 'vitest';
import {
  analyzePageSample,
  analyzeProxyConfig,
  analyzeWebRtc,
  candidateIps,
  offsetMinutesAt,
  type PageSample,
} from '../src/leaktest/analyze';

const JAN = Date.UTC(2020, 0, 15, 12);

describe('offsetMinutesAt', () => {
  it('matches getTimezoneOffset conventions', () => {
    expect(offsetMinutesAt('America/New_York', JAN)).toBe(300);
    expect(offsetMinutesAt('Europe/Berlin', Date.UTC(2020, 6, 15))).toBe(-120);
    expect(offsetMinutesAt('UTC', JAN)).toBe(0);
    expect(offsetMinutesAt('Asia/Tehran', JAN)).toBe(-210);
  });
});

describe('analyzePageSample', () => {
  const ok: PageSample = {
    now: JAN,
    tz: 'America/New_York',
    locale: 'en-US',
    offset: 300,
    dateString: 'Wed Jan 15 2020 07:00:00 GMT-0500 (Eastern Standard Time)',
    language: 'en-US',
    languages: ['en-US', 'en'],
    workerTz: 'America/New_York',
  };
  const byId = (s: PageSample) =>
    Object.fromEntries(analyzePageSample(s, 'America/New_York').map((r) => [r.id, r.status]));

  it('passes a fully spoofed page', () => {
    expect(byId(ok)).toEqual({
      timezone: 'pass',
      language: 'pass',
      worker: 'pass',
      webrtcApi: 'skip',
    });
    expect(byId({ ...ok, iceTransportPolicy: 'relay' }).webrtcApi).toBe('pass');
    expect(byId({ ...ok, iceTransportPolicy: 'all' }).webrtcApi).toBe('fail');
  });
  it('fails a leaking timezone and points to a fix', () => {
    const r = analyzePageSample({ ...ok, tz: 'Asia/Tehran', offset: -210 }, 'America/New_York');
    expect(r[0]).toMatchObject({ status: 'fail' });
    expect(r[0]?.fix).toBeDefined();
  });
  it('fails wrong language', () => {
    expect(byId({ ...ok, language: 'fa-IR', languages: ['fa-IR'] }).language).toBe('fail');
  });
  it('warns when workers leak, skips when no worker', () => {
    expect(byId({ ...ok, workerTz: 'Asia/Tehran' }).worker).toBe('warn');
    expect(byId({ ...ok, workerTz: null }).worker).toBe('skip');
  });
});

describe('WebRTC', () => {
  const host = 'candidate:1 1 udp 2113937151 192.168.1.5 54321 typ host';
  const mdns = 'candidate:1 1 udp 2113937151 abc-123.local 54321 typ host';
  const srflx = 'candidate:2 1 udp 1677729535 203.0.113.9 54321 typ srflx raddr 0.0.0.0 rport 0';
  it('extracts IP literals and ignores mDNS', () => {
    expect(candidateIps([host, mdns, srflx])).toEqual(['192.168.1.5', '203.0.113.9']);
  });
  it('passes with the policy and no IPs', () => {
    expect(
      analyzeWebRtc('disable_non_proxied_udp', 'controlled_by_this_extension', [mdns]).status,
    ).toBe('pass');
  });
  it('fails on exposed candidates or the wrong policy', () => {
    expect(
      analyzeWebRtc('disable_non_proxied_udp', 'controlled_by_this_extension', [srflx]).status,
    ).toBe('fail');
    expect(analyzeWebRtc('default', 'controlled_by_this_extension', []).status).toBe('fail');
    expect(analyzeWebRtc('default', 'controlled_by_other_extensions', []).status).toBe('fail');
  });
  it('passes when another extension holds the right policy (B1)', () => {
    expect(
      analyzeWebRtc('disable_non_proxied_udp', 'controlled_by_other_extensions', []).status,
    ).toBe('pass');
  });
});

describe('analyzeProxyConfig', () => {
  const ctl = 'controlled_by_this_extension';
  const pac = 'function FindProxyForURL(){ return "SOCKS5 h:1080"; }';
  it('passes a SOCKS5 PAC without fallback', () => {
    expect(analyzeProxyConfig('pac_script', pac, ctl).status).toBe('pass');
  });
  it('fails other control, wrong mode, SOCKS4 and DIRECT fallback', () => {
    expect(analyzeProxyConfig('pac_script', pac, 'controlled_by_other_extensions').status).toBe(
      'fail',
    );
    expect(analyzeProxyConfig('direct', undefined, ctl).status).toBe('fail');
    expect(analyzeProxyConfig('pac_script', 'return "SOCKS h:1";', ctl).status).toBe('fail');
    expect(analyzeProxyConfig('pac_script', 'return "SOCKS5 h:1; DIRECT";', ctl).status).toBe(
      'fail',
    );
  });
});
