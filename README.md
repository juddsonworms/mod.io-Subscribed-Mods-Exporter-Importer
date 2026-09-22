# mod.io Subscribed Mods Exporter

A lightweight, powerful Chrome Extension (Manifest V3) that makes it easy to back up your entire mod.io library. With a single click, this tool automatically scans your subscribed mods, navigates through multiple pages, and generates a clean text file containing the names and direct links to every mod in your collection.

##  Features

* **One-Click Automation:** Accessible directly from your Chrome toolbar.
* **Smart Detection:** Automatically checks if you are on the `mod.io/library` page. If not, provides a quick link to take you there.
* **Auto-Pagination Scraper:** Automatically clicks through "Next" pages and scrolls to ensure no mod is left behind, no matter how large your collection is.
* **Live Progress Overlay:** Injects a sleek, dark-mode glassmorphism overlay on the webpage so you can watch the scraper find your mods in real-time.
* **Clean Text Output:** Downloads a neatly formatted `.txt` file with numbered titles and direct URLs, ready to be copied or archived.
* **Popup Safety:** Safe to close the extension menu while scraping; the script continues to run seamlessly on the page.

##  Installation

Since this extension is not currently published on the Chrome Web Store, you can easily install it locally as an "unpacked" extension.

1. **Download the code:** Go to releases and download the latest version
2. **Open Chrome Extensions:** Open Google Chrome and navigate to `chrome://extensions/` in your address bar.
3. **Enable Developer Mode:** Toggle the **Developer mode** switch in the top right corner.
4. **Load the Extension:** Drag and drop the zip file onto the extensions tab

##  Usage

1. **Pin the Extension:** For easy access, click the "Puzzle" icon in your Chrome toolbar and click the pin icon next to "mod.io Library Exporter".
2. **Open the Menu:** Click the extension icon. If you aren't on mod.io, click the "Open mod.io Library" button.
3. **Log In:** Ensure you are logged into your mod.io account.
4. **Export:** Click the extension icon again and click **"📥 Export Subscribed Mods"**.
5. **Wait:** A dark overlay will appear on your screen showing the scraping progress. Let it run!
6. **Save:** Once finished, a `.txt` file will automatically download to your computer.
