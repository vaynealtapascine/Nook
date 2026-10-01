(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NookModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const id = () => globalThis.crypto.randomUUID?.() || "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (Number(c) ^ (globalThis.crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16));
  const text = (value) => (typeof value === "string" ? value : "");
  const tags = (value) => [
    ...new Set(
      (Array.isArray(value) ? value : text(value).split(","))
        .map((s) => text(s).trim().replace(/^#/, ""))
        .filter(Boolean),
    ),
  ];
  const image = (value) =>
    /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(value || "")
      ? value
      : "";
  const makeDraft = (title = "Untitled webweave") => ({
    id: id(),
    title,
    notes: "",
    status: "gathering",
    parts: [{ id: id(), title: "Part one", columns: 1, items: [] }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const empty = () => {
    const draft = makeDraft();
    return { version: 2, pieces: [], drafts: [draft], activeId: draft.id };
  };
  const fields = [
    "title",
    "creator",
    "creatorUrl",
    "contributors",
    "workTitle",
    "workType",
    "year",
    "url",
    "notes",
    "quote",
    "visualNotes",
    "ocrText",
    "transcriptionStatus",
    "taggingStatus",
    "processingSource",
    "altText",
    "annotation",
  ];
  function normalize(raw) {
    if (!raw || !Array.isArray(raw.pieces))
      throw new Error("This is not a Nook project or collection.");
    const sourceDrafts =
      raw.version === 2 ? raw.drafts : Array.isArray(raw.parts) ? [raw] : null;
    if (!Array.isArray(sourceDrafts) || !sourceDrafts.length)
      throw new Error("No drafts were found.");
    const seen = new Set(),
      pieces = raw.pieces.map((p) => {
        if (
          !p ||
          !/^[a-z0-9-]{1,100}$/i.test(p.id) ||
          seen.has(p.id) ||
          !["image", "quote", "link"].includes(p.kind)
        )
          throw new Error(
            "The collection contains an invalid or duplicate piece.",
          );
        seen.add(p.id);
        return {
          id: p.id,
          kind: p.kind,
          ...Object.fromEntries(fields.map((k) => [k, text(p[k])])),
          research: Array.isArray(p.research)
            ? p.research
                .filter((e) => e && typeof e.url === "string")
                .map((e) => ({
                  url: text(e.url),
                  note: text(e.note),
                  agent: text(e.agent),
                }))
            : [],
          tags: tags(p.tags),
          favorite: !!p.favorite,
          trashed: !!p.trashed,
          imageData: image(p.imageData),
          width: Math.max(0, Number(p.width) || 0),
          height: Math.max(0, Number(p.height) || 0),
          createdAt: Number(p.createdAt) || Date.now(),
        };
      });
    const draftIds = new Set();
    const drafts = sourceDrafts.map((d) => {
      if (!Array.isArray(d.parts) || !d.parts.length)
        throw new Error("A draft has no valid parts.");
      const draftId =
        /^[a-z0-9-]{1,100}$/i.test(d.id || "") && !draftIds.has(d.id)
          ? d.id
          : id();
      draftIds.add(draftId);
      const partIds = new Set();
      return {
        id: draftId,
        title: text(d.title) || "Untitled webweave",
        notes: text(d.notes),
        status: ["gathering", "weaving", "finished"].includes(d.status)
          ? d.status
          : "gathering",
        createdAt: Number(d.createdAt) || Date.now(),
        updatedAt: Number(d.updatedAt) || Date.now(),
        parts: d.parts.map((p) => {
          if (
            !p ||
            !Array.isArray(p.items) ||
            p.items.some((item) => !seen.has(item))
          )
            throw new Error("A part refers to a missing piece.");
          const partId =
            /^[a-z0-9-]{1,100}$/i.test(p.id || "") && !partIds.has(p.id)
              ? p.id
              : id();
          partIds.add(partId);
          return {
            id: partId,
            title: text(p.title) || "Untitled part",
            columns: [1, 2, 3].includes(p.columns) ? p.columns : 1,
            items: [...p.items],
          };
        }),
      };
    });
    return {
      version: 2,
      pieces,
      drafts,
      appliedProposals: Array.isArray(raw.appliedProposals)
        ? raw.appliedProposals.filter((x) => typeof x === "string")
        : [],
      appliedShares: Array.isArray(raw.appliedShares)
        ? [...new Set(raw.appliedShares.filter((x) => typeof x === "string"))]
        : [],
      activeId: drafts.some((d) => d.id === raw.activeId)
        ? raw.activeId
        : drafts[0].id,
    };
  }
  function merge(current, incoming) {
    const result = normalize(current),
      mapping = new Map();
    for (const p of incoming.pieces) {
      const match = result.pieces.find((q) => q.id === p.id);
      if (match && JSON.stringify(match) === JSON.stringify(p))
        mapping.set(p.id, p.id);
      else {
        const next = { ...p, id: match ? id() : p.id };
        mapping.set(p.id, next.id);
        result.pieces.push(next);
      }
    }
    for (const d of incoming.drafts)
      result.drafts.push({
        ...d,
        id: id(),
        parts: d.parts.map((p) => ({
          ...p,
          id: id(),
          items: p.items.map((item) => mapping.get(item)),
        })),
      });
    result.activeId = result.drafts.at(-1).id;
    result.appliedShares = [...new Set([...result.appliedShares, ...(incoming.appliedShares || [])])];
    return result;
  }
  function snapshot(w) {
    return {
      ...w,
      pieces: w.pieces.map((p) => ({ ...p, tags: [...(p.tags || [])] })),
      drafts: w.drafts.map((d) => ({
        ...d,
        parts: d.parts.map((p) => ({ ...p, items: [...p.items] })),
      })),
    };
  }
  return { id, tags, image, makeDraft, empty, normalize, merge, snapshot };
});
