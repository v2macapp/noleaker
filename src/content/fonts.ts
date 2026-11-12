/* eslint-disable @typescript-eslint/no-explicit-any */
import { isPersianFont, normalizeFamily } from '../shared/persian-fonts';
import type { SpoofConfig } from '../shared/spoof-config';
import { createNative } from './native';

const SIZE =
  /(^|\s)(\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|%|cm|mm|in|q)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)(\/\S+)?\s+/i;

/** What a page sees when none of its families exist: the browser's default font. */
const ABSENT = 'serif';

/**
 * Hides Persian font families by removing them from font stacks, so a page measuring text
 * sees the same widths as on a machine without them. A family the page loaded itself with
 * `@font-face` (listed in `document.fonts`) is never touched.
 */
export function installFonts(g: any): { setConfig(config: SpoofConfig | null): void } {
  const { patch, patchSetter, define } = createNative(g);
  let on = false;

  const loadedByPage = (): Set<string> => {
    const set = new Set<string>();
    try {
      g.document.fonts.forEach((face: any) => set.add(normalizeFamily(face.family)));
    } catch {
      // no document.fonts: nothing was loaded by the page
    }
    return set;
  };

  /** Drop Persian families from a comma-separated family list. `text` is unchanged if none. */
  function filterFamilies(list: string): { text: string; changed: boolean } {
    const mine = loadedByPage();
    const kept = list
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f === '' || !isPersianFont(f) || mine.has(normalizeFamily(f)));
    const changed = kept.length !== list.split(',').length;
    return { text: changed ? kept.join(', ') : list, changed };
  }

  /** `font-family` value. */
  const family = (value: string): string => {
    if (!on) return value;
    const r = filterFamilies(value);
    return r.changed ? r.text || ABSENT : value;
  };

  /** `font` shorthand: "italic 12px/1.5 IRANSans, Arial". */
  const shorthand = (value: string): string => {
    if (!on) return value;
    const m = SIZE.exec(value);
    if (!m) return value;
    const cut = m.index + m[0].length;
    const r = filterFamilies(value.slice(cut));
    return r.changed ? value.slice(0, cut) + (r.text || ABSENT) : value;
  };

  /** Inline style text: rewrite every font-family and font declaration. */
  const styleText = (value: string): string => {
    if (!on) return value;
    return value
      .replace(/(font-family\s*:\s*)([^;]+)/gi, (_m, head, list) => head + family(list))
      .replace(/((?<![-\w])font\s*:\s*)([^;]+)/gi, (_m, head, list) => head + shorthand(list));
  };

  // B16: a family hidden before the page loaded it (its @font-face not parsed yet, or the startup
  // state on a site where the shield turns out off) is put back when fonts finish loading or the
  // shield turns off, unless the page has changed that value since.
  // shortcut: a restored value loses an !important priority; keep it if a site relies on that.
  type Kind = 'fontFamily' | 'font';
  const setters: Partial<Record<Kind, (this: any, v: unknown) => void>> = {};
  const tracked = new WeakMap<object, Map<Kind, { raw: string; value: string; written: string }>>();
  const refs = new Set<WeakRef<object>>();
  const read = (decl: any, kind: Kind): string => {
    try {
      return String(Reflect.get(propsProto, kind, decl) ?? '');
    } catch {
      return '';
    }
  };
  const filtered = (kind: Kind, raw: string) => (kind === 'font' ? shorthand(raw) : family(raw));
  function note(decl: any, kind: Kind, raw: string, value: string): void {
    if (!decl || typeof decl !== 'object') return;
    let m = tracked.get(decl);
    if (value === raw) return void m?.delete(kind);
    if (!m) {
      tracked.set(decl, (m = new Map()));
      refs.add(new WeakRef(decl));
    }
    m.set(kind, { raw, value, written: read(decl, kind) });
  }
  /** The last font-family and font declarations of style text. */
  function noteText(decl: any, text: string): void {
    for (const [kind, re] of [
      ['fontFamily', /font-family\s*:\s*([^;]+)/gi],
      ['font', /(?<![-\w])font\s*:\s*([^;]+)/gi],
    ] as const) {
      let raw = '';
      for (const m of text.matchAll(re)) raw = m[1]!.replace(/\s*!\s*important\s*$/i, '').trim();
      note(decl, kind, raw, raw && filtered(kind, raw));
    }
  }
  function restore(): void {
    for (const ref of refs) {
      const decl = ref.deref();
      const m = decl && tracked.get(decl);
      if (!m?.size) {
        refs.delete(ref);
        continue;
      }
      for (const [kind, e] of m) {
        if (read(decl, kind) !== e.written) {
          m.delete(kind); // the page wrote it again since
          continue;
        }
        const value = filtered(kind, e.raw);
        if (value === e.value) continue;
        setters[kind]?.call(decl, value);
        note(decl, kind, e.raw, value);
      }
    }
  }
  g.document?.fonts?.addEventListener?.('loadingdone', restore);

  const styleProto: any = g.CSSStyleDeclaration?.prototype;
  // Newer engines define the property accessors on a subclass (Chrome: CSSStyleProperties,
  // Firefox: CSS2Properties), not on CSSStyleDeclaration itself.
  const propsProto: any =
    [g.CSSStyleProperties, g.CSS2Properties, g.CSSStyleDeclaration]
      .map((c) => c?.prototype)
      .find((p) => p && Object.getOwnPropertyDescriptor(p, 'fontFamily')) ?? styleProto;
  if (styleProto) {
    patchSetter(propsProto, 'fontFamily', (orig) => {
      setters.fontFamily = orig;
      return function (this: any, v: unknown) {
        const value = family(String(v));
        orig.call(this, value);
        note(this, 'fontFamily', String(v), value);
      };
    });
    patchSetter(propsProto, 'font', (orig) => {
      setters.font = orig;
      return function (this: any, v: unknown) {
        const value = shorthand(String(v));
        orig.call(this, value);
        note(this, 'font', String(v), value);
      };
    });
    patchSetter(
      styleProto,
      'cssText',
      (orig) =>
        function (this: any, v: unknown) {
          orig.call(this, styleText(String(v)));
          noteText(this, String(v));
        },
    );
    patch(
      styleProto,
      'setProperty',
      (orig) =>
        function (this: any, name: unknown, value: unknown, ...rest: unknown[]) {
          const prop = String(name).toLowerCase();
          const kind = prop === 'font-family' ? 'fontFamily' : prop === 'font' ? 'font' : null;
          const v = kind ? filtered(kind, String(value)) : value;
          const result = orig.call(this, name, v, ...rest);
          if (kind) note(this, kind, String(value), v as string);
          return result;
        },
    );
  }

  const elementProto: any = g.Element?.prototype;
  if (elementProto) {
    patch(
      elementProto,
      'setAttribute',
      (orig) =>
        function (this: any, name: unknown, value: unknown) {
          if (String(name).toLowerCase() !== 'style') return orig.call(this, name, value);
          const result = orig.call(this, name, styleText(String(value)));
          noteText(this.style, String(value));
          return result;
        },
    );
  }

  for (const name of ['CanvasRenderingContext2D', 'OffscreenCanvasRenderingContext2D']) {
    const proto: any = g[name]?.prototype;
    if (proto) {
      patchSetter(
        proto,
        'font',
        (orig) =>
          function (this: any, v: unknown) {
            orig.call(this, shorthand(String(v)));
          },
      );
    }
  }

  const faceSetProto: any = g.FontFaceSet?.prototype;
  if (faceSetProto?.check) {
    patch(
      faceSetProto,
      'check',
      (orig) =>
        function (this: any, font: unknown, ...rest: unknown[]) {
          return orig.call(this, shorthand(String(font)), ...rest);
        },
    );
  }

  // Local Font Access API: installed fonts, minus the Persian ones.
  if (typeof g.queryLocalFonts === 'function') {
    patch(
      g,
      'queryLocalFonts',
      (orig) =>
        async function (this: any, ...args: unknown[]) {
          const fonts: any[] = await orig.apply(this, args);
          return on
            ? fonts.filter((f) => !isPersianFont(f.family) && !isPersianFont(f.fullName))
            : fonts;
        },
    );
  }

  void define;
  return {
    setConfig(config) {
      const was = on;
      on = !!config?.active && config.shields.fonts;
      if (was && !on) restore();
    },
  };
}
