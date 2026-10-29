/* eslint-disable @typescript-eslint/no-explicit-any */
import { NO_OVERRIDES, sanitizeOverrides } from './overrides';
import { normalizeShields, SHIELD_DEFAULTS } from './shields';
import type { State } from './types';

/**
 * 2: dropped `iranDomains` (own storage key now); split `advanced.hardwareSpoof` in two.
 * 3: `advanced` became `shields`, with a switch per shield.
 * 5: `stealth`.
 * 4: manual `overrides` (timezone, locale, Accept-Language, coordinates) and `localeMode`.
 * 6: `flowUnlock` (default on).
 * 7: `autoExitCheck` (default on).
 * 8: strict/compatibility routing, opt-in list updates, runtime verification.
 * 9: `flowUnlock` removed (the Google Flow unlock is its own extension, noleaker-flow).
 */
export const SCHEMA_VERSION = 9;

export const DEFAULT_STATE: State = {
  schemaVersion: SCHEMA_VERSION,
  routingMode: 'strict',
  connection: 'proxy',
  listUpdates: false,
  protectionError: null,
  controlsVerifiedAt: null,
  profiles: [],
  activeProfileId: null,
  enabled: false,
  killSwitchActive: false,
  detectedExit: null,
  countryOverride: null,
  iranDomainsUpdatedAt: null,
  extraDirectDomains: [],
  whitelist: [],
  shields: SHIELD_DEFAULTS,
  overrides: NO_OVERRIDES,
  localeMode: 'english',
  stealth: false,
  autoExitCheck: true,
};

const KEY = 'state';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ARRAY_FIELDS = ['profiles', 'extraDirectDomains', 'whitelist'] as const;
const BOOLEAN_FIELDS = ['enabled', 'killSwitchActive'] as const;

/**
 * Turn whatever is in storage (older versions, partial writes, hand edits) into a valid State.
 * Pure: it never writes. Newer schema versions are kept as they are.
 */
export function migrateState(raw: unknown): State {
  const stored: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  const version = typeof stored.schemaVersion === 'number' ? stored.schemaVersion : 0;
  const advanced: Record<string, unknown> = isRecord(stored.advanced) ? { ...stored.advanced } : {};

  if (version < 2) {
    delete stored.iranDomains;
    if ('hardwareSpoof' in advanced) {
      const on = advanced.hardwareSpoof === true;
      advanced.hardwareConcurrency ??= on;
      advanced.deviceMemory ??= on;
    }
  }
  delete advanced.hardwareSpoof;

  // v3: `advanced` (5 fingerprint switches) became `shields` (all switches).
  let shields: unknown = stored.shields;
  if (!isRecord(shields)) {
    shields = {
      canvas: advanced.canvasNoise,
      webgl: advanced.webglSpoof,
      screen: advanced.screenSpoof,
      hardwareConcurrency: advanced.hardwareConcurrency,
      deviceMemory: advanced.deviceMemory,
    };
  }
  delete stored.advanced;
  delete stored.flowUnlock; // v9

  const state = {
    ...DEFAULT_STATE,
    ...stored,
    routingMode:
      stored.routingMode === 'strict'
        ? 'strict'
        : stored.routingMode === 'compatibility' || Object.keys(stored).length > 0
          ? 'compatibility'
          : 'strict',
    connection: stored.connection === 'system' ? 'system' : 'proxy',
    listUpdates: stored.listUpdates === true,
    protectionError: typeof stored.protectionError === 'string' ? stored.protectionError : null,
    controlsVerifiedAt:
      typeof stored.controlsVerifiedAt === 'number' ? stored.controlsVerifiedAt : null,
    shields: normalizeShields(shields),
    overrides: sanitizeOverrides(stored.overrides),
    localeMode: stored.localeMode === 'country' ? 'country' : 'english',
    stealth: stored.stealth === true,
    autoExitCheck: stored.autoExitCheck !== false,
    schemaVersion: Math.max(version, SCHEMA_VERSION),
  } as State;

  for (const key of ARRAY_FIELDS) if (!Array.isArray(state[key])) (state as any)[key] = [];
  for (const key of BOOLEAN_FIELDS) if (typeof state[key] !== 'boolean') state[key] = false;
  state.profiles = state.profiles.filter(
    (p) =>
      isRecord(p) &&
      typeof p.id === 'string' &&
      typeof p.host === 'string' &&
      Number.isInteger(p.port),
  );
  // Credentials are kept only as a pair of strings (Firefox hands them to proxy.onRequest).
  state.profiles = state.profiles.map(({ username, password, ...p }) =>
    typeof username === 'string' && username && typeof password === 'string'
      ? { ...p, username, password }
      : p,
  );
  if (!state.profiles.some((p) => p.id === state.activeProfileId)) {
    state.activeProfileId = state.profiles[0]?.id ?? null;
  }
  if (!state.activeProfileId && state.connection !== 'system') state.enabled = false;
  return state;
}

export async function getState(): Promise<State> {
  return migrateState((await chrome.storage.local.get(KEY))[KEY]);
}

/** Write the migrated state back once (service worker start), if storage holds an old shape. */
export async function persistMigration(): Promise<boolean> {
  const raw = (await chrome.storage.local.get(KEY))[KEY];
  if (isRecord(raw) && raw.schemaVersion === SCHEMA_VERSION && !('iranDomains' in raw))
    return false;
  await chrome.storage.local.set({ [KEY]: migrateState(raw) });
  return true;
}

export function setState(patch: Partial<State>): Promise<State> {
  return updateState(() => patch);
}

/** Read-modify-write under a lock shared by popup, options and background, so no write is lost. */
export function updateState(fn: (s: State) => Partial<State>): Promise<State> {
  return navigator.locks.request(KEY, async () => {
    const current = await getState();
    const next = { ...current, ...fn(current) };
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  });
}

/** Subscribe to state changes. Returns an unsubscribe function. */
export function onStateChanged(listener: (state: State) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) void getState().then(listener);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
