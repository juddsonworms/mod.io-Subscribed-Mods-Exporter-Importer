let isImporting = false;
let stopRequested = false;
let totalMods = 0;
let currentMod = 0;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStatus') {
    sendResponse({ isImporting, current: currentMod, total: totalMods });
  } 
  else if (request.action === 'stopImport') {
    stopRequested = true;
  } 
  else if (request.action === 'startImport') {
    if (isImporting) return; 
    isImporting = true;
    stopRequested = false;
    totalMods = request.urls.length;
    currentMod = 0;
    processQueue(request.urls);
  }
});

async function processQueue(urls) {
  for (let i = 0; i < urls.length; i++) {
    if (stopRequested) break; // Break the loop if the user hit STOP

    currentMod = i + 1;
    
    // Broadcast progress to the popup (if it happens to be open)
    chrome.runtime.sendMessage({ action: 'progressUpdate', current: currentMod, total: totalMods }).catch(() => {});
    
    const url = urls[i];
    const tab = await chrome.tabs.create({ url: url, active: false });
    
    await waitForTabComplete(tab.id);

    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: clickSubscribeButton });
    } catch (e) {}

    await new Promise(r => setTimeout(r, 1500));
    await chrome.tabs.remove(tab.id);
  }
  
  isImporting = false;
  
  // Notify the popup to reset its UI
  chrome.runtime.sendMessage({ action: 'importDone', stopped: stopRequested }).catch(() => {});
  
  // Send OS Notification
  const msgText = stopRequested 
    ? `Import stopped. Processed ${currentMod - 1} of ${totalMods} mods.` 
    : `Successfully processed all ${totalMods} mods!`;

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 
    title: stopRequested ? 'Import Stopped' : 'Import Complete',
    message: msgText
  });

  // Play a completion chime by injecting audio into the user's active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: playCompletionSound
      }).catch(() => {});
    }
  });
}

function waitForTabComplete(tabId) {
  return new Promise(resolve => {
    chrome.tabs.onUpdated.addListener(function listener(tId, info) {
      if (tId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 2000); 
      }
    });
  });
}

function clickSubscribeButton() {
  const buttons = Array.from(document.querySelectorAll('button, a'));
  const subBtn = buttons.find(b => (b.innerText || '').trim().toLowerCase() === 'subscribe' && !b.disabled);
  if (subBtn) subBtn.click();
}

// Synthesizes a happy 3-note completion chime using browser Audio API
function playCompletionSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C note
    osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.15); // E note
    osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.3); // G note
    
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.6);
    
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch(e) { 
    console.log("Audio failed to play"); 
  }
}
