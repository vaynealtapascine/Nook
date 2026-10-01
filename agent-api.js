const fs = require("node:fs/promises"),
  path = require("node:path"),
  { randomUUID } = require("node:crypto");
const fields = [
  "creator",
  "creatorUrl",
  "contributors",
  "workTitle",
  "workType",
  "year",
  "url",
  "annotation",
  "tags",
  "altText",
  "visualNotes",
];
const schema = {
  format: "nook-research/v1",
  description:
    "Submit evidence-backed suggestions. Nook asks the user to review them and fills only empty fields. Tags are merged.",
  example: {
    format: "nook-research/v1",
    agent: "Research assistant",
    summary: "Verified the creator and original publication.",
    updates: [
      {
        pieceId: "ID-FROM-CONTEXT",
        fields: {
          creator: "Author name",
          workTitle: "Work title",
          url: "https://example.com/original",
        },
        evidence: [
          {
            url: "https://example.com/original",
            note: "The original page identifies the author and title.",
          },
        ],
      },
    ],
    additions: [
      {
        kind: "quote",
        title: "A related passage",
        quote: "Exact passage copied from the cited source.",
        creator: "Author name",
        workTitle: "Work title",
        url: "https://example.com/original",
        tags: ["theme"],
        evidence: [
          {
            url: "https://example.com/original",
            note: "Primary source for this passage.",
          },
        ],
      },
    ],
  },
  allowedUpdateFields: fields,
  rules: [
    "Do not invent creators, titles, quotes, or source links. Leave uncertain fields unfilled.",
    "Use exact piece IDs from context. Include public evidence URLs and an explanation for each update or addition.",
    "For an image addition, supply imageUrl and its source-page url. It will be downloaded only when the user accepts it.",
    "Never submit executable HTML. Quote text must be plain text.",
  ],
};
const webURL = (s) => {
  try {
    return ["https:", "http:"].includes(new URL(s).protocol);
  } catch {
    return false;
  }
};
function evidence(raw) {
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    raw.some(
      (e) =>
        !e || !webURL(e.url) || typeof e.note !== "string" || !e.note.trim(),
    )
  )
    throw new Error(
      "Every suggestion needs an evidence URL and an explanation.",
    );
  return raw.map((e) => ({ url: e.url, note: e.note.slice(0, 5000) }));
}
function validate(raw) {
  if (raw?.format !== "nook-research/v1")
    throw new Error("Expected format nook-research/v1.");
  if (!Array.isArray(raw.updates || []) || !Array.isArray(raw.additions || []))
    throw new Error("Updates and additions must be arrays.");
  if ((raw.updates?.length || 0) + (raw.additions?.length || 0) > 200)
    throw new Error("Submit at most 200 suggestions at a time.");
  const updates = (raw.updates || []).map((u) => {
    if (
      !u ||
      typeof u.pieceId !== "string" ||
      !u.fields ||
      Array.isArray(u.fields) ||
      typeof u.fields !== "object"
    )
      throw new Error("Each update needs a pieceId and fields.");
    const values = {};
    for (const [key, value] of Object.entries(u.fields)) {
      if (!fields.includes(key)) throw new Error(`Unsupported field: ${key}`);
      if (key === "tags") {
        if (!Array.isArray(value) || value.some((t) => typeof t !== "string"))
          throw new Error("Tags must be a list of strings.");
        values.tags = value;
      } else {
        if (typeof value !== "string" || value.length > 50000)
          throw new Error("Suggested field values must be text.");
        if (["url", "creatorUrl"].includes(key) && value && !webURL(value))
          throw new Error("Source and creator links must be HTTP or HTTPS.");
        values[key] = value;
      }
    }
    return {
      pieceId: u.pieceId,
      fields: values,
      evidence: evidence(u.evidence),
    };
  });
  const additions = (raw.additions || []).map((a) => {
    if (!a || !["quote", "image", "link"].includes(a.kind))
      throw new Error("New pieces must be quotes, images, or links.");
    if (a.kind === "quote" && !(typeof a.quote === "string" && a.quote.trim()))
      throw new Error("A quote needs its passage.");
    if (a.kind === "image" && !webURL(a.imageUrl))
      throw new Error("An image needs a public imageUrl.");
    if (!webURL(a.url))
      throw new Error("Every new piece needs its source URL.");
    const out = { kind: a.kind, evidence: evidence(a.evidence) };
    for (const key of ["title", "quote", "imageUrl", ...fields])
      if (a[key] !== undefined) {
        if (key === "tags") {
          if (
            !Array.isArray(a.tags) ||
            a.tags.some((t) => typeof t !== "string")
          )
            throw new Error("Tags must be text.");
          out.tags = a.tags;
        } else {
          if (typeof a[key] !== "string" || a[key].length > 50000)
            throw new Error("Piece fields must be text.");
          out[key] = a[key];
        }
      }
    return out;
  });
  if (!updates.length && !additions.length)
    throw new Error("There are no suggestions in this packet.");
  return {
    format: raw.format,
    agent:
      typeof raw.agent === "string"
        ? raw.agent.slice(0, 200)
        : "Research assistant",
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 5000) : "",
    updates,
    additions,
  };
}
async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 40 * 1024 * 1024)
      throw new Error("Request is too large.");
  }
  return JSON.parse(body);
}
function makeAgentHandler(directory) {
  const queue = path.join(directory, "proposals");
  const send = (res, status, value) =>
    res
      .writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      })
      .end(JSON.stringify(value));
  return async (req, res, pathname) => {
    try {
      const imageMatch = pathname.match(
        /^\/api\/agent\/images\/([a-z0-9-]{1,100})$/i,
      );
      if (imageMatch) {
        const directoryImages = path.join(directory, "images"),
          file = path.join(directoryImages, imageMatch[1] + ".json");
        if (req.method === "GET") {
          const asset = JSON.parse(await fs.readFile(file, "utf8"));
          res
            .writeHead(200, {
              "Content-Type": asset.mime,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            })
            .end(Buffer.from(asset.base64, "base64"));
          return;
        }
        if (req.method === "POST") {
          const input = await readBody(req),
            match = String(input.data || "").match(
              /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=]+)$/i,
            );
          if (!match) throw new Error("Expected a raster image.");
          await fs.mkdir(directoryImages, { recursive: true });
          const temp = path.join(directoryImages, randomUUID() + ".tmp");
          await fs.writeFile(
            temp,
            JSON.stringify({ mime: match[1], base64: match[2] }),
          );
          await fs.rename(temp, file);
          send(res, 200, { ok: true });
          return;
        }
      }
      if (pathname === "/api/agent/schema" && req.method === "GET") {
        send(res, 200, schema);
        return;
      }
      if (pathname === "/api/agent/context") {
        if (req.method === "GET") {
          try {
            send(
              res,
              200,
              JSON.parse(
                await fs.readFile(path.join(directory, "context.json"), "utf8"),
              ),
            );
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
            send(res, 200, {
              message:
                "Open Nook and save your collection to publish its research context.",
              pieces: [],
              drafts: [],
            });
          }
          return;
        }
        if (req.method === "POST") {
          const data = await readBody(req);
          if (data.format !== "nook-context/v1" || !Array.isArray(data.pieces))
            throw new Error("Invalid context.");
          await fs.mkdir(directory, { recursive: true });
          const temp = path.join(directory, randomUUID() + ".tmp");
          await fs.writeFile(temp, JSON.stringify(data));
          await fs.rename(temp, path.join(directory, "context.json"));
          send(res, 200, { ok: true });
          return;
        }
      }
      if (pathname === "/api/agent/proposals") {
        if (req.method === "GET") {
          await fs.mkdir(queue, { recursive: true });
          const names = (await fs.readdir(queue)).filter((n) =>
            n.endsWith(".json"),
          );
          const proposals = await Promise.all(
            names.map(async (n) =>
              JSON.parse(await fs.readFile(path.join(queue, n), "utf8")),
            ),
          );
          send(res, 200, {
            proposals: proposals
              .filter((p) => p.status === "pending")
              .sort((a, b) => b.createdAt - a.createdAt),
          });
          return;
        }
        if (req.method === "POST") {
          const proposal = {
            ...validate(await readBody(req)),
            id: randomUUID(),
            status: "pending",
            createdAt: Date.now(),
          };
          await fs.mkdir(queue, { recursive: true });
          await fs.writeFile(
            path.join(queue, proposal.id + ".json"),
            JSON.stringify(proposal),
            { flag: "wx" },
          );
          send(res, 201, {
            id: proposal.id,
            status: "pending",
            message: "Suggestion queued for review in Nook.",
          });
          return;
        }
      }
      const match = pathname.match(
        /^\/api\/agent\/proposals\/([a-f0-9-]{36})\/status$/i,
      );
      if (match && req.method === "POST") {
        const { status } = await readBody(req);
        if (!["accepted", "dismissed"].includes(status))
          throw new Error("Invalid status.");
        const file = path.join(queue, match[1] + ".json");
        const proposal = JSON.parse(await fs.readFile(file, "utf8"));
        proposal.status = status;
        await fs.writeFile(file, JSON.stringify(proposal));
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { error: "Unknown agent endpoint." });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  };
}
module.exports = { schema, validate, makeAgentHandler };
