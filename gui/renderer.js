/**
 * DMCL 工作台 — 模组列表、详情矩阵、变体构建、新建向导
 */
(function () {
  "use strict";

  var LOADERS = [
    { id: "fabric", label: "Fabric", icon: "Fa", hint: "轻量、更新快" },
    { id: "neoforge", label: "NeoForge", icon: "NF", hint: "现代分支" },
    { id: "forge", label: "Forge", icon: "Fo", hint: "经典生态" },
  ];

  var LOADER_LABELS = { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge" };
  var STATUS_LABELS = { active: "开发中", paused: "暂停", released: "已发布" };

  var state = {
    mods: [],
    currentModId: null,
    filter: "all",
    search: "",
    selectedLoader: "",
    selectedMc: "",
    selectedMappings: "",
    modidTouched: false,
    groupTouched: false,
    generationCancelled: false,
    activeAbort: null,
    nameComposing: false,
    dirTouched: false,
  };

  var pathRefreshTimer = null;

  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    var box = $("error-box");
    var txt = $("error-text");
    if (txt) txt.textContent = msg;
    if (box) box.style.display = "block";
  }

  function hideError() {
    var box = $("error-box");
    if (box) box.style.display = "none";
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function notify(message) {
    var stack = $("toast-stack");
    if (!stack) {
      console.log("[dmcl]", message);
      return;
    }
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-4px)";
      toast.style.transition = "opacity 0.18s ease, transform 0.18s ease";
      setTimeout(function () { toast.remove(); }, 200);
    }, 3200);
  }

  function renderWorkbenchStats() {
    var totalVariants = 0;
    var builtVariants = 0;
    var loaders = {};
    state.mods.forEach(function (mod) {
      (mod.variants || []).forEach(function (variant) {
        totalVariants++;
        if (variant.buildStatus === "success") builtVariants++;
        loaders[variant.loader] = true;
      });
    });
    var loaderNames = Object.keys(loaders).map(function (id) {
      return LOADER_LABELS[id] || id;
    });
    setText("stat-mods", String(state.mods.length));
    setText("stat-variants", String(totalVariants));
    setText("stat-build-health", builtVariants + "/" + totalVariants);
    setText("stat-loaders", loaderNames.length ? loaderNames.join(" / ") : "-");
    setText("sidebar-status", state.mods.length ? state.mods.length + " 个模组就绪" : "工作台就绪");
  }

  function showView(name) {
    document.body.dataset.view = name;
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + name);
    });
    document.querySelectorAll(".nav-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.view === name);
    });
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    }).then(function (r) {
      if (opts.expectText) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r;
      }
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || ("HTTP " + r.status));
        return data;
      });
    });
  }

  // ============ 模组列表 ============

  async function loadMods() {
    try {
      var data = await api("/api/mods");
      state.mods = data.mods || [];
      renderWorkbenchStats();
      renderModList();
    } catch (e) {
      showError("加载模组列表失败：" + e.message);
    }
  }

  function variantSummary(mod) {
    return mod.variants.map(function (v) {
      return LOADER_LABELS[v.loader] + " " + v.mcVersion;
    }).join(" · ");
  }

  function buildHealth(mod) {
    var total = mod.variants.length;
    if (total === 0) return "无变体";
    var ok = mod.variants.filter(function (v) { return v.buildStatus === "success"; }).length;
    return ok + "/" + total + " 变体已构建";
  }

  function lastBuilt(mod) {
    var times = mod.variants
      .filter(function (v) { return v.lastBuiltAt; })
      .map(function (v) { return new Date(v.lastBuiltAt).getTime(); });
    if (!times.length) return "从未构建";
    var latest = Math.max.apply(null, times);
    var diff = Date.now() - latest;
    if (diff < 3600000) return "上次构建 " + Math.round(diff / 60000) + " 分钟前";
    if (diff < 86400000) return "上次构建 " + Math.round(diff / 3600000) + " 小时前";
    return "上次构建 " + Math.round(diff / 86400000) + " 天前";
  }

  function renderModList() {
    var grid = $("mod-grid");
    var empty = $("empty-state");
    if (!grid) return;

    var filtered = state.mods.filter(function (m) {
      if (state.filter !== "all" && m.status !== state.filter) return false;
      if (state.search) {
        var q = state.search.toLowerCase();
        return m.displayName.toLowerCase().indexOf(q) >= 0 || m.modId.indexOf(q) >= 0;
      }
      return true;
    });

    grid.innerHTML = "";
    if (!filtered.length) {
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";

    filtered.forEach(function (mod) {
      var card = document.createElement("div");
      card.className = "mod-card";
      card.innerHTML =
        '<div class="mod-card-top">' +
          '<div><h3>' + esc(mod.displayName) + '</h3>' +
          '<div class="variants-summary">' + esc(variantSummary(mod) || "暂无变体") + '</div>' +
          '<div class="meta">' + buildHealth(mod) + ' · ' + lastBuilt(mod) + '</div></div>' +
          '<span class="badge badge-' + mod.status + '">' + STATUS_LABELS[mod.status] + '</span>' +
        '</div>';
      card.addEventListener("click", function () { openDetail(mod.id); });
      grid.appendChild(card);
    });
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ============ 模组详情 ============

  async function openDetail(modId) {
    state.currentModId = modId;
    showView("detail");
    await refreshDetail();
  }

  async function refreshDetail() {
    var modId = state.currentModId;
    if (!modId) return;

    try {
      var modData = await api("/api/mods/" + modId);
      var mod = modData.mod;
      var matrixData = await api("/api/mods/" + modId + "/matrix");

      $("detail-name").textContent = mod.displayName;
      $("detail-meta").innerHTML =
        '<span>modId: ' + esc(mod.modId) + '</span>' +
        '<span>状态: ' + STATUS_LABELS[mod.status] + '</span>' +
        '<span>变体: ' + mod.variants.length + '</span>';

      renderMatrix(mod, matrixData);
      renderVariantList(mod);
    } catch (e) {
      showError("加载详情失败：" + e.message);
    }
  }

  function cellLabel(status) {
    if (status === "built") return "✓";
    if (status === "failed") return "×";
    if (status === "building") return "…";
    if (status === "exists") return "◆";
    if (status === "available") return "→";
    return "-";
  }

  function renderMatrix(mod, matrix) {
    var wrap = $("matrix-wrap");
    var table = document.createElement("table");
    table.className = "matrix";

    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    hr.innerHTML = '<th class="row-head">加载器</th>';
    matrix.versions.forEach(function (v) {
      var th = document.createElement("th");
      th.textContent = v;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    matrix.loaders.forEach(function (ldr) {
      var tr = document.createElement("tr");
      var th = document.createElement("th");
      th.className = "row-head";
      th.textContent = ldr.label;
      tr.appendChild(th);

      matrix.versions.forEach(function (ver) {
        var cell = matrix.cells.find(function (c) {
          return c.loader === ldr.id && c.mcVersion === ver;
        });
        var td = document.createElement("td");
        var status = cell ? cell.status : "unsupported";
        td.className = "cell-" + status;
        td.textContent = cellLabel(status);
        td.title = ldr.label + " " + ver + " — " + status;

        if (status === "built" || status === "failed" || status === "exists") {
          td.addEventListener("click", function () {
            scrollToVariant(cell.variantId);
          });
        } else if (status === "available") {
          td.addEventListener("click", function () {
            generateVariantFromMatrix(mod, ldr.id, ver);
          });
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.innerHTML = "";
    wrap.appendChild(table);
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
      showError("请先有至少一个变体作为源码来源");
      return;
    }

    if (!confirm("将从 " + LOADER_LABELS[source.loader] + " " + source.mcVersion +
        " 复制源码，生成 " + LOADER_LABELS[loader] + " " + mc + " 变体并加入构建队列？")) {
      return;
    }

    hideError();
    showModal("生成变体", "正在生成…");

    try {
      var resp = await fetch("/api/mods/" + mod.id + "/variants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceVariantId: source.id,
          targetLoader: loader,
          targetMc: mc,
          autoBuild: true,
        }),
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
        lines.forEach(function (line) {
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

      if (exitCode !== 0) throw new Error("生成失败（退出码 " + exitCode + "）");

      await loadMods();
      await refreshDetail();
      updateQueueBar();
      notify("变体已加入构建队列");
    } catch (e) {
      showError("生成变体失败：" + e.message);
    }
  }

  function renderVariantList(mod) {
    var list = $("variant-list");
    list.innerHTML = "";

    if (!mod.variants.length) {
      list.innerHTML = '<div class="empty-state" style="display:block;padding:24px">暂无变体；可在矩阵中选择 → 生成</div>';
      return;
    }

    mod.variants.forEach(function (v) {
      var item = document.createElement("div");
      item.className = "variant-item";
      item.dataset.variantId = v.id;

      var statusText = v.pathMissing ? "目录缺失"
        : v.buildStatus === "success" ? "构建成功"
        : v.buildStatus === "failed" ? "构建失败"
        : v.buildStatus === "building" ? "构建中" : "未构建";

      var missingBtn = v.pathMissing
        ? '<button class="btn btn-primary btn-sm" data-action="relocate">重新定位</button>'
        : "";

      item.innerHTML =
        '<div class="variant-item-header">' +
          '<div><h4>' + LOADER_LABELS[v.loader] + ' ' + esc(v.mcVersion) + ' · v' + esc(v.modVersion) + '</h4>' +
          '<div class="path">' + esc(v.projectPath) + '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);margin-top:4px">' + statusText + '</div></div>' +
        '</div>' +
        '<div class="variant-actions">' +
          '<button class="btn btn-primary btn-sm" data-action="build">构建</button>' +
          '<button class="btn btn-secondary btn-sm" data-action="run">启动客户端</button>' +
          '<button class="btn btn-secondary btn-sm" data-action="folder">打开文件夹</button>' +
          '<button class="btn btn-secondary btn-sm" data-action="cursor">Cursor 打开</button>' +
          '<button class="btn btn-secondary btn-sm" data-action="logs">查看日志</button>' +
          missingBtn +
          '<button class="btn btn-danger btn-sm" data-action="remove">移除</button>' +
        '</div>';

      item.querySelectorAll("[data-action]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
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
      await refreshDetail();
      notify("构建任务已加入队列");
    } else if (action === "run") {
      await api("/api/variants/" + variant.id + "/run", { method: "POST" });
      updateQueueBar();
      notify("客户端启动任务已加入队列");
    } else if (action === "folder") {
      await api("/api/open-folder", { method: "POST", body: { path: variant.projectPath } });
      notify("已请求打开项目文件夹");
    } else if (action === "cursor") {
      await api("/api/open-cursor", { method: "POST", body: { path: variant.projectPath } });
      notify("已请求用 Cursor 打开项目");
    } else if (action === "logs") {
      var logs = await api("/api/variants/" + variant.id + "/logs");
      if (!logs.logs || !logs.logs.length) {
        showModal("构建日志", "暂无日志");
        return;
      }
      var content = await api("/api/logs?path=" + encodeURIComponent(logs.logs[0].path));
      showModal("构建日志 — " + logs.logs[0].name, content.content || "(空)");
    } else if (action === "relocate") {
      var pick = await api("/api/select-dir");
      if (!pick.path) return;
      try {
        await api("/api/variants/" + variant.id + "/path", {
          method: "PATCH",
          body: { path: pick.path },
        });
        await loadMods();
        await refreshDetail();
        notify("项目路径已更新");
      } catch (e) {
        showError("重新定位失败：请选择包含 gradlew 的有效 mod 项目目录");
      }
    } else if (action === "remove") {
      if (!confirm("从工作台移除此变体（不删磁盘文件），且不会被自动扫描重新导入。确定？")) return;
      try {
        await api("/api/mods/" + modId + "/variants/" + variant.id, { method: "DELETE" });
        await loadMods();
        if (state.currentModId === modId) {
          var still = state.mods.find(function (m) { return m.id === modId; });
          if (still) await refreshDetail();
          else { state.currentModId = null; showView("list"); }
        }
        hideError();
        notify("变体已从工作台移除");
      } catch (e) {
        showError("移除失败：" + e.message);
      }
    }
  }

  // ============ 构建队列 ============

  async function updateQueueBar() {
    var bar = $("queue-bar");
    if (!bar) return;
    try {
      var data = await api("/api/queue");
      if (data.running || data.pending > 0) {
        bar.classList.add("visible");
        $("queue-text").textContent = data.running
          ? "正在构建… 队列剩余 " + data.pending + " 项"
          : "队列等待中 " + data.pending + " 项";
        setText("sidebar-status", data.running ? "构建队列运行中" : "队列等待中");
      } else {
        bar.classList.remove("visible");
        renderWorkbenchStats();
      }
    } catch (e) {
      bar.classList.remove("visible");
    }
  }

  if (window.dmclBridge) {
    window.dmclBridge.onBuildEvent(function (event) {
      updateQueueBar();
      if (event.type === "done" && state.currentModId) {
        refreshDetail();
        loadMods();
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

  setInterval(updateQueueBar, 5000);

  // ============ 新建向导 ============

  function nameToModId(name) {
    var s = name.toLowerCase()
      .replace(/[\u4e00-\u9fa5]+/g, "")
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_{2,}/g, "_");
    if (!s || !/^[a-z]/.test(s)) s = "mod" + (s || "");
    s = s.slice(0, 32);
    if (!/^[a-z][a-z0-9_]*$/.test(s)) s = "mymod";
    return s;
  }

  function schedulePathRefresh() {
    if (state.dirTouched) return;
    clearTimeout(pathRefreshTimer);
    pathRefreshTimer = setTimeout(function () {
      refreshDefaultProjectPath();
    }, 200);
  }

  function onDisplayNameChanged() {
    if (!state.modidTouched) {
      var name = $("inp-name").value.trim();
      $("inp-modid").value = name ? nameToModId(name) : "";
    }
    if (!state.groupTouched) {
      var m = $("inp-modid").value.trim() || "mymod";
      $("inp-group").value = "com.example." + m.replace(/_/g, "");
    }
    updateDirPreview();
    schedulePathRefresh();
  }

  function resetCreateWizard() {
    state.modidTouched = false;
    state.groupTouched = false;
    state.dirTouched = false;
    state.nameComposing = false;
    state.selectedLoader = "";
    clearTimeout(pathRefreshTimer);

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

    document.querySelectorAll("#loader-cards .card").forEach(function (c) {
      c.classList.remove("selected");
    });
    var btnNext = $("loader-next");
    if (btnNext) btnNext.disabled = true;
  }

  function updateDirPreview() {
    var el = $("dir-preview");
    var full = $("inp-dir").value.trim();
    if (!full) {
      el.textContent = "结构：dcml/projects/{modId}/{loader}-{版本}/";
      return;
    }
    el.textContent = "将创建在: " + full;
  }

  async function refreshDefaultProjectPath() {
    if (state.dirTouched) return;
    var modId = ($("inp-modid").value.trim() || "mymod");
    if (!state.selectedLoader || !state.selectedMc) return;
    try {
      var q = "/api/paths/default-variant?modId=" + encodeURIComponent(modId) +
        "&loader=" + encodeURIComponent(state.selectedLoader) +
        "&mc=" + encodeURIComponent(state.selectedMc);
      var data = await api(q);
      if (data.path && !state.dirTouched) {
        $("inp-dir").value = data.path;
        updateDirPreview();
      }
    } catch (e) { /* ignore */ }
  }

  function showCreateStep(step) {
    ["step-loader", "step-config", "step-gen"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      var show = id === step;
      el.style.display = show ? "block" : "none";
      el.setAttribute("aria-hidden", show ? "false" : "true");
    });
  }

  function initCreateWizard() {
    var cardsContainer = $("loader-cards");
    var btnNext = $("loader-next");
    cardsContainer.innerHTML = "";

    LOADERS.forEach(function (ldr) {
      var c = document.createElement("div");
      c.className = "card";
      c.setAttribute("role", "button");
      c.setAttribute("tabindex", "0");
      c.innerHTML = '<div class="icon">' + ldr.icon + '</div><div class="label">' + ldr.label + '</div><div class="hint">' + ldr.hint + '</div>';
      function selectLoaderCard() {
        document.querySelectorAll(".card").forEach(function (x) { x.classList.remove("selected"); });
        c.classList.add("selected");
        state.selectedLoader = ldr.id;
        btnNext.disabled = false;
        hideError();
      }
      c.addEventListener("click", selectLoaderCard);
      c.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectLoaderCard();
        }
      });
      cardsContainer.appendChild(c);
    });

    btnNext.addEventListener("click", function () {
      if (!state.selectedLoader) return;
      showCreateStep("step-config");
      loadVersions(state.selectedLoader).then(function () {
        refreshDefaultProjectPath();
        var nameEl = $("inp-name");
        if (nameEl) nameEl.focus();
      });
    });

    $("config-back").addEventListener("click", function () { showCreateStep("step-loader"); });
    $("config-gen").addEventListener("click", startGeneration);

    var nameEl = $("inp-name");
    if (nameEl) {
      nameEl.addEventListener("compositionstart", function () {
        state.nameComposing = true;
      });
      nameEl.addEventListener("compositionend", function () {
        state.nameComposing = false;
        onDisplayNameChanged();
      });
      nameEl.addEventListener("input", function () {
        if (!state.nameComposing) onDisplayNameChanged();
      });
    }

    $("inp-modid").addEventListener("input", function () {
      state.modidTouched = true;
      if (!state.groupTouched) {
        var m = $("inp-modid").value.trim() || "mymod";
        $("inp-group").value = "com.example." + m.replace(/_/g, "");
      }
      updateDirPreview();
      schedulePathRefresh();
    });
    $("inp-group").addEventListener("input", function () { state.groupTouched = true; });
    $("inp-dir").addEventListener("input", function () {
      state.dirTouched = true;
      updateDirPreview();
    });
    $("btn-browse").addEventListener("click", async function () {
      var data = await api("/api/select-dir");
      if (data.path) {
        state.dirTouched = true;
        $("inp-dir").value = data.path;
        updateDirPreview();
      }
    });
    $("sel-mc").addEventListener("change", function () {
      state.selectedMc = $("sel-mc").value;
      refreshMappings();
      refreshDefaultProjectPath();
    });
    $("sel-mappings").addEventListener("change", function () {
      state.selectedMappings = $("sel-mappings").value;
    });
    $("gen-cancel").addEventListener("click", function () {
      state.generationCancelled = true;
      if (state.activeAbort) state.activeAbort.abort();
      fetch("/api/cancel").catch(function () {});
      showCreateStep("step-config");
    });
  }

  async function loadDefaultDir() {
    await refreshDefaultProjectPath();
  }

  async function loadVersions(loader) {
    var sel = $("sel-mc");
    sel.innerHTML = "<option>加载中…</option>";
    sel.disabled = true;
    try {
      var data = await api("/api/versions/" + loader);
      var versions = data.versions || [];
      sel.innerHTML = versions.map(function (v, i) {
        return '<option value="' + v + '">' + v + (i === 0 ? "（最新）" : "") + '</option>';
      }).join("");
      state.selectedMc = versions[0] || "";
      await refreshMappings();
    } catch (e) {
      sel.innerHTML = "<option>加载失败</option>";
    }
    sel.disabled = false;
  }

  async function refreshMappings() {
    var mapSel = $("sel-mappings");
    if (!state.selectedMc || !state.selectedLoader) return;
    mapSel.innerHTML = "<option>检查中…</option>";
    var loader = state.selectedLoader;
    var mc = state.selectedMc;
    var results = { mojmap: true };
    try {
      var parchment = await fetch("https://maven.parchmentmc.org/org/parchmentmc/data/parchment-" + mc + "/maven-metadata.xml");
      results.parchment = parchment.ok;
      if (loader === "fabric") {
        var yarn = await fetch("https://meta.fabricmc.net/v2/versions/yarn/" + mc);
        results.yarn = yarn.ok;
      }
    } catch (e) { /* ignore */ }
    var order = loader === "fabric" ? ["yarn", "mojmap", "parchment"] : ["mojmap", "parchment"];
    var labels = { yarn: "Yarn", mojmap: "MojMap", parchment: "Parchment" };
    var html = "";
    var def = "";
    order.forEach(function (k) {
      if (!results[k]) return;
      html += '<option value="' + k + '">' + labels[k] + '</option>';
      if (!def) def = k;
    });
    mapSel.innerHTML = html;
    state.selectedMappings = def;
    mapSel.value = def;
  }

  function setPhase(phase) {
    var phases = ["phase-gen", "phase-build", "phase-client", "phase-done"];
    phases.forEach(function (id) {
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
      phases.forEach(function (id) { $(id).classList.add("done"); });
    }
  }

  async function startGeneration() {
    var name = $("inp-name").value.trim();
    var modId = $("inp-modid").value.trim();
    var group = $("inp-group").value.trim();
    var mirror = $("chk-mirror").checked;
    var dir = $("inp-dir").value.trim();

    if (!name) { showError("请给模组起个名字"); return; }
    if (!modId) { modId = nameToModId(name); $("inp-modid").value = modId; }
    if (!dir) { showError("项目路径未设置"); return; }
    hideError();
    showCreateStep("step-gen");
    setPhase("gen");
    state.generationCancelled = false;
    state.activeAbort = new AbortController();
    var log = $("gen-log");
    log.innerHTML = "";

    var args = [
      "--yes", "--loader", state.selectedLoader, "--mc", state.selectedMc,
      "--modid", modId, "--name", name, "--group", group, "--dir", dir,
      "--mappings", state.selectedMappings || "mojmap",
    ];
    if (!mirror) args.push("--no-mirror");

    try {
      var resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: args }),
        signal: state.activeAbort.signal,
      });

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var exitCode = null;

      while (true) {
        if (state.generationCancelled) return;
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop() || "";
        lines.forEach(function (line) {
          line = line.trim();
          if (!line) return;
          if (line.indexOf("__EXIT__:") === 0) {
            exitCode = parseInt(line.slice(9), 10);
            return;
          }
          if (line.indexOf("正在验证构建") >= 0) setPhase("build");
          if (line.indexOf("正在启动 Minecraft") >= 0) setPhase("client");
          var div = document.createElement("div");
          if (line.indexOf("失败") >= 0 || line.indexOf("ERROR") >= 0) div.className = "log-err";
          if (line.indexOf("成功") >= 0 || line.indexOf("BUILD SUCCESSFUL") >= 0) div.className = "log-ok";
          div.textContent = line;
          log.appendChild(div);
        });
        log.scrollTop = log.scrollHeight;
      }

      if (exitCode !== 0 && exitCode !== null) throw new Error("退出码 " + exitCode);
      setPhase("done");
      await loadMods();
      showView("list");
      showCreateStep("step-loader");
      notify("模组已创建并完成验证流程");
    } catch (e) {
      if (state.generationCancelled || e.name === "AbortError") return;
      showError("创建失败：" + e.message);
      showCreateStep("step-config");
    }
  }

  // ============ 设置 & 外部项目 ============

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
      list.innerHTML = '<p style="font-size:12px;color:var(--text-dim)">暂无额外监视目录</p>';
      return;
    }
    dirs.forEach(function (dir) {
      var isBuiltin = projectsRoot && dir.replace(/\\/g, "/").toLowerCase()
        === projectsRoot.replace(/\\/g, "/").toLowerCase();
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap";
      row.innerHTML = '<input readonly value="' + esc(dir) + '" style="flex:1;min-width:200px;opacity:0.85;font-size:12px;font-family:Consolas,monospace">';
      if (!isBuiltin) {
        var scanBtn = document.createElement("button");
        scanBtn.className = "btn btn-secondary btn-sm";
        scanBtn.textContent = "扫描";
        scanBtn.addEventListener("click", async function () {
          var r = await api("/api/mods/scan", { method: "POST", body: { path: dir } });
          notify("扫描完成：新导入 " + r.imported + " 个，跳过 " + r.skipped + " 个");
          loadRegistry();
          loadMods();
        });
        row.appendChild(scanBtn);
        var rm = document.createElement("button");
        rm.className = "btn btn-danger btn-sm";
        rm.textContent = "移除";
        rm.addEventListener("click", async function () {
          if (!confirm("移除监视目录「" + dir + "」？\n（不会删除已注册的项目条目，需手动清理）")) return;
          await removeScanDir(dir);
          loadSettings();
          loadExternalView();
        });
        row.appendChild(rm);
      } else {
        var tag = document.createElement("span");
        tag.style.cssText = "font-size:11px;color:var(--success)";
        tag.textContent = "内置";
        row.appendChild(tag);
      }
      list.appendChild(row);
    });
  }

  async function loadSettings() {
    var data = await api("/api/settings");
    $("dmcl-dir").value = data.dmclDir || "";
    if ($("projects-root")) $("projects-root").value = data.projectsRoot || "";
    var extra = (data.scanDirs || []).filter(function (d) {
      return !data.projectsRoot || d.replace(/\\/g, "/").toLowerCase()
        !== data.projectsRoot.replace(/\\/g, "/").toLowerCase();
    });
    renderScanDirList("scan-dirs-list", extra, data.projectsRoot);
  }

  async function registryAction(action, project) {
    if (action === "open") {
      openDetail(project.modUuid);
    } else if (action === "relocate") {
      var pick = await api("/api/select-dir");
      if (!pick.path) return;
      await api("/api/variants/" + project.variantId + "/path", {
        method: "PATCH", body: { path: pick.path },
      });
      loadRegistry();
      loadMods();
    } else if (action === "remove") {
      if (!confirm("移除此项目注册？磁盘文件不会被删除。")) return;
      await api("/api/mods/" + project.modUuid + "/variants/" + project.variantId, { method: "DELETE" });
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
      wrap.innerHTML = '<p style="font-size:13px;color:var(--text-dim);padding:12px 0">暂无已注册项目</p>';
      return;
    }
    var html = '<table class="registry-table"><thead><tr>' +
      '<th>模组</th><th>变体</th><th>路径</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    projects.forEach(function (p) {
      var status = p.pathMissing ? "路径缺失" : (p.isBuiltin ? "内置" : "外部");
      html += '<tr data-vid="' + p.variantId + '">' +
        '<td>' + esc(p.displayName) + '<br><span style="color:var(--text-dim)">' + esc(p.modId) + '</span></td>' +
        '<td>' + LOADER_LABELS[p.loader] + ' ' + esc(p.mcVersion) + '</td>' +
        '<td class="path-cell">' + esc(p.projectPath) + '</td>' +
        '<td>' + status + '</td>' +
        '<td class="actions">' +
          '<button class="btn btn-secondary btn-sm" data-act="open" data-vid="' + p.variantId + '">详情</button>' +
          '<button class="btn btn-secondary btn-sm" data-act="relocate" data-vid="' + p.variantId + '">改路径</button>' +
          '<button class="btn btn-danger btn-sm" data-act="remove" data-vid="' + p.variantId + '">移除</button>' +
        '</td></tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    var byId = {};
    projects.forEach(function (p) { byId[p.variantId] = p; });

    wrap.querySelectorAll("[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var p = byId[btn.dataset.vid];
        if (p) registryAction(btn.dataset.act, p);
      });
    });
  }

  async function loadExternalView() {
    var settings = await api("/api/settings");
    if ($("projects-root")) $("projects-root").value = settings.projectsRoot || "";
    var extra = (settings.scanDirs || []).filter(function (d) {
      return !settings.projectsRoot || d.replace(/\\/g, "/").toLowerCase()
        !== settings.projectsRoot.replace(/\\/g, "/").toLowerCase();
    });
    renderScanDirList("ext-scan-dirs", extra, settings.projectsRoot);
    await loadRegistry();
  }

  // ============ Modal ============

  function showModal(title, content) {
    $("modal-title").textContent = title;
    var log = $("modal-log");
    log.innerHTML = "";
    if (typeof content === "string") {
      content.split("\n").forEach(function (line) {
        var div = document.createElement("div");
        div.textContent = line;
        log.appendChild(div);
      });
    }
    $("modal-overlay").classList.add("visible");
  }

  $("modal-close").addEventListener("click", function () {
    $("modal-overlay").classList.remove("visible");
  });

  // ============ 导航与工具栏 ============

  document.querySelectorAll(".nav-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
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

  $("detail-back").addEventListener("click", function () {
    state.currentModId = null;
    showView("list");
    loadMods();
  });

  $("btn-new-mod").addEventListener("click", function () {
    document.querySelector('.nav-btn[data-view="create"]').click();
  });

  $("btn-scan").addEventListener("click", async function () {
    try {
      var data = await api("/api/mods/reconcile", { method: "POST", body: {} });
      notify("检测完成：检查 " + data.checked + " 个，路径缺失 " + data.missing + " 个，找回 " + data.relocated + " 个");
      loadMods();
    } catch (e) { showError(e.message); }
  });

  $("btn-scan-import").addEventListener("click", async function () {
    try {
      var data = await api("/api/mods/scan", { method: "POST", body: {} });
      notify("扫描完成：新导入 " + data.imported + " 个，跳过 " + data.skipped + " 个");
      loadMods();
    } catch (e) { showError(e.message); }
  });

  $("btn-purge").addEventListener("click", async function () {
    if (!confirm("移除所有路径已失效的项目条目？")) return;
    try {
      var data = await api("/api/mods/purge-missing", { method: "POST", body: {} });
      notify("已清理 " + data.removed + " 个失效条目");
      loadMods();
    } catch (e) { showError(e.message); }
  });

  $("btn-delete-mod").addEventListener("click", async function () {
    if (!state.currentModId) return;
    if (!confirm("删除整个模组及其所有变体注册？磁盘文件不会被删除，且不会自动重新导入。")) return;
    try {
      await api("/api/mods/" + state.currentModId, { method: "DELETE" });
      state.currentModId = null;
      showView("list");
      loadMods();
      notify("模组注册已删除");
    } catch (e) { showError("删除失败：" + e.message); }
  });

  $("btn-ext-import").addEventListener("click", async function () {
    var pick = await api("/api/select-dir");
    if (!pick.path) return;
    try {
      var result = await api("/api/mods/import", { method: "POST", body: { path: pick.path } });
      loadRegistry();
      loadMods();
      if (result.mod) openDetail(result.mod.id);
      notify("项目已导入工作台");
    } catch (e) { showError("导入失败：" + e.message); }
  });

  $("btn-ext-scan-all").addEventListener("click", async function () {
    try {
      var data = await api("/api/mods/scan", { method: "POST", body: {} });
      notify("扫描完成：新导入 " + data.imported + " 个，跳过 " + data.skipped + " 个");
      loadRegistry();
      loadMods();
    } catch (e) { showError(e.message); }
  });

  $("btn-ext-purge").addEventListener("click", async function () {
    if (!confirm("移除所有路径已失效的项目条目？")) return;
    var data = await api("/api/mods/purge-missing", { method: "POST", body: {} });
    notify("已清理 " + data.removed + " 个失效条目");
    loadRegistry();
    loadMods();
  });

  $("btn-ext-add-dir").addEventListener("click", async function () {
    var pick = await api("/api/select-dir");
    if (!pick.path) return;
    await addScanDirAndOptionalScan(pick.path, true);
    loadExternalView();
    loadSettings();
    notify("监视目录已添加并扫描");
  });

  $("btn-import").addEventListener("click", async function () {
    var pick = await api("/api/select-dir");
    if (!pick.path) return;
    try {
      var result = await api("/api/mods/import", { method: "POST", body: { path: pick.path } });
      if (result.mod) openDetail(result.mod.id);
      else loadMods();
      notify("项目已导入工作台");
    } catch (e) { showError("导入失败：" + e.message); }
  });

  $("btn-export").addEventListener("click", async function () {
    var data = await api("/api/export/catalog", { method: "POST", body: {} });
    notify("目录已导出到：" + data.path);
  });

  $("btn-build-all").addEventListener("click", async function () {
    if (!state.currentModId) return;
    await api("/api/mods/" + state.currentModId + "/build-all", {
      method: "POST", body: { runClient: false },
    });
    updateQueueBar();
    refreshDetail();
    notify("全部变体已加入构建队列");
  });

  $("btn-add-variant").addEventListener("click", function () {
    notify("在支持矩阵选择 → 单元格即可生成变体");
  });

  $("search-mods").addEventListener("input", function () {
    state.search = $("search-mods").value.trim();
    renderModList();
  });

  document.querySelectorAll(".filter-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      document.querySelectorAll(".filter-chip").forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      state.filter = chip.dataset.filter;
      renderModList();
    });
  });

  $("queue-cancel").addEventListener("click", async function () {
    await api("/api/queue/cancel", { method: "POST" });
    updateQueueBar();
    notify("构建队列已取消");
  });

  $("btn-add-scan-dir").addEventListener("click", async function () {
    var pick = await api("/api/select-dir");
    if (!pick.path) return;
    await addScanDirAndOptionalScan(pick.path, true);
    loadSettings();
    loadMods();
    notify("监视目录已添加并扫描");
  });

  // ============ Init ============

  initCreateWizard();
  loadMods();
  updateQueueBar();

  console.log("[dmcl] Workbench ready");
})();
