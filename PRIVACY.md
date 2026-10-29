# Privacy

noleaker has no account, no analytics and no servers of its own. Everything it stores stays in
your browser (`chrome.storage.local` and `chrome.storage.session`).

## What it sends, and to whom

Only three kinds of requests leave your browser because of noleaker, and none carry personal data
beyond ordinary request metadata, including the IP visible to the recipient:

| Request                                                                                        | Why                                                                                                | Sent to    |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------- |
| `cloudflare.com/cdn-cgi/trace`                                                                 | Find your proxy's exit IP and country (and as a health check, every minute while the proxy is on). | Cloudflare |
| `ipwho.is`                                                                                     | Fallback for the above, and the exit's timezone.                                                   | ipwho.is   |
| `github.com/bootmortis/iran-hosted-domains/releases/latest/download/domains.txt` (+ `.sha256`) | Opt-in compatibility-mode refresh of the routing list; disabled in strict mode.                    | GitHub     |

The Firefox build adds one more, made by Firefox itself: about once a day it fetches
`github.com/v2macapp/noleaker/releases/latest/download/updates.json` (the self-hosted add-on
update check) and, when there is a new version, downloads the signed `.xpi` from the same GitHub
release.

These requests use the browser's normal route: through your SOCKS5 proxy while it is on, directly
when it is off. When the effective browser proxy is controlled and working, lookup services see its exit IP.
A stored enabled flag alone is not proof of routing; the extension now verifies effective controls. They are third parties with their own policies.

The leak test page makes extra requests only when you open it: the same Cloudflare trace, a
WebRTC probe to `stun.l.google.com`, and background tabs on `cloudflare.com/cdn-cgi/trace` and
`challenges.cloudflare.com/cdn-cgi/trace`. Health lookups omit credentials and reject redirects.
List downloads omit credentials but follow GitHub's required download redirects.

## Permissions that can see your browsing

noleaker asks for access to all sites (it has to run on every page you spoof) and for
`webNavigation`, which tells it how each tab's last navigation happened (a form submit, a typed
address) so it never reloads a page after you submitted a form. The URLs are kept only in
`chrome.storage.session` for the lifetime of the browser session, one entry per open tab, and are
deleted when the tab closes. They are never sent anywhere.

## What it stores locally

Your proxy profiles (name, host, port and, in the Firefox build, an optional SOCKS5 username and
password), settings, the detected exit (IP, country, timezone), the
Iran domain list, your whitelist and extra direct domains, and a short diagnostics log (the last
100 events; no page URLs). Nothing is uploaded. **Export settings** writes a file you control; it
contains your proxy addresses and any SOCKS5 passwords, so keep it private. SOCKS5 passwords are
stored unencrypted in extension storage, as with any proxy extension.

Optional shields add request headers (`DNT`, `Sec-GPC`) and change `Accept-Language`; they only
change what your browser sends and do not send anything to us or anyone new.

## Privacy boundaries

Strict mode disables automatic public direct exceptions and blocks local URL requests (Chrome: PAC
and DNR; Firefox: the `proxy.onRequest` listener). Compatibility mode exposes real-IP traffic to direct destinations, including during
proxy failure. Request guards cover new DNR-visible requests, not existing connections, other
extensions, all browser-internal services or OS traffic. Disabling/uninstalling this extension
removes its enforcement. In Firefox, private windows are protected only if you allow noleaker to
run there (`about:addons` → Run in Private Windows); the icon shows a **PW!** badge until you do.

MAIN-world patches are observable and bypassable by hostile scripts. Early fingerprint reads, immediately accessible new iframe realms and existing Service Workers remain limitations.
Strict mode blocks unsupported new worker creation and Service Worker registration through patched
APIs; it does not remove existing registrations. Explicit spoofing whitelists expose native values.

The page receives a per-top-level-host SHA256-derived seed rather than a raw proxy profile id; its
full whitelist is kept in the isolated bridge. DOM event names do not constitute a secure channel.
Hardware presets, cookies, logins and other signals can still correlate browsing across sites.
Use a dedicated browser profile; switching proxies does not isolate or erase identity stores.

## What it does not do

- It does not read or record the pages you visit, and does not keep a browsing history.
- In Chrome it does not use proxy usernames or passwords (SOCKS5 without authentication only). In
  Firefox an optional SOCKS5 username and password are sent only to your proxy.
- It does not make you anonymous. It is not a VPN; only browser traffic goes through the proxy, and
  the proxy operator can see where that traffic goes.

Routing-list downloads stage unsigned candidates only. Review and approval in Options are required before direct-routing membership changes. See [coverage and identity boundaries](docs/PRIVACY-COVERAGE.md).
