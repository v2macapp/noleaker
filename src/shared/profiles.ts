import type { ProxyProfile, State } from './types';

export function activeProfile(state: State): ProxyProfile | null {
  return state.profiles.find((p) => p.id === state.activeProfileId) ?? null;
}

/** On, with something to route through: the active SOCKS5 profile, or the system VPN/TUN. */
export function connected(state: State): boolean {
  return state.enabled && (state.connection === 'system' || !!activeProfile(state));
}

/** noleaker itself sets the browser proxy (SOCKS5 mode). */
export function usesProxy(state: State): boolean {
  return state.enabled && state.connection === 'proxy' && !!activeProfile(state);
}

export function upsertProfile(state: State, profile: ProxyProfile): Partial<State> {
  const exists = state.profiles.some((p) => p.id === profile.id);
  const profiles = exists
    ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
    : [...state.profiles, profile];
  return { profiles, activeProfileId: state.activeProfileId ?? profile.id };
}

export function removeProfile(state: State, id: string): Partial<State> {
  const profiles = state.profiles.filter((p) => p.id !== id);
  if (state.activeProfileId !== id) return { profiles };
  const next = profiles[0]?.id ?? null;
  return {
    profiles,
    activeProfileId: next,
    enabled: next || state.connection === 'system' ? state.enabled : false,
  };
}
