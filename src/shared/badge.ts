import { COUNTRIES } from './countries';
import { connected } from './profiles';
import type { State } from './types';

export type IconStatus = 'off' | 'on' | 'error';

/** What the toolbar icon shows: its colour, the badge next to it and the hover title. */
export interface IconView {
  status: IconStatus;
  /** Badge text; empty means no badge. Chrome shows about four characters. */
  badge: string;
  badgeColor: string;
  title: string;
}

export const BADGE_COLORS = { ok: '#1f9d55', wait: '#c98a12', bad: '#d64545' } as const;

/**
 * The toolbar icon for a state. While the proxy is on, the badge is the country code of the exit
 * the browser is connected to (the detected one, not a manual spoof override).
 */
export function iconView(state: State): IconView {
  if (!state.enabled) {
    return { status: 'off', badge: '', badgeColor: BADGE_COLORS.ok, title: 'noleaker: off' };
  }
  if (!connected(state)) {
    return {
      status: 'error',
      badge: '!',
      badgeColor: BADGE_COLORS.bad,
      title: 'noleaker: no proxy selected, browsing is blocked',
    };
  }
  if (state.protectionError)
    return {
      status: 'error',
      badge: '!',
      badgeColor: BADGE_COLORS.bad,
      title: `noleaker: protection failed: ${state.protectionError}`,
    };
  if (state.killSwitchActive) {
    return {
      status: 'error',
      badge: '!',
      badgeColor: BADGE_COLORS.bad,
      title:
        state.connection === 'system'
          ? 'noleaker: exit check failed, spoofing is paused'
          : state.routingMode === 'strict'
            ? 'noleaker: proxy unreachable, new browsing requests are blocked until it recovers'
            : 'noleaker: proxy unreachable, proxied requests are blocked; direct exceptions remain',
    };
  }
  if (!state.controlsVerifiedAt || Date.now() - state.controlsVerifiedAt > 150_000) {
    return {
      status: 'on',
      badge: '…',
      badgeColor: BADGE_COLORS.wait,
      title: 'noleaker: browser controls have not been recently verified',
    };
  }
  const exit = state.detectedExit;
  if (!exit) {
    return {
      status: 'on',
      badge: '…',
      badgeColor: BADGE_COLORS.wait,
      title: 'noleaker: on, detecting the exit country…',
    };
  }
  const code = exit.countryCode.toUpperCase();
  const name = COUNTRIES[code]?.name;
  const where = name ? `${name} (${code})` : code;
  const spoofed =
    state.countryOverride && state.countryOverride !== code
      ? `, identity set to ${COUNTRIES[state.countryOverride]?.name ?? state.countryOverride}`
      : '';
  return {
    status: 'on',
    badge: code,
    badgeColor: BADGE_COLORS.ok,
    title: `noleaker: connected through ${where} · ${exit.ip}${spoofed}`,
  };
}
