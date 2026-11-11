import { LANGUAGES, LOCALE } from '../shared/spoof-config';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to change when the check is not green. */
  fix?: { text: string; page?: 'options' | 'popup' };
}

export interface PageSample {
  now: number;
  tz: string;
  locale: string;
  offset: number;
  dateString: string;
  language: string;
  languages: string[];
  workerTz: string | null;
  /** What `new RTCPeerConnection().getConfiguration().iceTransportPolicy` says in the page. */
  iceTransportPolicy?: string | null;
}

/** Same sign convention as Date.getTimezoneOffset (minutes, west of UTC positive). */
export function offsetMinutesAt(timeZone: string, atMs: number): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const v: Record<string, number> = {};
  for (const p of f.formatToParts(atMs)) if (p.type !== 'literal') v[p.type] = Number(p.value);
  const asUtc = Date.UTC(v.year!, v.month! - 1, v.day!, v.hour!, v.minute!, v.second!);
  const minutes = (asUtc - Math.floor(atMs / 1000) * 1000) / 60000;
  return minutes === 0 ? 0 : -minutes;
}

const gmt = (offsetWest: number) => {
  const east = -offsetWest;
  const abs = Math.abs(east);
  const p = (n: number) => String(n).padStart(2, '0');
  return `GMT${east < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
};

/** Timezone, language and worker checks from what a real page saw. */
export interface ExpectedLanguage {
  /** Default Intl locale. */
  locale: string;
  /** `languages[0]` is navigator.language. */
  languages: string[];
}

const ENGLISH: ExpectedLanguage = { locale: LOCALE, languages: LANGUAGES };

export function analyzePageSample(
  sample: PageSample,
  expectedTz: string,
  expected: ExpectedLanguage = ENGLISH,
): CheckResult[] {
  const expectedOffset = offsetMinutesAt(expectedTz, sample.now);

  const tzProblems: string[] = [];
  if (sample.tz !== expectedTz) tzProblems.push(`Intl says ${sample.tz}`);
  if (sample.offset !== expectedOffset) {
    tzProblems.push(`Date offset is ${sample.offset} min, expected ${expectedOffset}`);
  }
  if (!sample.dateString.includes(gmt(expectedOffset))) {
    tzProblems.push(`Date string is "${sample.dateString}"`);
  }
  const timezone: CheckResult = {
    id: 'timezone',
    title: 'Timezone (Intl and Date)',
    status: tzProblems.length ? 'fail' : 'pass',
    detail: tzProblems.length
      ? `${tzProblems.join('; ')}. Expected ${expectedTz}.`
      : `${expectedTz}, offset and date strings agree with the exit.`,
    fix: tzProblems.length
      ? {
          text: 'Check that the site is not whitelisted and that exit detection succeeded, then reload.',
          page: 'popup',
        }
      : undefined,
  };

  const langProblems: string[] = [];
  if (sample.language !== expected.languages[0]) {
    langProblems.push(`navigator.language is ${sample.language}`);
  }
  if (sample.languages.join(',') !== expected.languages.join(',')) {
    langProblems.push(`navigator.languages is ${sample.languages.join(',')}`);
  }
  if (sample.locale !== expected.locale) langProblems.push(`Intl locale is ${sample.locale}`);
  const language: CheckResult = {
    id: 'language',
    title: 'Language',
    status: langProblems.length ? 'fail' : 'pass',
    detail: langProblems.length
      ? langProblems.join('; ')
      : `${expected.languages.join(', ')} everywhere in the page.`,
    fix: langProblems.length
      ? { text: 'Reload the page; spoofing must be active for this site.', page: 'popup' }
      : undefined,
  };

  const worker: CheckResult =
    sample.workerTz === null
      ? {
          id: 'worker',
          title: 'Web Worker timezone',
          status: 'skip',
          detail: 'Could not start a worker on the test page.',
        }
      : sample.workerTz === expectedTz
        ? {
            id: 'worker',
            title: 'Web Worker timezone',
            status: 'pass',
            detail: `Workers report ${expectedTz}.`,
          }
        : {
            id: 'worker',
            title: 'Web Worker timezone',
            status: 'warn',
            detail: `Workers report ${sample.workerTz}. Scripts that read the timezone inside a worker can see it.`,
            fix: { text: 'Known limitation: workers are not spoofed yet.' },
          };

  const webrtcApi: CheckResult =
    sample.iceTransportPolicy === undefined || sample.iceTransportPolicy === null
      ? {
          id: 'webrtcApi',
          title: 'WebRTC (page API)',
          status: 'skip',
          detail: 'Could not create a peer connection on the test page.',
        }
      : sample.iceTransportPolicy === 'relay'
        ? {
            id: 'webrtcApi',
            title: 'WebRTC (page API)',
            status: 'pass',
            detail:
              'Pages get iceTransportPolicy "relay", so no local or public address is gathered.',
          }
        : {
            id: 'webrtcApi',
            title: 'WebRTC (page API)',
            status: 'fail',
            detail: `A page gets iceTransportPolicy "${sample.iceTransportPolicy}".`,
            fix: { text: 'Turn on the WebRTC shield and reload the page.', page: 'options' },
          };

  return [timezone, language, worker, webrtcApi];
}

const IP = /(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/i;

/** IP literals found in ICE candidate lines. mDNS (.local) candidates are not leaks. */
export function candidateIps(candidates: string[]): string[] {
  const ips = new Set<string>();
  for (const line of candidates) {
    const fields = line.split(' ');
    const address = fields[4] ?? '';
    if (address.endsWith('.local')) continue;
    const m = IP.exec(address);
    if (m) ips.add(m[0]);
  }
  return [...ips];
}

export function analyzeWebRtc(policy: string, level: string, candidates: string[]): CheckResult {
  const base = { id: 'webrtc', title: 'WebRTC' };
  // Another extension holding the right policy is fine (B1); only a wrong value fails.
  if (policy !== 'disable_non_proxied_udp' && level !== 'controlled_by_this_extension') {
    return {
      ...base,
      status: 'fail',
      detail: `WebRTC policy is "${policy}" and is not controlled by noleaker (${level}).`,
      fix: { text: 'Disable other extensions that manage WebRTC or privacy settings.' },
    };
  }
  if (policy !== 'disable_non_proxied_udp') {
    return {
      ...base,
      status: 'fail',
      detail: `WebRTC policy is "${policy}".`,
      fix: { text: 'Turn the proxy off and on again to re-apply the policy.', page: 'popup' },
    };
  }
  const ips = candidateIps(candidates);
  return ips.length
    ? {
        ...base,
        status: 'fail',
        detail: `ICE candidates exposed: ${ips.join(', ')}.`,
        fix: { text: 'Turn the proxy off and on again, then re-run the test.', page: 'popup' },
      }
    : {
        ...base,
        status: 'pass',
        detail: `Policy is disable_non_proxied_udp; ${candidates.length} candidate(s), no IP addresses.`,
      };
}

export function analyzeProxyConfig(
  mode: string,
  pacData: string | undefined,
  level: string,
): CheckResult {
  const base = { id: 'config', title: 'Proxy and DNS configuration' };
  if (level !== 'controlled_by_this_extension') {
    return {
      ...base,
      status: 'fail',
      detail: `The browser's proxy settings are not controlled by noleaker (${level}).`,
      fix: { text: 'Disable other proxy extensions (for example FoxyProxy) or system overrides.' },
    };
  }
  // Firefox: every request is routed by noleaker's proxy.onRequest listener (SOCKS5, proxyDNS).
  if (__BROWSER__ === 'firefox' && mode === 'on_request')
    return {
      ...base,
      status: 'pass',
      detail:
        'Each request is routed by noleaker (SOCKS5 with remote DNS, no direct fallback). (Configuration check, not a DNS probe.)',
    };
  if (mode !== 'pac_script' || !pacData) {
    return {
      ...base,
      status: 'fail',
      detail: `Proxy mode is "${mode}".`,
      fix: { text: 'Turn the proxy on in the popup.', page: 'popup' },
    };
  }
  if (!/"SOCKS5 [^"]+"/.test(pacData) || /SOCKS4|"SOCKS [^"]+"/.test(pacData)) {
    return {
      ...base,
      status: 'fail',
      detail: 'The PAC script does not use SOCKS5, so DNS may be resolved locally.',
      fix: { text: 'Re-save the proxy in the options.', page: 'options' },
    };
  }
  if (/"SOCKS5 [^"]*;\s*DIRECT"/.test(pacData)) {
    return {
      ...base,
      status: 'fail',
      detail: 'The PAC script falls back to DIRECT after the proxy.',
      fix: { text: 'Re-save the proxy in the options.', page: 'options' },
    };
  }
  return {
    ...base,
    status: 'pass',
    detail: 'SOCKS5 with remote DNS, no direct fallback. (Configuration check, not a DNS probe.)',
  };
}
