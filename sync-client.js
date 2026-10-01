/* Each browser keeps its work and the last shared snapshot independently. */
(function (root) {
  "use strict";
  root.NookSyncClient = class {
    constructor(options) {
      this.options = options;
      this.state = null;
      this.busy = false;
      this.pending = false;
      this.timer = null;
      this.lastError = "";
    }
    async start() {
      const stored = await this.options.readState();
      this.state = stored || {clientId: root.NookModel.id(), base: null, baseRevision: 0, serverId: null};
      if (!stored) await this.options.writeState(this.state);
      root.addEventListener("online", () => this.sync());
      root.addEventListener("offline", () => this.status("offline"));
      document.addEventListener("visibilitychange", () => { if (!document.hidden) this.sync(); });
      this.interval = setInterval(() => {
        if (!document.hidden && !document.activeElement?.matches("input,textarea,[contenteditable]")) this.sync();
      }, 20000);
      await this.sync();
    }
    status(mode, details = {}) {
      this.mode = mode;
      this.options.onStatus({mode, state: this.state, error: this.lastError, ...details});
    }
    schedule() {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.sync(), 1500);
    }
    async request(url, init) {
      const response = await fetch(url, {...init, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(20000)});
      const body = await response.json();
      if (!response.ok) {
        const error = new Error(body.error || `Sync returned ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      return body;
    }
    async pair(secret) {
      if (!this.state) throw new Error("The local collection is still loading. Try connecting again shortly.");
      await this.request("/api/pair", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({secret, clientId: this.state.clientId})});
      this.lastError = "";
      await this.sync();
    }
    async sync() {
      clearTimeout(this.timer);
      if (this.busy) { this.pending = true; return; }
      if (!this.state) return;
      if (document.hidden) { this.pending = true; return; }
      if (navigator.onLine === false) { this.status("offline"); return; }
      this.busy = true;
      this.status("syncing");
      try {
        if (this.options.beforeSync && await this.options.beforeSync() === false) { this.status("pending"); return; }
        // Another tab shares IndexedDB, but has its own in-memory workspace.
        // It must load that matching workspace before using a newer baseline.
        const stored = await this.options.readState();
        if (stored && (stored.clientId !== this.state.clientId || stored.baseRevision !== this.state.baseRevision || stored.serverId !== this.state.serverId || !root.NookSyncModel.equal(stored.base, this.state.base))) {
          const error = new Error("Another Nook tab saved a newer shared copy. Reload this tab before syncing its local work.");
          error.status = 409;
          throw error;
        }
        const server = await this.request("/api/collection/status");
        this.server = server;
        if (!server.paired) { this.status("pair"); return; }
        if (this.state.serverId && this.state.serverId !== server.serverId) {
          const error = new Error("This is a different Nook server. Back up your local copy before connecting it.");
          error.status = 409;
          throw error;
        }
        if (this.state.baseRevision > server.revision) {
          const error = new Error("The server is older than your saved shared copy. Back up your local collection before reconnecting.");
          error.status = 409;
          throw error;
        }
        const sent = structuredClone(this.options.snapshot());
        const unchanged = this.state.base && this.sameSharedCopy(sent, this.state.base);
        if (unchanged && server.revision === this.state.baseRevision) {
          this.lastError = "";
          this.status(this.options.isDirty() ? "pending" : "synced", {conflicts: this.state.conflicts || []});
          return;
        }
        // A completely new client adopts the server copy. Existing local work
        // enters the same merge protocol even on its first connection.
        if (server.initialized && (unchanged || (!this.state.base && !this.options.hasLocalWork()))) {
          const result = await this.request("/api/collection");
          await this.apply(result, sent);
        } else {
          const result = await this.request("/api/sync", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({clientId: this.state.clientId, serverId: this.state.serverId, baseRevision: this.state.baseRevision, base: this.state.base, workspace: sent}),
          });
          await this.apply(result, sent);
        }
        this.lastError = "";
        this.status(this.options.isDirty() || !this.sameSharedCopy(this.options.snapshot(), this.state.base) ? "pending" : "synced", {conflicts: this.state.conflicts || []});
      } catch (error) {
        this.lastError = error.message;
        this.status(error.status === 401 ? "pair" : error.status ? "error" : "offline");
      } finally {
        this.busy = false;
        if (this.pending) { this.pending = false; this.schedule(); }
      }
    }
    sameSharedCopy(left, right) {
      return root.NookSyncModel.equal({...left, activeId: ""}, {...right, activeId: ""});
    }
    async apply(result, sent) {
      if (!result.workspace || !Number.isSafeInteger(result.revision) || result.revision < 1 || (result.serverId && result.serverId !== this.server.serverId)) throw new Error("The server returned an invalid collection. Your local copy was kept.");
      const current = this.options.snapshot();
      const changed = !root.NookSyncModel.equal(sent, current);
      const merged = changed ? root.NookSyncModel.merge(sent, current, result.workspace) : {workspace: result.workspace, conflicts: []};
      const conflicts = [...(result.conflicts || []), ...(merged.conflicts || [])].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index);
      const nextState = {...this.state, base: structuredClone(result.workspace), baseRevision: result.revision,
        serverId: result.serverId || this.server.serverId, lastSyncedAt: Date.now(),
        conflicts: conflicts.length ? conflicts : this.state.conflicts || []};
      // Save the accepted baseline with the working copy in one transaction.
      // A partial write must never make unsaved work appear synchronized.
      try { await this.options.apply(merged.workspace, nextState); }
      catch (error) { error.status = error.status || 507; throw error; }
      // Publish the new baseline only after the local atomic write succeeds.
      this.state = nextState;
      if (changed) this.pending = true;
    }
  };
})(window);
