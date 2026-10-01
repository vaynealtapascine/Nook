const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server");

test("proxied clients cannot bypass pairing through the loopback listener", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "X-Forwarded-For": "100.64.0.2" };
  const status = await (await fetch(base + "/api/status", { headers })).json();
  assert.equal(status.paired, false);
  for (const pathname of ["/api/collection", "/api/agent/proposals"]) {
    assert.equal((await fetch(base + pathname, { headers })).status, 401, pathname);
  }
  const capture = await fetch(base + "/api/capture", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  assert.equal(capture.status, 401);
});

test("server never serves collection files, credentials, or source modules", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const pathname of ["/.nook-data/pairing-key.txt", "/.nook-data/collection.json", "/collection-api.js", "/server.js"]) {
    assert.equal((await fetch(base + pathname)).status, 404, pathname);
  }
  for (const pathname of ["/sync-model.js", "/sync-client.js", "/capture-tools.js", "/sw.js"]) {
    assert.equal((await fetch(base + pathname)).status, 200, pathname);
  }
});
