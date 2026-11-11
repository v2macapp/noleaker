// Runs in the page's MAIN world at document_start. It never touches storage:
// the isolated-world bridge hands it the effective config through DOM events.
import { installAudio } from './audio';
import { installFingerprint } from './fingerprint';
import { installFonts } from './fonts';
import { installGeolocation } from './geolocation';
import { installKeyboard } from './keyboard';
import { installRects } from './rects';
import { createNative } from './native';
import { installSpoof } from './spoof';
import { installVoices } from './voices';
import { installWebRtc } from './webrtc';
import { installWorkers } from './workers';
import { ackName, HANDSHAKE_EVENT, randomName, type ConfigMessage, type Hello } from './events';
import type { SpoofConfig } from '../shared/spoof-config';
import { startupConfig } from './startup';

let live: SpoofConfig | null = null;
let prelude: string | null = null;
// Captcha frames get this script only in Strict mode (the background registers it there), so the
// neutral startup state below never reaches a challenge in Compatibility, where it would loop.
let pending = true;
let workerConfig: SpoofConfig | null = null;

const spoof = installSpoof(globalThis);
const fingerprint = installFingerprint(globalThis);
const geolocation = installGeolocation(globalThis, { pending });
const fonts = installFonts(globalThis);
const voices = installVoices(globalThis);
const keyboard = installKeyboard(globalThis);
const webrtc = installWebRtc(globalThis, pending);
const audio = installAudio(globalThis);
const rects = installRects(globalThis);
// Until storage delivery completes, covered location/language APIs use the identity this origin
// last had in this tab, or public neutral values. The neutral start also briefly applies on
// disabled/whitelisted pages; the first valid config restores them.
const startup = startupConfig();
spoof.setConfig(startup);
for (const shield of [fonts, voices, keyboard]) shield.setConfig(startup);
const workers = installWorkers(globalThis, {
  config: () => workerConfig,
  pending: () => pending,
  prelude: () => prelude,
  gpu: () => fingerprint.currentGpu(),
});

function apply(config: SpoofConfig | null): void {
  if (!config || typeof config.active !== 'boolean' || !config.shields) return;
  pending = false;
  workerConfig = config;
  workers?.refresh();
  // Stealth mode: strict function shapes and clean stacks. Independent of whether spoofing is on.
  createNative(globalThis, { strict: config?.stealth === true });
  spoof.setConfig(config);
  // Every shield pauses together with the timezone spoofing (the key rule).
  live = config?.active ? config : null;
  fingerprint.setConfig(live?.fingerprint ?? null);
  audio.setConfig(live?.fingerprint ?? null);
  rects.setConfig(live?.fingerprint ?? null);
  for (const shield of [fonts, voices, keyboard]) shield.setConfig(live);
  geolocation.setConfig(config);
  webrtc.setConfig(config);
}

// Handshake with the bridge: invent this page's event name and tell the bridge, in whichever
// order the two scripts start. Nothing fixed is dispatched once page scripts can run.
const name = randomName();
const hello = (): void => {
  window.dispatchEvent(
    new CustomEvent(HANDSHAKE_EVENT, {
      detail: JSON.stringify({ k: 'main', n: name } satisfies Hello),
    }),
  );
};
const onHello = (e: Event): void => {
  try {
    if ((JSON.parse((e as CustomEvent<string>).detail) as Hello).k === 'bridge') hello();
  } catch {
    // not for us
  }
};
window.addEventListener(HANDSHAKE_EVENT, onHello);

window.addEventListener(name, (e) => {
  window.removeEventListener(HANDSHAKE_EVENT, onHello); // the bridge has the name: done with it
  try {
    const message = JSON.parse((e as CustomEvent<string>).detail) as ConfigMessage;
    prelude = message.prelude;
    apply(message.config);
  } catch {
    apply(null);
  }
  window.dispatchEvent(new Event(ackName(name)));
});
hello();
