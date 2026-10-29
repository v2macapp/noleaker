import { iconView } from '../../shared/badge';
import { generatePac } from './pac';
import { activeProfile, usesProxy } from '../../shared/profiles';
import { getState } from '../../shared/storage';
import { setGuard, setLocalGuard } from './guard';
import { setStatusIcon } from '../../background/icons';
import { loadIranGroups } from '../../background/iranlist';
import { forgetAppliedRules } from '../../background/protection';

const APPLIED_KEY = 'appliedPac';

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Forget what was applied, so the next sync writes the PAC even if it looks unchanged. */
export async function forgetAppliedPac(): Promise<void> {
  await chrome.storage.session.remove(APPLIED_KEY);
  await forgetAppliedRules();
}

/**
 * Make Chrome's proxy settings and the toolbar icon match the stored state.
 * While the kill switch is active the PAC refuses everything except direct hosts and probe hosts.
 */
export async function syncProxy(): Promise<void> {
  const state = await getState();
  const profile = activeProfile(state);

  if (!usesProxy(state) || !profile) {
    await chrome.storage.session.remove(APPLIED_KEY);
    await setGuard(false);
    await setLocalGuard(false);
    const effective = await chrome.proxy.settings.get({ incognito: false });
    if (effective.levelOfControl === 'controlled_by_this_extension')
      await chrome.proxy.settings.clear({ scope: 'regular' });
    await setStatusIcon(iconView(state));
    return;
  }

  const previous = await chrome.proxy.settings.get({ incognito: false });
  if (
    previous.levelOfControl !== 'controlled_by_this_extension' ||
    state.controlsVerifiedAt === null
  )
    await setGuard(true);
  if (
    previous.levelOfControl === 'controlled_by_other_extensions' ||
    previous.levelOfControl === 'not_controllable'
  )
    throw new Error(
      'Chrome proxy settings could not be verified: another extension or policy controls them.',
    );
  const pac = generatePac(profile, {
    blocking: state.killSwitchActive,
    strict: state.routingMode === 'strict',
    iranGroups: state.routingMode === 'strict' ? {} : await loadIranGroups(),
    extraDirect: state.extraDirectDomains,
  });
  // The PAC is large; only hand it to Chrome when it actually changed.
  const digest = await hash(pac);
  const applied = (await chrome.storage.session.get(APPLIED_KEY))[APPLIED_KEY];
  await setLocalGuard(state.routingMode === 'strict');
  const effective = await chrome.proxy.settings.get({ incognito: false });
  if (
    applied !== digest ||
    effective.levelOfControl !== 'controlled_by_this_extension' ||
    effective.value.pacScript?.data !== pac ||
    effective.value.pacScript?.mandatory !== true
  ) {
    await setGuard(true);
    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: pac, mandatory: true } },
      scope: 'regular',
    });
    const verified = await chrome.proxy.settings.get({ incognito: false });
    if (
      verified.levelOfControl !== 'controlled_by_this_extension' ||
      verified.value.mode !== 'pac_script' ||
      verified.value.pacScript?.data !== pac ||
      verified.value.pacScript?.mandatory !== true
    )
      throw new Error('Chrome proxy settings could not be verified.');
    await chrome.storage.session.set({ [APPLIED_KEY]: digest });
  }
  await setStatusIcon(iconView(state));
}
