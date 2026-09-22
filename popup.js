document.addEventListener('DOMContentLoaded', async () => {
  const btn = document.getElementById('action-btn');
  const status = document.getElementById('status');
  
  // Get the current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  // Smart routing: Check if they are actually on the library page
  if (!tab.url.includes('mod.io/library') && !tab.url.includes('mod.io/me/mods')) {
    btn.innerText = "Open mod.io Library";
    btn.onclick = () => {
      chrome.tabs.create({ url: 'https://mod.io/library' });
    };
    return;
  }

  // If they are on the right page, set up the export button
  btn.innerText = "📥 Export Subscribed Mods";
  
  btn.onclick = async () => {
    btn.disabled = true;
    btn.innerText = "Scraping Started...";
    status.innerText = "Look at the webpage for progress! You can safely close this menu.";
    
    // Inject the scraper script into the webpage
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeAndDownloadMods
    });
  };
});

// --- EVERYTHING BELOW THIS LINE RUNS INSIDE THE WEBPAGE ---
async function scrapeAndDownloadMods() {
  // 1. Create a beautiful overlay UI on the webpage so the user knows it's working
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(5px);
    z-index: 9999999; display: flex; flex-direction: column;
    justify-content: center; align-items: center; color: white;
    font-family: sans-serif;
  `;
  
  const title = document.createElement('h2');
  title.innerText = 'Scraping your mod.io library...';
  title.style.marginBottom = '10px';
  
  const subtitle = document.createElement('div');
  subtitle.innerText = 'Mods found: 0';
  subtitle.style.fontSize = '24px';
  subtitle.style.color = '#4ade80';
  subtitle.style.fontWeight = 'bold';

  overlay.appendChild(title);
  overlay.appendChild(subtitle);
  document.body.appendChild(overlay);

  // 2. The Scraping Logic
  const mods = new Map();
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  function scrapeCurrentView() {
    const modElements = document.querySelectorAll('a[href*="/m/"]');
    modElements.forEach(link => {
      if (link.href && !link.href.includes('/members/')) {
        const titleEl = link.querySelector('h3, h4, .title, .font-bold') || link;
        let name = titleEl.innerText.trim() || link.getAttribute('aria-label') || link.title;
        
        const urlObj = new URL(link.href);
        const cleanUrl = urlObj.origin + urlObj.pathname;

        if (name && cleanUrl && !mods.has(cleanUrl) && name.length > 1) {
          mods.set(cleanUrl, { name, url: cleanUrl });
        }
      }
    });
  }

  let loopCount = 0;
  while (loopCount < 200) {
    scrapeCurrentView();
    subtitle.innerText = `Mods found: ${mods.size}`;

    const nextBtn = Array.from(document.querySelectorAll('a, button, div')).find(el => {
      const text = (el.innerText || '').toLowerCase().trim();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      return (text === 'next' || aria.includes('next') || el.rel === 'next') && el.offsetParent !== null;
    });

    const lastHeight = document.body.scrollHeight;

    if (nextBtn && !nextBtn.disabled && !nextBtn.closest('.disabled') && !nextBtn.hasAttribute('disabled')) {
      nextBtn.click();
      await sleep(3500);
    } else {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(3000);
      if (document.body.scrollHeight <= lastHeight) break;
    }
    loopCount++;
  }

  // 3. Complete and Download
  if (mods.size === 0) {
    title.innerText = 'Error: No mods found.';
    title.style.color = '#f87171';
    subtitle.innerText = 'Closing in 3 seconds...';
    await sleep(3000);
    overlay.remove();
    return;
  }

  title.innerText = 'Done! Preparing download...';
  title.style.color = '#4ade80';

  let textContent = `mod.io Subscribed Mods Export\nExported on: ${new Date().toLocaleString()}\nTotal Mods: ${mods.size}\n\n`;
  textContent += '='.repeat(50) + '\n\n';

  let index = 1;
  for (const [url, mod] of mods) {
    textContent += `${index}. ${mod.name}\n   URL: ${mod.url}\n\n`;
    index++;
  }

  const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = `modio-subscribed-mods-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);

  await sleep(1500);
  overlay.remove();
}