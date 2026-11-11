import { onConfigChange, onControlLoss } from './monitor';
import { RTC_POLICY } from './protection';

// WebRTC and network-prediction settings must keep noleaker's values while the proxy is on; who
// controls them does not matter (B1). Same API and values in Chrome and Firefox. Imported for its
// side effects by the wiring.
chrome.privacy.network.networkPredictionEnabled.onChange.addListener((details) => {
  if (details.value !== false) onControlLoss('Network prediction protection was lost.');
  else onConfigChange();
});
chrome.privacy.network.webRTCIPHandlingPolicy.onChange.addListener((details) => {
  if (details.value !== RTC_POLICY) onControlLoss('WebRTC protection was lost.', 'webrtc');
  else onConfigChange();
});
