import '@platform/wiring';
import { readProxyControl } from '@platform/control';
import { fromExtensionPage, listen } from '../shared/messages';
import { getState, onStateChanged } from '../shared/storage';
import { UPDATE_ALARM, updateIranList, approveIranList } from './iranlist';
import { forgetTab, handleStaleReport, trackNavigation } from './stale';
import { noteStartupError } from './startup-tabs';
import { ensureAlarms, onAlarm, onConfigChange, onStartup, refreshExitNow } from './monitor';

function requireOptions(sender: chrome.runtime.MessageSender): void {
  if (!fromExtensionPage(sender, 'options/index.html'))
    throw new Error('Routing-list actions require extension Options.');
}

listen({
  ping: () => 'pong',
  topHost: (_message, sender) => {
    if (__BROWSER__ !== 'firefox') return '';
    try {
      return new URL(sender.tab?.url ?? '').hostname;
    } catch {
      return '';
    }
  },
  getState: () => getState(),
  updateIranList: (_message, sender) => {
    requireOptions(sender);
    return updateIranList();
  },
  approveIranList: (message, sender) => {
    requireOptions(sender);
    return approveIranList(message.candidateId);
  },
  staleReport: (message, sender) => handleStaleReport(message, sender),
  refreshExit: () => refreshExitNow(),
  proxyControl: () => {
    if (__BROWSER__ !== 'firefox') throw new Error('Firefox only.');
    return readProxyControl();
  },
});

// Alarms survive worker restarts, but make sure they exist after updates or cleared data.
ensureAlarms();
onStateChanged(onConfigChange);
chrome.alarms.onAlarm.addListener(onAlarm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== UPDATE_ALARM) return;
  void getState().then((s) => {
    if (s.listUpdates && s.routingMode !== 'strict') void updateIranList();
  });
});
// Reverify effective settings whenever this service worker wakes.
onConfigChange();
chrome.runtime.onInstalled.addListener(onStartup);
chrome.runtime.onStartup.addListener(onStartup);

// Stale-page recovery: know each tab's last navigation (form submits are never reloaded).
chrome.webNavigation.onCommitted.addListener((details) => void trackNavigation(details));
chrome.webNavigation.onErrorOccurred.addListener(noteStartupError);
chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));
