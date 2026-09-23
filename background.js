// background.js — mod.io Exporter & Importer
//
// Owns the import queue: opens each mod URL in a background tab, clicks
// Subscribe, *confirms* it actually took, then closes the tab and moves on.
// Progress is persisted to chrome.storage as it goes, so if Chrome ever
// terminates this service worker mid-import (it's allowed to, per the MV3
// lifecycle), the popup can detect that and offer to resume rather than
// silently losing progress.

const SPEED_PRESETS = {
  safe:   { tabSettle: 2200, verifyWait: 1400, tabTimeout: 30000 },
  normal: { tabSettle: 1600, verifyWait: 1100, tabTimeout: 22000 },
  fast:   { tabSettle: 900,  verifyWait: 800,  tabTimeout: 16000 }
};
const DEFAULT_SETTINGS = { speed: 'normal' };
const NOTIFICATION_ICON = chrome.runtime.getURL('icons/icon128.png');
const FAILED_STATUSES = ['not_found', 'button_not_found', 'timeout', 'error', 'unverified'];

let isImporting = false;
let stopRequested = false;
let heartbeat = null;

// If this service worker just woke up (or started fresh) and storage still
// says an import is "running", that run was interrupted — it can't still be
// running in *this* fresh instance since `isImporting` starts false.
(async () => {
  try {
    const { modioImportState } = await chrome.storage.local.get('modioImportState');
    if (modioImportState && modioImportState.status === 'running' && !isImporting) {
      modioImportState.status = 'interrupted';
      await chrome.storage.local.set({ modioImportState });
    }
  } catch (e) { /* storage unavailable — non-fatal */ }
})();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStatus') {
    chrome.storage.local.get('modioImportState').then(({ modioImportState }) => {
      sendResponse({ isImporting, state: modioImportState || null });
    });
    return true; // keep the channel open for the async response
  }
  if (request.action === 'stopImport') {
    stopRequested = true;
    return;
  }
  if (request.action === 'startImport') {
    if (isImporting) return;
    beginImport(dedupeItems(request.items));
    return;
  }
  if (request.action === 'resumeImport') {
    if (isImporting) return;
    chrome.storage.local.get('modioImportState').then(({ modioImportState }) => {
      if (!modioImportState || !Array.isArray(modioImportState.results)) return;
      const done = new Set(modioImportState.results.map(r => r.url));
      const remaining = (modioImportState.allItems || []).filter(it => !done.has(it.url));
      if (remaining.length) beginImport(remaining, modioImportState.results);
    });
    return;
  }
  if (request.action === 'retryFailed') {
    if (isImporting) return;
    chrome.storage.local.get('modioImportState').then(({ modioImportState }) => {
      if (!modioImportState || !Array.isArray(modioImportState.results)) return;
      const failedItems = modioImportState.results
        .filter(r => FAILED_STATUSES.includes(r.status))
        .map(r => ({ url: r.url, name: r.name }));
      if (failedItems.length) beginImport(dedupeItems(failedItems));
    });
    return;
  }
  if (request.action === 'dismissState') {
    chrome.storage.local.remove('modioImportState');
    return;
  }
});

function dedupeItems(items) {
  const seen = new Map();
  for (const raw of (items || [])) {
    const url = (raw && raw.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.set(url, { url, name: (raw.name || url).trim() });
  }
  return Array.from(seen.values());
}

function beginImport(items, priorResults = []) {
  if (!items.length) return;
  isImporting = true;
  stopRequested = false;
  processQueue(items, priorResults);
}

async function persistState(state) {
  try { await chrome.storage.local.set({ modioImportState: state }); } catch (e) {}
}

function startHeartbeat() {
  stopHeartbeat();
  // A trivial extension-API call every 15s resets the service worker's idle
  // timer while we're waiting on a slow-loading tab, so a long import is less
  // likely to get the worker torn down mid-flight. This is a mitigation, not
  // a guarantee — hence the resume feature above as a second line of defense.
  heartbeat = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 15000);
}
function stopHeartbeat() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

async function getSettings() {
  try {
    const { modioSyncSettings } = await chrome.storage.local.get('modioSyncSettings');
    return { ...DEFAULT_SETTINGS, ...(modioSyncSettings || {}) };
  } catch (e) { return DEFAULT_SETTINGS; }
}

async function processQueue(items, priorResults = []) {
  const settings = await getSettings();
  const preset = SPEED_PRESETS[settings.speed] || SPEED_PRESETS.normal;
  const results = [...priorResults];
  const total = results.length + items.length;

  startHeartbeat();

  let state = {
    status: 'running',
    total,
    current: results.length,
    results,
    allItems: [...results.map(r => ({ url: r.url, name: r.name })), ...items],
    startedAt: Date.now(),
    finishedAt: null,
    stopped: false
  };
  await persistState(state);

  for (let i = 0; i < items.length; i++) {
    if (stopRequested) { state.stopped = true; break; }

    const { url, name } = items[i];
    let entry;
    let tab;

    try {
      tab = await chrome.tabs.create({ url, active: false });
    } catch (e) {
      entry = { url, name, status: 'error', message: 'Could not open a tab for this URL' };
      results.push(entry);
      state.current = results.length;
      state.results = results;
      await persistState(state);
      chrome.runtime.sendMessage({ action: 'progressUpdate', current: state.current, total, last: entry }).catch(() => {});
      continue;
    }

    if (stopRequested) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
      state.stopped = true;
      break;
    }

    const loaded = await waitForTabComplete(tab.id, preset.tabTimeout);
    if (!loaded) {
      entry = { url, name, status: 'timeout', message: 'Page took too long to load' };
    } else {
      await sleep(preset.tabSettle);
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: subscribeAndVerify,
          args: [preset.verifyWait]
        });
        const result = injected && injected[0] && injected[0].result;
        entry = { url, name, ...(result || { status: 'error', message: 'No response from the page' }) };
      } catch (e) {
        entry = { url, name, status: 'error', message: e.message || 'Script injection failed' };
      }
    }

    try { await chrome.tabs.remove(tab.id); } catch (e) {}

    results.push(entry);
    state.current = results.length;
    state.results = results;
    await persistState(state);
    chrome.runtime.sendMessage({ action: 'progressUpdate', current: state.current, total, last: entry }).catch(() => {});
  }

  stopHeartbeat();
  isImporting = false;
  state.status = 'done';
  state.finishedAt = Date.now();
  await persistState(state);

  const summary = summarize(state.results);
  chrome.runtime.sendMessage({ action: 'importDone', stopped: state.stopped, summary }).catch(() => {});

  chrome.notifications.create({
    type: 'basic',
    iconUrl: NOTIFICATION_ICON,
    title: state.stopped ? 'Import stopped' : 'Import complete',
    message: state.stopped
      ? `Stopped after ${state.current} of ${state.total} — ${summary.subscribed} subscribed, ${summary.failed} failed.`
      : `${summary.subscribed} subscribed, ${summary.already} already had it, ${summary.failed} failed — of ${state.total}.`
  });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: playCompletionSound }).catch(() => {});
    }
  });
}

function summarize(results) {
  const s = { subscribed: 0, already: 0, failed: 0 };
  for (const r of results) {
    if (r.status === 'subscribed') s.subscribed++;
    else if (r.status === 'already_subscribed') s.already++;
    else s.failed++;
  }
  return s;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    function finish(loaded) {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(loaded);
    }
    function listener(tId, info) {
      if (tId === tabId && info.status === 'complete') finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// --- Injected into each mod page. Clicks Subscribe and *confirms* the button
// actually flipped to "Subscribed" before reporting success, instead of just
// assuming the click worked. ---
async function subscribeAndVerify(verifyWait) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function findByText(pattern) {
    return Array.from(document.querySelectorAll('button, a[role="button"], a')).find(el => {
      const text = (el.innerText || el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      return pattern.test(text) || pattern.test(aria);
    });
  }

  if (findByText(/^subscribed$/)) return { status: 'already_subscribed' };

  const subBtn = findByText(/^subscribe$/);
  if (!subBtn) {
    const bodyText = (document.body.innerText || '').toLowerCase();
    if (bodyText.includes('page not found') || bodyText.includes("doesn't exist") ||
        bodyText.includes('has been removed') || bodyText.includes('taken down') ||
        bodyText.includes('404')) {
      return { status: 'not_found', message: 'Mod page not found or removed' };
    }
    return { status: 'button_not_found', message: 'Could not find a Subscribe button' };
  }

  subBtn.click();
  await sleep(verifyWait);
  if (findByText(/^subscribed$/)) return { status: 'subscribed' };

  await sleep(verifyWait);
  if (findByText(/^subscribed$/)) return { status: 'subscribed' };

  return { status: 'unverified', message: 'Clicked Subscribe but could not confirm it worked' };
}

// Synthesizes a happy 3-note completion chime using the Web Audio API.
function playCompletionSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, ctx.currentTime);
    osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch (e) { /* audio not available in this context */ }
}
