# Bug list (audit of 2026-11-12)

Audit of `src/` at commit `4a46483` (v0.6.1). Work through the bugs one at a time, in the order of
the table, and tick each one off here when its fix is committed.

How the findings were made: by reading the code. Only B14 was run (in Node). Nothing was reproduced
in a real browser, so each bug has a "Reproduce" section to confirm it first. Unit tests (397),
typecheck and lint all pass at this commit, so no existing test covers any of these.

Not audited: `src/leaktest/`, `src/audit/`, and the e2e suites.

## Overview

| Done | ID  | Severity | Area             | Bug                                                                |
| ---- | --- | -------- | ---------------- | ------------------------------------------------------------------ |
| [x]  | B1  | High     | Stops working    | Another extension holding a privacy setting blocks all browsing    |
| [x]  | B2  | High     | Stops working    | One failed exit check trips the kill switch                        |
| [ ]  | B3  | Medium   | Stops working    | Browser start blocks restored tabs                                 |
| [x]  | B4  | High     | Stops working    | A failed ipwho.is lookup wipes the timezone                        |
| [ ]  | B5  | Medium   | Stops working    | Strict mode kills every page worker on any config change           |
| [ ]  | B6  | High     | Captcha          | Startup state: UTC, en-US and refused workers until config arrives |
| [x]  | B7  | High     | Captcha          | New `about:blank` iframes disagree with their parent page          |
| [x]  | B8  | High     | Captcha and leak | `Temporal` is not patched                                          |
| [ ]  | B9  | Medium   | Captcha          | Extension URLs show in error stacks unless Stealth is on           |
| [ ]  | B10 | Medium   | Captcha, sites   | The first worker on a CSP site is lost                             |
| [ ]  | B11 | Medium   | Captcha, sites   | Workers on Trusted Types sites probably break (unconfirmed)        |
| [ ]  | B12 | Low      | Captcha          | The captcha provider list is short                                 |
| [x]  | B13 | Medium   | Options          | Routing-list update fails after clicking a sidebar link            |
| [x]  | B14 | Low      | Spoofing         | Dates with US zone abbreviations are shifted                       |
| [ ]  | B15 | Low      | Options          | Unsaved text in the options page is overwritten                    |
| [ ]  | B16 | Medium   | Sites            | Persian fonts can be stripped permanently                          |
| [ ]  | B17 | Low      | Status           | False "Uncertain" exit on dual-stack servers (unconfirmed)         |
| [ ]  | B18 | Low      | Spoofing         | Spoofing starts before the proxy is verified (manual country)      |
| [ ]  | B19 | Low      | Sites            | Relative URLs fail inside wrapped workers                          |
| [ ]  | B20 | Low      | Spoofing         | Whitelist: header rule and page script disagree in frames          |

Suggested order: B1, B2, B4 (the "stops working" reports), then B13 and B14 (one-line fixes), then
B8, B6, B7 (captcha), then the rest.

B1, B2, B3 and B5 change fail-closed behaviour. Each fix needs a decision on how strict the kill
switch and the guard should stay; the decision is noted in the bug.

---

## Part 1: it sometimes stops working completely

### B1. Another extension holding a privacy setting blocks all browsing

- **Where:** `src/background/protection.ts:59-89` and `:96-113`, `src/background/privacy-watch.ts:5-16`
- **What happens:** while the proxy is on, `applyProtection` requires
  `levelOfControl === 'controlled_by_this_extension'` for `networkPredictionEnabled` and
  `webRTCIPHandlingPolicy`. Chrome and Firefox give control of a setting to the extension that was
  installed last. If an extension installed after noleaker sets either one (Privacy Badger, uBlock
  Origin on Firefox, a VPN extension, a WebRTC blocker), `set()` cannot take control back, the check
  throws `Network prediction control is unavailable.` or `WebRTC policy is not controlled by
noleaker.`, and `enqueue` in `src/background/monitor.ts:24-32` turns the guard on. The guard blocks
  every request. It happens even when the other extension set exactly the value noleaker wants.
- **What the user sees:** every page fails; the popup says "Protection failed". It stays that way
  until the other extension is removed.
- **Reproduce:** install noleaker, turn the proxy on, then install Privacy Badger (or any extension
  that sets network prediction). All browsing stops.
- **Fix:** accept the setting when its value is the wanted one, whoever controls it. Only fail when
  the value is wrong and noleaker cannot change it. The `onChange` listeners in `privacy-watch.ts`
  need the same rule: a loss is "the value is no longer right", not "someone else controls it".
- **Decision needed:** another extension could later change the value; the `onChange` listener
  catches that and guards then. Confirm this is strict enough.
- **Test:** unit test for the accept rule with a fake `chrome.privacy` that reports
  `controlled_by_other_extensions` with the right value (must pass) and the wrong value (must fail).
- **Same pattern, by design:** `src/platform/chrome/proxy.ts:48-54` blocks everything when another
  extension controls the proxy setting. That one is correct (noleaker must own the proxy), but the
  popup should name the cause clearly.

### B2. One failed exit check trips the kill switch

- **Where:** `src/background/monitor.ts:68-78` (`runCheck`), `src/shared/lookup.ts:35-44`
- **What happens:** `detectExit` asks Cloudflare and ipwho.is once each, 8 s timeout. If both fail
  once, `runCheck` sets `killSwitchActive` straight away. There is no retry and no "two failures in a
  row" rule. In Strict mode the DNR guard then blocks every request, so no proxy error can fire to
  trigger an early re-check (`onProxyError`), and recovery waits for the next alarm, up to one
  minute.
- **When it happens:** laptop wakes from sleep (the alarm fires before the network is back), a
  short proxy hiccup, a slow lookup.
- **What the user sees:** "Blocked" for up to a minute at random times. With B5, workers in all tabs
  die as well.
- **Reproduce:** proxy on in Strict, stop the local SOCKS server for 20 s around a check, start it
  again. Browsing stays blocked until the next minute tick.
- **Fix:** on a failed check, retry once after a few seconds before engaging the kill switch (or
  require two consecutive failures). While the kill switch is on, re-check every 10 s instead of
  every minute so recovery is fast.
- **Decision needed:** the retry leaves a few seconds where a dead proxy is not yet blocked. The
  PAC has no direct fallback, so requests fail rather than leak; confirm that is acceptable.
- **Test:** unit test of the decision ("first failure: no kill switch; second: kill switch").

### B3. Browser start blocks restored tabs

- **Where:** `src/background/monitor.ts:202-212` (`onStartup`), `src/platform/chrome/proxy.ts:42-47`,
  same idea in `src/platform/firefox/proxy.ts:49-52`
- **What happens:** `onStartup` sets `controlsVerifiedAt` to null. `syncProxy` then turns the
  block-all guard on until `syncProtection` has finished (PAC generation, hashing, DNR rule install,
  which can take a second or more with the Iran list in Compatibility mode). Tabs that the browser
  restores in that window fail with `ERR_BLOCKED_BY_CLIENT` and do not retry.
- **What the user sees:** after starting the browser, some restored tabs show an error page until
  reloaded by hand.
- **Reproduce:** proxy on, several tabs open, "continue where you left off" enabled, restart the
  browser.
- **Fix options:** (a) after the guard is released at startup, reload the tabs that failed while it
  was on (they are known from `webNavigation.onErrorOccurred`); or (b) do not guard at startup when
  the previous PAC is still in effect and controlled by noleaker.
- **Decision needed:** (b) trusts the state left by the last session; (a) keeps fail-closed and
  only repairs the tabs. (a) is the safer choice.

### B4. A failed ipwho.is lookup wipes the timezone

- **Where:** `src/shared/lookup.ts:71-75`, stored by `src/background/monitor.ts:101`
- **What happens:** only ipwho.is gives a timezone. When it fails and Cloudflare answers,
  `detectExit` returns `timezone: ''`, and the scheduled check stores that over the good value even
  though the IP did not change. The timezone then falls back to the country default
  (`src/shared/exit.ts:26`), which is wrong for countries with several zones (US, Canada, Russia,
  Australia, Brazil), and flips back on the next good check. ipwho.is is asked every minute by every
  user, from exit IPs that many users share, so rate limiting is likely.
- **What the user sees:** the timezone a site sees changes in the middle of a session. In Strict
  mode each flip also kills page workers (B5).
- **Reproduce:** block `ipwho.is` at the proxy for one check with a US exit; the popup's timezone
  changes to the country default, then back.
- **Fix:** in `runCheck`, when the new exit has the same IP as the stored one and no timezone, keep
  the stored timezone. Better still: ask ipwho.is only when the Cloudflare IP changed or no timezone
  is stored, which also removes most of the load on ipwho.is.
- **Test:** unit test in `tests/exit-refresh.test.ts` or `tests/lookup.test.ts`: same IP, empty
  timezone, stored timezone must survive.

### B5. Strict mode kills every page worker on any config change

- **Where:** `src/content/workers.ts:152-172` (`refresh`)
- **What happens:** in Strict mode, whenever the config a page receives differs from the previous
  one, every tracked worker is terminated. Pages get no event and cannot recover. The config changes
  on a kill-switch flip (B2), a timezone flip (B4), an exit change, and any settings change.
- **What the user sees:** web apps that depend on workers stop responding in all tabs until
  reloaded.
- **Fix:** B2 and B4 remove most triggers. Beyond that, terminate only when a value the worker
  actually holds has changed (timezone, locale, fingerprint), not on any difference, and not when
  the config only went inactive and came back identical.
- **Decision needed:** keeping an old worker alive after a real identity change leaks the old
  identity from that worker; that is why it terminates. Keep the rule for real changes.

---

## Part 2: captcha

### B6. Startup state: UTC, en-US and refused workers until the config arrives

- **Where:** `src/content/main.ts:21-37`, `src/content/workers.ts:34-36` and `:107`,
  `src/content/geolocation.ts:27` and `:97-111`, `src/content/bridge.ts:142-147`
- **What happens:** `main.js` runs at `document_start` with no config. The bridge reads the config
  from `chrome.storage.local`, which is asynchronous. Until it arrives the page is in a "pending"
  state:
  - timezone is UTC and language is en-US;
  - `new Worker()` and `new SharedWorker()` throw `SecurityError`;
  - `navigator.serviceWorker.register()` rejects;
  - geolocation reports "denied";
  - Persian fonts are hidden (see B16).

  Page scripts that run in that window see these values, then different ones a few milliseconds
  later. This applies on every page, also with noleaker switched off and on whitelisted sites.

- **Why it matters for captcha:** commit `f788eac` records that this state made Turnstile loop and
  removed it from captcha frames. Commit `6ca7af8` put it back for captcha frames in Strict mode,
  which is the default for new installs. A challenge that reads the timezone twice sees it change,
  and one that starts a worker early gets an exception.
- **Reproduce:** `tests/browser-fixtures/index.html` already records `firstInline` values; load it
  with the proxy on and compare them with the later values. For workers, add
  `try { new Worker('x.js') } catch (e) { … }` to the first inline script.
- **Fix:** deliver the config synchronously so there is no pending state. Cheapest way: the bridge
  caches the last pushed config per origin (for example in `sessionStorage` under a random-looking
  key, or `window.name`-free equivalent) and `main.js` reads it at start; the asynchronous storage
  read then only confirms or corrects it. The first page load on an origin still has the gap, later
  loads and all same-origin frames do not. With the extension off, the cache says "inactive" and the
  page starts native.
- **Decision needed:** the cached config is readable by the page. It holds nothing the page cannot
  observe already (timezone, locale, the per-site seed), but the whitelist must stay out of it (it
  already is: `bridge.ts:121`).
- **Depends on:** nothing, but B7 uses the same mechanism.
- **Status (partly fixed):** `src/content/startup.ts`. The bridge keeps the last active timezone,
  locale and languages in `sessionStorage`; `main.js` starts with them. Because the page can write
  that key, the cache can only choose spoofed values. It never turns spoofing off, and anything
  invalid gives the neutral start. So the first load of an origin in a tab, and pages with
  noleaker off or whitelisted, still start neutral. Workers, Service Worker registration and
  geolocation are still refused until the config arrives: a worker needs the prelude, which
  cannot come from page-writable storage. That part needs the deferred worker of B10.
  Checked in Chrome by the e2e test `startup: a reload and a new iframe …`.

### B7. New `about:blank` iframes disagree with their parent page

- **Where:** manifests (`match_about_blank`), `src/content/main.ts:35-37`
- **What happens:** a page creates an empty iframe and reads `frame.contentWindow` at once. The
  frame's realm is either not patched yet (real timezone, real language) or patched in the pending
  state of B6 (UTC). Either way it disagrees with the spoofed parent. Bot checks do exactly this
  comparison. The Cloudflare "Just a moment" page runs on the site's own domain, so it is spoofed in
  both modes and can see the mismatch.
- **Reproduce:** `tests/browser-fixtures/index.html` records `immediateIframe`; compare it with the
  parent's values with the proxy on.
- **Fix:** when `main.js` starts in a frame whose parent is same-origin and already configured,
  take the parent's live config synchronously instead of starting pending. For the "not patched
  yet" case, check in a real browser whether Chrome and Firefox run `document_start` scripts in a
  new `about:blank` frame before the parent can touch it; if not, the parent realm has to patch the
  child (hook the `contentWindow` and `contentDocument` getters) before handing it out.
- **Test:** e2e assertion that `immediateIframe` equals the parent's values.
- **Status (fixed for Chrome):** same-origin frames share `sessionStorage`, so a new frame starts
  with the B6 cache, the same identity as its parent. The Chrome e2e test confirms that a frame read
  at once from the first inline script matches its page. Not yet checked in Firefox.

### B8. `Temporal` is not patched

- **Where:** `src/content/spoof.ts` (no reference to `Temporal` anywhere in `src/`)
- **What happens:** current Chrome and Firefox ship `Temporal`. `Temporal.Now.timeZoneId()`,
  `Temporal.Now.zonedDateTimeISO()`, `Temporal.Now.plainDateTimeISO()`, `plainDateISO()` and
  `plainTimeISO()` use the real system timezone. That is a direct leak of the real timezone, and it
  contradicts the spoofed `Date` and `Intl`, which is a clear tampering signal.
- **Reproduce:** with the proxy on, run `Temporal.Now.timeZoneId()` in the console of a spoofed
  page. It prints the system timezone.
- **Fix:** in `installSpoof`, when `g.Temporal` exists and the timezone shield is on, patch
  `Temporal.Now.timeZoneId` to return the spoofed zone, and patch the `Temporal.Now.*ISO` functions
  to pass the spoofed zone when the caller gave none. The same in workers (it comes for free: the
  worker prelude calls `installSpoof`). Add `Temporal` to the leak-test and audit checks.
- **Test:** unit test in `tests/spoof.test.ts` against a `vm` context with `Temporal`, if the Node
  version in CI has it; otherwise an e2e assertion.

### B9. Extension URLs show in error stacks unless Stealth is on

- **Where:** `src/content/native.ts:108-115` (`guarded`), `:56-69` (`scrubStack`)
- **What happens:** every patched function runs inside `guarded`. An error that passes through it
  keeps the extension's stack frames (`chrome-extension://<id>/content/main.js`) unless
  `native.strict` is true, which is the Stealth setting, off by default. A detector that calls a
  patched function with bad arguments and reads `error.stack` sees the extension and its ID.
- **Reproduce:** on a spoofed page:
  `try { new Intl.DateTimeFormat('x-bad-') } catch (e) { console.log(e.stack) }`.
- **Fix:** always scrub the stack; keep the Stealth switch for the function-shape mirroring only.
- **Decision needed:** why Stealth is off by default is not recorded in the code. If the reason was
  cost or risk of the shape mirroring, scrubbing alone is cheap and safe to enable always.

### B10. The first worker on a CSP site is lost

- **Where:** `src/content/workers.ts:94-104` and `:106-150`
- **What happens:** the wrapper starts the page's worker from a blob URL. If the site's CSP does
  not allow `blob:` for workers (any `script-src` or `worker-src` without `blob:`), the browser
  blocks it. noleaker learns this from the `securitypolicyviolation` event, after the `Worker`
  object was already handed to the page. That first worker never runs. Later workers use the native
  path. In Strict mode the native path is refused, so every worker on such a site throws.
- **What the user sees:** a site feature backed by a worker does not start (first worker), or in
  Strict nothing worker-based works on that site.
- **Reproduce:** a page with `Content-Security-Policy: script-src 'self'` that starts
  `new Worker('/w.js')` and waits for a message.
- **Fix:** return a worker that buffers `postMessage` calls and listeners until the blob worker
  confirms it started; if it fails with a CSP violation instead, start the native worker with the
  original URL and replay the buffer. In Strict the fallback stays refused, but the refusal should
  then be a thrown error at construction for later workers and an `error` event for the first, which
  is what happens today; the fix mainly repairs Compatibility mode.
- **Test:** e2e page with the CSP above; the first worker must answer.

### B11. Workers on Trusted Types sites probably break (unconfirmed)

- **Where:** `src/content/workers.ts:131-135`
- **What happens (expected):** for a same-origin `https:` worker script, the wrapper blob contains
  `importScripts("https://…")` with a plain string. A blob worker inherits the page's CSP. If the
  page has `require-trusted-types-for 'script'`, `importScripts` in the worker needs a
  `TrustedScriptURL`, so the call throws and the worker dies. Commit `4a46483` fixed the
  constructor side only.
- **Confidence:** about 75%. The e2e fixture (`tests/e2e/chrome.e2e.ts:84-91`) only covers blob
  workers and declares a `default` policy, which would hide this.
- **Reproduce:** page with
  `Content-Security-Policy: require-trusted-types-for 'script'; trusted-types p`, a policy `p`, and
  `new Worker(p.createScriptURL('/w.js'))`. Check whether the worker answers.
- **Fix (if confirmed):** fetch the script text on the page side is not possible synchronously, so
  either fall back to the native worker when the page enforces Trusted Types and the script is not a
  blob, or have the prelude create the URL through a policy the page's CSP allows (not possible in
  general). The fallback is the realistic fix.

### B12. The captcha provider list is short

- **Where:** `src/shared/antibot.ts:6-14`, both manifests (`exclude_matches`)
- **What happens:** in Compatibility mode only the listed providers are left untouched. Missing:
  AWS WAF captcha (`*.awswaf.com`), PerimeterX/HUMAN (`*.px-cdn.net`, `*.perimeterx.net`), Yandex
  SmartCaptcha (`smartcaptcha.yandexcloud.net`), Arkose on customer domains (for example OpenAI's),
  Friendly Captcha, MTCaptcha.
- **Fix:** add the missing domains to `CAPTCHA_DOMAINS` and to `exclude_matches` in both manifests
  (the two must stay equal; a test that compares them would stop them drifting).
- **Note:** confirm each domain against the provider's documentation before adding it.

---

## Part 3: smaller bugs

### B13. Routing-list update fails after clicking a sidebar link

- **Where:** `src/background/index.ts:9-12` (`requireOptions`), `src/options/index.html:56-60`
- **What happens:** the check compares `sender.url` with the exact options URL. The sidebar links
  are `#proxies`, `#identity` and so on; after a click the page URL carries the fragment and no
  longer matches. "Download update" and "Approve" then answer
  `Routing-list actions require extension Options.`
- **Reproduce:** open Options, click "Tools" in the sidebar, click the list update button.
- **Fix:** compare without the fragment and query, for example
  `new URL(sender.url).pathname === '/options/index.html'` together with the existing `sender.id`
  check.
- **Test:** unit test of the check with `…/options/index.html#tools`.

### B14. Dates with US zone abbreviations are shifted

- **Where:** `src/content/spoof.ts:249-251` (`TIME_THEN_ZONE`)
- **What happens:** `[a-z]{3,4}t\b` needs four or five letters. `EST`, `EDT`, `CST`, `CDT`, `MST`,
  `MDT`, `PST`, `PDT` have three, so `hasExplicitZone` is false and the string is treated as local
  time and moved to the spoofed zone. Checked in Node: `"Mon, 01 Jan 2024 10:00:00 EST"` parses
  natively and is not detected as zoned.
- **Fix:** `[a-z]{2,4}t\b`.
- **Test:** add the eight abbreviations to `tests/spoof.test.ts`: `new Date('… EST')` must give the
  same instant with and without spoofing.

### B15. Unsaved text in the options page is overwritten

- **Where:** `src/options/main.ts:55-57` (`fill`), `:135-137` (`fillInput`), called from `render`
- **What happens:** `render` runs on every state change and refills the direct-domain and whitelist
  boxes and the override inputs unless the element has focus. The exit check writes the state every
  minute, and any switch on the page writes it too. Text that was typed but not saved disappears as
  soon as the box loses focus and a state change arrives.
- **Reproduce:** type a domain in the whitelist box, do not save, flip any shield switch.
- **Fix:** remember per field whether the user edited it since the last save (an `input` listener
  sets a flag, Save clears it) and skip the refill while the flag is set.

### B16. Persian fonts can be stripped permanently

- **Where:** `src/content/fonts.ts:21-47`, `src/content/main.ts:37`
- **What happens:** when page script sets a font family, Persian families are removed unless the
  page loaded that family itself (`document.fonts`). If the page's `@font-face` stylesheet has not
  been parsed yet at that moment, the family is removed from the inline style for good, and the
  element never uses the web font when it arrives. During the startup state (B6) the shield is on
  for every site, including direct and whitelisted ones and with noleaker off.
- **What the user sees:** Persian sites render in a fallback font, depending on load timing.
- **Fix:** B6 removes the startup part. For the rest, do not rewrite the style; leave the value as
  written and hide the font only from measurement (the existing canvas, `FontFaceSet.check` and
  rect paths), or re-check when `document.fonts` fires `loadingdone`.
- **Decision needed:** rewriting the style is what hides an installed font from width measurement
  of DOM text. Dropping it weakens the shield for that one technique.

---

## Part 4: less certain or low impact

### B17. False "Uncertain" exit on dual-stack servers (unconfirmed)

- **Where:** `src/shared/lookup.ts:71-72`
- **What happens (expected):** the two lookups are compared by IP string. If the proxy server
  reaches Cloudflare over IPv6 and ipwho.is over IPv4, the IPs differ and the exit is marked
  `uncertain` ("one went around the tunnel") although both used the tunnel.
- **Reproduce:** a proxy server with working IPv6; watch the popup.
- **Fix:** compare only when both are the same address family; otherwise compare the country.

### B18. Spoofing starts before the proxy is verified (manual country)

- **Where:** `src/shared/exit.ts:15-22`, `src/shared/spoof-config.ts:58-69`
- **What happens:** with a manual country set, `effectiveExit` returns an exit even when nothing
  was detected yet, so the config becomes active as soon as the proxy is switched on, before the
  first check proved the proxy works. The comment in `spoof-config.ts` says spoofing needs a known,
  reachable exit.
- **Fix:** require `state.detectedExit` (or a completed check) before the override applies.

### B19. Relative URLs fail inside wrapped workers

- **Where:** `src/content/worker-base.ts`
- **What happens:** `fetch`, `importScripts`, `XMLHttpRequest.open`, `Worker`, `WebSocket` and
  `EventSource` are rebased to the original script URL. `new Request('./x')` and dynamic
  `import('./x.js')` are not, so they resolve against the blob URL and fail.
- **Fix:** patch the `Request` constructor the same way. Dynamic `import()` cannot be patched; a
  worker that uses it needs the native fallback, which cannot be known in advance, so document it
  as a limit.

### B20. Whitelist: header rule and page script disagree in frames

- **Where:** `src/background/rules.ts:74-75`, `src/content/bridge.ts:94-96`
- **What happens:** the page script decides by the top-level site; the `Accept-Language` and header
  rules decide by request domain and initiator (frame) domain. A third-party frame on a whitelisted
  site therefore gets unspoofed JavaScript values with the spoofed `Accept-Language` header.
- **Fix:** if `declarativeNetRequest` in the minimum supported browser versions has a top-level
  domain condition, use it for the whitelist; check the current API documentation first. Otherwise
  record it as a known limit.

---

## Also noticed, not bugs to fix now

- `Intl.DisplayNames`, `Intl.DurationFormat` and `BigInt.prototype.toLocaleString` are not covered
  by the locale shield; with no locale argument they use the browser's default locale.
- `new FontFace('x', 'local("Vazir")').load()` still reveals an installed Persian font.
- The popup rebuilds its profile and country dropdowns on every state change, which closes an open
  dropdown.
