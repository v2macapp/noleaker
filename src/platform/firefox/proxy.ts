import { BADGE_COLORS, iconView, type IconView } from '../../shared/badge';
import { getEnv, PRIVATE_WARNING, type BrowserEnv } from '../../shared/browser-env';
import type { State } from '../../shared/types';
import { activeProfile, usesProxy } from '../../shared/profiles';
import { directLookup, NO_DIRECT, type DirectLookup } from '../../shared/route';
import { getState } from '../../shared/storage';
import { setStatusIcon } from '../../background/icons';
import { loadIranGroups, META_KEY } from '../../background/iranlist';
import { forgetAppliedRules } from '../../background/protection';
import { GUARD_KEY } from './guard';
import { setRouting } from './routing';

// The direct-domain lookup is rebuilt only when the list or the routing mode changes.
let lookupKey = '';
let lookup: DirectLookup = NO_DIRECT;

export async function forgetAppliedPac(): Promise<void> {
  lookupKey = '';
  await forgetAppliedRules();
}

/**
 * Make the proxy.onRequest routing table and the toolbar icon match the stored state. Until the
 * controls are verified (and after any failure) the transition guard stays on; syncProtection
 * releases it.
 */
export async function syncProxy(): Promise<void> {
  const state = await getState();
  const profile = activeProfile(state);

  if (!usesProxy(state) || !profile) {
    setRouting({ enabled: false, profile: null, guarded: false, blocking: false });
    await chrome.storage.session.set({ [GUARD_KEY]: false });
    await setStatusIcon(iconView(state));
    return;
  }

  const strict = state.routingMode === 'strict';
  if (strict) lookup = NO_DIRECT;
  else {
    const meta = (await chrome.storage.local.get(META_KEY))[META_KEY] as
      { updatedAt?: number } | undefined;
    const key = JSON.stringify([meta?.updatedAt ?? 0, state.extraDirectDomains]);
    if (key !== lookupKey) {
      lookup = directLookup(await loadIranGroups(), state.extraDirectDomains);
      lookupKey = key;
    }
  }
  const stored = (await chrome.storage.session.get(GUARD_KEY))[GUARD_KEY];
  // No record (fresh browser start) counts as guarded.
  const guarded = stored !== false || state.controlsVerifiedAt === null;
  await chrome.storage.session.set({ [GUARD_KEY]: guarded });
  setRouting({
    enabled: true,
    profile,
    blocking: state.killSwitchActive,
    strict,
    direct: strict ? NO_DIRECT : lookup,
    guarded,
  });
  await setStatusIcon(withPrivateWarning(iconView(state), state, await getEnv()));
}

/** The toolbar icon, with a warning badge while the proxy is on and private windows are not covered. */
export function withPrivateWarning(view: IconView, state: State, env: BrowserEnv): IconView {
  if (!state.enabled || env.privateAccess || view.status !== 'on') return view;
  return {
    ...view,
    badge: 'PW!',
    badgeColor: BADGE_COLORS.wait,
    title: `${view.title}\n${PRIVATE_WARNING}`,
  };
}
