/** What the audit reads from a page. Plain data, so it can cross from the page to the popup. */
export interface AuditObservation {
  now: number;
  tz: string;
  offset: number;
  dateString: string;
  calendar: string;
  numbering: string;
  /** Calendar and numbering a Persian locale resolves to, which the Language shield forces. */
  faCalendar: string;
  faNumbering: string;
  /** (1234).toLocaleString('fa-IR') and a fa-IR date, to look for Persian digits. */
  faSample: string;
  language: string;
  languages: string[];
  voiceLangs: string[];
  /** Persian fonts that a measuring page would find installed. */
  fonts: string[];
  /** What KeyA maps to, null if the map could not be read, "unsupported" without the API. */
  keyA: string | null;
  iceTransportPolicy: string | null;
}

/**
 * Runs inside the audited page (MAIN world), so it sees exactly what the site sees, through
 * every patch. Must not reference anything outside itself: Chrome serialises it as source.
 */
export async function collectAudit(fontNames: string[]): Promise<AuditObservation> {
  const now = Date.now();
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const fa = new Intl.DateTimeFormat('fa-IR').resolvedOptions();

  let voices = speechSynthesis.getVoices();
  if (voices.length === 0) {
    await new Promise<void>((resolve) => {
      speechSynthesis.addEventListener('voiceschanged', () => resolve(), { once: true });
      setTimeout(resolve, 400);
    });
    voices = speechSynthesis.getVoices();
  }

  // The same trick sites use: a font that exists changes the width of a probe string.
  const root = document.body ?? document.documentElement;
  const width = (family: string): number => {
    const span = document.createElement('span');
    span.textContent = 'mmmmmmmmmmlli';
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:72px';
    span.style.fontFamily = family;
    root.appendChild(span);
    const w = span.offsetWidth;
    span.remove();
    return w;
  };
  const generics = ['monospace', 'sans-serif', 'serif'];
  const base = generics.map(width);
  const fonts = fontNames.filter((name) =>
    generics.some((generic, i) => width(`"${name}", ${generic}`) !== base[i]),
  );

  let keyA: string | null;
  const keyboard = (
    navigator as unknown as { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }
  ).keyboard;
  if (!keyboard?.getLayoutMap) keyA = 'unsupported';
  else {
    try {
      keyA = (await keyboard.getLayoutMap()).get('KeyA') ?? null;
    } catch {
      keyA = null;
    }
  }

  let iceTransportPolicy: string | null;
  try {
    const pc = new RTCPeerConnection();
    iceTransportPolicy = pc.getConfiguration().iceTransportPolicy ?? null;
    pc.close();
  } catch {
    iceTransportPolicy = null;
  }

  // Temporal reads the system zone on its own path (B8); a mismatch shows up in the tz value.
  const temporalTz: string | undefined = (
    globalThis as { Temporal?: { Now: { timeZoneId(): string } } }
  ).Temporal?.Now.timeZoneId();
  return {
    now,
    tz:
      temporalTz && temporalTz !== resolved.timeZone
        ? `${resolved.timeZone}, Temporal ${temporalTz}`
        : resolved.timeZone,
    offset: new Date(now).getTimezoneOffset(),
    dateString: new Date(now).toString(),
    calendar: resolved.calendar,
    numbering: resolved.numberingSystem,
    faCalendar: fa.calendar,
    faNumbering: fa.numberingSystem,
    faSample: `${(1234.5).toLocaleString('fa-IR')} ${new Date(0).toLocaleDateString('fa-IR')}`,
    language: navigator.language,
    languages: [...navigator.languages],
    voiceLangs: voices.map((v) => v.lang),
    fonts,
    keyA,
    iceTransportPolicy,
  };
}
