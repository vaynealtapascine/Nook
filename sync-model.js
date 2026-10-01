(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./model") : root.NookModel);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NookSyncModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (M) => {
  "use strict";
  const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  function canonical(value) {
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
    return JSON.stringify(value);
  }
  const equal = (a, b) => canonical(a) === canonical(b);
  function recoveredId(type, id, value) {
    const source = type + ":" + id + ":" + canonical(value);
    const hashes = [2166136261, 3339675911, 2538058380, 3759814317];
    for (let i = 0; i < source.length; i++) for (let j = 0; j < hashes.length; j++) hashes[j] = Math.imul(hashes[j] ^ (source.charCodeAt(i) + j), 16777619);
    return "recovered-" + hashes.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
  }
  function mergeSet(base = [], local = [], remote = []) {
    const b = new Set(base.map(canonical)), l = new Map(local.map((v) => [canonical(v), v])), r = new Map(remote.map((v) => [canonical(v), v]));
    return [...new Set([...r.keys(), ...l.keys()])].filter((key) => !b.has(key) || (l.has(key) && r.has(key))).map((key) => copy(r.get(key) ?? l.get(key)));
  }
  function merge(base, local, remote, options = {}) {
    local = M.normalize(local);
    remote = remote ? M.normalize(remote) : { version: 2, pieces: [], drafts: [], appliedProposals: [], activeId: "" };
    base = base ? M.normalize(base) : { version: 2, pieces: [], drafts: [], appliedProposals: [], activeId: "" };
    const tombstones = { pieces: [...(options.tombstones?.pieces || [])], drafts: [...(options.tombstones?.drafts || [])], parts: [...(options.tombstones?.parts || [])] };
    const conflicts = [], localPieceMap = new Map(), deletedPieceMap = new Map();
    const recoveredPieces = [], recoveredDrafts = [];
    function record(type, entity, recovered, fields, reason, side = "local") {
      const description = reason === "deleted" ? "An edit met a deletion; the edited version was kept as a recovered copy." : "Both devices changed the same detail; the server version and a recovered copy were kept.";
      conflicts.push({ id: recovered.id, type, entityId: entity.id, recoveredId: recovered.id, title: entity.title || entity.id, fields: [...new Set(fields)], reason, side, details: description });
    }
    function recover(type, entity, fields, reason, side, destination, key = entity.id) {
      const next = copy(entity);
      next.id = recoveredId(type, key, entity);
      next.title = (entity.title || (type === "piece" ? "Untitled piece" : type === "part" ? "Untitled part" : "Untitled webweave")) + " · recovered copy";
      if (!destination.some((entry) => entry.id === next.id)) destination.push(next);
      record(type, entity, next, fields, reason, side);
      return next.id;
    }
    function fields(b, l, r, ignored = []) {
      const result = {}, changed = [];
      for (const key of new Set([...Object.keys(b || {}), ...Object.keys(l), ...Object.keys(r)])) {
        if (ignored.includes(key)) continue;
        if (key === "updatedAt") { result[key] = Math.max(l[key] || 0, r[key] || 0); continue; }
        if (equal(l[key], b?.[key])) result[key] = copy(r[key]);
        else if (equal(r[key], b?.[key]) || equal(l[key], r[key])) result[key] = copy(l[key]);
        else if (["transcriptionStatus", "taggingStatus"].includes(key)) result[key] = l[key] === 'done' || r[key] === 'done' ? 'done' : r[key] || l[key] || '';
        else if (key === 'processingSource') result[key] = r[key] || l[key] || '';
        else if (["tags", "research"].includes(key)) result[key] = mergeSet(b?.[key], l[key], r[key]);
        else { result[key] = copy(r[key]); changed.push(key); }
      }
      return { result, changed };
    }
    function entities(type, bList, lList, rList, mergeEntity, recoverEntity, tombstoneKey = (id) => id) {
      const b = new Map(bList.map((e) => [e.id, e])), l = new Map(lList.map((e) => [e.id, e])), r = new Map(rList.map((e) => [e.id, e]));
      const result = [], deleted = new Set(tombstones[type]);
      for (const id of new Set([...r.keys(), ...l.keys(), ...b.keys()])) {
        const original = b.get(id), left = l.get(id), right = r.get(id), key = tombstoneKey(id);
        if (!original && deleted.has(key)) {
          if (left) recoverEntity(left, [], "deleted", "local");
          if (right) recoverEntity(right, [], "deleted", "server");
          continue;
        }
        if (original && (!left || !right)) {
          deleted.add(key);
          const survivor = left || right;
          if (survivor && !equal(original, survivor)) recoverEntity(survivor, [], "deleted", left ? "local" : "server");
          continue;
        }
        if (!left || !right) { if (left || right) result.push(copy(left || right)); continue; }
        result.push(mergeEntity(original, left, right));
      }
      tombstones[type] = [...deleted];
      return result;
    }
    const pieces = entities("pieces", base.pieces, local.pieces, remote.pieces, (b, l, r) => {
      const merged = fields(b, l, r);
      if (merged.changed.length) localPieceMap.set(l.id, recover("piece", l, merged.changed, "changed", "local", recoveredPieces));
      return merged.result;
    }, (entity, changed, reason, side) => {
      const id = recover("piece", entity, changed, reason, side, recoveredPieces);
      deletedPieceMap.set(entity.id, id);
      if (side === "local") localPieceMap.set(entity.id, id);
    });
    for (const recovered of recoveredPieces) if (!pieces.some((p) => p.id === recovered.id)) pieces.push(recovered);
    const remapLocal = (draft) => ({ ...copy(draft), parts: draft.parts.map((part) => ({ ...copy(part), items: part.items.map((id) => localPieceMap.get(id) || id) })) });
    function order(baseOrder, localOrder, remoteOrder, existing) {
      const available = new Set(existing), common = new Set(baseOrder.filter((id) => localOrder.includes(id) && remoteOrder.includes(id)));
      const shared = (ids) => ids.filter((id) => common.has(id));
      const localChanged = !equal(shared(localOrder), shared(baseOrder)), remoteChanged = !equal(shared(remoteOrder), shared(baseOrder));
      const conflict = localChanged && remoteChanged && !equal(shared(localOrder), shared(remoteOrder));
      const primary = localChanged && !remoteChanged ? localOrder : remoteOrder;
      const secondary = primary === localOrder ? remoteOrder : localOrder;
      const ids = primary.filter((id) => available.has(id));
      for (let i = 0; i < secondary.length; i++) {
        const id = secondary[i];
        if (!available.has(id) || ids.includes(id)) continue;
        const next = secondary.slice(i + 1).find((after) => ids.includes(after));
        ids.splice(next ? ids.indexOf(next) : ids.length, 0, id);
      }
      for (const id of existing) if (!ids.includes(id)) ids.push(id);
      return { ids, conflict };
    }
    const drafts = entities("drafts", base.drafts, local.drafts, remote.drafts, (b, l, r) => {
      const merged = fields(b, l, r, ["parts"]), recoveredParts = [];
      const parts = entities("parts", b?.parts || [], l.parts, r.parts, (bp, lp, rp) => {
        const partMerge = fields(bp, lp, rp);
        if (partMerge.changed.length) recover("part", { ...lp, items: lp.items.map((id) => localPieceMap.get(id) || id) }, partMerge.changed, "changed", "local", recoveredParts, l.id + ":" + lp.id);
        if (!equal(lp.items, bp?.items) && equal(rp.items, bp?.items)) partMerge.result.items = lp.items.map((id) => localPieceMap.get(id) || id);
        return partMerge.result;
      }, (entity, changed, reason, side) => recover("part", side === "local" ? { ...entity, items: entity.items.map((id) => localPieceMap.get(id) || id) } : entity, changed, reason, side, recoveredParts, l.id + ":" + entity.id), (id) => l.id + ":" + id);
      for (const part of parts) if (!(b?.parts || []).some((p) => p.id === part.id) && l.parts.some((p) => p.id === part.id) && !r.parts.some((p) => p.id === part.id)) part.items = part.items.map((id) => localPieceMap.get(id) || id);
      for (const recovered of recoveredParts) if (!parts.some((p) => p.id === recovered.id)) parts.push(recovered);
      const ordered = order((b?.parts || []).map((p) => p.id), l.parts.map((p) => p.id), r.parts.map((p) => p.id), parts.map((p) => p.id));
      merged.result.parts = ordered.ids.map((id) => parts.find((part) => part.id === id));
      if (ordered.conflict) merged.changed.push("part order");
      if (merged.changed.length) recover("draft", remapLocal(l), merged.changed, "changed", "local", recoveredDrafts);
      return merged.result;
    }, (entity, changed, reason, side) => recover("draft", side === "local" ? remapLocal(entity) : entity, changed, reason, side, recoveredDrafts));
    for (const draft of drafts) if (!base.drafts.some((d) => d.id === draft.id) && local.drafts.some((d) => d.id === draft.id) && !remote.drafts.some((d) => d.id === draft.id)) draft.parts.forEach((part) => { part.items = part.items.map((id) => localPieceMap.get(id) || id); });
    for (const recovered of recoveredDrafts) if (!drafts.some((d) => d.id === recovered.id)) drafts.push(recovered);
    if (!drafts.length) {
      const blank = M.makeDraft();
      blank.id = recoveredId("blank", "draft", [...tombstones.drafts].sort());
      blank.parts[0].id = recoveredId("blank", "part", blank.id);
      drafts.push(blank);
    }
    const availablePieces = new Set(pieces.map((p) => p.id));
    for (const draft of drafts) {
      for (const part of draft.parts) part.items = part.items.map((id) => availablePieces.has(id) ? id : deletedPieceMap.get(id)).filter((id) => availablePieces.has(id));
      if (!draft.parts.length) draft.parts.push({ id: recoveredId("blank", "part", draft.id), title: "Part one", columns: 1, items: [] });
    }
    const workspace = M.normalize({ version: 2, pieces, drafts, appliedShares: [...new Set([...(local.appliedShares || []), ...(remote.appliedShares || [])])], appliedProposals: [...new Set([...(local.appliedProposals || []), ...(remote.appliedProposals || [])])], activeId: drafts.some((d) => d.id === local.activeId) ? local.activeId : drafts.some((d) => d.id === remote.activeId) ? remote.activeId : drafts[0].id });
    return { workspace, conflicts, tombstones };
  }
  return { merge, equal, canonical };
});
