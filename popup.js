const $ = id => document.getElementById(id);

const SPEED_LABELS = {
  safe: "Slower, but gentlest on mod.io's servers.",
  normal: 'A good default for most libraries.',
  fast: 'Quicker, best for a solid connection.'
};

let currentResults = [];   // mirrors the results the popup has seen for this run
let currentTotal = 0;      // the originally requested total for the run in progress
let lastKnownTotal = null; // total item count for an interrupted run, used when resuming

document.addEventListener('DOMContentLoaded', async () => {
  const exportBtn = $('export-btn');
  const importBtn = $('import-btn');
  const fileInput = $('file-input');
  const stopBtn = $('stop-btn');
  const statusLine = $('status-line');

  const mainView = $('main-view');
  const progressView = $('progress-view');
  const resultPanel = $('result-panel');
  const interruptedBanner = $('interrupted-banner');

  // ---------- Settings (import speed) ----------
  const speedRow = $('speed-row');
  const speedHint = $('speed-hint');
  let settings = { speed: 'normal' };
  try {
    const stored = await chrome.storage.local.get('modioSyncSettings');
    if (stored.modioSyncSettings) settings = { ...settings, ...stored.modioSyncSettings };
  } catch (e) {}
  renderSpeed(settings.speed);

  speedRow.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-speed]');
    if (!btn) return;
    settings.speed = btn.dataset.speed;
    renderSpeed(settings.speed);
    try { await chrome.storage.local.set({ modioSyncSettings: settings }); } catch (err) {}
  });

  function renderSpeed(speed) {
    [...speedRow.children].forEach(b => b.classList.toggle('active', b.dataset.speed === speed));
    speedHint.textContent = SPEED_LABELS[speed] || '';
  }

  // ---------- Export ----------
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onLibraryPage = !!tab.url && (tab.url.includes('mod.io/library') || tab.url.includes('mod.io/me/mods'));

  if (!onLibraryPage) {
    exportBtn.textContent = 'Open mod.io library';
    exportBtn.onclick = () => chrome.tabs.create({ url: 'https://mod.io/library' });
  } else {
    exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = 'Starting…';
      statusLine.textContent = 'Watch the mod.io tab for progress.';
      const ok = await ensureContentScript(tab.id);
      if (!ok) {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export mods';
        statusLine.textContent = "Couldn't reach the page — try reloading the tab.";
        return;
      }
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'startExport' });
      } catch (e) {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export mods';
        statusLine.textContent = "Couldn't start the export — try reloading the tab.";
        return;
      }
      setTimeout(() => {
        exportBtn.disabled = false;
        exportBtn.textContent = 'Export mods';
      }, 1500);
    };
  }

  async function ensureContentScript(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      return true;
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  // ---------- Import ----------
  importBtn.onclick = () => fileInput.click();

  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const items = parseBackup(event.target.result);
      if (items.length === 0) {
        statusLine.textContent = 'No mod URLs found in that file.';
        return;
      }
      currentResults = [];
      beginProgressView(items.length);
      chrome.runtime.sendMessage({ action: 'startImport', items }).catch(() => {});
    };
    reader.readAsText(file);
    fileInput.value = '';
  };

  function parseBackup(text) {
    const lines = text.split(/\r?\n/);
    const items = [];
    let pendingName = null;
    for (const raw of lines) {
      const line = raw.trim();
      const nameMatch = line.match(/^\d+\.\s+(.+)$/);
      if (nameMatch) { pendingName = nameMatch[1].trim(); continue; }
      if (/^URL:/i.test(line)) {
        const url = line.replace(/^URL:/i, '').trim();
        if (url) items.push({ url, name: pendingName || url });
        pendingName = null;
      }
    }
    // De-dupe client-side too, so the progress total is accurate up front.
    const seen = new Map();
    for (const it of items) if (!seen.has(it.url)) seen.set(it.url, it);
    return Array.from(seen.values());
  }

  // ---------- Stop ----------
  stopBtn.onclick = () => {
    chrome.runtime.sendMessage({ action: 'stopImport' }).catch(() => {});
    stopBtn.textContent = 'Stopping…';
    stopBtn.disabled = true;
  };

  // ---------- Resume / discard interrupted import ----------
  $('resume-btn').onclick = () => {
    chrome.runtime.sendMessage({ action: 'resumeImport' }).catch(() => {});
    interruptedBanner.hidden = true;
    beginProgressView(lastKnownTotal, currentResults);
  };
  $('discard-btn').onclick = async () => {
    chrome.runtime.sendMessage({ action: 'dismissState' }).catch(() => {});
    interruptedBanner.hidden = true;
    showView('main');
  };

  // ---------- Retry / report / dismiss on the result panel ----------
  $('retry-btn').onclick = () => {
    const failed = currentResults.filter(r => r.status !== 'subscribed' && r.status !== 'already_subscribed');
    currentResults = [];
    beginProgressView(failed.length);
    chrome.runtime.sendMessage({ action: 'retryFailed' }).catch(() => {});
  };
  $('report-btn').onclick = () => downloadReport(currentResults);
  $('dismiss-btn').onclick = () => {
    chrome.runtime.sendMessage({ action: 'dismissState' }).catch(() => {});
    showView('main');
    statusLine.textContent = '';
  };

  // ---------- Sync with whatever background is already doing ----------
  chrome.runtime.sendMessage({ action: 'getStatus' }, (res) => {
    if (!res) return;
    const state = res.state;
    if (!state) { showView('main'); return; }

    if (state.status === 'running' || res.isImporting) {
      currentResults = state.results || [];
      currentTotal = state.total;
      renderExistingResults(currentResults);
      progressView.querySelector('#progress-title').textContent = 'Importing…';
      updateProgressChrome(state.current, state.total);
      showView('progress');
    } else if (state.status === 'interrupted') {
      currentResults = state.results || [];
      lastKnownTotal = state.total;
      $('interrupted-detail').textContent = `${state.current} of ${state.total} were processed before it stopped.`;
      interruptedBanner.hidden = false;
      showView('main');
    } else if (state.status === 'done') {
      currentResults = state.results || [];
      showResultPanel(state);
    } else {
      showView('main');
    }
  });

  // ---------- Live updates from background.js / content.js ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progressUpdate') {
      currentResults.push(msg.last);
      currentTotal = msg.total;
      appendLogEntry(msg.last);
      bumpStat(msg.last.status);
      updateProgressChrome(msg.current, msg.total);
      showView('progress');
    } else if (msg.action === 'importDone') {
      showResultPanel({ stopped: msg.stopped, summary: msg.summary, current: currentResults.length, total: currentTotal || currentResults.length });
    } else if (msg.action === 'exportProgress') {
      statusLine.textContent = `Scanning… ${msg.count} found so far`;
    } else if (msg.action === 'exportDone') {
      statusLine.textContent = msg.success
        ? `Exported ${msg.count} mods.`
        : (msg.stopped ? 'Export cancelled.' : 'No subscribed mods were found.');
    }
  });

  // ---------- View helpers ----------
  function showView(which) {
    mainView.hidden = which !== 'main';
    progressView.hidden = which !== 'progress';
    resultPanel.hidden = which !== 'result';
  }

  function beginProgressView(total, seedResults) {
    currentTotal = total || (seedResults ? seedResults.length : 0);
    if (seedResults) {
      currentResults = seedResults;
      renderExistingResults(seedResults);
    } else {
      $('stat-ok').textContent = '0';
      $('stat-skip').textContent = '0';
      $('stat-fail').textContent = '0';
      $('log-list').innerHTML = '';
    }
    $('progress-title').textContent = 'Importing…';
    if (total) {
      $('progress-fill').style.width = `${Math.min(100, ((seedResults ? seedResults.length : 0) / total) * 100)}%`;
      $('progress-caption').textContent = `${seedResults ? seedResults.length : 0} / ${total}`;
    } else {
      $('progress-fill').style.width = '0%';
      $('progress-caption').textContent = seedResults && seedResults.length ? `${seedResults.length} processed so far…` : 'Starting…';
    }
    stopBtn.textContent = 'Stop import';
    stopBtn.disabled = false;
    showView('progress');
  }

  function renderExistingResults(results) {
    $('log-list').innerHTML = '';
    const counts = { ok: 0, skip: 0, fail: 0 };
    for (const r of results) {
      const bucket = bucketFor(r.status);
      counts[bucket]++;
    }
    $('stat-ok').textContent = counts.ok;
    $('stat-skip').textContent = counts.skip;
    $('stat-fail').textContent = counts.fail;
    for (const r of results.slice(-6)) appendLogEntry(r, false);
  }

  function bucketFor(status) {
    if (status === 'subscribed') return 'ok';
    if (status === 'already_subscribed') return 'skip';
    return 'fail';
  }

  function bumpStat(status) {
    const bucket = bucketFor(status);
    const el = $('stat-' + bucket);
    el.textContent = String(Number(el.textContent) + 1);
  }

  function updateProgressChrome(current, total) {
    $('progress-caption').textContent = `${current} / ${total}`;
    $('progress-fill').style.width = total ? `${Math.min(100, (current / total) * 100)}%` : '0%';
  }

  const STATUS_LABEL = {
    subscribed: 'Subscribed',
    already_subscribed: 'Already subscribed',
    not_found: 'Mod not found',
    button_not_found: 'Button not found',
    timeout: 'Timed out',
    unverified: "Couldn't confirm",
    error: 'Error'
  };
  const STATUS_COLOR = { ok: 'var(--ok)', skip: 'var(--warn)', fail: 'var(--err)' };

  function appendLogEntry(entry, trim = true) {
    const list = $('log-list');
    const li = document.createElement('li');
    const bucket = bucketFor(entry.status);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = STATUS_COLOR[bucket];
    const text = document.createElement('span');
    text.className = 'name';
    text.textContent = `${STATUS_LABEL[entry.status] || entry.status} — ${entry.name || entry.url}`;
    li.appendChild(dot);
    li.appendChild(text);
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
    if (trim) {
      while (list.children.length > 6) list.removeChild(list.firstChild);
    }
  }

  function showResultPanel(state) {
    const results = currentResults;
    const summary = state.summary || summarizeResults(results);
    $('result-title').textContent = state.stopped ? 'Import stopped' : 'Import complete';
    $('result-summary').textContent = state.stopped
      ? `Stopped after ${state.current || results.length} of ${state.total || results.length} — ${summary.subscribed} subscribed, ${summary.failed} failed.`
      : `${summary.subscribed} subscribed, ${summary.already} already had it, ${summary.failed} failed — of ${state.total || results.length}.`;
    $('retry-btn').hidden = summary.failed === 0;
    $('report-btn').hidden = summary.failed === 0;
    showView('result');
  }

  function summarizeResults(results) {
    const s = { subscribed: 0, already: 0, failed: 0 };
    for (const r of results) {
      if (r.status === 'subscribed') s.subscribed++;
      else if (r.status === 'already_subscribed') s.already++;
      else s.failed++;
    }
    return s;
  }

  function downloadReport(results) {
    let text = `mod.io Import Report\nGenerated: ${new Date().toLocaleString()}\n\n`;
    for (const r of results) {
      text += `[${STATUS_LABEL[r.status] || r.status}] ${r.name || ''}\n  URL: ${r.url}\n`;
      if (r.message) text += `  Note: ${r.message}\n`;
      text += '\n';
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `modio-import-report-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
});
