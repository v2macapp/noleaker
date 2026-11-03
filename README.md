<p align="center"><img src="docs/brand/logo.jpg" alt="noleaker: SOCKS5 proxy and VPN leak protection for Chrome and Firefox" width="520" /></p>

# noleaker: SOCKS5 proxy and VPN leak protection for Chrome and Firefox

[![Latest release](https://img.shields.io/github/v/release/v2macapp/noleaker)](https://github.com/v2macapp/noleaker/releases/latest)
[![Build and release](https://github.com/v2macapp/noleaker/actions/workflows/release.yml/badge.svg)](https://github.com/v2macapp/noleaker/actions/workflows/release.yml)
[![Downloads](https://img.shields.io/github/downloads/v2macapp/noleaker/total)](https://github.com/v2macapp/noleaker/releases)
![Chrome 120+](https://img.shields.io/badge/Chrome-120%2B-4285F4?logo=googlechrome&logoColor=white)
![Firefox 140+](https://img.shields.io/badge/Firefox-140%2B-FF7139?logo=firefoxbrowser&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue)](LICENSE)

**noleaker** is a free, open-source browser extension for Chrome and Firefox (Manifest V3) that
makes your browser match its exit, whether that exit is a SOCKS5 proxy or a system VPN/TUN, and
stops the usual leaks: WebRTC, DNS, QUIC, timezone and language.

- **SOCKS5 proxy mode:** sends the browser through your proxy, with a kill switch. A FoxyProxy
  alternative that also makes the browser look like it is in the proxy's country.
- **System VPN / TUN mode:** for a VPN or TUN app that already carries your traffic. noleaker sets
  no proxy and matches timezone, language and geolocation to the VPN's exit.

No account, no license key, no servers of our own. [Test your browser for leaks](https://v2macapp.github.io/noleaker/).

<p align="center">
  <img src="docs/screenshots/popup.png" alt="noleaker popup: SOCKS5 proxy switched on, exit IP, country and timezone shown" width="270" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/leak-test.png" alt="noleaker built-in leak test: public IP, DNS, WebRTC, QUIC, timezone and language checks" width="400" />
</p>

## What it does

| Leak                | How noleaker handles it                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| **IP and DNS**      | Proxy mode sends all browser traffic and DNS through your SOCKS5 proxy; VPN mode leaves routing to your VPN. |
| **WebRTC**          | Limited to proxied UDP, so pages cannot read your real IP.                                                   |
| **QUIC / HTTP3**    | Upgrades are prevented, so traffic stays on the proxy.                                                       |
| **Timezone**        | `Date` and `Intl` report the timezone of the exit's country (proxy or VPN).                                  |
| **Language**        | `navigator.language` and `Accept-Language` follow your choice.                                               |
| **Geolocation**     | Reports a point in the exit country, not your real position.                                                 |
| **Proxy goes down** | Kill switch (proxy mode): requests are blocked instead of going out directly.                                |

Also included:

- **Spoofing pauses** in VPN mode if the exit check fails, so a dropped VPN does not leave the old
  exit's timezone paired with your real IP.
- **Built-in leak test** that checks each item above and tells you which setting fixes a failure.
- **Audit this tab**: see what the current site really reads from your browser.
- **Per-site whitelist**, manual overrides (timezone, locale, coordinates) and settings import/export.
- **Optional fingerprint shields** (off by default): canvas, audio and layout noise, WebGL, screen, CPU.
- **Two privacy modes.** _Strict_ (default) sends everything through the proxy. _Compatibility_ lets
  Iran-hosted sites (bundled list of about 127,000 domains) and your own direct domains skip it.

<p align="center">
  <img src="docs/screenshots/options.png" alt="noleaker settings: shields for timezone, language, WebRTC, geolocation, fonts, voices, keyboard and workers" width="820" />
</p>

## Install

**Chrome**

1. Download `noleaker-chrome-<version>.zip` from the
   [latest release](https://github.com/v2macapp/noleaker/releases/latest) and extract it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and choose the extracted folder.

Needs Chrome 120 or newer. Other Chromium browsers are untested.

**Firefox**

1. Open `noleaker-firefox-<version>.xpi` from the
   [latest release](https://github.com/v2macapp/noleaker/releases/latest) in Firefox and click
   **Add**. It is signed by Mozilla (not listed on addons.mozilla.org) and updates itself.
2. Recommended: `about:addons` → noleaker → **Run in Private Windows** → Allow. Without it,
   private windows are not protected and the icon shows a **PW!** badge.

Needs Firefox 140 (ESR) or newer on desktop. Forks such as LibreWolf probably work but are untested.

## Use

1. **SOCKS5 proxy:** popup → **Manage proxies** → add your SOCKS5 host and port.
   **System VPN / TUN:** connect your VPN app, then set **Connection** to **System VPN / TUN** in the popup.
2. Switch **Protection** on. In proxy mode the pill shows **Proxy verified**.
3. Click **Run leak test** to check IP, DNS, WebRTC, QUIC, timezone and language.

## Troubleshooting

- **Everything is blocked, icon is red:** the proxy is unreachable. Start your SOCKS5 server; it
  recovers within a minute. Options → Diagnostics shows what happened.
- **"noleaker does not control the proxy":** another extension (for example FoxyProxy) or a policy
  owns Chrome's proxy settings. Disable it.
- **PW! badge (Firefox):** noleaker may not run in private windows, so they are not protected.
  Allow it in `about:addons` → noleaker → Run in Private Windows.
- **Firefox with `privacy.resistFingerprinting`:** the fingerprint shields switch themselves off,
  because Firefox already handles them. Timezone and language spoofing stay on.
- **A site shows your real timezone:** check that the site is not whitelisted, then reload the page.
- **WebRTC calls do not work:** expected. Browsers cannot carry UDP through SOCKS5, so WebRTC is
  restricted to protect your IP.

## Limits

- **Not a VPN itself.** In proxy mode only browser traffic is covered, and the proxy operator sees
  where it goes. VPN mode relies on your VPN app for routing.
- **System VPN / TUN mode has no kill switch.** noleaker routes nothing there, so if the VPN drops,
  traffic goes out directly. Use the VPN app's kill switch, and check DNS leaks in the VPN app.
- **SOCKS5 username/password only in Firefox.** Chrome's proxy API cannot carry them, so Chrome
  needs a proxy without authentication.
- **"Proxy verified" is not a guarantee of zero leaks.** It means the browser controls were applied
  and read back. Independent packet capture has not been done yet.
- **Not an anti-bot tool.** Spoofing removes obvious mismatches; it does not make you undetectable.
- Cookies and logins survive proxy changes. Use a separate browser profile to keep identities apart.

The full list of protections, edge cases and known gaps is in [docs/DETAILS.md](docs/DETAILS.md).
What the extension sends over the network is in [PRIVACY.md](PRIVACY.md).

## Build from source

```sh
npm install
npm run build     # typecheck + production build to dist/chrome/ and dist/firefox/
npm run build:chrome   # one target only (also build:firefox)
npm run dev       # watch mode with source maps (dev:firefox for Firefox)
npm test          # run after a build
npm run socks     # local SOCKS5 server on 127.0.0.1:1080 for testing
npm run package   # build and zip both targets to release/
```

Load the `dist/chrome/` folder with **Load unpacked**. For Firefox, run `npm run start:firefox`, or
open `about:debugging` → This Firefox → **Load Temporary Add-on** and pick
`dist/firefox/manifest.json`. After a rebuild, reload the extension and your open tabs. Testing, releases and design notes: [docs/DETAILS.md](docs/DETAILS.md) and
[DESIGN.md](DESIGN.md).

## License

[GPL-3.0](LICENSE). Third-party data, services and build tools are listed in
[THIRD_PARTY.md](THIRD_PARTY.md).
