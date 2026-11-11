/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SpoofConfig } from '../shared/spoof-config';
import { normalizeShields } from '../shared/shields';
import { createNative } from './native';

/**
 * Timezone and locale spoofing for one JS realm. `g` is the global object to patch, which
 * lets the unit tests run it against a fresh `vm` context. Every patch checks the current
 * config at call time and falls through to the native behaviour when spoofing is paused.
 */
export function installSpoof(g: any): { setConfig(config: SpoofConfig | null): void } {
  let config: SpoofConfig | null = null;
  /** Timezone shield. */
  const on = (): boolean => config !== null && config.shields.timezone;
  /** Locale shield. */
  const localeOn = (): boolean => config !== null && config.shields.locale;
  const tz = (): string => config!.timezone;

  const NativeDate: DateConstructor = g.Date;
  const DateProto: any = NativeDate.prototype;
  const NativeDTF: typeof Intl.DateTimeFormat = g.Intl.DateTimeFormat;
  const nativeGetTime = DateProto.getTime;
  const nativeSetTime = DateProto.setTime;
  const nativeParse = NativeDate.parse;
  const nativeTzOffset = DateProto.getTimezoneOffset;

  const { patch, patchCtor, patchGetter, patchProxy } = createNative(g);

  // ---- timezone math -----------------------------------------------------------------
  const formatters = new Map<string, Intl.DateTimeFormat>();
  const nameFormatters = new Map<string, Intl.DateTimeFormat>();
  const partsFormatter = (zone: string) => {
    let f = formatters.get(zone);
    if (!f) {
      f = new NativeDTF('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
      formatters.set(zone, f);
    }
    return f;
  };

  /** Offset (ms, east positive) of the spoofed zone at the UTC instant `utcMs`. */
  function offsetMs(utcMs: number): number {
    const v: Record<string, number> = {};
    for (const p of partsFormatter(tz()).formatToParts(utcMs)) {
      if (p.type !== 'literal') v[p.type] = Number(p.value);
    }
    const asUtc = NativeDate.UTC(v.year!, v.month! - 1, v.day!, v.hour!, v.minute!, v.second!);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  }
  /** UTC ms -> "wall clock" ms in the spoofed zone, expressed as if it were UTC. */
  const toLocal = (utcMs: number): number => utcMs + offsetMs(utcMs);
  /** Wall-clock ms in the spoofed zone (as if UTC) -> real UTC ms. */
  function toUtc(localMs: number): number {
    const guess = localMs - offsetMs(localMs);
    return localMs - offsetMs(guess);
  }

  // ---- Date getters / setters --------------------------------------------------------
  const GETTERS = [
    'FullYear',
    'Month',
    'Date',
    'Day',
    'Hours',
    'Minutes',
    'Seconds',
    'Milliseconds',
  ];
  for (const part of GETTERS) {
    patch(
      DateProto,
      `get${part}`,
      (orig) =>
        function (this: any) {
          const t = nativeGetTime.call(this);
          if (!on() || Number.isNaN(t)) return orig.call(this);
          return DateProto[`getUTC${part}`].call(new NativeDate(toLocal(t)));
        },
    );
  }
  patch(
    DateProto,
    'getYear',
    (orig) =>
      function (this: any) {
        const t = nativeGetTime.call(this);
        if (!on() || Number.isNaN(t)) return orig.call(this);
        return new NativeDate(toLocal(t)).getUTCFullYear() - 1900;
      },
  );
  patch(
    DateProto,
    'getTimezoneOffset',
    (orig) =>
      function (this: any) {
        const t = nativeGetTime.call(this);
        if (!on() || Number.isNaN(t)) return orig.call(this);
        const minutes = offsetMs(t) / 60000;
        return minutes === 0 ? 0 : -minutes;
      },
  );
  for (const part of ['FullYear', 'Month', 'Date', 'Hours', 'Minutes', 'Seconds', 'Milliseconds']) {
    patch(
      DateProto,
      `set${part}`,
      (orig) =>
        function (this: any, ...args: any[]) {
          if (!on()) return orig.apply(this, args);
          const t = nativeGetTime.call(this);
          if (Number.isNaN(t) && part !== 'FullYear') return orig.apply(this, args);
          const tmp = new NativeDate(Number.isNaN(t) ? 0 : toLocal(t));
          (tmp as any)[`setUTC${part}`](...args);
          const local = nativeGetTime.call(tmp);
          return nativeSetTime.call(this, Number.isNaN(local) ? NaN : toUtc(local));
        },
    );
  }

  // ---- Date string methods -----------------------------------------------------------
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');

  function zoneName(utcMs: number): string {
    let f = nameFormatters.get(tz());
    if (!f) {
      f = new NativeDTF('en-US', { timeZone: tz(), timeZoneName: 'long' });
      nameFormatters.set(tz(), f);
    }
    return f.formatToParts(utcMs).find((p) => p.type === 'timeZoneName')?.value ?? tz();
  }
  function datePart(l: Date): string {
    const y = l.getUTCFullYear();
    const year = y >= 0 ? pad(y, 4) : `-${pad(-y, 6)}`;
    return `${DAYS[l.getUTCDay()]} ${MONTHS[l.getUTCMonth()]} ${pad(l.getUTCDate())} ${year}`;
  }
  function timePart(t: number, l: Date): string {
    const off = offsetMs(t) / 60000;
    const abs = Math.abs(off);
    const sign = off < 0 ? '-' : '+';
    const hms = `${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}:${pad(l.getUTCSeconds())}`;
    return `${hms} GMT${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)} (${zoneName(t)})`;
  }
  const stringMethod = (name: string, build: (t: number, l: Date) => string) =>
    patch(
      DateProto,
      name,
      (orig) =>
        function (this: any) {
          const t = nativeGetTime.call(this);
          if (!on() || Number.isNaN(t)) return orig.call(this);
          return build(t, new NativeDate(toLocal(t)));
        },
    );
  stringMethod('toString', (t, l) => `${datePart(l)} ${timePart(t, l)}`);
  stringMethod('toDateString', (_t, l) => datePart(l));
  stringMethod('toTimeString', (t, l) => timePart(t, l));

  // ---- Intl / locale ------------------------------------------------------------------
  /**
   * Fill in what the caller did not choose: the locale, the timezone (dates), and, when no options
   * were passed at all, the gregorian calendar and latin digits so a Persian locale cannot show
   * Persian dates or numerals.
   */
  function withDefaults(args: any[], kind: 'date' | 'number' | 'other', optionsIndex = 1): any[] {
    const locale = localeOn();
    const zone = kind === 'date' && on();
    if (!zone && !locale) return args;
    const out = [...args];
    if (locale && out[optionsIndex - 1] === undefined) out[optionsIndex - 1] = config!.locale;

    const extras: Record<string, string> = {};
    if (zone) extras.timeZone = tz();
    if (locale && out[optionsIndex] === undefined && kind !== 'other') {
      if (kind === 'date') extras.calendar = 'gregory';
      extras.numberingSystem = 'latn';
    }
    const o = out[optionsIndex];
    if (
      Object.keys(extras).length > 0 &&
      (o === undefined || (typeof o === 'object' && o !== null))
    ) {
      const merged = Object.create(o ?? null);
      for (const [key, value] of Object.entries(extras)) {
        if (merged[key] === undefined) merged[key] = value;
      }
      out[optionsIndex] = merged;
    }
    return out;
  }

  patchCtor(g.Intl, 'DateTimeFormat', NativeDTF, (a) => withDefaults(a, 'date'));
  if (g.Intl.NumberFormat) {
    patchCtor(g.Intl, 'NumberFormat', g.Intl.NumberFormat, (a) => withDefaults(a, 'number'));
  }
  for (const name of ['Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'Segmenter']) {
    if (g.Intl[name]) patchCtor(g.Intl, name, g.Intl[name], (a) => withDefaults(a, 'other'));
  }
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    patch(
      DateProto,
      name,
      (orig) =>
        function (this: any, ...args: any[]) {
          return orig.apply(this, withDefaults(args, 'date'));
        },
    );
  }
  patch(
    g.Number.prototype,
    'toLocaleString',
    (orig) =>
      function (this: any, ...args: any[]) {
        return orig.apply(this, withDefaults(args, 'number'));
      },
  );
  patch(
    g.String.prototype,
    'localeCompare',
    (orig) =>
      function (this: any, that: any, ...rest: any[]) {
        return orig.apply(this, [that, ...withDefaults(rest, 'other', 1)]);
      },
  );

  // ---- Date constructor / parse -------------------------------------------------------
  const TIME_THEN_ZONE =
    /\d:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[ap]m)?\s*(?:z\b|[+-]\d{2}(?::?\d{2})?\b|[a-z]{2,4}t\b)/i;
  const hasExplicitZone = (s: string) => /\b(?:GMT|UTC|UT)\b/i.test(s) || TIME_THEN_ZONE.test(s);
  const isDateOnlyIso = (s: string) => /^\s*[+-]?\d{4,6}(?:-\d{2}(?:-\d{2})?)?\s*$/.test(s);

  /** Strings without a zone are parsed as local time; redo that in the spoofed zone. */
  function parseSpoofed(value: string): number {
    const r = nativeParse(value);
    if (!on() || Number.isNaN(r) || isDateOnlyIso(value) || hasExplicitZone(value)) return r;
    const realOffset = -nativeTzOffset.call(new NativeDate(r)) * 60000;
    return toUtc(r + realOffset);
  }
  patch(NativeDate, 'parse', () => (value: any) => parseSpoofed(String(value)));

  patchProxy(g, 'Date', NativeDate, {
    construct(target, args, newTarget) {
      let a = args;
      if (on()) {
        if (args.length >= 2) {
          const utc = (NativeDate.UTC as any)(...args);
          a = [Number.isNaN(utc) ? NaN : toUtc(utc)];
        } else if (args.length === 1 && typeof args[0] === 'string') {
          a = [parseSpoofed(args[0])];
        }
      }
      return Reflect.construct(target, a, newTarget);
    },
    apply(target, thisArg, args) {
      if (!on()) return Reflect.apply(target, thisArg, args);
      const now = NativeDate.now();
      const l = new NativeDate(toLocal(now));
      return `${datePart(l)} ${timePart(now, l)}`;
    },
  });

  // ---- navigator.language(s) ----------------------------------------------------------
  const NavProto: any = g.Navigator?.prototype ?? g.WorkerNavigator?.prototype;
  if (NavProto) {
    let languages: readonly string[] | null = null;
    patchGetter(NavProto, 'language', (orig) => (localeOn() ? config!.languages[0] : orig()));
    patchGetter(NavProto, 'languages', (orig) => {
      if (!localeOn()) return orig();
      if (!languages || languages.join() !== config!.languages.join()) {
        languages = Object.freeze([...config!.languages]);
      }
      return languages;
    });
  }

  return {
    setConfig(next) {
      if (!next?.active) {
        config = null;
        return;
      }
      try {
        new NativeDTF('en-US', { timeZone: next.timezone });
        config = { ...next, shields: normalizeShields(next.shields) };
      } catch {
        config = null; // unknown timezone: stay paused rather than half-spoof
      }
    },
  };
}
