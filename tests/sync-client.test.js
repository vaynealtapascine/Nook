"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const M = require("../model"), Sync = require("../sync-model");
const clone = (value) => structuredClone(value);
const sample = () => M.normalize({ version: 2, activeId: "draft-1", pieces: [{ id: "piece-1", kind: "quote", title: "First", quote: "Original words", creator: "Writer", createdAt: 1 }], drafts: [{ id: "draft-1", title: "A weave", createdAt: 1, updatedAt: 1, parts: [{ id: "part-1", title: "Opening", columns: 1, items: ["piece-1"] }] }] });
const baseline = (workspace, revision = 1) => ({ clientId: "browser-1", serverId: "server-1", base: clone(workspace), baseRevision: revision, lastSyncedAt: 123 });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flushUntil(condition) { for (let i = 0; i < 40 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve)); assert.ok(condition(), "Expected async operation to begin"); }
function fixture(config = {}) {
  let workspace = clone(config.workspace || sample()), persisted = clone(config.persisted || null), dirty = !!config.dirty, failApply = false;
  const calls = [], modes = [], windowEvents = new Map(), documentEvents = new Map(), timers = new Map();
  let timerId = 0, writeCount = 0, applyCount = 0;
  const document = { hidden: !!config.hidden, activeElement: null, addEventListener: (name, callback) => documentEvents.set(name, callback) };
  const navigator = { onLine: config.online !== false };
  const server = { serverId: "server-1", revision: config.serverRevision || 1, paired: config.paired !== false, initialized: true, workspace: clone(config.serverWorkspace || sample()) };
  const root = { NookModel: M, NookSyncModel: Sync, addEventListener: (name, callback) => windowEvents.set(name, callback) };
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(body) });
  const fetch = async (route, options = {}) => {
    const input = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, input, options });
    if (config.fetch) { const result = await config.fetch(route, input, server); if (result) return result; }
    if (route === "/api/collection/status") return response({ ...server, workspace: undefined });
    if (route === "/api/collection") {
      const result = { serverId: server.serverId, revision: server.revision, workspace: clone(server.workspace), conflicts: [] };
      if (config.pullGate) await config.pullGate.promise;
      return response(result);
    }
    if (route === "/api/sync") {
      const merged = Sync.merge(input.base, input.workspace, server.workspace);
      if (!Sync.equal(merged.workspace, server.workspace)) server.revision++;
      server.workspace = clone(merged.workspace);
      const result = { serverId: server.serverId, revision: server.revision, workspace: clone(server.workspace), conflicts: merged.conflicts };
      if (config.pushGate) await config.pushGate.promise;
      return response(result);
    }
    if (route === "/api/pair") { server.paired = true; return response({ paired: true, serverId: server.serverId }); }
    throw new Error("Unexpected test request: " + route);
  };
  const context = vm.createContext({ window: root, document, navigator, structuredClone, fetch, AbortSignal, Date, setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: (id) => timers.delete(id), setInterval: (callback) => { const id = ++timerId; timers.set(id, callback); return id; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../sync-client.js"), "utf8"), context);
  const options = {
    snapshot: () => clone(workspace),
    hasLocalWork: () => workspace.pieces.length > 0 || workspace.drafts[0].title !== "Untitled webweave",
    isDirty: () => dirty,
    readState: async () => clone(persisted),
    writeState: async (state) => { writeCount++; persisted = clone(state); },
    apply: async (incoming, state) => {
      applyCount++;
      if (failApply) throw new Error("IndexedDB is full");
      workspace = clone(incoming);
      persisted = clone(state);
      dirty = false;
    },
    onStatus: (status) => modes.push(status.mode),
  };
  const client = new root.NookSyncClient(options);
  return { client, calls, modes, server, document, navigator, timers, options,
    workspace: () => clone(workspace), persisted: () => clone(persisted), writeCount: () => writeCount, applyCount: () => applyCount,
    edit: (callback) => { callback(workspace); dirty = true; },
    setPersisted: (value) => { persisted = clone(value); },
    failApply: (value) => { failApply = value; },
    emitOnline: () => windowEvents.get("online")(), response,
  };
}

test("new client pull preserves a piece captured while the server request was in flight", async () => {
  const pullGate = deferred(), local = M.empty(), f = fixture({ workspace: local, pullGate });
  const starting = f.client.start();
  await flushUntil(() => f.calls.some((call) => call.route === "/api/collection"));
  f.edit((workspace) => { workspace.pieces.push({ ...sample().pieces[0], id: "new-local", quote: "Captured during pull" }); });
  pullGate.resolve(); await starting;
  assert.ok(f.workspace().pieces.some((piece) => piece.id === "new-local"));
  assert.ok(f.workspace().pieces.some((piece) => piece.id === "piece-1"));
  assert.equal(f.client.state.base.pieces.some((piece) => piece.id === "new-local"), false);
  assert.equal(f.client.mode, "pending");
});

test("in-flight local edits merge with the reply and the next sync sends the remaining change", async () => {
  const original = sample(), local = clone(original), remote = clone(original), pushGate = deferred();
  local.pieces[0].notes = "Saved locally before sync";
  remote.pieces[0].creator = "Other device creator";
  const f = fixture({ workspace: local, persisted: baseline(original), serverWorkspace: remote, serverRevision: 2, pushGate });
  const starting = f.client.start();
  await flushUntil(() => f.calls.some((call) => call.route === "/api/sync"));
  f.edit((workspace) => { workspace.pieces[0].quote = "Typed during sync"; });
  pushGate.resolve(); await starting;
  assert.equal(f.workspace().pieces[0].quote, "Typed during sync");
  assert.equal(f.workspace().pieces[0].creator, "Other device creator");
  assert.equal(f.workspace().pieces[0].notes, "Saved locally before sync");
  assert.equal(f.client.state.base.pieces[0].quote, "Original words");
  assert.equal(f.client.mode, "pending");
  await f.client.sync();
  assert.equal(f.server.workspace.pieces[0].quote, "Typed during sync");
  assert.equal(f.client.mode, "synced");
});

test("offline edits stay local and reconnect pushes them against the retained baseline", async () => {
  const original = sample(), f = fixture({ persisted: baseline(original), online: false });
  await f.client.start();
  f.edit((workspace) => { workspace.pieces[0].year = "2026"; });
  await f.client.sync();
  assert.equal(f.client.mode, "offline");
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.persisted().base, original);
  f.navigator.onLine = true;
  await f.emitOnline();
  assert.equal(f.server.workspace.pieces[0].year, "2026");
  assert.equal(f.client.state.base.pieces[0].year, "2026");
});

test("failed atomic local save never advances the in-memory or persisted baseline", async () => {
  const original = sample(), local = clone(original), oldState = baseline(original);
  local.pieces[0].notes = "Must remain unsynced if storage fails";
  const f = fixture({ workspace: local, persisted: oldState });
  f.failApply(true);
  await f.client.start();
  assert.equal(f.client.state.baseRevision, 1);
  assert.equal(f.client.state.lastSyncedAt, 123);
  assert.deepEqual(f.client.state.base, original);
  assert.deepEqual(f.persisted(), oldState);
  assert.equal(f.workspace().pieces[0].notes, local.pieces[0].notes);
  assert.match(f.client.lastError, /IndexedDB/);
  f.failApply(false);
  await f.client.sync();
  assert.equal(f.client.state.base.pieces[0].notes, local.pieces[0].notes);
  assert.equal(f.client.mode, "synced");
});

test("hidden tabs make no requests and sync their independent changes when visible", async () => {
  const original = sample(), local = clone(original);
  local.pieces[0].creator = "Edited in background";
  const f = fixture({ workspace: local, persisted: baseline(original), hidden: true });
  await f.client.start();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.persisted().base, original);
  f.document.hidden = false;
  await f.client.sync();
  assert.equal(f.server.workspace.pieces[0].creator, "Edited in background");
});

test("a stale tab refuses to push against a baseline written by another tab", async () => {
  const original = sample(), f = fixture({ persisted: baseline(original) });
  await f.client.start();
  const otherTab = clone(original); otherTab.pieces[0].creator = "New shared copy";
  f.setPersisted(baseline(otherTab, 2));
  f.edit((workspace) => { workspace.pieces[0].notes = "Local work to keep"; });
  const before = f.calls.length;
  await f.client.sync();
  assert.equal(f.calls.length, before);
  assert.equal(f.client.mode, "error");
  assert.match(f.client.lastError, /Another Nook tab/);
  assert.equal(f.client.state.baseRevision, 1);
  assert.equal(f.workspace().pieces[0].notes, "Local work to keep");
});

test("unchanged polling only reads status and clean remote updates use GET", async () => {
  const original = sample(), f = fixture({ persisted: baseline(original) });
  await f.client.start(); await f.client.sync();
  assert.deepEqual(f.calls.map((call) => call.route), ["/api/collection/status", "/api/collection/status"]);
  assert.equal(f.writeCount(), 0);
  assert.equal(f.applyCount(), 0);
  f.server.workspace.pieces[0].year = "2026"; f.server.revision = 2;
  await f.client.sync();
  assert.equal(f.calls.at(-1).route, "/api/collection");
  assert.equal(f.workspace().pieces[0].year, "2026");
  assert.equal(f.client.state.baseRevision, 2);
});

test("different or regressed server identity requires attention and retains the local copy", async () => {
  const original = sample(), f = fixture({ persisted: baseline(original, 2), serverRevision: 1 });
  await f.client.start();
  assert.equal(f.client.mode, "error");
  assert.equal(f.client.state.baseRevision, 2);
  assert.equal(f.calls.length, 1);
  f.server.revision = 2; f.server.serverId = "replacement-server";
  await f.client.sync();
  assert.equal(f.client.mode, "error");
  assert.match(f.client.lastError, /different Nook server/);
  assert.deepEqual(f.workspace(), original);
});

test("beforeSync can defer synchronization while a local transaction or tab reload is pending", async () => {
  const original = sample(), f = fixture({ persisted: baseline(original) });
  f.options.beforeSync = async () => false;
  await f.client.start();
  assert.equal(f.calls.length, 0);
  assert.equal(f.client.mode, "pending");
  f.options.beforeSync = async () => true;
  await f.client.sync();
  assert.equal(f.calls.length, 1);
  assert.equal(f.client.mode, "synced");
});
