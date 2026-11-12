import { CAPTCHA_DOMAINS, RECAPTCHA_URL_FILTER } from '../shared/antibot';
import type { StageStatus } from '../shared/rules-status';

export const RULE = {
  ALT_SVC: 1,
  ACCEPT_LANGUAGE: 2,
  HEADERS: 3,
  RECAPTCHA_ALLOW: 4,
} as const;
/** Rule id 5 was the Google Flow country-page block (now in noleaker-flow); removed on update. */
export const LEGACY_FLOW_RULE_ID = 5;
export const CORE_IDS = [RULE.ALT_SVC, RULE.ACCEPT_LANGUAGE, RULE.RECAPTCHA_ALLOW];
export const HEADER_IDS = [RULE.HEADERS];

/**
 * Priorities. An `allow` rule beats every lower-priority rule, so the reCAPTCHA exemption sits
 * above the header-changing rules but below Alt-Svc stripping, which must keep applying.
 */
const PRIORITY = { ALT_SVC: 200, ALLOW: 100, MODIFY: 1 } as const;

export interface DnrRule {
  id: number;
  priority: number;
  action: Record<string, unknown>;
  condition: Record<string, unknown>;
}

// Each browser rejects the whole rule set over a resource type it does not know, so the lists differ.
export const ALL_TYPES = (
  __BROWSER__ === 'firefox'
    ? [
        'main_frame',
        'sub_frame',
        'stylesheet',
        'script',
        'image',
        'imageset',
        'font',
        'object',
        'object_subrequest',
        'xmlhttprequest',
        'json',
        'xslt',
        'xml_dtd',
        'ping',
        'beacon',
        'csp_report',
        'media',
        'websocket',
        'web_manifest',
        'speculative',
        'other',
      ]
    : [
        'main_frame',
        'sub_frame',
        'stylesheet',
        'script',
        'image',
        'font',
        'object',
        'xmlhttprequest',
        'ping',
        'csp_report',
        'media',
        'websocket',
        'webtransport',
        'webbundle',
        'other',
      ]
) as chrome.declarativeNetRequest.ResourceType[];

/** Requests to these domains, and requests started by pages on them, are left alone. */
// shortcut: a third-party frame on a whitelisted site still gets the spoofed headers (B20); add
// excludedTopDomains for the whitelist once the minimum Chrome is 145.
const exclude = (domains: readonly string[]) =>
  domains.length > 0 ? { excludedRequestDomains: domains, excludedInitiatorDomains: domains } : {};

/**
 * Domains the language and header rules must skip, most important first: captcha providers and
 * the whitelist. When a rule set is rejected the tail is dropped first (see `installStage`).
 */
export function languageExclusions(whitelist: readonly string[]): string[] {
  return [...new Set([...CAPTCHA_DOMAINS, ...whitelist])];
}

/** Same, plus Iran-direct domains (your own, and the Iran list) for the header rule. */
export function headerExclusions(
  whitelist: readonly string[],
  extraDirect: readonly string[],
  iranDomains: readonly string[],
): string[] {
  return [...new Set([...languageExclusions(whitelist), ...extraDirect, ...iranDomains])];
}

export function coreRules(
  plan: { altSvc: boolean; acceptLanguage: boolean; headers: boolean; strict?: boolean },
  acceptLanguage: string,
  excluded: readonly string[],
): DnrRule[] {
  const rules: DnrRule[] = [];
  if (plan.altSvc) {
    rules.push({
      id: RULE.ALT_SVC,
      priority: PRIORITY.ALT_SVC,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'alt-svc', operation: 'remove' }],
      },
      condition: { resourceTypes: ALL_TYPES },
    });
  }
  if (plan.acceptLanguage) {
    rules.push({
      id: RULE.ACCEPT_LANGUAGE,
      priority: PRIORITY.MODIFY,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'accept-language', operation: 'set', value: acceptLanguage }],
      },
      condition: { resourceTypes: ALL_TYPES, ...exclude(excluded) },
    });
  }
  if (!plan.strict && (plan.acceptLanguage || plan.headers)) {
    rules.push({
      id: RULE.RECAPTCHA_ALLOW,
      priority: PRIORITY.ALLOW,
      action: { type: 'allow' },
      condition: { urlFilter: RECAPTCHA_URL_FILTER, resourceTypes: ALL_TYPES },
    });
  }
  return rules;
}

export function headerRules(on: boolean, excluded: readonly string[]): DnrRule[] {
  if (!on) return [];
  return [
    {
      id: RULE.HEADERS,
      priority: PRIORITY.MODIFY,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'dnt', operation: 'set', value: '1' },
          { header: 'sec-gpc', operation: 'set', value: '1' },
          { header: 'if-none-match', operation: 'remove' },
        ],
      },
      condition: { resourceTypes: ALL_TYPES, ...exclude(excluded) },
    },
  ];
}

/**
 * Install one group of rules. If Chrome rejects it (typically because an exclusion list is too
 * large) retry with half of the excluded domains, then a quarter, down to none. `update` is
 * atomic, so a rejected attempt leaves the previous rules untouched.
 */
export async function installStage(
  update: (rules: DnrRule[]) => Promise<void>,
  build: (excluded: string[]) => DnrRule[],
  excluded: string[],
): Promise<StageStatus> {
  let count = excluded.length;
  for (;;) {
    try {
      await update(build(excluded.slice(0, count)));
      return { ok: true, requested: excluded.length, installed: count };
    } catch (e) {
      if (count === 0) {
        return {
          ok: false,
          requested: excluded.length,
          installed: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
      count = Math.floor(count / 2);
    }
  }
}
