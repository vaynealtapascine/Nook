const http = require("node:http"),
  https = require("node:https"),
  dns = require("node:dns").promises,
  net = require("node:net"),
  fs = require("node:fs"),
  path = require("node:path");
const { spawn } = require("node:child_process");
const { makeAgentHandler } = require("./agent-api");
const { makeCollectionHandler } = require("./collection-api");
const { createProcessor, readJson: readProcessingJson } = require("./processing-api");
const root = __dirname,
  port = Number(process.env.PORT || 4177);
const agentHandler = makeAgentHandler(
  process.env.NOOK_AGENT_DIR || path.join(root, ".nook-agent"),
);
const collectionHandler = makeCollectionHandler(
  process.env.NOOK_DATA_DIR || path.join(root, ".nook-data"),
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19].includes(b))
    );
  }
  return (
    net.isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:db8|0):/i.test(address)
  );
}
async function retrieve(raw, redirects = 0) {
  if (redirects > 4)
    throw new Error(
      "Too many redirects. Save the link and add details manually.",
    );
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("Use a public HTTP or HTTPS page.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new Error("Only public web pages can be captured.");
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        headers: {
          "User-Agent": "WebweaveNook/2.0",
          Accept: "text/html,image/*;q=0.9",
          "Accept-Encoding": "identity",
        },
        lookup: (hostname, options, callback) =>
          options?.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (!response.headers.location) {
            reject(new Error("Redirect has no destination."));
            return;
          }
          retrieve(
            new URL(response.headers.location, url).href,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(
            new Error(
              `The source returned ${response.statusCode}. The link can still be saved.`,
            ),
          );
          return;
        }
        const type = (response.headers["content-type"] || "")
            .split(";")[0]
            .toLowerCase(),
          isImage = [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
          ].includes(type);
        if (
          !isImage &&
          !["text/html", "application/xhtml+xml"].includes(type)
        ) {
          response.resume();
          reject(new Error("This is not a supported image or web page."));
          return;
        }
        const limit = isImage ? 20 * 1024 * 1024 : 2 * 1024 * 1024;
        let bytes = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > limit) {
            response.destroy();
            reject(
              new Error(
                "This source is too large. Download it and add the file.",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve(
            isImage
              ? {
                  kind: "image",
                  url: url.href,
                  data: `data:${type};base64,${buffer.toString("base64")}`,
                }
              : { kind: "page", url: url.href, html: buffer.toString("utf8") },
          );
        });
      },
    );
    request.setTimeout(15000, () =>
      request.destroy(new Error("The source took too long to respond.")),
    );
    request.on("error", reject);
  });
}
const json = (res, status, body) =>
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    })
    .end(JSON.stringify(body));
const networkFile = path.join(root, "nook-network.json");
const network = fs.existsSync(networkFile) ? JSON.parse(fs.readFileSync(networkFile, "utf8")) : {};
function allowedHosts(req) {
  return ["127.0.0.1:" + req.socket.localPort, "localhost:" + req.socket.localPort,
    ...(network.address ? [network.address + ":" + req.socket.localPort] : []),
    ...[network.hostname, network.publicHostname, process.env.NOOK_PUBLIC_HOSTNAME]
      .filter(Boolean)
      .flatMap(hostname => [hostname + ":" + req.socket.localPort, hostname])];
}
function allowedOrigins(req) {
  return allowedHosts(req).flatMap(host => ["http://" + host, "https://" + host]);
}
function createServer(options = {}) {
  const processor = options.processor || createProcessor(options.processing);
  const server = http.createServer(async (req, res) => {
    if (
      !allowedHosts(req).includes(req.headers.host)
    ) {
      res.writeHead(403).end("Local requests only");
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    if (pathname === "/api/status") {
      json(res, 200, { app: "webweave-nook", version: 3, ...collectionHandler.status(req) });
      return;
    }
    if (["/api/pair", "/api/collection/status", "/api/collection", "/api/sync"].includes(pathname)) {
      await collectionHandler(req, res, pathname);
      return;
    }
    if (pathname.startsWith("/api/agent/")) {
      if (
        (req.headers.origin &&
          !allowedOrigins(req).includes(req.headers.origin)) ||
        (req.method === "POST" &&
          !req.headers["content-type"]?.startsWith("application/json"))
      ) {
        json(res, 403, { error: "Local JSON requests only." });
        return;
      }
      if (!collectionHandler.authorized(req)) {
        json(res, 401, { error: "Pair this device with the Nook server first." });
        return;
      }
      await agentHandler(req, res, pathname);
      return;
    }
    if (pathname === "/api/capture") {
      if (
        req.method !== "POST" ||
        (req.headers.origin &&
          !allowedOrigins(req).includes(req.headers.origin)) ||
        !req.headers["content-type"]?.startsWith("application/json")
      ) {
        json(res, 403, { error: "Capture must be requested from Nook." });
        return;
      }
      if (!collectionHandler.authorized(req)) {
        json(res, 401, { error: "Pair this device with the Nook server first." });
        return;
      }
      try {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 8192)
            throw new Error("Capture request is too large.");
        }
        const input = JSON.parse(body);
        json(res, 200, await retrieve(input.url));
      } catch (e) {
        json(res, 400, { error: e.message || "Could not fetch the source." });
      }
      return;
    }
    if (pathname === '/api/process') {
      if (req.method !== 'POST') { json(res, 405, {error:'Use POST to process a captured piece.'}); return; }
      if ((req.headers.origin && !allowedOrigins(req).includes(req.headers.origin)) || !req.headers['content-type']?.startsWith('application/json')) {
        json(res, 403, {error:'Process captures from Nook using JSON.'}); return;
      }
      if (!collectionHandler.authorized(req)) { json(res, 401, {error:'Pair this device with the Nook server first.'}); return; }
      try { json(res, 200, await processor.process(await readProcessingJson(req))); }
      catch (error) { json(res, error.status || 503, {error: error.message || 'Server processing is unavailable.'}); }
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405).end();
      return;
    }
    if (pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (
      !["/", "/index.html", "/app.js", "/theme.js", "/model.js", "/sync-model.js", "/sync-client.js", "/capture-tools.js", "/processing-client.js", "/share-inbox.js", "/styles.css", "/sw.js", "/manifest.webmanifest", "/icons/nook-192.png", "/icons/nook-512.png", "/icons/nook-maskable-512.png", "/icons/nook-180.png"].includes(
        pathname,
      ) &&
      !pathname.startsWith("/vendor/")
    ) {
      res.writeHead(404).end("Not found");
      return;
    }
    const file =
      pathname === "/"
        ? path.join(root, "index.html")
        : path.resolve(root, "." + pathname);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    });
  });
  server.on('close', () => processor.close());
  return server;
}
function openBrowser() {
  const url = `http://127.0.0.1:${port}`;
  if (process.platform === "win32")
    spawn("cmd.exe", ["/c", "start", "", url], {
      windowsHide: true,
      stdio: "ignore",
    }).unref();
  else console.log(`Open ${url}`);
}
if (require.main === module) {
  const sharedProcessor = createProcessor();
  if (network.address) {
    const remoteServer = createServer({processor:sharedProcessor});
    remoteServer.on("error", err => console.error("Tailscale listener:", err.message));
    remoteServer.listen(port, network.address, () => console.log(`Tailscale Nook: http://${network.address}:${port}`));
  }
  const server = createServer({processor:sharedProcessor});
  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE" && process.argv.includes("--open")) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`);
        if ((await response.json()).app === "webweave-nook") {
          openBrowser();
          return;
        }
      } catch {}
    }
    console.error("Could not start Nook:", err.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Webweave Nook: http://127.0.0.1:${port}\nKeep this window open while using Nook.`,
    );
    if (process.argv.includes("--open")) openBrowser();
  });
}
module.exports = { publicAddress, createServer };
