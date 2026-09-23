// content.js — mod.io Exporter & Importer
//
// Runs automatically on mod.io's library / me-mods pages (see manifest.json
// content_scripts) so the floating "Export mods" button is always there.
// The popup's own Export button re-uses this exact same code by messaging
// it, instead of keeping a second copy in sync by hand.

(function () {
  if (window.__modioSyncInjected) return;
  window.__modioSyncInjected = true;

  const BRAND = '#f6412d';
  const OK = '#35c48f';
  const WARN = '#e8b339';
  const ERR = '#f0576b';

  const DEFAULT_SETTINGS = { speed: 'normal' };
  const SPEED_PRESETS = {
    safe: 4000,
    normal: 3200,
    fast: 2200
  };

  const sleep = ms => new Promise(res => setTimeout(res, ms));

  async function getPageWait() {
    try {
      const { modioSyncSettings } = await chrome.storage.local.get('modioSyncSettings');
      const speed = (modioSyncSettings && modioSyncSettings.speed) || DEFAULT_SETTINGS.speed;
      return SPEED_PRESETS[speed] || SPEED_PRESETS.normal;
    } catch (e) {
      return SPEED_PRESETS.normal;
    }
  }

  // ---------- Floating button ----------
  const button = document.createElement('button');
  button.id = 'modio-export-btn';
  button.type = 'button';
  button.setAttribute('aria-label', 'Export subscribed mods to a file');
  button.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19h15"/></svg>' +
    '<span>Export mods</span>';
  button.style.cssText =
    'position:fixed; bottom:20px; right:20px; z-index:999999; display:inline-flex; align-items:center; gap:8px;' +
    'background:' + BRAND + '; color:#fff; border:none; padding:11px 16px 11px 14px;' +
    "font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; letter-spacing:.1px;" +
    'border-radius:10px; cursor:pointer; box-shadow:0 6px 20px rgba(0,0,0,.35); transition:transform .15s ease;';
  button.onmouseenter = () => { if (!button.disabled) button.style.transform = 'translateY(-1px)'; };
  button.onmouseleave = () => { button.style.transform = 'none'; };
  button.onclick = () => runExport();
  document.body.appendChild(button);

  // ---------- Message bridge (used by the popup) ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'ping') {
      sendResponse({ ok: true });
    } else if (msg.action === 'startExport') {
      runExport();
      sendResponse({ started: true });
    } else if (msg.action === 'stopExport') {
      exportStopRequested = true;
    }
    return true;
  });

  // ---------- Overlay ----------
  let overlayEls = null;
  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed; inset:0; background:rgba(10,9,13,.78); backdrop-filter:blur(6px); z-index:1000000;' +
      "display:flex; align-items:center; justify-content:center; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";

    const card = document.createElement('div');
    card.style.cssText =
      'background:#1c1a22; border:1px solid #322f3c; border-radius:16px; padding:30px 34px;' +
      'min-width:260px; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,.5);';

    const title = document.createElement('div');
    title.style.cssText = 'color:#f5f3f7; font-size:15px; font-weight:600; margin-bottom:8px;';
    title.textContent = 'Scanning your library…';

    const count = document.createElement('div');
    count.style.cssText =
      'color:' + BRAND + '; font-size:34px; font-weight:700; font-variant-numeric:tabular-nums; margin-bottom:20px;';
    count.textContent = '0';

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.textContent = 'Cancel';
    stopBtn.style.cssText =
      'background:transparent; color:#918da3; border:1px solid #3a3745; padding:8px 18px;' +
      'border-radius:8px; font-size:13px; cursor:pointer;';
    stopBtn.onclick = () => {
      exportStopRequested = true;
      stopBtn.textContent = 'Stopping…';
      stopBtn.disabled = true;
    };

    card.appendChild(title);
    card.appendChild(count);
    card.appendChild(stopBtn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlayEls = { overlay, title, count, stopBtn };
  }
  function removeOverlay() {
    if (overlayEls) { overlayEls.overlay.remove(); overlayEls = null; }
  }

  // ---------- Core scrape routine (single source of truth) ----------
  let exportRunning = false;
  let exportStopRequested = false;

  async function runExport() {
    if (exportRunning) return;
    exportRunning = true;
    exportStopRequested = false;

    const pageWait = await getPageWait();

    button.disabled = true;
    button.style.opacity = '0.6';
    button.style.cursor = 'wait';
    buildOverlay();

    const mods = new Map();

    function scrapeCurrentView() {
      document.querySelectorAll('a[href*="/m/"]').forEach(link => {
        if (!link.href || link.href.includes('/members/')) return;
        const titleEl = link.querySelector('h3, h4, .title, .font-bold') || link;
        const img = link.querySelector('img[alt]');
        let name = (titleEl.innerText || '').trim() ||
          link.getAttribute('aria-label') ||
          link.title ||
          (img && img.alt) ||
          '';
        name = (name || '').trim();
        let cleanUrl;
        try {
          const u = new URL(link.href);
          cleanUrl = u.origin + u.pathname;
        } catch (e) {
          return;
        }
        if (name.length > 1 && cleanUrl && !mods.has(cleanUrl)) {
          mods.set(cleanUrl, { name, url: cleanUrl });
        }
      });
    }

    let loopCount = 0;
    const maxLoops = 400;
    let stoppedEarly = false;

    while (loopCount < maxLoops) {
      if (exportStopRequested) { stoppedEarly = true; break; }

      scrapeCurrentView();
      if (overlayEls) overlayEls.count.textContent = String(mods.size);
      chrome.runtime.sendMessage({ action: 'exportProgress', count: mods.size }).catch(() => {});

      const nextBtn = Array.from(document.querySelectorAll('a, button, div')).find(el => {
        const t = (el.innerText || '').toLowerCase().trim();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        return (t === 'next' || aria.includes('next') || el.rel === 'next') && el.offsetParent !== null;
      });

      const lastHeight = document.body.scrollHeight;

      if (nextBtn && !nextBtn.disabled && !nextBtn.hasAttribute('disabled') && !nextBtn.closest('.disabled')) {
        nextBtn.click();
        await sleep(pageWait);
      } else {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(Math.round(pageWait * 0.85));
        if (document.body.scrollHeight <= lastHeight) break;
      }
      loopCount++;
    }

    if (mods.size === 0 && !stoppedEarly) {
      if (overlayEls) {
        overlayEls.title.textContent = 'No mods found';
        overlayEls.title.style.color = ERR;
        overlayEls.stopBtn.textContent = 'Close';
        overlayEls.stopBtn.disabled = false;
        overlayEls.stopBtn.onclick = () => removeOverlay();
      }
      resetButton();
      exportRunning = false;
      chrome.runtime.sendMessage({ action: 'exportDone', success: false, count: 0 }).catch(() => {});
      return;
    }

    if (!stoppedEarly) {
      let textContent =
        'mod.io Subscribed Mods Export\n' +
        'Format: modio-sync-v1\n' +
        'Exported on: ' + new Date().toLocaleString() + '\n' +
        'Total Mods: ' + mods.size + '\n\n' + '='.repeat(50) + '\n\n';
      let index = 1;
      for (const [, mod] of mods) {
        textContent += index + '. ' + mod.name + '\n   URL: ' + mod.url + '\n\n';
        index++;
      }
      const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'modio-subscribed-mods-' + new Date().toISOString().slice(0, 10) + '.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();

      try {
        await chrome.storage.local.set({ modioLastExport: { count: mods.size, at: Date.now() } });
      } catch (e) { /* non-fatal */ }
    }

    if (overlayEls) {
      overlayEls.title.textContent = stoppedEarly ? 'Cancelled' : 'Done!';
      overlayEls.title.style.color = stoppedEarly ? WARN : OK;
      overlayEls.stopBtn.textContent = 'Close';
      overlayEls.stopBtn.disabled = false;
      overlayEls.stopBtn.onclick = () => removeOverlay();
    }

    chrome.runtime.sendMessage({
      action: 'exportDone',
      success: !stoppedEarly,
      count: mods.size,
      stopped: stoppedEarly
    }).catch(() => {});

    await sleep(1400);
    removeOverlay();
    resetButton();
    exportRunning = false;

    function resetButton() {
      button.disabled = false;
      button.style.opacity = '1';
      button.style.cursor = 'pointer';
    }
  }
})();
