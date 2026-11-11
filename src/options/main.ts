import { initI18n, LANGUAGES_UI, UI_LANG_KEY, uiLang } from '../shared/i18n';
import { removeProfile, upsertProfile } from '../shared/profiles';
import type { IranListMeta } from '../shared/iranlist';
import { parseDomainLines } from '../shared/domains';
import { sendMessage } from '../shared/messages';
import { clearLog, formatLog, LOG_KEY, readLog } from '../shared/log';
import { SHIELDS } from '../shared/shields';
import { COUNTRY_PROFILES } from '../shared/country-profiles';
import { autoIdentity } from '../shared/identity';
import { checkOverrides } from '../shared/override-check';
import { NO_OVERRIDES, validateOverrideInput } from '../shared/overrides';
import { exportSettings, parseSettings } from '../shared/settings';
import { showEnvNotes } from '../shared/env-notes';
import { getState, onStateChanged, setState, updateState } from '../shared/storage';
import type { State } from '../shared/types';
import { validateCredentials, validateProfile } from '../shared/validate';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const nameEl = $<HTMLInputElement>('name');
const hostEl = $<HTMLInputElement>('host');
const portEl = $<HTMLInputElement>('port');
// SOCKS authentication works only through Firefox's proxy API; Chrome's PAC cannot carry it.
const AUTH = __BROWSER__ === 'firefox';
if (AUTH) {
  for (const el of document.querySelectorAll<HTMLElement>('.auth')) el.hidden = false;
  $('auth-foot').textContent = 'optional username and password';
}

let editingId: string | null = null;

function resetForm(): void {
  editingId = null;
  form.reset();
  $('form-title').textContent = 'Add proxy';
  $('save').textContent = 'Add';
  $('cancel').hidden = true;
  $('error').textContent = '';
}

function button(label: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn small ${extra}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const extraEl = $<HTMLTextAreaElement>('extra');
const whitelistEl = $<HTMLTextAreaElement>('whitelist');
const META_KEY = 'iranListMeta';

/** Fields typed into since their last save (B15): a state change must not overwrite them. */
const edited = new WeakSet<EventTarget>();
document.addEventListener('input', (e) => e.target && edited.add(e.target));
const untouched = (el: HTMLElement) => document.activeElement !== el && !edited.has(el);

/** Fill a textarea from state unless the user is editing it. */
function fill(el: HTMLTextAreaElement, domains: string[]): void {
  if (untouched(el)) el.value = domains.join('\n');
}

function renderMeta(meta: IranListMeta | undefined): void {
  $('iran-meta').textContent = meta
    ? `${meta.count.toLocaleString('en-US')} domains · ${meta.source === 'bundled' ? 'bundled snapshot' : 'updated'} ${new Date(meta.updatedAt).toLocaleDateString('en-US')}`
    : 'Not loaded yet. It loads when the proxy is first turned on.';
}

function bindDomainSave(
  button: string,
  textarea: HTMLTextAreaElement,
  msg: string,
  key: 'extraDirectDomains' | 'whitelist',
): void {
  $(button).addEventListener('click', () => {
    const { domains, invalid } = parseDomainLines(textarea.value);
    $(msg).textContent = invalid.length ? `Ignored: ${invalid.join(', ')}` : 'Saved';
    textarea.value = domains.join('\n');
    edited.delete(textarea);
    void updateState(() => ({ [key]: domains }));
  });
}

function renderShields(state: State): void {
  for (const group of ['country', 'fingerprint'] as const) {
    $(`shields-${group}`).replaceChildren(
      ...SHIELDS.filter((shield) => shield.group === group).map((shield) => {
        const row = document.createElement('label');
        row.className = 'fp-row';
        const text = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'fp-name';
        title.textContent = shield.label;
        if (!shield.implemented) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'Soon';
          title.append(badge);
        }
        const tip = document.createElement('button');
        tip.type = 'button';
        tip.className = 'hint';
        tip.textContent = '?';
        tip.setAttribute('aria-label', `About ${shield.label}`);
        tip.dataset.tip = shield.hint;
        title.append(tip);
        const sub = document.createElement('div');
        sub.className = 'muted';
        sub.textContent = shield.description;
        text.append(title, sub);
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'switch';
        const mandatory = state.routingMode === 'strict' && shield.key === 'webrtc';
        input.checked = mandatory || state.shields[shield.key];
        input.disabled = !shield.implemented || mandatory;
        if (mandatory)
          sub.textContent =
            'Required in strict privacy mode: browser policy and relay-only page API.';
        input.addEventListener('change', () => {
          void updateState((s) => ({ shields: { ...s.shields, [shield.key]: input.checked } }));
        });
        row.append(text, input);
        return row;
      }),
    );
  }
}

const ov = {
  timezone: $<HTMLInputElement>('ov-timezone'),
  locale: $<HTMLInputElement>('ov-locale'),
  accept: $<HTMLInputElement>('ov-accept'),
  lat: $<HTMLInputElement>('ov-lat'),
  lon: $<HTMLInputElement>('ov-lon'),
  country: $<HTMLSelectElement>('ov-country'),
  mode: $<HTMLSelectElement>('locale-mode'),
};

function fillInput(el: HTMLInputElement, value: string): void {
  if (untouched(el)) el.value = value;
}

/** "currently automatic: X" or "currently manual: X" for one field. */
function currentLine(id: string, manual: string | null, auto: string): void {
  $(id).textContent = manual
    ? `currently manual: ${manual} (automatic would be ${auto})`
    : `currently automatic: ${auto}`;
}

const point = (c: { latitude: number; longitude: number } | null) =>
  c ? `${c.latitude}, ${c.longitude}` : 'unknown until the exit is detected';

function renderOverrides(state: State): void {
  $<HTMLSelectElement>('routing-mode').value = state.routingMode;
  $<HTMLInputElement>('list-updates').checked = state.listUpdates;
  $<HTMLInputElement>('list-updates').disabled = state.routingMode === 'strict';
  $<HTMLButtonElement>('iran-update').disabled =
    state.routingMode === 'strict' || !state.listUpdates;
  $<HTMLInputElement>('stealth').checked = state.stealth;
  const o = state.overrides;
  const auto = autoIdentity(state);
  ov.mode.value = state.localeMode;
  fillInput(ov.timezone, o.timezone ?? '');
  fillInput(ov.locale, o.locale ?? '');
  fillInput(ov.accept, o.acceptLanguage ?? '');
  fillInput(ov.lat, o.coordinates ? String(o.coordinates.latitude) : '');
  fillInput(ov.lon, o.coordinates ? String(o.coordinates.longitude) : '');
  currentLine(
    'ov-timezone-current',
    o.timezone,
    auto.timezone ?? 'unknown until the exit is detected',
  );
  currentLine('ov-locale-current', o.locale, auto.locale);
  currentLine('ov-accept-current', o.acceptLanguage, auto.acceptLanguage);
  currentLine(
    'ov-coords-current',
    o.coordinates ? point(o.coordinates) : null,
    point(auto.coordinates),
  );

  const warnings = checkOverrides(state);
  const box = $('override-warnings');
  box.hidden = warnings.length === 0;
  const list = document.createElement('ul');
  for (const w of warnings) {
    const li = document.createElement('li');
    li.textContent = w.message;
    list.append(li);
  }
  box.replaceChildren(list);
}

function initOverrides(): void {
  $('routing-mode').addEventListener('change', () => {
    void updateState(() => ({
      routingMode:
        $<HTMLSelectElement>('routing-mode').value === 'strict' ? 'strict' : 'compatibility',
      controlsVerifiedAt: null,
    }));
  });
  $('list-updates').addEventListener('change', () => {
    void updateState(() => ({ listUpdates: $<HTMLInputElement>('list-updates').checked }));
  });
  $('stealth').addEventListener('change', () => {
    void updateState(() => ({ stealth: $<HTMLInputElement>('stealth').checked }));
  });
  const zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  $('tz-list').replaceChildren(...(zones?.('timeZone') ?? []).map((z) => new Option(z)));
  const locales = [...new Set(Object.values(COUNTRY_PROFILES).map((p) => p.locale))].sort();
  $('locale-list').replaceChildren(...locales.map((l) => new Option(l)));
  ov.country.append(
    ...Object.entries(COUNTRY_PROFILES)
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([code, p]) => new Option(`Use ${p.name}`, code)),
  );

  ov.country.addEventListener('change', () => {
    const p = COUNTRY_PROFILES[ov.country.value];
    if (!p) return;
    ov.lat.value = String(p.latitude);
    ov.lon.value = String(p.longitude);
    edited.add(ov.lat).add(ov.lon);
  });
  for (const el of [ov.lat, ov.lon]) el.addEventListener('input', () => (ov.country.value = ''));
  ov.mode.addEventListener('change', () => {
    void updateState(() => ({ localeMode: ov.mode.value === 'country' ? 'country' : 'english' }));
  });

  const clearErrors = () => {
    for (const id of [
      'ov-timezone-error',
      'ov-locale-error',
      'ov-accept-error',
      'ov-coords-error',
    ]) {
      $(id).textContent = '';
    }
    $('ov-msg').textContent = '';
  };

  $('ov-save').addEventListener('click', () => {
    clearErrors();
    const { overrides, errors } = validateOverrideInput({
      timezone: ov.timezone.value,
      locale: ov.locale.value,
      acceptLanguage: ov.accept.value,
      latitude: ov.lat.value,
      longitude: ov.lon.value,
    });
    $('ov-timezone-error').textContent = errors.timezone ?? '';
    $('ov-locale-error').textContent = errors.locale ?? '';
    $('ov-accept-error').textContent = errors.acceptLanguage ?? '';
    $('ov-coords-error').textContent = errors.coordinates ?? '';
    if (Object.keys(errors).length > 0) return;
    for (const el of [ov.timezone, ov.locale, ov.accept, ov.lat, ov.lon]) edited.delete(el);
    void updateState(() => ({ overrides })).then(() => ($('ov-msg').textContent = 'Saved'));
  });
  $('ov-reset').addEventListener('click', () => {
    clearErrors();
    for (const el of [ov.timezone, ov.locale, ov.accept, ov.lat, ov.lon]) {
      el.value = '';
      edited.delete(el);
    }
    ov.country.value = '';
    void updateState(() => ({ overrides: { ...NO_OVERRIDES } })).then(
      () => ($('ov-msg').textContent = 'Back to automatic'),
    );
  });
}
initOverrides();
initNav();

/** Highlight the sidebar link of the section that is on screen. */
function initNav(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('#nav a'));
  const groups = links
    .map((a) => document.getElementById(a.hash.slice(1)))
    .filter((el): el is HTMLElement => el !== null);
  const show = (id: string) =>
    links.forEach((a) => a.classList.toggle('active', a.hash === `#${id}`));
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting);
      if (visible.length) show(visible[0]!.target.id);
    },
    { rootMargin: '-20% 0px -65% 0px' },
  );
  groups.forEach((g) => observer.observe(g));
}

function render(state: State): void {
  renderOverrides(state);
  renderShields(state);
  fill(extraEl, state.extraDirectDomains);
  fill(whitelistEl, state.whitelist);
  $('empty').hidden = state.profiles.length > 0;
  $('list').replaceChildren(
    ...state.profiles.map((p) => {
      const tr = document.createElement('tr');
      for (const [i, text] of [p.name, `${p.host}:${p.port}`].entries()) {
        const td = document.createElement('td');
        if (i === 1) td.className = 'host';
        td.textContent = text;
        tr.append(td);
      }
      const actions = document.createElement('td');
      actions.className = 'actions-cell';
      actions.append(
        button('Edit', () => {
          editingId = p.id;
          nameEl.value = p.name;
          hostEl.value = p.host;
          portEl.value = String(p.port);
          if (AUTH) {
            $<HTMLInputElement>('username').value = p.username ?? '';
            $<HTMLInputElement>('password').value = p.password ?? '';
          }
          $('form-title').textContent = 'Edit proxy';
          $('save').textContent = 'Save';
          $('cancel').hidden = false;
        }),
        button(
          'Delete',
          () => {
            if (confirm(`Delete "${p.name}"?`)) {
              if (editingId === p.id) resetForm();
              void updateState((s) => removeProfile(s, p.id));
            }
          },
          'danger',
        ),
      );
      tr.append(actions);
      return tr;
    }),
  );
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameEl.value.trim();
  const host = hostEl.value.trim().replace(/^\[|\]$/g, '');
  const port = Number(portEl.value);
  const error =
    validateProfile(name, host, port) ??
    (AUTH
      ? validateCredentials(
          $<HTMLInputElement>('username').value,
          $<HTMLInputElement>('password').value,
        )
      : null);
  $('error').textContent = error ?? '';
  if (error) return;
  const id = editingId ?? crypto.randomUUID();
  void updateState((s) => {
    const fields = { id, name, host, port };
    if (AUTH) {
      const username = $<HTMLInputElement>('username').value;
      const auth = username ? { username, password: $<HTMLInputElement>('password').value } : {};
      return upsertProfile(s, { ...fields, ...auth });
    }
    // Chrome keeps credentials it cannot use (from an imported Firefox file) untouched.
    return upsertProfile(s, { ...s.profiles.find((p) => p.id === id), ...fields });
  }).then(resetForm);
});
$('cancel').addEventListener('click', resetForm);

bindDomainSave('extra-save', extraEl, 'extra-msg', 'extraDirectDomains');
bindDomainSave('whitelist-save', whitelistEl, 'whitelist-msg', 'whitelist');

$('iran-update').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('iran-update');
  button.disabled = true;
  $('iran-error').textContent = '';
  // No answer means the background worker was reloaded or stopped while we asked.
  const result = await sendMessage({ type: 'updateIranList' }).catch(() => undefined);
  if (!result) {
    $('iran-error').textContent =
      'No answer from the extension. Reload it on the extensions page and try again.';
  } else if (!result.ok) {
    $('iran-error').textContent = result.error ?? 'Update failed.';
  }
  if (result?.ok && result.candidateId) {
    const panel = document.createElement('div');
    const notice = document.createElement('p');
    notice.textContent =
      result.warning ??
      'Update downloaded. Review the changes and approve to replace the current list.';
    const review = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Unsigned candidate: ${result.added?.length ?? 0} added, ${result.removed?.length ?? 0} removed. Review all changes.`;
    const diff = document.createElement('pre');
    diff.textContent =
      [
        ...(result.added ?? []).map((d) => `+ ${d}`),
        ...(result.removed ?? []).map((d) => `- ${d}`),
      ].join('\n') || 'No membership changes.';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve and replace list';
    const approvalStatus = document.createElement('p');
    approvalStatus.setAttribute('role', 'status');
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      const applied = await sendMessage({
        type: 'approveIranList',
        candidateId: result.candidateId!,
      }).catch(() => undefined);
      approvalStatus.textContent = applied?.ok
        ? 'Reviewed list applied.'
        : (applied?.error ?? 'Approval failed. Download and review again.');
      if (applied?.ok) {
        review.remove();
        approve.remove();
        notice.remove();
      } else approve.disabled = false;
    });
    review.append(summary, diff);
    panel.append(notice, review, approve, approvalStatus);
    $('iran-error').replaceChildren(panel);
  }
  button.disabled = false;
});

void chrome.storage.local
  .get(META_KEY)
  .then((r) => renderMeta(r[META_KEY] as IranListMeta | undefined));
chrome.storage.onChanged.addListener((changes) => {
  if (changes[META_KEY]) renderMeta(changes[META_KEY].newValue as IranListMeta | undefined);
});

void getState().then(render);
onStateChanged(render);
if (__BROWSER__ === 'firefox') showEnvNotes($('private-note'), $('rfp-note'));

const backupMsg = (text: string, ok = false) => {
  $('backup-msg').textContent = text;
  $('backup-msg').style.color = ok ? 'var(--ok)' : '';
};

$('export').addEventListener('click', () => {
  void getState().then((state) => {
    const url = URL.createObjectURL(
      new Blob([exportSettings(state)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'noleaker-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  });
});

const importFile = $<HTMLInputElement>('import-file');
$('import').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  importFile.value = '';
  if (!file) return;
  const result = parseSettings(await file.text());
  if (!result.ok) return backupMsg(result.error);
  if (!confirm('Replace your proxies, direct domains and whitelist with the imported ones?'))
    return;
  await setState(result.patch);
  backupMsg(`Imported ${result.patch.profiles?.length ?? 0} proxies.`, true);
});

async function renderLog(): Promise<void> {
  const entries = await readLog();
  $('log').textContent = entries.length ? formatLog(entries) : 'No events yet.';
}
$('log-copy').addEventListener('click', () => {
  void readLog().then((entries) => navigator.clipboard.writeText(formatLog(entries)));
});
$('log-clear').addEventListener('click', () => void clearLog());
chrome.storage.onChanged.addListener((changes) => {
  if (changes[LOG_KEY]) void renderLog();
});
void renderLog();
void initI18n();

const langSelect = $<HTMLSelectElement>('ui-lang');
for (const [code, name] of Object.entries(LANGUAGES_UI)) langSelect.add(new Option(name, code));
void uiLang().then((lang) => (langSelect.value = lang));
langSelect.addEventListener('change', () => {
  void chrome.storage.local.set({ [UI_LANG_KEY]: langSelect.value }).then(() => location.reload());
});
