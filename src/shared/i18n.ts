/** UI languages. Translations live in public/i18n/<code>.json, keyed by the English text. */
export const LANGUAGES_UI: Record<string, string> = {
  en: 'English',
  fa: 'فارسی',
  zh: '中文',
  'zh-Hant': '繁體中文',
  ru: 'Русский',
  fr: 'Français',
  pt: 'Português',
  de: 'Deutsch',
  es: 'Español',
};
export const UI_LANG_KEY = 'uiLang';
const ATTRS = ['placeholder', 'aria-label', 'data-tip', 'title'];

export async function uiLang(): Promise<string> {
  const lang =
    ((await chrome.storage.local.get(UI_LANG_KEY))[UI_LANG_KEY] as string | undefined) ??
    navigator.language.slice(0, 2);
  return lang in LANGUAGES_UI ? lang : 'en';
}

/**
 * Translates the page in place, and keeps translating text the page code sets later.
 * shortcut: exact-text lookup only, so strings built with variables stay English; add
 * placeholders to the dictionaries if those need translating.
 */
export async function initI18n(): Promise<void> {
  const lang = await uiLang();
  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'fa' ? 'rtl' : 'ltr';
  if (lang === 'en') return;
  let dict: Record<string, string>;
  try {
    dict = await (await fetch(chrome.runtime.getURL(`i18n/${lang}.json`))).json();
  } catch {
    return; // missing dictionary: stay in English
  }
  const t = (s: string): string | undefined => dict[s.replace(/\s+/g, ' ').trim()];

  const text = (n: Text): void => {
    if (n.parentElement?.closest('textarea, code, script, style')) return;
    const v = t(n.data);
    // Keep the surrounding spaces: they separate this node from inline neighbours.
    if (v) n.data = n.data.replace(/^(\s*).*?(\s*)$/s, `$1${v}$2`);
  };
  const attrs = (el: Element): void => {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      const tr = v && t(v);
      if (tr) el.setAttribute(a, tr);
    }
  };
  const walk = (node: Node): void => {
    if (node instanceof Text) return text(node);
    if (!(node instanceof Element)) return;
    attrs(node);
    node.childNodes.forEach(walk);
  };

  walk(document.body);
  document.title = t(document.title) ?? document.title;
  // A translated value is never a key itself, so these writes do not loop.
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(walk);
      else if (r.type === 'characterData') text(r.target as Text);
      else attrs(r.target as Element);
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributeFilter: ATTRS,
  });
}
