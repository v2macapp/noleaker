import { describeExitChange, shouldStoreExit, type ExitRefresh } from '../shared/exit';
import { activeProfile } from '../shared/profiles';
import { detectExit } from '../shared/lookup';
import { directLookup, route } from '../shared/route';
import { log } from '../shared/log';
import { getState, persistMigration, setState } from '../shared/storage';
import type { State } from '../shared/types';
import { removeLegacyFlow } from './legacy';
import { syncProtection } from './protection';
import { scheduleUpdates } from './iranlist';
import { setGuard } from '@platform/guard';
import { forgetAppliedPac, syncProxy } from '@platform/proxy';

const ALARM = 'health-check';
const CHECK_MINUTES = 1;
const ERROR_RECHECK_MS = 10_000;
const KEY = 'checkKey';

let lastCheckAt = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Serialise all work so proxy updates and checks never overlap. */
function enqueue(task: () => Promise<void>): void {
  chain = chain.then(task).catch(async (e) => {
    log('error', 'Background task failed', e);
    const state = await getState();
    if (state.enabled)
      await setGuard(true).catch((error) => log('error', 'Request guard failed', error));
    const protectionError = e instanceof Error ? e.message : String(e);
    if (state.protectionError !== protectionError || state.controlsVerifiedAt !== null)
      await setState({ protectionError, controlsVerifiedAt: null });
  });
}

/** Changes whenever the proxy configuration that detection depends on changes. */
function configKey(state: State): string {
  if (state.enabled && state.connection === 'system') return 'system';
  const p = activeProfile(state);
  return state.enabled && p ? `${p.username ?? ''}@${p.host}:${p.port}` : 'off';
}

/** "FR 1.2.3.4" for the log. */
const label = (e: { ip: string; countryCode: string }) => `${e.countryCode} ${e.ip}`;

/**
 * Detect the exit through the proxy; on failure engage the kill switch, on success release it.
 * The exit it finds is stored when `shouldStoreExit` says so (always for a manual refresh).
 */
async function runCheck(force = false): Promise<ExitRefresh> {
  const before = await getState();
  if (configKey(before) === 'off') return { ok: false, changed: false, error: 'The proxy is off.' };
  lastCheckAt = Date.now();
  await syncProxy();
  await syncProtection();
  // Proxy mode: a lookup host on the direct list would report the real IP, so it is skipped.
  const direct = directLookup({}, before.extraDirectDomains);
  const strict = before.routingMode === 'strict';
  const exit = await detectExit((host) =>
    before.connection === 'system'
      ? true
      : route(host, { blocking: false, strict, direct }) === 'proxy',
  );
  const now = await getState();
  if (configKey(now) !== configKey(before)) {
    // config changed mid-check; a new check follows
    return { ok: false, changed: false, error: 'The proxy was changed during the check.' };
  }
  if (!exit) {
    if (!now.killSwitchActive) log('warn', 'Proxy unreachable; kill switch engaged');
    await setState({ killSwitchActive: true });
    await syncProxy();
    await syncProtection();
    return {
      ok: false,
      changed: false,
      error: now.connection === 'system' ? 'The exit check failed.' : 'The proxy is unreachable.',
    };
  }

  if (now.killSwitchActive) log('info', 'Proxy recovered; kill switch released');
  if (exit.uncertain && !now.detectedExit?.uncertain)
    log(
      'warn',
      'Exit uncertain: Cloudflare and ipwho.is saw different IPs, so one went around the tunnel',
    );
  const found = { ip: exit.ip, countryCode: exit.countryCode };
  const previous = now.detectedExit
    ? { ip: now.detectedExit.ip, countryCode: now.detectedExit.countryCode }
    : undefined;
  const change = describeExitChange(previous ?? null, found);
  // System mode: a new exit means the VPN dropped or moved, so the identity must follow it.
  const store = shouldStoreExit(now, force || now.connection === 'system');
  if (store) {
    if (change === 'country') {
      log('info', `Exit country changed: ${label(previous!)} -> ${label(found)}`);
    } else if (change === 'ip') {
      log('info', `Exit IP changed: ${previous!.ip} -> ${found.ip}`);
    } else if (change === 'first') {
      log('info', `Exit detected: ${label(found)}, ${exit.timezone || 'no timezone'}`);
    }
    await setState({ detectedExit: exit, killSwitchActive: false });
  } else {
    await setState({ killSwitchActive: false });
    if (change === 'country' || change === 'ip') {
      log(
        'info',
        `Exit differs from the stored one (${label(found)}); not following (auto-check off)`,
      );
    }
  }
  await syncProxy();
  await syncProtection();
  await markVerified();
  return {
    ok: true,
    changed: store && (change === 'country' || change === 'ip'),
    exit: found,
    ...(previous ? { previous } : {}),
  };
}

/** Check the exit right now (the popup's refresh button). Waits its turn behind other work. */
export function refreshExitNow(): Promise<ExitRefresh> {
  return new Promise((resolve) => {
    enqueue(async () => {
      try {
        resolve(await runCheck(true));
      } catch (e) {
        resolve({ ok: false, changed: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    });
  });
}

async function markVerified(): Promise<void> {
  const state = await getState();
  if (!state.enabled) {
    if (state.protectionError || state.controlsVerifiedAt)
      await setState({ protectionError: null, controlsVerifiedAt: null });
    return;
  }
  // Avoid a storage-change synchronization loop; health checks refresh before expiry.
  if (
    state.protectionError ||
    !state.controlsVerifiedAt ||
    Date.now() - state.controlsVerifiedAt > 60_000
  )
    await setState({ protectionError: null, controlsVerifiedAt: Date.now() });
}

async function handleChange(): Promise<void> {
  const key = configKey(await getState());
  const prev = (await chrome.storage.session.get(KEY))[KEY];
  if (key !== prev) {
    await setState({
      detectedExit: null,
      killSwitchActive: false,
      controlsVerifiedAt: null,
    });
    await chrome.storage.session.set({ [KEY]: key });
  }
  await syncProxy();
  await syncProtection();
  if (key !== prev && key !== 'off') await runCheck();
  else await markVerified();
}

/** React to lost controls without waiting behind an in-flight health lookup. */
export function onControlLoss(
  reason: string,
  control: 'proxy' | 'prediction' | 'webrtc' = 'proxy',
): void {
  void (async () => {
    const state = await getState();
    if (
      state.enabled &&
      // In system mode noleaker sets no proxy, so a proxy setting change is not a loss.
      !(control === 'proxy' && state.connection === 'system') &&
      !(control === 'webrtc' && state.routingMode === 'compatibility' && !state.shields.webrtc)
    ) {
      if (state.protectionError !== reason || state.controlsVerifiedAt !== null)
        await setState({ protectionError: reason, controlsVerifiedAt: null });
      await setGuard(true);
    }
    onConfigChange();
  })().catch((e) => log('error', 'Could not guard lost browser control', e));
}

export function onConfigChange(): void {
  enqueue(handleChange);
}

/** Create the periodic alarms if missing. Safe to call on every service worker start. */
export function ensureAlarms(): void {
  scheduleUpdates();
  void chrome.alarms.get(ALARM).then((a) => {
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: CHECK_MINUTES });
  });
}

export function onStartup(): void {
  enqueue(async () => {
    if (await persistMigration()) log('info', 'Migrated stored settings');
    await removeLegacyFlow();
    await setState({ controlsVerifiedAt: null });
    await chrome.storage.session.remove(KEY); // force a fresh detection
    await forgetAppliedPac();
    await handleChange();
  });
  ensureAlarms();
}

export function onAlarm(alarm: chrome.alarms.Alarm): void {
  if (alarm.name === ALARM) enqueue(async () => void (await runCheck()));
}

/** Proxy errors trigger an early re-check (rate limited) instead of waiting for the timer. */
export function onProxyError(details: { error: string; fatal?: boolean }): void {
  log('warn', `Proxy error: ${details.error}${details.fatal ? ' (fatal)' : ''}`);
  if (Date.now() - lastCheckAt < ERROR_RECHECK_MS) return;
  lastCheckAt = Date.now(); // one queued check per burst of errors
  enqueue(async () => void (await runCheck()));
}
