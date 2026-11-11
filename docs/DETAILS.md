# noleaker: technical details

The full reference behind the [README](../README.md): privacy modes, what each shield changes, known
limits, testing and releases.

## Privacy modes and current assurance

Options → Privacy mode selects **Strict privacy** or **Compatibility**. Fresh storage defaults to
strict; existing installations and old imports retain compatibility. Strict mode ignores the Iran
list and custom direct-domain list, blocks local destinations with PAC plus DNR rules, keeps the
browser WebRTC policy enabled, and removes automatic captcha exemptions. Explicit spoofing
whitelists still expose native page values; they never bypass the proxy.

The PAC is mandatory. Proxy ownership, PAC readback, disabled network prediction, WebRTC policy
and required network rules are verified before the transition guard is released. Application
failure retains a persistent DNR request block and reports the failure. These controls apply to
new browser requests; they are not an OS firewall and cannot guarantee closure of existing sockets or zero traffic during an external control-takeover race.
The popup says **Proxy verified**, not an assertion of complete leak prevention.

Covered Date/Intl APIs initially return UTC/English. Geolocation, WebRTC and worker creation are restricted while initial configuration loads, even
before the extension knows whether protection is enabled. This brief startup restriction can
break scripts that immediately create a worker. Strict mode also blocks unsupported worker
creation and new Service Worker registrations. Existing Service Workers and instantly inspected
iframe realms remain outside these page patches. Covered Date/Intl APIs initially use UTC/English; early fingerprint and new-iframe escapes remain.

Use a dedicated browser profile for identity separation. Cookies, logins and site storage survive
proxy changes. The extension neither clears them nor promises account isolation. Incognito page
shields require enabling the extension for incognito; routing inheritance alone is insufficient.

Routing-list downloads are off by default, disabled in strict mode, and require explicit
opt-in in compatibility mode. Downloads stage candidates; Options shows the full membership diff
and requires approval before changing routing. Scheduled checks never apply an update. They use the active browser route and omit cookies. A same-release
SHA256 checksum verifies consistency, not independent publisher authenticity; updates changing
more than 10% of entries show a warning and can be applied with “Approve and replace list” after reviewing the diff. No signed-update guarantee is claimed.

The following feature descriptions refer to compatibility behavior where exceptions are mentioned.

## Shields

Options has one switch per shield, in two groups.

- **Match my exit country** (on by default): timezone, language, WebRTC, geolocation, Persian
  fonts, speech voices, keyboard layout and workers. Calendar and digits (gregorian, latin) follow
  the Language switch.
- **Fingerprint** (off by default): canvas noise, audio noise, layout noise, WebGL vendor/renderer,
  screen size, CPU cores, device memory and privacy headers.

Each switch changes only its own values. Turning WebRTC off can leak your real IP.

Limits of the new country shields: Persian fonts are hidden where a page sets them from script
(`style.fontFamily`, `cssText`, `setAttribute('style')`, `setProperty`, canvas `font`,
`document.fonts.check`); fonts in a page's own stylesheet or HTML `style=""` attribute are not
rewritten. Geolocation returns the same point (a major city) for the exit country, with 20 to 100 m
accuracy while active. Pending configuration or strict mode without a usable shield/position
returns a permission-denied result rather than forwarding to native geolocation.

### Fingerprint notes

- Hardware values are picked from the proxy profile id. Page-facing noise/GPU/screen seeds are
  SHA256-derived per top-level hostname; the raw profile id and full whitelist are not sent to
  the page. Noise differences reduce one linking signal; they do not prevent fingerprint linking.
- They follow the same rules as timezone spoofing: active only while the proxy is on and healthy,
  and not on whitelisted sites.
- **Risk:** spoofing only some values can make your browser more unique, and sites can notice
  inconsistencies (for example a GPU that does not match your OS, or a screen smaller than the
  window). Keep everything off unless you have a reason.
- The WebGL/WebGPU GPU is chosen from a model table keyed by OS, and only if it fits the CPU
  cores and screen the page sees (an Apple M1 has 8 cores; a desktop RTX card does not sit behind
  a 1366x768 screen). If no model fits, the real GPU is kept: a fake GPU that does not fit the
  machine is worse than the real one. WebGPU `device` and `description` follow the same choice;
  `vendor` and `architecture` are not changed.
- `OffscreenCanvas` (`getImageData`, `convertToBlob`) gets the same noise and seed as a normal
  canvas, also inside workers.
- **Noise seed:** canvas, audio and layout noise use a SHA256 derivation of the profile seed and
  full top-level hostname. Reloads of one host keep the same seed; different subdomains get
  different seeds. Full-host partitioning avoids sharing seeds between private-suffix tenants.
- **Audio noise** adds about 1e-4 to `AudioBuffer.getChannelData` and `copyFromChannel` and to the
  four `AnalyserNode` read methods. Silence stays silent: zero samples, `-Infinity` dB bins and the
  128 midpoint of byte time-domain data are never changed. `getChannelData` data is changed in
  place (it is a live view), so playback carries the same sub-audible noise.
- **Layout noise** moves `getBoundingClientRect`, `getClientRects` (elements and ranges), SVG
  `getBBox`, SVG text lengths and `TextMetrics` values by at most 1/64 px. A value that is already
  a multiple of 1/4 px is left alone, so pixel-snapped layout is unchanged.
- Not covered: WebGL `readPixels`, `matchMedia` device queries and `window.screenX/Y`.

### Privacy headers, captchas and network rules

- **Privacy headers** (off by default) sets `DNT: 1` and `Sec-GPC: 1` and removes `If-None-Match`
  (so pages are never answered with a cached 304). It skips whitelisted sites, your extra
  direct domains and the Iran list. It runs only while the proxy is on and healthy.
- **Captchas in compatibility mode:** Cloudflare Turnstile, hCaptcha, reCAPTCHA (including `www.google.com/recaptcha/`),
  Arkose/FunCaptcha, GeeTest and DataDome (`captcha-delivery.com`) are exempt: the language and
  header rules skip their requests, and their frames get no spoofing at all, wherever they are
  embedded. Alt-Svc stripping still applies to them, because it keeps traffic off QUIC.
- **If Chrome rejects the rules** (an exclusion list that is too large), noleaker retries with half
  of the excluded domains, then a quarter, down to none. Captcha providers and your whitelist come
  first in that list, so Iran-list domains are dropped first. The result is shown in the popup
  (status "Rules") and in the leak test row "Network rules installed", and logged under
  Diagnostics. A rule set that cannot be installed at all is reported as a failure, not hidden.
- The header rule is installed separately from the core rules, so a problem with it cannot take
  Alt-Svc stripping or the language header down with it.

### Stealth mode

Options → Stealth mode (off by default) raises the cost of detecting noleaker. It does **not** make
it undetectable.

- **Function shapes.** Every patched function (and getter/setter) copies the own-property keys and
  the `name`/`length` descriptors of the native one it replaced. Patched methods have no
  `prototype`, patched constructors keep their non-writable `prototype`, and
  `Function.prototype.toString` prints `[native code]` for all of them.
- **Clean stacks.** An error that passes through a patch loses the stack frames that point at this
  extension (`chrome-extension://...`), which would otherwise reveal its presence and its id.
- It follows the setting even when spoofing is paused or the site is whitelisted, because the
  patches are still installed there.

Always on, with or without stealth: the MAIN-world script and the bridge do not talk over fixed
event names. They shake hands once, at document start and before any script of the page can run
(the only fixed name, `__nl__`, is dispatched there and both sides stop listening to it after), and
everything later uses event names the page-side script invents for each page load. Nothing is added
to the DOM or to `window`, and the worker prelude removes its start-up data before the page's worker
code runs. This is decided before your settings are known, so it cannot depend on the switch. A name that changes on every page load needs no stored secret.

What stealth does not hide:

- Stack frames of errors that **your own page code** creates inside a callback we call (for example
  a geolocation callback or a worker message) can still show this extension's frame.
- A page that already runs code in a frame before our scripts start there (a script-created iframe
  read immediately) can see the handshake and native values.
- Timing: patched calls take slightly longer than native ones.
- Everything the server sees: `Accept-Language`, `DNT`/`Sec-GPC`, the proxy IP.
- Workers start from a `blob:` URL (see Workers), and worker stack traces show it.
- Behaviour, not shape: for example a geolocation answer after 150 to 550 ms, or noise in canvas and
  audio data, can be recognised by a page that knows what to look for.

### Overrides and warnings

Options → Overrides lets you set the timezone (IANA picker), locale, `Accept-Language` and
coordinates by hand. Empty means automatic, and each field shows "currently automatic: X" or
"currently manual: X (automatic would be Y)". A manual value wins over what noleaker picks from the
exit country, field by field:

- A manual **locale** without a manual `Accept-Language` gets the header that fits it
  (`de-DE` becomes `de-DE,de;q=0.9,en;q=0.8`).
- `navigator.language` and `navigator.languages` come from the `Accept-Language` value, the default
  `Intl` locale from the locale.
- **Language mode:** "English (recommended)" keeps `en-US` everywhere.
  "Match the exit country" uses the country's own locale and `Accept-Language`. It looks more local,
  but it is a rarer combination. Both modes still obey manual overrides.
- Overrides never replace detection: spoofing still runs only while the proxy is on, healthy and the
  exit is known.

Warnings (shown in the options page, and in the popup as "Override") appear when:

- the timezone differs from the exit country's;
- the locale or `Accept-Language` contains Persian (`fa`, `fa-*`);
- a manual locale's region differs from the exit country;
- the coordinates are more than 12 degrees of arc (about 1,300 km) from the country's point.

Overrides are stored with your other settings, survive a browser or service-worker restart, and are
part of Export/Import.

### Stale pages and the per-tab audit

- **Stale-page recovery.** After every config message the page-side script answers, and the bridge
  expects that answer. If a protected page does not answer (its MAIN-world script never ran, for
  example because a Service Worker served a response that skipped it), the bridge retries once and
  then asks the service worker to reload the tab. Guards, all mandatory: at most one reload per tab
  and URL within 20 seconds, never after a form submit (found through `webNavigation`), never on
  whitelisted, directly connected (Iran list, your own direct domains) or captcha pages, and
  only for the top-level page. A page controlled by a Service Worker gets a hard reload (bypass
  cache), any other a normal one. The popup says "This page was reloaded once to apply
  protection", or "This page may be unprotected: ..." when it could not reload. A page restored from
  the back/forward cache gets a fresh config push (no reload needed).
- **Audit this tab** (popup): reads what the active page really sees, through every patch, and shows
  a grid with one chip per check: timezone, system offset, calendar, digits, language, voices, fonts,
  keyboard and WebRTC. Green is fine, red shows "site sees: ..." and which switch fixes it, grey means
  the shield is off or the value cannot be read. It explains why it will not run on browser pages, a
  whitelisted site, a captcha page, a directly connected site, with the proxy off, or before the exit
  is known. A font check cannot tell "hidden by the shield" from "not installed", so a machine
  without Persian fonts passes that chip either way.

### Workers

With the Workers shield on, a classic same-origin `Worker` starts through a small blob script that
runs the prelude (timezone, language, GPU, OffscreenCanvas noise) and then loads your script with
`importScripts`. For blob URLs created in the page, the original Blob is included directly after
the prelude, so a CSP that permits blob workers but forbids blob script imports does not break
the worker, and revoking the original URL immediately is safe. Inside the worker `location`,
`importScripts`, `fetch`, XHR and nested `Worker` resolve against the original script URL. A worker
is left alone (and runs natively) in compatibility mode when it is a module worker, cross-origin
or `data:`, an unknown blob URL, when the prelude has not arrived yet, or after the page reported
a CSP that blocks blob workers.

For a `TrustedScriptURL`, the wrapper URL is submitted to the same page policy that approved the
original URL. If the policy is unavailable, rejects it or rewrites it, the usual unsupported-worker
fallback applies: blocked in Strict, native in Compatibility. Page strings are never promoted to
trusted values automatically.

Limits:

- `SharedWorker` is not wrapped: a blob URL differs per tab, so tabs would stop sharing one worker.
- Service Workers and workers started from inside a worker are not covered.
- A worker keeps its starting config in compatibility mode. Workers tracked by this page are
  terminated on config changes when entering, leaving or using strict mode; sites may need reload.
- Worker creation is blocked until initial configuration arrives; unsupported workers then run
  natively only in compatibility mode.
- Error stack traces inside a worker show a `blob:` URL.
- Prepending the prelude to a Blob means its leading `"use strict"` is no longer a directive.

### Google Flow unlock

Moved to its own extension, [noleaker-flow](https://github.com/LordVersA/noleaker-flow), for Chrome
and Firefox. Updating from v0.1.1 removes the old Flow page script, its network rule and the
setting.

## Firefox differences

The Firefox build (desktop, Firefox 140 ESR or newer) shares all page-side code with Chrome. The
differences:

- **Routing.** Firefox has no PAC here: a `proxy.onRequest` listener decides each request with the
  same `route()` logic as Chrome's PAC script (SOCKS5 with remote DNS, Iran list and direct domains
  in compatibility mode, strict-mode local-host block). The kill switch and the transition guard
  answer with a dead-end proxy instead of DNR block rules. Requests made before the routing table is
  loaded wait for it and are refused if it never arrives; a listener error also means refused,
  never direct. There is no `proxy.settings` fallback, so if the listener itself is missing (for
  example the extension failed to start), Firefox's own proxy settings apply.
- **SOCKS5 authentication.** Optional username and password per proxy, Firefox only.
- **Private windows.** noleaker runs there only if allowed (`about:addons` → Run in Private
  Windows). Without it, private windows are not protected: popup, options and the leak test show a
  warning and the icon a **PW!** badge. Nothing else changes.
- **resistFingerprinting.** With `privacy.resistFingerprinting` on, the fingerprint shields
  (canvas, WebGL, audio, client rects, screen, CPU, memory) are switched off in the effective
  config, because Firefox already handles them; timezone and language spoofing stay on. Firefox's
  Fingerprinting Protection (FPP) cannot be detected, so canvas or audio noise may stack with its
  own when you turn the shields on.
- **Stealth.** Stack cleaning also removes `moz-extension://` frames, and patched functions copy
  Firefox's native `toString` format. Less tested than in Chrome; errors Firefox does not let us
  rewrite (possibly `DOMException`) keep their frames.
- **Frames.** Firefox before 151 has no `location.ancestorOrigins`; frames ask the background for
  the tab's site so the whitelist and per-site seed match the top page.
- **Distribution.** An unlisted, Mozilla-signed `.xpi` on GitHub Releases that updates itself
  through `updates.json` (see Releases). Not on addons.mozilla.org.

## Testing

Build before running tests so bundled-script checks use the current output:

```sh
npm run lint
npm run format:check
npm run build
npm test
```

The SOCKS integration tests require permission to open localhost listeners. `npm run socks` starts
a local test proxy on `127.0.0.1:1080`; it logs CONNECT requests so you can inspect domain-name
forwarding. Strict mode blocks local page destinations, so use a public test page through the proxy
when checking site protections.

For manual verification, use a disposable browser profile and check regular/incognito behavior,
proxy outage and recovery, local-address blocking, startup, frames and workers. Complete release
verification also requires independent packet/DNS/TURN captures, existing-connection checks,
IPv4/IPv6 and Chrome stable/beta coverage on supported operating systems. Configuration readback
and an empty ICE result alone do not prove that all network traffic is protected.

### Firefox

CI (`.github/workflows/ci.yml`) runs lint, typecheck, both builds, the unit and bundle tests,
`web-ext lint` and a Selenium E2E suite on Firefox ESR. The E2E suite (`tests/e2e/firefox.e2e.ts`)
covers four leak scenarios: startup (no request goes direct before the proxy listener is ready),
kill switch (SOCKS server down), private windows without access (warning badge) and WebRTC (no
real-IP candidates). It installs the unsigned build into a profile, which needs Firefox ESR,
Developer Edition or Nightly:

```sh
npm run build:firefox
FIREFOX_BIN=/path/to/firefox-esr npm run e2e:firefox
```

Manual Firefox release checklist (with the signed `.xpi`, in a fresh profile on Firefox release
and ESR 140):

- the `.xpi` installs permanently, and the popup, options and leak test open with no console errors;
- the proxy, with and without SOCKS credentials, shows the proxy IP; Iran-list sites go direct in
  compatibility mode;
- the leak test passes with stealth on and off, including timezone, locale and workers inside
  frames;
- the "PW!" badge follows "Run in Private Windows", and turning on `privacy.resistFingerprinting`
  turns the fingerprint shields off;
- a settings export from Chrome imports into Firefox, and back.

## Releases

Pushing a version tag (for example `v0.2.0`) automatically installs locked dependencies, checks
formatting/lint, builds minified production bundles, runs the full test suite and publishes to
GitHub Releases:

- `noleaker-chrome-X.Y.Z.zip`;
- `noleaker-firefox-X.Y.Z.xpi`, signed by Mozilla on the unlisted channel (`web-ext sign`, with
  the source code uploaded), and `updates.json` for Firefox's self-hosted update check;
- `SHA256SUMS.txt` covering all of them.

The tag must match the versions in `package.json` and both `manifests/manifest.*.json`.

Signing needs two repository secrets, `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (an API key from
addons.mozilla.org → Developer Hub → Manage API Keys). Without them the release has no Firefox
build. AMO signs each version only once, so rebuilding an existing tag reuses the signed `.xpi`
already on the release. The Gecko ID `noleaker@lordversa.github.io` is permanent once signed.

Installed Firefox copies check
`https://github.com/v2macapp/noleaker/releases/latest/download/updates.json`, so a new release
only updates them once it is the latest (not a draft or pre-release).

To release, run `npm run release -- 0.3.0` on a clean `main`. It shows the release notes, then
bumps `package.json`, `package-lock.json` and both manifests, commits `chore: release 0.3.0`, tags
`v0.3.0` and pushes. The notes come from `scripts/changelog.sh`: the commits since the previous
tag, grouped into Features, Fixes and Other changes. The workflow writes them into the GitHub
Release, and again when an existing release is rebuilt. An existing tag can be rebuilt from Actions → Build and
release → Run workflow.

## Updating the bundled Iran list

`npm run snapshot` regenerates `public/data/iran-domains.json` from the latest upstream release.

## Brand

The mark is a shield outline with a droplet (`src/shared/brand.ts`). `npm run icons` redraws the
packaged PNG icons in `public/icons/` from the same shapes, the toolbar icon is drawn from them at
runtime (gray off, blue on, red on error), and the options page uses them inline.
