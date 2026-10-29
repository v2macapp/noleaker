import { connected, usesProxy } from './profiles';
import { buildSpoofConfig } from './spoof-config';
import type { State } from './types';

/** What leak protection should be installed for a state. Pure, so it can be unit tested. */
export function protectionPlan(state: State) {
  const proxyOn = usesProxy(state);
  /** Proxy or system VPN: WebRTC, prediction and Alt-Svc protection apply to both. */
  const on = connected(state);
  const config = buildSpoofConfig(state);
  return {
    proxyOn,
    on,
    strict: state.routingMode === 'strict',
    /** WebRTC policy follows the WebRTC shield. */
    webrtc: on && (state.routingMode === 'strict' || state.shields.webrtc),
    /** Alt-Svc stripping is not a shield: it is part of keeping traffic on the proxy. */
    altSvc: on,
    /** Accept-Language follows the locale shield. */
    acceptLanguage: config.active && state.shields.locale,
    /** DNT, Sec-GPC and If-None-Match follow the headers shield. */
    headers: config.active && state.shields.headers,
    config,
  };
}

export type ProtectionPlan = ReturnType<typeof protectionPlan>;
