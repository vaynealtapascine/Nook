# Nook

A local-first home for collected images, passages, and links. Gather once, arrange pieces across several webweave projects, and export compositions to keep working in Affinity.

**Live:** [nook.vayne.garden](https://nook.vayne.garden/) · [Service status](https://status.vayne.garden/) — our installation requires Tailscale.

- **Collect without stopping.** Paste images, text, or URLs; drop files; use Quick capture, the web clipper, or Android sharing.
- **Find what you saved.** Browse a masonry grid, search and filter, favorite pieces, and select a set to work with.
- **Weave across projects.** Reuse a piece in several projects and parts. Arrange stacked, paired, or triptych layouts without duplicating its credits.
- **Keep the source attached.** Edit authors, works, years, links, tags, notes, and descriptions; review sourced research suggestions before applying them.
- **Take it into Affinity.** Export SVG with embedded images, editable text, and separate groups, or use the preview and print/PDF options.
- **Work locally and sync privately.** Each browser keeps an offline copy. Pair devices with your own server, merge changes, and review conflicts.
- **Read image text on your own devices.** Bundled English OCR runs on the server or in the browser. No hosted OCR or AI service is required.

## Quick start

Use Node.js 22 or newer and npm.

```sh
git clone https://github.com/vaynealtapascine/Nook.git
cd Nook
npm ci
npm start
```

Open **http://127.0.0.1:4177/**. Keep the terminal running while using Nook. On Windows, you can also double-click **Start Webweave Nook.cmd**. There is no build step: the Node server serves the app and its local APIs.

Local loopback use is trusted. The first run creates the server collection and a device pairing key in `.nook-data/`. Browser working copies live in IndexedDB; server data and research caches stay outside source control.

## Run it on your own network

Put the server behind an HTTPS proxy to enable remote clipboard permissions and offline app caching. Our installation uses Windows, Caddy, and Tailscale; **[DEPLOYMENT.md](DEPLOYMENT.md)** documents the live route and background startup scripts. The domain and addresses in that guide belong to our installation; use your own for a separate server.

On this PC, the shared server listens at `127.0.0.1:4177`. Other devices open **[nook.vayne.garden](https://nook.vayne.garden/)** with Tailscale connected, then pair in **Devices & sync**. Keep the host PC awake and connected while syncing.

## Five ways to work

- **Gathering:** copy and paste, then keep going. Paste images, passages, or URLs, drop image files, or use Quick capture. Image transcription runs in the background with bundled English OCR; word-based tags are added automatically. Both can be switched off. Credits can wait until Marking.
- **Nipping:** browse a masonry grid, search and filter the collection, and select a few pieces. Adjust thumbnail size, favorite pieces, and carry your selection into Weaving or Peeling.
- **Weaving:** create, switch, or duplicate projects. Arrange shared pieces into named parts; drag to place and reorder them, or use the placement and arrow controls. Choose stacked, paired, or triptych layouts. A piece can appear in several parts and projects.
- **Marking:** complete authors, work titles, years, source links, tags, notes, and descriptions. Apply shared metadata to a selection or inspect one piece. Changes to a piece's credits follow it across projects. Research tools and sourced suggestions live here too.
- **Peeling:** export the current project, an individual part, or selected pieces as SVG for Affinity. Images are embedded, passages remain text, and pieces have their own groups. Preview, print/PDF, linked citations, and descriptions are available alongside export. Refine the composition in Affinity; the export is an SVG interchange document.

Automatic tags use captured words, hashtags, and a small set of themes. OCR reads text; it does not identify a scene or invent an attribution. Review transcription and add visual descriptions in Marking.

## Your devices and the server

Open **Devices & sync** to connect a browser, see the last sync, or **Sync now**. Remote browsers pair using the key in `.nook-data/pairing-key.txt` on this PC. Local loopback use is trusted. The key is kept on the server; paired browsers receive an HttpOnly session cookie.

Pieces, images, projects, parts, and ordering are saved durably in `.nook-data/collection.json`. Writes are serialized, flushed, and replaced atomically; the previous server snapshot is retained for recovery. Each browser keeps its full working copy and last shared snapshot in IndexedDB. Local saving and server synchronization have separate status indicators.

Paired clients sync automatically after changes and check for updates while in use. They can continue independently when the server is asleep or the connection drops, then sync when connected again. Edits to different details merge. When devices change the same detail, Nook preserves both versions using recovered copies of pieces, parts, or projects. **Devices & sync** lists conflicts for review.

The active project is a device preference. Switching projects on one device does not switch another device's workspace. Research snapshots and suggestion packets remain in the separate `.nook-agent/` cache; they are excluded from collection sync and portable collection backups.

## Offline copies and backups

Gathering defaults to **Processing → Server when connected**. Paired browsers send captured images and words to this PC through `/api/process`; it runs English Tesseract OCR and word/theme tagging, then sends the results back for local saving and normal collection sync. No outside OCR or AI service is called. Concurrent image jobs are queued, repeated image requests reuse recent results, and the isolated OCR process stops after a minute without work. Text-only tagging does not start an OCR process.

If the server is unavailable or the browser is not paired, processing falls back to the device. Choose **Processing → This device** to always process locally. Marking's **Suggest tags** and image-description transcription use the same preference. Gathering labels new results **On server** or **On this device**. Images are saved locally before processing; unreadable captures remain available for manual correction. Server OCR accepts embedded PNG/JPEG/WebP/GIF images up to 20 MB; its English language model is bundled with Nook.

Visit the HTTPS app while connected once and let it load to cache the application. Sync a collection onto the device before taking it offline. Collecting files, editing, arranging, credits, and exports then work from the browser copy. To prepare offline OCR, select **Processing → This device** and transcribe an image while connected once; that caches its recognition engine and language assets. Server processing does not download the browser's OCR engine. Without the local engine cached, offline images stay saved and processing retries when you reconnect. Fetching web pages or remote images still needs a connection. API responses and pairing credentials are not stored in the application cache.

**Back up collection** (`Ctrl+S`) downloads a portable `.webweave.json` file with images and every project. Importing a backup merges it into the current collection; older single-project files are supported. Keep portable backups in addition to synchronized copies. Browser storage has a capacity limit, and clearing site data removes that device's local copy and pairing session.

Browser storage belongs to an address. Your old localhost, Tailscale IP, and HTTPS domain copies are separate. To move an existing collection, open its original address and sync it, or export a backup there and import it at the new address. Pairing an empty new browser downloads the server collection.

## Capture and research helpers

### Install Nook and share from Android

With Tailscale connected, open **https://nook.vayne.garden/** in Android Chrome. In **Gathering → Install & sharing**, use **Install Nook**, or choose **Install app / Add to Home screen** from Chrome's menu. Once installed, Nook can appear in other apps' Android Share menu. Share text, a link, or PNG/JPEG/WebP/GIF images into Gathering; transcription and tagging follow your capture preferences. Each image can be up to 20 MB, with up to 80 MB in one share.

The service worker saves incoming shares in a separate local IndexedDB inbox before opening Gathering, including while offline. Nook removes an inbox entry only after the pieces and a receipt are committed to the local collection. Interrupted saves can be retried from **Install & sharing** without duplicating pieces. Pair the device in **Devices & sync** to synchronize with this PC. Installing and initial caching require a connection; subsequent capture and editing work locally. Android's native Share chooser needs an installed PWA; support depends on the receiving browser. [Chrome's Share Target documentation](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target) describes this requirement.

On iPhone/iPad, use Safari's **Share → Add to Home Screen** to install, and use copy/paste to gather. This app's Android Share Target has been tested through multipart browser submissions (text, links, multiple images, offline capture, restart, and sync); an actual Android system Share chooser still needs device verification.

**Web clipper & shortcuts** in Gathering provides a bookmarklet: run it on a page to bring selected text and its source into Nook. Image file imports provide a review tray with duplicate checks and shared credits.

Research assistants can read context, inspect collected images, and propose sourced updates or additions through the authenticated agent interface and `nook-agent.js`. Review suggestions before applying them. Accepted evidence stays attached to the piece. Nook does not automatically call an AI service. See [AGENT_GUIDE.md](AGENT_GUIDE.md).

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+V | Gather clipboard content outside text fields |
| Ctrl+Shift+V | Capture while editing |
| Ctrl+K | Quick capture |
| Ctrl+F | Search collection |
| Ctrl+S | Back up every project and piece |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo outside text fields |
| Escape | Close details or dialog |

## Development

`npm run check` checks JavaScript syntax. `npm test` checks migration, imports, transcription tags, research validation, persistence, offline merging, recovery, pairing, and server boundaries. The `vendor/` folder includes Tesseract.js, its core, English trained data, and their notices for local OCR. No analytics or hosted cloud account is required.

## Documentation

- [Deployment](DEPLOYMENT.md): HTTPS, Windows startup, device pairing, and route verification.
- [Agent guide](AGENT_GUIDE.md): authenticated research tools, evidence, and reviewable proposals.
- The `vendor/` directory includes the third-party OCR engine, language assets, and their notices.

## AI assistance

Nook is developed with AI assistance. Research suggestions are reviewed before they change a collection; the app does not automatically call a hosted AI service.
