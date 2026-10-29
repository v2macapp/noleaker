import { initI18n } from '../shared/i18n';
import { COUNTRIES } from '../shared/countries';
import { hostMatches } from '../shared/domains';
import { effectiveExit } from '../shared/exit';
import { sendMessage } from '../shared/messages';
import { activeProfile, connected } from '../shared/profiles';
import { showEnvNotes } from '../shared/env-notes';
import { getState, onStateChanged, setState, updateState } from '../shared/storage';
import { RULES_STATUS_KEY, type RulesStatus } from '../shared/rules-status';
import { analyzeAudit, auditGate, shieldLabel } from '../audit/analyze';
import { collectAudit } from '../audit/collect';
import type { Groups } from '../shared/iranlist';
import { PERSIAN_FONTS } from '../shared/persian-fonts';
import { describeNote, NOTES_KEY, type TabNote } from '../shared/stale';
import { buildSpoofConfig } from '../shared/spoof-config';
import { summarize } from '../shared/status';
import type { State } from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toggle = $<HTMLInputElement>('toggle');
const select = $<HTMLSelectElement>('profile');
const override = $<HTMLSelectElement>('override');
const connection = $<HTMLSelectElement>('connection');
/** The real system timezone: extension pages are never spoofed. */
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const siteToggle = $<HTMLInputElement>('site-toggle');
let currentHost: string | null = null;

let activeTab: { id: number; url: string } | null = null;
let tabNote: TabNote | undefined;

async function loadTabNote(): Promise<void> {
  const notes = ((await chrome.storage.session.get(NOTES_KEY))[NOTES_KEY] ?? {}) as Record<
    string,
    TabNote
  >;
  const note = activeTab ? notes[activeTab.id] : undefined;
  tabNote = note && note.url === activeTab?.url ? note : undefined;
}

void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  activeTab = tab?.id !== undefined && tab.url ? { id: tab.id, url: tab.url } : null;
  await loadTabNote();
  try {
    const url = new URL(tab?.url ?? '');
    currentHost = /^https?:$/.test(url.protocol) ? url.hostname : null;
  } catch {
    currentHost = null;
  }
  void getState().then(render);
});

let rulesStatus: RulesStatus | undefined;

// --- exit: refresh button, "checked Ns ago" and the change notice -----------------------------
let checkedAt: number | null = null;
/** A message from the last manual refresh, shown for a few seconds. */
let refreshMsg: { text: string; until: number } | null = null;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)} min ago`;
}

function renderExitNote(): void {
  const note = $('exit-note');
  if (refreshMsg && Date.now() < refreshMsg.until) {
    note.textContent = refreshMsg.text;
  } else {
    refreshMsg = null;
    note.textContent = checkedAt ? `Checked ${ago(Date.now() - checkedAt)}` : '';
  }
}
setInterval(renderExitNote, 1000);

const where = (e: { ip: string; countryCode: string }) =>
  `${COUNTRIES[e.countryCode]?.name ?? e.countryCode} (${e.ip})`;

async function refreshExit(): Promise<void> {
  const button = $<HTMLButtonElement>('refresh');
  button.disabled = true;
  button.classList.add('spinning');
  $('exit-note').textContent = 'Checking…';
  // No answer means the background worker was reloaded or stopped while we asked.
  const result = await sendMessage({ type: 'refreshExit' }).catch(() => undefined);
  button.disabled = false;
  button.classList.remove('spinning');
  const text = !result
    ? 'No answer from the extension. Reload it and try again.'
    : !result.ok
      ? (result.error ?? 'The check failed.')
      : result.changed && result.previous && result.exit
        ? `Exit changed: ${where(result.previous)} → ${where(result.exit)}`
        : 'Exit unchanged.';
  refreshMsg = { text, until: Date.now() + 8000 };
  renderExitNote();
}
$('refresh').addEventListener('click', () => void refreshExit());
$('auto-check').addEventListener(
  'change',
  () => void setState({ autoExitCheck: $<HTMLInputElement>('auto-check').checked }),
);

function render(state: State): void {
  const profile = activeProfile(state);
  select.replaceChildren(
    ...state.profiles.map((p) => {
      const o = new Option(`${p.name} (${p.host}:${p.port})`, p.id);
      o.selected = p.id === state.activeProfileId;
      return o;
    }),
  );
  select.disabled = state.profiles.length === 0;
  const system = state.connection === 'system';
  connection.value = state.connection;
  $('profile-row').hidden = system;
  toggle.disabled = !system && !profile;
  toggle.checked = connected(state);
  const on = toggle.checked;
  const summary = summarize(state, rulesStatus);
  document.body.dataset.level = summary.level;
  $('tab-note').hidden = !tabNote;
  $('tab-note').textContent = tabNote ? describeNote(tabNote) : '';
  $('status').textContent = summary.label;
  $('power-sub').textContent = !on
    ? system
      ? 'Protection is off'
      : 'Proxy is disabled'
    : state.protectionError
      ? 'Browser controls could not be verified'
      : state.killSwitchActive
        ? system
          ? 'Exit check failed; spoofing is paused'
          : state.routingMode === 'strict'
            ? 'New browsing requests are blocked'
            : 'Proxied requests blocked; direct exceptions remain'
        : system
          ? 'Following the system VPN exit'
          : state.routingMode === 'strict'
            ? 'Strict proxy routing enabled'
            : 'Proxy routing enabled; direct exceptions apply';
  $('hint').textContent = summary.reason;

  const exit = effectiveExit(state);
  const name = exit ? (COUNTRIES[exit.countryCode]?.name ?? exit.countryCode) : '';
  $('exit').textContent = exit
    ? `${exit.ip ?? '?'}\n${name}${exit.overridden ? ' (manual)' : ''}\n${exit.timezone ?? 'unknown timezone'}${exit.timezone && exit.timezone !== SYSTEM_TZ ? `\nYour system: ${SYSTEM_TZ} (hidden from sites)` : ''}`
    : state.killSwitchActive
      ? '—'
      : 'Detecting…';
  $('exit-card').hidden = !on;
  $<HTMLInputElement>('auto-check').checked = state.autoExitCheck;
  checkedAt = state.detectedExit?.detectedAt ?? null;
  renderExitNote();

  $('site-card').hidden = !on || !currentHost;
  if (currentHost) {
    $('site-host').textContent = currentHost;
    siteToggle.checked = !hostMatches(currentHost, state.whitelist);
  }
  override.replaceChildren(
    new Option('Auto-detect', ''),
    ...Object.entries(COUNTRIES)
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([code, c]) => new Option(c.name, code)),
  );
  override.value = state.countryOverride ?? '';
}

toggle.addEventListener('change', () => void setState({ enabled: toggle.checked }));
select.addEventListener('change', () => void setState({ activeProfileId: select.value }));
connection.addEventListener(
  'change',
  () => void setState({ connection: connection.value === 'system' ? 'system' : 'proxy' }),
);
override.addEventListener(
  'change',
  () => void setState({ countryOverride: override.value || null }),
);
siteToggle.addEventListener('change', () => {
  const host = currentHost;
  if (!host) return;
  void updateState((s) => ({
    whitelist: siteToggle.checked
      ? s.whitelist.filter((e) => !hostMatches(host, [e]))
      : [...new Set([...s.whitelist, host])],
  }));
});
$('leaktest').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL('leaktest/index.html') });
});
$('options').addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

async function runAudit(): Promise<void> {
  const button = $<HTMLButtonElement>('audit');
  const message = $('audit-msg');
  const grid = $('audit-grid');
  const detail = $('audit-detail');
  grid.hidden = true;
  grid.replaceChildren();
  detail.replaceChildren();
  message.textContent = '';

  const state = await getState();
  const iranGroups = (await chrome.storage.local.get('iranList')).iranList as Groups | undefined;
  const gate = auditGate(state, activeTab?.url, iranGroups);
  if (!gate.ok) {
    message.textContent = gate.message;
    return;
  }

  button.disabled = true;
  message.textContent = 'Auditing…';
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: activeTab!.id },
      world: 'MAIN',
      func: collectAudit,
      args: [[...PERSIAN_FONTS]],
    });
    const { value: policy } = await chrome.privacy.network.webRTCIPHandlingPolicy.get({});
    const shields = {
      ...state.shields,
      webrtc: state.routingMode === 'strict' || state.shields.webrtc,
    };
    const result = analyzeAudit(
      injected!.result!,
      gate.timezone,
      shields,
      policy,
      buildSpoofConfig(state),
    );
    message.textContent = result.summary;
    for (const c of result.chips) {
      const el = document.createElement('div');
      el.className = 'chip';
      el.dataset.status = c.status;
      el.title =
        c.status === 'off'
          ? 'Shield off'
          : c.status === 'na'
            ? 'Not available in this browser'
            : c.status === 'ok'
              ? 'Hidden from the site'
              : (c.seen ?? '');
      const dot = document.createElement('i');
      el.append(dot, document.createTextNode(c.label));
      grid.append(el);
      if (c.status === 'bad') {
        const li = document.createElement('li');
        const name = document.createElement('b');
        name.textContent = c.label;
        // A failing check with its shield on means the page loaded before the shield applied.
        const fix = shields[c.shield]
          ? 'Reload the tab and audit again.'
          : `Turn on "${shieldLabel(c.shield)}" in settings.`;
        li.append(name, ` — the site sees ${c.seen}. ${fix}`);
        detail.append(li);
      }
    }
    grid.hidden = false;
  } catch {
    message.textContent = 'This page cannot be audited (reload it, or it may be a protected page).';
  } finally {
    button.disabled = false;
  }
}
$('audit').addEventListener('click', () => void runAudit());

void chrome.storage.local.get(RULES_STATUS_KEY).then((r) => {
  rulesStatus = r[RULES_STATUS_KEY] as RulesStatus | undefined;
  void getState().then(render);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[RULES_STATUS_KEY]) {
    rulesStatus = changes[RULES_STATUS_KEY].newValue as RulesStatus | undefined;
    void getState().then(render);
  }
});
onStateChanged(render);
if (__BROWSER__ === 'firefox') showEnvNotes($('private-note'), $('rfp-note'));
void initI18n();
