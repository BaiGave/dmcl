import { state, pathRefreshTimer, setPathRefreshTimer } from "./state";
import { LOADERS, LOADER_LABELS, STATUS_LABELS, SIDE_LAYOUT_HINTS, SIDE_LAYOUT_HOVER_TIPS, SIDE_LAYOUT_OPTIONS } from "./constants";
import { $, showError, hideError, setText, notify, showView, esc, showModal, closeModal, confirmAction } from "./dom";
import { hydrateIcons, icon, loaderIcon } from "./icons";
import { api } from "./api";

export function bootWorkbench(): void {

  hydrateIcons();
  initLoaderFilterChips();

  function initLoaderFilterChips() {
    document.querySelectorAll<HTMLElement>("[data-loader-filter]").forEach(function (chip) {
      var loader = chip.dataset.loaderFilter;
      if (!loader || loader === "all") return;
      chip.classList.add("loader-" + loader);
      var label = chip.textContent?.trim() || LOADER_LABELS[loader] || loader;
      chip.innerHTML = loaderIcon(loader) + "<span>" + esc(label) + "</span>";
    });
  }
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion && !sessionStorage.getItem("dmcl:intro-played")) {
    sessionStorage.setItem("dmcl:intro-played", "1");
    requestAnimationFrame(function () {
      document.body.classList.remove("intro-pending");
      document.body.classList.add("intro-running");
      setTimeout(function () { document.body.classList.remove("intro-running"); }, 700);
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
    state.mods.forEach(function (mod) {
      (mod.variants || []).forEach(function (variant) {
        totalVariants++;
        if (variant.buildStatus === "success") builtVariants++;
        if (variant.buildStatus === "failed") failedVariants++;
        if (variant.buildStatus === "building") runningVariants++;
        loaders[variant.loader] = true;
      });
    });
    var loaderNames = Object.keys(loaders).map(function (id) {
      return LOADER_LABELS[id] || id;
    });
    setText("stat-mods", String(state.mods.length));
    setText("stat-variants", String(totalVariants));
    setText("stat-build-health", builtVariants + "/" + totalVariants);
    var healthEl = $("stat-build-health");
    if (healthEl) {
      healthEl.className = "value " + (failedVariants ? "has-failures" : runningVariants ? "is-running" : "is-healthy");
      healthEl.title = builtVariants + " 个就绪 · " + failedVariants + " 个失败 · " + runningVariants + " 个进行中";
    }
    setText("stat-loaders", loaderNames.length ? loaderNames.join(" / ") : "-");
    setText("sidebar-status", state.mods.length ? state.mods.length + " 个模组就绪" : "工作台就绪");
  }

  // ============ 模组列表 ============

  async function loadMods() {
    try {
      var data = await api("/api/mods");
      state.mods = data.mods || [];
      state.modsFetchedAt = Date.now();
      state.mods.forEach(function (m) {
        var cached = state.detailCache[m.id];
        if (!cached) return;
        var oldSig = (cached.mod.variants || []).map(function (v) { return v.id; }).sort().join(",");
        var newSig = (m.variants || []).map(function (v) { return v.id; }).sort().join(",");
        if (oldSig !== newSig) {
          delete state.detailCache[m.id];
          return;
        }
        cached.mod = m;
      });
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

  function buildHealthData(mod) {
    var variants = mod.variants || [];
    var total = variants.length;
    var ready = variants.filter(function (v) { return v.buildStatus === "success"; }).length;
    var failed = variants.filter(function (v) { return v.buildStatus === "failed"; }).length;
    var running = variants.filter(function (v) { return v.buildStatus === "building"; }).length;
    return { total: total, ready: ready, failed: failed, running: running, percent: total ? Math.round(ready / total * 100) : 0 };
  }

  function modInitials(name) {
    var words = String(name || "DM").trim().split(/\s+/).filter(Boolean);
    return (words.length ? words.slice(0, 2).map(function (word) { return word.slice(0, 1); }).join("") : "DM").toUpperCase();
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
      if (state.loaderFilter !== "all" && !(m.variants || []).some(function (v) { return v.loader === state.loaderFilter; })) return false;
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
      var primary = $("empty-primary") as HTMLButtonElement | null;
      var secondary = $("empty-secondary") as HTMLButtonElement | null;
      var illustration = $("empty-illustration") as HTMLImageElement | null;
      var emptyIcon = $("empty-icon") as HTMLElement | null;
      var showGenesis = !state.mods.length;
      if (illustration) illustration.hidden = !showGenesis;
      if (emptyIcon) emptyIcon.hidden = showGenesis;
      if (!state.mods.length) {
        if (title) title.textContent = "开始你的第一个模组";
        if (description) description.textContent = "从模板创建新项目，或导入已有 Gradle 模组。";
        if (primary) { primary.textContent = "新建模组"; primary.dataset.emptyAction = "create"; primary.hidden = false; }
        if (secondary) { secondary.textContent = "导入项目"; secondary.dataset.emptyAction = "import"; secondary.hidden = false; }
      } else if (state.search) {
        if (title) title.textContent = "没有匹配的模组";
        if (description) description.textContent = "换个关键词，或清空搜索后查看全部模组。";
        if (primary) { primary.textContent = "清空搜索"; primary.dataset.emptyAction = "clear-search"; primary.hidden = false; }
        if (secondary) secondary.hidden = true;
      } else {
        if (title) title.textContent = "当前筛选没有结果";
        if (description) description.textContent = "重置状态和加载器筛选后再试。";
        if (primary) { primary.textContent = "重置筛选"; primary.dataset.emptyAction = "reset-filters"; primary.hidden = false; }
        if (secondary) secondary.hidden = true;
      }
      return;
    }
    empty.style.display = "none";

    filtered.forEach(function (mod) {
      var card = document.createElement("article");
      card.className = "mod-card" + (state.currentModId === mod.id ? " selected" : "");
      var health = buildHealthData(mod);
      var variants = (mod.variants || []).slice(0, 3).map(function (v) {
        return '<span class="variant-chip"><i class="loader-mark loader-' + esc(v.loader) + '">' + loaderIcon(v.loader) + '</i>' + esc(LOADER_LABELS[v.loader] + " " + v.mcVersion) + '</span>';
      }).join("");
      var remaining = Math.max(0, (mod.variants || []).length - 3);
      card.innerHTML =
        '<button type="button" class="mod-card-main" aria-label="打开模组 ' + esc(mod.displayName) + '，' + buildHealth(mod) + '">' +
          '<span class="mod-avatar">' + esc(modInitials(mod.displayName)) + '</span>' +
          '<span class="mod-card-content"><span class="mod-title-row"><strong>' + esc(mod.displayName) + '</strong><span class="badge badge-' + mod.status + '">' + STATUS_LABELS[mod.status] + '</span></span>' +
          '<span class="variant-chips">' + (variants || '<span class="variant-chip muted">暂无变体</span>') + (remaining ? '<span class="variant-chip more">+' + remaining + '</span>' : '') + '</span>' +
          '<span class="health-row"><span class="health-track"><i data-health="' + health.percent + '"></i></span><span>' + health.ready + '/' + health.total + ' 就绪' + (health.failed ? ' · ' + health.failed + ' 失败' : '') + (health.running ? ' · ' + health.running + ' 构建中' : '') + '</span></span>' +
          '<span class="last-built">' + icon("clock") + lastBuilt(mod) + '</span></span>' +
          '<span class="card-chevron">' + icon("chevron-left") + '</span>' +
        '</button>';
      var healthBar = card.querySelector<HTMLElement>("[data-health]");
      if (healthBar) healthBar.style.width = health.percent + "%";
      card.querySelector(".mod-card-main")?.addEventListener("click", function () { openDetail(mod.id); });
      grid.appendChild(card);
    });
  }

  // ============ 模组详情 ============

  var DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;

  function invalidateDetailCache(modId) {
    if (modId) delete state.detailCache[modId];
    else state.detailCache = {};
  }

  async function afterVariantRegistryChange(modId, result) {
    invalidateDetailCache(modId);
    if (result && result.mod) {
      var idx = state.mods.findIndex(function (m) { return m.id === modId; });
      if (idx >= 0) state.mods[idx] = result.mod;
    }
    await loadMods();
    if (state.currentModId === modId) {
      var still = state.mods.find(function (m) { return m.id === modId; });
      if (still) await refreshDetail({ force: true });
      else { state.currentModId = null; showView("list"); }
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
      countEl.innerHTML = '<span class="matrix-loading-pill"><span class="spinner spinner-xs" aria-hidden="true"></span>'
        + esc(label || "加载中…") + "</span>";
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
    title = title || "加载版本矩阵…";
    subtitle = subtitle || "正在读取支持的 Minecraft 版本与 loader 组合";
    var wrap = $("matrix-wrap");
    if (!wrap) return;
    wrap.setAttribute("aria-busy", "true");
    wrap.innerHTML =
      '<div class="matrix-loading" role="status" aria-live="polite">'
      + '<div class="matrix-loading-head">'
      + '<span class="spinner" aria-hidden="true"></span>'
      + '<div class="matrix-loading-copy"><strong>' + esc(title) + "</strong>"
      + "<span>" + esc(subtitle) + "</span></div>"
      + "</div>"
      + '<div class="matrix-loading-progress" aria-hidden="true"><span></span></div>'
      + buildMatrixSkeletonHtml()
      + "</div>";
    setMatrixLoadingMeta(true, "加载中…");
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
    return '<div class="matrix-skeleton" aria-hidden="true"><table><thead>' + head
      + "</thead><tbody>" + body + "</tbody></table></div>";
  }

  function clearMatrixLoadingMeta() {
    var wrap = $("matrix-wrap");
    if (wrap) wrap.removeAttribute("aria-busy");
    setMatrixLoadingMeta(false);
    setMatrixRefreshing(false);
  }

  function renderDetailContent(mod, matrix) {
    $("detail-name").textContent = mod.displayName;
    $("detail-meta").innerHTML =
      '<span>modId: ' + esc(mod.modId) + '</span>' +
      '<span>状态: ' + STATUS_LABELS[mod.status] + '</span>' +
      '<span>变体: ' + mod.variants.length + '</span>';
    renderMatrix(mod, matrix);
    renderVariantList(mod);
    updateBuildAllButton(mod);
  }

  function countBuildableVariants(mod, opts) {
    opts = opts || {};
    var count = 0;
    (mod.variants || []).forEach(function (v) {
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
      btn.title = "暂无变体可构建";
      return;
    }
    var buildable = countBuildableVariants(mod, {});
    btn.disabled = buildable === 0;
    btn.title = buildable
      ? "将 " + buildable + " 个变体依次加入构建队列"
      : "暂无变体可构建";
  }

  function showDetailPlaceholder(modId) {
    var fromList = state.mods.find(function (m) { return m.id === modId; });
    $("detail-name").textContent = fromList ? fromList.displayName : "加载中…";
    $("detail-meta").innerHTML = fromList
      ? '<span>modId: ' + esc(fromList.modId) + '</span><span>加载详情…</span>'
      : '<span>加载中…</span>';
    renderMatrixLoading("加载版本矩阵…", "正在读取模组详情与支持矩阵");
    $("variant-list").innerHTML = '<p class="muted-placeholder inline-empty">加载变体列表…</p>';
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
        setMatrixLoadingMeta(true, "刷新中…");
      } else {
        renderMatrixLoading("加载版本矩阵…", "正在组装支持矩阵（优先使用本地元数据缓存）");
      }
    }

    try {
      var detailData = await api("/api/mods/" + modId + "/detail");
      if (requestId !== state.detailRequestId || modId !== state.currentModId) return;

      var modData = { mod: detailData.mod };
      var matrixData = detailData.matrix;

      state.detailCache[modId] = {
        mod: modData.mod,
        matrix: matrixData,
        fetchedAt: Date.now(),
      };

      var idx = state.mods.findIndex(function (m) { return m.id === modId; });
      if (idx >= 0) state.mods[idx] = modData.mod;

      clearMatrixLoadingMeta();
      renderDetailContent(modData.mod, matrixData);
    } catch (e) {
      if (requestId !== state.detailRequestId) return;
      clearMatrixLoadingMeta();
      showError("加载详情失败：" + e.message);
    }
  }

  function cellLabel(status) {
    if (status === "built") return "已构建";
    if (status === "failed") return "失败";
    if (status === "building") return "构建中";
    if (status === "exists") return "已存在";
    if (status === "available") return "可创建";
    return "不支持";
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
      th.className = "row-head loader-row-head loader-" + ldr.id;
      th.innerHTML = loaderIcon(ldr.id) + '<span>' + esc(ldr.label) + '</span>';
      tr.appendChild(th);

      matrix.versions.forEach(function (ver) {
        var cell = matrix.cells.find(function (c) {
          return c.loader === ldr.id && c.mcVersion === ver;
        });
        var td = document.createElement("td");
        var status = cell ? cell.status : "unsupported";
        td.className = "cell-" + status;
        var matrixMatches = state.matrixFilter === "all"
          || (state.matrixFilter === "available" && status === "available")
          || (state.matrixFilter === "failed" && status === "failed")
          || (state.matrixFilter === "existing" && (status === "built" || status === "exists" || status === "building"));
        if (!matrixMatches) td.classList.add("matrix-muted");
        var actionButton = document.createElement("button");
        actionButton.type = "button";
        actionButton.className = "matrix-cell";
        actionButton.innerHTML = '<span class="matrix-dot" aria-hidden="true"></span><span>' + cellLabel(status) + '</span>';
        actionButton.setAttribute("aria-label", ldr.label + " " + ver + "，" + cellLabel(status));
        actionButton.disabled = status === "unsupported" || status === "building";
        td.title = ldr.label + " " + ver + " — " + cellLabel(status);

        if (status === "built" || status === "failed" || status === "exists") {
          actionButton.addEventListener("click", function () {
            scrollToVariant(cell.variantId);
          });
        } else if (status === "available") {
          actionButton.addEventListener("click", function () {
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
      countEl.textContent = matrix.versions.length + " 个版本 · 可横向滚动";
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

  function pickSourceVariantForMc(mod, mcVersion) {
    return (mod.variants || []).find(function (v) { return v.mcVersion === mcVersion; }) || pickSourceVariant(mod);
  }

  async function consumeVariantGenerationStream(resp) {
    if (!resp.ok) {
      var errText = "";
      try { errText = await resp.text(); } catch { /* ignore */ }
      throw new Error(errText || "HTTP " + resp.status);
    }
    if (!resp.body) throw new Error("服务器未返回流式响应");

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var exitCode = 0;
    var lastErrorLine = "";

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(function (line) {
        if (!line.trim()) return;
        if (line.indexOf("__EXIT__:") === 0) {
          exitCode = parseInt(line.slice(9), 10);
          return;
        }
        if (line.indexOf("__") === 0) return;
        if (line.indexOf("错误：") === 0) lastErrorLine = line.slice(3);
      });
    }

    if (exitCode !== 0 && lastErrorLine) throw new Error(lastErrorLine);
    return exitCode;
  }

  async function generateVariantQuiet(mod, loader, mcVersion) {
    var source = pickSourceVariantForMc(mod, mcVersion);
    if (!source) throw new Error("没有可用的源变体");

    var resp = await fetch("/api/mods/" + mod.id + "/variants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceVariantId: source.id,
        targetLoader: loader,
        targetMc: mcVersion,
        autoBuild: false,
      }),
    });
    var exitCode = await consumeVariantGenerationStream(resp);
    if (exitCode !== 0) throw new Error("生成失败（退出码 " + exitCode + "）");
  }

  async function generateVariantFromMatrix(mod, loader, mc) {
    var source = pickSourceVariantForMc(mod, mc);
    if (!source) {
      showError("请先有至少一个变体作为源码来源");
      return;
    }

    if (!await confirmAction({
      title: "创建新变体",
      message: "复制现有源码并生成新的加载器变体？",
      detail: LOADER_LABELS[source.loader] + " " + source.mcVersion + "  →  " + LOADER_LABELS[loader] + " " + mc + "\n创建后将自动加入构建队列。",
      confirmLabel: "创建并构建",
    })) {
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

      var log = $("modal-log");
      if (log) log.innerHTML = "";

      var reader = resp.body!.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
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
          if (!log) return;
          var div = document.createElement("div");
          div.textContent = line;
          log.appendChild(div);
        });
        if (log) log.scrollTop = log.scrollHeight;
      }

      if (exitCode !== 0) throw new Error("生成失败（退出码 " + exitCode + "）");

      await loadMods();
      invalidateDetailCache(mod.id);
      await refreshDetail({ force: true });
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
      list.innerHTML = '<div class="empty-state inline-empty">暂无变体；可在矩阵中选择“可创建”单元格生成</div>';
      return;
    }

    mod.variants.forEach(function (v) {
      var item = document.createElement("div");
      item.className = "variant-item status-" + (v.buildStatus || "idle");
      item.dataset.variantId = v.id;

      var statusText = v.buildStatus === "success" ? "就绪"
        : v.buildStatus === "failed" ? "失败"
        : v.buildStatus === "building" ? "任务进行中" : "未验证";

      var missingBtn = "";
      var sourceReady = v.sourceStatus?.ready === true;
      var sourceText = sourceReady
        ? "开发源码已准备 · MC + " + (v.sourceStatus.modCount || 0) + " 个前置"
        : "开发源码尚未准备";

      item.innerHTML =
        '<div class="variant-item-header">' +
          '<span class="loader-badge loader-' + esc(v.loader) + '">' + loaderIcon(v.loader) + '</span>' +
          '<div><h4>' + LOADER_LABELS[v.loader] + ' ' + esc(v.mcVersion) + ' <span>· v' + esc(v.modVersion) + '</span></h4>' +
          '<div class="path" title="' + esc(v.projectPath) + '">' + esc(v.projectPath) + '</div>' +
          '<div class="variant-status"><span class="status-dot"></span>' + statusText + '</div>' +
          '<div class="variant-source-state' + (sourceReady ? ' ready' : '') + '">' + icon("sparkles") + esc(sourceText) + '</div></div>' +
        '</div>' +
        '<div class="variant-actions">' +
          '<button class="btn btn-primary btn-sm" data-action="build">' + icon("build") + '构建</button>' +
          '<button class="btn btn-secondary btn-sm" data-action="run">' + icon("play") + '启动</button>' +
          '<button class="btn btn-secondary btn-sm" data-action="logs">' + icon("terminal") + '日志</button>' +
          '<button class="btn btn-secondary btn-sm btn-prepare-sources" data-action="sources">' + icon(sourceReady ? "folder" : "sparkles") + (sourceReady ? '打开开发源码' : '准备开发源码') + '</button>' +
          '<button class="btn btn-icon" data-action="folder" title="打开项目文件夹" aria-label="打开项目文件夹">' + icon("folder") + '</button>' +
          '<details class="action-menu"><summary class="btn btn-quiet btn-sm" aria-label="更多变体操作">' + icon("more") + '</summary>' +
            '<div class="action-menu-popover">' +
              '<button data-action="cursor">用 Cursor 打开</button>' +
              '<button data-action="relocate">重新定位项目</button>' + missingBtn +
              (sourceReady ? '<button data-action="sources-refresh">重新准备开发源码</button>' : '') +
              '<span class="menu-separator"></span>' +
              '<button data-action="unlink">仅移除登记</button>' +
              '<button class="menu-danger" data-action="delete">删除变体</button>' +
            '</div></details>' +
        '</div>';

      item.querySelectorAll("[data-action]").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          var menu = btn.closest("details");
          if (menu) menu.removeAttribute("open");
          variantAction(mod.id, v, btn.dataset.action);
        });
      });
      list.appendChild(item);
    });
  }

  async function prepareVariantSources(modId, variant, force) {
    hideError();
    showModal("准备开发源码", "正在识别 Minecraft、映射与 Gradle 前置依赖…");
    var cancelButton = $("modal-source-cancel") as HTMLButtonElement | null;
    if (cancelButton) cancelButton.hidden = false;
    try {
      var started = await api("/api/variants/" + variant.id + "/sources", {
        method: "POST",
        body: { force: force === true },
      });
      var taskId = started.task?.id;
      if (!taskId) throw new Error("服务端未返回源码任务");
      while (true) {
        var status = await api("/api/sources/status");
        var task = status.task;
        if (!task || task.id !== taskId) throw new Error("源码任务状态已丢失");
        var log = $("modal-log");
        if (log) {
          var dependencyProgress = task.currentPhase === "dependencies"
            ? (task.dependenciesFound
              ? " · 前置模组 " + (task.dependenciesPrepared || 0) + "/" + task.dependenciesFound
              : " · Gradle 正在解析前置依赖")
            : "";
          var progress = "Minecraft " + task.completed + "/" + task.total
            + (task.currentPhase ? " · " + sourcePhaseLabel(task.currentPhase) : "")
            + dependencyProgress;
          log.textContent = progress + "\n" + (task.logs || []).join("\n");
          log.scrollTop = log.scrollHeight;
        }
        if (task.state !== "running") {
          if (task.state === "completed") {
            await api("/api/open-folder", { method: "POST", body: { path: task.outputPath } });
            invalidateDetailCache(modId);
            await refreshDetail({ force: true });
            showModal(
              "开发源码已准备",
              "项目源码目录：" + task.outputPath + "\nMinecraft 源码与 "
                + (task.dependenciesPrepared || 0) + " 个前置模组源码已就绪。",
            );
            notify("开发源码已准备并打开文件夹", task.dependencyFailures ? "warning" : "success");
          } else if (task.state === "cancelled") {
            notify("源码准备已取消", "warning");
            closeModal();
          } else {
            throw new Error(task.lastError || "源码准备失败");
          }
          break;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 1000); });
      }
    } catch (e) {
      showError("准备开发源码失败：" + (e as Error).message);
      showModal("源码准备失败", (e as Error).message);
    } finally {
      if (cancelButton) cancelButton.hidden = true;
    }
  }

  async function variantAction(modId, variant, action) {
    if (action === "build") {
      await api("/api/variants/" + variant.id + "/build", { method: "POST", body: { runClient: false } });
      updateQueueBar();
      invalidateDetailCache(modId);
      await refreshDetail({ force: true });
      notify("构建任务已加入队列");
    } else if (action === "run") {
      await api("/api/variants/" + variant.id + "/run", { method: "POST" });
      updateQueueBar();
      invalidateDetailCache(modId);
      await refreshDetail({ force: true });
      notify("客户端正在启动，请稍候（首次需下载依赖，游戏窗口打开前队列会显示运行中）");
    } else if (action === "sources") {
      if (variant.sourceStatus?.ready && variant.sourceStatus.rootPath) {
        await api("/api/open-folder", { method: "POST", body: { path: variant.sourceStatus.rootPath } });
        notify("已打开开发源码文件夹");
      } else {
        await prepareVariantSources(modId, variant, false);
      }
    } else if (action === "sources-refresh") {
      await prepareVariantSources(modId, variant, true);
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
      var content = await api("/api/logs?path=" + encodeURIComponent(logs.logs[0].path) + "&variantId=" + encodeURIComponent(variant.id));
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
        invalidateDetailCache(modId);
        await refreshDetail({ force: true });
        notify("项目路径已更新");
      } catch (e) {
        showError("重新定位失败：请选择包含 gradlew 的有效 mod 项目目录");
      }
    } else if (action === "unlink" || action === "remove") {
      if (!await confirmAction({ title: "移除变体登记", message: "仅从工作台移除此变体，磁盘文件会保留。", detail: variant.projectPath, confirmLabel: "移除登记" })) return;
      try {
        var unlinkResult = await api("/api/mods/" + modId + "/variants/" + variant.id, {
          method: "DELETE",
          body: { deleteFiles: false },
        });
        await afterVariantRegistryChange(modId, unlinkResult);
        hideError();
        notify("变体登记已移除");
      } catch (e) {
        showError("移除失败：" + e.message);
      }
    } else if (action === "delete") {
      if (!await confirmAction({ title: "永久删除变体", message: "将删除此变体的整个项目目录，此操作不可恢复。", detail: variant.projectPath, confirmLabel: "删除项目文件", danger: true })) return;
      try {
        var deleteResult = await api("/api/mods/" + modId + "/variants/" + variant.id, {
          method: "DELETE",
          body: { deleteFiles: true },
        });
        await afterVariantRegistryChange(modId, deleteResult);
        hideError();
        notify("变体项目已删除");
      } catch (e) {
        showError("删除失败：" + e.message);
      }
    }
  }

  // ============ 构建队列 ============

  var queueSummaryUntil = 0;

  function burstBuildParticles(target) {
    if (!target || reduceMotion) return;
    var burst = document.createElement("span");
    burst.className = "build-particles";
    for (var i = 0; i < 8; i++) {
      var particle = document.createElement("i");
      particle.style.setProperty("--x", ((i % 4) - 1.5) * 18 + "px");
      particle.style.setProperty("--y", (-18 - (i % 3) * 10) + "px");
      particle.style.setProperty("--delay", (i * 24) + "ms");
      burst.appendChild(particle);
    }
    target.appendChild(burst);
    setTimeout(function () { burst.remove(); }, 650);
  }

  function flashVariant(variantId, failed) {
    var item = document.querySelector<HTMLElement>('[data-variant-id="' + variantId + '"]');
    if (!item) return;
    var className = failed ? "build-result-failed" : "build-result-success";
    item.classList.remove("build-result-failed", "build-result-success");
    requestAnimationFrame(function () {
      item.classList.add(className);
      if (!failed) burstBuildParticles(item.querySelector(".variant-status") || item);
      setTimeout(function () { item.classList.remove(className); }, 900);
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
    setText("queue-text", failed ? "构建完成，但有任务失败" : "构建完成");
    setText("queue-subtext", success + " 个成功" + (failed ? " · " + failed + " 个失败" : " · 所有任务已就绪"));
    notify(success + " 个构建成功" + (failed ? "，" + failed + " 个失败" : ""), failed ? "error" : "success");
    if (!failed) burstBuildParticles(bar.querySelector(".spinner") || bar);
    (summary.failedVariantIds || []).forEach(function (id) { flashVariant(id, true); });
    if (!failed && summary.targetVariantId) flashVariant(summary.targetVariantId, false);
    setTimeout(function () {
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
        var slotInfo = " · 任务 " + active + "/" + jobSlots
          + " · 构建 " + gradleActive + "/" + gradleMax
          + " · 客户端 " + clientActive + "/" + clientMax;
        $("queue-text").textContent = data.running || active > 0
          ? "正在构建" + detail + slotInfo + (pending > 0 ? " · 剩余 " + pending + " 项" : "")
          : "队列等待中 " + pending + " 项";
        setText(
          "queue-subtext",
          data.running || active > 0
            ? "Gradle 与客户端分级限流 · 每槽 Gradle 单 Worker · 物理 CPU " + (data.physicalCores || jobSlots) + " 核"
            : "等待执行槽释放",
        );
        setText("sidebar-status", data.running || active > 0 ? "构建队列运行中" : "队列等待中");
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
    batch.jobIds.forEach(function (id) {
      if (id in batch.done) {
        if (batch.done[id]) success++;
        else failed++;
      } else {
        pending++;
        failed++;
      }
    });
    if (!cancelled && pending > 0) return;
    if (cancelled) notify(batch.modName + " 构建已取消", "warning");
    state.buildBatch = null;
  }

  if (window.dmclBridge) {
    window.dmclBridge.onBuildEvent(function (event) {
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

  setInterval(updateQueueBar, 5000);

  // ============ 新建向导 ============

  function nameToModId(name) {
    var s = name.toLowerCase()
      .replace(/[\u4e00-\u9fa5]+/g, "")
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_{2,}/g, "_");
    if (!s || !/^[a-z]/.test(s)) {
      var hash = 0;
      for (var i = 0; i < name.length; i++) {
        hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
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
    if (state.modidTouched) return ($("inp-modid").value.trim() || "");
    var name = $("inp-name").value.trim();
    if (name) return nameToModId(name);
    return ($("inp-modid").value.trim() || "");
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
    dirEl.placeholder = managed ? "填写模组名字后自动生成" : "自定义项目路径";
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
    state.versionsLoading[loader] = api("/api/versions/" + loader).then(function (data) {
      var versions = data.versions || [];
      state.versionsCache[loader] = versions;
      if (versions[0]) {
        api("/api/mappings/" + loader + "/" + encodeURIComponent(versions[0])).catch(function () {});
      }
      delete state.versionsLoading[loader];
      return versions;
    }).catch(function (e) {
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
    if ($("sel-mappings")) $("sel-mappings").innerHTML = "<option>等待版本加载…</option>";

    document.querySelectorAll("#loader-cards .card").forEach(function (c) {
      c.classList.remove("selected");
      var radio = c.querySelector<HTMLInputElement>("input[type=radio]");
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
      el.textContent = "将创建在: " + full;
      return;
    }
    if (modId && isValidModId(modId) && state.selectedLoader && state.selectedMc) {
      var preview = joinProjectPath(modId, state.selectedLoader, state.selectedMc);
      el.textContent = preview ? "将创建在: " + preview : "结构：projects/{modId}/{loader}-{版本}/";
      return;
    }
    el.textContent = "结构：projects/{modId}/{loader}-{版本}/（填写模组名字后自动更新）";
  }

  async function refreshDefaultProjectPath() {
    if (!state.projectsRoot) {
      try {
        var info = await api("/api/default-dir");
        if (info.projectsRoot) state.projectsRoot = info.projectsRoot;
      } catch (e) { /* ignore */ }
    }
    syncProjectPath();
  }

  function showCreateStep(step) {
    ["step-loader", "step-config", "step-confirm", "step-gen"].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      var show = id === step;
      el.hidden = !show;
      el.setAttribute("aria-hidden", show ? "false" : "true");
    });
    var stage = step.replace("step-", "");
    var order = ["loader", "config", "confirm", "gen"];
    var current = order.indexOf(stage);
    document.querySelectorAll<HTMLElement>("[data-wizard-stage]").forEach(function (item) {
      var index = order.indexOf(item.dataset.wizardStage || "");
      item.classList.toggle("active", index === current);
      item.classList.toggle("done", index >= 0 && index < current);
    });
    window.dmclBridge.onBuildSummary?.(function (summary) {
      showBuildSummaryFeedback(summary);
    });
    window.dmclBridge.onNotificationOpen?.(async function (payload) {
      var variantId = payload && payload.targetVariantId;
      if (!variantId) { showView("list"); return; }
      await loadMods();
      var mod = state.mods.find(function (candidate) {
        return (candidate.variants || []).some(function (variant) { return variant.id === variantId; });
      });
      if (!mod) { showView("list"); return; }
      await openDetail(mod.id);
      requestAnimationFrame(function () { scrollToVariant(variantId); });
    });
  }

  async function showCreateConfirmation() {
    var form = await validateCreateForm();
    if (!form) return;
    if (!state.selectedMappings && !(state.selectedLoader === "fabric" && isUnobfuscatedMc(state.selectedMc))) {
      showError("当前版本暂无可用映射表，请换一个 Minecraft 版本");
      return;
    }
    hideError();
    var summary = $("create-summary");
    if (summary) {
      var rows = [
        ["模组", form.name + "  ·  " + form.modId],
        ["开发环境", (LOADER_LABELS[state.selectedLoader] || state.selectedLoader) + "  ·  Minecraft " + state.selectedMc],
        ["映射", state.selectedMappings || "Mojang 官方映射"],
        ["运行端", sideLayoutSummaryLabel()],
        ["项目目录", $("inp-dir").value.trim()],
        ["镜像", form.mirror ? "使用国内镜像" : "使用官方源"],
      ];
      summary.innerHTML = rows.map(function (row) {
        return '<div><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '</strong></div>';
      }).join("");
    }
    showCreateStep("step-confirm");
  }

  function initCreateWizard() {
    var cardsContainer = $("loader-cards");
    var btnNext = $("loader-next");
    cardsContainer.innerHTML = "";

    LOADERS.forEach(function (ldr) {
      var c = document.createElement("label");
      c.className = "card";
      c.innerHTML = '<input class="sr-only loader-radio" type="radio" name="loader" value="' + ldr.id + '"><span class="loader-card-mark loader-' + ldr.id + '">' + loaderIcon(ldr.id) + '</span><span class="label">' + ldr.label + '</span><span class="hint">' + ldr.hint + '</span><span class="card-check">' + icon("check") + '</span>';
      function selectLoaderCard() {
        document.querySelectorAll(".card").forEach(function (x) { x.classList.remove("selected"); });
        c.classList.add("selected");
        var radio = c.querySelector<HTMLInputElement>("input");
        if (radio) radio.checked = true;
        state.selectedLoader = ldr.id;
        btnNext.disabled = false;
        hideError();
        preloadLoaderData(ldr.id).catch(function () {});
      }
      c.addEventListener("click", selectLoaderCard);
      cardsContainer.appendChild(c);
    });

    btnNext.addEventListener("click", function () {
      if (!state.selectedLoader) return;
      showCreateStep("step-config");
      setDirInputManaged(true);
      var nameEl = $("inp-name");
      if (nameEl) {
        requestAnimationFrame(function () {
          nameEl.focus();
          nameEl.select();
        });
      }
      refreshDefaultProjectPath();
      updateSideLayoutUi();
      loadVersions(state.selectedLoader);
    });

    $("config-back").addEventListener("click", function () { showCreateStep("step-loader"); });
    $("config-gen").addEventListener("click", function () { void showCreateConfirmation(); });
    $("confirm-back").addEventListener("click", function () { showCreateStep("step-config"); });
    $("confirm-create").addEventListener("click", startGeneration);
    $("config-gen-all").addEventListener("click", startGenerationAll);
    $("btn-refresh-versions").addEventListener("click", function () { void refreshMetaVersions(); });
    $("btn-refresh-mappings").addEventListener("click", function () { void forceRefreshMappings(); });

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
        if (state.nameComposing) {
          syncProjectPath();
          updateDirPreview();
        } else {
          onDisplayNameChanged();
        }
      });
    }

    $("inp-modid").addEventListener("input", function () {
      state.modidTouched = true;
      var m = $("inp-modid").value.trim();
      if (!state.groupTouched && m) {
        $("inp-group").value = "com.example." + m.replace(/_/g, "");
      }
      syncProjectPath();
    });
    $("inp-group").addEventListener("input", function () { state.groupTouched = true; });
    $("inp-dir").addEventListener("input", function () {
      state.dirTouched = true;
      setDirInputManaged(false);
      updateDirPreview();
    });
    $("btn-browse").addEventListener("click", async function () {
      var data = await api("/api/select-dir");
      if (data.path) {
        state.dirTouched = true;
        setDirInputManaged(false);
        $("inp-dir").value = data.path;
        updateDirPreview();
      }
    });
    $("sel-mc").addEventListener("change", function () {
      state.selectedMc = $("sel-mc").value;
      syncProjectPath();
      updateMappingsUiForVersion(state.selectedMc);
      updateSideLayoutUi();
      refreshMappings();
    });
    $("sel-mappings").addEventListener("change", function () {
      state.selectedMappings = $("sel-mappings").value;
    });
    var sideLayoutPicker = $("side-layout-picker");
    if (sideLayoutPicker) initSideLayoutPicker(sideLayoutPicker);
    $("gen-cancel").addEventListener("click", function () {
      state.generationCancelled = true;
      if (state.activeAbort) state.activeAbort.abort();
      if (state.batchAbortControllers) {
        state.batchAbortControllers.forEach(function (ac) { ac.abort(); });
        state.batchAbortControllers = null;
      }
      fetch("/api/cancel").catch(function () {});
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

  function supportsSplitSourcesForMc(mc) {
    if (!mc) return false;
    var parts = mc.split(".").map(function (p) { return parseInt(p, 10) || 0; });
    if (parts[0] === 1) return (parts[1] || 0) >= 18;
    return parts[0] >= 18;
  }

  function initSideLayoutPicker(container: HTMLElement) {
    container.innerHTML = "";
    SIDE_LAYOUT_OPTIONS.forEach(function (opt) {
      var label = document.createElement("label");
      label.className = "side-layout-option";
      label.dataset.layout = opt.id;
      var hoverTip = SIDE_LAYOUT_HOVER_TIPS[opt.id] || "";
      label.title = hoverTip;
      label.innerHTML =
        '<input class="sr-only" type="radio" name="side-layout" value="' + esc(opt.id) + '">' +
        '<span class="side-layout-label">' + esc(opt.label) + "</span>" +
        '<span class="side-layout-hover-tip">' + esc(hoverTip) + "</span>";
      label.addEventListener("click", function (e) {
        var splitDisabled = opt.id === "split" && label.classList.contains("is-disabled");
        if (splitDisabled) {
          e.preventDefault();
          return;
        }
        selectSideLayoutOption(opt.id);
      });
      container.appendChild(label);
    });
    selectSideLayoutOption(state.selectedSideLayout || defaultSideLayoutForSelection());
  }

  function selectSideLayoutOption(layoutId: string) {
    state.selectedSideLayout = layoutId;
    document.querySelectorAll(".side-layout-option").forEach(function (node) {
      var el = node as HTMLElement;
      var radio = el.querySelector<HTMLInputElement>('input[type="radio"]');
      var active = el.dataset.layout === layoutId && !el.classList.contains("is-disabled");
      el.classList.toggle("selected", active);
      if (radio) radio.checked = active;
    });
    updateSideLayoutHint();
  }

  function resolveSideLayoutForMc(loader: string, mc: string, requested: string) {
    if (requested === "split" && loader === "fabric" && !supportsSplitSourcesForMc(mc)) return "unified";
    return requested;
  }

  function sideLayoutBatchNote(requested: string, loader: string, versions: string[]) {
    if (requested !== "split" || loader !== "fabric") {
      return "运行端：" + sideLayoutSummaryLabel();
    }
    var fallbackCount = versions.filter(function (mc) {
      return !supportsSplitSourcesForMc(mc);
    }).length;
    if (!fallbackCount) return "运行端：客户端 / 通用分离（全部版本支持）";
    return "运行端：分离（其中 " + fallbackCount + " 个旧版本将自动改为「一起」）";
  }

  function defaultSideLayoutForSelection() {
    return "unified";
  }

  function getSelectedSideLayout() {
    var checked = document.querySelector<HTMLInputElement>('input[name="side-layout"]:checked');
    return checked?.value || state.selectedSideLayout || defaultSideLayoutForSelection();
  }

  function sideLayoutSummaryLabel() {
    var id = getSelectedSideLayout();
    var opt = SIDE_LAYOUT_OPTIONS.find(function (o) { return o.id === id; });
    return opt ? opt.label : id;
  }

  function updateSideLayoutHint() {
    var hint = $("side-layout-hint");
    if (!hint) return;
    var layout = getSelectedSideLayout();
    var text = SIDE_LAYOUT_HINTS[layout] || "";
    if (state.selectedLoader !== "fabric") {
      text += " Forge / NeoForge 使用单一 src/main 源码集；「分离」与「一起」效果相同。";
    } else if (layout === "split" && !supportsSplitSourcesForMc(state.selectedMc)) {
      text += " 当前 Minecraft 版本不支持 Loom 分源，将自动使用单源码集。";
    }
    hint.textContent = text;
  }

  function updateSideLayoutUi() {
    var canSplit = state.selectedLoader === "fabric" && supportsSplitSourcesForMc(state.selectedMc);
    document.querySelectorAll(".side-layout-option").forEach(function (node) {
      var el = node as HTMLElement;
      if (el.dataset.layout !== "split") return;
      el.classList.toggle("is-disabled", !canSplit);
      var radio = el.querySelector<HTMLInputElement>('input[type="radio"]');
      if (radio) radio.disabled = !canSplit;
    });
    if (!canSplit && getSelectedSideLayout() === "split") {
      selectSideLayoutOption("unified");
      return;
    }
    selectSideLayoutOption(getSelectedSideLayout() || defaultSideLayoutForSelection());
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
    var src = fromCache ? "本地缓存" : "联网获取";
    hint.textContent = src + " · 更新于 " + updatedAt.slice(0, 10);
  }

  function applyMappingsData(data) {
    var mapSel = $("sel-mappings");
    if (!mapSel) return;
    var options = data.options || [];
    if (!options.length) {
      mapSel.innerHTML = "<option>此版本暂无可用映射</option>";
      state.selectedMappings = "";
      return;
    }
    var unobfuscated = state.selectedLoader === "fabric" && isUnobfuscatedMc(state.selectedMc);
    mapSel.innerHTML = options.map(function (o) {
      var label = o.label;
      if (o.version) label += " (" + o.version + ")";
      if (o.id === data.default) label += "（推荐）";
      return '<option value="' + o.id + '">' + label + "</option>";
    }).join("");
    state.selectedMappings = data.default || options[0].id;
    mapSel.value = state.selectedMappings;
    mapSel.disabled = unobfuscated;
    var hint = $("mappings-cache-hint");
    if (hint) {
      if (unobfuscated) {
        hint.textContent = "此版本官方未混淆，无需选择 Yarn/Parchment 映射";
      } else {
        var src = data.fromCache ? "本地缓存" : "联网探测";
        var at = data.updatedAt ? data.updatedAt.slice(0, 10) : "";
        hint.textContent = src + (at ? " · 更新于 " + at : "");
      }
    }
    updateMappingsUiForVersion(state.selectedMc);
  }

  async function refreshMetaVersions() {
    if (!state.selectedLoader) return;
    var btn = $("btn-refresh-versions") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    hideError();
    try {
      var result = await api("/api/meta/refresh", { method: "POST" });
      delete state.versionsCache[state.selectedLoader];
      state.versionsCache[state.selectedLoader] =
        (result.loaderVersions && result.loaderVersions[state.selectedLoader]) || [];
      updateVersionsHint(false, result.updatedAt);
      await loadVersions(state.selectedLoader);
      notify("版本列表已刷新");
    } catch (e) {
      showError("刷新版本失败：" + (e as Error).message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function forceRefreshMappings() {
    if (!state.selectedLoader || !state.selectedMc) return;
    var btn = $("btn-refresh-mappings") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    hideError();
    try {
      var data = await api("/api/mappings/refresh", {
        method: "POST",
        body: { loader: state.selectedLoader, mcVersion: state.selectedMc },
      });
      applyMappingsData(data);
      notify("映射表已刷新");
    } catch (e) {
      showError("刷新映射失败：" + (e as Error).message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function loadDefaultDir() {
    try {
      var data = await api("/api/default-dir");
      if (data.projectsRoot) state.projectsRoot = data.projectsRoot;
    } catch (e) { /* ignore */ }
    await refreshDefaultProjectPath();
  }

  async function loadVersions(loader) {
    var sel = $("sel-mc");
    var mapSel = $("sel-mappings");
    sel.innerHTML = "<option>加载中…</option>";
    sel.disabled = true;
    if (mapSel) {
      mapSel.innerHTML = "<option>加载中…</option>";
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
        } catch (e) { /* ignore */ }
      }
      updateVersionsHint(fromCache, updatedAt);
      sel.innerHTML = versions.map(function (v, i) {
        return '<option value="' + v + '">' + v + (i === 0 ? "（最新）" : "") + '</option>';
      }).join("");
      state.selectedMc = versions[0] || "";
      syncProjectPath();
      onDisplayNameChanged();
      await refreshMappings(0);
    } catch (e) {
      sel.innerHTML = "<option>加载失败</option>";
      if (mapSel) mapSel.innerHTML = "<option>加载失败</option>";
    }
    sel.disabled = false;
  }

  async function refreshMappings(retryCount) {
    retryCount = retryCount || 0;
    var mapSel = $("sel-mappings");
    if (!mapSel || !state.selectedMc || !state.selectedLoader) return;
    mapSel.innerHTML = "<option>读取本地缓存…</option>";
    mapSel.disabled = true;
    try {
      var data = await api(
        "/api/mappings/" + state.selectedLoader + "/" + encodeURIComponent(state.selectedMc)
      );
      var options = data.options || [];
      var unobfuscated = state.selectedLoader === "fabric" && isUnobfuscatedMc(state.selectedMc);
      if (!unobfuscated && state.selectedLoader === "fabric" && options.length === 0 && retryCount < 3) {
        mapSel.innerHTML = "<option>正在探测 Yarn 映射（" + (retryCount + 1) + "/3）…</option>";
        await new Promise(function (r) { setTimeout(r, 1500 + retryCount * 500); });
        return refreshMappings(retryCount + 1);
      }
      if (!options.length) {
        throw new Error(unobfuscated ? "此版本映射信息不可用" : "此版本暂无可用映射");
      }
      applyMappingsData(data);
    } catch (e) {
      if (retryCount < 2) {
        await new Promise(function (r) { setTimeout(r, 1000); });
        return refreshMappings(retryCount + 1);
      }
      mapSel.innerHTML = "<option>此版本暂无可用映射</option>";
      state.selectedMappings = "";
    } finally {
      mapSel.disabled = false;
    }
  }

  function extractGenFailure(logEl, exitCode) {
    var lines = [];
    logEl.querySelectorAll("div").forEach(function (d) {
      lines.push(d.textContent || "");
    });
    var errLines = lines.filter(function (l) {
      return /错误|失败|ERROR|FAILURE|Exception|BUILD FAILED/i.test(l);
    });
    if (errLines.length) return errLines[errLines.length - 1];
    if (exitCode !== null && exitCode !== undefined) return "退出码 " + exitCode;
    return "未知错误";
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

  function clearFieldErrors() {
    document.querySelectorAll(".field-error").forEach(function (el) { el.remove(); });
    document.querySelectorAll(".field-invalid").forEach(function (el) { el.classList.remove("field-invalid"); });
  }

  function setFieldError(fieldId, message) {
    var field = $(fieldId) as HTMLElement | null;
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

    if (!name) { setFieldError("inp-name", "请给模组起个名字"); showError("请检查标记的表单字段"); return null; }
    if (!modId) { modId = nameToModId(name); $("inp-modid").value = modId; }
    if (!isValidModId(modId)) {
      setFieldError("inp-modid", "需小写字母开头，仅含小写字母、数字和下划线");
      showError("模组 ID 格式无效");
      return null;
    }
    if (!state.selectedLoader) {
      showError("请先选择加载器");
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
    return { name: name, modId: modId, group: group, mirror: mirror, sideLayout: getSelectedSideLayout() };
  }

  async function resolveMappingsForVersion(loader, mc) {
    if (loader === "fabric" && isUnobfuscatedMc(mc)) return "mojmap";
    var data = await api("/api/mappings/" + loader + "/" + encodeURIComponent(mc));
    if (!data.options || !data.options.length) {
      if (loader === "fabric") return "mojmap";
      throw new Error(mc + " 暂无可用映射");
    }
    return data.default || data.options[0].id;
  }

  async function runGenerateStream(args, opts) {
    opts = opts || {};
    var log = opts.logEl || $("gen-log");
    var resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: args, scaffoldOnly: !!opts.scaffoldOnly }),
      signal: opts.signal || (state.activeAbort ? state.activeAbort.signal : undefined),
    });

    var reader = resp.body!.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var exitCode: number | null = null;
    var prefix = opts.prefix || "";

    while (true) {
      if (state.generationCancelled) return -1;
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
        if (!opts.scaffoldOnly) {
          if (line.indexOf("正在验证构建") >= 0) setPhase("build");
          if (line.indexOf("正在启动 Minecraft") >= 0) setPhase("client");
        }
        var div = document.createElement("div");
        if (line.indexOf("失败") >= 0 || line.indexOf("ERROR") >= 0 || line.indexOf("错误") >= 0) {
          div.className = "log-err";
        }
        if (line.indexOf("成功") >= 0 || line.indexOf("BUILD SUCCESSFUL") >= 0 || line.indexOf("✔") >= 0) {
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
    if (!dir) { setFieldError("inp-dir", "项目路径未设置，请检查模组 ID"); showError("项目路径未设置"); return; }
    if (!state.selectedMappings) {
      if (state.selectedLoader === "fabric" && isUnobfuscatedMc(state.selectedMc)) {
        state.selectedMappings = "mojmap";
      } else {
        setFieldError("sel-mappings", "当前版本暂无可用映射表，请换一个 Minecraft 版本");
        showError("当前版本暂无可用映射表");
        return;
      }
    }
    hideError();
    showCreateStep("step-gen");
    setPhase("gen");
    var hint = $("gen-hint");
    if (hint) hint.textContent = "正在创建并验证 " + state.selectedMc + "…";
    state.generationCancelled = false;
    state.activeAbort = new AbortController();
    var log = $("gen-log");
    log.innerHTML = "";

    var args = [
      "--yes", "--loader", state.selectedLoader, "--mc", state.selectedMc,
      "--modid", form.modId, "--name", form.name, "--group", form.group, "--dir", dir,
      "--mappings", state.selectedMappings,
      "--side-layout", resolveSideLayoutForMc(state.selectedLoader, state.selectedMc, form.sideLayout),
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
      notify("模组已创建并完成验证流程");
    } catch (e) {
      if (state.generationCancelled || (e as Error).name === "AbortError") return;
      showError("创建失败：" + (e as Error).message);
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
        showError("加载版本列表失败：" + (e as Error).message);
        return;
      }
    }
    if (!versions.length) {
      showError("没有可用版本，请先刷新版本列表");
      return;
    }

    var loaderLabel = LOADER_LABELS[state.selectedLoader] || state.selectedLoader;
    var concurrency = {
      jobSlots: 1,
      gradleBuildConcurrency: 1,
      clientConcurrency: 1,
      physicalCores: 1,
    };
    try {
      concurrency = await api("/api/concurrency");
    } catch (e) { /* fallback */ }
    var maxSlots = concurrency.jobSlots || concurrency.maxConcurrency || 1;
    var gradleMax = concurrency.gradleBuildMax || concurrency.gradleBuildConcurrency || maxSlots;
    var clientMax = concurrency.clientMax || concurrency.clientConcurrency || 1;
    if (!await confirmAction({
      title: "批量创建所有版本",
      message: "将为「" + form.name + "」创建 " + loaderLabel + " 的全部 " + versions.length + " 个版本。",
      detail: sideLayoutBatchNote(form.sideLayout, state.selectedLoader, versions)
        + "\n任务 " + maxSlots + " 路 · Gradle 构建最多 " + gradleMax + " 路 · 客户端验证最多 " + clientMax + " 路（安全限流）。\n已存在且非空的目录会跳过。",
      confirmLabel: "开始批量创建",
    })) return;

    hideError();
    showCreateStep("step-gen");
    state.generationCancelled = false;
    state.activeAbort = null;
    state.batchAbortControllers = [];
    var log = $("gen-log");
    log.innerHTML = "";
    var hint = $("gen-hint");
    if (hint) hint.textContent = "准备并行创建 " + versions.length + " 个版本（最多 " + maxSlots + " 路）…";

    var success = 0;
    var failed = 0;
    var skipped = 0;
    var completed = 0;
    var nextIndex = 0;
    var activeCount = 0;

    function updateBatchHint() {
      if (!hint) return;
      var pending = versions.length - completed - activeCount;
      hint.textContent = "任务 " + activeCount + "/" + maxSlots
        + " · 构建限 " + gradleMax + " · 客户端限 " + clientMax
        + " · 已完成 " + completed + "/" + versions.length
        + (pending > 0 ? " · 待处理 " + pending : "");
    }

    async function runOneVersion(mc) {
      var dir = joinProjectPath(form.modId, state.selectedLoader, mc);
      var header = document.createElement("div");
      header.className = "log-ok";
      header.textContent = "—— " + mc + " ——";
      log.appendChild(header);
      log.scrollTop = log.scrollHeight;

      var abort = new AbortController();
      state.batchAbortControllers!.push(abort);
      try {
        var mappings = await resolveMappingsForVersion(state.selectedLoader, mc);
        var args = [
          "--yes", "--loader", state.selectedLoader, "--mc", mc,
          "--modid", form.modId, "--name", form.name, "--group", form.group, "--dir", dir,
          "--mappings", mappings,
          "--side-layout", resolveSideLayoutForMc(state.selectedLoader, mc, form.sideLayout),
        ];
        if (!form.mirror) args.push("--no-mirror");

        setPhase("gen");
        var exitCode = await runGenerateStream(args, {
          logEl: log,
          prefix: "  [" + mc + "] ",
          signal: abort.signal,
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
        var msg = (e as Error).message || "";
        if ((e as Error).name === "AbortError" || state.generationCancelled) return "cancelled";
        var errDiv = document.createElement("div");
        errDiv.className = "log-err";
        errDiv.textContent = "  [" + mc + "] 错误：" + msg;
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
      await new Promise<void>(function (resolve) {
        function pump() {
          if (state.generationCancelled) {
            if (activeCount === 0) resolve();
            return;
          }
          while (activeCount < maxSlots && nextIndex < versions.length && !state.generationCancelled) {
            var mc = versions[nextIndex++];
            activeCount++;
            updateBatchHint();
            void runOneVersion(mc).finally(function () {
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
      if (hint) hint.textContent = "批量创建与验证完成（构建 " + gradleMax + " 路 · 客户端 " + clientMax + " 路）";
      await loadMods();
      notify("批量完成：" + success + " 成功，" + failed + " 失败，" + skipped + " 跳过");
      if (success > 0) {
        var mod = state.mods.find(function (m) { return m.modId === form.modId; });
        if (mod) {
          showView("detail");
          await openDetail(mod.id);
          return;
        }
      }
      showView("list");
      showCreateStep("step-loader");
    } catch (e) {
      if (state.generationCancelled || (e as Error).name === "AbortError") return;
      showError("批量创建失败：" + (e as Error).message);
    } finally {
      state.batchAbortControllers = null;
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
      list.innerHTML = '<p class="muted-placeholder">暂无额外监视目录</p>';
      return;
    }
    dirs.forEach(function (dir) {
      var isBuiltin = projectsRoot && dir.replace(/\\/g, "/").toLowerCase()
        === projectsRoot.replace(/\\/g, "/").toLowerCase();
      var row = document.createElement("div");
      row.className = "scan-dir-row";
      row.innerHTML = '<input class="code-input" readonly value="' + esc(dir) + '">';
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
          if (!await confirmAction({ title: "移除监视目录", message: "停止扫描此目录？已登记项目不会被删除。", detail: dir, confirmLabel: "移除目录" })) return;
          await removeScanDir(dir);
          loadSettings();
          loadExternalView();
        });
        row.appendChild(rm);
      } else {
        var tag = document.createElement("span");
        tag.className = "builtin-tag";
        tag.textContent = "内置";
        row.appendChild(tag);
      }
      list.appendChild(row);
    });
  }

  async function loadMetaCacheStatus() {
    try {
      var meta = await api("/api/meta/status");
      var maps = await api("/api/mappings/status");
      var verText = meta.updatedAt
        ? "Fabric " + (meta.loaderCounts?.fabric ?? 0)
          + " / NeoForge " + (meta.loaderCounts?.neoforge ?? 0)
          + " / Forge " + (meta.loaderCounts?.forge ?? 0)
          + " · " + meta.updatedAt.slice(0, 10)
          + (meta.stale ? "（可能过期）" : "")
        : "未缓存";
      var mapText = maps.lastUpdated
        ? maps.entries + " 条 · " + maps.lastUpdated.slice(0, 10)
        : "未缓存";
      setText("meta-versions-status", verText);
      setText("meta-mappings-status", mapText);
    } catch (e) {
      setText("meta-versions-status", "读取失败");
      setText("meta-mappings-status", "读取失败");
    }
  }

  var sourceStatusCache: any = null;
  var sourcePollTimer: ReturnType<typeof setInterval> | null = null;
  var sourceOptionsToken = 0;
  var lastSourceTaskNotice = "";
  var sourceAutoOpenTask: { id: string; scope: "single" | "all" } | null = null;

  function sourcePhaseLabel(phase) {
    return {
      planning: "规划版本与映射",
      scaffolding: "准备加载器开发环境",
      mapping: "生成映射产物",
      extracting: "提取与反编译源码",
      dependencies: "解析并准备前置模组源码",
      linking: "写入项目源码入口",
      verifying: "校验源码完整性",
    }[phase] || "处理中";
  }

  function selectedSourceEntry() {
    if (!sourceStatusCache) return null;
    var loader = ($("source-loader") as HTMLSelectElement | null)?.value;
    var mc = ($("source-mc") as HTMLSelectElement | null)?.value;
    var mapping = ($("source-mapping") as HTMLSelectElement | null)?.value;
    return (sourceStatusCache.entries || []).find(function (entry) {
      return entry.loader === loader && entry.minecraftVersion === mc && entry.mapping === mapping;
    }) || null;
  }

  function renderSelectedSourcePath() {
    var entry = selectedSourceEntry();
    var input = $("source-selected-path") as HTMLInputElement | null;
    var open = $("btn-source-open-selected") as HTMLButtonElement | null;
    var copy = $("btn-source-copy-selected") as HTMLButtonElement | null;
    if (input) input.value = entry?.sourcePath || "";
    if (open) open.disabled = !entry;
    if (copy) copy.disabled = !entry;
  }

  function scheduleSourcePolling(running) {
    if (running && !sourcePollTimer) {
      sourcePollTimer = setInterval(function () { void loadSourceStatus(); }, 1200);
    } else if (!running && sourcePollTimer) {
      clearInterval(sourcePollTimer);
      sourcePollTimer = null;
    }
  }

  function renderSourceStatus(data) {
    sourceStatusCache = data;
    var rootInput = $("source-root-path") as HTMLInputElement | null;
    if (rootInput) rootInput.value = data.rootPath || "";
    setText("source-library-count", "Minecraft " + (data.entries?.length || 0)
      + " 组 · 前置模组 " + (data.modEntries || 0) + " 组");
    renderSelectedSourcePath();

    var task = data.task;
    var badge = $("source-state-badge");
    var panel = $("source-progress-panel") as HTMLElement | null;
    var cancel = $("btn-source-cancel") as HTMLButtonElement | null;
    var currentBtn = $("btn-source-current") as HTMLButtonElement | null;
    var allBtn = $("btn-source-all") as HTMLButtonElement | null;
    var force = $("source-force") as HTMLInputElement | null;
    var controls = [$("source-loader"), $("source-mc"), $("source-mapping")];
    var running = task?.state === "running";
    controls.forEach(function (el) { if (el) (el as HTMLInputElement).disabled = running; });
    if (currentBtn) currentBtn.disabled = running;
    if (allBtn) allBtn.disabled = running;
    if (force) force.disabled = running;
    if (cancel) cancel.hidden = !running;

    if (!task) {
      if (badge) {
        badge.textContent = data.entries?.length || data.modEntries ? "缓存就绪" : "缓存为空";
        badge.className = "source-state-badge" + (data.entries?.length ? " completed" : "");
      }
      if (panel) panel.hidden = true;
      scheduleSourcePolling(false);
      return;
    }

    var stateLabels = { running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消" };
    if (badge) {
      badge.textContent = stateLabels[task.state] || task.state;
      badge.className = "source-state-badge " + task.state;
    }
    if (panel) panel.hidden = false;
    var current = task.current
      ? (LOADER_LABELS[task.current.loader] || task.current.loader) + " " + task.current.mcVersion
      : (task.state === "running" ? "正在准备任务" : "任务结束");
    setText("source-progress-title", current);
    setText("source-progress-detail", task.state === "running"
      ? sourcePhaseLabel(task.currentPhase)
      : (task.lastError || stateLabels[task.state] || task.state));
    var pct = task.total ? Math.round((task.completed / task.total) * 100) : 0;
    var bar = $("source-progress-bar") as HTMLElement | null;
    if (bar) bar.style.width = pct + "%";
    var track = panel?.querySelector("[role=progressbar]");
    if (track) track.setAttribute("aria-valuenow", String(pct));
    setText("source-progress-stats", "进度 " + task.completed + "/" + task.total
      + " · 成功 " + task.successes + " · 跳过 " + task.skipped + " · 失败 " + task.failures);
    var log = $("source-task-log");
    if (log) {
      log.textContent = (task.logs || []).join("\n") || "等待第一条任务日志…";
      log.scrollTop = log.scrollHeight;
    }
    scheduleSourcePolling(running);

    if (!running) {
      var noticeKey = task.id + ":" + task.state;
      if (lastSourceTaskNotice !== noticeKey) {
        lastSourceTaskNotice = noticeKey;
        if (task.state === "completed") {
          notify("源码任务完成：成功 " + task.successes + "，跳过 " + task.skipped
            + (task.failures ? "，失败 " + task.failures : ""), task.failures ? "warning" : "success");
        } else if (task.state === "failed") {
          notify("源码任务失败：" + (task.lastError || "请查看任务日志"), "error");
        } else if (task.state === "cancelled") {
          notify("源码任务已取消", "warning");
        }
      }
      if (task.state === "completed" && sourceAutoOpenTask?.id === task.id) {
        var autoOpenPath = sourceAutoOpenTask.scope === "single" ? task.outputPath : data.rootPath;
        sourceAutoOpenTask = null;
        if (autoOpenPath) {
          void api("/api/open-folder", { method: "POST", body: { path: autoOpenPath } })
            .then(function () { notify("已自动打开源码文件夹"); })
            .catch(function (e) { showError("源码已完成，但打开文件夹失败：" + (e as Error).message); });
        }
      }
    }
  }

  async function loadSourceStatus() {
    try {
      renderSourceStatus(await api("/api/sources/status"));
    } catch (e) {
      scheduleSourcePolling(false);
      setText("source-state-badge", "读取失败");
    }
  }

  async function loadSourceMappings() {
    var loader = ($("source-loader") as HTMLSelectElement).value;
    var mc = ($("source-mc") as HTMLSelectElement).value;
    var select = $("source-mapping") as HTMLSelectElement;
    if (!mc) return;
    select.disabled = true;
    try {
      var data = await api("/api/mappings/" + loader + "/" + encodeURIComponent(mc));
      select.innerHTML = "";
      (data.options || []).filter(function (option) { return option.available; }).forEach(function (option) {
        var item = document.createElement("option");
        item.value = option.id;
        item.textContent = option.label + (option.version ? " · " + option.version : "");
        select.appendChild(item);
      });
      if (data.default) select.value = data.default;
    } catch (e) {
      select.innerHTML = '<option value="mojmap">官方默认映射</option>';
    } finally {
      select.disabled = sourceStatusCache?.task?.state === "running";
      renderSelectedSourcePath();
    }
  }

  async function loadSourceVersions(preferred) {
    var token = ++sourceOptionsToken;
    var loader = ($("source-loader") as HTMLSelectElement).value;
    var select = $("source-mc") as HTMLSelectElement;
    select.disabled = true;
    select.innerHTML = "<option>正在读取版本…</option>";
    try {
      var data = await api("/api/versions/" + loader);
      if (token !== sourceOptionsToken) return;
      select.innerHTML = "";
      (data.versions || []).forEach(function (version) {
        var option = document.createElement("option");
        option.value = version;
        option.textContent = version;
        select.appendChild(option);
      });
      if (preferred && (data.versions || []).includes(preferred)) select.value = preferred;
      setText("source-scope-note", "单版本完成后自动打开源码文件夹；全部版本将顺序处理 "
        + (data.versions?.length || 0) + " 个版本，完成后只打开源码仓库。");
      await loadSourceMappings();
    } catch (e) {
      select.innerHTML = "<option>版本列表读取失败</option>";
    } finally {
      select.disabled = sourceStatusCache?.task?.state === "running";
    }
  }

  async function startSourceTask(scope) {
    var loader = ($("source-loader") as HTMLSelectElement).value;
    var mcVersion = ($("source-mc") as HTMLSelectElement).value;
    var mapping = ($("source-mapping") as HTMLSelectElement).value;
    if (scope === "all") {
      var countText = ($("source-scope-note") as HTMLElement)?.textContent || "";
      if (!await confirmAction({
        title: "获取全部版本源码",
        message: "将依次生成 " + (LOADER_LABELS[loader] || loader) + " 支持的全部 Minecraft 版本源码。",
        detail: countText + "\n任务可随时取消；已经有 READY 标记的版本默认不会重复生成。",
        confirmLabel: "开始获取",
      })) return;
    }
    hideError();
    try {
      var startedTask = await api("/api/sources/start", {
        method: "POST",
        body: {
          scope: scope,
          loader: loader,
          mcVersion: scope === "single" ? mcVersion : undefined,
          mapping: scope === "single" ? mapping : undefined,
          force: ($("source-force") as HTMLInputElement).checked,
          mirror: true,
        },
      });
      sourceAutoOpenTask = startedTask?.task?.id ? { id: startedTask.task.id, scope: scope } : null;
      notify(scope === "single" ? "源码任务已开始" : "全部版本源码任务已开始");
      await loadSourceStatus();
    } catch (e) {
      showError("无法启动源码任务：" + (e as Error).message);
    }
  }

  async function copySourcePath(inputId) {
    var value = ($(inputId) as HTMLInputElement | null)?.value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      notify("路径已复制");
    } catch {
      showError("复制失败，请手动选择路径文本");
    }
  }

  async function openSourcePath(inputId) {
    var value = ($(inputId) as HTMLInputElement | null)?.value;
    if (!value) return;
    await api("/api/open-folder", { method: "POST", body: { path: value } });
  }

  async function refreshAllMetaFromSettings() {
    var btn = $("btn-settings-refresh-versions") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      await api("/api/meta/refresh", { method: "POST" });
      state.versionsCache = {};
      invalidateDetailCache();
      await loadMetaCacheStatus();
      notify("版本列表已刷新");
    } catch (e) {
      showError("刷新版本列表失败：" + (e as Error).message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function refreshAllMappingsFromSettings() {
    var btn = $("btn-settings-refresh-mappings") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      var loaders = ["fabric", "neoforge", "forge"];
      var totalFetched = 0;
      var totalErrors = 0;
      for (var i = 0; i < loaders.length; i++) {
        var result = await api("/api/mappings/refresh-all", {
          method: "POST",
          body: { loader: loaders[i] },
        });
        totalFetched += result.fetched || 0;
        totalErrors += result.errors || 0;
      }
      await loadMetaCacheStatus();
      notify("映射表已刷新：新增/更新 " + totalFetched + " 条"
        + (totalErrors ? "，" + totalErrors + " 条失败" : ""));
    } catch (e) {
      showError("刷新映射表失败：" + (e as Error).message);
    } finally {
      if (btn) btn.disabled = false;
    }
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
    renderConcurrencySettings(data.concurrency);
    await Promise.all([loadMetaCacheStatus(), loadSourceStatus()]);
  }

  function renderConcurrencySettings(payload) {
    if (!payload) return;
    var hw = payload.hardware || {};
    var bounds = payload.bounds || {};
    var effective = payload.effective || {};
    var hwEl = $("concurrency-hw");
    if (hwEl) {
      hwEl.textContent = "检测到 " + (hw.physicalCores || "?") + " 物理核 · "
        + (hw.logicalCores || "?") + " 逻辑核"
        + (hw.source ? "（" + hw.source + "）" : "");
    }
    bindConcurrencyControl("set-job-slots", bounds.jobSlots, effective.jobSlots);
    bindConcurrencyControl("set-gradle-slots", bounds.gradleBuildConcurrency, effective.gradleBuildConcurrency);
    bindConcurrencyControl("set-client-slots", bounds.clientConcurrency, effective.clientConcurrency);
    updateConcurrencyEffectiveNote(payload);
  }

  function bindConcurrencyControl(prefix, bounds, value) {
    if (!bounds) return;
    var num = $(prefix) as HTMLInputElement | null;
    var range = $(prefix + "-range") as HTMLInputElement | null;
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
      jobSlots: Number(($("set-job-slots") as HTMLInputElement).value),
      gradleBuildConcurrency: Number(($("set-gradle-slots") as HTMLInputElement).value),
      clientConcurrency: Number(($("set-client-slots") as HTMLInputElement).value),
    };
  }

  function updateConcurrencyEffectiveNote(payload) {
    var el = $("concurrency-effective");
    if (!el || !payload) return;
    var eff = payload.effective || {};
    var defs = payload.defaults || {};
    var customized = payload.user && (
      payload.user.jobSlots !== undefined
      || payload.user.gradleBuildConcurrency !== undefined
      || payload.user.clientConcurrency !== undefined
    );
    el.textContent = "当前生效：任务 " + (eff.jobSlots || "-")
      + " · Gradle " + (eff.gradleBuildConcurrency || "-")
      + " · 客户端 " + (eff.clientConcurrency || "-")
      + (customized ? "（已自定义）" : "（推荐默认值）")
      + " · 推荐 Gradle " + (defs.gradleBuildConcurrency || "-")
      + " / 客户端 " + (defs.clientConcurrency || "-");
  }

  function wireConcurrencyControl(prefix) {
    var num = $(prefix) as HTMLInputElement | null;
    var range = $(prefix + "-range") as HTMLInputElement | null;
    if (!num || !range) return;
    var syncFromRange = function () {
      num.value = range.value;
      var gradleNum = $("set-gradle-slots") as HTMLInputElement | null;
      var gradleRange = $("set-gradle-slots-range") as HTMLInputElement | null;
      var jobVal = Number(($("set-job-slots") as HTMLInputElement).value);
      if (prefix === "set-job-slots" && gradleNum && gradleRange) {
        if (Number(gradleNum.value) > jobVal) {
          gradleNum.value = String(jobVal);
          gradleRange.value = String(jobVal);
        }
        gradleNum.max = String(jobVal);
        gradleRange.max = String(jobVal);
        var clientNum = $("set-client-slots") as HTMLInputElement | null;
        var clientRange = $("set-client-slots-range") as HTMLInputElement | null;
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
    var syncFromNum = function () {
      var min = Number(num.min) || 1;
      var max = Number(num.max) || min;
      var v = Math.max(min, Math.min(max, Number(num.value) || min));
      num.value = String(v);
      range.value = String(v);
      syncFromRange();
    };
    range.addEventListener("input", syncFromRange);
    num.addEventListener("change", syncFromNum);
    num.addEventListener("input", function () { range.value = num.value; });
  }

  wireConcurrencyControl("set-job-slots");
  wireConcurrencyControl("set-gradle-slots");
  wireConcurrencyControl("set-client-slots");

  $("btn-concurrency-save")?.addEventListener("click", async function () {
    hideError();
    try {
      var body = readConcurrencyForm();
      if (body.gradleBuildConcurrency > body.jobSlots) {
        showError("Gradle 构建并发不能大于任务槽位");
        return;
      }
      var result = await api("/api/settings/concurrency", { method: "POST", body: body });
      renderConcurrencySettings(result.concurrency);
      notify("并发设置已保存");
    } catch (e) {
      showError("保存并发设置失败：" + (e as Error).message);
    }
  });

  $("btn-concurrency-reset")?.addEventListener("click", async function () {
    hideError();
    try {
      var result = await api("/api/settings/concurrency", { method: "POST", body: { reset: true } });
      renderConcurrencySettings(result.concurrency);
      notify("已恢复推荐并发值");
    } catch (e) {
      showError("恢复失败：" + (e as Error).message);
    }
  });

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
      if (!await confirmAction({ title: "移除项目登记", message: "项目只会从工作台移除，磁盘文件不会被删除。", detail: project.projectPath, confirmLabel: "移除登记" })) return;
      await api("/api/mods/" + project.modUuid + "/variants/" + project.variantId, {
        method: "DELETE",
        body: { deleteFiles: false },
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
      wrap.innerHTML = '<p class="muted-placeholder registry-empty">暂无已注册项目</p>';
      return;
    }
    var html = '<table class="registry-table"><thead><tr>' +
      '<th>模组</th><th>变体</th><th>路径</th><th>状态</th><th>操作</th></tr></thead><tbody>';
    projects.forEach(function (p) {
      var status = p.isBuiltin ? "内置" : "外部";
      html += '<tr data-vid="' + p.variantId + '">' +
        '<td>' + esc(p.displayName) + '<br><span class="registry-modid">' + esc(p.modId) + '</span></td>' +
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

  $("modal-close").addEventListener("click", function () {
    closeModal();
  });
  $("modal-source-cancel")?.addEventListener("click", async function () {
    var button = $("modal-source-cancel") as HTMLButtonElement;
    button.disabled = true;
    try {
      await api("/api/sources/cancel", { method: "POST" });
      notify("正在取消源码准备…", "warning");
    } finally {
      button.disabled = false;
    }
  });
  $("modal-overlay")?.addEventListener("click", function (event) {
    if (event.target === $("modal-overlay")) closeModal();
  });
  $("error-close")?.addEventListener("click", hideError);
  document.querySelectorAll(".action-menu button").forEach(function (button) {
    button.addEventListener("click", function () {
      button.closest("details")?.removeAttribute("open");
    });
  });

  document.addEventListener("keydown", function (event) {
    var visibleOverlay = document.querySelector<HTMLElement>(".modal-overlay.visible");
    if (!visibleOverlay) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (visibleOverlay.id === "build-all-modal") closeBuildAllModal();
      else if (visibleOverlay.id === "modal-overlay") closeModal();
      else visibleOverlay.classList.remove("visible");
      return;
    }
    if (event.key !== "Tab") return;
    var focusable = Array.from(visibleOverlay.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return el.offsetParent !== null; });
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
    if (!await confirmAction({ title: "清理失效登记", message: "移除所有路径已经不存在的项目登记？", detail: "此操作不会删除任何仍存在的磁盘文件。", confirmLabel: "清理失效项", danger: true })) return;
    try {
      var data = await api("/api/mods/purge-missing", { method: "POST", body: {} });
      notify("已清理 " + data.removed + " 个失效条目");
      loadMods();
    } catch (e) { showError(e.message); }
  });

  $("btn-delete-mod").addEventListener("click", async function () {
    if (!state.currentModId) return;
    var mod = state.mods.find(function (m) { return m.id === state.currentModId; });
    if (!mod) return;
    var paths = (mod.variants || []).map(function (v) { return v.projectPath; }).join("\n  · ");
    var msg = "删除整个模组「" + mod.displayName + "」？\n\n将删除 " + mod.variants.length +
      " 个变体的项目文件夹：\n  · " + (paths || "(无变体)") +
      "\n\n此操作不可恢复。";
    if (!await confirmAction({ title: "永久删除模组", message: "将删除「" + mod.displayName + "」及其 " + mod.variants.length + " 个变体项目，此操作不可恢复。", detail: paths || "(无变体目录)", confirmLabel: "删除模组与文件", danger: true })) return;
    try {
      var result = await api("/api/mods/" + state.currentModId, {
        method: "DELETE",
        body: { deleteFiles: true },
      });
      state.currentModId = null;
      invalidateDetailCache();
      showView("list");
      loadMods();
      var deleted = result.fileResult && result.fileResult.deleted
        ? result.fileResult.deleted.length : 0;
      notify("模组已删除（" + deleted + " 个文件夹已清除）");
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
    if (!await confirmAction({ title: "清理失效登记", message: "移除所有路径已经不存在的项目登记？", detail: "此操作不会删除任何仍存在的磁盘文件。", confirmLabel: "清理失效项", danger: true })) return;
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

  var buildAllPendingMod: Record<string, unknown> | null = null;
  var buildAllPendingMatrix: Record<string, unknown> | null = null;
  var buildAllReturnFocus: HTMLElement | null = null;
  var buildAllBusy = false;

  function setBuildAllBusy(busy: boolean, message?: string) {
    buildAllBusy = busy;
    var confirmBtn = $("build-all-confirm") as HTMLButtonElement | null;
    var cancelBtn = $("build-all-cancel") as HTMLButtonElement | null;
    var options = $("build-all-modal")?.querySelector(".build-all-options");
    if (confirmBtn) {
      confirmBtn.disabled = busy;
      confirmBtn.textContent = busy ? "处理中…" : "开始构建";
    }
    if (cancelBtn) cancelBtn.disabled = busy;
    if (options) {
      options.querySelectorAll("input, select").forEach(function (el) {
        (el as HTMLInputElement).disabled = busy;
      });
    }
    if (busy && message) {
      var summary = $("build-all-summary");
      if (summary) summary.textContent = message;
    }
  }

  function filterVariantsForBuildAll(mod, opts) {
    return (mod.variants || []).filter(function (v) {
      if (opts.loader && v.loader !== opts.loader) return false;
      if (opts.failedOnly && v.buildStatus !== "failed") return false;
      return true;
    });
  }

  function isMatrixLoaderMcSupported(matrix, loader, mcVersion) {
    if (!matrix || !matrix.supported) return false;
    var list = matrix.supported[loader];
    if (!list) return false;
    if (Array.isArray(list)) return list.indexOf(mcVersion) >= 0;
    return false;
  }

  function collectBuildAllTargets(mod, matrix, opts) {
    var existing = filterVariantsForBuildAll(mod, opts);
    var pending: Array<{ loader: string; mcVersion: string }> = [];
    if (opts.includeMissingLoaders === false || !matrix) {
      return { existing: existing, pending: pending };
    }
    var mcVersions: Record<string, boolean> = {};
    (mod.variants || []).forEach(function (v) { mcVersions[v.mcVersion] = true; });
    (["forge", "neoforge"] as const).forEach(function (loader) {
      if (opts.loader && loader !== opts.loader) return;
      Object.keys(mcVersions).forEach(function (mcVersion) {
        var exists = (mod.variants || []).some(function (v) {
          return v.loader === loader && v.mcVersion === mcVersion;
        });
        if (exists) return;
        if (!isMatrixLoaderMcSupported(matrix, loader, mcVersion)) return;
        pending.push({ loader: loader, mcVersion: mcVersion });
      });
    });
    return { existing: existing, pending: pending };
  }

  function openBuildAllModal(mod, matrix) {
    buildAllReturnFocus = document.activeElement as HTMLElement | null;
    buildAllPendingMod = mod;
    buildAllPendingMatrix = matrix || null;
    var failedOnlyEl = $("build-all-failed-only") as HTMLInputElement | null;
    var loaderEl = $("build-all-loader") as HTMLSelectElement | null;
    var includeMissingEl = $("build-all-include-missing") as HTMLInputElement | null;
    if (failedOnlyEl) failedOnlyEl.checked = false;
    if (loaderEl) loaderEl.value = "";
    if (includeMissingEl) includeMissingEl.checked = true;
    refreshBuildAllModalList();
    $("build-all-modal")?.classList.add("visible");
    requestAnimationFrame(function () {
      ($("build-all-failed-only") as HTMLElement | null)?.focus();
    });
  }

  function closeBuildAllModal(force?: boolean) {
    if (buildAllBusy && !force) return;
    buildAllPendingMod = null;
    buildAllPendingMatrix = null;
    setBuildAllBusy(false);
    $("build-all-modal")?.classList.remove("visible");
    buildAllReturnFocus?.focus();
    buildAllReturnFocus = null;
  }

  function refreshBuildAllModalList() {
    if (!buildAllPendingMod) return;
    var failedOnlyEl = $("build-all-failed-only") as HTMLInputElement | null;
    var loaderEl = $("build-all-loader") as HTMLSelectElement | null;
    var includeMissingEl = $("build-all-include-missing") as HTMLInputElement | null;
    var opts = {
      failedOnly: !!(failedOnlyEl && failedOnlyEl.checked),
      loader: loaderEl ? loaderEl.value : "",
      includeMissingLoaders: !(includeMissingEl && !includeMissingEl.checked),
    };
    var targets = collectBuildAllTargets(buildAllPendingMod, buildAllPendingMatrix, opts);
    var variants = targets.existing;
    var pending = targets.pending;
    var totalCount = variants.length + pending.length;
    var summary = $("build-all-summary");
    var list = $("build-all-list");
    if (summary) {
      summary.textContent = totalCount
        ? "将为「" + buildAllPendingMod.displayName + "」构建 " + totalCount + " 个变体（按 CPU 核数并行）："
        : "当前筛选条件下没有可构建的变体。";
    }
    if (list) {
      list.innerHTML = "";
      variants.forEach(function (v) {
        var li = document.createElement("li");
        li.textContent = (LOADER_LABELS[v.loader] || v.loader) + " " + v.mcVersion;
        list.appendChild(li);
      });
      pending.forEach(function (p) {
        var li = document.createElement("li");
        li.textContent = (LOADER_LABELS[p.loader] || p.loader) + " " + p.mcVersion + "（将先生成）";
        list.appendChild(li);
      });
    }
    var confirmBtn = $("build-all-confirm") as HTMLButtonElement | null;
    if (confirmBtn) confirmBtn.disabled = totalCount === 0;
  }

  async function confirmBuildAll() {
    if (buildAllBusy) return;
    if (!buildAllPendingMod) {
      notify("无法开始构建：请先打开模组详情", "warning");
      return;
    }
    var modId = String(buildAllPendingMod.id || "");
    if (!modId) {
      notify("无法开始构建：模组信息无效", "warning");
      return;
    }
    var modName = String(buildAllPendingMod.displayName || "模组");
    var failedOnlyEl = $("build-all-failed-only") as HTMLInputElement | null;
    var loaderEl = $("build-all-loader") as HTMLSelectElement | null;
    var includeMissingEl = $("build-all-include-missing") as HTMLInputElement | null;
    var includeMissingLoaders = !(includeMissingEl && !includeMissingEl.checked);
    var filterOpts = {
      failedOnly: !!(failedOnlyEl && failedOnlyEl.checked),
      loader: loaderEl ? loaderEl.value : "",
      includeMissingLoaders: includeMissingLoaders,
    };
    var targets = collectBuildAllTargets(buildAllPendingMod, buildAllPendingMatrix, filterOpts);
    var mod = buildAllPendingMod;
    var genErrors: string[] = [];

    hideError();
    setBuildAllBusy(true, "准备中…");

    try {
      if (includeMissingLoaders && targets.pending.length) {
        for (var i = 0; i < targets.pending.length; i++) {
          var pending = targets.pending[i];
          setBuildAllBusy(
            true,
            "正在生成 " + (LOADER_LABELS[pending.loader] || pending.loader) + " "
              + pending.mcVersion + "（" + (i + 1) + "/" + targets.pending.length + "）…",
          );
          try {
            await generateVariantQuiet(mod, pending.loader, pending.mcVersion);
            var detailData = await api("/api/mods/" + modId + "/detail") as {
              mod: Record<string, unknown>;
              matrix: Record<string, unknown>;
            };
            mod = detailData.mod;
            buildAllPendingMod = mod;
            buildAllPendingMatrix = detailData.matrix;
          } catch (genErr) {
            genErrors.push(
              (LOADER_LABELS[pending.loader] || pending.loader) + " " + pending.mcVersion
                + "：" + ((genErr as Error).message || String(genErr)),
            );
          }
        }
      }

      setBuildAllBusy(true, "正在加入构建队列…");
      var body: Record<string, unknown> = { runClient: false };
      if (filterOpts.failedOnly) body.failedOnly = true;
      if (filterOpts.loader) body.loader = filterOpts.loader;

      var result = await api("/api/mods/" + modId + "/build-all", {
        method: "POST",
        body: body,
      }) as {
        jobIds?: string[];
        count?: number;
        skipped?: { queued?: number; missing?: number };
      };

      closeBuildAllModal(true);
      if (result.jobIds && result.jobIds.length) {
        state.buildBatch = {
          modId: modId,
          modName: modName,
          jobIds: result.jobIds,
          done: {},
        };
      }
      updateQueueBar();
      invalidateDetailCache(modId);
      await refreshDetail({ force: true });
      var skipped = result.skipped || {};
      var extra: string[] = [];
      if (skipped.queued) extra.push(skipped.queued + " 个已在队列");
      if (skipped.missing) extra.push(skipped.missing + " 个路径不存在");
      var suffix = extra.length ? "（跳过 " + extra.join("，") + "）" : "";
      if (genErrors.length) {
        notify("部分变体生成失败（" + genErrors.length + " 个），其余已处理", "warning");
      }
      notify((result.count || 0) + " 个变体已加入构建队列" + suffix);
    } catch (e) {
      var msg = e instanceof Error ? e.message : String(e);
      notify("构建全部失败：" + msg, "error");
      var summary = $("build-all-summary");
      if (summary) summary.textContent = "失败：" + msg;
      setBuildAllBusy(false);
      refreshBuildAllModalList();
    }
  }

  $("btn-build-all").addEventListener("click", async function () {
    if (!state.currentModId) return;
    hideError();
    try {
      var detailData = await api("/api/mods/" + state.currentModId + "/detail");
      if (!detailData.mod || !detailData.mod.variants || !detailData.mod.variants.length) {
        notify("暂无变体可构建");
        return;
      }
      openBuildAllModal(detailData.mod, detailData.matrix);
    } catch (e) {
      showError("加载模组信息失败：" + e.message);
    }
  });

  $("build-all-cancel")?.addEventListener("click", closeBuildAllModal);
  $("build-all-confirm")?.addEventListener("click", function () { void confirmBuildAll(); });
  $("build-all-failed-only")?.addEventListener("change", refreshBuildAllModalList);
  $("build-all-loader")?.addEventListener("change", refreshBuildAllModalList);
  $("build-all-include-missing")?.addEventListener("change", refreshBuildAllModalList);
  $("build-all-modal")?.addEventListener("click", function (e) {
    if (e.target === $("build-all-modal")) closeBuildAllModal();
  });

  $("btn-add-variant").addEventListener("click", function () {
    notify("在支持矩阵选择 → 单元格即可生成变体");
  });

  $("search-mods").addEventListener("input", function () {
    state.search = $("search-mods").value.trim();
    renderModList();
  });

  document.querySelectorAll(".filter-chip").forEach(function (chip) {
    if (chip.hasAttribute("data-loader-filter") || chip.hasAttribute("data-matrix-filter")) return;
    chip.addEventListener("click", function () {
      document.querySelectorAll("[data-filter]").forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      state.filter = chip.dataset.filter;
      renderModList();
    });
  });

  document.querySelectorAll("[data-loader-filter]").forEach(function (chip) {
    chip.addEventListener("click", function () {
      document.querySelectorAll("[data-loader-filter]").forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      state.loaderFilter = chip.dataset.loaderFilter || "all";
      renderModList();
    });
  });

  document.querySelectorAll("[data-matrix-filter]").forEach(function (chip) {
    chip.addEventListener("click", function () {
      document.querySelectorAll("[data-matrix-filter]").forEach(function (c) { c.classList.remove("active"); });
      chip.classList.add("active");
      state.matrixFilter = chip.dataset.matrixFilter || "all";
      if (state.currentModId && state.detailCache[state.currentModId]) {
        var cached = state.detailCache[state.currentModId];
        renderMatrix(cached.mod, cached.matrix);
      }
    });
  });

  $("empty-primary")?.addEventListener("click", function () {
    var action = ($("empty-primary") as HTMLElement).dataset.emptyAction;
    if (action === "create") $("btn-new-mod")?.click();
    else if (action === "clear-search") {
      state.search = "";
      var input = $("search-mods") as HTMLInputElement | null;
      if (input) input.value = "";
      renderModList();
    } else if (action === "reset-filters") {
      state.filter = "all";
      state.loaderFilter = "all";
      document.querySelectorAll("[data-filter], [data-loader-filter]").forEach(function (el) {
        el.classList.toggle("active", (el as HTMLElement).dataset.filter === "all" || (el as HTMLElement).dataset.loaderFilter === "all");
      });
      renderModList();
    }
  });
  $("empty-secondary")?.addEventListener("click", function () { $("btn-import")?.click(); });

  document.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showView("list");
      ($("search-mods") as HTMLInputElement | null)?.focus();
    }
  });

  $("queue-cancel").addEventListener("click", async function () {
    try {
      await api("/api/queue/cancel", { method: "POST" });
      updateQueueBar();
      await loadMods();
      if (state.currentModId) {
        invalidateDetailCache(state.currentModId);
        await refreshDetail({ force: true });
      }
      notify("已取消当前任务并清空队列");
    } catch (e) {
      showError("取消失败：" + e.message);
    }
  });

  $("btn-add-scan-dir").addEventListener("click", async function () {
    var pick = await api("/api/select-dir");
    if (!pick.path) return;
    await addScanDirAndOptionalScan(pick.path, true);
    loadSettings();
    loadMods();
    notify("监视目录已添加并扫描");
  });

  $("btn-settings-refresh-versions")?.addEventListener("click", function () {
    void refreshAllMetaFromSettings();
  });
  $("btn-settings-refresh-mappings")?.addEventListener("click", function () {
    void refreshAllMappingsFromSettings();
  });
  $("source-loader")?.addEventListener("change", function () {
    void loadSourceVersions();
  });
  $("source-mc")?.addEventListener("change", function () {
    void loadSourceMappings();
  });
  $("source-mapping")?.addEventListener("change", renderSelectedSourcePath);
  $("btn-source-current")?.addEventListener("click", function () {
    void startSourceTask("single");
  });
  $("btn-source-all")?.addEventListener("click", function () {
    void startSourceTask("all");
  });
  $("btn-source-cancel")?.addEventListener("click", async function () {
    try {
      await api("/api/sources/cancel", { method: "POST" });
      notify("正在取消源码任务…", "warning");
      await loadSourceStatus();
    } catch (e) {
      showError("取消源码任务失败：" + (e as Error).message);
    }
  });
  $("btn-source-open-root")?.addEventListener("click", function () { void openSourcePath("source-root-path"); });
  $("btn-source-copy-root")?.addEventListener("click", function () { void copySourcePath("source-root-path"); });
  $("btn-source-open-selected")?.addEventListener("click", function () { void openSourcePath("source-selected-path"); });
  $("btn-source-copy-selected")?.addEventListener("click", function () { void copySourcePath("source-selected-path"); });

  // ============ Init ============

  initCreateWizard();
  loadMods();
  loadDefaultDir();
  updateQueueBar();

  console.log("[dmcl] Workbench ready");
}
