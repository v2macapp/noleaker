import { effectiveExit } from '../shared/exit';
import { hostMatches } from '../shared/domains';
import { COUNTRIES } from '../shared/countries';
import { parseTrace, TRACE_URL } from '../shared/lookup';
import { protectionPlan } from '../shared/plan';
import { RULES_STATUS_KEY, rulesProblem, type RulesStatus } from '../shared/rules-status';
import { buildSpoofConfig } from '../shared/spoof-config';
import type { State } from '../shared/types';
import {
  analyzePageSample,
  analyzeProxyConfig,
  analyzeWebRtc,
  type CheckResult,
  type PageSample,
} from './analyze';
import { readProxyControl } from '@platform/control';
import { getEnv, PRIVATE_WARNING, RFP_NOTE, setEnv } from '../shared/browser-env';

export interface CheckDef {
  id: string;
  title: string;
}

/** Rows shown while checks run. The page-sample check fills three rows. */
export const ROWS: CheckDef[] = [
  { id: 'ip', title: 'Public IP matches the exit' },
  { id: 'config', title: 'Proxy and DNS configuration' },
  { id: 'webrtc', title: 'WebRTC' },
  { id: 'quic', title: 'QUIC / HTTP3 fallback' },
  { id: 'timezone', title: 'Timezone (Intl and Date)' },
  { id: 'language', title: 'Language' },
  { id: 'worker', title: 'Web Worker timezone' },
  { id: 'webrtcApi', title: 'WebRTC (page API)' },
  { id: 'rules', title: 'Network rules installed' },
  { id: 'killswitch', title: 'Kill switch' },
];

const TEST_PAGE = 'https://cloudflare.com/cdn-cgi/trace';

async function checkIp(state: State): Promise<CheckResult> {
  const base = { id: 'ip', title: 'Public IP matches the exit' };
  let seen: { ip: string; countryCode: string } | null = null;
  try {
    const res = await fetch(TRACE_URL, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    seen = parseTrace(await res.text());
  } catch {
    // handled below
  }
  if (!seen) {
    return {
      ...base,
      status: 'fail',
      detail: 'Could not look up the public IP through the proxy.',
      fix: {
        text: 'Check that your SOCKS5 server is running and the host/port are right.',
        page: 'options',
      },
    };
  }
  const exit = effectiveExit(state);
  const name = COUNTRIES[seen.countryCode]?.name ?? seen.countryCode;
  if (!state.detectedExit) {
    return {
      ...base,
      status: 'warn',
      detail: `Seen as ${seen.ip} (${name}), but exit detection has not finished.`,
      fix: { text: 'Wait a few seconds, or turn the proxy off and on.', page: 'popup' },
    };
  }
  if (seen.ip !== state.detectedExit.ip) {
    return {
      ...base,
      status: 'warn',
      detail: `Seen as ${seen.ip}, but detection recorded ${state.detectedExit.ip}. The exit changed.`,
      fix: { text: 'Turn the proxy off and on to re-detect the exit.', page: 'popup' },
    };
  }
  if (exit?.overridden) {
    return {
      ...base,
      status: 'warn',
      detail: `${seen.ip} is in ${name}, but the country is manually set to ${exit.countryCode}.`,
      fix: { text: 'Set the exit country back to Auto-detect.', page: 'popup' },
    };
  }
  return {
    ...base,
    status: 'pass',
    detail: `${seen.ip} · ${name}. Matches the stored lookup; independent proxy egress and real-IP separation were not measured.`,
  };
}

async function checkConfig(state: State): Promise<CheckResult> {
  if (state.connection === 'system')
    return {
      id: 'config',
      title: 'Proxy and DNS configuration',
      status: 'skip',
      detail: 'System VPN mode: noleaker sets no proxy. Check DNS leaks in the VPN app.',
    };
  const proxy = await readProxyControl();
  const result = analyzeProxyConfig(proxy.mode, proxy.pac, proxy.levelOfControl);
  if (result.status !== 'pass') return result;
  if (!proxy.mandatory)
    return {
      ...result,
      status: 'fail',
      detail: 'PAC is not mandatory; invalid PAC may allow direct fallback.',
    };
  const prediction = await chrome.privacy.network.networkPredictionEnabled.get({});
  if (prediction.value !== false || prediction.levelOfControl !== 'controlled_by_this_extension')
    return {
      ...result,
      status: 'fail',
      detail: 'Network prediction is not disabled and controlled by noleaker.',
    };
  return {
    ...result,
    detail:
      'Mandatory SOCKS5 PAC and disabled network prediction verified. Configuration only; DNS traffic was not measured.',
  };
}

/**
 * Runs inside a web page (MAIN world); must not reference anything outside itself. Gathers ICE
 * candidates the way a site would.
 */
async function gatherInPage(): Promise<string[]> {
  const candidates: string[] = [];
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.createDataChannel('probe');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    pc.onicecandidate = (e) => {
      if (e.candidate) candidates.push(e.candidate.candidate);
      else {
        clearTimeout(timer);
        resolve();
      }
    };
    void pc.createOffer().then((o) => pc.setLocalDescription(o));
  });
  pc.close();
  return candidates;
}

/**
 * A captcha host is a page where noleaker changes nothing (see `isCaptchaPage`), so a probe there
 * measures Chrome's own WebRTC policy. It must not run in this extension page: Chrome does not
 * apply the policy to extension pages, which would make the check fail on a protected browser.
 */
const WEBRTC_PROBE_PAGE = 'https://challenges.cloudflare.com/cdn-cgi/trace';

async function gatherCandidates(): Promise<string[]> {
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: WEBRTC_PROBE_PAGE, active: false });
    tabId = tab.id!;
    await waitForTab(tabId);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: gatherInPage,
    });
    if (!Array.isArray(result?.result)) throw new Error('The probe page returned nothing.');
    return result.result as string[];
  } finally {
    if (tabId !== undefined) void chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

async function checkWebRtc(state: State): Promise<CheckResult> {
  if (state.routingMode !== 'strict' && !state.shields.webrtc) {
    return {
      id: 'webrtc',
      title: 'WebRTC',
      status: 'fail',
      detail: 'The WebRTC shield is off, so WebRTC can expose your real IP.',
      fix: { text: 'Turn on the WebRTC shield in the options.', page: 'options' },
    };
  }
  const { value, levelOfControl } = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
  let candidates: string[];
  try {
    candidates = await gatherCandidates();
  } catch (e) {
    // The policy itself can still be judged; only the live probe is missing.
    const policy = analyzeWebRtc(value, levelOfControl, []);
    return policy.status === 'pass'
      ? {
          ...policy,
          status: 'skip',
          detail: `Policy is ${value}, but the live probe could not run (${e instanceof Error ? e.message : 'unknown error'}).`,
        }
      : policy;
  }
  const result = analyzeWebRtc(value, levelOfControl, candidates);
  if (state.routingMode === 'strict' && result.status === 'pass')
    result.detail +=
      ' Strict-mode page relay restriction also applies; this is not an independent native-realm or TURN traffic test.';
  return result;
}

async function checkQuic(): Promise<CheckResult> {
  const base = { id: 'quic', title: 'QUIC / HTTP3 fallback' };
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (!rules.some((r) => r.id === 1)) {
    return {
      ...base,
      status: 'fail',
      detail: 'The rule that strips Alt-Svc (to prevent HTTP/3 upgrades) is missing.',
      fix: { text: 'Turn the proxy off and on again.', page: 'popup' },
    };
  }
  const url = `${TRACE_URL}?q=${Date.now()}`;
  try {
    await (await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })).text();
  } catch {
    return { ...base, status: 'skip', detail: 'Could not make a test request.' };
  }
  const entry = performance.getEntriesByName(url).at(-1) as PerformanceResourceTiming | undefined;
  const protocol = entry?.nextHopProtocol ?? '';
  if (protocol === 'h3' || protocol.startsWith('h3-') || protocol === 'quic') {
    return {
      ...base,
      status: 'fail',
      detail: `A request used ${protocol}.`,
      fix: { text: 'Turn the proxy off and on again, then re-run the test.', page: 'popup' },
    };
  }
  if (!protocol)
    return {
      ...base,
      status: 'skip',
      detail:
        'Alt-Svc rule installed; protocol measurement is unavailable. QUIC protection is inconclusive.',
    };
  return {
    ...base,
    status: 'pass',
    detail: `Alt-Svc is stripped; the test request used ${protocol || 'TCP (protocol hidden)'}.`,
  };
}

/** The network rules the plan needs are installed, and no exclusion list had to be cut. */
async function checkRules(state: State): Promise<CheckResult> {
  const base = { id: 'rules', title: 'Network rules installed' };
  const plan = protectionPlan(state);
  const expected = [
    plan.altSvc && 1,
    plan.acceptLanguage && 2,
    plan.headers && 3,
    !plan.strict && (plan.acceptLanguage || plan.headers) && 4,
  ].filter((id): id is number => typeof id === 'number');
  const installed = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  const missing = expected.filter((id) => !installed.includes(id));
  const status = (await chrome.storage.local.get(RULES_STATUS_KEY))[RULES_STATUS_KEY] as
    RulesStatus | undefined;
  const problem = rulesProblem(status);

  if (missing.length > 0 || problem?.level === 'bad') {
    return {
      ...base,
      status: 'fail',
      detail:
        problem?.reason ??
        `Expected network rules are missing (ids ${missing.join(', ')}), so Alt-Svc, language or header changes are not applied.`,
      fix: {
        text: 'Turn the proxy off and on again. If it persists, shorten the whitelist and extra direct domains, or turn off Privacy headers.',
        page: 'options',
      },
    };
  }
  if (problem) {
    return {
      ...base,
      status: 'warn',
      detail: problem.reason,
      fix: {
        text: 'Shorten the whitelist or extra direct domains, or turn off Privacy headers.',
        page: 'options',
      },
    };
  }
  return {
    ...base,
    status: 'pass',
    detail: `${expected.length} rule${expected.length === 1 ? '' : 's'} installed (Alt-Svc strip${plan.acceptLanguage ? ', language' : ''}${plan.headers ? ', privacy headers' : ''}).`,
  };
}

/** Firefox: private windows bypass noleaker without access; RFP replaces the fingerprint shields. */
async function checkBrowserEnv(): Promise<CheckResult[]> {
  const privateAccess = await chrome.extension.isAllowedIncognitoAccess();
  await setEnv({ privateAccess });
  const env = await getEnv();
  return [
    privateAccess
      ? {
          id: 'private',
          title: 'Private windows',
          status: 'pass',
          detail: 'noleaker runs in private windows too.',
        }
      : {
          id: 'private',
          title: 'Private windows',
          status: 'warn',
          detail: PRIVATE_WARNING,
          fix: { text: 'about:addons → noleaker → Run in Private Windows → Allow.' },
        },
    {
      id: 'rfp',
      title: 'Firefox resistFingerprinting',
      status: env.rfp ? 'warn' : 'skip',
      detail: env.rfp
        ? RFP_NOTE
        : 'Off. noleaker fingerprint shields apply as set in Options. (Fingerprinting Protection, FPP, cannot be read by extensions; with it on, canvas and audio noise may stack.)',
    },
  ];
}

function checkKillSwitch(state: State): CheckResult {
  const base = { id: 'killswitch', title: 'Kill switch' };
  return state.killSwitchActive
    ? {
        ...base,
        status: 'fail',
        detail:
          'The kill switch is active. Compatibility direct exceptions may still connect; traffic blocking was not measured here.',
        fix: {
          text: 'Start your SOCKS5 server. Browsing recovers by itself within a minute.',
          page: 'options',
        },
      }
    : {
        ...base,
        status: 'skip',
        detail:
          'Kill-switch state is idle. Failure prevention requires a controlled proxy-outage traffic test; it was not measured here.',
      };
}

async function waitForTab(tabId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Test page did not load in time.'));
    }, 20_000);
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs
      .get(tabId)
      .then((t) => t.status === 'complete' && listener(tabId, { status: 'complete' }));
  });
}

/** Runs inside the test page (MAIN world); must not reference anything outside itself. */
async function collectInPage() {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const now = Date.now();
  let workerTz: string | null;
  try {
    const url = URL.createObjectURL(
      new Blob(['postMessage(Intl.DateTimeFormat().resolvedOptions().timeZone)'], {
        type: 'text/javascript',
      }),
    );
    const worker = new Worker(url);
    workerTz = await new Promise<string | null>((resolve) => {
      worker.onmessage = (e) => resolve(String(e.data));
      worker.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 3000);
    });
    worker.terminate();
    URL.revokeObjectURL(url);
  } catch {
    workerTz = null;
  }
  let iceTransportPolicy: string | null;
  try {
    const pc = new RTCPeerConnection();
    iceTransportPolicy = pc.getConfiguration().iceTransportPolicy ?? null;
    pc.close();
  } catch {
    iceTransportPolicy = null;
  }
  return {
    now,
    tz: resolved.timeZone,
    locale: resolved.locale,
    offset: new Date(now).getTimezoneOffset(),
    dateString: new Date(now).toString(),
    language: navigator.language,
    languages: [...navigator.languages],
    workerTz,
    iceTransportPolicy,
  };
}

/** Open a real page in a background tab so the content scripts run, and look at what it sees. */
async function checkPage(state: State): Promise<CheckResult[]> {
  const ids = ['timezone', 'language', 'worker', 'webrtcApi'];
  const skip = (detail: string, status: 'skip' | 'fail' = 'skip'): CheckResult[] =>
    ROWS.filter((r) => ids.includes(r.id)).map((r) => ({
      id: r.id,
      title: r.title,
      status,
      detail,
    }));

  const exit = effectiveExit(state);
  if (!buildSpoofConfig(state).active || !exit?.timezone) {
    return skip('Spoofing is paused (proxy off, unreachable, or exit unknown).');
  }
  if (hostMatches('cloudflare.com', state.whitelist)) {
    return skip('The test page (cloudflare.com) is on your whitelist.');
  }

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: TEST_PAGE, active: false });
    tabId = tab.id!;
    await waitForTab(tabId);
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: collectInPage,
    });
    const off = (id: string, detail: string): CheckResult => ({
      id,
      title: ROWS.find((r) => r.id === id)?.title ?? id,
      status: 'skip',
      detail,
    });
    return analyzePageSample(
      result?.result as PageSample,
      exit.timezone,
      buildSpoofConfig(state),
    ).map((r) =>
      r.id === 'timezone' && !state.shields.timezone
        ? off(r.id, 'The timezone shield is off.')
        : r.id === 'language' && !state.shields.locale
          ? off(r.id, 'The language shield is off.')
          : r.id === 'worker' && !(state.shields.workers && state.shields.timezone)
            ? off(r.id, 'The workers or timezone shield is off.')
            : r.id === 'webrtcApi' && state.routingMode !== 'strict' && !state.shields.webrtc
              ? off(r.id, 'The WebRTC shield is off.')
              : r,
    );
  } catch (e) {
    return skip(e instanceof Error ? e.message : 'Could not run the page test.', 'fail');
  } finally {
    if (tabId !== undefined) void chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

/** Run every check; `onResult` fires as each one finishes. */
export async function runAll(state: State, onResult: (r: CheckResult) => void): Promise<void> {
  const guard = (id: string, title: string, task: () => Promise<CheckResult>) =>
    task()
      .catch((e): CheckResult => ({
        id,
        title,
        status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
      }))
      .then(onResult);

  onResult(checkKillSwitch(state));
  if (__BROWSER__ === 'firefox') (await checkBrowserEnv()).forEach(onResult);
  await Promise.all([
    guard('ip', 'Public IP matches the exit', () => checkIp(state)),
    guard('config', 'Proxy and DNS configuration', () => checkConfig(state)),
    guard('webrtc', 'WebRTC', () => checkWebRtc(state)),
    guard('rules', 'Network rules installed', () => checkRules(state)),
    guard('quic', 'QUIC / HTTP3 fallback', checkQuic),
    checkPage(state).then((rs) => rs.forEach(onResult)),
  ]);
}
