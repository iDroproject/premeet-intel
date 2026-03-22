// PreMeet background service worker
// Handles auth, data fetching, and message routing between content scripts and popup.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[PreMeet] Extension installed.');
});
