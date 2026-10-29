import { describe, expect, it } from 'vitest';
import { iconView } from '../src/shared/badge';
import { protectionPlan } from '../src/shared/plan';
import { exportSettings, parseSettings } from '../src/shared/settings';
import { DEFAULT_STATE, migrateState } from '../src/shared/storage';
import { summarize } from '../src/shared/status';
import type { State } from '../src/shared/types';

const system: State = {
  ...DEFAULT_STATE,
  connection: 'system',
  enabled: true,
  controlsVerifiedAt: Date.now(),
  detectedExit: { ip: '1.2.3.4', countryCode: 'US', timezone: 'America/New_York', detectedAt: 0 },
};

describe('system VPN/TUN mode', () => {
  it('spoofs to the detected exit without a proxy profile', () => {
    const plan = protectionPlan(system);
    expect(plan.proxyOn).toBe(false);
    expect(plan.on).toBe(true);
    expect(plan.webrtc).toBe(true);
    expect(plan.config.active).toBe(true);
    expect(plan.config.timezone).toBe('America/New_York');
    expect(plan.config.fingerprint.seed).toBe('system');
  });

  it('pauses spoofing when the exit check fails', () => {
    expect(protectionPlan({ ...system, killSwitchActive: true }).config.active).toBe(false);
    expect(summarize({ ...system, killSwitchActive: true }).label).toBe('Paused');
  });

  it('reports the VPN exit in the popup and badge', () => {
    expect(summarize(system).label).toBe('VPN exit');
    expect(iconView(system).badge).toBe('US');
  });

  it('stays on without a profile through migration and import', () => {
    expect(migrateState(system).enabled).toBe(true);
    expect(migrateState({ ...system, connection: 'bogus' }).connection).toBe('proxy');
    const parsed = parseSettings(exportSettings(system));
    expect(parsed.ok && parsed.patch.connection).toBe('system');
    expect(parsed.ok && 'enabled' in parsed.patch).toBe(false);
  });
});
