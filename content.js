(function() {
  if (document.getElementById('modio-export-btn')) return;

  const button = document.createElement('button');
  button.id = 'modio-export-btn';
  button.innerText = '📥 Export All Mods (.txt)';
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 999999;
    background-color: #f6412d;
    color: white;
    border: none;
    padding: 12px 20px;
    font-size: 14px;
    font-weight: bold;
    border-radius: 8px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    transition: background 0.2s;
  `;

  button.onmouseover = () => { if(!button.disabled) button.style.backgroundColor = '#d43522'; };
  button.onmouseout = () => { if(!button.disabled) button.style.backgroundColor = '#f6412d'; };

  button.onclick = () => {
    exportAllSubscribedMods();
  };

  document.body.appendChild(button);

  async function exportAllSubscribedMods() {
    const originalText = button.innerText;
    button.disabled = true;
    button.style.backgroundColor = '#888';
    button.style.cursor = 'wait';
    
    const mods = new Map();
    const sleep = ms => new Promise(res => setTimeout(res, ms));

    function scrapeCurrentView() {
      // Find all links that go to a mod page (mod.io uses /m/ for mods)
      const modElements = document.querySelectorAll('a[href*="/m/"]');
      
      modElements.forEach(link => {
        if (link.href && !link.href.includes('/members/')) {
          const titleEl = link.querySelector('h3, h4, .title, .font-bold') || link;
          let name = titleEl.innerText.trim() || link.getAttribute('aria-label') || link.title;
          
          // Clean the URL to remove tracking or pagination parameters to avoid duplicates
          const urlObj = new URL(link.href);
          const cleanUrl = urlObj.origin + urlObj.pathname;

          if (name && cleanUrl && !mods.has(cleanUrl) && name.length > 1) {
            mods.set(cleanUrl, { name, url: cleanUrl });
          }
        }
      });
    }

    let loopCount = 0;
    const maxLoops = 200; // Safety limit to prevent infinite loops

    while (loopCount < maxLoops) {
      scrapeCurrentView();
      button.innerText = `⏳ Scraping... (${mods.size} found)`;

      // Try to find the "Next" pagination button or link
      const nextBtn = Array.from(document.querySelectorAll('a, button, div')).find(el => {
        const text = (el.innerText || '').toLowerCase().trim();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        return (text === 'next' || aria.includes('next') || el.rel === 'next') && 
               el.offsetParent !== null; // Ensure it's currently visible on screen
      });

      // Record scroll height in case it uses infinite scrolling instead of a button
      const lastHeight = document.body.scrollHeight;

      if (nextBtn && !nextBtn.disabled && !nextBtn.closest('.disabled') && !nextBtn.hasAttribute('disabled')) {
        nextBtn.click();
        await sleep(3500); // Wait 3.5 seconds for the next page to fetch and render
      } else {
        // Fallback: Try scrolling to the bottom to trigger infinite load
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(3000);
        if (document.body.scrollHeight <= lastHeight) {
          // No new content loaded after scrolling and no next button, we must be at the end
          break; 
        }
      }
      loopCount++;
    }

    if (mods.size === 0) {
      alert('No subscribed mods found. Make sure you are logged in and on https://mod.io/library.');
      resetButton();
      return;
    }

    // Format the text file
    let textContent = `mod.io Subscribed Mods Export\nExported on: ${new Date().toLocaleString()}\nTotal Mods: ${mods.size}\n\n`;
    textContent += '='.repeat(50) + '\n\n';

    let index = 1;
    for (const [url, mod] of mods) {
      textContent += `${index}. ${mod.name}\n   URL: ${mod.url}\n\n`;
      index++;
    }

    // Trigger Download
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `modio-subscribed-mods-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);

    alert(`Success! Exported ${mods.size} mods.`);
    resetButton();

    function resetButton() {
      button.innerText = originalText;
      button.disabled = false;
      button.style.backgroundColor = '#f6412d';
      button.style.cursor = 'pointer';
    }
  }
})();