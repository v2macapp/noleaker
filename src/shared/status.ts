import { effectiveExit } from './exit';
import { checkOverrides } from './override-check';
import { connected } from './profiles';
import { rulesProblem, type RulesStatus } from './rules-status';
import type { State } from './types';

export type Level = 'off' | 'ok' | 'warn' | 'bad';

export interface Summary {
  level: Level;
  /** Short text for the status pill. */
  label: string;
  /** Why, for warn/bad. Empty when there is nothing to say. */
  reason: string;
}

/** One-glance status for the popup, from stored state only (the leak test does the deep checks). */
export function summarize(state: State, rules?: RulesStatus): Summary {
  if (!state.enabled) return { level: 'off', label: 'Off', reason: '' };
  const system = state.connection === 'system';
  if (!connected(state)) {
    return { level: 'bad', label: 'No proxy', reason: 'Add a SOCKS5 proxy in the options first.' };
  }
  if (state.killSwitchActive) {
    return {
      level: 'bad',
      label: 'Blocked',
      reason: system
        ? 'Exit check failed (no network?). Spoofing is paused until it recovers.'
        : state.routingMode === 'strict'
          ? 'Proxy unreachable. New browsing requests are blocked until it recovers.'
          : 'Proxy unreachable. Proxied destinations are blocked; compatibility direct exceptions remain direct.',
    };
  }
  if (state.protectionError)
    return { level: 'bad', label: 'Protection failed', reason: state.protectionError };
  if (!state.controlsVerifiedAt || Date.now() - state.controlsVerifiedAt > 150_000)
    return {
      level: 'warn',
      label: 'Unverified',
      reason: 'Browser protection controls have not been verified recently.',
    };
  if (state.routingMode === 'compatibility' && !state.shields.webrtc)
    return {
      level: 'bad',
      label: 'WebRTC exposed',
      reason: 'WebRTC protection is off and may reveal your real IP.',
    };
  const problem = rulesProblem(rules);
  if (problem?.level === 'bad') return { level: 'bad', label: 'Rules', reason: problem.reason };
  const exit = effectiveExit(state);
  if (!exit) return { level: 'warn', label: 'Checking', reason: 'Detecting the exit location…' };
  if (!exit.timezone) {
    return {
      level: 'warn',
      label: 'Partial',
      reason: 'Exit timezone is unknown, so spoofing is paused.',
    };
  }
  if (exit.overridden) {
    return {
      level: 'warn',
      label: 'Override',
      reason: 'Manual country: the timezone is a country default, not the exit’s own.',
    };
  }
  const overrideWarnings = checkOverrides(state);
  if (overrideWarnings.length > 0) {
    const more = overrideWarnings.length > 1 ? ` (+${overrideWarnings.length - 1} more)` : '';
    return { level: 'warn', label: 'Override', reason: overrideWarnings[0]!.message + more };
  }
  if (problem) return { level: 'warn', label: 'Rules', reason: problem.reason };
  if (system)
    return {
      level: 'ok',
      label: 'VPN exit',
      reason:
        'Spoofing follows the system VPN exit. noleaker cannot block traffic if the VPN drops.',
    };
  return {
    level: state.routingMode === 'compatibility' ? 'warn' : 'ok',
    label: 'Proxy verified',
    reason:
      state.routingMode === 'compatibility'
        ? 'Compatibility mode allows direct exceptions and native captcha values.'
        : 'Browser controls verified. Startup, worker and identity limitations still apply.',
  };
}
