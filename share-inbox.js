/* Incoming shares stay on this device until the collection commit succeeds. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NookShares = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";
  const DB = "webweave-nook-shares";
  const MAX_FILE = 20 * 1024 * 1024, MAX_TOTAL = 80 * 1024 * 1024;
  const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  function fromForm(form, id, now = Date.now()) {
    const field = name => {
      const value = form.get(name);
      if (value != null && typeof value !== "string") throw new Error("The shared text could not be read. Try sharing it again.");
      if ((value || "").length > 1024 * 1024) throw new Error("Share a shorter passage, up to one million characters.");
      return (value || "").trim();
    };
    const title = field("title"), text = field("text"), url = field("url");
    let total = 0;
    // HTML forms include an unnamed empty File when no file was selected.
    const files = form.getAll("images").filter(file => !(typeof file !== "string" && !file.size && !file.name)).map(file => {
      if (typeof file === "string" || !file.size) throw new Error("An image arrived empty. Try sharing the original file again.");
      const extension = (file.name || "").split(".").pop().toLowerCase();
      const type = file.type || mime[extension];
      if (!Object.values(mime).includes(type)) throw new Error("Share PNG, JPEG, WebP or GIF images.");
      total += file.size;
      if (file.size > MAX_FILE || total > MAX_TOTAL) throw new Error("Share images up to 20 MB each, and 80 MB together.");
      return { name: file.name || "Shared image", blob: file.type ? file : new Blob([file], { type }) };
    });
    if (!title && !text && !url && !files.length) throw new Error("Nothing arrived from the sharing app. Try sharing text, a link or an image again.");
    return { id, createdAt: now, title, text, url, files };
  }
  function textPiece(share) {
    const content = share.text || (!share.files.length && !share.url ? share.title : "");
    const candidate = share.url || [share.text, share.title].find(value => /^https?:\/\/\S+$/i.test(value || "")) || "";
    let url = "";
    try { const parsed = new URL(candidate); if (["http:", "https:"].includes(parsed.protocol)) url = parsed.href; } catch {}
    if (!content && !url) return null;
    const quote = content === candidate ? "" : content;
    return { kind: quote ? "quote" : "link", quote, url, title: share.title || (quote ? quote.slice(0, 80) : url), workType: quote ? "quote" : "web page" };
  }
  function open(factory = indexedDB) {
    return new Promise((resolve, reject) => {
      const req = factory.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("inbox", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Close another Nook window, then try sharing again."));
    });
  }
  async function transaction(mode, action, factory) {
    const db = await open(factory);
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("inbox", mode);
        const req = action(tx.objectStore("inbox"));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("The shared piece could not be saved on this device."));
      });
    } finally { db.close(); }
  }
  return { fromForm, textPiece,
    put: (share, factory) => transaction("readwrite", store => store.put(share), factory),
    pending: factory => transaction("readonly", store => store.getAll(), factory),
    remove: (id, factory) => transaction("readwrite", store => store.delete(id), factory),
  };
});
