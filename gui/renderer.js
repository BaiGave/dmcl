"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res, err) => function __init() {
    if (err) throw err[0];
    try {
      return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
    } catch (e) {
      throw err = [e], e;
    }
  };
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // gui/renderer-src/state.ts
  var state, pathRefreshTimer;
  var init_state = __esm({
    "gui/renderer-src/state.ts"() {
      "use strict";
      state = {
        mods: [],
        currentModId: null,
        filter: "all",
        loaderFilter: "all",
        matrixFilter: "all",
        search: "",
        selectedLoader: "",
        selectedMc: "",
        selectedMappings: "",
        modidTouched: false,
        groupTouched: false,
        generationCancelled: false,
        activeAbort: null,
        batchAbortControllers: null,
        nameComposing: false,
        dirTouched: false,
        projectsRoot: "",
        versionsCache: {},
        versionsLoading: {},
        detailCache: {},
        detailRequestId: 0,
        modsFetchedAt: 0,
        buildBatch: null
      };
      pathRefreshTimer = null;
    }
  });

  // gui/renderer-src/constants.ts
  var LOADERS, LOADER_LABELS, STATUS_LABELS;
  var init_constants = __esm({
    "gui/renderer-src/constants.ts"() {
      "use strict";
      LOADERS = [
        { id: "fabric", label: "Fabric", icon: "Fa", hint: "\u8F7B\u91CF\u3001\u66F4\u65B0\u5FEB" },
        { id: "neoforge", label: "NeoForge", icon: "NF", hint: "\u73B0\u4EE3\u5206\u652F" },
        { id: "forge", label: "Forge", icon: "Fo", hint: "\u7ECF\u5178\u751F\u6001" }
      ];
      LOADER_LABELS = {
        fabric: "Fabric",
        forge: "Forge",
        neoforge: "NeoForge"
      };
      STATUS_LABELS = {
        active: "\u5F00\u53D1\u4E2D",
        paused: "\u6682\u505C",
        released: "\u5DF2\u53D1\u5E03"
      };
    }
  });

  // gui/renderer-src/icons.ts
  function icon(name) {
    return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
  }
  function hydrateIcons(root = document) {
    root.querySelectorAll("[data-icon]").forEach((el) => {
      const name = el.dataset.icon;
      if (paths[name]) el.innerHTML = icon(name);
    });
  }
  var paths;
  var init_icons = __esm({
    "gui/renderer-src/icons.ts"() {
      "use strict";
      paths = {
        workbench: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        folder: '<path d="M3 7.5h7l2-2h9v13H3Z"/>',
        external: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2.2-.7-.5-1.2 1.1-2-2.1-2.1-2 1.1-1.2-.5L10.5 3h-3l-.7 2.2-1.2.5-2-1.1-2.1 2.1 1.1 2-.5 1.2L0 10.5v3l2.2.7.5 1.2-1.1 2 2.1 2.1 2-1.1 1.2.5.7 2.1h3l.7-2.2 1.2-.5 2 1.1 2.1-2.1-1.1-2 .5-1.2Z" transform="translate(1) scale(.92)"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>',
        filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
        more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
        refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
        scan: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 12h10"/>',
        import: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 19h14"/>',
        export: '<path d="M12 17V5m0 0 4 4m-4-4L8 9"/><path d="M5 19h14"/>',
        trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
        unlink: '<path d="m9 15-2 2a3 3 0 0 1-4-4l3-3a3 3 0 0 1 4-.2M15 9l2-2a3 3 0 0 1 4 4l-3 3a3 3 0 0 1-4 .2M8 3l8 18"/>',
        build: '<path d="M14.7 6.3a4 4 0 0 0-5-5L7.5 3.5l3 3 2.2-2.2a4 4 0 0 0 2 2Z"/><path d="m4 20 7.5-7.5M2.5 16.5l5 5"/>',
        play: '<path d="m8 5 11 7-11 7Z"/>',
        terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 16h4"/>',
        copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
        "chevron-left": '<path d="m15 18-6-6 6-6"/>',
        "chevron-down": '<path d="m6 9 6 6 6-6"/>',
        check: '<path d="m5 12 4 4L19 6"/>',
        warning: '<path d="M12 3 2.5 20h19Z"/><path d="M12 9v4M12 17h.01"/>',
        error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        loader: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
        close: '<path d="m6 6 12 12M18 6 6 18"/>',
        sparkles: '<path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2ZM18.5 14l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7ZM5 14l.6 1.8 1.9.7-1.9.6L5 19l-.6-1.9-1.9-.6 1.9-.7Z"/>'
      };
    }
  });

  // gui/renderer-src/dom.ts
  function $(id) {
    return document.getElementById(id);
  }
  function showError(msg) {
    const box = $("error-box");
    const txt = $("error-text");
    if (txt) txt.textContent = msg;
    if (box) box.style.display = "block";
  }
  function hideError() {
    const box = $("error-box");
    if (box) box.style.display = "none";
  }
  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value;
  }
  function notify(message, kind = "info") {
    const stack = $("toast-stack");
    if (!stack) {
      console.log("[dmcl]", message);
      return;
    }
    const toast = document.createElement("div");
    toast.className = `toast toast-${kind}`;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    toast.innerHTML = icon(kind === "success" ? "check" : kind) + "<span></span>";
    const text = toast.querySelector("span");
    if (text) text.textContent = message;
    stack.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-4px)";
      toast.style.transition = "opacity 0.18s ease, transform 0.18s ease";
      setTimeout(() => toast.remove(), 200);
    }, 3200);
  }
  function showView(name) {
    document.body.dataset.view = name;
    document.querySelectorAll(".view").forEach((v) => {
      v.classList.toggle("active", v.id === `view-${name}`);
    });
    document.querySelectorAll(".nav-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === name);
    });
  }
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function showModal(title, content) {
    const titleEl = $("modal-title");
    const log = $("modal-log");
    const overlay = $("modal-overlay");
    if (titleEl) titleEl.textContent = title;
    if (log) {
      log.innerHTML = "";
      content.split("\n").forEach((line) => {
        const div = document.createElement("div");
        div.textContent = line;
        log.appendChild(div);
      });
    }
    logModalReturnFocus = document.activeElement;
    overlay?.classList.add("visible");
    const modal = overlay?.querySelector(".modal");
    requestAnimationFrame(() => modal?.focus());
  }
  function closeModal() {
    $("modal-overlay")?.classList.remove("visible");
    logModalReturnFocus?.focus();
    logModalReturnFocus = null;
  }
  function confirmAction(options) {
    const overlay = $("confirm-modal");
    const title = $("confirm-title");
    const message = $("confirm-message");
    const detail = $("confirm-detail");
    const confirm = $("confirm-accept");
    const cancel = $("confirm-cancel");
    if (!overlay || !title || !message || !detail || !confirm || !cancel) {
      return Promise.resolve(false);
    }
    confirmReturnFocus = document.activeElement;
    title.textContent = options.title;
    message.textContent = options.message;
    detail.textContent = options.detail || "";
    detail.hidden = !options.detail;
    confirm.textContent = options.confirmLabel || (options.danger ? "\u786E\u8BA4\u5220\u9664" : "\u786E\u8BA4");
    confirm.className = `btn ${options.danger ? "btn-danger" : "btn-primary"}`;
    overlay.classList.add("visible");
    return new Promise((resolve) => {
      const finish = (value) => {
        overlay.classList.remove("visible");
        confirm.onclick = null;
        cancel.onclick = null;
        overlay.onclick = null;
        document.removeEventListener("keydown", onKeydown, true);
        confirmReturnFocus?.focus();
        resolve(value);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      };
      confirm.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
      overlay.onclick = (event) => {
        if (event.target === overlay) finish(false);
      };
      document.addEventListener("keydown", onKeydown, true);
      requestAnimationFrame(() => cancel.focus());
    });
  }
  var logModalReturnFocus, confirmReturnFocus;
  var init_dom = __esm({
    "gui/renderer-src/dom.ts"() {
      "use strict";
      init_icons();
      logModalReturnFocus = null;
      confirmReturnFocus = null;
    }
  });

  // gui/renderer-src/api.ts
  function api(path, opts = {}) {
    return fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : void 0,
      body: opts.body ? JSON.stringify(opts.body) : void 0,
      signal: opts.signal
    }).then((r) => {
      if (opts.expectText) {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r;
      }
      return r.json().then((data) => {
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        return data;
      });
    });
  }
  var init_api = __esm({
    "gui/renderer-src/api.ts"() {
      "use strict";
    }
  });

  // gui/renderer-src/boot.ts
  function bootWorkbench() {
    hydrateIcons();
    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduceMotion && !sessionStorage.getItem("dmcl:intro-played")) {
      sessionStorage.setItem("dmcl:intro-played", "1");
      requestAnimationFrame(function() {
        document.body.classList.remove("intro-pending");
        document.body.classList.add("intro-running");
        setTimeout(function() {
          document.body.classList.remove("intro-running");
        }, 700);
      });
    } else {
      document.body.classList.remove("intro-pending");
    }
    function renderWorkbenchStats() {
      var totalVariants = 0;
      var builtVariants = 0;
      var failedVariants = 0;
      var runningVariants = 0;
      var loaders = {};
      state.mods.forEach(function(mod) {
        (mod.variants || []).forEach(function(variant) {
          totalVariants++;
          if (variant.buildStatus === "success") builtVariants++;
          if (variant.buildStatus === "failed") failedVariants++;
          if (variant.buildStatus === "building") runningVariants++;
          loaders[variant.loader] = true;
        });
      });
      var loaderNames = Object.keys(loaders).map(function(id) {
        return LOADER_LABELS[id] || id;
      });
      setText("stat-mods", String(state.mods.length));
      setText("stat-variants", String(totalVariants));
      setText("stat-build-health", builtVariants + "/" + totalVariants);
      var healthEl = $("stat-build-health");
      if (healthEl) {
        healthEl.className = "value " + (failedVariants ? "has-failures" : runningVariants ? "is-running" : "is-healthy");
        healthEl.title = builtVariants + " \u4E2A\u5C31\u7EEA \xB7 " + failedVariants + " \u4E2A\u5931\u8D25 \xB7 " + runningVariants + " \u4E2A\u8FDB\u884C\u4E2D";
      }
      setText("stat-loaders", loaderNames.length ? loaderNames.join(" / ") : "-");
      setText("sidebar-status", state.mods.length ? state.mods.length + " \u4E2A\u6A21\u7EC4\u5C31\u7EEA" : "\u5DE5\u4F5C\u53F0\u5C31\u7EEA");
    }
    async function loadMods() {
      try {
        var data = await api("/api/mods");
        state.mods = data.mods || [];
        state.modsFetchedAt = Date.now();
        state.mods.forEach(function(m) {
          var cached = state.detailCache[m.id];
          if (!cached) return;
          var oldSig = (cached.mod.variants || []).map(function(v) {
            return v.id;
          }).sort().join(",");
          var newSig = (m.variants || []).map(function(v) {
            return v.id;
          }).sort().join(",");
          if (oldSig !== newSig) {
            delete state.detailCache[m.id];
            return;
          }
          cached.mod = m;
        });
        renderWorkbenchStats();
        renderModList();
      } catch (e) {
        showError("\u52A0\u8F7D\u6A21\u7EC4\u5217\u8868\u5931\u8D25\uFF1A" + e.message);
      }
    }
    function variantSummary(mod) {
      return mod.variants.map(function(v) {
        return LOADER_LABELS[v.loader] + " " + v.mcVersion;
      }).join(" \xB7 ");
    }
    function buildHealth(mod) {
      var total = mod.variants.length;
      if (total === 0) return "\u65E0\u53D8\u4F53";
      var ok = mod.variants.filter(function(v) {
        return v.buildStatus === "success";
      }).length;
      return ok + "/" + total + " \u53D8\u4F53\u5DF2\u6784\u5EFA";
    }
    function buildHealthData(mod) {
      var variants = mod.variants || [];
      var total = variants.length;
      var ready = variants.filter(function(v) {
        return v.buildStatus === "success";
      }).length;
      var failed = variants.filter(function(v) {
        return v.buildStatus === "failed";
      }).length;
      var running = variants.filter(function(v) {
        return v.buildStatus === "building";
      }).length;
      return { total, ready, failed, running, percent: total ? Math.round(ready / total * 100) : 0 };
    }
    function modInitials(name) {
      var words = String(name || "DM").trim().split(/\s+/).filter(Boolean);
      return (words.length ? words.slice(0, 2).map(function(word) {
        return word.slice(0, 1);
      }).join("") : "DM").toUpperCase();
    }
    function lastBuilt(mod) {
      var times = mod.variants.filter(function(v) {
        return v.lastBuiltAt;
      }).map(function(v) {
        return new Date(v.lastBuiltAt).getTime();
      });
      if (!times.length) return "\u4ECE\u672A\u6784\u5EFA";
      var latest = Math.max.apply(null, times);
      var diff = Date.now() - latest;
      if (diff < 36e5) return "\u4E0A\u6B21\u6784\u5EFA " + Math.round(diff / 6e4) + " \u5206\u949F\u524D";
      if (diff < 864e5) return "\u4E0A\u6B21\u6784\u5EFA " + Math.round(diff / 36e5) + " \u5C0F\u65F6\u524D";
      return "\u4E0A\u6B21\u6784\u5EFA " + Math.round(diff / 864e5) + " \u5929\u524D";
    }
    function renderModList() {
      var grid = $("mod-grid");
      var empty = $("empty-state");
      if (!grid) return;
      var filtered = state.mods.filter(function(m) {
        if (state.filter !== "all" && m.status !== state.filter) return false;
        if (state.loaderFilter !== "all" && !(m.variants || []).some(function(v) {
          return v.loader === state.loaderFilter;
        })) return false;
        if (state.search) {
          var q = state.search.toLowerCase();
          return m.displayName.toLowerCase().indexOf(q) >= 0 || m.modId.indexOf(q) >= 0;
        }
        return true;
      });
      grid.innerHTML = "";
      if (!filtered.length) {
        empty.style.display = "block";
        var title = $("empty-title");
        var description = $("empty-description");
        var primary = $("empty-primary");
        var secondary = $("empty-secondary");
        if (!state.mods.length) {
          if (title) title.textContent = "\u5F00\u59CB\u4F60\u7684\u7B2C\u4E00\u4E2A\u6A21\u7EC4";
          if (description) description.textContent = "\u4ECE\u6A21\u677F\u521B\u5EFA\u65B0\u9879\u76EE\uFF0C\u6216\u5BFC\u5165\u5DF2\u6709 Gradle \u6A21\u7EC4\u3002";
          if (primary) {
            primary.textContent = "\u65B0\u5EFA\u6A21\u7EC4";
            primary.dataset.emptyAction = "create";
            primary.hidden = false;
          }
          if (secondary) {
            secondary.textContent = "\u5BFC\u5165\u9879\u76EE";
            secondary.dataset.emptyAction = "import";
            secondary.hidden = false;
          }
        } else if (state.search) {
          if (title) title.textContent = "\u6CA1\u6709\u5339\u914D\u7684\u6A21\u7EC4";
          if (description) description.textContent = "\u6362\u4E2A\u5173\u952E\u8BCD\uFF0C\u6216\u6E05\u7A7A\u641C\u7D22\u540E\u67E5\u770B\u5168\u90E8\u6A21\u7EC4\u3002";
          if (primary) {
            primary.textContent = "\u6E05\u7A7A\u641C\u7D22";
            primary.dataset.emptyAction = "clear-search";
            primary.hidden = false;
          }
          if (secondary) secondary.hidden = true;
        } else {
          if (title) title.textContent = "\u5F53\u524D\u7B5B\u9009\u6CA1\u6709\u7ED3\u679C";
          if (description) description.textContent = "\u91CD\u7F6E\u72B6\u6001\u548C\u52A0\u8F7D\u5668\u7B5B\u9009\u540E\u518D\u8BD5\u3002";
          if (primary) {
            primary.textContent = "\u91CD\u7F6E\u7B5B\u9009";
            primary.dataset.emptyAction = "reset-filters";
            primary.hidden = false;
          }
          if (secondary) secondary.hidden = true;
        }
        return;
      }
      empty.style.display = "none";
      filtered.forEach(function(mod) {
        var card = document.createElement("article");
        card.className = "mod-card" + (state.currentModId === mod.id ? " selected" : "");
        var health = buildHealthData(mod);
        var variants = (mod.variants || []).slice(0, 3).map(function(v) {
          return '<span class="variant-chip"><i class="loader-mark loader-' + esc(v.loader) + '">' + esc((LOADER_LABELS[v.loader] || v.loader).slice(0, 1)) + "</i>" + esc(LOADER_LABELS[v.loader] + " " + v.mcVersion) + "</span>";
        }).join("");
        var remaining = Math.max(0, (mod.variants || []).length - 3);
        card.innerHTML = '<button type="button" class="mod-card-main" aria-label="\u6253\u5F00\u6A21\u7EC4 ' + esc(mod.displayName) + "\uFF0C" + buildHealth(mod) + '"><span class="mod-avatar">' + esc(modInitials(mod.displayName)) + '</span><span class="mod-card-content"><span class="mod-title-row"><strong>' + esc(mod.displayName) + '</strong><span class="badge badge-' + mod.status + '">' + STATUS_LABELS[mod.status] + '</span></span><span class="variant-chips">' + (variants || '<span class="variant-chip muted">\u6682\u65E0\u53D8\u4F53</span>') + (remaining ? '<span class="variant-chip more">+' + remaining + "</span>" : "") + '</span><span class="health-row"><span class="health-track"><i data-health="' + health.percent + '"></i></span><span>' + health.ready + "/" + health.total + " \u5C31\u7EEA" + (health.failed ? " \xB7 " + health.failed + " \u5931\u8D25" : "") + (health.running ? " \xB7 " + health.running + " \u6784\u5EFA\u4E2D" : "") + '</span></span><span class="last-built">' + icon("clock") + lastBuilt(mod) + '</span></span><span class="card-chevron">' + icon("chevron-left") + "</span></button>";
        var healthBar = card.querySelector("[data-health]");
        if (healthBar) healthBar.style.width = health.percent + "%";
        card.querySelector(".mod-card-main")?.addEventListener("click", function() {
          openDetail(mod.id);
        });
        grid.appendChild(card);
      });
    }
    var DETAIL_CACHE_TTL_MS = 5 * 60 * 1e3;
    function invalidateDetailCache(modId) {
      if (modId) delete state.detailCache[modId];
      else state.detailCache = {};
    }
    async function afterVariantRegistryChange(modId, result) {
      invalidateDetailCache(modId);
      if (result && result.mod) {
        var idx = state.mods.findIndex(function(m) {
          return m.id === modId;
        });
        if (idx >= 0) state.mods[idx] = result.mod;
      }
      await loadMods();
      if (state.currentModId === modId) {
        var still = state.mods.find(function(m) {
          return m.id === modId;
        });
        if (still) await refreshDetail({ force: true });
        else {
          state.currentModId = null;
          showView("list");
        }
      }
    }
    function isDetailStale(entry) {
      return !entry || Date.now() - entry.fetchedAt > DETAIL_CACHE_TTL_MS;
    }
    function setMatrixLoadingMeta(loading, label) {
      var shell = $("matrix-shell");
      if (shell) shell.classList.toggle("is-loading", !!loading);
      var countEl = $("matrix-version-count");
      if (!countEl) return;
      if (loading) {
        countEl.innerHTML = '<span class="matrix-loading-pill"><span class="spinner spinner-xs" aria-hidden="true"></span>' + esc(label || "\u52A0\u8F7D\u4E2D\u2026") + "</span>";
      }
    }
    function setMatrixRefreshing(refreshing) {
      var shell = $("matrix-shell");
      var overlay = $("matrix-refresh-overlay");
      if (shell) shell.classList.toggle("is-refreshing", !!refreshing);
      if (overlay) {
        overlay.hidden = !refreshing;
        overlay.setAttribute("aria-hidden", refreshing ? "false" : "true");
      }
    }
    function renderMatrixLoading(title, subtitle) {
      title = title || "\u52A0\u8F7D\u7248\u672C\u77E9\u9635\u2026";
      subtitle = subtitle || "\u6B63\u5728\u8BFB\u53D6\u652F\u6301\u7684 Minecraft \u7248\u672C\u4E0E loader \u7EC4\u5408";
      var wrap = $("matrix-wrap");
      if (!wrap) return;
      wrap.setAttribute("aria-busy", "true");
      wrap.innerHTML = '<div class="matrix-loading" role="status" aria-live="polite"><div class="matrix-loading-head"><span class="spinner" aria-hidden="true"></span><div class="matrix-loading-copy"><strong>' + esc(title) + "</strong><span>" + esc(subtitle) + '</span></div></div><div class="matrix-loading-progress" aria-hidden="true"><span></span></div>' + buildMatrixSkeletonHtml() + "</div>";
      setMatrixLoadingMeta(true, "\u52A0\u8F7D\u4E2D\u2026");
    }
    function buildMatrixSkeletonHtml() {
      var versionCols = 8;
      var loaderRows = 4;
      var head = '<tr><th class="row-head"><span class="matrix-skeleton-block"></span></th>';
      for (var c = 0; c < versionCols; c++) {
        head += '<th><span class="matrix-skeleton-block"></span></th>';
      }
      head += "</tr>";
      var body = "";
      for (var r = 0; r < loaderRows; r++) {
        body += '<tr><th class="row-head"><span class="matrix-skeleton-block"></span></th>';
        for (var cc = 0; cc < versionCols; cc++) {
          body += '<td><span class="matrix-skeleton-block"></span></td>';
        }
        body += "</tr>";
      }
      return '<div class="matrix-skeleton" aria-hidden="true"><table><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>";
    }
    function clearMatrixLoadingMeta() {
      var wrap = $("matrix-wrap");
      if (wrap) wrap.removeAttribute("aria-busy");
      setMatrixLoadingMeta(false);
      setMatrixRefreshing(false);
    }
    function renderDetailContent(mod, matrix) {
      $("detail-name").textContent = mod.displayName;
      $("detail-meta").innerHTML = "<span>modId: " + esc(mod.modId) + "</span><span>\u72B6\u6001: " + STATUS_LABELS[mod.status] + "</span><span>\u53D8\u4F53: " + mod.variants.length + "</span>";
      renderMatrix(mod, matrix);
      renderVariantList(mod);
      updateBuildAllButton(mod);
    }
    function countBuildableVariants(mod, opts) {
      opts = opts || {};
      var count = 0;
      (mod.variants || []).forEach(function(v) {
        if (opts.loader && v.loader !== opts.loader) return;
        if (opts.failedOnly && v.buildStatus !== "failed") return;
        count++;
      });
      return count;
    }
    function updateBuildAllButton(mod) {
      var btn = $("btn-build-all");
      if (!btn) return;
      if (!mod || !mod.variants || !mod.variants.length) {
        btn.disabled = true;
        btn.title = "\u6682\u65E0\u53D8\u4F53\u53EF\u6784\u5EFA";
        return;
      }
      var buildable = countBuildableVariants(mod, {});
      btn.disabled = buildable === 0;
      btn.title = buildable ? "\u5C06 " + buildable + " \u4E2A\u53D8\u4F53\u4F9D\u6B21\u52A0\u5165\u6784\u5EFA\u961F\u5217" : "\u6682\u65E0\u53D8\u4F53\u53EF\u6784\u5EFA";
    }
    function showDetailPlaceholder(modId) {
      var fromList = state.mods.find(function(m) {
        return m.id === modId;
      });
      $("detail-name").textContent = fromList ? fromList.displayName : "\u52A0\u8F7D\u4E2D\u2026";
      $("detail-meta").innerHTML = fromList ? "<span>modId: " + esc(fromList.modId) + "</span><span>\u52A0\u8F7D\u8BE6\u60C5\u2026</span>" : "<span>\u52A0\u8F7D\u4E2D\u2026</span>";
      renderMatrixLoading("\u52A0\u8F7D\u7248\u672C\u77E9\u9635\u2026", "\u6B63\u5728\u8BFB\u53D6\u6A21\u7EC4\u8BE6\u60C5\u4E0E\u652F\u6301\u8303\u56F4");
      $("variant-list").innerHTML = '<p class="muted-placeholder inline-empty">\u52A0\u8F7D\u53D8\u4F53\u5217\u8868\u2026</p>';
    }
    async function openDetail(modId) {
      state.currentModId = modId;
      showView("detail");
      var cached = state.detailCache[modId];
      if (cached && !isDetailStale(cached)) {
        renderDetailContent(cached.mod, cached.matrix);
      } else if (cached) {
        renderDetailContent(cached.mod, cached.matrix);
      } else {
        showDetailPlaceholder(modId);
      }
      await refreshDetail({ force: !cached || isDetailStale(cached) });
    }
    async function refreshDetail(opts) {
      opts = opts || {};
      var modId = state.currentModId;
      if (!modId) return;
      var requestId = ++state.detailRequestId;
      var cached = state.detailCache[modId];
      var showMatrixRefresh = opts.force && requestId === state.detailRequestId && modId === state.currentModId;
      if (!opts.force && cached && !isDetailStale(cached)) {
        if (requestId === state.detailRequestId && modId === state.currentModId) {
          renderDetailContent(cached.mod, cached.matrix);
        }
        return;
      }
      if (showMatrixRefresh) {
        if (cached && cached.matrix) {
          setMatrixRefreshing(true);
          setMatrixLoadingMeta(true, "\u5237\u65B0\u4E2D\u2026");
        } else {
          renderMatrixLoading("\u52A0\u8F7D\u7248\u672C\u77E9\u9635\u2026", "\u6B63\u5728\u67E5\u8BE2 loader \u4E0E Minecraft \u7248\u672C\u7EC4\u5408");
        }
      }
      try {
        var modData = await api("/api/mods/" + modId);
        if (requestId !== state.detailRequestId || modId !== state.currentModId) return;
        if (showMatrixRefresh && !cached) {
          renderMatrixLoading("\u52A0\u8F7D\u7248\u672C\u77E9\u9635\u2026", "\u6B63\u5728\u8BA1\u7B97 " + modData.mod.modId + " \u7684\u652F\u6301\u77E9\u9635");
        }
        var matrixData = await api("/api/mods/" + modId + "/matrix");
        if (requestId !== state.detailRequestId || modId !== state.currentModId) return;
        state.detailCache[modId] = {
          mod: modData.mod,
          matrix: matrixData,
          fetchedAt: Date.now()
        };
        var idx = state.mods.findIndex(function(m) {
          return m.id === modId;
        });
        if (idx >= 0) state.mods[idx] = modData.mod;
        clearMatrixLoadingMeta();
        renderDetailContent(modData.mod, matrixData);
      } catch (e) {
        if (requestId !== state.detailRequestId) return;
        clearMatrixLoadingMeta();
        showError("\u52A0\u8F7D\u8BE6\u60C5\u5931\u8D25\uFF1A" + e.message);
      }
    }
    function cellLabel(status) {
      if (status === "built") return "\u5DF2\u6784\u5EFA";
      if (status === "failed") return "\u5931\u8D25";
      if (status === "building") return "\u6784\u5EFA\u4E2D";
      if (status === "exists") return "\u5DF2\u5B58\u5728";
      if (status === "verified") return "\u5DF2\u9A8C\u8BC1";
      if (status === "verification-failed") return "\u9A8C\u8BC1\u5931\u8D25";
      if (status === "available") return "\u53EF\u521B\u5EFA";
      return "\u4E0D\u652F\u6301";
    }
    function renderMatrix(mod, matrix) {
      var wrap = $("matrix-wrap");
      var table = document.createElement("table");
      table.className = "matrix";
      var thead = document.createElement("thead");
      var hr = document.createElement("tr");
      hr.innerHTML = '<th class="row-head">\u52A0\u8F7D\u5668</th>';
      matrix.versions.forEach(function(v) {
        var th = document.createElement("th");
        th.textContent = v;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement("tbody");
      matrix.loaders.forEach(function(ldr) {
        var tr = document.createElement("tr");
        var th = document.createElement("th");
        th.className = "row-head";
        th.textContent = ldr.label;
        tr.appendChild(th);
        matrix.versions.forEach(function(ver) {
          var cell = matrix.cells.find(function(c) {
            return c.loader === ldr.id && c.mcVersion === ver;
          });
          var td = document.createElement("td");
          var status = cell ? cell.status : "unsupported";
          td.className = "cell-" + status;
          var matrixMatches = state.matrixFilter === "all" || state.matrixFilter === "available" && (status === "available" || status === "verified" || status === "verification-failed") || state.matrixFilter === "failed" && (status === "failed" || status === "verification-failed") || state.matrixFilter === "existing" && (status === "built" || status === "exists" || status === "building");
          if (!matrixMatches) td.classList.add("matrix-muted");
          var actionButton = document.createElement("button");
          actionButton.type = "button";
          actionButton.className = "matrix-cell";
          actionButton.innerHTML = '<span class="matrix-dot" aria-hidden="true"></span><span>' + cellLabel(status) + "</span>";
          actionButton.setAttribute("aria-label", ldr.label + " " + ver + "\uFF0C" + cellLabel(status));
          actionButton.disabled = status === "unsupported" || status === "building";
          td.title = ldr.label + " " + ver + " \u2014 " + cellLabel(status);
          if (cell && cell.verification && cell.verification.updatedAt) {
            td.title += " / verified: " + cell.verification.state + " @ " + cell.verification.updatedAt;
          }
          if (cell && cell.verification && cell.verification.failureSummary) {
            td.title += " / " + cell.verification.failureSummary;
          }
          if (status === "built" || status === "failed" || status === "exists") {
            actionButton.addEventListener("click", function() {
              scrollToVariant(cell.variantId);
            });
          } else if (status === "available" || status === "verified" || status === "verification-failed") {
            actionButton.addEventListener("click", function() {
              generateVariantFromMatrix(mod, ldr.id, ver);
            });
          }
          td.appendChild(actionButton);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.innerHTML = "";
      wrap.appendChild(table);
      var countEl = $("matrix-version-count");
      if (countEl) {
        countEl.textContent = matrix.versions.length + " \u4E2A\u7248\u672C \xB7 \u53EF\u6A2A\u5411\u6EDA\u52A8";
      }
      function updateMatrixFades() {
        var shell = wrap.closest(".matrix-shell");
        if (!shell) return;
        shell.classList.toggle("can-scroll-left", wrap.scrollLeft > 4);
        shell.classList.toggle("can-scroll-right", wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 4);
      }
      wrap.onscroll = updateMatrixFades;
      requestAnimationFrame(updateMatrixFades);
    }
    function scrollToVariant(variantId) {
      var el = document.querySelector('[data-variant-id="' + variantId + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    function pickSourceVariant(mod) {
      if (!mod.variants.length) return null;
      return mod.variants[0];
    }
    async function generateVariantFromMatrix(mod, loader, mc) {
      var source = pickSourceVariant(mod);
      if (!source) {
        showError("\u8BF7\u5148\u6709\u81F3\u5C11\u4E00\u4E2A\u53D8\u4F53\u4F5C\u4E3A\u6E90\u7801\u6765\u6E90");
        return;
      }
      if (!await confirmAction({
        title: "\u521B\u5EFA\u65B0\u53D8\u4F53",
        message: "\u590D\u5236\u73B0\u6709\u6E90\u7801\u5E76\u751F\u6210\u65B0\u7684\u52A0\u8F7D\u5668\u53D8\u4F53\uFF1F",
        detail: LOADER_LABELS[source.loader] + " " + source.mcVersion + "  \u2192  " + LOADER_LABELS[loader] + " " + mc + "\n\u521B\u5EFA\u540E\u5C06\u81EA\u52A8\u52A0\u5165\u6784\u5EFA\u961F\u5217\u3002",
        confirmLabel: "\u521B\u5EFA\u5E76\u6784\u5EFA"
      })) {
        return;
      }
      hideError();
      showModal("\u751F\u6210\u53D8\u4F53", "\u6B63\u5728\u751F\u6210\u2026");
      try {
        var resp = await fetch("/api/mods/" + mod.id + "/variants", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceVariantId: source.id,
            targetLoader: loader,
            targetMc: mc,
            autoBuild: true
          })
        });
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        var log = $("modal-log");
        log.innerHTML = "";
        var exitCode = 0;
        while (true) {
          var result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split("\n");
          buffer = lines.pop() || "";
          lines.forEach(function(line) {
            if (!line.trim()) return;
            if (line.indexOf("__EXIT__:") === 0) {
              exitCode = parseInt(line.slice(9), 10);
              return;
            }
            if (line.indexOf("__") === 0) return;
            var div = document.createElement("div");
            div.textContent = line;
            log.appendChild(div);
          });
          log.scrollTop = log.scrollHeight;
        }
        if (exitCode !== 0) throw new Error("\u751F\u6210\u5931\u8D25\uFF08\u9000\u51FA\u7801 " + exitCode + "\uFF09");
        await loadMods();
        invalidateDetailCache(mod.id);
        await refreshDetail({ force: true });
        updateQueueBar();
        notify("\u53D8\u4F53\u5DF2\u52A0\u5165\u6784\u5EFA\u961F\u5217");
      } catch (e) {
        showError("\u751F\u6210\u53D8\u4F53\u5931\u8D25\uFF1A" + e.message);
      }
    }
    function renderVariantList(mod) {
      var list = $("variant-list");
      list.innerHTML = "";
      if (!mod.variants.length) {
        list.innerHTML = '<div class="empty-state inline-empty">\u6682\u65E0\u53D8\u4F53\uFF1B\u53EF\u5728\u77E9\u9635\u4E2D\u9009\u62E9\u201C\u53EF\u521B\u5EFA\u201D\u5355\u5143\u683C\u751F\u6210</div>';
        return;
      }
      mod.variants.forEach(function(v) {
        var item = document.createElement("div");
        item.className = "variant-item status-" + (v.buildStatus || "idle");
        item.dataset.variantId = v.id;
        var statusText = v.buildStatus === "success" ? "\u5C31\u7EEA" : v.buildStatus === "failed" ? "\u5931\u8D25" : v.buildStatus === "building" ? "\u4EFB\u52A1\u8FDB\u884C\u4E2D" : "\u672A\u9A8C\u8BC1";
        var missingBtn = "";
        item.innerHTML = '<div class="variant-item-header"><span class="loader-badge loader-' + esc(v.loader) + '">' + esc((LOADER_LABELS[v.loader] || v.loader).slice(0, 2)) + "</span><div><h4>" + LOADER_LABELS[v.loader] + " " + esc(v.mcVersion) + " <span>\xB7 v" + esc(v.modVersion) + '</span></h4><div class="path" title="' + esc(v.projectPath) + '">' + esc(v.projectPath) + '</div><div class="variant-status"><span class="status-dot"></span>' + statusText + '</div></div></div><div class="variant-actions"><button class="btn btn-primary btn-sm" data-action="build">' + icon("build") + '\u6784\u5EFA</button><button class="btn btn-secondary btn-sm" data-action="run">' + icon("play") + '\u542F\u52A8</button><button class="btn btn-secondary btn-sm" data-action="logs">' + icon("terminal") + '\u65E5\u5FD7</button><button class="btn btn-icon" data-action="folder" title="\u6253\u5F00\u9879\u76EE\u6587\u4EF6\u5939" aria-label="\u6253\u5F00\u9879\u76EE\u6587\u4EF6\u5939">' + icon("folder") + '</button><details class="action-menu"><summary class="btn btn-quiet btn-sm" aria-label="\u66F4\u591A\u53D8\u4F53\u64CD\u4F5C">' + icon("more") + '</summary><div class="action-menu-popover"><button data-action="cursor">\u7528 Cursor \u6253\u5F00</button><button data-action="relocate">\u91CD\u65B0\u5B9A\u4F4D\u9879\u76EE</button>' + missingBtn + '<span class="menu-separator"></span><button data-action="unlink">\u4EC5\u79FB\u9664\u767B\u8BB0</button><button class="menu-danger" data-action="delete">\u5220\u9664\u53D8\u4F53</button></div></details></div>';
        item.querySelectorAll("[data-action]").forEach(function(btn) {
          btn.addEventListener("click", function(e) {
            e.stopPropagation();
            var menu = btn.closest("details");
            if (menu) menu.removeAttribute("open");
            variantAction(mod.id, v, btn.dataset.action);
          });
        });
        list.appendChild(item);
      });
    }
    async function variantAction(modId, variant, action) {
      if (action === "build") {
        await api("/api/variants/" + variant.id + "/build", { method: "POST", body: { runClient: false } });
        updateQueueBar();
        invalidateDetailCache(modId);
        await refreshDetail({ force: true });
        notify("\u6784\u5EFA\u4EFB\u52A1\u5DF2\u52A0\u5165\u961F\u5217");
      } else if (action === "run") {
        await api("/api/variants/" + variant.id + "/run", { method: "POST" });
        updateQueueBar();
        invalidateDetailCache(modId);
        await refreshDetail({ force: true });
        notify("\u5BA2\u6237\u7AEF\u6B63\u5728\u542F\u52A8\uFF0C\u8BF7\u7A0D\u5019\uFF08\u9996\u6B21\u9700\u4E0B\u8F7D\u4F9D\u8D56\uFF0C\u6E38\u620F\u7A97\u53E3\u6253\u5F00\u524D\u961F\u5217\u4F1A\u663E\u793A\u8FD0\u884C\u4E2D\uFF09");
      } else if (action === "folder") {
        await api("/api/open-folder", { method: "POST", body: { path: variant.projectPath } });
        notify("\u5DF2\u8BF7\u6C42\u6253\u5F00\u9879\u76EE\u6587\u4EF6\u5939");
      } else if (action === "cursor") {
        await api("/api/open-cursor", { method: "POST", body: { path: variant.projectPath } });
        notify("\u5DF2\u8BF7\u6C42\u7528 Cursor \u6253\u5F00\u9879\u76EE");
      } else if (action === "logs") {
        var logs = await api("/api/variants/" + variant.id + "/logs");
        if (!logs.logs || !logs.logs.length) {
          showModal("\u6784\u5EFA\u65E5\u5FD7", "\u6682\u65E0\u65E5\u5FD7");
          return;
        }
        var content = await api("/api/logs?path=" + encodeURIComponent(logs.logs[0].path) + "&variantId=" + encodeURIComponent(variant.id));
        showModal("\u6784\u5EFA\u65E5\u5FD7 \u2014 " + logs.logs[0].name, content.content || "(\u7A7A)");
      } else if (action === "relocate") {
        var pick = await api("/api/select-dir");
        if (!pick.path) return;
        try {
          await api("/api/variants/" + variant.id + "/path", {
            method: "PATCH",
            body: { path: pick.path }
          });
          await loadMods();
          invalidateDetailCache(modId);
          await refreshDetail({ force: true });
          notify("\u9879\u76EE\u8DEF\u5F84\u5DF2\u66F4\u65B0");
        } catch (e) {
          showError("\u91CD\u65B0\u5B9A\u4F4D\u5931\u8D25\uFF1A\u8BF7\u9009\u62E9\u5305\u542B gradlew \u7684\u6709\u6548 mod \u9879\u76EE\u76EE\u5F55");
        }
      } else if (action === "unlink" || action === "remove") {
        if (!await confirmAction({ title: "\u79FB\u9664\u53D8\u4F53\u767B\u8BB0", message: "\u4EC5\u4ECE\u5DE5\u4F5C\u53F0\u79FB\u9664\u6B64\u53D8\u4F53\uFF0C\u78C1\u76D8\u6587\u4EF6\u4F1A\u4FDD\u7559\u3002", detail: variant.projectPath, confirmLabel: "\u79FB\u9664\u767B\u8BB0" })) return;
        try {
          var unlinkResult = await api("/api/mods/" + modId + "/variants/" + variant.id, {
            method: "DELETE",
            body: { deleteFiles: false }
          });
          await afterVariantRegistryChange(modId, unlinkResult);
          hideError();
          notify("\u53D8\u4F53\u767B\u8BB0\u5DF2\u79FB\u9664");
        } catch (e) {
          showError("\u79FB\u9664\u5931\u8D25\uFF1A" + e.message);
        }
      } else if (action === "delete") {
        if (!await confirmAction({ title: "\u6C38\u4E45\u5220\u9664\u53D8\u4F53", message: "\u5C06\u5220\u9664\u6B64\u53D8\u4F53\u7684\u6574\u4E2A\u9879\u76EE\u76EE\u5F55\uFF0C\u6B64\u64CD\u4F5C\u4E0D\u53EF\u6062\u590D\u3002", detail: variant.projectPath, confirmLabel: "\u5220\u9664\u9879\u76EE\u6587\u4EF6", danger: true })) return;
        try {
          var deleteResult = await api("/api/mods/" + modId + "/variants/" + variant.id, {
            method: "DELETE",
            body: { deleteFiles: true }
          });
          await afterVariantRegistryChange(modId, deleteResult);
          hideError();
          notify("\u53D8\u4F53\u9879\u76EE\u5DF2\u5220\u9664");
        } catch (e) {
          showError("\u5220\u9664\u5931\u8D25\uFF1A" + e.message);
        }
      }
    }
    var queueSummaryUntil = 0;
    function burstBuildParticles(target) {
      if (!target || reduceMotion) return;
      var burst = document.createElement("span");
      burst.className = "build-particles";
      for (var i = 0; i < 8; i++) {
        var particle = document.createElement("i");
        particle.style.setProperty("--x", (i % 4 - 1.5) * 18 + "px");
        particle.style.setProperty("--y", -18 - i % 3 * 10 + "px");
        particle.style.setProperty("--delay", i * 24 + "ms");
        burst.appendChild(particle);
      }
      target.appendChild(burst);
      setTimeout(function() {
        burst.remove();
      }, 650);
    }
    function flashVariant(variantId, failed) {
      var item = document.querySelector('[data-variant-id="' + variantId + '"]');
      if (!item) return;
      var className = failed ? "build-result-failed" : "build-result-success";
      item.classList.remove("build-result-failed", "build-result-success");
      requestAnimationFrame(function() {
        item.classList.add(className);
        if (!failed) burstBuildParticles(item.querySelector(".variant-status") || item);
        setTimeout(function() {
          item.classList.remove(className);
        }, 900);
      });
    }
    function showBuildSummaryFeedback(summary) {
      var bar = $("queue-bar");
      if (!bar) return;
      var failed = Number(summary.failed || 0);
      var success = Number(summary.success || 0);
      queueSummaryUntil = Date.now() + 1600;
      bar.classList.add("visible", failed ? "summary-failed" : "summary-success");
      bar.classList.remove(failed ? "summary-success" : "summary-failed");
      setText("queue-text", failed ? "\u6784\u5EFA\u5B8C\u6210\uFF0C\u4F46\u6709\u4EFB\u52A1\u5931\u8D25" : "\u6784\u5EFA\u5B8C\u6210");
      setText("queue-subtext", success + " \u4E2A\u6210\u529F" + (failed ? " \xB7 " + failed + " \u4E2A\u5931\u8D25" : " \xB7 \u6240\u6709\u4EFB\u52A1\u5DF2\u5C31\u7EEA"));
      notify(success + " \u4E2A\u6784\u5EFA\u6210\u529F" + (failed ? "\uFF0C" + failed + " \u4E2A\u5931\u8D25" : ""), failed ? "error" : "success");
      if (!failed) burstBuildParticles(bar.querySelector(".spinner") || bar);
      (summary.failedVariantIds || []).forEach(function(id) {
        flashVariant(id, true);
      });
      if (!failed && summary.targetVariantId) flashVariant(summary.targetVariantId, false);
      setTimeout(function() {
        bar.classList.remove("summary-success", "summary-failed");
        void updateQueueBar();
      }, 1650);
    }
    async function updateQueueBar() {
      var bar = $("queue-bar");
      if (!bar) return;
      try {
        var data = await api("/api/queue");
        var active = data.active || (data.running && data.current ? 1 : 0);
        var pending = data.pending || 0;
        var gradleActive = data.gradleBuildActive ?? 0;
        var gradleMax = data.gradleBuildMax || data.maxConcurrency || active || 1;
        var clientActive = data.clientActive ?? 0;
        var clientMax = data.clientMax || 1;
        var jobSlots = data.jobSlots || gradleMax;
        if (data.running || active > 0 || pending > 0) {
          bar.classList.add("visible");
          var label = data.currentLabel || "";
          var detail = label ? " " + label : "";
          var slotInfo = " \xB7 \u4EFB\u52A1 " + active + "/" + jobSlots + " \xB7 \u6784\u5EFA " + gradleActive + "/" + gradleMax + " \xB7 \u5BA2\u6237\u7AEF " + clientActive + "/" + clientMax;
          $("queue-text").textContent = data.running || active > 0 ? "\u6B63\u5728\u6784\u5EFA" + detail + slotInfo + (pending > 0 ? " \xB7 \u5269\u4F59 " + pending + " \u9879" : "") : "\u961F\u5217\u7B49\u5F85\u4E2D " + pending + " \u9879";
          setText(
            "queue-subtext",
            data.running || active > 0 ? "Gradle \u4E0E\u5BA2\u6237\u7AEF\u5206\u7EA7\u9650\u6D41 \xB7 \u6BCF\u69FD Gradle \u5355 Worker \xB7 \u7269\u7406 CPU " + (data.physicalCores || jobSlots) + " \u6838" : "\u7B49\u5F85\u6267\u884C\u69FD\u91CA\u653E"
          );
          setText("sidebar-status", data.running || active > 0 ? "\u6784\u5EFA\u961F\u5217\u8FD0\u884C\u4E2D" : "\u961F\u5217\u7B49\u5F85\u4E2D");
        } else {
          if (Date.now() < queueSummaryUntil) return;
          bar.classList.remove("visible");
          renderWorkbenchStats();
        }
      } catch (e) {
        bar.classList.remove("visible");
      }
    }
    function trackBuildBatchDone(event) {
      if (!state.buildBatch || !event.job) return;
      if (state.buildBatch.jobIds.indexOf(event.job.id) < 0) return;
      state.buildBatch.done[event.job.id] = !!event.success;
      finalizeBuildBatch(false);
    }
    function finalizeBuildBatch(cancelled) {
      if (!state.buildBatch) return;
      var batch = state.buildBatch;
      var success = 0;
      var failed = 0;
      var pending = 0;
      batch.jobIds.forEach(function(id) {
        if (id in batch.done) {
          if (batch.done[id]) success++;
          else failed++;
        } else {
          pending++;
          failed++;
        }
      });
      if (!cancelled && pending > 0) return;
      if (cancelled) notify(batch.modName + " \u6784\u5EFA\u5DF2\u53D6\u6D88", "warning");
      state.buildBatch = null;
    }
    if (window.dmclBridge) {
      window.dmclBridge.onBuildEvent(function(event) {
        updateQueueBar();
        if (event.type === "done") trackBuildBatchDone(event);
        if (event.type === "cancelled") finalizeBuildBatch(true);
        if ((event.type === "done" || event.type === "start" || event.type === "cancelled") && state.currentModId) {
          invalidateDetailCache(state.currentModId);
          refreshDetail({ force: true });
          if (event.type === "done") loadMods();
        }
        if (event.type === "progress" && $("modal-overlay").classList.contains("visible")) {
          var log = $("modal-log");
          if (log && event.line) {
            var div = document.createElement("div");
            div.textContent = event.line;
            log.appendChild(div);
            log.scrollTop = log.scrollHeight;
          }
        }
      });
    }
    setInterval(updateQueueBar, 5e3);
    function nameToModId(name) {
      var s = name.toLowerCase().replace(/[\u4e00-\u9fa5]+/g, "").replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_{2,}/g, "_");
      if (!s || !/^[a-z]/.test(s)) {
        var hash = 0;
        for (var i = 0; i < name.length; i++) {
          hash = (hash << 5) - hash + name.charCodeAt(i) | 0;
        }
        s = "mod_" + Math.abs(hash).toString(36).slice(0, 8);
      }
      s = s.slice(0, 32);
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(s)) s = "mymod";
      return s;
    }
    function isValidModId(modId) {
      return /^[a-z][a-z0-9_]{1,63}$/.test(modId);
    }
    function currentModId() {
      if (state.modidTouched) return $("inp-modid").value.trim() || "";
      var name = $("inp-name").value.trim();
      if (name) return nameToModId(name);
      return $("inp-modid").value.trim() || "";
    }
    function joinProjectPath(modId, loader, mc) {
      var root = state.projectsRoot;
      if (!root || !modId || !loader || !mc) return "";
      var sep = root.indexOf("\\") >= 0 ? "\\" : "/";
      return root.replace(/[/\\]+$/, "") + sep + modId + sep + loader + "-" + mc;
    }
    function setDirInputManaged(managed) {
      var dirEl = $("inp-dir");
      if (!dirEl) return;
      dirEl.readOnly = !!managed;
      dirEl.style.opacity = managed ? "0.92" : "1";
      dirEl.placeholder = managed ? "\u586B\u5199\u6A21\u7EC4\u540D\u5B57\u540E\u81EA\u52A8\u751F\u6210" : "\u81EA\u5B9A\u4E49\u9879\u76EE\u8DEF\u5F84";
    }
    function syncProjectPath() {
      if (state.dirTouched) return;
      var modId = currentModId();
      if (!isValidModId(modId) || !state.selectedLoader || !state.selectedMc) {
        $("inp-dir").value = "";
        updateDirPreview();
        return;
      }
      $("inp-dir").value = joinProjectPath(modId, state.selectedLoader, state.selectedMc);
      updateDirPreview();
    }
    function onDisplayNameChanged() {
      if (!state.modidTouched) {
        var name = $("inp-name").value.trim();
        $("inp-modid").value = name ? nameToModId(name) : "";
      }
      if (!state.groupTouched) {
        var m = currentModId();
        $("inp-group").value = m ? "com.example." + m.replace(/_/g, "") : "";
      }
      syncProjectPath();
    }
    function preloadLoaderData(loader) {
      if (state.versionsCache[loader]) return Promise.resolve(state.versionsCache[loader]);
      if (state.versionsLoading[loader]) return state.versionsLoading[loader];
      state.versionsLoading[loader] = api("/api/versions/" + loader).then(function(data) {
        var versions = data.versions || [];
        state.versionsCache[loader] = versions;
        if (versions[0]) {
          api("/api/mappings/" + loader + "/" + encodeURIComponent(versions[0])).catch(function() {
          });
        }
        delete state.versionsLoading[loader];
        return versions;
      }).catch(function(e) {
        delete state.versionsLoading[loader];
        throw e;
      });
      return state.versionsLoading[loader];
    }
    function resetCreateWizard() {
      state.modidTouched = false;
      state.groupTouched = false;
      state.dirTouched = false;
      state.nameComposing = false;
      state.selectedLoader = "";
      clearTimeout(pathRefreshTimer);
      setDirInputManaged(true);
      var nameEl = $("inp-name");
      if (nameEl) {
        nameEl.value = "";
        nameEl.readOnly = false;
        nameEl.disabled = false;
      }
      if ($("inp-modid")) $("inp-modid").value = "";
      if ($("inp-group")) $("inp-group").value = "";
      if ($("inp-dir")) $("inp-dir").value = "";
      if ($("dir-preview")) $("dir-preview").textContent = "";
      if ($("sel-mappings")) $("sel-mappings").innerHTML = "<option>\u7B49\u5F85\u7248\u672C\u52A0\u8F7D\u2026</option>";
      document.querySelectorAll("#loader-cards .card").forEach(function(c) {
        c.classList.remove("selected");
        var radio = c.querySelector("input[type=radio]");
        if (radio) radio.checked = false;
      });
      var btnNext = $("loader-next");
      if (btnNext) btnNext.disabled = true;
    }
    function updateDirPreview() {
      var el = $("dir-preview");
      var modId = currentModId();
      var full = $("inp-dir").value.trim();
      if (full) {
        el.textContent = "\u5C06\u521B\u5EFA\u5728: " + full;
        return;
      }
      if (modId && isValidModId(modId) && state.selectedLoader && state.selectedMc) {
        var preview = joinProjectPath(modId, state.selectedLoader, state.selectedMc);
        el.textContent = preview ? "\u5C06\u521B\u5EFA\u5728: " + preview : "\u7ED3\u6784\uFF1Aprojects/{modId}/{loader}-{\u7248\u672C}/";
        return;
      }
      el.textContent = "\u7ED3\u6784\uFF1Aprojects/{modId}/{loader}-{\u7248\u672C}/\uFF08\u586B\u5199\u6A21\u7EC4\u540D\u5B57\u540E\u81EA\u52A8\u66F4\u65B0\uFF09";
    }
    async function refreshDefaultProjectPath() {
      if (!state.projectsRoot) {
        try {
          var info = await api("/api/default-dir");
          if (info.projectsRoot) state.projectsRoot = info.projectsRoot;
        } catch (e) {
        }
      }
      syncProjectPath();
    }
    function showCreateStep(step) {
      ["step-loader", "step-config", "step-confirm", "step-gen"].forEach(function(id) {
        var el = $(id);
        if (!el) return;
        var show = id === step;
        el.hidden = !show;
        el.setAttribute("aria-hidden", show ? "false" : "true");
      });
      var stage = step.replace("step-", "");
      var order = ["loader", "config", "confirm", "gen"];
      var current = order.indexOf(stage);
      document.querySelectorAll("[data-wizard-stage]").forEach(function(item) {
        var index = order.indexOf(item.dataset.wizardStage || "");
        item.classList.toggle("active", index === current);
        item.classList.toggle("done", index >= 0 && index < current);
      });
      window.dmclBridge.onBuildSummary?.(function(summary) {
        showBuildSummaryFeedback(summary);
      });
      window.dmclBridge.onNotificationOpen?.(async function(payload) {
        var variantId = payload && payload.targetVariantId;
        if (!variantId) {
          showView("list");
          return;
        }
        await loadMods();
        var mod = state.mods.find(function(candidate) {
          return (candidate.variants || []).some(function(variant) {
            return variant.id === variantId;
          });
        });
        if (!mod) {
          showView("list");
          return;
        }
        await openDetail(mod.id);
        requestAnimationFrame(function() {
          scrollToVariant(variantId);
        });
      });
    }
    async function showCreateConfirmation() {
      var form = await validateCreateForm();
      if (!form) return;
      if (!state.selectedMappings && !(state.selectedLoader === "fabric" && isUnobfuscatedMc(state.selectedMc))) {
        showError("\u5F53\u524D\u7248\u672C\u6682\u65E0\u53EF\u7528\u6620\u5C04\u8868\uFF0C\u8BF7\u6362\u4E00\u4E2A Minecraft \u7248\u672C");
        return;
      }
      hideError();
      var summary = $("create-summary");
      if (summary) {
        var rows = [
          ["\u6A21\u7EC4", form.name + "  \xB7  " + form.modId],
          ["\u5F00\u53D1\u73AF\u5883", (LOADER_LABELS[state.selectedLoader] || state.selectedLoader) + "  \xB7  Minecraft " + state.selectedMc],
          ["\u6620\u5C04", state.selectedMappings || "Mojang \u5B98\u65B9\u6620\u5C04"],
          ["\u9879\u76EE\u76EE\u5F55", $("inp-dir").value.trim()],
          ["\u955C\u50CF", form.mirror ? "\u4F7F\u7528\u56FD\u5185\u955C\u50CF" : "\u4F7F\u7528\u5B98\u65B9\u6E90"]
        ];
        summary.innerHTML = rows.map(function(row) {
          return "<div><span>" + esc(row[0]) + "</span><strong>" + esc(row[1]) + "</strong></div>";
        }).join("");
      }
      showCreateStep("step-confirm");
    }
    function initCreateWizard() {
      var cardsContainer = $("loader-cards");
      var btnNext = $("loader-next");
      cardsContainer.innerHTML = "";
      LOADERS.forEach(function(ldr) {
        var c = document.createElement("label");
        c.className = "card";
        c.innerHTML = '<input class="sr-only loader-radio" type="radio" name="loader" value="' + ldr.id + '"><span class="loader-card-mark">' + ldr.icon + '</span><span class="label">' + ldr.label + '</span><span class="hint">' + ldr.hint + '</span><span class="card-check">' + icon("check") + "</span>";
        function selectLoaderCard() {
          document.querySelectorAll(".card").forEach(function(x) {
            x.classList.remove("selected");
          });
          c.classList.add("selected");
          var radio = c.querySelector("input");
          if (radio) radio.checked = true;
          state.selectedLoader = ldr.id;
          btnNext.disabled = false;
          hideError();
          preloadLoaderData(ldr.id).catch(function() {
          });
        }
        c.addEventListener("click", selectLoaderCard);
        cardsContainer.appendChild(c);
      });
      btnNext.addEventListener("click", function() {
        if (!state.selectedLoader) return;
        showCreateStep("step-config");
        setDirInputManaged(true);
        var nameEl2 = $("inp-name");
        if (nameEl2) {
          requestAnimationFrame(function() {
            nameEl2.focus();
            nameEl2.select();
          });
        }
        refreshDefaultProjectPath();
        loadVersions(state.selectedLoader);
      });
      $("config-back").addEventListener("click", function() {
        showCreateStep("step-loader");
      });
      $("config-gen").addEventListener("click", function() {
        void showCreateConfirmation();
      });
      $("confirm-back").addEventListener("click", function() {
        showCreateStep("step-config");
      });
      $("confirm-create").addEventListener("click", startGeneration);
      $("config-gen-all").addEventListener("click", startGenerationAll);
      $("btn-refresh-versions").addEventListener("click", function() {
        void refreshMetaVersions();
      });
      $("btn-refresh-mappings").addEventListener("click", function() {
        void forceRefreshMappings();
      });
      var nameEl = $("inp-name");
      if (nameEl) {
        nameEl.addEventListener("compositionstart", function() {
          state.nameComposing = true;
        });
        nameEl.addEventListener("compositionend", function() {
          state.nameComposing = false;
          onDisplayNameChanged();
        });
        nameEl.addEventListener("input", function() {
          if (state.nameComposing) {
            syncProjectPath();
            updateDirPreview();
          } else {
            onDisplayNameChanged();
          }
        });
      }
      $("inp-modid").addEventListener("input", function() {
        state.modidTouched = true;
        var m = $("inp-modid").value.trim();
        if (!state.groupTouched && m) {
          $("inp-group").value = "com.example." + m.replace(/_/g, "");
        }
        syncProjectPath();
      });
      $("inp-group").addEventListener("input", function() {
        state.groupTouched = true;
      });
      $("inp-dir").addEventListener("input", function() {
        state.dirTouched = true;
        setDirInputManaged(false);
        updateDirPreview();
      });
      $("btn-browse").addEventListener("click", async function() {
        var data = await api("/api/select-dir");
        if (data.path) {
          state.dirTouched = true;
          setDirInputManaged(false);
          $("inp-dir").value = data.path;
          updateDirPreview();
        }
      });
      $("sel-mc").addEventListener("change", function() {
        state.selectedMc = $("sel-mc").value;
        syncProjectPath();
        updateMappingsUiForVersion(state.selectedMc);
        refreshMappings();
      });
      $("sel-mappings").addEventListener("change", function() {
        state.selectedMappings = $("sel-mappings").value;
      });
      $("gen-cancel").addEventListener("click", function() {
        state.generationCancelled = true;
        if (state.activeAbort) state.activeAbort.abort();
        if (state.batchAbortControllers) {
          state.batchAbortControllers.forEach(function(ac) {
            ac.abort();
          });
          state.batchAbortControllers = null;
        }
        fetch("/api/cancel").catch(function() {
        });
        showCreateStep("step-config");
      });
    }
    function isUnobfuscatedMc(mc) {
      if (!mc) return false;
      var parts = mc.split(".");
      var first = parseInt(parts[0], 10);
      if (first === 1) return false;
      return first >= 26;
    }
    function updateMappingsUiForVersion(mc) {
      var mapGroup = $("sel-mappings")?.closest(".form-group");
      var refreshBtn = $("btn-refresh-mappings");
      var unobfuscated = state.selectedLoader === "fabric" && isUnobfuscatedMc(mc);
      if (mapGroup) mapGroup.style.opacity = unobfuscated ? "0.72" : "1";
      if (refreshBtn) refreshBtn.disabled = !!unobfuscated;
    }
    function updateVersionsHint(fromCache, updatedAt) {
      var hint = $("versions-cache-hint");
      if (!hint) return;
      if (!updatedAt) {
        hint.textContent = "";
        return;
      }
      var src = fromCache ? "\u672C\u5730\u7F13\u5B58" : "\u8054\u7F51\u83B7\u53D6";
      hint.textContent = src + " \xB7 \u66F4\u65B0\u4E8E " + updatedAt.slice(0, 10);
    }
    function applyMappingsData(data) {
      var mapSel = $("sel-mappings");
      if (!mapSel) return;
      var options = data.options || [];
      if (!options.length) {
        mapSel.innerHTML = "<option>\u6B64\u7248\u672C\u6682\u65E0\u53EF\u7528\u6620\u5C04</option>";
        state.selectedMappings = "";
        return;
      }
      var unobfuscated = state.selectedLoader === "fabric" && isUnobfuscatedMc(state.selectedMc);
      mapSel.innerHTML = options.map(function(o) {
        var label = o.label;
        if (o.version) label += " (" + o.version + ")";
        if (o.id === data.default) label += "\uFF08\u63A8\u8350\uFF09";
        return '<option value="' + o.id + '">' + label + "</option>";
      }).join("");
      state.selectedMappings = data.default || options[0].id;
      mapSel.value = state.selectedMappings;
      mapSel.disabled = unobfuscated;
      var hint = $("mappings-cache-hint");
      if (hint) {
        if (unobfuscated) {
          hint.textContent = "\u6B64\u7248\u672C\u5B98\u65B9\u672A\u6DF7\u6DC6\uFF0C\u65E0\u9700\u9009\u62E9 Yarn/Parchment \u6620\u5C04";
        } else {
          var src = data.fromCache ? "\u672C\u5730\u7F13\u5B58" : "\u8054\u7F51\u63A2\u6D4B";
          var at = data.updatedAt ? data.updatedAt.slice(0, 10) : "";
          hint.textContent = src + (at ? " \xB7 \u66F4\u65B0\u4E8E " + at : "");
        }
      }
      updateMappingsUiForVersion(state.selectedMc);
    }
    async function refreshMetaVersions() {
      if (!state.selectedLoader) return;
      var btn = $("btn-refresh-versions");
      if (btn) btn.disabled = true;
      hideError();
      try {
        var result = await api("/api/meta/refresh", { method: "POST" });
        delete state.versionsCache[state.selectedLoader];
        state.versionsCache[state.selectedLoader] = result.loaderVersions && result.loaderVersions[state.selectedLoader] || [];
        updateVersionsHint(false, result.updatedAt);
        await loadVersions(state.selectedLoader);
        notify("\u7248\u672C\u5217\u8868\u5DF2\u5237\u65B0");
      } catch (e) {
        showError("\u5237\u65B0\u7248\u672C\u5931\u8D25\uFF1A" + e.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    }
    async function forceRefreshMappings() {
      if (!state.selectedLoader || !state.selectedMc) return;
      var btn = $("btn-refresh-mappings");
      if (btn) btn.disabled = true;
      hideError();
      try {
        var data = await api("/api/mappings/refresh", {
          method: "POST",
          body: { loader: state.selectedLoader, mcVersion: state.selectedMc }
        });
        applyMappingsData(data);
        notify("\u6620\u5C04\u8868\u5DF2\u5237\u65B0");
      } catch (e) {
        showError("\u5237\u65B0\u6620\u5C04\u5931\u8D25\uFF1A" + e.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    }
    async function loadDefaultDir() {
      try {
        var data = await api("/api/default-dir");
        if (data.projectsRoot) state.projectsRoot = data.projectsRoot;
      } catch (e) {
      }
      await refreshDefaultProjectPath();
    }
    async function loadVersions(loader) {
      var sel = $("sel-mc");
      var mapSel = $("sel-mappings");
      sel.innerHTML = "<option>\u52A0\u8F7D\u4E2D\u2026</option>";
      sel.disabled = true;
      if (mapSel) {
        mapSel.innerHTML = "<option>\u52A0\u8F7D\u4E2D\u2026</option>";
        mapSel.disabled = true;
      }
      try {
        var versions = state.versionsCache[loader];
        var fromCache = true;
        var updatedAt = "";
        if (!versions) {
          var data = await api("/api/versions/" + loader);
          versions = data.versions || [];
          state.versionsCache[loader] = versions;
          fromCache = !!data.fromCache;
          updatedAt = data.updatedAt || "";
        } else {
          try {
            var status = await api("/api/meta/status");
            updatedAt = status.updatedAt || "";
            fromCache = !status.stale;
          } catch (e) {
          }
        }
        updateVersionsHint(fromCache, updatedAt);
        sel.innerHTML = versions.map(function(v, i) {
          return '<option value="' + v + '">' + v + (i === 0 ? "\uFF08\u6700\u65B0\uFF09" : "") + "</option>";
        }).join("");
        state.selectedMc = versions[0] || "";
        syncProjectPath();
        onDisplayNameChanged();
        await refreshMappings(0);
      } catch (e) {
        sel.innerHTML = "<option>\u52A0\u8F7D\u5931\u8D25</option>";
        if (mapSel) mapSel.innerHTML = "<option>\u52A0\u8F7D\u5931\u8D25</option>";
      }
      sel.disabled = false;
    }
    async function refreshMappings(retryCount) {
      retryCount = retryCount || 0;
      var mapSel = $("sel-mappings");
      if (!mapSel || !state.selectedMc || !state.selectedLoader) return;
      mapSel.innerHTML = "<option>\u8BFB\u53D6\u672C\u5730\u7F13\u5B58\u2026</option>";
      mapSel.disabled = true;
      try {
        var data = await api(
          "/api/mappings/" + state.selectedLoader + "/" + encodeURIComponent(state.selectedMc)
        );
        var options = data.options || [];
        var unobfuscated = state.selectedLoader === "fabric" && isUnobfuscatedMc(state.selectedMc);
        if (!unobfuscated && state.selectedLoader === "fabric" && options.length === 0 && retryCount < 3) {
          mapSel.innerHTML = "<option>\u6B63\u5728\u63A2\u6D4B Yarn \u6620\u5C04\uFF08" + (retryCount + 1) + "/3\uFF09\u2026</option>";
          await new Promise(function(r) {
            setTimeout(r, 1500 + retryCount * 500);
          });
          return refreshMappings(retryCount + 1);
        }
        if (!options.length) {
          throw new Error(unobfuscated ? "\u6B64\u7248\u672C\u6620\u5C04\u4FE1\u606F\u4E0D\u53EF\u7528" : "\u6B64\u7248\u672C\u6682\u65E0\u53EF\u7528\u6620\u5C04");
        }
        applyMappingsData(data);
      } catch (e) {
        if (retryCount < 2) {
          await new Promise(function(r) {
            setTimeout(r, 1e3);
          });
          return refreshMappings(retryCount + 1);
        }
        mapSel.innerHTML = "<option>\u6B64\u7248\u672C\u6682\u65E0\u53EF\u7528\u6620\u5C04</option>";
        state.selectedMappings = "";
      } finally {
        mapSel.disabled = false;
      }
    }
    function extractGenFailure(logEl, exitCode) {
      var lines = [];
      logEl.querySelectorAll("div").forEach(function(d) {
        lines.push(d.textContent || "");
      });
      var errLines = lines.filter(function(l) {
        return /错误|失败|ERROR|FAILURE|Exception|BUILD FAILED/i.test(l);
      });
      if (errLines.length) return errLines[errLines.length - 1];
      if (exitCode !== null && exitCode !== void 0) return "\u9000\u51FA\u7801 " + exitCode;
      return "\u672A\u77E5\u9519\u8BEF";
    }
    function setPhase(phase) {
      var phases = ["phase-gen", "phase-build", "phase-client", "phase-done"];
      phases.forEach(function(id) {
        var el = $(id);
        el.classList.remove("active", "done");
      });
      if (phase === "gen") $("phase-gen").classList.add("active");
      else if (phase === "build") {
        $("phase-gen").classList.add("done");
        $("phase-build").classList.add("active");
      } else if (phase === "client") {
        $("phase-gen").classList.add("done");
        $("phase-build").classList.add("done");
        $("phase-client").classList.add("active");
      } else if (phase === "done") {
        phases.forEach(function(id) {
          $(id).classList.add("done");
        });
      }
    }
    function clearFieldErrors() {
      document.querySelectorAll(".field-error").forEach(function(el) {
        el.remove();
      });
      document.querySelectorAll(".field-invalid").forEach(function(el) {
        el.classList.remove("field-invalid");
      });
    }
    function setFieldError(fieldId, message) {
      var field = $(fieldId);
      if (!field) return;
      field.classList.add("field-invalid");
      var group = field.closest(".form-group") || field.parentElement;
      if (!group) return;
      var error = document.createElement("div");
      error.className = "field-error";
      error.textContent = message;
      group.appendChild(error);
      field.focus();
    }
    async function validateCreateForm() {
      clearFieldErrors();
      var name = $("inp-name").value.trim();
      var modId = $("inp-modid").value.trim();
      var group = $("inp-group").value.trim();
      var mirror = $("chk-mirror").checked;
      if (!name) {
        setFieldError("inp-name", "\u8BF7\u7ED9\u6A21\u7EC4\u8D77\u4E2A\u540D\u5B57");
        showError("\u8BF7\u68C0\u67E5\u6807\u8BB0\u7684\u8868\u5355\u5B57\u6BB5");
        return null;
      }
      if (!modId) {
        modId = nameToModId(name);
        $("inp-modid").value = modId;
      }
      if (!isValidModId(modId)) {
        setFieldError("inp-modid", "\u9700\u5C0F\u5199\u5B57\u6BCD\u5F00\u5934\uFF0C\u4EC5\u542B\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u4E0B\u5212\u7EBF");
        showError("\u6A21\u7EC4 ID \u683C\u5F0F\u65E0\u6548");
        return null;
      }
      if (!state.selectedLoader) {
        showError("\u8BF7\u5148\u9009\u62E9\u52A0\u8F7D\u5668");
        return null;
      }
      if (!state.dirTouched) {
        await refreshDefaultProjectPath();
        syncProjectPath();
      }
      if (!group) {
        group = "com.example." + modId.replace(/_/g, "");
        $("inp-group").value = group;
      }
      return { name, modId, group, mirror };
    }
    async function resolveMappingsForVersion(loader, mc) {
      if (loader === "fabric" && isUnobfuscatedMc(mc)) return "mojmap";
      var data = await api("/api/mappings/" + loader + "/" + encodeURIComponent(mc));
      if (!data.options || !data.options.length) {
        if (loader === "fabric") return "mojmap";
        throw new Error(mc + " \u6682\u65E0\u53EF\u7528\u6620\u5C04");
      }
      return data.default || data.options[0].id;
    }
    async function runGenerateStream(args, opts) {
      opts = opts || {};
      var log = opts.logEl || $("gen-log");
      var resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args, scaffoldOnly: !!opts.scaffoldOnly }),
        signal: opts.signal || (state.activeAbort ? state.activeAbort.signal : void 0)
      });
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var exitCode = null;
      var prefix = opts.prefix || "";
      while (true) {
        if (state.generationCancelled) return -1;
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop() || "";
        lines.forEach(function(line) {
          line = line.trim();
          if (!line) return;
          if (line.indexOf("__EXIT__:") === 0) {
            exitCode = parseInt(line.slice(9), 10);
            return;
          }
          if (!opts.scaffoldOnly) {
            if (line.indexOf("\u6B63\u5728\u9A8C\u8BC1\u6784\u5EFA") >= 0) setPhase("build");
            if (line.indexOf("\u6B63\u5728\u542F\u52A8 Minecraft") >= 0) setPhase("client");
          }
          var div = document.createElement("div");
          if (line.indexOf("\u5931\u8D25") >= 0 || line.indexOf("ERROR") >= 0 || line.indexOf("\u9519\u8BEF") >= 0) {
            div.className = "log-err";
          }
          if (line.indexOf("\u6210\u529F") >= 0 || line.indexOf("BUILD SUCCESSFUL") >= 0 || line.indexOf("\u2714") >= 0) {
            div.className = "log-ok";
          }
          div.textContent = prefix + line;
          log.appendChild(div);
        });
        log.scrollTop = log.scrollHeight;
      }
      return exitCode;
    }
    async function startGeneration() {
      var form = await validateCreateForm();
      if (!form) return;
      var dir = $("inp-dir").value.trim();
      if (!dir) {
        setFieldError("inp-dir", "\u9879\u76EE\u8DEF\u5F84\u672A\u8BBE\u7F6E\uFF0C\u8BF7\u68C0\u67E5\u6A21\u7EC4 ID");
        showError("\u9879\u76EE\u8DEF\u5F84\u672A\u8BBE\u7F6E");
        return;
      }
      if (!state.selectedMappings) {
        if (state.selectedLoader === "fabric" && isUnobfuscatedMc(state.selectedMc)) {
          state.selectedMappings = "mojmap";
        } else {
          setFieldError("sel-mappings", "\u5F53\u524D\u7248\u672C\u6682\u65E0\u53EF\u7528\u6620\u5C04\u8868\uFF0C\u8BF7\u6362\u4E00\u4E2A Minecraft \u7248\u672C");
          showError("\u5F53\u524D\u7248\u672C\u6682\u65E0\u53EF\u7528\u6620\u5C04\u8868");
          return;
        }
      }
      hideError();
      showCreateStep("step-gen");
      setPhase("gen");
      var hint = $("gen-hint");
      if (hint) hint.textContent = "\u6B63\u5728\u521B\u5EFA\u5E76\u9A8C\u8BC1 " + state.selectedMc + "\u2026";
      state.generationCancelled = false;
      state.activeAbort = new AbortController();
      var log = $("gen-log");
      log.innerHTML = "";
      var args = [
        "--yes",
        "--loader",
        state.selectedLoader,
        "--mc",
        state.selectedMc,
        "--modid",
        form.modId,
        "--name",
        form.name,
        "--group",
        form.group,
        "--dir",
        dir,
        "--mappings",
        state.selectedMappings
      ];
      if (!form.mirror) args.push("--no-mirror");
      try {
        var exitCode = await runGenerateStream(args);
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(extractGenFailure(log, exitCode));
        }
        if (exitCode === -1) return;
        setPhase("done");
        await loadMods();
        showView("list");
        showCreateStep("step-loader");
        notify("\u6A21\u7EC4\u5DF2\u521B\u5EFA\u5E76\u5B8C\u6210\u9A8C\u8BC1\u6D41\u7A0B");
      } catch (e) {
        if (state.generationCancelled || e.name === "AbortError") return;
        showError("\u521B\u5EFA\u5931\u8D25\uFF1A" + e.message);
      }
    }
    async function startGenerationAll() {
      var form = await validateCreateForm();
      if (!form) return;
      var versions = state.versionsCache[state.selectedLoader];
      if (!versions || !versions.length) {
        try {
          var data = await api("/api/versions/" + state.selectedLoader);
          versions = data.versions || [];
          state.versionsCache[state.selectedLoader] = versions;
        } catch (e) {
          showError("\u52A0\u8F7D\u7248\u672C\u5217\u8868\u5931\u8D25\uFF1A" + e.message);
          return;
        }
      }
      if (!versions.length) {
        showError("\u6CA1\u6709\u53EF\u7528\u7248\u672C\uFF0C\u8BF7\u5148\u5237\u65B0\u7248\u672C\u5217\u8868");
        return;
      }
      var loaderLabel = LOADER_LABELS[state.selectedLoader] || state.selectedLoader;
      var concurrency = {
        jobSlots: 1,
        gradleBuildConcurrency: 1,
        clientConcurrency: 1,
        physicalCores: 1
      };
      try {
        concurrency = await api("/api/concurrency");
      } catch (e) {
      }
      var maxSlots = concurrency.jobSlots || concurrency.maxConcurrency || 1;
      var gradleMax = concurrency.gradleBuildMax || concurrency.gradleBuildConcurrency || maxSlots;
      var clientMax = concurrency.clientMax || concurrency.clientConcurrency || 1;
      if (!await confirmAction({
        title: "\u6279\u91CF\u521B\u5EFA\u6240\u6709\u7248\u672C",
        message: "\u5C06\u4E3A\u300C" + form.name + "\u300D\u521B\u5EFA " + loaderLabel + " \u7684\u5168\u90E8 " + versions.length + " \u4E2A\u7248\u672C\u3002",
        detail: "\u4EFB\u52A1 " + maxSlots + " \u8DEF \xB7 Gradle \u6784\u5EFA\u6700\u591A " + gradleMax + " \u8DEF \xB7 \u5BA2\u6237\u7AEF\u9A8C\u8BC1\u6700\u591A " + clientMax + " \u8DEF\uFF08\u5B89\u5168\u9650\u6D41\uFF09\u3002\n\u5DF2\u5B58\u5728\u4E14\u975E\u7A7A\u7684\u76EE\u5F55\u4F1A\u8DF3\u8FC7\u3002",
        confirmLabel: "\u5F00\u59CB\u6279\u91CF\u521B\u5EFA"
      })) return;
      hideError();
      showCreateStep("step-gen");
      state.generationCancelled = false;
      state.activeAbort = null;
      state.batchAbortControllers = [];
      var log = $("gen-log");
      log.innerHTML = "";
      var hint = $("gen-hint");
      if (hint) hint.textContent = "\u51C6\u5907\u5E76\u884C\u521B\u5EFA " + versions.length + " \u4E2A\u7248\u672C\uFF08\u6700\u591A " + maxSlots + " \u8DEF\uFF09\u2026";
      var success = 0;
      var failed = 0;
      var skipped = 0;
      var completed = 0;
      var nextIndex = 0;
      var activeCount = 0;
      function updateBatchHint() {
        if (!hint) return;
        var pending = versions.length - completed - activeCount;
        hint.textContent = "\u4EFB\u52A1 " + activeCount + "/" + maxSlots + " \xB7 \u6784\u5EFA\u9650 " + gradleMax + " \xB7 \u5BA2\u6237\u7AEF\u9650 " + clientMax + " \xB7 \u5DF2\u5B8C\u6210 " + completed + "/" + versions.length + (pending > 0 ? " \xB7 \u5F85\u5904\u7406 " + pending : "");
      }
      async function runOneVersion(mc) {
        var dir = joinProjectPath(form.modId, state.selectedLoader, mc);
        var header = document.createElement("div");
        header.className = "log-ok";
        header.textContent = "\u2014\u2014 " + mc + " \u2014\u2014";
        log.appendChild(header);
        log.scrollTop = log.scrollHeight;
        var abort = new AbortController();
        state.batchAbortControllers.push(abort);
        try {
          var mappings = await resolveMappingsForVersion(state.selectedLoader, mc);
          var args = [
            "--yes",
            "--loader",
            state.selectedLoader,
            "--mc",
            mc,
            "--modid",
            form.modId,
            "--name",
            form.name,
            "--group",
            form.group,
            "--dir",
            dir,
            "--mappings",
            mappings
          ];
          if (!form.mirror) args.push("--no-mirror");
          setPhase("gen");
          var exitCode = await runGenerateStream(args, {
            logEl: log,
            prefix: "  [" + mc + "] ",
            signal: abort.signal
          });
          if (exitCode === -1) return "cancelled";
          if (exitCode === 0) {
            success++;
            setPhase("done");
            return "success";
          }
          var errText = extractGenFailure(log, exitCode);
          if (/目录已存在|非空/.test(errText)) {
            skipped++;
            return "skipped";
          }
          failed++;
          return "failed";
        } catch (e) {
          var msg = e.message || "";
          if (e.name === "AbortError" || state.generationCancelled) return "cancelled";
          var errDiv = document.createElement("div");
          errDiv.className = "log-err";
          errDiv.textContent = "  [" + mc + "] \u9519\u8BEF\uFF1A" + msg;
          log.appendChild(errDiv);
          if (/目录已存在|非空/.test(msg)) {
            skipped++;
            return "skipped";
          }
          failed++;
          return "failed";
        }
      }
      try {
        await new Promise(function(resolve) {
          function pump() {
            if (state.generationCancelled) {
              if (activeCount === 0) resolve();
              return;
            }
            while (activeCount < maxSlots && nextIndex < versions.length && !state.generationCancelled) {
              var mc = versions[nextIndex++];
              activeCount++;
              updateBatchHint();
              void runOneVersion(mc).finally(function() {
                activeCount--;
                completed++;
                updateBatchHint();
                if (state.generationCancelled && activeCount === 0) resolve();
                else if (nextIndex >= versions.length && activeCount === 0) resolve();
                else pump();
              });
            }
          }
          pump();
        });
        if (state.generationCancelled) return;
        setPhase("done");
        if (hint) hint.textContent = "\u6279\u91CF\u521B\u5EFA\u4E0E\u9A8C\u8BC1\u5B8C\u6210\uFF08\u6784\u5EFA " + gradleMax + " \u8DEF \xB7 \u5BA2\u6237\u7AEF " + clientMax + " \u8DEF\uFF09";
        await loadMods();
        notify("\u6279\u91CF\u5B8C\u6210\uFF1A" + success + " \u6210\u529F\uFF0C" + failed + " \u5931\u8D25\uFF0C" + skipped + " \u8DF3\u8FC7");
        if (success > 0) {
          var mod = state.mods.find(function(m) {
            return m.modId === form.modId;
          });
          if (mod) {
            showView("detail");
            await openDetail(mod.id);
            return;
          }
        }
        showView("list");
        showCreateStep("step-loader");
      } catch (e) {
        if (state.generationCancelled || e.name === "AbortError") return;
        showError("\u6279\u91CF\u521B\u5EFA\u5931\u8D25\uFF1A" + e.message);
      } finally {
        state.batchAbortControllers = null;
      }
    }
    async function removeScanDir(dir) {
      await api("/api/settings/scan-dirs", { method: "POST", body: { remove: dir } });
    }
    async function addScanDirAndOptionalScan(dirPath, doScan) {
      await api("/api/settings/scan-dirs", { method: "POST", body: { add: dirPath } });
      if (doScan) {
        return api("/api/mods/scan", { method: "POST", body: { path: dirPath } });
      }
    }
    function renderScanDirList(containerId, dirs, projectsRoot) {
      var list = $(containerId);
      if (!list) return;
      list.innerHTML = "";
      if (!dirs.length) {
        list.innerHTML = '<p class="muted-placeholder">\u6682\u65E0\u989D\u5916\u76D1\u89C6\u76EE\u5F55</p>';
        return;
      }
      dirs.forEach(function(dir) {
        var isBuiltin = projectsRoot && dir.replace(/\\/g, "/").toLowerCase() === projectsRoot.replace(/\\/g, "/").toLowerCase();
        var row = document.createElement("div");
        row.className = "scan-dir-row";
        row.innerHTML = '<input class="code-input" readonly value="' + esc(dir) + '">';
        if (!isBuiltin) {
          var scanBtn = document.createElement("button");
          scanBtn.className = "btn btn-secondary btn-sm";
          scanBtn.textContent = "\u626B\u63CF";
          scanBtn.addEventListener("click", async function() {
            var r = await api("/api/mods/scan", { method: "POST", body: { path: dir } });
            notify("\u626B\u63CF\u5B8C\u6210\uFF1A\u65B0\u5BFC\u5165 " + r.imported + " \u4E2A\uFF0C\u8DF3\u8FC7 " + r.skipped + " \u4E2A");
            loadRegistry();
            loadMods();
          });
          row.appendChild(scanBtn);
          var rm = document.createElement("button");
          rm.className = "btn btn-danger btn-sm";
          rm.textContent = "\u79FB\u9664";
          rm.addEventListener("click", async function() {
            if (!await confirmAction({ title: "\u79FB\u9664\u76D1\u89C6\u76EE\u5F55", message: "\u505C\u6B62\u626B\u63CF\u6B64\u76EE\u5F55\uFF1F\u5DF2\u767B\u8BB0\u9879\u76EE\u4E0D\u4F1A\u88AB\u5220\u9664\u3002", detail: dir, confirmLabel: "\u79FB\u9664\u76EE\u5F55" })) return;
            await removeScanDir(dir);
            loadSettings();
            loadExternalView();
          });
          row.appendChild(rm);
        } else {
          var tag = document.createElement("span");
          tag.className = "builtin-tag";
          tag.textContent = "\u5185\u7F6E";
          row.appendChild(tag);
        }
        list.appendChild(row);
      });
    }
    async function loadMetaCacheStatus() {
      try {
        var meta = await api("/api/meta/status");
        var maps = await api("/api/mappings/status");
        var verText = meta.updatedAt ? "Fabric " + (meta.loaderCounts?.fabric ?? 0) + " / NeoForge " + (meta.loaderCounts?.neoforge ?? 0) + " / Forge " + (meta.loaderCounts?.forge ?? 0) + " \xB7 " + meta.updatedAt.slice(0, 10) + (meta.stale ? "\uFF08\u53EF\u80FD\u8FC7\u671F\uFF09" : "") : "\u672A\u7F13\u5B58";
        var mapText = maps.lastUpdated ? maps.entries + " \u6761 \xB7 " + maps.lastUpdated.slice(0, 10) : "\u672A\u7F13\u5B58";
        setText("meta-versions-status", verText);
        setText("meta-mappings-status", mapText);
      } catch (e) {
        setText("meta-versions-status", "\u8BFB\u53D6\u5931\u8D25");
        setText("meta-mappings-status", "\u8BFB\u53D6\u5931\u8D25");
      }
    }
    async function refreshAllMetaFromSettings() {
      var btn = $("btn-settings-refresh-versions");
      if (btn) btn.disabled = true;
      try {
        await api("/api/meta/refresh", { method: "POST" });
        state.versionsCache = {};
        invalidateDetailCache();
        await loadMetaCacheStatus();
        notify("\u7248\u672C\u5217\u8868\u5DF2\u5237\u65B0");
      } catch (e) {
        showError("\u5237\u65B0\u7248\u672C\u5217\u8868\u5931\u8D25\uFF1A" + e.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    }
    async function refreshAllMappingsFromSettings() {
      var btn = $("btn-settings-refresh-mappings");
      if (btn) btn.disabled = true;
      try {
        var loaders = ["fabric", "neoforge", "forge"];
        var totalFetched = 0;
        var totalErrors = 0;
        for (var i = 0; i < loaders.length; i++) {
          var result = await api("/api/mappings/refresh-all", {
            method: "POST",
            body: { loader: loaders[i] }
          });
          totalFetched += result.fetched || 0;
          totalErrors += result.errors || 0;
        }
        await loadMetaCacheStatus();
        notify("\u6620\u5C04\u8868\u5DF2\u5237\u65B0\uFF1A\u65B0\u589E/\u66F4\u65B0 " + totalFetched + " \u6761" + (totalErrors ? "\uFF0C" + totalErrors + " \u6761\u5931\u8D25" : ""));
      } catch (e) {
        showError("\u5237\u65B0\u6620\u5C04\u8868\u5931\u8D25\uFF1A" + e.message);
      } finally {
        if (btn) btn.disabled = false;
      }
    }
    async function loadSettings() {
      var data = await api("/api/settings");
      $("dmcl-dir").value = data.dmclDir || "";
      if ($("projects-root")) $("projects-root").value = data.projectsRoot || "";
      var extra = (data.scanDirs || []).filter(function(d) {
        return !data.projectsRoot || d.replace(/\\/g, "/").toLowerCase() !== data.projectsRoot.replace(/\\/g, "/").toLowerCase();
      });
      renderScanDirList("scan-dirs-list", extra, data.projectsRoot);
      renderConcurrencySettings(data.concurrency);
      await loadMetaCacheStatus();
    }
    function renderConcurrencySettings(payload) {
      if (!payload) return;
      var hw = payload.hardware || {};
      var bounds = payload.bounds || {};
      var effective = payload.effective || {};
      var hwEl = $("concurrency-hw");
      if (hwEl) {
        hwEl.textContent = "\u68C0\u6D4B\u5230 " + (hw.physicalCores || "?") + " \u7269\u7406\u6838 \xB7 " + (hw.logicalCores || "?") + " \u903B\u8F91\u6838" + (hw.source ? "\uFF08" + hw.source + "\uFF09" : "");
      }
      bindConcurrencyControl("set-job-slots", bounds.jobSlots, effective.jobSlots);
      bindConcurrencyControl("set-gradle-slots", bounds.gradleBuildConcurrency, effective.gradleBuildConcurrency);
      bindConcurrencyControl("set-client-slots", bounds.clientConcurrency, effective.clientConcurrency);
      updateConcurrencyEffectiveNote(payload);
    }
    function bindConcurrencyControl(prefix, bounds, value) {
      if (!bounds) return;
      var num = $(prefix);
      var range = $(prefix + "-range");
      if (!num || !range) return;
      var min = bounds.min || 1;
      var max = bounds.max || min;
      num.min = String(min);
      num.max = String(max);
      range.min = String(min);
      range.max = String(max);
      var v = Math.max(min, Math.min(max, Number(value) || min));
      num.value = String(v);
      range.value = String(v);
    }
    function readConcurrencyForm() {
      return {
        jobSlots: Number($("set-job-slots").value),
        gradleBuildConcurrency: Number($("set-gradle-slots").value),
        clientConcurrency: Number($("set-client-slots").value)
      };
    }
    function updateConcurrencyEffectiveNote(payload) {
      var el = $("concurrency-effective");
      if (!el || !payload) return;
      var eff = payload.effective || {};
      var defs = payload.defaults || {};
      var customized = payload.user && (payload.user.jobSlots !== void 0 || payload.user.gradleBuildConcurrency !== void 0 || payload.user.clientConcurrency !== void 0);
      el.textContent = "\u5F53\u524D\u751F\u6548\uFF1A\u4EFB\u52A1 " + (eff.jobSlots || "-") + " \xB7 Gradle " + (eff.gradleBuildConcurrency || "-") + " \xB7 \u5BA2\u6237\u7AEF " + (eff.clientConcurrency || "-") + (customized ? "\uFF08\u5DF2\u81EA\u5B9A\u4E49\uFF09" : "\uFF08\u63A8\u8350\u9ED8\u8BA4\u503C\uFF09") + " \xB7 \u63A8\u8350 Gradle " + (defs.gradleBuildConcurrency || "-") + " / \u5BA2\u6237\u7AEF " + (defs.clientConcurrency || "-");
    }
    function wireConcurrencyControl(prefix) {
      var num = $(prefix);
      var range = $(prefix + "-range");
      if (!num || !range) return;
      var syncFromRange = function() {
        num.value = range.value;
        var gradleNum = $("set-gradle-slots");
        var gradleRange = $("set-gradle-slots-range");
        var jobVal = Number($("set-job-slots").value);
        if (prefix === "set-job-slots" && gradleNum && gradleRange) {
          if (Number(gradleNum.value) > jobVal) {
            gradleNum.value = String(jobVal);
            gradleRange.value = String(jobVal);
          }
          gradleNum.max = String(jobVal);
          gradleRange.max = String(jobVal);
          var clientNum = $("set-client-slots");
          var clientRange = $("set-client-slots-range");
          var clientMax = Math.min(8, jobVal);
          if (clientNum && clientRange) {
            clientNum.max = String(clientMax);
            clientRange.max = String(clientMax);
            if (Number(clientNum.value) > clientMax) {
              clientNum.value = String(clientMax);
              clientRange.value = String(clientMax);
            }
          }
        }
      };
      var syncFromNum = function() {
        var min = Number(num.min) || 1;
        var max = Number(num.max) || min;
        var v = Math.max(min, Math.min(max, Number(num.value) || min));
        num.value = String(v);
        range.value = String(v);
        syncFromRange();
      };
      range.addEventListener("input", syncFromRange);
      num.addEventListener("change", syncFromNum);
      num.addEventListener("input", function() {
        range.value = num.value;
      });
    }
    wireConcurrencyControl("set-job-slots");
    wireConcurrencyControl("set-gradle-slots");
    wireConcurrencyControl("set-client-slots");
    $("btn-concurrency-save")?.addEventListener("click", async function() {
      hideError();
      try {
        var body = readConcurrencyForm();
        if (body.gradleBuildConcurrency > body.jobSlots) {
          showError("Gradle \u6784\u5EFA\u5E76\u53D1\u4E0D\u80FD\u5927\u4E8E\u4EFB\u52A1\u69FD\u4F4D");
          return;
        }
        var result = await api("/api/settings/concurrency", { method: "POST", body });
        renderConcurrencySettings(result.concurrency);
        notify("\u5E76\u53D1\u8BBE\u7F6E\u5DF2\u4FDD\u5B58");
      } catch (e) {
        showError("\u4FDD\u5B58\u5E76\u53D1\u8BBE\u7F6E\u5931\u8D25\uFF1A" + e.message);
      }
    });
    $("btn-concurrency-reset")?.addEventListener("click", async function() {
      hideError();
      try {
        var result = await api("/api/settings/concurrency", { method: "POST", body: { reset: true } });
        renderConcurrencySettings(result.concurrency);
        notify("\u5DF2\u6062\u590D\u63A8\u8350\u5E76\u53D1\u503C");
      } catch (e) {
        showError("\u6062\u590D\u5931\u8D25\uFF1A" + e.message);
      }
    });
    async function registryAction(action, project) {
      if (action === "open") {
        openDetail(project.modUuid);
      } else if (action === "relocate") {
        var pick = await api("/api/select-dir");
        if (!pick.path) return;
        await api("/api/variants/" + project.variantId + "/path", {
          method: "PATCH",
          body: { path: pick.path }
        });
        loadRegistry();
        loadMods();
      } else if (action === "remove") {
        if (!await confirmAction({ title: "\u79FB\u9664\u9879\u76EE\u767B\u8BB0", message: "\u9879\u76EE\u53EA\u4F1A\u4ECE\u5DE5\u4F5C\u53F0\u79FB\u9664\uFF0C\u78C1\u76D8\u6587\u4EF6\u4E0D\u4F1A\u88AB\u5220\u9664\u3002", detail: project.projectPath, confirmLabel: "\u79FB\u9664\u767B\u8BB0" })) return;
        await api("/api/mods/" + project.modUuid + "/variants/" + project.variantId, {
          method: "DELETE",
          body: { deleteFiles: false }
        });
        loadRegistry();
        loadMods();
      }
    }
    async function loadRegistry() {
      var wrap = $("registry-wrap");
      if (!wrap) return;
      var data = await api("/api/registry/projects");
      var projects = data.projects || [];
      if (!projects.length) {
        wrap.innerHTML = '<p class="muted-placeholder registry-empty">\u6682\u65E0\u5DF2\u6CE8\u518C\u9879\u76EE</p>';
        return;
      }
      var html = '<table class="registry-table"><thead><tr><th>\u6A21\u7EC4</th><th>\u53D8\u4F53</th><th>\u8DEF\u5F84</th><th>\u72B6\u6001</th><th>\u64CD\u4F5C</th></tr></thead><tbody>';
      projects.forEach(function(p) {
        var status = p.isBuiltin ? "\u5185\u7F6E" : "\u5916\u90E8";
        html += '<tr data-vid="' + p.variantId + '"><td>' + esc(p.displayName) + '<br><span class="registry-modid">' + esc(p.modId) + "</span></td><td>" + LOADER_LABELS[p.loader] + " " + esc(p.mcVersion) + '</td><td class="path-cell">' + esc(p.projectPath) + "</td><td>" + status + '</td><td class="actions"><button class="btn btn-secondary btn-sm" data-act="open" data-vid="' + p.variantId + '">\u8BE6\u60C5</button><button class="btn btn-secondary btn-sm" data-act="relocate" data-vid="' + p.variantId + '">\u6539\u8DEF\u5F84</button><button class="btn btn-danger btn-sm" data-act="remove" data-vid="' + p.variantId + '">\u79FB\u9664</button></td></tr>';
      });
      html += "</tbody></table>";
      wrap.innerHTML = html;
      var byId = {};
      projects.forEach(function(p) {
        byId[p.variantId] = p;
      });
      wrap.querySelectorAll("[data-act]").forEach(function(btn) {
        btn.addEventListener("click", function() {
          var p = byId[btn.dataset.vid];
          if (p) registryAction(btn.dataset.act, p);
        });
      });
    }
    async function loadExternalView() {
      var settings = await api("/api/settings");
      if ($("projects-root")) $("projects-root").value = settings.projectsRoot || "";
      var extra = (settings.scanDirs || []).filter(function(d) {
        return !settings.projectsRoot || d.replace(/\\/g, "/").toLowerCase() !== settings.projectsRoot.replace(/\\/g, "/").toLowerCase();
      });
      renderScanDirList("ext-scan-dirs", extra, settings.projectsRoot);
      await loadRegistry();
    }
    $("modal-close").addEventListener("click", function() {
      closeModal();
    });
    $("modal-overlay")?.addEventListener("click", function(event) {
      if (event.target === $("modal-overlay")) closeModal();
    });
    $("error-close")?.addEventListener("click", hideError);
    document.querySelectorAll(".action-menu button").forEach(function(button) {
      button.addEventListener("click", function() {
        button.closest("details")?.removeAttribute("open");
      });
    });
    document.addEventListener("keydown", function(event) {
      var visibleOverlay = document.querySelector(".modal-overlay.visible");
      if (!visibleOverlay) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (visibleOverlay.id === "build-all-modal") closeBuildAllModal();
        else if (visibleOverlay.id === "modal-overlay") closeModal();
        else visibleOverlay.classList.remove("visible");
        return;
      }
      if (event.key !== "Tab") return;
      var focusable = Array.from(visibleOverlay.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(function(el) {
        return el.offsetParent !== null;
      });
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.querySelectorAll(".nav-btn").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var view = btn.dataset.view;
        if (view === "create") {
          resetCreateWizard();
          showView("create");
          showCreateStep("step-loader");
        } else {
          showView(view);
          if (view === "settings") loadSettings();
          if (view === "external") loadExternalView();
          if (view === "list") loadMods();
        }
      });
    });
    $("detail-back").addEventListener("click", function() {
      state.currentModId = null;
      showView("list");
      loadMods();
    });
    $("btn-new-mod").addEventListener("click", function() {
      document.querySelector('.nav-btn[data-view="create"]').click();
    });
    $("btn-scan").addEventListener("click", async function() {
      try {
        var data = await api("/api/mods/reconcile", { method: "POST", body: {} });
        notify("\u68C0\u6D4B\u5B8C\u6210\uFF1A\u68C0\u67E5 " + data.checked + " \u4E2A\uFF0C\u8DEF\u5F84\u7F3A\u5931 " + data.missing + " \u4E2A\uFF0C\u627E\u56DE " + data.relocated + " \u4E2A");
        loadMods();
      } catch (e) {
        showError(e.message);
      }
    });
    $("btn-scan-import").addEventListener("click", async function() {
      try {
        var data = await api("/api/mods/scan", { method: "POST", body: {} });
        notify("\u626B\u63CF\u5B8C\u6210\uFF1A\u65B0\u5BFC\u5165 " + data.imported + " \u4E2A\uFF0C\u8DF3\u8FC7 " + data.skipped + " \u4E2A");
        loadMods();
      } catch (e) {
        showError(e.message);
      }
    });
    $("btn-purge").addEventListener("click", async function() {
      if (!await confirmAction({ title: "\u6E05\u7406\u5931\u6548\u767B\u8BB0", message: "\u79FB\u9664\u6240\u6709\u8DEF\u5F84\u5DF2\u7ECF\u4E0D\u5B58\u5728\u7684\u9879\u76EE\u767B\u8BB0\uFF1F", detail: "\u6B64\u64CD\u4F5C\u4E0D\u4F1A\u5220\u9664\u4EFB\u4F55\u4ECD\u5B58\u5728\u7684\u78C1\u76D8\u6587\u4EF6\u3002", confirmLabel: "\u6E05\u7406\u5931\u6548\u9879", danger: true })) return;
      try {
        var data = await api("/api/mods/purge-missing", { method: "POST", body: {} });
        notify("\u5DF2\u6E05\u7406 " + data.removed + " \u4E2A\u5931\u6548\u6761\u76EE");
        loadMods();
      } catch (e) {
        showError(e.message);
      }
    });
    $("btn-delete-mod").addEventListener("click", async function() {
      if (!state.currentModId) return;
      var mod = state.mods.find(function(m) {
        return m.id === state.currentModId;
      });
      if (!mod) return;
      var paths2 = (mod.variants || []).map(function(v) {
        return v.projectPath;
      }).join("\n  \xB7 ");
      var msg = "\u5220\u9664\u6574\u4E2A\u6A21\u7EC4\u300C" + mod.displayName + "\u300D\uFF1F\n\n\u5C06\u5220\u9664 " + mod.variants.length + " \u4E2A\u53D8\u4F53\u7684\u9879\u76EE\u6587\u4EF6\u5939\uFF1A\n  \xB7 " + (paths2 || "(\u65E0\u53D8\u4F53)") + "\n\n\u6B64\u64CD\u4F5C\u4E0D\u53EF\u6062\u590D\u3002";
      if (!await confirmAction({ title: "\u6C38\u4E45\u5220\u9664\u6A21\u7EC4", message: "\u5C06\u5220\u9664\u300C" + mod.displayName + "\u300D\u53CA\u5176 " + mod.variants.length + " \u4E2A\u53D8\u4F53\u9879\u76EE\uFF0C\u6B64\u64CD\u4F5C\u4E0D\u53EF\u6062\u590D\u3002", detail: paths2 || "(\u65E0\u53D8\u4F53\u76EE\u5F55)", confirmLabel: "\u5220\u9664\u6A21\u7EC4\u4E0E\u6587\u4EF6", danger: true })) return;
      try {
        var result = await api("/api/mods/" + state.currentModId, {
          method: "DELETE",
          body: { deleteFiles: true }
        });
        state.currentModId = null;
        invalidateDetailCache();
        showView("list");
        loadMods();
        var deleted = result.fileResult && result.fileResult.deleted ? result.fileResult.deleted.length : 0;
        notify("\u6A21\u7EC4\u5DF2\u5220\u9664\uFF08" + deleted + " \u4E2A\u6587\u4EF6\u5939\u5DF2\u6E05\u9664\uFF09");
      } catch (e) {
        showError("\u5220\u9664\u5931\u8D25\uFF1A" + e.message);
      }
    });
    $("btn-ext-import").addEventListener("click", async function() {
      var pick = await api("/api/select-dir");
      if (!pick.path) return;
      try {
        var result = await api("/api/mods/import", { method: "POST", body: { path: pick.path } });
        loadRegistry();
        loadMods();
        if (result.mod) openDetail(result.mod.id);
        notify("\u9879\u76EE\u5DF2\u5BFC\u5165\u5DE5\u4F5C\u53F0");
      } catch (e) {
        showError("\u5BFC\u5165\u5931\u8D25\uFF1A" + e.message);
      }
    });
    $("btn-ext-scan-all").addEventListener("click", async function() {
      try {
        var data = await api("/api/mods/scan", { method: "POST", body: {} });
        notify("\u626B\u63CF\u5B8C\u6210\uFF1A\u65B0\u5BFC\u5165 " + data.imported + " \u4E2A\uFF0C\u8DF3\u8FC7 " + data.skipped + " \u4E2A");
        loadRegistry();
        loadMods();
      } catch (e) {
        showError(e.message);
      }
    });
    $("btn-ext-purge").addEventListener("click", async function() {
      if (!await confirmAction({ title: "\u6E05\u7406\u5931\u6548\u767B\u8BB0", message: "\u79FB\u9664\u6240\u6709\u8DEF\u5F84\u5DF2\u7ECF\u4E0D\u5B58\u5728\u7684\u9879\u76EE\u767B\u8BB0\uFF1F", detail: "\u6B64\u64CD\u4F5C\u4E0D\u4F1A\u5220\u9664\u4EFB\u4F55\u4ECD\u5B58\u5728\u7684\u78C1\u76D8\u6587\u4EF6\u3002", confirmLabel: "\u6E05\u7406\u5931\u6548\u9879", danger: true })) return;
      var data = await api("/api/mods/purge-missing", { method: "POST", body: {} });
      notify("\u5DF2\u6E05\u7406 " + data.removed + " \u4E2A\u5931\u6548\u6761\u76EE");
      loadRegistry();
      loadMods();
    });
    $("btn-ext-add-dir").addEventListener("click", async function() {
      var pick = await api("/api/select-dir");
      if (!pick.path) return;
      await addScanDirAndOptionalScan(pick.path, true);
      loadExternalView();
      loadSettings();
      notify("\u76D1\u89C6\u76EE\u5F55\u5DF2\u6DFB\u52A0\u5E76\u626B\u63CF");
    });
    $("btn-import").addEventListener("click", async function() {
      var pick = await api("/api/select-dir");
      if (!pick.path) return;
      try {
        var result = await api("/api/mods/import", { method: "POST", body: { path: pick.path } });
        if (result.mod) openDetail(result.mod.id);
        else loadMods();
        notify("\u9879\u76EE\u5DF2\u5BFC\u5165\u5DE5\u4F5C\u53F0");
      } catch (e) {
        showError("\u5BFC\u5165\u5931\u8D25\uFF1A" + e.message);
      }
    });
    $("btn-export").addEventListener("click", async function() {
      var data = await api("/api/export/catalog", { method: "POST", body: {} });
      notify("\u76EE\u5F55\u5DF2\u5BFC\u51FA\u5230\uFF1A" + data.path);
    });
    var buildAllPendingMod = null;
    var buildAllReturnFocus = null;
    function filterVariantsForBuildAll(mod, opts) {
      return (mod.variants || []).filter(function(v) {
        if (opts.loader && v.loader !== opts.loader) return false;
        if (opts.failedOnly && v.buildStatus !== "failed") return false;
        return true;
      });
    }
    function openBuildAllModal(mod) {
      buildAllReturnFocus = document.activeElement;
      buildAllPendingMod = mod;
      var failedOnlyEl = $("build-all-failed-only");
      var loaderEl = $("build-all-loader");
      if (failedOnlyEl) failedOnlyEl.checked = false;
      if (loaderEl) loaderEl.value = "";
      refreshBuildAllModalList();
      $("build-all-modal")?.classList.add("visible");
      requestAnimationFrame(function() {
        $("build-all-failed-only")?.focus();
      });
    }
    function closeBuildAllModal() {
      buildAllPendingMod = null;
      $("build-all-modal")?.classList.remove("visible");
      buildAllReturnFocus?.focus();
      buildAllReturnFocus = null;
    }
    function refreshBuildAllModalList() {
      if (!buildAllPendingMod) return;
      var failedOnlyEl = $("build-all-failed-only");
      var loaderEl = $("build-all-loader");
      var opts = {
        failedOnly: !!(failedOnlyEl && failedOnlyEl.checked),
        loader: loaderEl ? loaderEl.value : ""
      };
      var variants = filterVariantsForBuildAll(buildAllPendingMod, opts);
      var summary = $("build-all-summary");
      var list = $("build-all-list");
      if (summary) {
        summary.textContent = variants.length ? "\u5C06\u4E3A\u300C" + buildAllPendingMod.displayName + "\u300D\u6784\u5EFA " + variants.length + " \u4E2A\u53D8\u4F53\uFF08\u6309 CPU \u6838\u6570\u5E76\u884C\uFF09\uFF1A" : "\u5F53\u524D\u7B5B\u9009\u6761\u4EF6\u4E0B\u6CA1\u6709\u53EF\u6784\u5EFA\u7684\u53D8\u4F53\u3002";
      }
      if (list) {
        list.innerHTML = "";
        variants.forEach(function(v) {
          var li = document.createElement("li");
          li.textContent = (LOADER_LABELS[v.loader] || v.loader) + " " + v.mcVersion;
          list.appendChild(li);
        });
      }
      var confirmBtn = $("build-all-confirm");
      if (confirmBtn) confirmBtn.disabled = variants.length === 0;
    }
    async function confirmBuildAll() {
      if (!buildAllPendingMod || !state.currentModId) return;
      var modName = String(buildAllPendingMod.displayName || "\u6A21\u7EC4");
      var failedOnlyEl = $("build-all-failed-only");
      var loaderEl = $("build-all-loader");
      var body = { runClient: false };
      if (failedOnlyEl && failedOnlyEl.checked) body.failedOnly = true;
      if (loaderEl && loaderEl.value) body.loader = loaderEl.value;
      hideError();
      try {
        var result = await api("/api/mods/" + state.currentModId + "/build-all", {
          method: "POST",
          body
        });
        closeBuildAllModal();
        if (result.jobIds && result.jobIds.length) {
          state.buildBatch = {
            modId: state.currentModId,
            modName,
            jobIds: result.jobIds,
            done: {}
          };
        }
        updateQueueBar();
        invalidateDetailCache(state.currentModId);
        await refreshDetail({ force: true });
        var skipped = result.skipped || {};
        var extra = [];
        if (skipped.queued) extra.push(skipped.queued + " \u4E2A\u5DF2\u5728\u961F\u5217");
        if (skipped.missing) extra.push(skipped.missing + " \u4E2A\u8DEF\u5F84\u4E0D\u5B58\u5728");
        var suffix = extra.length ? "\uFF08\u8DF3\u8FC7 " + extra.join("\uFF0C") + "\uFF09" : "";
        notify(result.count + " \u4E2A\u53D8\u4F53\u5DF2\u52A0\u5165\u6784\u5EFA\u961F\u5217" + suffix);
      } catch (e) {
        showError("\u6784\u5EFA\u5168\u90E8\u5931\u8D25\uFF1A" + e.message);
      }
    }
    $("btn-build-all").addEventListener("click", async function() {
      if (!state.currentModId) return;
      var mod = state.detailCache[state.currentModId]?.mod || state.mods.find(function(m) {
        return m.id === state.currentModId;
      });
      if (!mod) {
        try {
          var data = await api("/api/mods/" + state.currentModId);
          mod = data.mod;
        } catch (e) {
          showError("\u52A0\u8F7D\u6A21\u7EC4\u4FE1\u606F\u5931\u8D25\uFF1A" + e.message);
          return;
        }
      }
      if (!mod.variants || !mod.variants.length) {
        notify("\u6682\u65E0\u53D8\u4F53\u53EF\u6784\u5EFA");
        return;
      }
      openBuildAllModal(mod);
    });
    $("build-all-cancel")?.addEventListener("click", closeBuildAllModal);
    $("build-all-confirm")?.addEventListener("click", function() {
      void confirmBuildAll();
    });
    $("build-all-failed-only")?.addEventListener("change", refreshBuildAllModalList);
    $("build-all-loader")?.addEventListener("change", refreshBuildAllModalList);
    $("build-all-modal")?.addEventListener("click", function(e) {
      if (e.target === $("build-all-modal")) closeBuildAllModal();
    });
    $("btn-add-variant").addEventListener("click", function() {
      notify("\u5728\u652F\u6301\u77E9\u9635\u9009\u62E9 \u2192 \u5355\u5143\u683C\u5373\u53EF\u751F\u6210\u53D8\u4F53");
    });
    $("search-mods").addEventListener("input", function() {
      state.search = $("search-mods").value.trim();
      renderModList();
    });
    document.querySelectorAll(".filter-chip").forEach(function(chip) {
      if (chip.hasAttribute("data-loader-filter") || chip.hasAttribute("data-matrix-filter")) return;
      chip.addEventListener("click", function() {
        document.querySelectorAll("[data-filter]").forEach(function(c) {
          c.classList.remove("active");
        });
        chip.classList.add("active");
        state.filter = chip.dataset.filter;
        renderModList();
      });
    });
    document.querySelectorAll("[data-loader-filter]").forEach(function(chip) {
      chip.addEventListener("click", function() {
        document.querySelectorAll("[data-loader-filter]").forEach(function(c) {
          c.classList.remove("active");
        });
        chip.classList.add("active");
        state.loaderFilter = chip.dataset.loaderFilter || "all";
        renderModList();
      });
    });
    document.querySelectorAll("[data-matrix-filter]").forEach(function(chip) {
      chip.addEventListener("click", function() {
        document.querySelectorAll("[data-matrix-filter]").forEach(function(c) {
          c.classList.remove("active");
        });
        chip.classList.add("active");
        state.matrixFilter = chip.dataset.matrixFilter || "all";
        if (state.currentModId && state.detailCache[state.currentModId]) {
          var cached = state.detailCache[state.currentModId];
          renderMatrix(cached.mod, cached.matrix);
        }
      });
    });
    $("empty-primary")?.addEventListener("click", function() {
      var action = $("empty-primary").dataset.emptyAction;
      if (action === "create") $("btn-new-mod")?.click();
      else if (action === "clear-search") {
        state.search = "";
        var input = $("search-mods");
        if (input) input.value = "";
        renderModList();
      } else if (action === "reset-filters") {
        state.filter = "all";
        state.loaderFilter = "all";
        document.querySelectorAll("[data-filter], [data-loader-filter]").forEach(function(el) {
          el.classList.toggle("active", el.dataset.filter === "all" || el.dataset.loaderFilter === "all");
        });
        renderModList();
      }
    });
    $("empty-secondary")?.addEventListener("click", function() {
      $("btn-import")?.click();
    });
    document.addEventListener("keydown", function(event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        showView("list");
        $("search-mods")?.focus();
      }
    });
    $("queue-cancel").addEventListener("click", async function() {
      try {
        await api("/api/queue/cancel", { method: "POST" });
        updateQueueBar();
        await loadMods();
        if (state.currentModId) {
          invalidateDetailCache(state.currentModId);
          await refreshDetail({ force: true });
        }
        notify("\u5DF2\u53D6\u6D88\u5F53\u524D\u4EFB\u52A1\u5E76\u6E05\u7A7A\u961F\u5217");
      } catch (e) {
        showError("\u53D6\u6D88\u5931\u8D25\uFF1A" + e.message);
      }
    });
    $("btn-add-scan-dir").addEventListener("click", async function() {
      var pick = await api("/api/select-dir");
      if (!pick.path) return;
      await addScanDirAndOptionalScan(pick.path, true);
      loadSettings();
      loadMods();
      notify("\u76D1\u89C6\u76EE\u5F55\u5DF2\u6DFB\u52A0\u5E76\u626B\u63CF");
    });
    $("btn-settings-refresh-versions")?.addEventListener("click", function() {
      void refreshAllMetaFromSettings();
    });
    $("btn-settings-refresh-mappings")?.addEventListener("click", function() {
      void refreshAllMappingsFromSettings();
    });
    initCreateWizard();
    loadMods();
    loadDefaultDir();
    updateQueueBar();
    console.log("[dmcl] Workbench ready");
  }
  var init_boot = __esm({
    "gui/renderer-src/boot.ts"() {
      "use strict";
      init_state();
      init_constants();
      init_dom();
      init_icons();
      init_api();
    }
  });

  // gui/renderer-src/main.ts
  var require_main = __commonJS({
    "gui/renderer-src/main.ts"() {
      init_boot();
      bootWorkbench();
    }
  });
  require_main();
})();
