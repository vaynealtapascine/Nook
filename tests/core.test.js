const test = require("node:test"),
  assert = require("node:assert/strict");
const M = require("../model"),
  { validate, makeAgentHandler } = require("../agent-api"),
  { publicAddress, createServer } = require("../server");
const http = require("node:http"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const legacy = () => ({
  title: "Old weave",
  pieces: [
    {
      id: "piece-1",
      kind: "quote",
      quote: "Line one\nLine two",
      creator: "Original writer",
    },
  ],
  parts: [{ id: "part-1", title: "Opening", items: ["piece-1", "piece-1"] }],
});
const evidence = [
  { url: "https://example.com/source", note: "Integration test fixture." },
];
test("legacy migration preserves repeated placements and multiline quotes", () => {
  const w = M.normalize(legacy());
  assert.equal(w.version, 2);
  assert.deepEqual(w.drafts[0].parts[0].items, ["piece-1", "piece-1"]);
  assert.equal(w.pieces[0].quote, "Line one\nLine two");
  assert.equal(w.pieces[0].creator, "Original writer");
});
test("invalid imports cannot silently discard missing references", () => {
  const x = legacy();
  x.parts[0].items.push("missing");
  assert.throws(() => M.normalize(x), /missing piece/);
});
test("unsafe IDs and duplicate IDs are rejected", () => {
  const x = legacy();
  x.pieces[0].id = 'bad\"id';
  assert.throws(() => M.normalize(x));
  const y = legacy();
  y.pieces.push({ ...y.pieces[0] });
  assert.throws(() => M.normalize(y), /duplicate/);
});
test("multiple drafts and shared piece references survive a backup round trip", () => {
  const w = M.normalize(legacy());
  w.drafts.push({
    ...M.makeDraft("Second"),
    parts: [{ id: "part-2", title: "Again", columns: 2, items: ["piece-1"] }],
  });
  w.activeId = w.drafts[1].id;
  const loaded = M.normalize(JSON.parse(JSON.stringify(w)));
  assert.equal(loaded.pieces.length, 1);
  assert.equal(loaded.drafts.length, 2);
  assert.equal(loaded.drafts[1].parts[0].columns, 2);
  assert.equal(loaded.activeId, w.activeId);
});
test("import merges conflicting IDs without replacing current work", () => {
  const a = M.normalize(legacy()),
    b = M.normalize(legacy());
  b.pieces[0].creator = "Different";
  const result = M.merge(a, b);
  assert.equal(result.pieces.length, 2);
  assert.equal(result.pieces[0].creator, "Original writer");
  assert.notEqual(result.drafts[1].parts[0].items[0], "piece-1");
});
test("snapshots isolate metadata and ordering without duplicating asset contents", () => {
  const a = M.normalize(legacy());
  a.pieces[0].tags = ["home"];
  const copy = M.snapshot(a);
  copy.pieces[0].tags.push("rain");
  copy.drafts[0].parts[0].items.pop();
  assert.deepEqual(a.pieces[0].tags, ["home"]);
  assert.equal(a.drafts[0].parts[0].items.length, 2);
});
test("research provenance and applied packet IDs survive backup import", () => {
  const a = M.normalize(legacy());
  a.pieces[0].research = [{ ...evidence[0], agent: "Researcher" }];
  a.appliedProposals = ["packet-1"];
  const loaded = M.normalize(a);
  assert.equal(loaded.pieces[0].research[0].agent, "Researcher");
  assert.deepEqual(loaded.appliedProposals, ["packet-1"]);
});
test("agent updates require evidence and reject arbitrary fields", () => {
  assert.throws(
    () =>
      validate({
        format: "nook-research/v1",
        updates: [{ pieceId: "p", fields: { creator: "X" }, evidence: [] }],
      }),
    /evidence/,
  );
  assert.throws(
    () =>
      validate({
        format: "nook-research/v1",
        updates: [{ pieceId: "p", fields: { imageData: "bad" }, evidence }],
      }),
    /Unsupported/,
  );
});
test("agent additions require attributable sources and exact quote text", () => {
  assert.throws(
    () =>
      validate({
        format: "nook-research/v1",
        additions: [{ kind: "quote", url: "https://example.com", evidence }],
      }),
    /passage/,
  );
  const packet = validate({
    format: "nook-research/v1",
    additions: [
      {
        kind: "quote",
        quote: "Exact words",
        url: "https://example.com",
        evidence,
      },
    ],
  });
  assert.equal(packet.additions[0].quote, "Exact words");
});
test("capture excludes local and reserved addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.0.1",
    "172.16.1.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700:4700::1111"), true);
});
test("agent inbox survives server recreation and can be acknowledged", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nook-agent-test-"));
  const handler = makeAgentHandler(dir),
    server = http.createServer((req, res) =>
      handler(req, res, new URL(req.url, "http://localhost").pathname),
    );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const submit = await fetch(base + "/api/agent/proposals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: "nook-research/v1",
      updates: [{ pieceId: "p", fields: { creator: "Writer" }, evidence }],
    }),
  });
  assert.equal(submit.status, 201);
  const created = await submit.json();
  assert.equal(
    (await (await fetch(base + "/api/agent/proposals")).json()).proposals
      .length,
    1,
  );
  await fetch(base + `/api/agent/proposals/${created.id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "accepted" }),
  });
  assert.equal(
    (await (await fetch(base + "/api/agent/proposals")).json()).proposals
      .length,
    0,
  );
});
test("server blocks cross-origin writes and private-source capture", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`,
    host = "127.0.0.1:" + server.address().port;
  const cross = await fetch(base + "/api/agent/proposals", {
    method: "POST",
    headers: {
      Host: host,
      Origin: "https://other.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(cross.status, 403);
  const local = await fetch(base + "/api/capture", {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://127.0.0.1/" }),
  });
  assert.equal(local.status, 400);
  assert.match((await local.json()).error, /public/);
  assert.equal(
    (await fetch(base + "/server.js", { headers: { Host: host } })).status,
    404,
  );
});
