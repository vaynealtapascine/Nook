(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const uid = () =>
    crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const escapeHtml = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const escapeXml = escapeHtml;
  const clean = (s) => String(s ?? "").trim();
  const filename = (s) =>
    (clean(s) || "untitled-webweave")
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 80);
  const kindLabel = { image: "Image", quote: "Quote", link: "Link" };
  const M = NookModel;
  let workspace = M.empty(),
    project;
  let selectedId = null,
    activePartId,
    view = "gathering",
    citationFormat = "markdown",
    search = "", gatheringQuery = "", markingQuery = "";
  let libraryFilter = "all",
    librarySort = "newest",
    tagFilter = "",
    bulkIds = new Set(),
    groupCitations = false;
  let saveTimer,
    toastTimer,
    ocrWorker,
    ocrBusy = false,
    dirty = false,
    revision = 0,
    conflict = false;
  let changeNumber = 0,
    batchDepth = 0;
  let clientSync, localLoaded = false, serverSyncState = null;
  let openDraftIds = [], splitWeaves = false, projectDeskRestored = false;
  const partFocus = new Map();
  const captureQueue = [], captureStates = new Map();
  let captureProcessing = false;
  let installPrompt = null, receivingShares = false, collectionReady = false;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
  window.addEventListener('appinstalled', () => { installPrompt = null; toast('Nook is installed. You can share text, links and images to Gathering.'); });
  const captureSettings = (() => { try { return {transcribe:true, tag:true, location:'server', ...JSON.parse(localStorage.getItem("nook-capture-settings") || "{}")}; } catch { return {transcribe:true, tag:true, location:'server'}; } })();
  const captureProcessor = NookProcessing.create({
    fetch: (...args) => fetch(...args), online: () => navigator.onLine,
    getWorker: getOcrWorker,
    onMode: source => {
      const progress = $('#capture-progress');
      if (progress) progress.textContent = source === 'server' ? 'Processing on your Nook server…' : 'Processing on this device…';
    },
  });
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("nook-collection")
      : null;
  channel?.addEventListener("message", () => {
    if (clientSync?.busy && !dirty && !ocrBusy) {
      clientSync.pending = true;
      return;
    }
    if (!dirty && !ocrBusy && !clientSync?.busy) {
      history = [];
      future = [];
      loadLocal(true);
    } else {
      toast(
        "Another Nook tab changed the collection. Finish here and back up before reloading.",
      );
    }
  });
  let history = [],
    future = [],
    storedImages = new Map(),
    saveChain = Promise.resolve();
  function attachProject() {
    project =
      workspace.drafts.find((d) => d.id === workspace.activeId) ||
      workspace.drafts[0];
    workspace.activeId = project.id;
    openDraftIds = openDraftIds.filter(id => workspace.drafts.some(d => d.id === id));
    if (!openDraftIds.includes(project.id)) openDraftIds.push(project.id);
    Object.defineProperty(project, "pieces", {
      get: () => workspace.pieces,
      set: (v) => (workspace.pieces = v),
      configurable: true,
      enumerable: false,
    });
    if (!project.parts.some((p) => p.id === activePartId))
      activePartId = partFocus.get(project.id) || project.parts[0].id;
    if (!project.parts.some(p => p.id === activePartId)) activePartId = project.parts[0].id;
    partFocus.set(project.id, activePartId);
  }
  attachProject();
  function checkpoint() {
    if (batchDepth) return;
    const current = M.snapshot(workspace);
    const signature = (w) =>
      JSON.stringify({
        ...w,
        pieces: w.pieces.map(({ imageData, ...p }) => p),
      });
    if (!history.length || signature(history.at(-1)) !== signature(current))
      history.push(current);
    if (history.length > 30) history.shift();
    future = [];
  }
  function undo(redo = false) {
    const from = redo ? future : history,
      to = redo ? history : future;
    if (!from.length) return;
    to.push(M.snapshot(workspace));
    workspace = from.pop();
    attachProject();
    if (!piece(selectedId)) selectedId = null;
    scheduleSave();
    render();
    toast(redo ? "Change restored." : "Change undone.");
  }
  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open("webweave-nook", 2);
    request.onupgradeneeded = () => {
      for (const name of ["projects", "assets"])
        if (!request.result.objectStoreNames.contains(name))
          request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      toast("Close older Nook tabs, then reload to finish the update.");
  });
  const readStore = (db, name, key) =>
    new Promise((resolve, reject) => {
      const req = db.transaction(name).objectStore(name).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  function readLocalSnapshot(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["projects", "assets"], "readonly");
      const projects = tx.objectStore("projects"), assets = tx.objectStore("assets");
      const result = { saved: null, legacy: null, sync: null, images: new Map() };
      let failure;
      const workspaceRequest = projects.get("workspace");
      const legacyRequest = projects.get("current");
      const syncRequest = projects.get("server-sync");
      workspaceRequest.onsuccess = () => {
        try {
          if (!workspaceRequest.result) return;
          result.saved = structuredClone(workspaceRequest.result);
          for (const piece of result.saved.pieces) {
            if (!piece.assetId) continue;
            // Enqueue these reads while the transaction callback is active.
            // All assets and the sync baseline belong to the same generation.
            const request = assets.get(piece.assetId);
            request.onsuccess = () => {
              if (typeof request.result !== "string" || !request.result) {
                failure = new Error("A saved image could not be loaded. Keep your backup before reloading.");
                tx.abort();
                return;
              }
              piece.imageData = request.result;
              result.images.set(piece.id, request.result);
            };
          }
        } catch (error) { failure = error; tx.abort(); }
      };
      legacyRequest.onsuccess = () => { result.legacy = legacyRequest.result || null; };
      syncRequest.onsuccess = () => { result.sync = syncRequest.result || null; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(failure || tx.error);
      tx.onabort = () => reject(failure || tx.error || new Error("The local collection read was interrupted."));
    });
  }
  async function loadLocal(preserveFocus = false) {
    const readChangeNumber = changeNumber;
    try {
      const db = await dbPromise;
      const { saved, legacy, sync, images } = await readLocalSnapshot(db);
      // A paste or edit made while IndexedDB was loading belongs to this tab.
      if (dirty && changeNumber !== readChangeNumber) return false;
      if (saved) {
        const next = M.normalize(saved);
        workspace = next;
        revision = saved._revision || 0;
        storedImages = images;
        serverSyncState = sync;
        if (clientSync && !clientSync.busy) clientSync.state = serverSyncState || clientSync.state;
      } else if (legacy) workspace = M.normalize(legacy);
      if (saved) localLoaded = true;
      attachProject();
      if (!saved && legacy) scheduleSave();
      workspace.pieces.forEach(queueTranscription);
    } catch (e) {
      console.error(e);
      conflict = true;
      $("#save-state").textContent = "Storage needs attention";
      toast(
        "Could not load the collection. Export any open work before reloading.",
      );
    }
    if (preserveFocus) renderPreservingFocus();
    else render();
    readIncomingClip();
    syncAgentContext();
    if (!clientSync) initializeClientSync();
    collectionReady = !conflict;
    if (collectionReady) receiveShares();
    return !conflict;
  }
  function scheduleSave() {
    changeNumber++;
    dirty = true;
    project.updatedAt = Date.now();
    $("#save-state").textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 350);
  }
  function save(skipSync = false, strict = false) {
    clearTimeout(saveTimer);
    const snapshot = M.snapshot(workspace),
      saveNumber = changeNumber;
    const syncSnapshot = serverSyncState ? structuredClone(serverSyncState) : null;
    saveChain = saveChain
      .catch(() => {})
      .then(async () => {
        if (conflict)
          throw new Error(
            "Another tab changed this collection. Back up this tab, then reload.",
          );
        const db = await dbPromise;
        const changed = snapshot.pieces.filter(
          (p) => p.imageData && storedImages.get(p.id) !== p.imageData,
        );
        await new Promise((resolve, reject) => {
          const tx = db.transaction(["projects", "assets"], "readwrite");
          const store = tx.objectStore("projects");
          const req = store.get("workspace");
          req.onsuccess = () => {
            if ((req.result?._revision || 0) !== revision) {
              conflict = true;
              tx.abort();
              return;
            }
            const payload = {
              ...snapshot,
              _revision: revision + 1,
              pieces: snapshot.pieces.map((p) => ({
                ...p,
                imageData: "",
                assetId: p.imageData ? p.id : undefined,
              })),
            };
            changed.forEach((p) =>
              tx.objectStore("assets").put(p.imageData, p.id),
            );
            store.put(payload, "workspace");
            if (syncSnapshot) store.put(syncSnapshot, "server-sync");
          };
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () =>
            reject(
              new Error(
                conflict
                  ? "Another tab changed this collection. Back up this tab, then reload."
                  : "The collection could not be saved.",
              ),
            );
        });
        revision++;
        changed.forEach((p) => storedImages.set(p.id, p.imageData));
        dirty = saveNumber !== changeNumber;
        $("#save-state").textContent = dirty
          ? "Saving…"
          : "Saved on this device";
        channel?.postMessage({ revision });
        syncAgentContext();
        if (!skipSync) clientSync?.schedule();
        $("#undo").disabled = !history.length;
        $("#redo").disabled = !future.length;
      })
      .catch((e) => {
        console.error(e);
        $("#save-state").textContent = "Not saved — back up now";
        toast(e.message || "Storage is full. Back up your collection.");
        if (strict) throw e;
      });
    return saveChain;
  }
  window.addEventListener("pagehide", () => {
    if (dirty) save();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && dirty) save();
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  async function initializeClientSync() {
    if (!window.NookSyncClient) return;
    clientSync = new NookSyncClient({
      snapshot: () => M.snapshot(workspace),
      hasLocalWork: () => localLoaded || dirty || workspace.pieces.length > 0 || workspace.drafts.length > 1 || project.title !== "Untitled webweave" || project.parts.some(p => p.items.length),
      isDirty: () => dirty,
      readState: async () => readStore(await dbPromise, "projects", "server-sync"),
      beforeSync: async () => {
        await saveChain.catch(() => {});
        if (dirty) await save(true, true);
        const stored = await readStore(await dbPromise, "projects", "workspace");
        if (stored && stored._revision !== revision) {
          if (dirty || conflict) return false;
          history = []; future = [];
          if (!await loadLocal(true)) return false;
          if (serverSyncState) clientSync.state = serverSyncState;
        }
        return !conflict;
      },
      writeState: async state => {
        serverSyncState = state;
        const db = await dbPromise;
        await new Promise((resolve, reject) => {
          const tx = db.transaction("projects", "readwrite");
          tx.objectStore("projects").put(state, "server-sync");
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      },
      apply: async (incoming, state) => {
        const previousSyncState = serverSyncState;
        const activeId = workspace.activeId;
        const next = M.normalize(incoming);
        if (next.drafts.some(d => d.id === activeId)) next.activeId = activeId;
        const changed = JSON.stringify(next) !== JSON.stringify(workspace);
        serverSyncState = state;
        workspace = next;
        attachProject();
        workspace.pieces.forEach(queueTranscription);
        localLoaded = true;
        if (!piece(selectedId)) selectedId = null;
        // No artificial updatedAt change: receiving a server snapshot is not an edit.
        changeNumber++;
        dirty = true;
        if (changed) renderPreservingFocus();
        try { await save(true, true); }
        catch (e) { serverSyncState = previousSyncState; throw e; }
        if (conflict || dirty) {
          if (conflict) throw new Error("This tab could not save the synced copy. Back up and reload.");
          clientSync.pending = true;
        }
      },
      onStatus: status => {
        const el = $("#sync-status");
        if (el) {
          el.textContent = ({syncing: "Syncing…", synced: "Synced with Nook", pending: "Changes waiting", pair: "Connect this device", offline: "Working locally", error: "Sync needs attention"})[status.mode];
          el.dataset.state = status.mode;
        }
        $("#device-sync")?.classList.toggle("needs-pairing", status.mode === "pair");
        if ($("#sync-dialog")?.open) renderSyncDetails();
      },
    });
    try { await clientSync.start(); } catch (e) { console.error(e); }
  }
  function renderPreservingFocus() {
    const el = document.activeElement;
    const id = el?.id;
    const data = el?.dataset;
    const selector = id ? "#" + CSS.escape(id) : data?.gatherId ? `[data-gather-id="${data.gatherId}"][data-gather-field="${data.gatherField}"]` : data?.field ? `[data-field="${data.field}"]` : data?.partTitle ? `[data-part-title="${data.partTitle}"]` : data?.altId ? `[data-alt-id="${data.altId}"]` : null;
    const start = el?.selectionStart, end = el?.selectionEnd;
    render();
    const replacement = selector && $(selector);
    replacement?.focus({preventScroll: true});
    if (typeof start === "number" && replacement?.setSelectionRange) {
      try { replacement.setSelectionRange(start, end); } catch {}
    }
  }
  function openSyncDialog() {
    let dialog = $("#sync-dialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "sync-dialog";
      dialog.innerHTML = '<div class="inspector-top"><h2>Your devices, one Nook</h2><button class="icon-button" data-close-sync aria-label="Close devices and sync">×</button></div><p class="helper">This PC keeps the shared collection. Every paired browser keeps a full local copy so you can keep working independently.</p><div id="sync-details"></div><form id="pair-form"><label class="field"><span>Pairing key from the server device</span><input id="pair-secret" name="secret" type="password" required autocomplete="off" placeholder="Paste the pairing key"></label><button class="button primary">Connect this device</button><p id="pair-error" class="source-note" role="alert"></p></form><div class="dialog-actions"><button class="button quiet" data-sync-backup>Back up local copy</button><button class="button primary" data-sync-now>Sync now</button></div>';
      document.body.append(dialog);
      dialog.querySelector('[data-close-sync]').onclick = () => dialog.close();
      dialog.querySelector('[data-sync-backup]').onclick = saveProject;
      dialog.querySelector('[data-sync-now]').onclick = () => clientSync?.sync();
      dialog.querySelector('#pair-form').onsubmit = async e => {
        e.preventDefault();
        const button = e.target.querySelector("button");
        button.disabled = true;
        $("#pair-error").textContent = "";
        try { await clientSync.pair($("#pair-secret").value.trim()); $("#pair-secret").value = ""; }
        catch (err) { $("#pair-error").textContent = err.message; }
        finally { button.disabled = false; renderSyncDetails(); }
      };
    }
    renderSyncDetails();
    dialog.showModal();
  }
  function renderSyncDetails() {
    const el = $("#sync-details");
    if (!el || !clientSync) return;
    const state = clientSync.state;
    const paired = clientSync.mode === "pair" ? false : clientSync.server?.paired ?? !!state?.serverId;
    $("#pair-form").classList.toggle("hidden", !!paired);
    const conflicts = state?.conflicts || [];
    el.innerHTML = `<div class="sync-summary"><strong>${clientSync.mode === "offline" ? "Working locally" : paired ? "Connected to your server" : "Local copy ready"}</strong><p>${state?.lastSyncedAt ? "Last synced " + escapeHtml(new Date(state.lastSyncedAt).toLocaleString()) : "Your local changes will join the server collection when connected."}</p><p>${workspace.pieces.length} pieces · ${workspace.drafts.length} projects · Server revision ${state?.baseRevision || 0}</p>${clientSync.lastError ? `<p role="status">${escapeHtml(clientSync.mode === "offline" ? "The server is unavailable. Your edits stay on this device and will sync when it returns." : clientSync.lastError)}</p>` : ""}</div>${clientSync.server?.local ? '<div class="sync-info"><p>To pair another device, open <a href="https://nook.vayne.garden/" target="_blank" rel="noopener">nook.vayne.garden</a> on that device while connected to Tailscale. Copy the key from <code>.nook-data/pairing-key.txt</code> on this PC into Devices & sync there.</p></div>' : ""}${conflicts.length ? `<div class="sync-conflicts"><strong>${conflicts.length} conflicting ${conflicts.length === 1 ? "edit was" : "edits were"} preserved</strong><p>Both versions are kept as recovered pieces, parts, or projects. Review them in Nipping, Marking, or Weaving.</p><ul>${conflicts.map(c => `<li>${escapeHtml(c.title || c.type || "Recovered edit")} · ${escapeHtml(c.details || "Both copies kept")}</li>`).join("")}</ul><button class="button small" data-dismiss-conflicts>Reviewed</button></div>` : ""}`;
    el.querySelector('[data-dismiss-conflicts]')?.addEventListener("click", async () => {
      state.conflicts = [];
      serverSyncState = state;
      await save();
      renderSyncDetails();
    });
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }
  function piece(id) {
    return workspace.pieces.find((p) => p.id === id);
  }
  function part(id) {
    return workspace.drafts.flatMap(d => d.parts).find((p) => p.id === id);
  }
  function selected() {
    return piece(selectedId);
  }
  function safeUrl(url) {
    try {
      const u = new URL(url);
      return ["http:", "https:"].includes(u.protocol) ? u.href : "";
    } catch {
      return "";
    }
  }
  function safeImageData(value) {
    return /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(
      value || "",
    )
      ? value
      : "";
  }
  function plain(s) {
    return clean(s).replace(/\s+/g, " ");
  }
  function kindIcon(p) {
    return p.kind === "quote" ? "“" : p.kind === "link" ? "↗" : "▧";
  }
  function pieceTitle(p) {
    return (
      clean(p.title) ||
      clean(p.workTitle) ||
      (p.kind === "image"
        ? "Untitled image"
        : p.kind === "quote"
          ? "Untitled quote"
          : "Untitled link")
    );
  }
  function credit(p) {
    return (
      [p.creator, p.workTitle].filter(Boolean).join(" · ") || kindLabel[p.kind]
    );
  }
  function thumb(p) {
    const data = safeImageData(p.imageData);
    return data
      ? `<img class="piece-thumb" src="${data}" alt="">`
      : `<div class="piece-thumb" aria-hidden="true">${kindIcon(p)}</div>`;
  }
  function render() {
    const stage = ({research: "marking", alt: "marking", sources: "peeling", preview: "draft"})[view] || view;
    document.body.dataset.view = stage;
    document.body.dataset.workflow = stage;
    document.body.classList.toggle("has-selection", !!selected());
    document.body.classList.toggle("gathering-mode", view === "gathering");
    $("#project-title").value = project.title;
    $("#piece-count").textContent = project.pieces.length;
    document.querySelectorAll(".view-tab").forEach((b) => {
      const on = b.dataset.view === stage;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    [
      "gathering",
      "library",
      "research",
      "draft",
      "preview",
      "alt",
      "sources",
      "marking",
      "peeling",
    ].forEach((v) =>
      $("#" + v + "-view").classList.toggle("hidden", v !== view),
    );
    const headings = {
      gathering: [
        "Gathering",
        "Copy something that stays with you. Paste it here. Keep going.",
      ],
      library: [
        "Nipping",
        "Pick out the pieces that belong together. A few connections are enough.",
      ],
      research: ["Marking", "Trace the source. Find another thread."],
      preview: ["Read the weave", "See how your pieces speak to one another."],
      draft: [
        "Weaving",
        "A gentle first draft. Move things around until they click.",
      ],
      alt: [
        "Marking",
        "Read images locally, then add the visual details that matter.",
      ],
      sources: [
        "Peeling",
        "Credits, links, and a portable copy of your work.",
      ],
      marking: ["Marking", "Give your pieces their names, makers, sources, and a little context."],
      peeling: ["Peeling", "Take a whole weave, or just a part, into Affinity."],
    };
    $("#view-title").textContent = headings[view][0];
    $("#view-subtitle").textContent = headings[view][1];
    if ($("#workflow-step")) $("#workflow-step").textContent = ({gathering: "01 · Collect", library: "02 · Choose", draft: "03 · Compose", marking: "04 · Refine", peeling: "05 · Take with you"})[stage];
    renderLibrary();
    renderDraft();
    renderInspector();
    renderAlt();
    renderSources();
    renderDailyTools();
    renderPreview();
    renderGallery();
    renderGathering();
    renderResearch();
    renderMarking();
    renderPeeling();
    renderStageTools(stage);
  }
  function renderLibrary() {
    $("#library-filter").value = libraryFilter;
    $("#library-sort").value = librarySort;
    const used = new Set(
        workspace.drafts.flatMap((d) => d.parts.flatMap((p) => p.items)),
      ),
      inDraft = new Set(project.parts.flatMap((p) => p.items));
    const found = project.pieces
      .filter((p) => (libraryFilter === "trash" ? p.trashed : !p.trashed))
      .filter((p) => {
        if (
          (libraryFilter === "inbox" && used.has(p.id)) ||
          (libraryFilter === "draft" && !inDraft.has(p.id)) ||
          (libraryFilter === "favorites" && !p.favorite) ||
          (libraryFilter === "uncredited" && clean(p.creator))
        )
          return false;
        if (
          ["image", "quote", "link"].includes(libraryFilter) &&
          p.kind !== libraryFilter
        )
          return false;
        if (tagFilter && !(p.tags || []).includes(tagFilter)) return false;
        return [
          p.title,
          p.creator,
          p.contributors,
          p.workTitle,
          p.workType,
          p.quote,
          p.ocrText,
          p.url,
          p.notes,
          ...(p.tags || []),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search);
      })
      .sort((a, b) =>
        librarySort === "author"
          ? a.creator.localeCompare(b.creator)
          : librarySort === "title"
            ? pieceTitle(a).localeCompare(pieceTitle(b))
            : librarySort === "oldest"
              ? (a.createdAt || 0) - (b.createdAt || 0)
              : (b.createdAt || 0) - (a.createdAt || 0),
      );
    visiblePieces = found;
    $("#piece-count").textContent = project.pieces.filter(
      (p) => !p.trashed,
    ).length;
    $("#library-list").innerHTML = found.length
      ? found
          .map(
            (p) =>
              `<div class="library-entry"><input type="checkbox" data-bulk-id="${p.id}" aria-label="Select ${escapeHtml(pieceTitle(p))} for bulk editing" ${bulkIds.has(p.id) ? "checked" : ""}><button class="piece-card ${selectedId === p.id ? "selected" : ""}" data-select="${p.id}" data-drag-piece="${p.id}" title="Drag into a part · click to edit">${p.imageData ? thumb(p) : p.kind === "quote" ? `<span class="piece-passage">${escapeHtml(p.quote || "A passage waiting to be filled")}</span>` : thumb(p)}<span class="piece-main"><span class="piece-title">${p.favorite ? "☆ " : ""}${escapeHtml(pieceTitle(p))}</span><span class="piece-meta">${escapeHtml(credit(p))}</span>${p.tags?.length ? `<span class="piece-tags">${escapeHtml(p.tags.slice(0, 3).join(" · "))}</span>` : ""}</span><span class="piece-drag" aria-hidden="true">⠿</span></button></div>`,
          )
          .join("")
      : `<div class="empty-library">${project.pieces.length ? "No pieces match these filters." : "Your collection starts here.<br>Copy something you love, then press Ctrl+V."}</div>`;
    const allTags = [
      ...new Set(
        project.pieces.filter((p) => !p.trashed).flatMap((p) => p.tags || []),
      ),
    ].sort();
    $("#tag-filters").innerHTML =
      `${tagFilter ? `<button data-tag-filter="" class="tag-chip active">${escapeHtml(tagFilter)} ×</button>` : ""}${allTags
        .filter((t) => t !== tagFilter)
        .slice(0, 12)
        .map(
          (t) =>
            `<button class="tag-chip" data-tag-filter="${escapeHtml(t)}">${escapeHtml(t)}</button>`,
        )
        .join("")}`;
    $("#bulk-tools").innerHTML = bulkIds.size
      ? `<div class="bulk-tools"><strong>${bulkIds.size} selected</strong><button class="button small" data-action="bulk-credit">Credit / tag</button><button class="button small" data-action="bulk-place">Add to part</button><button class="icon-button" data-action="bulk-clear" aria-label="Clear selection">×</button></div>`
      : "";
    renderGallery();
  }

  function renderDraft() {
    if (!projectDeskRestored) {
      try {
        const prefs = JSON.parse(localStorage.getItem("nook-project-desk") || "{}");
        openDraftIds = (prefs.open || workspace.drafts.map(d => d.id)).filter(id => workspace.drafts.some(d => d.id === id));
        splitWeaves = !!prefs.split;
      } catch { openDraftIds = [project.id]; }
      if (!openDraftIds.includes(project.id)) openDraftIds.push(project.id);
      projectDeskRestored = true;
    }
    localStorage.setItem("nook-project-desk", JSON.stringify({open: openDraftIds, split: splitWeaves}));
    const active = project;
    const ids = splitWeaves ? openDraftIds : [project.id];
    $("#draft-view").innerHTML = `<div class="weave-worktabs"><span class="eyebrow">Open projects</span>${openDraftIds.map(id => { const d = workspace.drafts.find(d => d.id === id); return `<div class="weave-worktab ${id === project.id ? "active" : ""}"><button data-open-weave="${id}" aria-pressed="${id === project.id}">${escapeHtml(d.title)}</button>${openDraftIds.length > 1 ? `<button data-close-weave="${id}" aria-label="Close ${escapeHtml(d.title)}">×</button>` : ""}</div>`; }).join("")}<button class="button small" data-action="new-project">＋ New project</button><button id="weave-split" class="button small quiet" aria-pressed="${splitWeaves}" ${openDraftIds.length < 2 ? "disabled" : ""}>${splitWeaves ? "One at a time" : "Side by side"}</button><button class="button small quiet" data-view="preview">Preview</button></div><div class="weave-desks ${splitWeaves ? "split" : ""}">${ids.map(id => { project = workspace.drafts.find(d => d.id === id); return `<article class="weave-desk ${id === active.id ? "active" : ""}" data-weave-id="${id}" aria-label="Project ${escapeHtml(project.title)}"><div class="weave-desk-title"><h2>${escapeHtml(project.title)}</h2>${id === active.id ? '<span class="count-pill">Active</span>' : '<span class="source-note">Click to work here</span>'}</div>${draftMarkup()}</article>`; }).join("")}</div>`;
    project = active;
  }
  function draftMarkup() {
    return `<div class="draft-intro"><p>${project.parts.length} ${project.parts.length === 1 ? "part" : "parts"} · ${project.parts.reduce((n, p) => n + p.items.length, 0)} placed ${project.parts.reduce((n, p) => n + p.items.length, 0) === 1 ? "piece" : "pieces"}</p><button class="button small quiet" data-action="add-part">＋ New part</button></div><div class="parts">${project.parts
        .map(
          (p, pi) =>
            `<section class="part" data-part="${p.id}"><div class="part-head"><span class="part-index">${String(pi + 1).padStart(2, "0")}</span><input class="part-name" data-part-title="${p.id}" value="${escapeHtml(p.title)}" aria-label="Part ${pi + 1} name"><select class="part-columns" data-columns="${p.id}" aria-label="Layout for ${escapeHtml(p.title)}"><option value="1" ${(p.columns || 1) === 1 ? "selected" : ""}>Stacked</option><option value="2" ${p.columns === 2 ? "selected" : ""}>Pairs</option><option value="3" ${p.columns === 3 ? "selected" : ""}>Triptych</option></select><div class="part-actions"><button class="icon-button" data-action="export-part" data-part-id="${p.id}" title="Download this part for Affinity" aria-label="Export ${escapeHtml(p.title)} as SVG">↗</button><button class="icon-button" data-action="move-part-up" data-part-id="${p.id}" title="Move part up" aria-label="Move part up" ${pi === 0 ? "disabled" : ""}>↑</button><button class="icon-button" data-action="move-part-down" data-part-id="${p.id}" title="Move part down" aria-label="Move part down" ${pi === project.parts.length - 1 ? "disabled" : ""}>↓</button><button class="icon-button" data-action="remove-part" data-part-id="${p.id}" title="Remove part" aria-label="Remove part">×</button></div></div><div class="part-body" data-drop-part="${p.id}">${
              p.items.length
                ? p.items
                    .map((id, i) => {
                      const item = piece(id);
                      return item
                        ? `<div class="draft-card ${selectedId === id ? "selected" : ""}" tabindex="0" role="button" data-select="${id}" data-drag-item="${id}" data-from-part="${p.id}" data-index="${i}">${thumb(item)}<div class="draft-content"><span class="draft-kind">${kindLabel[item.kind]}</span><strong>${escapeHtml(pieceTitle(item))}</strong><p>${escapeHtml(item.kind === "quote" ? item.quote || credit(item) : credit(item))}</p></div><span class="piece-drag" aria-hidden="true">⠿</span><div class="move-actions">${project.parts.length > 1 ? `<select class="move-part-select" data-move-placement="${p.id}:${i}" aria-label="Move ${escapeHtml(pieceTitle(item))} to part">${project.parts.map((prt) => `<option value="${prt.id}" ${prt.id === p.id ? "selected" : ""}>${escapeHtml(prt.title)}</option>`).join("")}</select>` : ""}<button class="icon-button" data-action="move-up" data-part-id="${p.id}" data-index="${i}" title="Move up" aria-label="Move piece up" ${i === 0 ? "disabled" : ""}>↑</button><button class="icon-button" data-action="move-down" data-part-id="${p.id}" data-index="${i}" title="Move down" aria-label="Move piece down" ${i === p.items.length - 1 ? "disabled" : ""}>↓</button><button class="icon-button" data-action="unplace" data-part-id="${p.id}" data-index="${i}" title="Remove from part" aria-label="Remove from part">×</button></div></div>`
                        : "";
                    })
                    .join("")
                : `<div class="part-empty"><span aria-hidden="true">✳</span><div>Drag a piece here from your library<br>or select one and choose “Add to part”.</div></div>`
            }</div><div class="part-footer"><button class="button quiet small" data-action="activate-part" data-part-id="${p.id}">${activePartId === p.id ? "✓ Active part" : "＋ Add to this part"}</button></div></section>`,
        )
        .join(
          "",
        )}<button class="add-part" data-action="add-part">＋ Add another part</button></div>`;
  }
  function renderInspector() {
    const p = selected();
    if (!p) {
      $("#inspector-content").innerHTML =
        `<div class="inspector-empty"><div class="flower">✳</div><h2>A place for details</h2><p>Pick a piece to add its title, maker, source link, and notes. Those details become your citations.</p></div>`;
      return;
    }
    $("#inspector-content").innerHTML =
      `<div class="inspector-top"><div><p class="eyebrow">Piece context</p><h2>Piece details</h2></div><button class="icon-button" data-action="deselect" title="Close details">×</button></div>${safeImageData(p.imageData) ? `<img class="inspector-preview" src="${safeImageData(p.imageData)}" alt="">` : `<div class="inspector-preview text-preview">${kindIcon(p)}</div>`}<label class="field"><span>Name in your library</span><input data-field="title" value="${escapeHtml(p.title)}" placeholder="Give this piece a name"></label>${p.kind === "quote" ? `<label class="field"><span>Quote or passage</span><textarea data-field="quote" placeholder="Paste the words here">${escapeHtml(p.quote)}</textarea></label>` : ""}<div class="field-grid"><label class="field"><span>Author / artist</span><input list="known-authors" data-field="creator" value="${escapeHtml(p.creator)}" placeholder="Name"></label><label class="field"><span>Year</span><input data-field="year" value="${escapeHtml(p.year)}" placeholder="Optional"></label></div><label class="field"><span>Author’s link</span><input data-field="creatorUrl" type="url" value="${escapeHtml(p.creatorUrl)}" placeholder="Website or profile"></label><label class="field"><span>More creators · one per line</span><textarea data-field="contributors" placeholder="Name | https://profile…">${escapeHtml(p.contributors)}</textarea></label><label class="field"><span>Tags</span><input data-field="tags" value="${escapeHtml((p.tags || []).join(", "))}" placeholder="home, longing, tenderness"></label><label class="field"><span>Citation annotation</span><input data-field="annotation" value="${escapeHtml(p.annotation)}" placeholder="translated by…, detail, page 12…"></label><label class="field"><span>Work title</span><input data-field="workTitle" value="${escapeHtml(p.workTitle)}" placeholder="Book, poem, artwork…"></label><label class="field"><span>Work type</span><input data-field="workType" value="${escapeHtml(p.workType)}" placeholder="Poem, photograph, film…"></label><label class="field"><span>Source link</span><input data-field="url" type="url" value="${escapeHtml(p.url)}" placeholder="https://…"></label><label class="field"><span>Private notes</span><textarea data-field="notes" placeholder="Why you saved it, context, a page number…">${escapeHtml(p.notes)}</textarea></label>${p.kind === "image" ? `<div class="inspector-section"><h3>Alt text</h3><p>Read words in the image offline, then describe what you see.</p><label class="field"><span>Visual notes</span><textarea data-field="visualNotes" placeholder="People, objects, setting, mood, layout…">${escapeHtml(p.visualNotes)}</textarea></label><label class="field"><span>Alt text</span><textarea data-field="altText" placeholder="A description for readers who cannot see the image">${escapeHtml(p.altText)}</textarea></label><div class="inspector-actions"><button class="button small" data-action="generate-alt" data-piece-id="${p.id}">✳ Read image & draft alt text</button></div>${p.ocrText ? `<p class="source-note">Words found: ${escapeHtml(p.ocrText.slice(0, 180))}${p.ocrText.length > 180 ? "…" : ""}</p>` : ""}</div>` : ""}<div class="inspector-section"><div class="inspector-actions"><button class="button small primary" data-action="add-selected" data-piece-id="${p.id}">＋ Add to ${escapeHtml(part(activePartId)?.title || "part")}</button><button class="button small quiet" data-action="duplicate-piece" data-piece-id="${p.id}">Duplicate</button></div><button class="button small quiet" data-action="favorite" data-piece-id="${p.id}">${p.favorite ? "★ Favorited" : "☆ Favorite"}</button><button class="button small quiet" data-action="restore-piece" data-piece-id="${p.id}" ${p.trashed ? "" : "hidden"}>Restore from trash</button><p class="source-note">Shared across ${workspace.drafts.filter((d) => d.parts.some((prt) => prt.items.includes(p.id))).length} drafts. Credit edits update everywhere.</p><button class="link-action" data-action="delete-piece" data-piece-id="${p.id}">Move to trash</button></div>`;
  }
  function imagesInOrder(scopePart) {
    const ids = (scopePart ? [scopePart] : project.parts).flatMap(
      (p) => p.items,
    );
    return ids
      .map(piece)
      .filter((p) => p?.kind === "image")
      .filter((p, i, a) => a.findIndex((q) => q.id === p.id) === i);
  }
  function renderAlt() {
    const images = workspace.pieces.filter(p => p.kind === "image" && !p.trashed);
    const missing = images.filter(p => !clean(p.altText));
    $("#alt-view").innerHTML = `<section class="section-card"><h2>Image descriptions</h2><p>All collected images appear here, including pieces you have not placed yet. Transcription reads visible words; add the visual details you see.</p><div class="alt-actions"><button class="button primary" data-action="generate-all-alt" ${!missing.length || ocrBusy ? "disabled" : ""}>${ocrBusy ? "Reading images…" : "Draft missing descriptions"}</button><button class="button quiet" data-action="copy-all-alt" ${!imagesInOrder().length ? "disabled" : ""}>Copy active project descriptions</button><button class="button quiet" data-action="download-alt" ${!imagesInOrder().length ? "disabled" : ""}>Download active project .txt</button></div></section><div class="alt-list">${images.map(p => `<div class="alt-item"><img src="${safeImageData(p.imageData)}" alt=""><div><strong>${escapeHtml(pieceTitle(p))}</strong><br><small>${escapeHtml(credit(p))}</small><textarea data-alt-id="${p.id}" aria-label="Alt text for ${escapeHtml(pieceTitle(p))}" placeholder="Describe the image here…">${escapeHtml(p.altText)}</textarea>${p.ocrText ? `<p class="source-note">Words found: ${escapeHtml(p.ocrText)}</p>` : ""}<button class="button small" data-action="generate-alt" data-piece-id="${p.id}" ${ocrBusy ? "disabled" : ""}>Read image & draft</button></div></div>`).join("") || '<div class="first-step"><h3>Gather an image to begin.</h3><button class="button" data-view="gathering">Go gathering →</button></div>'}</div>`;
  }
  function sourcePieces() {
    const seen = new Set();
    return project.parts
      .flatMap((prt) => prt.items.map(piece).filter(Boolean))
      .filter((p) => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });
  }
  function citationParts(p) {
    return {
      creator: plain(p.creator) || "Unknown creator",
      title: plain(p.workTitle) || plain(p.title) || "Untitled",
      type: plain(p.workType) || kindLabel[p.kind].toLowerCase(),
      year: plain(p.year),
      url: safeUrl(p.url),
    };
  }
  function citationLines(format = "plain") {
    return groupCitations
      ? project.parts
          .filter((prt) => prt.items.length)
          .map(
            (prt, i) =>
              `${i + 1}. ${format === "markdown" ? md(prt.title) : prt.title}: ${prt.items
                .map(piece)
                .filter(Boolean)
                .map((p) => creditMarkup(p, format))
                .join(" + ")}`,
          )
      : sourcePieces().map((p, i) => `${i + 1}. ${creditMarkup(p, format)}`);
  }
  function citationHtml() {
    return `<div>${
      groupCitations
        ? project.parts
            .filter((prt) => prt.items.length)
            .map(
              (prt, i) =>
                `<p>${i + 1}. ${escapeHtml(prt.title)}: ${prt.items
                  .map(piece)
                  .filter(Boolean)
                  .map((p) => creditMarkup(p, "rich"))
                  .join(" + ")}</p>`,
            )
            .join("")
        : sourcePieces()
            .map((p, i) => `<p>${i + 1}. ${creditMarkup(p, "rich")}</p>`)
            .join("")
    }</div>`;
  }

  function renderSources() {
    const count = sourcePieces().length;
    const output =
      citationLines(citationFormat === "markdown" ? "markdown" : "plain").join(
        "\n",
      ) ||
      "Place some pieces in your draft and their sources will appear here.";
    $("#sources-view").innerHTML =
      `<section class="section-card"><h2>A little credit goes a long way</h2><p>${count} ${count === 1 ? "source" : "sources"} in draft order. Add author, work title, type, year, and links in each piece’s detail panel.</p><label class="checkbox-label"><input id="group-citations" type="checkbox" ${groupCitations ? "checked" : ""}> Group credits by part, joined with +</label><div class="format-switch"><button data-format="rich" class="${citationFormat === "rich" ? "active" : ""}">Rich text</button><button data-format="markdown" class="${citationFormat === "markdown" ? "active" : ""}">Markdown</button><button data-format="plain" class="${citationFormat === "plain" ? "active" : ""}">Plain text</button></div><div class="source-actions"><button class="button primary" data-action="copy-citations" ${!count ? "disabled" : ""}>Copy citations</button><button class="button quiet" data-action="download-citations" ${!count ? "disabled" : ""}>Download ${citationFormat === "rich" ? ".html" : citationFormat === "markdown" ? ".md" : ".txt"}</button></div><div class="citation-output">${citationFormat === "rich" && count ? citationHtml() : escapeHtml(output)}</div><p class="source-note">${sourcePieces().filter((p) => !clean(p.creator)).length} missing creator · ${sourcePieces().filter((p) => !safeUrl(p.url)).length} missing source link. Select a piece to complete its credits.</p></section>`;
  }
  const sentence = (s) =>
    /[.!?…]$/.test(clean(s)) ? clean(s) : `${clean(s)}.`;
  function altForPiece(p) {
    return p.kind === "image"
      ? clean(p.altText) || `Image: ${pieceTitle(p)}. Alt text needed.`
      : p.kind === "quote"
        ? `Text: ${sentence(plain(p.quote) || pieceTitle(p))}`
        : `Link: ${sentence(pieceTitle(p))}`;
  }
  function partAlt(prt) {
    return prt.items.map(piece).filter(Boolean).map(altForPiece).join(" ");
  }
  function allAlt() {
    return project.parts
      .map(
        (p, i) =>
          `Part ${i + 1} — ${p.title}\n${p.items
            .map(piece)
            .filter(Boolean)
            .map((item, j) => `${j + 1}. ${altForPiece(item)}`)
            .join("\n")}`,
      )
      .join("\n\n");
  }
  function addPiece(kind, overrides = {}) {
    checkpoint();
    const p = {
      id: uid(),
      kind,
      title: "",
      creator: "",
      workTitle: "",
      workType: "",
      year: "",
      url: "",
      notes: "",
      quote: "",
      visualNotes: "",
      ocrText: "",
      transcriptionStatus: "",
      taggingStatus: "",
      processingSource: "",
      altText: "",
      imageData: "",
      width: 0,
      height: 0,
      tags: [],
      creatorUrl: "",
      contributors: "",
      annotation: "",
      favorite: false,
      trashed: false,
      createdAt: Date.now(),
      research: [],
      ...overrides,
    };
    project.pieces.unshift(p);
    if (captureSettings.tag && captureSettings.location === 'device') {
      p.tags = M.tags([...(p.tags || []), ...NookCapture.suggestTags(p)]);
      p.taggingStatus = 'done'; p.processingSource = 'device';
    }
    selectedId = view === "gathering" ? null : p.id;
    queueTranscription(p);
    if (!batchDepth) {
      scheduleSave();
      render();
      if (view === "gathering")
        $("#gather-paste")?.focus();
    }
    return p;
  }
  async function importImages(files) {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    let added = 0;
    for (const file of images) {
      try {
        const { data, width, height } = await imageToData(file);
        addPiece("image", {
          title: file.name.replace(/\.[^.]+$/, ""),
          workType: "image",
          imageData: data,
          width,
          height,
        });
        added++;
      } catch (e) {
        console.error(e);
        toast(`Could not open ${file.name}`);
      }
    }
    if (added)
      toast(
        `${added} ${added === 1 ? "image" : "images"} added to your library.`,
      );
  }
  function imageToData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Invalid image"));
        img.onload = () => {
          let w = img.naturalWidth,
            h = img.naturalHeight;
          const max = 4000;
          if (Math.max(w, h) <= max && safeImageData(reader.result)) {
            resolve({ data: reader.result, width: w, height: h });
            return;
          }
          if (Math.max(w, h) > max) {
            const scale = max / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve({ data: canvas.toDataURL("image/png"), width: w, height: h });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function addToPart(id, partId = activePartId, index) {
    checkpoint();
    const prt = part(partId);
    if (!prt || !piece(id)) return;
    activateWeave(workspace.drafts.find(d => d.parts.some(p => p.id === partId)).id, false);
    if (index == null) prt.items.push(id);
    else prt.items.splice(index, 0, id);
    activePartId = prt.id;
    partFocus.set(project.id, activePartId);
    scheduleSave();
    render();
    toast(`Added to ${prt.title}.`);
  }
  function movePlaced(fromPart, fromIndex, toPart, toIndex) {
    checkpoint();
    const from = part(fromPart),
      to = part(toPart);
    if (!from || !to) return;
    const [id] = from.items.splice(fromIndex, 1);
    if (!id) return;
    if (from === to && fromIndex < toIndex) toIndex--;
    to.items.splice(Math.max(0, toIndex), 0, id);
    activateWeave(workspace.drafts.find(d => d.parts.some(p => p.id === toPart)).id, false);
    activePartId = to.id;
    partFocus.set(project.id, activePartId);
    scheduleSave();
    render();
  }
  function removePlaced(partId, index) {
    checkpoint();
    const prt = part(partId);
    if (!prt) return;
    prt.items.splice(index, 1);
    scheduleSave();
    render();
  }
  function swap(arr, a, b) {
    checkpoint();
    [arr[a], arr[b]] = [arr[b], arr[a]];
    scheduleSave();
    render();
  }
  async function confirmAction(title, message, confirmLabel = "Remove") {
    const d = $("#confirm-dialog");
    $("#dialog-title").textContent = title;
    $("#dialog-message").textContent = message;
    d.querySelector('[value="confirm"]').textContent = confirmLabel;
    d.returnValue = "cancel";
    d.showModal();
    return new Promise((resolve) => {
      d.addEventListener("close", () => resolve(d.returnValue === "confirm"), {
        once: true,
      });
    });
  }
  async function runAction(action, btn) {
    const id = btn.dataset.pieceId,
      partId = btn.dataset.partId,
      index = Number(btn.dataset.index);
    switch (action) {
      case "capture":
        openCapture();
        break;
      case "capture-help":
        $("#help-dialog").showModal();
        break;
      case "close-help":
        $("#help-dialog").close();
        break;
      case "close-capture":
        $("#capture-dialog").close();
        break;
      case "duplicate-draft":
        checkpoint();
        {
          const d = {
            ...project,
            id: uid(),
            title: project.title + " — copy",
            parts: project.parts.map((p) => ({
              ...p,
              id: uid(),
              items: [...p.items],
            })),
          };
          workspace.drafts.push(d);
          workspace.activeId = d.id;
          attachProject();
          scheduleSave();
          render();
        }
        break;
      case "delete-draft":
        if (workspace.drafts.length === 1) {
          toast("Keep one draft, or create a new one first.");
          break;
        }
        if (
          await confirmAction(
            "Delete this draft?",
            "The collection stays available. You can undo this change.",
            "Delete draft",
          )
        ) {
          checkpoint();
          workspace.drafts = workspace.drafts.filter(
            (d) => d.id !== project.id,
          );
          workspace.activeId = workspace.drafts[0].id;
          attachProject();
          scheduleSave();
          render();
        }
        break;
      case "favorite":
        checkpoint();
        piece(id).favorite = !piece(id).favorite;
        scheduleSave();
        render();
        break;
      case "restore-piece":
        checkpoint();
        piece(id).trashed = false;
        scheduleSave();
        render();
        break;
      case "bulk-clear":
        bulkIds.clear();
        renderLibrary();
        break;
      case "bulk-place":
        checkpoint();
        part(activePartId).items.push(
          ...[...bulkIds].filter((id) => piece(id) && !piece(id).trashed),
        );
        scheduleSave();
        render();
        toast("Selected pieces added to the active part.");
        break;
      case "bulk-credit":
        openBulk();
        break;
      case "save-draft":
        download(
          filename(project.title) + ".webweave.json",
          JSON.stringify(
            {
              ...project,
              pieces: project.pieces.filter((p) =>
                project.parts.some((prt) => prt.items.includes(p.id)),
              ),
            },
            null,
            2,
          ),
          "application/json",
        );
        break;
      case "print-preview":
        view = "preview";
        render();
        window.print();
        break;
      case "add-part": {
        checkpoint();
        const prt = {
          id: uid(),
          title: `Part ${project.parts.length + 1}`,
          items: [],
        };
        project.parts.push(prt);
        activePartId = prt.id;
        scheduleSave();
        render();
        document.querySelector(`[data-part-title="${prt.id}"]`)?.focus();
        break;
      }
      case "activate-part":
        activePartId = partId;
        render();
        toast(`${part(partId).title} is ready for pieces.`);
        break;
      case "move-part-up": {
        const i = project.parts.findIndex((p) => p.id === partId);
        if (i > 0) swap(project.parts, i, i - 1);
        break;
      }
      case "move-part-down": {
        const i = project.parts.findIndex((p) => p.id === partId);
        if (i < project.parts.length - 1) swap(project.parts, i, i + 1);
        break;
      }
      case "remove-part": {
        const prt = part(partId);
        if (!prt) return;
        if (project.parts.length === 1) {
          toast("Keep at least one part in your weave.");
          return;
        }
        if (
          !(await confirmAction(
            "Remove this part?",
            `“${prt.title}” and its placements will be removed. The pieces stay in your library.`,
          ))
        )
          return;
        checkpoint();
        project.parts = project.parts.filter((p) => p.id !== partId);
        activePartId = project.parts[0].id;
        scheduleSave();
        render();
        break;
      }
      case "move-up": {
        const prt = part(partId);
        if (index > 0) swap(prt.items, index, index - 1);
        break;
      }
      case "move-down": {
        const prt = part(partId);
        if (index < prt.items.length - 1) swap(prt.items, index, index + 1);
        break;
      }
      case "unplace":
        removePlaced(partId, index);
        break;
      case "deselect":
        selectedId = null;
        render();
        break;
      case "add-selected":
        addToPart(id);
        break;
      case "duplicate-piece": {
        const source = piece(id);
        if (source)
          addPiece(source.kind, {
            ...source,
            id: uid(),
            title: `${pieceTitle(source)} copy`,
          });
        break;
      }
      case "delete-piece": {
        const target = piece(id);
        if (!target) return;
        checkpoint();
        target.trashed = true;
        selectedId = null;
        scheduleSave();
        render();
        toast("Moved to trash. Existing draft placements are kept.");
        break;
      }

      case "generate-alt":
        await generateAlt(piece(id));
        break;
      case "generate-all-alt":
        await generateAllAlt();
        break;
      case "copy-all-alt":
        await copyText(allAlt(), "Alt text copied.");
        break;
      case "copy-part-alt":
        await copyText(
          `${part(partId).title}\n${partAlt(part(partId))}`,
          "Part alt text copied.",
        );
        break;
      case "download-alt":
        download(
          `${filename(project.title)}-alt-text.txt`,
          allAlt(),
          "text/plain",
        );
        break;
      case "copy-citations":
        await copyCitations();
        break;
      case "download-citations":
        downloadCitations();
        break;
      case "export-svg":
        exportSvg(project.parts);
        break;
      case "export-part":
        exportSvg([part(partId)]);
        break;
      case "save-project":
        saveProject();
        break;
      case "open-project":
        $("#project-input").click();
        break;
      case "new-project": {
        checkpoint();
        const d = M.makeDraft();
        workspace.drafts.push(d);
        workspace.activeId = d.id;
        attachProject();
        selectedId = null;
        view = "draft";
        scheduleSave();
        render();
        $("#project-title").focus();
        $("#project-title").select();
        break;
      }
    }
  }

  function orientation(p) {
    if (!p.width || !p.height) return "";
    const ratio = p.width / p.height;
    return ratio > 1.25 ? "landscape" : ratio < 0.8 ? "portrait" : "square";
  }
  function draftAlt(p) {
    const bits = [];
    const note = plain(p.visualNotes);
    if (note) bits.push(note.replace(/[.!?]$/, "") + ".");
    else
      bits.push(
        `${orientation(p) ? orientation(p) + " " : ""}image${p.title ? ` titled “${plain(p.title)}”` : ""}.`,
      );
    const ocr = plain(p.ocrText);
    if (ocr) bits.push(`Visible text: “${ocr}”`);
    return bits.join(" ");
  }
  async function getOcrWorker() {
    if (ocrWorker) return ocrWorker;
    if (!window.Tesseract) throw new Error("Image reader is missing");
    // Check and warm the language file before starting a browser worker. A cold
    // offline device must retain its capture instead of waiting on initialization.
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(new URL('vendor/lang/eng.traineddata.gz', location.href), {signal:controller.signal});
      if (!response.ok) throw new Error('Reader unavailable');
      await response.arrayBuffer();
    } catch {
      throw new Error('Offline transcription is not ready. Connect and read an image using This device once.');
    } finally { clearTimeout(timer); }
    ocrWorker = await Tesseract.createWorker("eng", 1, {
      workerPath: new URL("vendor/worker.min.js", location.href).href,
      langPath: new URL("vendor/lang/", location.href).href,
      corePath: new URL("vendor/core/", location.href).href,
      errorHandler: () => {},
      logger: (m) => {
        if (m.status === "recognizing text")
          ($("#capture-progress") || $("#save-state")).textContent =
            `Reading image… ${Math.round((m.progress || 0) * 100)}%`;
      },
    });
    return ocrWorker;
  }
  async function generateAlt(p, quiet = false) {
    if (!p?.imageData) return false;
    if (ocrBusy && !quiet) return;
    try {
      if (!quiet) {
        ocrBusy = true;
        renderAlt();
      }
      const input = {...p}, settings = {transcribe:true, tag:captureSettings.tag, location:captureSettings.location};
      const result = await captureProcessor.process(input, settings);
      const current = piece(p.id);
      if (current !== p || p.trashed || p.imageData !== input.imageData || processingText(p) !== processingText(input)) return false;
      checkpoint();
      p.ocrText = clean(result.ocrText);
      p.transcriptionStatus = "done";
      p.processingSource = result.source;
      if (settings.tag && captureSettings.tag) { p.tags = M.tags([...p.tags, ...result.tags]); p.taggingStatus = 'done'; }
      p.altText = draftAlt(p);
      scheduleSave();
      if (!quiet)
        toast(
          p.ocrText
            ? "Alt text drafted with words found in the image."
            : "Alt text starter ready. Add the visual details you see.",
        );
      return true;
    } catch (e) {
      console.error(e);
      if (!quiet)
        toast("Image reading failed. You can still write alt text by hand.");
      return false;
    } finally {
      if (!quiet) {
        ocrBusy = false;
        render();
      }
    }
  }
  async function generateAllAlt() {
    if (ocrBusy) return;
    const images = workspace.pieces.filter(p => p.kind === "image" && !p.trashed && !clean(p.altText));
    ocrBusy = true;
    renderAlt();
    let done = 0;
    for (const p of images) {
      $("#save-state").textContent = `Reading ${done + 1} of ${images.length}…`;
      if (await generateAlt(p, true)) done++;
    }
    ocrBusy = false;
    scheduleSave();
    render();
    toast(
      `Drafted alt text for ${done} ${done === 1 ? "image" : "images"}. Please review each one.`,
    );
  }
  async function copyText(value, message) {
    try {
      await navigator.clipboard.writeText(value);
      toast(message);
    } catch {
      const el = document.createElement("textarea");
      el.value = value;
      document.body.append(el);
      el.select();
      document.execCommand("copy");
      el.remove();
      toast(message);
    }
  }
  async function copyCitations() {
    const plainText = citationLines(
      citationFormat === "markdown" ? "markdown" : "plain",
    ).join("\n");
    if (
      citationFormat === "rich" &&
      window.ClipboardItem &&
      navigator.clipboard.write
    ) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([citationHtml()], { type: "text/html" }),
            "text/plain": new Blob([plainText], { type: "text/plain" }),
          }),
        ]);
        toast("Rich text citations copied.");
        return;
      } catch (e) {
        console.warn(e);
      }
    }
    await copyText(plainText, "Citations copied.");
  }
  function download(name, content, type) {
    const blob =
      content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function downloadCitations() {
    const ext =
      citationFormat === "rich"
        ? "html"
        : citationFormat === "markdown"
          ? "md"
          : "txt";
    const content =
      citationFormat === "rich"
        ? `<!doctype html><html><meta charset="utf-8"><title>Sources for ${escapeHtml(project.title)}</title><body><h1>Sources for ${escapeHtml(project.title)}</h1>${citationHtml()}</body></html>`
        : citationLines(
            citationFormat === "markdown" ? "markdown" : "plain",
          ).join("\n");
    download(
      `${filename(project.title)}-sources.${ext}`,
      content,
      citationFormat === "rich" ? "text/html" : "text/plain",
    );
    toast("Citations downloaded.");
  }
  function saveProject() {
    download(
      `nook-collection-${new Date().toISOString().slice(0, 10)}.webweave.json`,
      JSON.stringify(workspace, null, 2),
      "application/json",
    );
    toast("Backup requested: every draft and piece is included.");
  }
  async function openProject(file) {
    try {
      const incoming = M.normalize(JSON.parse(await file.text()));
      checkpoint();
      workspace = M.merge(workspace, incoming);
      attachProject();
      selectedId = null;
      view = "draft";
      scheduleSave();
      render();
      toast(
        `Imported ${incoming.drafts.length} draft(s). Your existing collection is kept.`,
      );
    } catch (e) {
      toast(e.message || "Could not read this backup.");
    }
  }

  function wrapSvgText(text, width, font = "24px Georgia") {
    const canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d");
    ctx.font = font;
    const lines = [];
    for (const paragraph of String(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        if (ctx.measureText((line + " " + word).trim()).width > width && line) {
          lines.push(line);
          line = "";
        }
        if (ctx.measureText(word).width > width) {
          for (const ch of word) {
            if (ctx.measureText(line + ch).width > width) {
              lines.push(line);
              line = "";
            }
            line += ch;
          }
        } else line = (line + " " + word).trim();
      }
      lines.push(line);
    }
    return lines;
  }
  function svgText(lines, x, y, size = 22, color = "#39372f", lineHeight = 30) {
    return lines
      .map(
        (line, i) =>
          `<text x="${x}" y="${y + i * lineHeight}" font-family="Georgia,serif" font-size="${size}" fill="${color}">${escapeXml(line)}</text>`,
      )
      .join("");
  }
  function svgForParts(parts) {
    const W = 800,
      pad = 50,
      inner = 700,
      gap = 20;
    let y = 65;
    const out = [];
    const title = wrapSvgText(project.title, inner, "29px Georgia");
    out.push(svgText(title, pad, y, 29));
    y += title.length * 35 + 25;
    for (const prt of parts) {
      const heading = wrapSvgText(prt.title, inner, "21px Georgia");
      out.push(svgText(heading, pad, y, 21, "#59684b", 28));
      y += heading.length * 28 + 20;
      const columns = prt.columns || 1,
        width = (inner - gap * (columns - 1)) / columns;
      const items = prt.items.map(piece).filter(Boolean);
      for (let start = 0; start < items.length; start += columns) {
        let rowHeight = 0;
        for (let col = 0; col < columns && start + col < items.length; col++) {
          const p = items[start + col],
            x = pad + col * (width + gap);
          let h = 0;
          const content = [];
          if (p.kind === "image" && safeImageData(p.imageData)) {
            const ratio = p.width > 0 && p.height > 0 ? p.width / p.height : 1;
            const imageHeight = Math.min(1000, width / ratio),
              imageWidth = Math.min(width, imageHeight * ratio);
            content.push(
              `<image x="${x + (width - imageWidth) / 2}" y="${y}" width="${imageWidth}" height="${imageHeight}" xlink:href="${safeImageData(p.imageData)}"/>`,
            );
            h = imageHeight + 16;
          } else {
            const lines = wrapSvgText(
              p.kind === "quote" ? p.quote : pieceTitle(p),
              width - 24,
              "24px Georgia",
            );
            content.push(svgText(lines, x + 12, y + 28, 24, "#39372f", 32));
            h = lines.length * 32 + 28;
          }
          const caption = wrapSvgText(
            [p.workTitle, ...creators(p).map((a) => a.name), p.annotation]
              .filter(Boolean)
              .join(" · "),
            width,
            "12px Georgia",
          );
          content.push(svgText(caption, x, y + h + 12, 12, "#777268", 18));
          h += caption.length * 18 + 24;
          out.push(
            `<g><title>${escapeXml(pieceTitle(p))}</title><desc>${escapeXml(p.altText || p.quote || "")}</desc>${content.join("")}</g>`,
          );
          rowHeight = Math.max(rowHeight, h);
        }
        y += rowHeight + gap;
      }
      y += 25;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="${Math.max(y + 25, 350)}" viewBox="0 0 800 ${Math.max(y + 25, 350)}"><title>${escapeXml(project.title)}</title><rect width="100%" height="100%" fill="#f7f3ec"/>${out.join("")}</svg>`;
  }

  function exportSvg(parts) {
    if (!parts?.length) return;
    const suffix =
      parts.length === 1 && project.parts.length > 1
        ? `-${filename(parts[0].title)}`
        : "";
    download(
      `${filename(project.title)}${suffix}-affinity.svg`,
      svgForParts(parts),
      "image/svg+xml",
    );
    toast("SVG draft downloaded. Open it in Affinity.");
  }
  let suppressClickUntil = 0;
  document.addEventListener("click", (e) => {
    if (Date.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const action = e.target.closest("[data-action]");
    if (action) {
      e.stopPropagation();
      runAction(action.dataset.action, action);
      return;
    }
    const card = e.target.closest("[data-select]");
    if (card) {
      selectedId = card.dataset.select;
      const prt = card.closest("[data-part]");
      if (prt) activePartId = prt.dataset.part;
      render();
    }
  });
  document.addEventListener("dblclick", (e) => {
    const card = e.target.closest("[data-drag-piece]");
    if (card) addToPart(card.dataset.dragPiece);
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "project-title") {
      project.title = e.target.value;
      const opt = $("#draft-picker").selectedOptions[0];
      if (opt) opt.textContent = project.title || "Untitled webweave";
      document.querySelector(`[data-open-weave="${project.id}"]`)?.replaceChildren(document.createTextNode(project.title || "Untitled webweave"));
      const desk = document.querySelector(`[data-weave-id="${project.id}"]`);
      if (desk) { desk.querySelector("h2").textContent = project.title || "Untitled webweave"; desk.setAttribute("aria-label", "Project " + (project.title || "Untitled webweave")); }
      scheduleSave();
      return;
    }
    if (e.target.id === "piece-search") {
      search = e.target.value.toLowerCase();
      renderLibrary();
      return;
    }
    if (e.target.matches("[data-part-title]")) {
      const p = part(e.target.dataset.partTitle);
      if (p) {
        p.title = e.target.value;
        scheduleSave();
      }
      return;
    }
    if (e.target.matches("[data-field]")) {
      const p = selected();
      if (p) {
        p[e.target.dataset.field] =
          e.target.dataset.field === "tags"
            ? M.tags(e.target.value)
            : e.target.value;
        scheduleSave();
        if (
          [
            "title",
            "creator",
            "workTitle",
            "workType",
            "quote",
            "tags",
          ].includes(e.target.dataset.field)
        ) {
          renderLibrary();
          renderDraft();
        }
        if (
          [
            "title",
            "creator",
            "creatorUrl",
            "contributors",
            "annotation",
            "workTitle",
            "workType",
            "year",
            "url",
          ].includes(e.target.dataset.field)
        )
          renderSources();
        if (e.target.dataset.field === "altText" && view === "alt") renderAlt();
      }
      return;
    }
    if (e.target.matches("[data-alt-id]")) {
      const p = piece(e.target.dataset.altId);
      if (p) {
        p.altText = e.target.value;
        scheduleSave();
      }
    }
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.matches("[data-alt-id]")) {
      renderAlt();
      renderInspector();
      renderDailyTools();
    }
    if (e.target.matches("[data-part-title]")) renderDailyTools();
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "image-input") {
      stageImport(e.target.files);
      e.target.value = "";
    }
    if (e.target.id === "project-input") {
      if (e.target.files[0]) openProject(e.target.files[0]);
      e.target.value = "";
    }
  });
  document.addEventListener("click", (e) => {
    const tab = e.target.closest("button[data-view]");
    if (tab) {
      view = tab.dataset.view;
      selectedId = null;
      render();
      if (view === "research") {
        syncAgentContext();
        refreshResearch();
      }
      return;
    }
    const format = e.target.closest("[data-format]");
    if (format) {
      citationFormat = format.dataset.format;
      renderSources();
    }
  });
  $("#add-image").onclick = () => $("#image-input").click();
  $("#add-quote").onclick = () =>
    addPiece("quote", { title: "New quote", workType: "quote" });
  $("#add-link").onclick = () =>
    addPiece("link", { title: "New link", workType: "web page" });
  $("#import-project").onclick = () => $("#project-input").click();
  $("#save-project").onclick = saveProject;
  $("#undo").onclick = () => undo();
  $("#redo").onclick = () => undo(true);
  $("#capture").onclick = () => openCapture();
  $("#export-svg").onclick = () => exportSvg(project.parts);
  let pointerDrag = null;
  document.addEventListener("pointerdown", (e) => {
    if (
      e.button !== 0 ||
      e.target.closest(".move-actions button,.move-actions select") ||
      (e.pointerType === "touch" && !e.target.closest(".piece-drag"))
    )
      return;
    const from = e.target.closest("[data-drag-item]"),
      library = e.target.closest("[data-drag-piece]");
    if (!from && !library) return;
    pointerDrag = {
      pieceId: from?.dataset.dragItem || library.dataset.dragPiece,
      fromPart: from?.dataset.fromPart,
      index: from ? Number(from.dataset.index) : null,
      startX: e.clientX,
      startY: e.clientY,
      source: from || library,
      pointerId: e.pointerId,
      dragging: false,
    };
  });
  document.addEventListener("pointermove", (e) => {
    const d = pointerDrag;
    if (!d || d.pointerId !== e.pointerId) return;
    if (
      !d.dragging &&
      Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 7
    ) {
      d.dragging = true;
      d.source.classList.add("dragging");
      document.body.setPointerCapture?.(e.pointerId);
      if (!d.fromPart && view !== "draft") {
        view = "draft";
        document.body.dataset.workflow = "draft";
        document.body.dataset.view = "draft";
        document.body.classList.remove("gathering-mode");
        // Keep the source DOM alive throughout the captured pointer gesture.
        ["library", "research", "preview", "alt", "sources"].forEach((v) =>
          $("#" + v + "-view").classList.add("hidden"),
        );
        $("#draft-view").classList.remove("hidden");
        $("#view-title").textContent = "Weaving";
        $("#view-subtitle").textContent = "Drop into a part to add your piece.";
        document.querySelectorAll(".view-tab").forEach((b) => {
          b.classList.toggle("active", b.dataset.view === "draft");
          b.setAttribute("aria-selected", String(b.dataset.view === "draft"));
        });
      }
      d.ghost = document.createElement("div");
      d.ghost.className = "drag-ghost";
      d.ghost.textContent = pieceTitle(piece(d.pieceId));
      document.body.append(d.ghost);
    }
    if (!d.dragging) return;
    e.preventDefault();
    d.ghost.style.left = `${e.clientX + 13}px`;
    d.ghost.style.top = `${e.clientY + 13}px`;
    document
      .querySelectorAll(".drop-target")
      .forEach((el) => el.classList.remove("drop-target"));
    document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest("[data-drop-part]")
      ?.classList.add("drop-target");
  });
  document.addEventListener("pointerup", (e) => {
    const d = pointerDrag;
    if (!d || d.pointerId !== e.pointerId) return;
    pointerDrag = null;
    if (!d.dragging) return;
    suppressClickUntil = Date.now() + 350;
    d.source.classList.remove("dragging");
    d.ghost?.remove();
    document
      .querySelectorAll(".drop-target")
      .forEach((el) => el.classList.remove("drop-target"));
    const target = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest("[data-drop-part]");
    if (!target) {
      render();
      return;
    }
    const card = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest("[data-drag-item]");
    const index = card
      ? Number(card.dataset.index) +
        (e.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2
          ? 1
          : 0)
      : part(target.dataset.dropPart).items.length;
    if (d.fromPart)
      movePlaced(d.fromPart, d.index, target.dataset.dropPart, index);
    else addToPart(d.pieceId, target.dataset.dropPart, index);
  });
  document.addEventListener("pointercancel", () => {
    pointerDrag?.ghost?.remove();
    pointerDrag?.source?.classList.remove("dragging");
    pointerDrag = null;
    document
      .querySelectorAll(".drop-target")
      .forEach((el) => el.classList.remove("drop-target"));
  });
  document.addEventListener("dragstart", (e) => {
    if (e.target.closest("[data-drag-piece],[data-drag-item]"))
      e.preventDefault();
  });
  document.addEventListener("dragover", (e) => {
    if (!e.target.closest("input,textarea")) e.preventDefault();
  });
  document.addEventListener("dragleave", (e) => {
    const target = e.target.closest("[data-drop-part]");
    if (target && !target.contains(e.relatedTarget))
      target.classList.remove("drop-target");
  });
  document.addEventListener("drop", (e) => {
    if (e.target.closest("input,textarea")) return;
    e.preventDefault();
    if (e.dataTransfer.files?.length) {
      stageImport(e.dataTransfer.files);
      return;
    }
    captureClipboard(e.dataTransfer);
  });

  document.addEventListener("paste", (e) => {
    if (e.target.closest("input,textarea,[contenteditable]")) return;
    e.preventDefault();
    captureClipboard(e.clipboardData);
  });
  document.addEventListener("keydown", (e) => {
    const editing = !!e.target.closest("input,textarea,[contenteditable]"),
      mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      selectedId = null;
      render();
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      pasteFromButton();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveProject();
      return;
    }
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openCapture();
      return;
    }
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      if (["alt", "research"].includes(view)) { view = "marking"; render(); }
      if (["preview", "peeling", "sources"].includes(view)) { view = "library"; render(); }
      const searchTarget = ({gathering: "#gather-search", library: "#nip-search", marking: "#marking-search", draft: "#piece-search"})[view];
      $(searchTarget)?.focus();
      return;
    }
    if (!editing && mod && ["z", "y"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      undo(e.shiftKey || e.key.toLowerCase() === "y");
      return;
    }
    if (!editing && (e.key === "Enter" || e.key === " ")) {
      const card = e.target.closest(".draft-card");
      if (card && !e.target.closest("button,select")) {
        e.preventDefault();
        selectedId = card.dataset.select;
        render();
      }
    }
  });
  document.addEventListener("focusin", (e) => {
    if (
      e.target.matches(
        "[data-gather-field],[data-field],[data-alt-id],[data-part-title],#project-title,#draft-notes",
      )
    )
      checkpoint();
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "draft-picker") {
      workspace.activeId = e.target.value;
      attachProject();
      selectedId = null;
      bulkIds.clear();
      scheduleSave();
      render();
    }
    if (e.target.id === "draft-status") {
      checkpoint();
      project.status = e.target.value;
      scheduleSave();
    }
    if (e.target.id === "library-filter") {
      libraryFilter = e.target.value;
      bulkIds.clear();
      renderLibrary();
    }
    if (e.target.id === "library-sort") {
      librarySort = e.target.value;
      renderLibrary();
    }
    if (e.target.matches("[data-bulk-id]")) {
      e.target.checked
        ? bulkIds.add(e.target.dataset.bulkId)
        : bulkIds.delete(e.target.dataset.bulkId);
      renderLibrary();
    }
    if (e.target.matches("[data-columns]")) {
      checkpoint();
      part(e.target.dataset.columns).columns = Number(e.target.value);
      scheduleSave();
      renderPreview();
    }
    if (e.target.matches("[data-move-placement]")) {
      const [from, index] = e.target.dataset.movePlacement.split(":");
      movePlaced(
        from,
        Number(index),
        e.target.value,
        part(e.target.value).items.length,
      );
    }
    if (e.target.id === "group-citations") {
      groupCitations = e.target.checked;
      renderSources();
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "draft-notes") {
      project.notes = e.target.value;
      scheduleSave();
    }
  });
  document.addEventListener("click", (e) => {
    const tag = e.target.closest("[data-tag-filter]");
    if (tag) {
      tagFilter = tag.dataset.tagFilter;
      renderLibrary();
    }
  });

  function renderDailyTools() {
    $("#draft-picker").innerHTML = workspace.drafts
      .map(
        (d) =>
          `<option value="${d.id}" ${d.id === project.id ? "selected" : ""}>${escapeHtml(d.title || "Untitled webweave")}</option>`,
      )
      .join("");
    $("#draft-status").value = project.status || "gathering";
    $("#draft-notes").value = project.notes || "";
    $("#undo").disabled = !history.length;
    $("#redo").disabled = !future.length;
    $("#known-authors").innerHTML = [
      ...new Set(workspace.pieces.map((p) => p.creator).filter(Boolean)),
    ]
      .sort()
      .map((name) => `<option value="${escapeHtml(name)}">`)
      .join("");
    document
      .querySelector(".draft-notes")
      .classList.toggle(
        "hidden",
        view !== "draft",
      );
    const p = selected();
    if (p?.research?.length) {
      const evidence = document.createElement("section");
      evidence.className = "inspector-section";
      evidence.innerHTML = "<h3>Research trail</h3>" + evidenceHtml(p.research);
      $("#inspector-content").append(evidence);
    }
    if (p && safeUrl(p.url)) {
      const actions = document.createElement("div");
      actions.className = "inspector-actions";
      actions.innerHTML = `<a class="button small" href="${escapeHtml(safeUrl(p.url))}" target="_blank" rel="noopener noreferrer">Visit source ↗</a><button class="button small" data-action="fetch-details" data-piece-id="${p.id}">Fill missing credits</button>`;
      $("#inspector-content").append(actions);
    }
    const code = `(()=>{const selection=window.getSelection()?.toString()||'';const author=document.querySelector('meta[name="author"]')?.content||'';const data={text:selection,url:location.href,title:document.title,author};window.open('${location.origin}/#capture='+encodeURIComponent(JSON.stringify(data)),'_blank','noopener')})()`;
    $("#bookmarklet").href = "javascript:" + encodeURIComponent(code);
  }
  function renderPreview() {
    $("#preview-view").innerHTML =
      `<div class="draft-intro"><p>Images and words, in conversation.</p><button class="button small" data-action="print-preview">Print / Save PDF</button></div><article class="weave-preview"><h2>${escapeHtml(project.title)}</h2>${project.notes ? `<p class="weave-intention">${escapeHtml(project.notes)}</p>` : ""}${project.parts
        .map(
          (prt) =>
            `<section><h3>${escapeHtml(prt.title)}</h3><div class="preview-grid" style="--columns:${prt.columns || 1}">${prt.items
              .map(piece)
              .filter(Boolean)
              .map(
                (p) =>
                  `<figure>${p.kind === "image" ? `<img src="${safeImageData(p.imageData)}" alt="${escapeHtml(p.altText)}">` : p.kind === "quote" ? `<blockquote>${escapeHtml(p.quote)}</blockquote>` : `<div class="preview-link">↗ ${escapeHtml(pieceTitle(p))}</div>`}<figcaption>${creditMarkup(p, "rich")}</figcaption></figure>`,
              )
              .join("")}</div></section>`,
        )
        .join("")}</article>`;
  }
  function creators(p) {
    return [
      { name: p.creator, url: p.creatorUrl },
      ...(p.contributors || "")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, url] = line.split("|");
          return { name: clean(name), url: clean(url) };
        }),
    ].filter((a) => clean(a.name));
  }
  const md = (s) => String(s || "").replace(/[\\`*_{}\[\]<>]/g, "\\$&");
  const mdUrl = (s) =>
    safeUrl(s).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
  function creditMarkup(p, format) {
    const title = plain(p.workTitle) || pieceTitle(p),
      authors = creators(p),
      details = [
        p.annotation,
        p.workType || kindLabel[p.kind].toLowerCase(),
        p.year,
      ]
        .filter(Boolean)
        .join(", ");
    const link = (label, url) =>
      format === "rich"
        ? safeUrl(url)
          ? `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
          : escapeHtml(label)
        : format === "markdown"
          ? safeUrl(url)
            ? `[${md(label)}](${mdUrl(url)})`
            : md(label)
          : label;
    const name = authors.length
      ? authors.map((a) => link(a.name, a.url)).join(" & ")
      : "Unknown creator";
    const work =
      format === "rich"
        ? `<em>${link(title, p.url)}</em>`
        : format === "markdown"
          ? `*${link(title, p.url)}*`
          : `“${title}”`;
    return `${work}, ${name}${details ? ` (${format === "rich" ? escapeHtml(details) : format === "markdown" ? md(details) : details})` : ""}${format === "plain" && safeUrl(p.url) ? ` — ${safeUrl(p.url)}` : ""}${
      format === "plain"
        ? authors
            .filter((a) => safeUrl(a.url))
            .map((a) => ` [${a.name}: ${safeUrl(a.url)}]`)
            .join("")
        : ""
    }`;
  }
  function openCapture(data = {}) {
    const f = $("#capture-form");
    f.reset();
    $("#capture-content").value = data.text || data.url || "";
    $("#capture-author").value = data.author || "";
    $("#capture-title").value = data.title || "";
    $("#capture-url").value = data.url || "";
    $("#capture-dialog").showModal();
    $("#capture-content").focus();
  }
  function readIncomingClip() {
    if (!location.hash.startsWith("#capture=")) return;
    try {
      const data = JSON.parse(decodeURIComponent(location.hash.slice(9)));
      historyReplaceHash();
      openCapture({
        text: String(data.text || ""),
        url: safeUrl(data.url),
        title: String(data.title || ""),
        author: String(data.author || ""),
      });
    } catch {
      toast(
        "This clip could not be read. Paste it into Quick capture instead.",
      );
      historyReplaceHash();
    }
  }
  function historyReplaceHash() {
    window.history.replaceState(null, "", location.pathname + location.search);
  }
  window.addEventListener("hashchange", readIncomingClip);
  async function fetchSource(url) {
    const response = await fetch("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Could not read this page.");
    return data;
  }
  function metadata(html, url) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const meta = (name) =>
      doc
        .querySelector(`meta[property="${name}"],meta[name="${name}"]`)
        ?.getAttribute("content") || "";
    const author = meta("author") || meta("article:author") || "";
    return {
      workTitle: meta("og:title") || doc.title || "",
      creator: safeUrl(author) ? "" : author,
      creatorUrl: safeUrl(author),
      workType: meta("og:type") === "article" ? "article" : "web page",
      url: safeUrl(url),
    };
  }
  async function captureUrl(url, extra = {}) {
    toast("Saving the link; checking for page details…");
    const p = addPiece("link", {
      title: new URL(url).hostname,
      url,
      workType: "web page",
      ...extra,
      kind: "link",
    });
    try {
      const data = await fetchSource(url);
      if (!piece(p.id)) return p;
      if (data.kind === "image") {
        const response = await fetch(data.data);
        const result = await imageToData(await response.blob());
        Object.assign(p, {
          kind: "image",
          imageData: result.data,
          width: result.width,
          height: result.height,
          workType: "image",
          title:
            extra.title ||
            decodeURIComponent(new URL(url).pathname.split("/").pop()) ||
            "Saved image",
        });
      } else {
        const details = metadata(data.html, data.url);
        for (const key of ["creator", "creatorUrl", "workTitle"])
          if (!clean(p[key])) p[key] = details[key];
        if (!extra.title && p.title === new URL(url).hostname)
          p.title = details.workTitle || p.title;
        if (!extra.workType) p.workType = details.workType;
      }
      if (captureSettings.tag) p.tags = M.tags([...p.tags, ...NookCapture.suggestTags(p)]);
      queueTranscription(p);
      scheduleSave();
      renderPreservingFocus();
      toast("Saved to your collection. Keep gathering.");
    } catch (e) {
      toast(
        "Link saved. Page details unavailable; you can fill them in later.",
      );
    }
    return p;
  }
  async function captureClipboard(data) {
    const files = [...(data.files || [])].filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length) {
      await importImages(files);
      return;
    }
    const text = clean(data.getData("text/plain")),
      html = data.getData("text/html") || "",
      uri = safeUrl(data.getData("text/uri-list"));
    const doc = html
      ? new DOMParser().parseFromString(html, "text/html")
      : null;
    const source =
      safeUrl(html.match(/SourceURL:\s*([^\r\n<>]+)/i)?.[1]) ||
      safeUrl(doc?.querySelector("[cite]")?.getAttribute("cite"));
    if (uri || safeUrl(text)) {
      await captureUrl(uri || safeUrl(text));
      return;
    }
    const imageUrl = safeUrl(doc?.querySelector("img")?.getAttribute("src"));
    if (imageUrl && !text) {
      await captureUrl(imageUrl);
      return;
    }
    const passage = text || doc?.body.textContent?.trim();
    if (passage) {
      const existing = workspace.pieces.find(
        (p) => p.kind === "quote" && p.quote === passage && !p.trashed,
      );
      if (existing) {
        selectedId = existing.id;
        render();
        toast("You already saved this passage.");
        return;
      }
      addPiece("quote", {
        title: passage.split("\n")[0].slice(0, 70),
        quote: passage,
        url: source || "",
        workType: "quote",
      });
      toast("Saved. Keep gathering; credits can wait for Marking.");
      return;
    }
    toast("Copy a quote, image, or URL, then paste it here.");
  }
  async function pasteFromButton() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (imageType) {
          await importImages([
            new File([await item.getType(imageType)], "Pasted image.png", {
              type: imageType,
            }),
          ]);
          return;
        }
      }
      const content = {};
      for (const item of items)
        for (const type of ["text/plain", "text/html"])
          if (item.types.includes(type))
            content[type] = await (await item.getType(type)).text();
      await captureClipboard({ files: [], getData: (t) => content[t] || "" });
    } catch {
      openCapture();
      toast(
        "Paste into this capture box, or close it and press Ctrl+V on the page.",
      );
    }
  }
  $("#capture-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = clean($("#capture-content").value);
    const extra = {
      creator: clean($("#capture-author").value),
      workTitle: clean($("#capture-title").value),
      tags: M.tags($("#capture-tags").value),
    };
    const url = safeUrl($("#capture-url").value),
      place = $("#capture-place").checked,
      target = activePartId;
    $("#capture-dialog").close();
    let p;
    if (safeUrl(value)) p = await captureUrl(safeUrl(value), extra);
    else
      p = addPiece("quote", {
        title: value.split("\n")[0].slice(0, 70),
        quote: value,
        url,
        workType: "quote",
        ...extra,
      });
    if (place && part(target)) addToPart(p.id, target);
  });
  function openBulk() {
    const dialog = document.createElement("dialog");
    dialog.innerHTML = `<form><h2>Credit ${bulkIds.size} pieces</h2><p class="helper">Blank fields leave existing details in place. Tags are added to each piece.</p><label class="field"><span>Author / artist</span><input name="creator" list="known-authors"></label><label class="field"><span>Add tags</span><input name="tags" placeholder="home, water"></label><div class="dialog-actions"><button type="button" class="button quiet">Cancel</button><button class="button primary">Apply</button></div></form>`;
    document.body.append(dialog);
    dialog.querySelector('[type="button"]').onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    dialog.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      checkpoint();
      const data = new FormData(e.target);
      for (const id of bulkIds) {
        const p = piece(id);
        if (!p) continue;
        if (clean(data.get("creator"))) p.creator = clean(data.get("creator"));
        p.tags = M.tags([...(p.tags || []), ...M.tags(data.get("tags"))]);
      }
      scheduleSave();
      render();
      dialog.close();
    };
    dialog.showModal();
  }
  document.addEventListener("click", async (e) => {
    const button = e.target.closest('[data-action="fetch-details"]');
    if (!button) return;
    const p = piece(button.dataset.pieceId);
    button.disabled = true;
    try {
      const data = await fetchSource(p.url);
      if (data.kind !== "page")
        throw new Error("This link is an image. Add the creator manually.");
      checkpoint();
      const details = metadata(data.html, data.url);
      for (const key of ["creator", "creatorUrl", "workTitle", "workType"])
        if (!clean(p[key])) p[key] = details[key];
      scheduleSave();
      render();
      toast("Missing details filled. Please check the attribution.");
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    }
  });

  let proposals = [],
    researchError = "";
  function researchContext() {
    return {
      format: "nook-context/v1",
      updatedAt: new Date().toISOString(),
      activeDraftId: project.id,
      drafts: workspace.drafts.map((d) => ({
        id: d.id,
        title: d.title,
        theme: d.notes,
        status: d.status,
        parts: d.parts,
      })),
      pieces: workspace.pieces
        .filter((p) => !p.trashed)
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          imageUrl: p.imageData
            ? location.origin + "/api/agent/images/" + p.id
            : undefined,
          title: p.title,
          quote: p.quote,
          creator: p.creator,
          creatorUrl: p.creatorUrl,
          contributors: p.contributors,
          workTitle: p.workTitle,
          workType: p.workType,
          year: p.year,
          url: p.url,
          tags: p.tags || [],
          annotation: p.annotation,
          ocrText: p.ocrText,
          visualNotes: p.visualNotes,
          altText: p.altText,
          missingFields: [
            "creator",
            "workTitle",
            "workType",
            "url",
            "year",
          ].filter((key) => !clean(p[key])),
        })),
      proposalEndpoint: location.origin + "/api/agent/proposals",
      schemaEndpoint: location.origin + "/api/agent/schema",
    };
  }
  let agentSync = Promise.resolve(),
    agentImages = new Map();
  function syncAgentContext() {
    agentSync = agentSync
      .catch(() => {})
      .then(async () => {
        for (const p of workspace.pieces.filter(
          (p) =>
            !p.trashed && p.imageData && agentImages.get(p.id) !== p.imageData,
        )) {
          const response = await fetch("/api/agent/images/" + p.id, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: p.imageData }),
          });
          if (response.ok) agentImages.set(p.id, p.imageData);
        }
        const response = await fetch("/api/agent/context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(researchContext()),
        });
        if (!response.ok)
          throw new Error("Research context could not be refreshed.");
      })
      .catch(() => {});
    return agentSync;
  }
  async function refreshResearch() {
    try {
      const response = await fetch("/api/agent/proposals");
      if (!response.ok)
        throw new Error(
          "Restart the Nook launcher to enable the research desk.",
        );
      const data = await response.json();
      proposals = data.proposals;
      researchError = "";
    } catch (e) {
      researchError = e.message;
    }
    renderResearch();
  }
  function evidenceHtml(evidence) {
    return `<ul class="evidence-list">${evidence.map((e) => `<li><a href="${escapeHtml(safeUrl(e.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.url)}</a><br>${escapeHtml(e.note)}</li>`).join("")}</ul>`;
  }
  function eligibleFields(p, fields) {
    return Object.entries(fields).filter(
      ([key, value]) => key === "tags" || !clean(p?.[key]),
    );
  }
  function renderResearch() {
    const el = $("#research-view");
    if (!el) return;
    el.innerHTML = `<section class="section-card"><p class="eyebrow">An extra pair of eyes</p><h2>Research desk</h2><p>Let an agent trace a quote, verify a creator, or suggest related pieces. Suggestions wait here for your review. Filled fields are preserved, and evidence stays with accepted pieces.</p><div class="source-actions"><button class="button primary" data-action="agent-instructions">Copy agent instructions</button><button class="button" data-action="agent-packet">Export research packet</button><button class="button" data-action="agent-import">Import suggestions</button><button class="button quiet" data-action="agent-refresh">Refresh inbox</button></div><p class="source-note">${bulkIds.size ? `${bulkIds.size} selected pieces will be included in the exported packet.` : "The packet includes collection metadata, quote text, and draft themes. Private notes are excluded. Saved images are available to local agents through the image links in the packet."}</p><details><summary>Local agent interface</summary><p class="source-note">Read <code>${escapeHtml(location.origin)}/api/agent/context</code> and <code>/api/agent/schema</code>. Submit JSON to <code>/api/agent/proposals</code>. Nook must be running. Agents can also return a JSON file for import.</p></details></section>${researchError ? `<p class="source-note">${escapeHtml(researchError)}</p>` : ""}${
      proposals.length
        ? proposals
            .map(
              (proposal) =>
                `<section class="section-card research-proposal" data-proposal="${proposal.id}"><p class="eyebrow">${escapeHtml(proposal.agent)}</p><h2>${escapeHtml(proposal.summary || "Research suggestions")}</h2>${proposal.updates
                  .map((u, i) => {
                    const p = piece(u.pieceId),
                      available = p ? eligibleFields(p, u.fields) : [];
                    return `<div class="research-suggestion"><label class="checkbox-label"><input type="checkbox" data-update-index="${i}" ${available.length ? "checked" : "disabled"}><strong>${escapeHtml(p ? pieceTitle(p) : "Piece no longer in this collection")}</strong></label><dl class="research-fields">${Object.entries(
                      u.fields,
                    )
                      .map(
                        ([key, value]) =>
                          `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(Array.isArray(value) ? value.join(", ") : value)}${p && key !== "tags" && clean(p[key]) ? ` <small>Kept as: ${escapeHtml(p[key])}</small>` : ""}</dd>`,
                      )
                      .join("")}</dl>${evidenceHtml(u.evidence)}</div>`;
                  })
                  .join(
                    "",
                  )}${proposal.additions.map((p, i) => `<div class="research-suggestion"><label class="checkbox-label"><input type="checkbox" data-add-index="${i}" checked><strong>New ${escapeHtml(p.kind)} · ${escapeHtml(p.title || p.workTitle || "Untitled")}</strong></label>${p.quote ? `<blockquote>${escapeHtml(p.quote)}</blockquote>` : ""}<p class="source-note">${escapeHtml([p.creator, p.workTitle, p.url].filter(Boolean).join(" · "))}</p>${evidenceHtml(p.evidence)}</div>`).join("")}<div class="source-actions"><button class="button primary" data-action="agent-apply" data-proposal-id="${proposal.id}">Apply selected & finish</button><button class="button quiet" data-action="agent-dismiss" data-proposal-id="${proposal.id}">Dismiss</button></div></section>`,
            )
            .join("")
        : `<div class="section-card first-step"><div class="flower">✳</div><h3>No suggestions waiting</h3><p>Give an agent a research packet or the local interface instructions. Refresh here when it has finished.</p></div>`
    }`;
  }
  async function markProposal(id, status) {
    const response = await fetch(`/api/agent/proposals/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!response.ok)
      throw new Error(
        "Could not update the research inbox. Refresh and try again.",
      );
  }
  async function applyProposal(id) {
    const proposal = proposals.find((p) => p.id === id);
    if (!proposal) return;
    if (workspace.appliedProposals?.includes(id)) {
      await markProposal(id, "accepted");
      await refreshResearch();
      return;
    }
    const container = document.querySelector(`[data-proposal="${id}"]`),
      updates = [
        ...container.querySelectorAll("[data-update-index]:checked"),
      ].map((e) => Number(e.dataset.updateIndex)),
      additions = [
        ...container.querySelectorAll("[data-add-index]:checked"),
      ].map((e) => Number(e.dataset.addIndex));
    if (!updates.length && !additions.length) {
      toast("Select a suggestion, or dismiss this packet.");
      return;
    }
    container.querySelectorAll("button").forEach((b) => (b.disabled = true));
    checkpoint();
    let count = 0;
    for (const index of updates) {
      const u = proposal.updates[index],
        p = piece(u.pieceId);
      if (!p) continue;
      for (const [key, value] of eligibleFields(p, u.fields))
        p[key] = key === "tags" ? M.tags([...(p.tags || []), ...value]) : value;
      p.research = [
        ...(p.research || []),
        ...u.evidence.map((e) => ({ ...e, agent: proposal.agent })),
      ];
      count++;
    }
    for (const index of additions) {
      const addition = proposal.additions[index];
      let p;
      if (addition.kind === "image")
        p = await captureUrl(addition.imageUrl, {
          ...addition,
          url: addition.url,
        });
      else p = addPiece(addition.kind, { ...addition });
      p.research = addition.evidence.map((e) => ({
        ...e,
        agent: proposal.agent,
      }));
      count++;
    }
    workspace.appliedProposals = [...(workspace.appliedProposals || []), id];
    scheduleSave();
    await save();
    if (dirty || conflict) {
      toast(
        "Suggestions are in this tab, but saving failed. Back up before reloading.",
      );
      render();
      return;
    }
    await markProposal(id, "accepted");
    await refreshResearch();
    render();
    toast(`${count} suggestions applied. Existing credits were preserved.`);
  }
  document.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-action]");
    if (!button) return;
    try {
      switch (button.dataset.action) {
        case "agent-refresh":
          await syncAgentContext();
          await refreshResearch();
          break;
        case "agent-instructions":
          await syncAgentContext();
          await copyText(
            `Help research my webweave collection. Read ${location.origin}/api/agent/context and ${location.origin}/api/agent/schema. Verify unfilled creator, title, type, year, and source fields against reliable sources. You may propose related quotes or images that fit my draft themes. Do not invent quotations or attribution; leave uncertainty unresolved and explain it. Submit evidence-backed JSON to ${location.origin}/api/agent/proposals using format nook-research/v1. I will review the suggestions in Nook. Do not modify the collection directly.`,
            "Agent instructions copied.",
          );
          break;
        case "agent-packet": {
          const context = researchContext();
          if (bulkIds.size)
            context.pieces = context.pieces.filter((p) => bulkIds.has(p.id));
          download(
            "nook-research-context.json",
            JSON.stringify(context, null, 2),
            "application/json",
          );
          break;
        }
        case "agent-import":
          $("#agent-input").click();
          break;
        case "agent-apply":
          await applyProposal(button.dataset.proposalId);
          break;
        case "agent-dismiss":
          await markProposal(button.dataset.proposalId, "dismissed");
          await refreshResearch();
          break;
      }
    } catch (error) {
      toast(error.message);
      await refreshResearch();
    }
  });
  $("#agent-input").onchange = async (e) => {
    try {
      const file = e.target.files[0];
      if (!file) return;
      const response = await fetch("/api/agent/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await file.text(),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await refreshResearch();
      view = "research";
      render();
      toast("Suggestions imported for review.");
    } catch (error) {
      toast(error.message);
    }
    e.target.value = "";
  };

  let visiblePieces = [],
    thumbnailSize = 180;

  function renderGathering() {
    if (view !== "gathering") return;
    const pieces = workspace.pieces
      .filter((p) => !p.trashed)
      .filter(p => [p.title,p.creator,p.workTitle,p.quote,p.ocrText,p.url,...p.tags].join(" ").toLowerCase().includes(gatheringQuery))
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    $("#gathering-view").innerHTML = `<div class="gather-dropzone"><div class="gather-flower" aria-hidden="true">✳</div><p class="eyebrow">A place for things that catch your eye</p><h2>One piece, then another.</h2><p>Images, words, links. Copy and paste, or drop them here.</p><button id="gather-paste" class="button primary" type="button">Paste a piece <kbd>Ctrl V</kbd></button><div class="gather-toolbar"><button class="button quiet" data-action="capture">Write or paste text</button><button class="button quiet" data-action="gallery-import">Choose images</button><button class="button quiet" data-action="capture-help">Web clipper & shortcuts</button><button class="button quiet" data-install-help>Install & sharing</button></div><div class="gather-automation"><label class="capture-location-label">Processing <select id="capture-location" aria-label="Capture processing location"><option value="server" ${captureSettings.location !== "device" ? "selected" : ""}>Server when connected</option><option value="device" ${captureSettings.location === "device" ? "selected" : ""}>This device</option></select></label><label class="checkbox-label"><input id="auto-transcribe" type="checkbox" ${captureSettings.transcribe ? "checked" : ""}> Automatically transcribe images</label><label class="checkbox-label"><input id="auto-tag" type="checkbox" ${captureSettings.tag ? "checked" : ""}> Tag from captured words</label></div><p id="capture-progress" class="source-note" role="status">${captureProcessing ? "Processing your pieces in the background…" : (captureSettings.location === "device" ? "Transcription and tags run on this device. Saved as you gather." : "Your server handles transcription and tags when connected. To prepare offline transcription, read one image using This device.")}</p></div><div class="gather-toolbar"><div><p class="eyebrow">Freshly gathered</p><strong>${pieces.length} ${pieces.length === 1 ? "piece" : "pieces"} in your collection</strong></div><input id="gather-search" type="search" aria-label="Search gathering list" value="${escapeHtml(gatheringQuery)}" placeholder="Find something you saved…"><button class="button quiet" data-view="library">Start nipping →</button></div><div class="gather-recent">${pieces.slice(0, 40).map(p => `<article class="gather-row" data-gather-row="${p.id}"><div class="gather-piece">${p.imageData ? `<img src="${safeImageData(p.imageData)}" alt="${escapeHtml(p.altText)}" loading="lazy">` : `<span class="gather-kind" aria-hidden="true">${kindIcon(p)}</span>`}<div><small class="eyebrow">${kindLabel[p.kind]}${captureStates.has(p.id) ? " · " + ({queued:"Waiting to process",reading:"Processing…",done:"Processed",error:"Review processing"})[captureStates.get(p.id)] : ""}${p.processingSource ? " · " + (p.processingSource === "server" ? "On server" : "On this device") : ""}</small><strong>${escapeHtml(pieceTitle(p))}</strong><p>${escapeHtml((p.quote || p.ocrText || p.url || "").slice(0, 210))}</p><div class="tag-filters">${(p.tags || []).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div></div></div><button class="button small quiet" data-mark-piece="${p.id}">Mark details ↗</button></article>`).join("") || '<div class="first-step"><h3>Leave a little room for discovery.</h3><p>Your first piece will appear here. Everything you gather can find its way into several projects.</p></div>'}</div>${pieces.length > 40 ? '<button class="button quiet full" data-view="library">See the whole collection →</button>' : ""}`;
    $("#gather-paste").onclick = () => {
      $("#gather-paste").focus();
      if (window.isSecureContext && navigator.clipboard?.read) pasteFromButton();
      else toast("Press Ctrl+V to add an image, passage, or link.");
    };
  }
  document.addEventListener("input", (e) => {
    if (e.target.dataset.gatherField) {
      const p = piece(e.target.dataset.gatherId);
      if (!p) return;
      const key = e.target.dataset.gatherField;
      p[key] =
        key === "tags"
          ? [
              ...new Set(
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              ),
            ]
          : e.target.value;
      p.updatedAt = Date.now();
      scheduleSave();
      if (selectedId === p.id) renderInspector();
    }
    if (e.target.id === "gather-search") {
      const query = e.target.value.trim().toLowerCase();
      gatheringQuery = query;
      const active = document.activeElement;
      const cursor = active.selectionStart;
      renderGathering();
      $("#gather-search").focus();
      $("#gather-search").setSelectionRange(cursor,cursor);
      document.querySelectorAll("[data-gather-row]").forEach((row) => {
        const p = piece(row.dataset.gatherRow);
        row.hidden = ![
          p.title,
          p.creator,
          p.workTitle,
          p.quote,
          p.ocrText,
          p.url,
          ...(p.tags || []),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);
      });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input[data-gather-field]")) {
      e.preventDefault();
      const fields = [
        ...e.target
          .closest(".gather-row,.marking-row")
          .querySelectorAll("[data-gather-field]"),
      ];
      (fields[fields.indexOf(e.target) + 1] || fields[0])?.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="gather-quote"]'))
      addPiece("quote", { title: "New quote", workType: "quote" });
  });

  function renderGallery() {
    const el = $("#library-view");
    if (!el) return;
    el.innerHTML = `<div class="gallery-toolbar"><div><strong>${visiblePieces.length} ${visiblePieces.length === 1 ? "piece" : "pieces"}</strong><span class="source-note"> · ${bulkIds.size} picked</span></div><input id="nip-search" type="search" aria-label="Search pieces" value="${escapeHtml(search)}" placeholder="Find a piece, maker, or tag…"><select id="nip-filter" aria-label="Filter pieces">${[['all','All pieces'],['inbox','Unused'],['draft','In this project'],['favorites','Favorites'],['uncredited','Needs credit'],['image','Images'],['quote','Quotes'],['link','Links'],['trash','Trash']].map(([v,t]) => `<option value="${v}" ${libraryFilter === v ? 'selected' : ''}>${t}</option>`).join('')}</select><select id="nip-sort" aria-label="Sort pieces">${[['newest','Newest first'],['oldest','Oldest first'],['author','By author'],['title','By title']].map(([v,t]) => `<option value="${v}" ${librarySort === v ? 'selected' : ''}>${t}</option>`).join('')}</select><label>Piece size <input id="thumbnail-size" aria-label="Thumbnail size" type="range" min="130" max="300" step="10" value="${thumbnailSize}"></label></div><div class="gallery-toolbar gallery-picks"><button class="button small" data-action="select-visible">Pick all visible</button><button class="button small quiet" data-action="bulk-clear" ${!bulkIds.size ? 'disabled' : ''}>Clear picks</button><label>Project <select id="nip-project" aria-label="Place into project">${workspace.drafts.map(d => `<option value="${d.id}" ${d.id === project.id ? 'selected' : ''}>${escapeHtml(d.title)}</option>`).join('')}</select></label><label>Part <select id="nip-target" aria-label="Place into part">${project.parts.map(p => `<option value="${p.id}" ${p.id === activePartId ? 'selected' : ''}>${escapeHtml(p.title)}</option>`).join('')}</select></label><button class="button primary small" data-action="bulk-place" ${!bulkIds.size ? 'disabled' : ''}>Add ${bulkIds.size || ''} to part</button><button class="button quiet small" data-view="draft">Go weaving →</button><button class="button quiet small" data-view="gathering">Gather more</button></div><div class="tag-filters">${tagFilter ? `<button data-tag-filter="" class="tag-chip active">${escapeHtml(tagFilter)} ×</button>` : ''}${[...new Set(workspace.pieces.filter(p => !p.trashed).flatMap(p => p.tags || []))].slice(0,12).filter(t => t !== tagFilter).map(t => `<button class="tag-chip" data-tag-filter="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join('')}</div><div class="contact-sheet" style="--thumb-size:${thumbnailSize}px">${visiblePieces.map((p) => `<article class="contact-item ${selectedId === p.id ? "selected" : ""}"><div class="contact-select"><input type="checkbox" data-bulk-id="${p.id}" aria-label="Select ${escapeHtml(pieceTitle(p))} for bulk editing" ${bulkIds.has(p.id) ? "checked" : ""}><span>${p.favorite ? "★ " : ""}${kindLabel[p.kind]}</span><span class="piece-drag" data-drag-piece="${p.id}" title="Drag into your weave">⠿</span></div><button class="contact-preview" data-select="${p.id}" data-drag-piece="${p.id}" aria-label="Edit ${escapeHtml(pieceTitle(p))}">${p.imageData ? `<img src="${safeImageData(p.imageData)}" alt="${escapeHtml(p.altText)}" loading="lazy">` : p.kind === "quote" ? `<blockquote>${escapeHtml(p.quote || "A passage waiting to be filled")}</blockquote>` : `<div class="contact-link">↗<p>${escapeHtml(p.workTitle || p.title)}</p></div>`}</button><div class="contact-caption"><strong>${escapeHtml(pieceTitle(p))}</strong><span>${escapeHtml(p.creator || "Add a creator")}</span><small>${escapeHtml((p.tags || []).join(" · "))}</small></div></article>`).join("")}</div>${!visiblePieces.length ? `<div class="first-step"><h3>A collection of connections</h3><p>Start with a quote or an image. It can belong to as many drafts as you like.</p></div>` : ""}`;
  }
  let importItems = [];
  async function stageImport(files) {
    const valid = [...files].filter((f) => f.type.startsWith("image/"));
    if (!valid.length) {
      toast("Choose image files to import.");
      return;
    }
    toast(`Preparing ${valid.length} images…`);
    importItems = [];
    for (const file of valid) {
      try {
        const result = await imageToData(file);
        importItems.push({
          name: file.name,
          ...result,
          selected: true,
          duplicate: workspace.pieces.some(
            (p) => p.imageData === result.data && !p.trashed,
          ),
        });
      } catch {
        toast(`Could not read ${file.name}.`);
      }
    }
    if (!importItems.length) return;
    importItems.forEach((p) => {
      if (p.duplicate) p.selected = false;
    });
    $("#import-tray-form").reset();
    renderImportTray();
    $("#import-tray").showModal();
  }
  function renderImportTray() {
    const selected = importItems.filter((p) => p.selected).length;
    $("#import-tray-count").textContent =
      `${selected} of ${importItems.length} selected`;
    $("#import-tray-grid").innerHTML = importItems
      .map(
        (p, i) =>
          `<label class="import-tile"><input type="checkbox" data-import-index="${i}" ${p.selected ? "checked" : ""}><img src="${p.data}" alt=""><span>${escapeHtml(p.name)}</span>${p.duplicate ? "<small>Already in your collection</small>" : ""}</label>`,
      )
      .join("");
    $("#import-tray-submit").disabled = !selected;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    switch (b.dataset.action) {
      case "gallery-import":
        $("#image-input").click();
        break;
      case "select-visible":
        visiblePieces.forEach((p) => bulkIds.add(p.id));
        renderLibrary();
        break;
      case "close-import":
        $("#import-tray").close();
        importItems = [];
        break;
      case "import-select-all":
        importItems.forEach((p) => (p.selected = true));
        renderImportTray();
        break;
      case "import-select-none":
        importItems.forEach((p) => (p.selected = false));
        renderImportTray();
        break;
    }
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "thumbnail-size") {
      thumbnailSize = Number(e.target.value);
      document
        .querySelector(".contact-sheet")
        ?.style.setProperty("--thumb-size", thumbnailSize + "px");
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches("[data-import-index]")) {
      importItems[Number(e.target.dataset.importIndex)].selected =
        e.target.checked;
      $("#import-tray-count").textContent =
        `${importItems.filter((p) => p.selected).length} of ${importItems.length} selected`;
      $("#import-tray-submit").disabled = !importItems.some((p) => p.selected);
    }
  });
  $("#import-tray-form").onsubmit = (e) => {
    e.preventDefault();
    const author = $("#import-author").value,
      source = $("#import-source").value,
      tags = M.tags($("#import-tags").value),
      place = $("#import-place").checked;
    const imports = importItems.filter((p) => p.selected);
    checkpoint();
    batchDepth++;
    for (const item of imports) {
      const p = addPiece("image", {
        title: item.name.replace(/\.[^.]+$/, ""),
        creator: author,
        url: source,
        tags: [...tags],
        imageData: item.data,
        width: item.width,
        height: item.height,
        workType: "image",
      });
      if (place) part(activePartId).items.push(p.id);
    }
    batchDepth--;
    importItems = [];
    $("#import-tray").close();
    if (view !== "gathering") view = "library";
    selectedId = null;
    scheduleSave();
    render();
    toast(`${imports.length} images imported.`);
  };


  function renderStageTools(stage) {
    let el = document.querySelector('#stage-tools');
    if (!el) {
      el = document.createElement('div'); el.id = 'stage-tools'; el.className = 'stage-tabs';
      document.querySelector('.view-header').after(el);
    }
    const tabs = stage === 'marking' ? [['marking','Metadata'],['alt','Image descriptions'],['research','Research desk']] : stage === 'peeling' ? [['peeling','Affinity exports'],['sources','Sources & citations']] : [];
    el.innerHTML = tabs.map(([key,label]) => `<button data-view="${key}" class="${view === key ? 'active' : ''}" aria-pressed="${view === key}">${label}</button>`).join('');
    el.hidden = !tabs.length;
    document.querySelector('.draft-switcher').classList.toggle('hidden', !['draft','peeling','preview','sources','alt'].includes(view));
  }
  function markingField(p, key, label, extra = '') {
    return `<label><span>${label}</span><input data-gather-id="${p.id}" data-gather-field="${key}" aria-label="${label} for ${escapeHtml(pieceTitle(p))}" value="${escapeHtml(key === 'tags' ? (p.tags || []).join(', ') : p[key])}" ${extra}></label>`;
  }
  let markingFilter = 'all';
  function renderMarking() {
    if (view !== 'marking') return;
    const pieces = workspace.pieces.filter(p => !p.trashed).filter(p => markingFilter !== 'missing' || !p.creator || !p.url || (p.kind === 'image' && !p.altText)).filter(p => [p.title,p.creator,p.quote,p.ocrText,p.workTitle,p.url,...p.tags].join(' ').toLowerCase().includes(markingQuery));
    $('#marking-view').innerHTML = `<div class="marking-toolbar"><div><strong>${pieces.length} ${pieces.length === 1 ? "piece" : "pieces"}</strong><p class="source-note">Changes follow each piece into every project.</p></div><input id="marking-search" type="search" aria-label="Search metadata" value="${escapeHtml(markingQuery)}" placeholder="Find a piece or creator…"><select id="marking-filter" aria-label="Metadata filter"><option value="all">All pieces</option><option value="missing" ${markingFilter === 'missing' ? 'selected' : ''}>Missing credits or descriptions</option></select><button class="button small" data-action="bulk-credit" ${!bulkIds.size ? 'disabled' : ''}>Edit selected (${bulkIds.size})</button></div><div class="marking-list">${pieces.map(p => `<article class="marking-row" data-gather-row="${p.id}"><div class="gather-piece">${p.imageData ? `<img src="${safeImageData(p.imageData)}" alt="${escapeHtml(p.altText)}" loading="lazy">` : `<blockquote>${escapeHtml((p.quote || p.title).slice(0,350))}</blockquote>`}<div><small class="eyebrow">${kindLabel[p.kind]}</small><strong>${escapeHtml(pieceTitle(p))}</strong></div><button class="button small quiet" data-select="${p.id}">All details ↗</button></div><div class="gather-credits marking-credits">${markingField(p,'title','Piece name')}${markingField(p,'creator','Author / artist','list="known-authors"')}${markingField(p,'workTitle','Work title')}${markingField(p,'url','Source link','type="url" placeholder="https://…"')}${markingField(p,'workType','Work type')}${markingField(p,'year','Year')}${markingField(p,'creatorUrl','Creator profile','type="url"')}${markingField(p,'tags','Tags','placeholder="Separate with commas"')}${markingField(p,'annotation','Citation note')}<div class="source-actions"><button class="button small" data-action="fetch-details" data-piece-id="${p.id}" ${!safeUrl(p.url) ? 'disabled' : ''}>Fill missing credits</button><button class="button small quiet" data-tag-piece="${p.id}">Suggest tags</button></div></div></article>`).join('') || '<div class="first-step"><h3>Everything starts with a piece.</h3><p>Gather something first; its credits and context can take shape here.</p><button class="button" data-view="gathering">Go gathering →</button></div>'}</div>`;
  }
  function renderPeeling() {
    if (view !== 'peeling') return;
    const count = project.parts.reduce((n,p) => n + p.items.length,0);
    $('#peeling-view').innerHTML = `<div class="peeling-grid"><section class="peeling-card wide"><p class="eyebrow">An editable starting point</p><h2>Make room for the finishing touches.</h2><p>Export ${escapeHtml(project.title)} as SVG, then open it in Affinity. Images are embedded, passages stay as text, and each piece has its own group.</p><p class="source-note">${project.parts.length} ${project.parts.length === 1 ? "part" : "parts"} · ${count} placed ${count === 1 ? "piece" : "pieces"}. SVG is an interchange document; finish your typography and composition in Affinity.</p><div class="source-actions"><button class="button primary" data-action="export-svg" ${!count ? 'disabled' : ''}>Export project SVG ↗</button><button class="button quiet" data-view="preview">Preview</button><button class="button quiet" data-action="print-preview">Print / PDF</button></div></section>${project.parts.map(p => `<section class="peeling-card"><p class="eyebrow">A single part</p><h3>${escapeHtml(p.title)}</h3><p>${p.items.length} ${p.items.length === 1 ? 'piece' : 'pieces'} · ${(p.columns || 1) === 1 ? 'Stacked' : p.columns === 2 ? 'Pairs' : 'Triptych'}</p><button class="button" data-action="export-part" data-part-id="${p.id}" ${!p.items.length ? 'disabled' : ''}>Export part SVG ↗</button></section>`).join('')}<section class="peeling-card"><p class="eyebrow">Just the pieces</p><h3>Your selected pieces</h3><p>${bulkIds.size} ${bulkIds.size === 1 ? "piece" : "pieces"} selected in Nipping. Export them together to arrange in Affinity.</p><button class="button" data-export-selected ${!bulkIds.size ? 'disabled' : ''}>Export selection SVG ↗</button><button class="button quiet" data-view="library">Pick pieces →</button></section><section class="peeling-card"><p class="eyebrow">Keep the context</p><h3>Credits & descriptions</h3><p>Take linked citations and image descriptions with your composition.</p><div class="source-actions"><button class="button" data-view="sources">Sources & citations</button><button class="button quiet" data-action="download-alt" ${!count ? 'disabled' : ''}>Download descriptions</button></div></section></div>`;
    $('#export-svg').disabled = !count;
  }
  function activateWeave(id, rerender = true) {
    if (!workspace.drafts.some(d => d.id === id)) return;
    partFocus.set(project.id, activePartId);
    workspace.activeId = id;
    attachProject();
    if (rerender) { scheduleSave(); render(); }
    else {
      $('#project-title').value = project.title;
      $('#draft-picker').value = project.id;
      $('#draft-status').value = project.status;
      $('#draft-notes').value = project.notes || '';
      document.querySelectorAll('[data-weave-id]').forEach(el => {
        const on = el.dataset.weaveId === id;
        el.classList.toggle('active', on);
        const label = el.querySelector('.weave-desk-title > span');
        if (label) { label.className = on ? 'count-pill' : 'source-note'; label.textContent = on ? 'Active' : 'Click to work here'; }
      });
      document.querySelectorAll('[data-open-weave]').forEach(el => {
        el.setAttribute('aria-pressed', String(el.dataset.openWeave === id));
        el.parentElement.classList.toggle('active', el.dataset.openWeave === id);
      });
    }
  }
  function activateDesk(e) {
    const desk = e.target.closest('[data-weave-id]');
    if (desk && desk.dataset.weaveId !== project.id) {
      activateWeave(desk.dataset.weaveId, false);
      scheduleSave();
    }
  }
  document.addEventListener('pointerdown', activateDesk, true);
  document.addEventListener('focusin', activateDesk, true);
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-open-weave],[data-close-weave],[data-mark-piece],[data-tag-piece],[data-export-selected]');
    if (b?.dataset.openWeave) activateWeave(b.dataset.openWeave);
    if (b?.dataset.closeWeave) {
      openDraftIds = openDraftIds.filter(id => id !== b.dataset.closeWeave);
      if (!openDraftIds.length) openDraftIds.push(project.id);
      if (workspace.activeId === b.dataset.closeWeave) activateWeave(openDraftIds[0], false);
      render();
    }
    if (e.target.closest('#weave-split')) { splitWeaves = !splitWeaves; render(); }
    if (e.target.closest('#device-sync')) openSyncDialog();
    if (b?.dataset.markPiece) { view = 'marking'; selectedId = b.dataset.markPiece; render(); }
    if (b?.dataset.tagPiece) {
      const p = piece(b.dataset.tagPiece), input = {...p};
      b.disabled = true;
      try {
        const result = await captureProcessor.process(input, {transcribe:false, tag:true, location:captureSettings.location});
        const current = piece(input.id);
        if (!current || current.trashed || processingText(current) !== processingText(input)) return;
        checkpoint(); current.tags = M.tags([...current.tags, ...result.tags]);
        current.taggingStatus = 'done'; current.processingSource = result.source;
        scheduleSave(); renderPreservingFocus();
        toast(`Tags added from captured words on ${result.source === 'server' ? 'your server' : 'this device'}.`);
      } catch (error) { toast(error.message || 'Tagging needs another try.'); }
      finally { b.disabled = false; }
    }
    if (b?.hasAttribute('data-export-selected')) exportSvg([{id: uid(), title: 'Selected pieces', columns: 1, items: [...bulkIds].filter(id => piece(id) && !piece(id).trashed)}]);
  });
  document.addEventListener('keydown', e => {
    if (e.target.matches('.view-tab') && ['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
      e.preventDefault(); const tabs = [...document.querySelectorAll('.view-tab')];
      let index = tabs.indexOf(e.target);
      index = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      view = tabs[index].dataset.view; selectedId = null; render(); tabs[index].focus();
    }
    if (e.target.matches('.draft-card[role="button"]') && ['Enter',' '].includes(e.key)) {
      e.preventDefault(); selectedId = e.target.dataset.select; render();
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'marking-filter') { markingFilter = e.target.value; renderMarking(); }
    if (['auto-transcribe','auto-tag','capture-location'].includes(e.target.id)) {
      if (e.target.id === 'capture-location') captureSettings.location = e.target.value;
      else captureSettings[e.target.id === 'auto-tag' ? 'tag' : 'transcribe'] = e.target.checked;
      localStorage.setItem('nook-capture-settings', JSON.stringify(captureSettings));
      workspace.pieces.forEach(queueTranscription);
    }
    if (e.target.id === 'nip-filter') { libraryFilter = e.target.value; bulkIds.clear(); renderLibrary(); }
    if (e.target.id === 'nip-sort') { librarySort = e.target.value; renderLibrary(); }
    if (e.target.id === 'nip-target') { activePartId = e.target.value; partFocus.set(project.id, activePartId); }
    if (e.target.id === 'nip-project') { activateWeave(e.target.value); }
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'nip-search') {
      search = e.target.value.toLowerCase(); $('#piece-search').value = e.target.value;
      renderLibrary(); $('#nip-search')?.focus();
    }
    if (e.target.id === 'marking-search') {
      const query = e.target.value.toLowerCase();
      markingQuery = query;
      document.querySelectorAll('#marking-view [data-gather-row]').forEach(row => {
        const p = piece(row.dataset.gatherRow);
        row.hidden = ![p.title,p.creator,p.quote,p.ocrText,p.workTitle,p.url,...p.tags].join(' ').toLowerCase().includes(query);
      });
    }
  });
  function processingText(p) { return JSON.stringify([p.title,p.workTitle,p.quote,p.ocrText]); }
  function queueTranscription(p) {
    const needsWork = (captureSettings.transcribe && NookCapture.needsTranscription(p)) || (captureSettings.tag && NookCapture.needsTagging(p));
    if (!needsWork || captureQueue.includes(p.id) || captureStates.get(p.id) === "reading") return;
    captureQueue.push(p.id);
    captureStates.set(p.id, "queued");
    setTimeout(drainCaptureQueue, 0);
  }
  async function drainCaptureQueue() {
    if (captureProcessing) return;
    if (ocrBusy) { setTimeout(drainCaptureQueue, 1000); return; }
    captureProcessing = true;
    ocrBusy = true;
    while (captureQueue.length) {
      const p = piece(captureQueue.shift());
      if (!p || p.trashed) continue;
      const settings = {transcribe: captureSettings.transcribe && NookCapture.needsTranscription(p), tag:captureSettings.tag, location:captureSettings.location};
      if (!settings.transcribe && !(settings.tag && NookCapture.needsTagging(p))) continue;
      const input = {...p}, inputText = processingText(p);
      captureStates.set(p.id, 'reading');
      if (view === 'gathering') renderPreservingFocus();
      try {
        const result = await captureProcessor.process(input, settings);
        const current = piece(p.id);
        if (!current || current.trashed || current.imageData !== input.imageData || processingText(current) !== inputText) {
          captureStates.delete(p.id); if (current) queueTranscription(current); continue;
        }
        current.processingSource = result.source;
        if (settings.transcribe && captureSettings.transcribe) {
          current.ocrText = clean(result.ocrText); current.transcriptionStatus = 'done';
          if (!current.altText) current.altText = draftAlt(current);
        }
        if (settings.tag && captureSettings.tag) { current.tags = M.tags([...current.tags, ...result.tags]); current.taggingStatus = 'done'; }
        captureStates.set(p.id, 'done');
        scheduleSave();
      } catch (err) {
        console.error(err); captureStates.set(p.id, 'error');
        const current = piece(p.id);
        if (current) { if (settings.transcribe) current.transcriptionStatus = 'failed'; if (settings.tag) current.taggingStatus = 'failed'; scheduleSave(); }
        toast('Piece saved. Processing needs another try in Marking.');
      }
      if (view === 'gathering' || view === 'marking') renderPreservingFocus();
    }
    captureProcessing = false; ocrBusy = false;
    if (view === 'gathering' || view === 'marking') renderPreservingFocus();
  }
  function openInstallHelp() {
    let dialog = $('#install-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'install-dialog';
      dialog.innerHTML = '<div class="inspector-top"><h2>Keep Nook close</h2><button class="icon-button" data-close-install aria-label="Close installation help">×</button></div><p>Install Nook to open it like an app and keep gathering while offline.</p><p>On Android, open <strong>nook.vayne.garden</strong> in Chrome with Tailscale connected, then choose <strong>Install app</strong> or <strong>Add to Home screen</strong> in the browser menu. After installation, choose <strong>Nook</strong> in another app’s Share menu to gather text, links or images.</p><p>Your shares are saved on this device first. Pair this device in <strong>Devices & sync</strong> to join the shared collection. Tailscale is needed to install and sync; already saved work stays available offline.</p><p>On iPhone or iPad, use Safari’s Share menu → Add to Home Screen. Use copy and paste to gather there.</p><p id="install-state" class="source-note" role="status"></p><div class="dialog-actions"><button class="button quiet" data-retry-shares>Retry pending shares</button><button class="button primary" data-install-nook>Install Nook</button></div>';
      document.body.append(dialog);
      dialog.querySelector('[data-close-install]').onclick = () => dialog.close();
      dialog.querySelector('[data-retry-shares]').onclick = () => receiveShares(true);
      dialog.querySelector('[data-install-nook]').onclick = async () => {
        const prompt = installPrompt;
        if (!prompt) return;
        installPrompt = null;
        await prompt.prompt();
        const choice = await prompt.userChoice;
        $('#install-state').textContent = choice.outcome === 'accepted' ? 'Installation started. Nook will be available from your apps.' : 'You can install Nook later from the browser menu.';
        dialog.querySelector('[data-install-nook]').hidden = true;
        if (choice.outcome === 'accepted') navigator.storage?.persist?.().catch(() => {});
      };
    }
    const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    $('#install-state').textContent = installed ? 'You’re using the installed Nook app.' : installPrompt ? 'This browser is ready to install Nook.' : 'Use your browser’s install option. Android sharing appears after installation.';
    dialog.querySelector('[data-install-nook]').hidden = installed || !installPrompt;
    dialog.showModal();
  }
  document.addEventListener('click', e => { if (e.target.closest('[data-install-help]')) openInstallHelp(); });
  async function receiveShares(manual = false) {
    if (!collectionReady || receivingShares || conflict) return;
    if (clientSync?.busy) { setTimeout(() => receiveShares(manual), 1500); return; }
    receivingShares = true;
    try {
      const shares = (await NookShares.pending()).sort((a,b) => a.createdAt - b.createdAt);
      if (!shares.length && manual) toast('All shared pieces have been gathered.');
      for (const share of shares) {
        try {
        if (!(workspace.appliedShares || []).includes(share.id)) {
          // Decode the entire share before changing the collection, so a bad image
          // leaves the original inbox entry available to retry.
          const images = [];
          for (const file of share.files) images.push({ ...await imageToData(file.blob), name: file.name });
          checkpoint(); view = 'gathering'; selectedId = null;
          batchDepth++;
          try {
            const passage = NookShares.textPiece(share);
            if (passage) addPiece(passage.kind, { ...passage, id: 'share-' + share.id + '-text', createdAt: share.createdAt });
            images.forEach((image, i) => addPiece('image', { id: 'share-' + share.id + '-image-' + i, title: share.title || image.name.replace(/\.[^.]+$/, ''), imageData: image.data, width: image.width, height: image.height, workType: 'image', url: safeUrl(share.url), createdAt: share.createdAt }));
            workspace.appliedShares = [...(workspace.appliedShares || []), share.id];
          } finally { batchDepth--; }
          scheduleSave(); render();
        }
        // The receipt is committed with the pieces. A crash between this commit
        // and inbox deletion can be retried without making duplicate pieces.
        await save(false, true);
        await NookShares.remove(share.id);
        toast('Shared to Gathering. Saved on this device.');
        } catch (error) {
          console.error('Share is still in the local inbox:', error);
          toast(`Share kept in the local inbox: ${error.message || 'try again from Install & sharing'}`);
          // An unreadable image must not hold up later text shares. A collection
          // conflict needs a reload before any further local commit is attempted.
          if (conflict) break;
        }
      }
      if (new URL(location.href).searchParams.has('shared')) {
        const url = new URL(location.href); url.searchParams.delete('shared');
        window.history.replaceState(null, '', url);
      }
    } catch (error) {
      console.error('Share is still in the local inbox:', error);
      toast('Share kept in the local inbox. Open Install & sharing to retry.');
    } finally { receivingShares = false; }
  }
  window.addEventListener('focus', () => receiveShares());
  window.addEventListener('online', () => workspace.pieces.forEach(queueTranscription));
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('Offline cache unavailable:', e));
  }

  loadLocal();
})();
