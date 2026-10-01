"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), http = require("node:http"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { makeCollectionHandler } = require("../collection-api"), M = require("../model"), Sync = require("../sync-model");
const clone = (value) => structuredClone(value);
const sample = () => M.normalize({ version: 2, activeId: "draft-1", pieces: [{ id: "piece-1", kind: "quote", title: "First", quote: "One\nTwo", creator: "Author", createdAt: 1, tags: ["home"] }, { id: "piece-2", kind: "image", title: "Picture", imageData: "data:image/png;base64,aGVsbG8=", createdAt: 1 }], drafts: [{ id: "draft-1", title: "A weave", createdAt: 1, updatedAt: 1, parts: [{ id: "part-1", title: "Opening", columns: 1, items: ["piece-1", "piece-1", "piece-2"] }, { id: "part-2", title: "End", columns: 2, items: [] }] }] });
async function fixture(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nook-sync-"));
  let handler, server, url;
  async function start() {
    handler = makeCollectionHandler(directory, options);
    server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://localhost").pathname).catch((error) => { res.writeHead(500).end(error.message); }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = "http://127.0.0.1:" + server.address().port;
  }
  async function stop() { if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); server = null; } }
  t.after(async () => { await stop(); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  await start();
  return {
    directory,
    restart: async () => { await stop(); await start(); },
    request: (route, payload, headers = {}) => new Promise((resolve, reject) => {
      const request = http.request(url + route, { method: payload === undefined ? "GET" : "POST", headers: { ...(payload === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, (response) => {
        let content = "";
        response.on("data", (chunk) => { content += chunk; });
        response.on("end", () => { try { resolve({ status: response.statusCode, body: JSON.parse(content), cookie: response.headers["set-cookie"]?.[0] || null }); } catch (error) { reject(error); } });
      });
      request.on("error", reject);
      request.end(payload === undefined ? undefined : JSON.stringify(payload));
    }),
    sync: async (workspace, base = null, baseRevision = 0, extra = {}) => {
      const response = await fetch(url + "/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId: "test-device", workspace, base, baseRevision, ...extra }) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test("server saves complete pieces, images and repeated placements across a restart", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/collection/status")).body.initialized, false);
  assert.equal((await f.request("/api/collection")).body.workspace, null);
  const initial = await f.sync(sample());
  assert.equal(initial.status, 200);
  assert.equal(initial.body.revision, 1);
  assert.deepEqual(initial.body.workspace, sample());
  const key = await fs.readFile(path.join(f.directory, "pairing-key.txt"), "utf8");
  assert.ok(key.trim().length >= 32);
  await f.restart();
  const result = await f.request("/api/collection");
  assert.equal(result.body.serverId, initial.body.serverId);
  assert.equal(result.body.revision, 1);
  assert.deepEqual(result.body.workspace, sample());
});

test("independent offline field edits and tag changes merge through actual HTTP", async (t) => {
  const f = await fixture(t), initial = (await f.sync(sample())).body;
  const a = clone(initial.workspace), b = clone(initial.workspace);
  a.pieces[0].creator = "Edited creator";
  a.pieces[0].tags = ["home", "rain"];
  a.drafts[0].parts[0].title = "New opening";
  b.pieces[0].year = "2026";
  b.pieces[0].tags = ["light"];
  b.drafts[0].parts[1].columns = 3;
  assert.equal((await f.sync(a, initial.workspace, initial.revision)).status, 200);
  const combined = await f.sync(b, initial.workspace, initial.revision);
  assert.equal(combined.status, 200);
  assert.equal(combined.body.workspace.pieces[0].creator, "Edited creator");
  assert.equal(combined.body.workspace.pieces[0].year, "2026");
  assert.deepEqual(combined.body.workspace.pieces[0].tags.sort(), ["light", "rain"]);
  assert.equal(combined.body.workspace.drafts[0].parts[0].title, "New opening");
  assert.equal(combined.body.workspace.drafts[0].parts[1].columns, 3);
  assert.deepEqual(combined.body.conflicts, []);
});

test("conflicting piece credits preserve both versions and retries do not duplicate recoveries", async (t) => {
  const f = await fixture(t), initial = (await f.sync(sample())).body;
  const remote = clone(initial.workspace), local = clone(initial.workspace);
  remote.pieces[0].creator = "Server writer";
  local.pieces[0].creator = "Offline writer";
  await f.sync(remote, initial.workspace, initial.revision);
  const result = (await f.sync(local, initial.workspace, initial.revision)).body;
  assert.equal(result.workspace.pieces.find((p) => p.id === "piece-1").creator, "Server writer");
  const conflict = result.conflicts[0];
  assert.equal(conflict.type, "piece");
  assert.deepEqual(conflict.fields, ["creator"]);
  assert.equal(result.workspace.pieces.find((p) => p.id === conflict.recoveredId).creator, "Offline writer");
  const retry = (await f.sync(local, initial.workspace, initial.revision)).body;
  assert.equal(retry.workspace.pieces.length, 3);
  assert.equal(retry.conflicts[0].recoveredId, conflict.recoveredId);
});

test("deletion survives stale clients and tombstones prevent fresh-import resurrection", async (t) => {
  const f = await fixture(t), initial = (await f.sync(sample())).body;
  const deleted = clone(initial.workspace);
  deleted.pieces = deleted.pieces.filter((p) => p.id !== "piece-1");
  deleted.drafts[0].parts[0].items = ["piece-2"];
  await f.sync(deleted, initial.workspace, initial.revision);
  const stale = (await f.sync(initial.workspace, initial.workspace, initial.revision)).body;
  assert.equal(stale.workspace.pieces.some((p) => p.id === "piece-1"), false);
  assert.deepEqual(stale.conflicts, []);
  await f.restart();
  const returning = (await f.sync(initial.workspace)).body;
  assert.equal(returning.workspace.pieces.some((p) => p.id === "piece-1"), false);
  assert.ok(returning.workspace.pieces.some((p) => p.quote === "One\nTwo"));
  assert.equal(returning.conflicts[0].reason, "deleted");
});

test("delete versus edit keeps the deletion and recovers edited content with valid placements", () => {
  const base = sample(), deleted = clone(base), edited = clone(base);
  deleted.pieces = deleted.pieces.filter((p) => p.id !== "piece-1");
  deleted.drafts[0].parts[0].items = ["piece-2"];
  edited.pieces[0].quote = "Words added offline";
  const result = Sync.merge(base, edited, deleted);
  assert.equal(result.workspace.pieces.some((p) => p.id === "piece-1"), false);
  assert.ok(result.workspace.pieces.some((p) => p.quote === "Words added offline"));
  assert.doesNotThrow(() => M.normalize(result.workspace));
});

test("concurrent same-part arrangements preserve a recovered part and repeated placements", () => {
  const base = sample(), local = clone(base), remote = clone(base);
  local.drafts[0].parts[0].items = ["piece-1", "piece-2", "piece-1", "piece-1"];
  remote.drafts[0].parts[0].items = ["piece-2", "piece-1"];
  const result = Sync.merge(base, local, remote);
  assert.deepEqual(result.workspace.drafts[0].parts.find((p) => p.id === "part-1").items, remote.drafts[0].parts[0].items);
  assert.deepEqual(result.workspace.drafts[0].parts.find((p) => p.id === result.conflicts[0].recoveredId).items, local.drafts[0].parts[0].items);
});

test("part deletion concurrent with edits recovers the edited part; stale sync leaves it deleted", () => {
  const base = sample(), local = clone(base), remote = clone(base);
  remote.drafts[0].parts = remote.drafts[0].parts.filter((p) => p.id !== "part-2");
  local.drafts[0].parts[1].title = "A new ending";
  const result = Sync.merge(base, local, remote);
  assert.equal(result.workspace.drafts[0].parts.some((p) => p.id === "part-2"), false);
  assert.ok(result.workspace.drafts[0].parts.some((p) => p.title === "A new ending · recovered copy"));
  const next = Sync.merge(base, base, result.workspace, { tombstones: result.tombstones });
  assert.equal(next.workspace.drafts[0].parts.some((p) => p.id === "part-2"), false);
});

test("new local drafts remap placements to their recovered conflicting piece", () => {
  const base = sample(), local = clone(base), remote = clone(base);
  local.pieces[0].quote = "Offline text";
  remote.pieces[0].quote = "Server text";
  local.drafts.push({ ...M.makeDraft("Offline weave"), id: "draft-2", parts: [{ id: "part-new", title: "New", columns: 1, items: ["piece-1"] }] });
  const result = Sync.merge(base, local, remote), recovered = result.workspace.pieces.find((p) => p.quote === "Offline text");
  assert.deepEqual(result.workspace.drafts.find((d) => d.id === "draft-2").parts[0].items, [recovered.id]);
});

test("in-flight edits merge against the sent workspace without overwriting new local work", () => {
  const sent = sample(), current = clone(sent), response = clone(sent);
  current.pieces[0].notes = "Typed while syncing";
  response.pieces[0].creator = "Remote editor";
  const result = Sync.merge(sent, current, response).workspace;
  assert.equal(result.pieces[0].notes, "Typed while syncing");
  assert.equal(result.pieces[0].creator, "Remote editor");
});

test("pairing protects proxied clients, persists sessions, and rejects cross-origin writes", async (t) => {
  const f = await fixture(t), publicHeaders = { Host: "nook.example", "X-Forwarded-For": "203.0.113.1", "X-Forwarded-Proto": "https" };
  assert.equal((await f.request("/api/collection/status", undefined, publicHeaders)).body.paired, false);
  assert.equal((await f.request("/api/collection", undefined, publicHeaders)).status, 401);
  // Forwarded requests never acquire local privileges, even with a loopback Host.
  assert.equal((await f.request("/api/collection", undefined, { "X-Forwarded-For": "203.0.113.1" })).status, 401);
  assert.equal((await f.request("/api/pair", { secret: "incorrect" }, publicHeaders)).status, 401);
  const secret = (await fs.readFile(path.join(f.directory, "pairing-key.txt"), "utf8")).trim();
  assert.equal((await f.request("/api/pair", { secret }, { ...publicHeaders, Origin: "https://attacker.example" })).status, 403);
  const paired = await f.request("/api/pair", { secret, clientId: "phone" }, { ...publicHeaders, Origin: "https://nook.example" });
  assert.equal(paired.status, 200);
  assert.match(paired.cookie, /HttpOnly/);
  assert.match(paired.cookie, /SameSite=Strict/);
  assert.match(paired.cookie, /Secure/);
  const headers = { ...publicHeaders, Cookie: paired.cookie.split(";")[0] };
  assert.equal((await f.request("/api/collection", undefined, headers)).status, 200);
  await f.restart();
  assert.equal((await f.request("/api/collection/status", undefined, headers)).body.paired, true);
  const sessions = await fs.readFile(path.join(f.directory, "sessions.json"), "utf8");
  assert.equal(sessions.includes(paired.cookie.split("=")[1].split(";")[0]), false);
  assert.equal((await f.request("/api/sync", { clientId: "phone", baseRevision: 0, base: null, workspace: sample() }, { ...headers, Origin: "https://attacker.example" })).status, 403);
});

test("invalid revisions and invalid collections leave the durable collection unchanged", async (t) => {
  const f = await fixture(t), initial = (await f.sync(sample())).body;
  const bad = sample(); bad.drafts[0].parts[0].items.push("missing");
  assert.equal((await f.sync(bad, initial.workspace, 1)).status, 400);
  assert.equal((await f.sync(sample(), initial.workspace, 10)).status, 409);
  assert.equal((await f.sync(sample(), null, 1)).status, 400);
  assert.equal((await f.sync(sample(), initial.workspace, 1, { serverId: "different-server" })).status, 409);
  assert.equal((await f.request("/api/collection")).body.revision, 1);
});

test("concurrent HTTP syncs are serialized and retain both device edits", async (t) => {
  const f = await fixture(t), initial = (await f.sync(sample())).body;
  const left = clone(initial.workspace), right = clone(initial.workspace);
  left.pieces[0].creator = "Left creator";
  right.pieces[0].year = "Right year";
  const replies = await Promise.all([f.sync(left, initial.workspace, 1), f.sync(right, initial.workspace, 1)]);
  assert.ok(replies.every((reply) => reply.status === 200));
  assert.deepEqual(replies.map((reply) => reply.body.revision).sort(), [2, 3]);
  const final = (await f.request("/api/collection")).body;
  assert.equal(final.workspace.pieces[0].creator, "Left creator");
  assert.equal(final.workspace.pieces[0].year, "Right year");
  await f.restart();
  assert.deepEqual((await f.request("/api/collection")).body.workspace, final.workspace);
});

test("unchanged syncs and device weave selection do not rewrite the server revision", async (t) => {
  const f = await fixture(t), workspace = sample();
  workspace.drafts.push({ ...M.makeDraft("Second"), id: "draft-2" });
  const initial = (await f.sync(workspace)).body;
  const selected = clone(initial.workspace); selected.activeId = "draft-2";
  const result = (await f.sync(selected, initial.workspace, initial.revision)).body;
  assert.equal(result.revision, initial.revision);
  assert.equal(result.workspace.activeId, "draft-2");
  assert.equal((await f.request("/api/collection")).body.workspace.activeId, "draft-1");
  assert.equal((await f.sync(result.workspace, result.workspace, result.revision)).body.revision, initial.revision);
});

test("a damaged primary uses the previous flushed generation without silently resetting", async (t) => {
  const f = await fixture(t), initial = (await f.sync(sample())).body;
  const changed = clone(initial.workspace); changed.pieces[0].notes = "New generation";
  await f.sync(changed, initial.workspace, 1);
  await fs.writeFile(path.join(f.directory, "collection.json"), "truncated {");
  await f.restart();
  const recovered = await f.request("/api/collection");
  assert.equal(recovered.body.recoveredFromBackup, true);
  assert.equal(recovered.body.revision, 1);
  assert.deepEqual(recovered.body.workspace, initial.workspace);
});
