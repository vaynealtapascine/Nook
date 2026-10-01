"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const start = source.indexOf("  function readLocalSnapshot(db) {"), end = source.indexOf("  async function loadLocal", start);
assert.ok(start >= 0 && end > start);
const readLocalSnapshot = vm.runInNewContext("(" + source.slice(start, end).trim().replace(/^function readLocalSnapshot/, "function") + ")", { structuredClone, Map, Error });
function database(stores, onWorkspace) {
  const transactions = [];
  return { transactions, transaction(names, mode) {
    transactions.push({ names, mode });
    const snapshot = structuredClone(stores), queue = [];
    let aborted = false;
    const tx = { error: null,
      objectStore(name) { assert.ok(names.includes(name)); return { get(key) { const request = {}; queue.push({ name, key, request }); return request; } }; },
      abort() { aborted = true; queueMicrotask(() => tx.onabort?.()); },
    };
    setImmediate(() => {
      while (queue.length && !aborted) {
        const { name, key, request } = queue.shift();
        request.result = structuredClone(snapshot[name]?.[key]);
        request.onsuccess?.();
        if (name === "projects" && key === "workspace") onWorkspace?.(stores);
      }
      if (!aborted) tx.oncomplete?.();
    });
    return tx;
  } };
}

test("local load reads metadata, image assets and sync baseline from one transaction generation", async () => {
  const stores = { projects: { workspace: { _revision: 4, pieces: [{ id: "image-1", assetId: "image-1", imageData: "" }] }, "server-sync": { baseRevision: 2 }, current: null }, assets: { "image-1": "data:image/png;base64,b2xk" } };
  const db = database(stores, (live) => {
    live.projects["server-sync"] = { baseRevision: 3 };
    live.projects.workspace._revision = 5;
    live.assets["image-1"] = "data:image/png;base64,bmV3";
  });
  const result = await readLocalSnapshot(db);
  assert.equal(result.saved._revision, 4);
  assert.equal(result.sync.baseRevision, 2);
  assert.equal(result.saved.pieces[0].imageData, "data:image/png;base64,b2xk");
  assert.equal(result.images.get("image-1"), result.saved.pieces[0].imageData);
  assert.equal(db.transactions.length, 1);
  assert.deepEqual(Array.from(db.transactions[0].names), ["projects", "assets"]);
  assert.equal(db.transactions[0].mode, "readonly");
});

test("missing saved image aborts loading instead of silently replacing it with blank data", async () => {
  const db = database({ projects: { workspace: { pieces: [{ id: "image-1", assetId: "missing" }] } }, assets: {} });
  await assert.rejects(readLocalSnapshot(db), /saved image could not be loaded/);
});
