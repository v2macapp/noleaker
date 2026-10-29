import { activeProfile } from './profiles';
import type { State } from './types';

/** What the page needs for the optional fingerprint spoofing. Values are stable per proxy profile. */
export interface FingerprintConfig {
  /** Per-profile seed (the proxy profile id). */
  seed: string;
  /**
   * Seed for the noise shields (canvas, audio, layout): the profile seed plus the registrable
   * domain, so a hash cannot link your visits across sites. The bridge fills in the site part.
   */
  siteSeed: string;
  canvasNoise: boolean;
  audioNoise: boolean;
  rectNoise: boolean;
  webglSpoof: boolean;
  screenSpoof: boolean;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
}

export const CORE_COUNTS = [4, 6, 8, 12, 16] as const;
export const MEMORY_SIZES = [4, 8] as const;
export const SCREEN_SIZES = [
  [1920, 1080],
  [2560, 1440],
  [1366, 768],
  [1536, 864],
  [1440, 900],
  [1680, 1050],
  [2560, 1600],
] as const;

/** FNV-1a, 32 bit. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Deterministic pick: the same seed and salt always give the same entry. */
export function pick<T>(pool: readonly T[], seed: string, salt: string): T {
  return pool[hashString(`${salt}:${seed}`) % pool.length]!;
}

export const NO_FINGERPRINT: FingerprintConfig = {
  seed: '',
  siteSeed: '',
  canvasNoise: false,
  audioNoise: false,
  rectNoise: false,
  webglSpoof: false,
  screenSpoof: false,
  hardwareConcurrency: null,
  deviceMemory: null,
};

export function buildFingerprintConfig(state: State): FingerprintConfig {
  const seed = state.connection === 'system' ? 'system' : activeProfile(state)?.id;
  if (!seed) return NO_FINGERPRINT;
  const a = state.shields;
  return {
    seed,
    siteSeed: seed,
    canvasNoise: a.canvas,
    audioNoise: a.audio,
    rectNoise: a.clientRects,
    webglSpoof: a.webgl,
    screenSpoof: a.screen,
    hardwareConcurrency: a.hardwareConcurrency ? pick(CORE_COUNTS, seed, 'cores') : null,
    deviceMemory: a.deviceMemory ? pick(MEMORY_SIZES, seed, 'memory') : null,
  };
}
