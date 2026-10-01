"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const M = require("./model"), Sync = require("./sync-model");
const MAX_BODY = 160 * 1024 * 1024;
const SESSION_AGE = 365 * 24 * 60 * 60 * 1000;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const json = (res, status, value, headers = {}) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }).end(JSON.stringify(value));
function localRequest(req) {
  const address = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return false;
  if (["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"].some((name) => req.headers[name])) return false;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL("http://" + req.headers.host).hostname); } catch { return false; }
}
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { const origin = new URL(req.headers.origin); return ["http:", "https:"].includes(origin.protocol) && origin.host === req.headers.host; } catch { return false; }
}
function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [], tooLarge = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        chunks = [];
        if (!tooLarge) { tooLarge = true; reject(Object.assign(new Error("The collection is too large for one sync. Export a backup and reduce image sizes."), { status: 413 })); }
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("Send valid JSON."), { status: 400 })); }
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("The request ended before the collection was received.")));
  });
}
function checkedWorkspace(input) {
  if (!input || input.version !== 2 || !Array.isArray(input.pieces) || !Array.isArray(input.drafts) || !input.drafts.length) throw new Error("Send a complete version 2 collection.");
  if (input.pieces.length > 100000 || input.drafts.length > 10000) throw new Error("This collection contains too many pieces or webweaves.");
  const validId = (id) => typeof id === "string" && /^[a-z0-9-]{1,100}$/i.test(id);
  const draftIds = new Set();
  for (const draft of input.drafts) {
    if (!draft || !validId(draft.id) || draftIds.has(draft.id) || !Array.isArray(draft.parts) || !draft.parts.length || draft.parts.length > 10000) throw new Error("A webweave has invalid or duplicate identifiers or parts.");
    draftIds.add(draft.id);
    const partIds = new Set();
    for (const part of draft.parts) {
      if (!part || !validId(part.id) || partIds.has(part.id) || !Array.isArray(part.items) || part.items.length > 100000) throw new Error("A part has invalid or duplicate identifiers or placements.");
      partIds.add(part.id);
    }
  }
  for (const piece of input.pieces) if (piece && piece.imageData && !M.image(piece.imageData)) throw new Error("A piece contains an unsupported or damaged image.");
  return M.normalize(input);
}
function readFile(filename, fallback) {
  if (!fs.existsSync(filename)) return fallback;
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}
async function atomicWrite(filename, content) {
  const temporary = filename + "." + crypto.randomUUID() + ".tmp";
  let handle;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.promises.rename(temporary, filename);
    // Windows does not expose directory fsync; the file itself has been flushed.
    try { const directory = await fs.promises.open(path.dirname(filename), "r"); try { await directory.sync(); } finally { await directory.close(); } } catch {}
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}
function makeCollectionHandler(directory, options = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "collection.json"), backupFile = path.join(directory, "collection.previous.json"), pairingFile = path.join(directory, "pairing-key.txt"), identityFile = path.join(directory, "server-id.txt"), sessionFile = path.join(directory, "sessions.json");
  function privateText(file, value) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, value + "\n", { flag: "wx", mode: 0o600 });
    return fs.readFileSync(file, "utf8").trim();
  }
  const secret = privateText(pairingFile, crypto.randomBytes(24).toString("base64url"));
  const serverId = privateText(identityFile, crypto.randomUUID());
  let state = null, recoveredFromBackup = false;
  function validateState(value) {
    if (!value || value.format !== "nook-server/v1" || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("The saved server collection is invalid.");
    return { ...value, workspace: checkedWorkspace(value.workspace), tombstones: { pieces: value.tombstones?.pieces || [], drafts: value.tombstones?.drafts || [], parts: value.tombstones?.parts || [] } };
  }
  if (fs.existsSync(filename)) {
    try { state = validateState(readFile(filename)); }
    catch (primaryError) {
      try { state = validateState(readFile(backupFile)); recoveredFromBackup = true; }
      catch { throw new Error("Nook's server collection could not be read. Keep collection.json and collection.previous.json for recovery. " + primaryError.message); }
    }
  } else if (fs.existsSync(backupFile)) { state = validateState(readFile(backupFile)); recoveredFromBackup = true; }
  let sessions = readFile(sessionFile, {});
  sessions = Object.fromEntries(Object.entries(sessions).filter(([token, session]) => /^[a-f0-9]{64}$/.test(token) && session && session.expiresAt > Date.now()));
  let chain = Promise.resolve();
  const failures = new Map();
  const serialize = (operation) => { const pending = chain.then(operation); chain = pending.catch(() => {}); return pending; };
  function authorized(req) {
    if (localRequest(req)) return true;
    let token = "";
    if (req.headers.authorization?.startsWith("Bearer ")) token = req.headers.authorization.slice(7);
    else token = /(?:^|;\s*)nook_session=([a-zA-Z0-9_-]+)/.exec(req.headers.cookie || "")?.[1] || "";
    if (!token || token.length > 200) return false;
    const session = sessions[digest(token)];
    return !!session && session.expiresAt > Date.now();
  }
  function status(req) {
    return { app: "webweave-nook", version: 3, serverId, initialized: !!state, revision: state?.revision || 0, paired: authorized(req), local: localRequest(req), recoveredFromBackup, conflicts: state?.conflicts?.length || 0 };
  }
  async function handler(req, res, pathname) {
    if (pathname === "/api/collection/status") {
      if (req.method !== "GET") return json(res, 405, { error: "Use GET." }, { Allow: "GET" });
      return json(res, 200, status(req));
    }
    if (pathname === "/api/pair") {
      if (req.method !== "POST") return json(res, 405, { error: "Use POST." }, { Allow: "POST" });
      if (!sameOrigin(req) || !req.headers["content-type"]?.startsWith("application/json")) return json(res, 403, { error: "Pair from Nook using JSON." });
      const peer = req.socket.remoteAddress || "unknown";
      const entry = failures.get(peer);
      if (entry && entry.until > Date.now() && entry.count >= 10) return json(res, 429, { error: "Too many pairing attempts. Try again in a minute." }, { "Retry-After": "60" });
      try {
        const input = await readJson(req, 4096);
        const supplied = typeof input.secret === "string" ? input.secret : "";
        if (!supplied || supplied.length > 200 || !crypto.timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(secret)))) {
          const next = entry && entry.until > Date.now() ? entry : { count: 0, until: Date.now() + 60000 };
          next.count++; failures.set(peer, next);
          return json(res, 401, { error: "That pairing key did not match this server." });
        }
        const token = crypto.randomBytes(32).toString("base64url"), key = digest(token), expiresAt = Date.now() + SESSION_AGE;
        await serialize(async () => {
          const next = Object.fromEntries(Object.entries(sessions).filter(([, session]) => session.expiresAt > Date.now()));
          next[key] = { clientId: typeof input.clientId === "string" ? input.clientId.slice(0, 100) : "client", expiresAt };
          await atomicWrite(sessionFile, JSON.stringify(next));
          sessions = next;
        });
        failures.delete(peer);
        const secure = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https";
        return json(res, 200, { paired: true, serverId, expiresAt }, { "Set-Cookie": `nook_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_AGE / 1000}${secure ? "; Secure" : ""}` });
      } catch (error) { return json(res, error.status || 400, { error: error.message || "Pairing failed." }); }
    }
    if (!authorized(req)) return json(res, 401, { error: "Pair this device with the Nook server first.", pairingRequired: true });
    if (pathname === "/api/collection") {
      if (req.method !== "GET") return json(res, 405, { error: "Use GET; send changes to /api/sync." }, { Allow: "GET" });
      return json(res, 200, { serverId, revision: state?.revision || 0, workspace: state ? state.workspace : null, conflicts: state?.conflicts || [], recoveredFromBackup });
    }
    if (pathname !== "/api/sync") return json(res, 404, { error: "Unknown collection endpoint." });
    if (req.method !== "POST") return json(res, 405, { error: "Use POST." }, { Allow: "POST" });
    if (!sameOrigin(req) || !req.headers["content-type"]?.startsWith("application/json")) return json(res, 403, { error: "Sync from Nook using JSON." });
    try {
      const input = await readJson(req, options.maxBody || MAX_BODY);
      if (typeof input.clientId !== "string" || !/^[a-z0-9-]{1,100}$/i.test(input.clientId)) throw new Error("Send a valid device identifier.");
      if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new Error("Send a valid base revision.");
      if (input.serverId && input.serverId !== serverId) return json(res, 409, { error: "This is a different Nook server. Reconnect before syncing.", serverId });
      if (input.baseRevision > 0 && !input.base) throw new Error("An existing client must include its previous server snapshot.");
      if (input.base && input.baseRevision === 0) throw new Error("A new client must use a null base and revision zero.");
      const local = checkedWorkspace(input.workspace), base = input.base ? checkedWorkspace(input.base) : null;
      const result = await serialize(async () => {
        if (input.baseRevision > (state?.revision || 0)) throw Object.assign(new Error("The server is older than this client's saved snapshot. Export your local backup before reconnecting."), { status: 409 });
        const merged = Sync.merge(base, local, state?.workspace || null, { tombstones: state?.tombstones });
        // Choosing a weave is a device preference, so it cannot cause clients to
        // bounce the shared revision back and forth while polling.
        const shared = { ...merged.workspace, activeId: merged.workspace.drafts.some((draft) => draft.id === state?.workspace.activeId) ? state.workspace.activeId : merged.workspace.activeId };
        const conflicts = [...(state?.conflicts || []), ...merged.conflicts].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index).slice(-1000);
        if (state && Sync.equal(shared, state.workspace) && Sync.equal(merged.tombstones, state.tombstones) && Sync.equal(conflicts, state.conflicts || [])) return { serverId, revision: state.revision, workspace: merged.workspace, conflicts: merged.conflicts, updatedAt: state.updatedAt };
        const next = { format: "nook-server/v1", serverId, revision: (state?.revision || 0) + 1, updatedAt: Date.now(), lastClientId: input.clientId, workspace: shared, tombstones: merged.tombstones, conflicts };
        // Keep one fully flushed previous generation before replacing the primary.
        if (state) await atomicWrite(backupFile, JSON.stringify(state));
        await atomicWrite(filename, JSON.stringify(next));
        state = next;
        recoveredFromBackup = false;
        return { serverId, revision: state.revision, workspace: merged.workspace, conflicts: merged.conflicts, updatedAt: state.updatedAt };
      });
      return json(res, 200, result);
    } catch (error) { return json(res, error.status || 400, { error: error.message || "The collection could not be synced." }); }
  }
  handler.authorized = authorized;
  handler.status = status;
  return handler;
}
module.exports = { makeCollectionHandler, checkedWorkspace, localRequest, sameOrigin, atomicWrite };
