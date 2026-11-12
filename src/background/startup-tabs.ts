/**
 * Tabs whose page failed while the startup guard blocked every request (B3). Restored tabs load
 * before protection is ready and do not retry, so they are reloaded once the guard is off.
 */
let failed: Set<number> | null = new Set();
// shortcut: only failures in a worker's first minute are kept; a slower start leaves them alone.
setTimeout(() => (failed = null), 60_000);

export function noteStartupError(d: { tabId: number; frameId: number; error: string }): void {
  // An abort is the user stopping a load or a download, not the guard.
  if (d.frameId === 0 && d.tabId >= 0 && !/ABORT/i.test(d.error)) failed?.add(d.tabId);
}

/** The failed tabs so far; recording stops. */
export function takeStartupErrors(): number[] {
  const ids = [...(failed ?? [])];
  failed = null;
  return ids;
}
