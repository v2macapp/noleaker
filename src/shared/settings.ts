import { parseDomainLines } from './domains';
import { sanitizeOverrides } from './overrides';
import { normalizeShields } from './shields';
import type { ProxyProfile, State } from './types';
import { validateCredentials, validateProfile } from './validate';

const FORMAT = 'noleaker-settings';
/**
 * 2: `shields` replaced `advanced`. 3: `overrides` and `localeMode`. 4: `stealth`. 5: `flowUnlock`.
 * 6: `autoExitCheck`. 7: routing mode and list updates. 8: `flowUnlock` dropped (now the separate
 * noleaker-flow extension); it is ignored in older files. `connection` is optional (missing means proxy). Older files are still read.
 */
const VERSION = 8;

type Settings = Pick<
  State,
  | 'routingMode'
  | 'connection'
  | 'listUpdates'
  | 'profiles'
  | 'activeProfileId'
  | 'countryOverride'
  | 'extraDirectDomains'
  | 'whitelist'
  | 'shields'
  | 'overrides'
  | 'localeMode'
  | 'stealth'
  | 'autoExitCheck'
>;

/** Only user configuration is exported; runtime state (on/off, exit, kill switch) is not. */
export function exportSettings(state: State): string {
  const settings: Settings = {
    routingMode: state.routingMode,
    connection: state.connection,
    listUpdates: state.listUpdates,
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
    countryOverride: state.countryOverride,
    extraDirectDomains: state.extraDirectDomains,
    whitelist: state.whitelist,
    shields: state.shields,
    overrides: state.overrides,
    localeMode: state.localeMode,
    stealth: state.stealth,
    autoExitCheck: state.autoExitCheck,
  };
  return JSON.stringify({ format: FORMAT, version: VERSION, ...settings }, null, 2);
}

export type ImportResult = { ok: true; patch: Partial<State> } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate an exported file. Anything malformed is rejected; nothing is half-applied. */
export function parseSettings(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not a valid JSON file.' };
  }
  if (!isRecord(data) || data.format !== FORMAT) {
    return { ok: false, error: 'This is not a noleaker settings file.' };
  }
  if (![1, 2, 3, 4, 5, 6, 7, VERSION].includes(data.version as number))
    return { ok: false, error: 'Unsupported settings version.' };

  const profiles: ProxyProfile[] = [];
  if (!Array.isArray(data.profiles)) return { ok: false, error: 'Missing proxy list.' };
  for (const p of data.profiles) {
    if (!isRecord(p) || typeof p.id !== 'string' || typeof p.name !== 'string') {
      return { ok: false, error: 'A proxy entry is malformed.' };
    }
    const host = String(p.host ?? '').trim();
    const port = Number(p.port);
    const error = validateProfile(p.name, host, port);
    if (error) return { ok: false, error: `Proxy "${p.name}": ${error}` };
    if (profiles.some((x) => x.id === p.id)) return { ok: false, error: 'Duplicate proxy id.' };
    const credentials =
      typeof p.username === 'string' && p.username
        ? {
            username: p.username,
            password: typeof p.password === 'string' ? p.password : '',
          }
        : {};
    const authError =
      credentials.username !== undefined &&
      validateCredentials(credentials.username, credentials.password);
    if (authError) return { ok: false, error: `Proxy "${p.name}": ${authError}` };
    profiles.push({ id: p.id, name: p.name.trim(), host, port, ...credentials });
  }

  const domains = (v: unknown) =>
    parseDomainLines(Array.isArray(v) ? v.filter((x) => typeof x === 'string').join('\n') : '')
      .domains;
  // v1 files carry the five fingerprint switches as `advanced`; v2 files carry all `shields`.
  const adv = isRecord(data.advanced) ? data.advanced : {};
  const shields = normalizeShields(
    isRecord(data.shields)
      ? data.shields
      : {
          canvas: adv.canvasNoise,
          webgl: adv.webglSpoof,
          screen: adv.screenSpoof,
          hardwareConcurrency: adv.hardwareConcurrency ?? adv.hardwareSpoof,
          deviceMemory: adv.deviceMemory ?? adv.hardwareSpoof,
        },
  );

  const activeId =
    typeof data.activeProfileId === 'string' && profiles.some((p) => p.id === data.activeProfileId)
      ? data.activeProfileId
      : (profiles[0]?.id ?? null);

  return {
    ok: true,
    patch: {
      routingMode: data.routingMode === 'strict' ? 'strict' : 'compatibility',
      connection: data.connection === 'system' ? 'system' : 'proxy',
      listUpdates: data.listUpdates === true,
      protectionError: null,
      controlsVerifiedAt: null,
      profiles,
      activeProfileId: activeId,
      countryOverride:
        typeof data.countryOverride === 'string' && /^[A-Z]{2}$/.test(data.countryOverride)
          ? data.countryOverride
          : null,
      extraDirectDomains: domains(data.extraDirectDomains),
      whitelist: domains(data.whitelist),
      shields,
      overrides: sanitizeOverrides(data.overrides),
      localeMode: data.localeMode === 'country' ? 'country' : 'english',
      stealth: data.stealth === true,
      autoExitCheck: data.autoExitCheck !== false,
      // The proxy cannot stay on without a profile.
      ...(activeId || data.connection === 'system' ? {} : { enabled: false }),
    },
  };
}
