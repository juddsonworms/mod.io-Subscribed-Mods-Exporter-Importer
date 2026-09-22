document.addEventListener('DOMContentLoaded', async () => {
  const exportBtn = document.getElementById('export-btn');
  const importBtn = document.getElementById('import-btn');
  const fileInput = document.getElementById('file-input');
  const stopBtn = document.getElementById('stop-btn');
  const status = document.getElementById('status');
  
  const mainUI = document.getElementById('main-ui');
  const progressContainer = document.getElementById('progress-container');
  const progressText = document.getElementById('progress-text');
  const progressFill = document.getElementById('progress-fill');
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // --- SYNC STATE WITH BACKGROUND ---
  chrome.runtime.sendMessage({ action: 'getStatus' }, (res) => {
    if (res && res.isImporting) showProgressView(res.current, res.total);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progressUpdate') {
      showProgressView(msg.current, msg.total);
    } else if (msg.action === 'importDone') {
      resetView();
      status.innerText = msg.stopped ? "Import manually stopped." : "Import complete!";
    }
  });

  function showProgressView(current, total) {
    mainUI.style.display = 'none';
    progressContainer.style.display = 'block';
    progressText.innerText = `Importing... ${current} / ${total}`;
    progressFill.style.width = `${(current / total) * 100}%`;
    status.innerText = "You can safely close this menu.";
  }

  function resetView() {
    mainUI.style.display = 'block';
    progressContainer.style.display = 'none';
  }

  // --- STOP BUTTON ---
  stopBtn.onclick = () => {
    chrome.runtime.sendMessage({ action: 'stopImport' });
    stopBtn.innerText = "Stopping...";
    stopBtn.disabled = true;
  };
  
  // --- EXPORT LOGIC ---
  if (!tab.url.includes('mod.io/library') && !tab.url.includes('mod.io/me/mods')) {
    exportBtn.innerText = "Open mod.io Library";
    exportBtn.onclick = () => chrome.tabs.create({ url: 'https://mod.io/library' });
  } else {
    exportBtn.onclick = async () => {
      exportBtn.disabled = true; importBtn.disabled = true;
      exportBtn.innerText = "Scraping Started...";
      status.innerText = "Look at the webpage for progress!";
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeAndDownloadMods });
    };
  }

  // --- IMPORT LOGIC ---
  importBtn.onclick = () => fileInput.click();

  fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const urls = event.target.result.split('\n')
        .filter(line => line.trim().startsWith('URL:'))
        .map(line => line.replace('URL:', '').trim());

      if (urls.length === 0) {
        status.innerText = "Error: No mod URLs found.";
        status.style.color = "#f87171";
        return;
      }
      chrome.runtime.sendMessage({ action: 'startImport', urls: urls });
      showProgressView(0, urls.length);
      stopBtn.innerText = "🛑 Stop Import";
      stopBtn.disabled = false;
    };
    reader.readAsText(file);
    fileInput.value = ''; // Reset input
  };
});

// --- EXPORT SCRAPER FUNCTION (UNCHANGED) ---
async function scrapeAndDownloadMods() {
  const overlay = document.createElement('div');
  overlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.85); backdrop-filter: blur(5px); z-index: 9999999; display: flex; flex-direction: column; justify-content: center; align-items: center; color: white; font-family: sans-serif;`;
  const title = document.createElement('h2'); title.innerText = 'Scraping your mod.io library...';
  const subtitle = document.createElement('div'); subtitle.innerText = 'Mods found: 0';
  subtitle.style.fontSize = '24px'; subtitle.style.color = '#4ade80';
  overlay.appendChild(title); overlay.appendChild(subtitle); document.body.appendChild(overlay);

  const mods = new Map();
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  function scrapeCurrentView() {
    document.querySelectorAll('a[href*="/m/"]').forEach(link => {
      if (link.href && !link.href.includes('/members/')) {
        const titleEl = link.querySelector('h3, h4, .title, .font-bold') || link;
        let name = titleEl.innerText.trim() || link.getAttribute('aria-label') || link.title;
        const cleanUrl = new URL(link.href).origin + new URL(link.href).pathname;
        if (name && cleanUrl && !mods.has(cleanUrl) && name.length > 1) mods.set(cleanUrl, { name, url: cleanUrl });
      }
    });
  }

  let loopCount = 0;
  while (loopCount < 200) {
    scrapeCurrentView();
    subtitle.innerText = `Mods found: ${mods.size}`;
    const nextBtn = Array.from(document.querySelectorAll('a, button, div')).find(el => {
      const t = (el.innerText || '').toLowerCase().trim();
      return (t === 'next' || (el.getAttribute('aria-label')||'').toLowerCase().includes('next')) && el.offsetParent !== null;
    });
    const lastHeight = document.body.scrollHeight;
    if (nextBtn && !nextBtn.disabled && !nextBtn.closest('.disabled')) {
      nextBtn.click(); await sleep(3500);
    } else {
      window.scrollTo(0, document.body.scrollHeight); await sleep(3000);
      if (document.body.scrollHeight <= lastHeight) break;
    }
    loopCount++;
  }

  if (mods.size === 0) {
    title.innerText = 'Error: No mods found.'; title.style.color = '#f87171';
    await sleep(3000); overlay.remove(); return;
  }

  title.innerText = 'Done! Preparing download...';
  let textContent = `mod.io Subscribed Mods Export\nExported on: ${new Date().toLocaleString()}\nTotal Mods: ${mods.size}\n\n${'='.repeat(50)}\n\n`;
  let index = 1;
  for (const [url, mod] of mods) { textContent += `${index}. ${mod.name}\n   URL: ${mod.url}\n\n`; index++; }

  const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `modio-subscribed-mods-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  await sleep(1500); overlay.remove();
}
