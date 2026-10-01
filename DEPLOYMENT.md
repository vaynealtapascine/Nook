# This device serves Nook

Open **https://nook.vayne.garden/** on a device connected to this Tailscale network. Its DNS record points to this computer's Tailscale address, `100.68.254.40`. Caddy supplies a trusted HTTPS certificate and restricts the Nook route to Tailscale addresses and loopback. HTTP redirects to HTTPS. Keep this computer awake and Tailscale connected.

The Nook Node server runs on `127.0.0.1:4177`; the existing Caddy Windows service proxies the domain to it. Other existing Caddy sites retain their routes. The live configuration is `C:\Users\pcuser\selfhost\Caddyfile`. [deployment/Caddyfile.nook](deployment/Caddyfile.nook) records the Nook block without DNS credentials; it uses that installation's existing `common` TLS snippet. The Cloudflare DNS credential remains in the existing Caddy service environment.

## Start after sign-in

The scheduled task **Webweave Nook** starts the Node server in the background when `pcuser` signs into Windows. Caddy is already an automatic Windows service. Run these commands from this repository to start Nook manually or recreate its startup task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start-server.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\register-startup.ps1
```

The start script checks whether this version of Nook is already running. Logs are `.nook-data/server.log` and `.nook-data/server-error.log`. Local use also works at `http://127.0.0.1:4177/`. `nook-network.json` enables the additional Tailscale listener on port 4177 and accepts the domain Host header.

## Pair clients and save the server copy

Each remote browser must pair with this server before reading or syncing the collection. Obtain the pairing key on this computer from `.nook-data/pairing-key.txt` and enter it in Nook's device connection control. Pairing uses a persistent HttpOnly cookie; it does not publish the key in a URL or browser storage.

Pieces, image data, webweaves, parts, and placements sync to `.nook-data/collection.json` on this device. Each client keeps its browser copy for independent work. Use the client sync controls to send local changes and receive changes made elsewhere. Save a portable collection backup as well. The server data folder contains private data and pairing credentials and is excluded from the served files and source control.

To bring an existing browser collection onto this server, first open Nook using that browser's original address, then connect and sync its local collection. Opening the HTTPS domain uses a separate browser storage origin; it starts with its own local copy until synced or imported from a backup.

HTTPS enables browser clipboard permissions and offline application caching. A client must visit Nook while connected once to cache the application and synchronize a copy before working offline. Large OCR assets may need an initial online visit as well. Closing Nook's server or disconnecting Tailscale pauses synchronization; the browser copy stays available.

The HTTPS route also serves `manifest.webmanifest` and the installation icons. Android Chrome can install Nook as a PWA and register its multipart POST Share Target. Incoming shares are intercepted by the service worker and saved on the receiving device, so sharing can work without a live server. Use **Gathering → Install & sharing** for instructions and pending-share retries. Open this same HTTPS origin on each device so installation, pairing, and its offline copy belong to the same app.

Paired devices offload transcription and tagging to `/api/process` by default. This PC runs a single shared OCR queue for both listeners, using the installed `tesseract.js` dependency and bundled `vendor/lang/eng.traineddata.gz`; no runtime language download is needed. Run `npm ci` when setting up a fresh checkout. The OCR subprocess launches in the background when needed and shuts down after an idle minute. Pairing and same-origin JSON checks protect processing requests. Devices fall back to local processing offline and may explicitly select **This device** in Gathering.

## Verify the route

`https://nook.vayne.garden/api/status` reports the application version and pairing state without returning collection content. Unpaired remote requests to the collection, capture, and agent interfaces return 401. Unknown Host headers are rejected, and private server files return 404. The proxy route rejects connections outside the Tailscale address ranges even if they send the Nook Host header.
