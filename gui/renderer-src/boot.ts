import { state, pathRefreshTimer, setPathRefreshTimer } from "./state";
import { LOADERS, LOADER_LABELS, STATUS_LABELS, SIDE_LAYOUT_HINTS, SIDE_LAYOUT_HOVER_TIPS, SIDE_LAYOUT_OPTIONS } from "./constants";
import { $, showError, hideError, setText, notify, showView, esc, showModal, showLogModal, setModalLogContent, getLastLogModalText, closeModal, confirmAction } from "./dom";
import { hydrateIcons, icon, loaderIcon } from "./icons";
import { api, apiFetch, fetchWithRetry } from "./api";
import { type JobKind, type JobState, isActive, toMillis, variantStatusOf } from "./contract";
import { HostActivityMonitor, askLaunchWhileBusy, shouldWarnBeforeLaunch } from "./host-activity";
import { launchPanel, lastJobFor, rememberJob } from "./launch-panel";
import { jobHeadline } from "./phases";
import { refreshRelativeTimes, renderVariantCards } from "./variant-card";
import { humanTime, statusView } from "./status";

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
        var tone = variantTone(variant);
        if (tone === "success") builtVariants++;
        if (tone === "danger") failedVariants++;
        if (tone === "running" || tone === "queued") runningVariants++;
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

  async function loadMods(force?: boolean) {
    try {
      var data = await api("/api/mods" + (force ? "?force=1" : ""));
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
    var ok = mod.variants.filter(function (v) { return variantTone(v) === "success"; }).length;
    return ok + "/" + total + " 变体已构建";
  }

  /** Status tone of a variant; old failures read as history ("stale"), not as alarms. */
  function variantTone(variant) {
    return statusView(variantStatusOf(variant)).tone;
  }

  function buildHealthData(mod) {
    var variants = mod.variants || [];
    var total = variants.length;
    var ready = variants.filter(function (v) { return variantTone(v) === "success"; }).length;
    var failed = variants.filter(function (v) { return variantTone(v) === "danger"; }).length;
    var running = variants.filter(function (v) { var t = variantTone(v); return t === "running" || t === "queued"; }).length;
    return { total: total, ready: ready, failed: failed, running: running, percent: total ? Math.round(ready / total * 100) : 0 };
  }

  function modInitials(name) {
    var words = String(name || "DM").trim().split(/\s+/).filter(Boolean);
    return (words.length ? words.slice(0, 2).map(function (word) { return word.slice(0, 1); }).join("") : "DM").toUpperCase();
  }

  function lastBuilt(mod) {
    var latest = 0;
    (mod.variants || []).forEach(function (v) {
      var at = toMillis(variantStatusOf(v).at);
      if (at !== null && at > latest) latest = at;
    });
    var label = latest ? humanTime(latest) : null;
    return label ? "最近活动 " + label : "尚未构建或启动";
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
          '<span class="health-row"><span class="health-track"><i data-health="' + health.percent + '"></i></span><span>' + health.ready + '/' + health.total + ' 就绪' + (health.failed ? ' · ' + health.failed + ' 失败' : '') + (health.running ? ' · ' + health.running + ' 进行中' : '') + '</span></span>' +
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

  var lastMatrixSig = "";

  function renderDetailContent(mod, matrix) {
    $("detail-name").textContent = mod.displayName;
    $("detail-meta").innerHTML =
      '<span>modId: ' + esc(mod.modId) + '</span>' +
      '<span>状态: ' + STATUS_LABELS[mod.status] + '</span>' +
      '<span>变体: ' + mod.variants.length + '</span>';
    // Re-rendering the matrix resets its horizontal scroll; skip it when nothing changed.
    var matrixSig = mod.id + "|" + state.matrixFilter + "|" + JSON.stringify(matrix);
    if (matrixSig !== lastMatrixSig || !$("matrix-wrap")?.querySelector("table.matrix")) {
      lastMatrixSig = matrixSig;
      renderMatrix(mod, matrix);
    }
    renderVariantList(mod);
    updateBuildAllButton(mod);
  }

  function countBuildableVariants(mod, opts) {
    opts = opts || {};
    var count = 0;
    (mod.variants || []).forEach(function (v) {
      if (opts.loader && v.loader !== opts.loader) return;
      if (opts.failedOnly && variantStatusOf(v).state !== "failed") return;
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
    var showMatrixRefresh = opts.force && !opts.quiet && requestId === state.detailRequestId && modId === state.currentModId;

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
      if (!opts.quiet) showError("加载详情失败：" + e.message);
    }
  }

  function cellLabel(status) {
    if (status === "built") return "已构建";
    if (status === "failed") return "失败";
    if (status === "building") return "进行中";
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
        actionButton.disabled = status === "unsupported";
        td.title = ldr.label + " " + ver + " — " + cellLabel(status);

        if (cell && cell.variantId && status !== "available" && status !== "unsupported") {
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
    var el = document.querySelector<HTMLElement>('[data-variant-id="' + variantId + '"]');
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    el.classList.remove("is-spotlit");
    requestAnimationFrame(function () { el.classList.add("is-spotlit"); });
    setTimeout(function () { el.classList.remove("is-spotlit"); }, 1400);
    el.querySelector<HTMLElement>(".btn-launch")?.focus({ preventScroll: true });
  }

  function pickSourceVariant(mod) {
    if (!mod.variants.length) return null;
    return mod.variants[0];
  }

  /** 为新建变体选源码模板：不用目标格自身，并行批量时优先冻结的源变体 ID */
  function pickSourceVariantForTarget(
    mod,
    targetLoader: string,
    targetMc: string,
    frozenSourceId?: string,
  ) {
    var variants = mod.variants || [];
    if (frozenSourceId) {
      var frozen = variants.find(function (v) { return v.id === frozenSourceId; });
      if (frozen) return frozen;
    }
    var crossLoader = variants.find(function (v) {
      return v.mcVersion === targetMc && v.loader !== targetLoader;
    });
    if (crossLoader) return crossLoader;
    var sameLoaderTemplate = variants.find(function (v) {
      return v.loader === targetLoader && v.mcVersion !== targetMc;
    });
    if (sameLoaderTemplate) return sameLoaderTemplate;
    var anyOther = variants.find(function (v) {
      return !(v.loader === targetLoader && v.mcVersion === targetMc);
    });
    return anyOther || variants[0] || null;
  }

  function pickSourceVariantForMc(mod, mcVersion) {
    return pickSourceVariantForTarget(mod, "", mcVersion);
  }

  function parseApiErrorText(raw: string, fallback: string): string {
    var text = (raw || "").trim();
    if (!text) return fallback;
    if (text.charAt(0) === "{") {
      try {
        var parsed = JSON.parse(text) as { error?: string };
        if (parsed.error) return parsed.error;
      } catch { /* ignore */ }
    }
    return text;
  }

  type StreamVariantInfo = {
    id: string;
    loader: string;
    mcVersion: string;
    projectPath: string;
  };

  type VariantStreamResult = {
    exitCode: number;
    variant?: StreamVariantInfo;
    lastErrorLine?: string;
  };

  async function consumeVariantGenerationStream(
    resp: Response,
    onLine?: (line: string) => void,
  ): Promise<VariantStreamResult> {
    if (!resp.ok) {
      var errText = "";
      try { errText = await resp.text(); } catch { /* ignore */ }
      throw new Error(parseApiErrorText(errText, "HTTP " + resp.status));
    }
    if (!resp.body) throw new Error("服务器未返回流式响应");

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var exitCode = 0;
    var lastErrorLine = "";
    var variant: StreamVariantInfo | undefined;

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
        if (line.indexOf("__VARIANT__:") === 0) {
          try {
            variant = JSON.parse(line.slice(12)) as StreamVariantInfo;
          } catch { /* ignore */ }
          return;
        }
        if (line.indexOf("__") === 0) return;
        if (line.indexOf("错误：") === 0) lastErrorLine = line.slice(3);
        if (onLine) onLine(line);
      });
    }

    return { exitCode: exitCode, variant: variant, lastErrorLine: lastErrorLine || undefined };
  }

  function resolveVariantFromStream(
    mod: Record<string, unknown>,
    target: { loader: string; mcVersion: string },
    stream: VariantStreamResult,
  ): StreamVariantInfo {
    if (stream.variant?.id && stream.variant.projectPath) return stream.variant;
    var fromMod = ((mod.variants || []) as StreamVariantInfo[]).find(function (v) {
      return v.loader === target.loader && v.mcVersion === target.mcVersion;
    });
    if (fromMod?.id && fromMod.projectPath) return fromMod;
    var pathGuess = joinProjectPath(String(mod.modId || ""), target.loader, target.mcVersion);
    if (pathGuess) {
      return {
        id: "",
        loader: target.loader,
        mcVersion: target.mcVersion,
        projectPath: pathGuess,
      };
    }
    throw new Error("变体登记失败");
  }

  async function generateVariantQuiet(
    mod,
    loader,
    mcVersion,
    onLine?: (line: string) => void,
    opts?: { modUuid?: string; sourceVariantId?: string },
  ): Promise<StreamVariantInfo> {
    var modUuid = opts?.modUuid || mod.id;
    if (!modUuid) throw new Error("模组信息无效");

    var source = opts?.sourceVariantId
      ? (mod.variants || []).find(function (v) { return v.id === opts.sourceVariantId; })
        || pickSourceVariantForTarget(mod, loader, mcVersion, opts.sourceVariantId)
      : pickSourceVariantForTarget(mod, loader, mcVersion);
    if (!source) throw new Error("没有可用的源变体");

    var resp = await fetchWithRetry("/api/mods/" + encodeURIComponent(String(modUuid)) + "/variants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceVariantId: source.id,
        targetLoader: loader,
        targetMc: mcVersion,
        modId: mod.modId,
        autoBuild: false,
      }),
    });
    var stream = await consumeVariantGenerationStream(resp, onLine);
    if (stream.exitCode !== 0) {
      throw new Error(stream.lastErrorLine || ("生成失败（退出码 " + stream.exitCode + "）"));
    }
    return resolveVariantFromStream(mod, { loader: loader, mcVersion: mcVersion }, stream);
  }

  async function verifyProjectQuiet(
    projectPath: string,
    variantId: string | undefined,
    onLine?: (line: string) => void,
    opts?: { buildOnly?: boolean },
  ) {
    var resp = await fetchWithRetry("/api/verify-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: projectPath,
        variantId: variantId || undefined,
        buildOnly: !!opts?.buildOnly,
      }),
    });
    var stream = await consumeVariantGenerationStream(resp, onLine);
    if (stream.exitCode !== 0) {
      throw new Error(stream.lastErrorLine || ("验证失败（退出码 " + stream.exitCode + "）"));
    }
  }

  async function generateVariantFromMatrix(mod, loader, mc) {
    var source = pickSourceVariantForTarget(mod, loader, mc);
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
      var resp = await apiFetch("/api/mods/" + mod.id + "/variants", {
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
    if (!list) return;
    if (!mod.variants.length) {
      list.innerHTML = '<div class="empty-inline">' + icon("sparkles") + '<div><strong>还没有变体</strong><span>在上方矩阵中点击「可创建」的格子，即可生成对应加载器与版本的项目。</span></div></div>';
      return;
    }
    renderVariantCards(list, mod.variants, {
      hasJob: function (variantId) { return !!lastJobFor(variantId); },
      onAction: function (variant, action) {
        void variantAction(mod.id, variant, action).catch(function (err) {
          showError("操作失败：" + ((err as Error).message || String(err)));
        });
      },
    });
  }

  async function openVariantSourceReports(variant) {
    var mods = (variant.sourceStatus?.mods || []).filter(function (m) { return !!m.reportFilePath; });
    if (!mods.length) {
      notify("还没有可用的依赖 API 报告", "warning");
      return;
    }
    if (mods.length === 1) {
      await api("/api/open-folder", { method: "POST", body: { path: mods[0].reportFilePath } });
      notify("已打开依赖 API 报告");
      return;
    }
    var reportRoot = variant.sourceStatus?.rootPath
      ? variant.sourceStatus.rootPath + "\\mods"
      : mods[0].reportFilePath;
    await api("/api/open-folder", { method: "POST", body: { path: reportRoot } });
    showLogModal(
      "依赖 API 报告",
      mods.map(function (m) {
        return [
          (m.modName || m.modId) + " " + (m.modVersion || ""),
          "  来源：" + (m.sourceKind || "未知") + (m.confidence ? " / " + m.confidence : ""),
          "  许可证：" + (m.license?.id || m.license?.name || "未知"),
          "  报告：" + m.reportFilePath,
        ].join("\n");
      }).join("\n\n"),
    );
    notify("已打开依赖报告文件夹");
  }

  var sourceHubState = {
    modId: "",
    variant: null as any,
  };

  function closeSourceHub() {
    $("source-hub-modal")?.classList.remove("visible");
  }

  async function openSourceHub(modId, variant) {
    sourceHubState.modId = modId;
    sourceHubState.variant = variant;
    var sourceStatus = variant.sourceStatus || {};
    var minecraftReady = sourceStatus.minecraftReady === true;
    var modCount = sourceStatus.modCount || 0;
    setText("source-hub-subtitle", (LOADER_LABELS[variant.loader] || variant.loader) + " " + variant.mcVersion);
    setText(
      "source-hub-project-status",
      minecraftReady ? "Minecraft 已就绪 · " + modCount + " 个模组源码" : "尚未投影到项目 · " + modCount + " 个模组源码",
    );
    var projectButton = $("source-hub-project") as HTMLButtonElement | null;
    if (projectButton) projectButton.textContent = minecraftReady ? "打开" : "准备";
    setText("source-hub-runtime-status", "正在扫描 run/mods");
    $("source-hub-modal")?.classList.add("visible");
    try {
      var data = await api("/api/variants/" + encodeURIComponent(variant.id) + "/runtime-mods") as any;
      var runtimeMods = (data.mods || []).filter(function (item) { return item.supported; });
      var runtimeReady = runtimeMods.filter(function (item) { return item.source?.ready; }).length;
      setText("source-hub-runtime-status", runtimeMods.length
        ? runtimeMods.length + " 个模组 · " + runtimeReady + " 已准备"
        : "run/mods 中没有模组");
    } catch {
      setText("source-hub-runtime-status", "run/mods 扫描失败");
    }
  }

  $("source-hub-close")?.addEventListener("click", closeSourceHub);
  $("source-hub-project")?.addEventListener("click", function () {
    var variant = sourceHubState.variant;
    if (!variant) return;
    closeSourceHub();
    if (variant.sourceStatus?.minecraftReady && variant.sourceStatus?.rootPath) {
      void api("/api/open-folder", { method: "POST", body: { path: variant.sourceStatus.rootPath } });
      return;
    }
    void prepareVariantSources(sourceHubState.modId, variant, false, false);
  });
  $("source-hub-runtime")?.addEventListener("click", function () {
    var variant = sourceHubState.variant;
    if (!variant) return;
    closeSourceHub();
    void openRuntimeSources(variant);
  });
  $("source-hub-adapt")?.addEventListener("click", function () {
    var variant = sourceHubState.variant;
    if (!variant) return;
    closeSourceHub();
    openAdaptCenterForVariant(variant);
  });
  $("source-hub-gradle")?.addEventListener("click", function () {
    var variant = sourceHubState.variant;
    if (!variant) return;
    closeSourceHub();
    void prepareVariantSources(sourceHubState.modId, variant, false, true);
  });

  var runtimeSourcesState = {
    variant: null as any,
    mods: [] as any[],
    selected: new Set<string>(),
  };

  function runtimeSourceBadge(item) {
    if (!item.supported) return { label: "未识别", className: "unsupported" };
    if (!item.source?.ready) return { label: "未准备", className: "" };
    if (item.source.sourceKind === "github-source") return { label: "GitHub 源码", className: "ready" };
    if (item.source.sourceKind === "sources-jar") return { label: "源码包", className: "ready" };
    if (item.source.sourceKind === "cfr-decompile") return { label: "CFR 反编译", className: "cfr" };
    return { label: "已准备", className: "ready" };
  }

  function closeRuntimeSourcesModal() {
    $("runtime-sources-modal")?.classList.remove("visible");
  }

  function renderRuntimeSources() {
    var list = $("runtime-sources-list");
    if (!list) return;
    var mods = runtimeSourcesState.mods;
    var supported = mods.filter(function (item) { return item.supported; });
    var ready = supported.filter(function (item) { return item.source?.ready; });
    setText("runtime-sources-summary", mods.length
      ? mods.length + " 个 JAR · " + ready.length + " 已准备 · " + runtimeSourcesState.selected.size + " 已选择"
      : "未发现 JAR");
    var prepare = $("runtime-sources-prepare") as HTMLButtonElement | null;
    if (prepare) {
      prepare.disabled = runtimeSourcesState.selected.size === 0;
      prepare.innerHTML = icon("sparkles") + "准备所选" + (runtimeSourcesState.selected.size ? " (" + runtimeSourcesState.selected.size + ")" : "");
    }
    list.innerHTML = "";
    if (!mods.length) {
      list.innerHTML = '<p class="muted-placeholder">run/mods 中没有可扫描的 JAR。</p>';
      return;
    }
    mods.forEach(function (item) {
      var badge = runtimeSourceBadge(item);
      var row = document.createElement("div");
      row.className = "runtime-source-row";
      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = runtimeSourcesState.selected.has(item.file);
      checkbox.disabled = !item.supported;
      checkbox.setAttribute("aria-label", "选择 " + (item.modName || item.relativePath));
      checkbox.addEventListener("change", function () {
        if (checkbox.checked) runtimeSourcesState.selected.add(item.file);
        else runtimeSourcesState.selected.delete(item.file);
        renderRuntimeSources();
      });
      var copy = document.createElement("div");
      copy.className = "runtime-source-copy";
      copy.innerHTML =
        '<div class="runtime-source-title"><strong>' + esc(item.modName || item.modId || "未知 JAR") + '</strong>'
          + (item.modVersion ? '<span>' + esc(item.modVersion) + '</span>' : "") + '</div>'
          + '<div class="runtime-source-file">' + esc(item.relativePath) + (item.modId ? " · " + esc(item.modId) : "") + '</div>';
      var meta = document.createElement("div");
      meta.className = "runtime-source-meta";
      meta.innerHTML = '<span class="runtime-source-badge ' + badge.className + '">' + esc(badge.label) + '</span>';
      if (item.source?.ready && item.source.sourcePath) {
        var open = document.createElement("button");
        open.type = "button";
        open.className = "btn btn-icon";
        open.title = "打开源码";
        open.setAttribute("aria-label", "打开源码");
        open.innerHTML = icon("folder");
        open.addEventListener("click", function () {
          void api("/api/open-folder", { method: "POST", body: { path: item.source.sourcePath } });
        });
        meta.appendChild(open);
      }
      row.append(checkbox, copy, meta);
      list.appendChild(row);
    });
  }

  async function refreshRuntimeSources(keepSelection?: boolean) {
    var variant = runtimeSourcesState.variant;
    if (!variant) return;
    var list = $("runtime-sources-list");
    if (list) list.innerHTML = '<p class="loading-placeholder">正在扫描 run/mods…</p>';
    var data = await api("/api/variants/" + encodeURIComponent(variant.id) + "/runtime-mods") as any;
    runtimeSourcesState.mods = data.mods || [];
    var available = new Set(runtimeSourcesState.mods.filter(function (item) { return item.supported; }).map(function (item) { return item.file; }));
    if (keepSelection) {
      runtimeSourcesState.selected = new Set(Array.from(runtimeSourcesState.selected).filter(function (file) { return available.has(file); }));
    } else {
      runtimeSourcesState.selected = new Set(runtimeSourcesState.mods
        .filter(function (item) { return item.supported && !item.source?.ready; })
        .map(function (item) { return item.file; }));
    }
    setText("runtime-sources-path", data.rootPath || "run/mods");
    renderRuntimeSources();
  }

  async function openRuntimeSources(variant) {
    runtimeSourcesState.variant = variant;
    runtimeSourcesState.mods = [];
    runtimeSourcesState.selected.clear();
    $("runtime-sources-modal")?.classList.add("visible");
    try {
      await refreshRuntimeSources(false);
    } catch (err) {
      closeRuntimeSourcesModal();
      showError("读取运行模组失败：" + (err as Error).message);
    }
  }

  async function prepareRuntimeSources() {
    var variant = runtimeSourcesState.variant;
    var files = Array.from(runtimeSourcesState.selected);
    if (!variant || !files.length) return;
    closeRuntimeSourcesModal();
    hideError();
    showModal("准备联动源码", "正在处理所选 run/mods 模组…");
    var cancelButton = $("modal-source-cancel") as HTMLButtonElement | null;
    if (cancelButton) cancelButton.hidden = false;
    try {
      var started = await api("/api/variants/" + encodeURIComponent(variant.id) + "/runtime-mods/sources", {
        method: "POST",
        body: { files: files },
      }) as any;
      var taskId = started.task?.id;
      if (!taskId) throw new Error("服务端未返回源码任务");
      while (true) {
        var status = await api("/api/sources/status") as any;
        var task = status.task;
        if (!task || task.id !== taskId) throw new Error("源码任务状态已丢失");
        setModalLogContent((task.currentPhase ? "阶段: " + sourcePhaseLabel(task.currentPhase) + "\n" : "") + (task.logs || []).join("\n"), { scrollToEnd: true });
        if (task.state !== "running") {
          if (task.state === "completed") {
            invalidateDetailCache();
            await refreshDetail({ force: true });
            closeModal();
            await openRuntimeSources(variant);
            notify("所选运行模组源码已准备", task.dependencyFailures ? "warning" : "success");
          } else if (task.state === "cancelled") {
            closeModal();
            notify("联动源码准备已取消", "warning");
          } else {
            throw new Error(task.lastError || "联动源码准备失败");
          }
          break;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 900); });
      }
    } catch (err) {
      showError("联动源码准备失败：" + (err as Error).message);
      showModal("联动源码准备失败", (err as Error).message);
    } finally {
      if (cancelButton) cancelButton.hidden = true;
    }
  }

  $("runtime-sources-cancel")?.addEventListener("click", closeRuntimeSourcesModal);
  $("runtime-sources-refresh")?.addEventListener("click", function () { void refreshRuntimeSources(true); });
  $("runtime-sources-select-all")?.addEventListener("click", function () {
    runtimeSourcesState.selected = new Set(runtimeSourcesState.mods
      .filter(function (item) { return item.supported && !item.source?.ready; })
      .map(function (item) { return item.file; }));
    renderRuntimeSources();
  });
  $("runtime-sources-prepare")?.addEventListener("click", function () { void prepareRuntimeSources(); });

  async function prepareVariantSources(modId, variant, force, includeDependencies = false) {
    hideError();
    showModal(
      includeDependencies ? "同步 Gradle 依赖源码" : "准备项目开发源码",
      includeDependencies ? "正在解析 Gradle 依赖；项目源码入口会先创建。" : "正在投影 Minecraft 开发源码…",
    );
    var cancelButton = $("modal-source-cancel") as HTMLButtonElement | null;
    if (cancelButton) cancelButton.hidden = false;
    try {
      var started = await api("/api/variants/" + variant.id + "/sources", {
        method: "POST",
        body: { force: force === true, includeDependencies: includeDependencies === true },
      });
      var taskId = started.task?.id;
      if (!taskId) throw new Error("服务端未返回源码任务");
      while (true) {
        var status = await api("/api/sources/status");
        var task = status.task;
        if (!task || task.id !== taskId) throw new Error("源码任务状态已丢失");
        var log = $("modal-log");
        if (log) {
          var dependencyProgress = includeDependencies && task.currentPhase === "dependencies"
            ? (task.dependenciesFound
              ? " · 前置模组 " + (task.dependenciesPrepared || 0) + "/" + task.dependenciesFound
              : " · Gradle 正在解析前置依赖")
            : "";
          var progress = "Minecraft " + task.completed + "/" + task.total
            + (task.currentPhase ? " · " + sourcePhaseLabel(task.currentPhase) : "")
            + dependencyProgress;
          setModalLogContent(progress + "\n" + (task.logs || []).join("\n"), { scrollToEnd: true });
        }
        if (task.state !== "running") {
          if (task.state === "completed") {
            await api("/api/open-folder", { method: "POST", body: { path: task.outputPath } });
            invalidateDetailCache(modId);
            await refreshDetail({ force: true });
            var refreshed = state.detailCache[modId]?.mod?.variants?.find(function (v) { return v.id === variant.id; });
            var reportMods = (refreshed?.sourceStatus?.mods || []).filter(function (m) { return !!m.reportFilePath; });
            showModal(
              "开发源码已准备",
              "项目源码目录：" + task.outputPath + (includeDependencies
                ? "\nMinecraft 源码与 " + (task.dependenciesPrepared || 0) + " 个依赖模组源码已就绪。"
                : "\nMinecraft 源码已就绪。"),
            );
            notify("开发源码已准备并打开文件夹", task.dependencyFailures ? "warning" : "success");
            if (reportMods.length) {
              setModalLogContent(
                getLastLogModalText() + "\n\nDependency API reports:\n" + reportMods.map(function (m) {
                  return "- " + (m.modName || m.modId) + " " + (m.modVersion || "") + " [" + (m.sourceKind || "unknown") + "]";
                }).join("\n"),
              );
            }
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

  // ============ 启动与任务面板 ============

  var hostMonitor = new HostActivityMonitor($("topbar-status"));
  hostMonitor.start();

  var panel = launchPanel({
    onJobFinished: function (job) {
      updateQueueBar();
      if (state.currentModId) {
        invalidateDetailCache(state.currentModId);
        void refreshDetail({ force: true, quiet: true });
      }
      void loadMods();
      if (!panel.isOpen) {
        notify(jobHeadline(job), job.state === "failed" ? "error" : job.state === "succeeded" ? "success" : "warning");
      }
    },
    onRelaunch: function (pv, kind) {
      var found = findVariant(pv.id);
      if (found) void launchVariant(found.mod.id, found.variant, kind).catch(reportActionError);
    },
  });

  function reportActionError(err) {
    showError("操作失败：" + ((err as Error).message || String(err)));
  }

  function findVariant(variantId) {
    for (var i = 0; i < state.mods.length; i++) {
      var mod = state.mods[i];
      var variant = (mod.variants || []).find(function (v) { return v.id === variantId; });
      if (variant) return { mod: mod, variant: variant };
    }
    return null;
  }

  function variantLabel(variant) {
    return (LOADER_LABELS[variant.loader] || variant.loader) + " " + variant.mcVersion;
  }

  /** The stored result of a variant, for the older backend once its live log is gone. */
  async function storedOutcome(modId, variantId): Promise<JobState> {
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        var detail = await api("/api/mods/" + modId + "/detail");
        var v = ((detail.mod && detail.mod.variants) || []).find(function (x) { return x.id === variantId; });
        var st = v ? variantStatusOf(v).state : "unknown";
        if (st === "succeeded" || st === "failed" || st === "cancelled") return st;
        if (st === "unknown") return "cancelled";
      } catch { /* retry */ }
      await new Promise(function (r) { setTimeout(r, 600); });
    }
    return "failed";
  }

  function openJobPanel(modId, variant, jobId: string | null, kind: JobKind, follow: boolean) {
    var mod = state.mods.find(function (m) { return m.id === modId; });
    void panel.open({
      variant: {
        id: variant.id,
        loader: variant.loader,
        mcVersion: variant.mcVersion,
        modVersion: variant.modVersion,
        projectPath: variant.projectPath,
        modName: mod ? mod.displayName : undefined,
      },
      jobId: jobId,
      kind: kind,
      follow: follow,
      outcome: function () { return storedOutcome(modId, variant.id); },
    });
  }

  /** 启动 / 构建: warns first when Linker tests or other heavy work share the host. */
  async function launchVariant(modId, variant, kind: JobKind) {
    if (kind === "run") {
      var activity = await hostMonitor.current(3000);
      if (activity && shouldWarnBeforeLaunch(activity)) {
        var go = await askLaunchWhileBusy(activity, variantLabel(variant));
        if (!go) { notify("已暂缓启动 " + variantLabel(variant)); return; }
      }
    }
    var result = await api("/api/variants/" + encodeURIComponent(variant.id) + "/" + kind, {
      method: "POST",
      body: kind === "build" ? { runClient: false } : {},
    });
    var jobId = result && typeof result.jobId === "string" ? result.jobId : null;
    if (jobId) rememberJob(variant.id, jobId, kind);
    openJobPanel(modId, variant, jobId, kind, true);
    updateQueueBar();
    invalidateDetailCache(modId);
    await refreshDetail({ force: true, quiet: true });
  }

  /** 查看进度 / 日志: reopens the active or last job, else shows the saved log. */
  function showVariantJob(modId, variant) {
    var status = variantStatusOf(variant);
    var remembered = lastJobFor(variant.id);
    var active = isActive(status.state);
    var jobId = status.activeJobId || (remembered ? remembered.jobId : null);
    var kind: JobKind = status.kind || (remembered ? remembered.kind : "run");
    openJobPanel(modId, variant, jobId, kind, active);
  }

  async function variantAction(modId, variant, action) {
    if (action === "run" || action === "build") {
      await launchVariant(modId, variant, action);
    } else if (action === "view-job" || action === "logs") {
      showVariantJob(modId, variant);
    } else if (action === "source-hub") {
      await openSourceHub(modId, variant);
    } else if (action === "sources-report") {
      await openVariantSourceReports(variant);
    } else if (action === "folder") {
      await api("/api/open-folder", { method: "POST", body: { path: variant.projectPath } });
      notify("已请求打开项目文件夹");
    } else if (action === "cursor") {
      await api("/api/open-cursor", { method: "POST", body: { path: variant.projectPath } });
      notify("已请求用 Cursor 打开项目");
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
    var openBtn = $("queue-open");
    if (openBtn) openBtn.hidden = !(panel && panel.currentJob && !panel.isOpen);
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
      }
    });
    if (!cancelled && pending > 0) return;
    state.buildBatch = null;
    if (cancelled) {
      notify(batch.modName + " 构建已取消", "warning");
      return;
    }
    showBuildSummaryFeedback({ success: success, failed: failed, failedVariantIds: [] });
  }

  if (window.dmclBridge) {
    window.dmclBridge.onBuildEvent(function (event) {
      if (event.type === "progress") return;
      updateQueueBar();
      if (event.type === "done") trackBuildBatchDone(event);
      if (event.type === "cancelled") finalizeBuildBatch(true);
      if ((event.type === "done" || event.type === "start" || event.type === "cancelled") && state.currentModId) {
        invalidateDetailCache(state.currentModId);
        refreshDetail({ force: true });
        if (event.type === "done") loadMods();
      }
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

  setInterval(updateQueueBar, 5000);

  // While a variant of the open mod is queued or running, keep its card current even
  // when the backend sends no push events (job API) — cards are keyed, so this is cheap.
  setInterval(function () {
    if (document.hidden || !state.currentModId) return;
    var mod = state.mods.find(function (m) { return m.id === state.currentModId; });
    if (!mod) return;
    var active = (mod.variants || []).some(function (v) { return isActive(variantStatusOf(v).state); });
    if (active) void refreshDetail({ force: true, quiet: true });
  }, 3000);

  setInterval(function () {
    var list = $("variant-list");
    if (list) refreshRelativeTimes(list);
  }, 30000);

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
      apiFetch("/api/cancel").catch(function () {});
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
      var result = await api("/api/meta/refresh", { method: "POST", body: { force: false } });
      delete state.versionsCache[state.selectedLoader];
      state.versionsCache[state.selectedLoader] =
        (result.loaderVersions && result.loaderVersions[state.selectedLoader]) || [];
      updateVersionsHint(false, result.updatedAt);
      await loadVersions(state.selectedLoader);
      notify(
        result.mode === "full"
          ? "版本列表已全量刷新"
          : "版本列表已增量刷新（新增 " + (result.newReleaseCount || 0) + " 个 MC 版本）",
      );
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
    if (retryCount === 0) {
      mapSel.innerHTML = "<option>读取本地缓存…</option>";
      mapSel.disabled = true;
    }
    try {
      var data = await api(
        "/api/mappings/" + state.selectedLoader + "/" + encodeURIComponent(state.selectedMc)
      );
      var options = (data.options || []).filter(function (o) { return o.available !== false; });
      if (!options.length) {
        throw new Error("此版本暂无可用映射");
      }
      applyMappingsData(Object.assign({}, data, { options: options }));
      if (data.pending && retryCount < 2) {
        window.setTimeout(function () { void refreshMappings(retryCount + 1); }, 2000);
      }
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
    var resp = await apiFetch("/api/generate", {
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
      await loadMods(true);
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

  // ============ 外部模组适配中心 ============

  var adaptState = {
    searchRequestId: 0,
    resolveRequestId: 0,
    offset: 0,
    limit: 20,
    totalHits: 0,
    results: [] as any[],
    selectedProjectId: "",
    category: "",
    target: null as any,
    variantId: "",
    lastSourceResult: null as any,
  };

  var ADAPT_DEFAULT_VERSIONS = [
    "26.2", "26.1.2", "26.1.1", "26.1",
    "1.21.11", "1.21.10", "1.21.9", "1.21.8", "1.21.7", "1.21.6",
    "1.21.5", "1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.20.1",
  ];
  var ADAPT_CATEGORIES = [
    ["adventure", "Adventure"],
    ["cursed", "Cursed"],
    ["decoration", "Decoration"],
    ["economy", "Economy"],
    ["equipment", "Equipment"],
    ["food", "Food"],
    ["game-mechanics", "Game Mechanics"],
    ["library", "Library"],
    ["magic", "Magic"],
    ["management", "Management"],
    ["minigame", "Minigame"],
    ["mobs", "Mobs"],
    ["optimization", "Optimization"],
    ["social", "Social"],
    ["storage", "Storage"],
    ["technology", "Technology"],
    ["transportation", "Transportation"],
    ["utility", "Utility"],
    ["worldgen", "World Generation"],
  ];
  var ADAPT_LOADERS = [
    ["fabric", "Fabric"],
    ["forge", "Forge"],
    ["neoforge", "NeoForge"],
  ];

  function allWorkbenchVariants() {
    var out: any[] = [];
    (state.mods || []).forEach(function (mod: any) {
      (mod.variants || []).forEach(function (variant: any) {
        out.push({ mod: mod, variant: variant });
      });
    });
    return out;
  }

  function selectedAdaptVariant() {
    if (!adaptState.variantId) return null;
    return allWorkbenchVariants().find(function (item) { return item.variant.id === adaptState.variantId; }) || null;
  }

  function renderAdaptVariantSelect() {
    var select = $("adapt-variant-select") as HTMLSelectElement | null;
    if (!select) return;
    var previous = adaptState.variantId || select.value;
    select.innerHTML = '<option value="">未绑定变体</option>';
    allWorkbenchVariants().forEach(function (item) {
      var option = document.createElement("option");
      option.value = item.variant.id;
      option.textContent = item.mod.displayName + " · " + (LOADER_LABELS[item.variant.loader] || item.variant.loader) + " " + item.variant.mcVersion;
      select.appendChild(option);
    });
    if (previous && Array.from(select.options).some(function (option) { return option.value === previous; })) {
      select.value = previous;
      adaptState.variantId = previous;
    }
  }

  function applyAdaptVariantToFilters() {
    var selected = selectedAdaptVariant();
    if (!selected) return;
    var loader = $("adapt-loader") as HTMLInputElement | null;
    var mc = $("adapt-mc") as HTMLInputElement | null;
    if (loader) loader.value = selected.variant.loader || "";
    if (mc) mc.value = selected.variant.mcVersion || "";
    syncAdaptFilterButtons();
  }

  function renderAdaptFilterList(
    containerId: string,
    values: string[][],
    activeValue: string,
    attrName: string,
  ) {
    var wrap = $(containerId);
    if (!wrap) return;
    wrap.innerHTML = "";
    values.forEach(function (item) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "adapt-filter-option" + (item[0] === activeValue ? " active" : "");
      button.dataset[attrName] = item[0];
      button.innerHTML = attrName === "adaptLoader"
        ? loaderIcon(item[0]) + '<span>' + esc(item[1]) + '</span>'
        : '<span>' + esc(item[1]) + '</span>';
      wrap.appendChild(button);
    });
  }

  function visibleAdaptVersions() {
    var showAll = ($("adapt-show-all-versions") as HTMLInputElement | null)?.checked === true;
    var typed = (($("adapt-mc") as HTMLInputElement | null)?.value || "").trim();
    var versions = showAll
      ? ADAPT_DEFAULT_VERSIONS
      : ADAPT_DEFAULT_VERSIONS.slice(0, 8);
    if (typed && !versions.includes(typed)) versions = [typed].concat(versions);
    return versions.map(function (version) { return [version, version]; });
  }

  function renderAdaptFilters() {
    renderAdaptFilterList("adapt-version-list", visibleAdaptVersions(), (($("adapt-mc") as HTMLInputElement | null)?.value || "").trim(), "adaptMc");
    renderAdaptFilterList("adapt-loader-list", ADAPT_LOADERS, (($("adapt-loader") as HTMLInputElement | null)?.value || ""), "adaptLoader");
    renderAdaptFilterList("adapt-category-list", ADAPT_CATEGORIES, adaptState.category, "adaptCategory");
  }

  function syncAdaptFilterButtons() {
    document.querySelectorAll<HTMLElement>("[data-adapt-mc]").forEach(function (button) {
      button.classList.toggle("active", button.dataset.adaptMc === (($("adapt-mc") as HTMLInputElement | null)?.value || "").trim());
    });
    document.querySelectorAll<HTMLElement>("[data-adapt-loader]").forEach(function (button) {
      button.classList.toggle("active", button.dataset.adaptLoader === (($("adapt-loader") as HTMLInputElement | null)?.value || ""));
    });
    document.querySelectorAll<HTMLElement>("[data-adapt-category]").forEach(function (button) {
      button.classList.toggle("active", button.dataset.adaptCategory === adaptState.category);
    });
  }

  function openAdaptCenterForVariant(variant) {
    adaptState.variantId = variant.id;
    renderAdaptVariantSelect();
    applyAdaptVariantToFilters();
    setAdaptDetailMode(false);
    showView("adapt");
    void loadAdaptView();
  }

  function setAdaptDetailMode(enabled: boolean) {
    $("view-adapt")?.classList.toggle("adapt-detail-mode", enabled);
  }

  function backToAdaptResults() {
    adaptState.resolveRequestId++;
    setAdaptDetailMode(false);
    adaptState.target = null;
    adaptState.lastSourceResult = null;
    var detail = $("adapt-detail");
    if (detail) {
      detail.classList.remove("visible");
      detail.innerHTML = "";
    }
    requestAnimationFrame(function () {
      $("view-adapt")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function loadAdaptView() {
    if (!state.modsFetchedAt) {
      await loadMods();
    }
    setAdaptDetailMode(false);
    renderAdaptVariantSelect();
    applyAdaptVariantToFilters();
    renderAdaptFilters();
    if (!$("adapt-detail")?.classList.contains("visible")) {
      var detail = $("adapt-detail");
      if (detail) {
        detail.classList.add("visible");
        detail.innerHTML = '<p class="muted-placeholder">选择一个搜索结果查看版本、依赖和源码候选。</p>';
      }
    }
    if (!adaptState.results.length) {
      void searchAdaptMods(true);
    }
  }

  function adaptSearchParams(resetOffset?: boolean) {
    if (resetOffset) adaptState.offset = 0;
    var query = (($("adapt-query") as HTMLInputElement | null)?.value || "").trim();
    var source = (($("adapt-source") as HTMLSelectElement | null)?.value || "all");
    var loader = (($("adapt-loader") as HTMLInputElement | null)?.value || "");
    var mc = (($("adapt-mc") as HTMLInputElement | null)?.value || "").trim();
    var sort = (($("adapt-sort") as HTMLSelectElement | null)?.value || "downloads");
    var limit = Number((($("adapt-limit") as HTMLSelectElement | null)?.value || adaptState.limit));
    adaptState.limit = Number.isFinite(limit) && limit > 0 ? limit : 20;
    var params = new URLSearchParams();
    params.set("query", query);
    params.set("source", source);
    params.set("sort", sort);
    params.set("offset", String(adaptState.offset));
    params.set("limit", String(adaptState.limit));
    if (loader) params.set("loader", loader);
    if (mc) params.set("mcVersion", mc);
    if (adaptState.category) params.set("category", adaptState.category);
    return params;
  }

  async function searchAdaptMods(resetOffset?: boolean) {
    var requestId = ++adaptState.searchRequestId;
    hideError();
    var results = $("adapt-results");
    if (results) results.innerHTML = '<p class="loading-placeholder">搜索中...</p>';
    setText("adapt-count", "搜索中");
    try {
      var data = await api("/api/mod-intel/search?" + adaptSearchParams(resetOffset).toString()) as any;
      if (requestId !== adaptState.searchRequestId) return;
      adaptState.results = data.results || [];
      adaptState.totalHits = data.totalHits || 0;
      renderAdaptResults(data);
    } catch (e) {
      if (requestId !== adaptState.searchRequestId) return;
      if (results) results.innerHTML = '<p class="muted-placeholder">搜索失败</p>';
      showError("模组搜索失败：" + (e as Error).message);
    }
  }

  function renderAdaptResults(data) {
    var warning = $("adapt-warning");
    var warnings = data.warnings || [];
    if (warning) {
      warning.hidden = warnings.length === 0;
      warning.textContent = warnings.join(" ");
    }
    var total = data.totalHits || adaptState.totalHits || 0;
    var start = total ? adaptState.offset + 1 : 0;
    var end = Math.min(adaptState.offset + adaptState.limit, total);
    setText("adapt-count", total + " 个结果 · " + start + "-" + end);
    setText("adapt-page-label", total ? ("第 " + (Math.floor(adaptState.offset / adaptState.limit) + 1) + " 页") : "第 0 页");
    var prev = $("adapt-prev") as HTMLButtonElement | null;
    var next = $("adapt-next") as HTMLButtonElement | null;
    if (prev) prev.disabled = adaptState.offset <= 0;
    if (next) next.disabled = adaptState.offset + adaptState.limit >= total;
    var results = $("adapt-results");
    if (!results) return;
    results.innerHTML = "";
    if (!adaptState.results.length) {
      results.innerHTML = '<p class="muted-placeholder">没有匹配结果</p>';
      return;
    }
    adaptState.results.forEach(function (item, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "adapt-result" + (adaptState.selectedProjectId === item.projectId ? " selected" : "");
      button.dataset.index = String(index);
      var iconHtml = item.iconUrl
        ? '<img src="' + esc(item.iconUrl) + '" alt="">'
        : esc((item.title || "MOD").slice(0, 2).toUpperCase());
      var loaders = (item.loaders || []).map(function (loader) { return LOADER_LABELS[loader] || loader; }).join("/");
      var versions = (item.versions || []).slice(0, 4).join(" ");
      var tags = [
        loaders || "任意加载器",
        versions || "Any MC",
        item.license || "许可证未知",
        item.openSource ? "有源码" : "无源码链接",
      ].filter(Boolean);
      button.innerHTML =
        '<span class="adapt-icon">' + iconHtml + '</span>' +
        '<span class="adapt-result-main">' +
          '<span class="adapt-result-title"><strong>' + esc(item.title || item.slug || item.projectId) + '</strong><span class="adapt-provider">' + esc(item.provider) + '</span></span>' +
          '<span class="adapt-result-desc">' + esc(item.description || "") + '</span>' +
          '<span class="adapt-tags">' + tags.map(function (tag) { return '<span>' + esc(tag) + '</span>'; }).join("") + '</span>' +
        '</span>' +
        '<span class="adapt-result-stat">' + (item.downloads ? Number(item.downloads).toLocaleString() + " 下载" : "") + '</span>';
      button.addEventListener("click", function () {
        void selectAdaptResult(item).catch(function (err) { showError("解析模组失败：" + (err as Error).message); });
      });
      results.appendChild(button);
    });
  }

  async function selectAdaptResult(item) {
    var requestId = ++adaptState.resolveRequestId;
    adaptState.selectedProjectId = item.projectId;
    adaptState.lastSourceResult = null;
    renderAdaptResults({ totalHits: adaptState.totalHits, warnings: [], results: adaptState.results });
    var detail = $("adapt-detail");
    if (detail) {
      setAdaptDetailMode(true);
      detail.classList.add("visible");
      detail.innerHTML = '<p class="loading-placeholder">正在解析版本与源码候选...</p>';
      requestAnimationFrame(function () {
        detail.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    var loader = (($("adapt-loader") as HTMLInputElement | null)?.value || undefined) as string | undefined;
    var mc = (($("adapt-mc") as HTMLInputElement | null)?.value || "").trim() || undefined;
    try {
      var resolved = await api("/api/mod-intel/resolve", {
        method: "POST",
        body: {
          kind: "modrinth",
          projectIdOrSlug: item.slug || item.projectId,
          loader: loader || undefined,
          mcVersion: mc,
        },
      }) as any;
      if (requestId !== adaptState.resolveRequestId) return;
      adaptState.target = resolved.target;
      renderAdaptDetail(resolved.target);
    } catch (err) {
      if (requestId === adaptState.resolveRequestId) throw err;
    }
  }

  function renderAdaptDetail(target) {
    var detail = $("adapt-detail");
    if (!detail) return;
    detail.classList.add("visible");
    var version = target.selectedVersion || {};
    var deps = version.dependencies || [];
    var files = version.files || [];
    var sourceRows = (target.sourceCandidates || []).map(function (candidate, index) {
      var checked = index === 0 ? " checked" : "";
      return '<label class="adapt-source-row">' +
        '<input type="radio" name="adapt-source-choice" value="' + esc(candidate.sourceKind) + '"' + checked + '>' +
        '<span><strong>' + esc(candidate.sourceKind) + '</strong><br><span>' + esc(candidate.reason || candidate.provider) + '</span></span>' +
        '<span>' + esc(candidate.confidence || "unknown") + '</span>' +
      '</label>';
    }).join("");
    var dependencyList = deps.length
      ? deps.map(function (dep) {
        return '<span>' + esc(dep.dependencyType || "dependency") + (dep.projectId ? " · " + dep.projectId : "") + '</span>';
      }).join("")
      : '<span>无依赖记录</span>';
    var fileList = files.length
      ? files.map(function (file) { return '<span>' + esc(file.fileName) + '</span>'; }).join("")
      : '<span>无文件记录</span>';
    var snippet = (target.dependencySnippets || [])[0] || "该来源没有可用的依赖声明片段。";
    var result = adaptState.lastSourceResult;
    detail.innerHTML =
      '<button class="back-link" id="adapt-detail-back" type="button">' + icon("chevron-left") + '返回搜索结果</button>' +
      '<div class="adapt-detail-head">' +
        '<div><h3>' + esc(target.modName || target.title) + '</h3>' +
          '<p>' + esc(target.projectUrl || target.sourceUrl || target.provider) + '</p>' +
          '<div class="adapt-detail-meta">' +
            '<span>modId: ' + esc(target.modId || "-") + '</span>' +
            '<span>version: ' + esc(target.modVersion || "-") + '</span>' +
            '<span>loader: ' + esc(target.loader || (($("adapt-loader") as HTMLInputElement | null)?.value || "-")) + '</span>' +
            '<span>MC: ' + esc(target.minecraftVersion || (($("adapt-mc") as HTMLInputElement | null)?.value || "-")) + '</span>' +
            '<span>license: ' + esc(target.license || "unknown") + '</span>' +
          '</div></div>' +
        '<div class="adapt-detail-actions">' +
          '<button class="btn btn-primary btn-sm" id="btn-adapt-prepare" type="button">' + icon("sparkles") + '准备源码</button>' +
          '<button class="btn btn-secondary btn-sm" id="btn-adapt-save" type="button">保存适配档案</button>' +
          '<button class="btn btn-secondary btn-sm" id="btn-adapt-open-source" type="button"' + (result ? "" : " disabled") + '>打开源码</button>' +
          '<button class="btn btn-secondary btn-sm" id="btn-adapt-open-report" type="button"' + (result ? "" : " disabled") + '>打开报告</button>' +
        '</div>' +
      '</div>' +
      '<div class="adapt-detail-grid">' +
        '<div class="adapt-detail-block"><h4>源码候选</h4><div class="adapt-source-list">' + sourceRows + '</div></div>' +
        '<div class="adapt-detail-block"><h4>依赖片段</h4><pre class="adapt-snippet" id="adapt-snippet">' + esc(snippet) + '</pre><div class="adapt-detail-actions"><button class="btn btn-secondary btn-sm" id="btn-adapt-copy-snippet" type="button">' + icon("copy") + '复制片段</button></div></div>' +
        '<div class="adapt-detail-block"><h4>版本文件</h4><div class="adapt-tags">' + fileList + '</div></div>' +
        '<div class="adapt-detail-block"><h4>依赖关系</h4><div class="adapt-tags">' + dependencyList + '</div></div>' +
      '</div>';
    $("adapt-detail-back")?.addEventListener("click", backToAdaptResults);
    $("btn-adapt-prepare")?.addEventListener("click", function () { void prepareAdaptSources(); });
    $("btn-adapt-save")?.addEventListener("click", function () { void saveAdaptProfile(); });
    $("btn-adapt-open-source")?.addEventListener("click", function () { void openAdaptSource(); });
    $("btn-adapt-open-report")?.addEventListener("click", function () { void openAdaptReport(); });
    $("btn-adapt-copy-snippet")?.addEventListener("click", function () { void copyAdaptSnippet(); });
  }

  function selectedAdaptSourceKind() {
    return (document.querySelector('input[name="adapt-source-choice"]:checked') as HTMLInputElement | null)?.value || undefined;
  }

  async function prepareAdaptSources() {
    if (!adaptState.target) return;
    hideError();
    var selected = selectedAdaptVariant();
    var loader = (($("adapt-loader") as HTMLInputElement | null)?.value || adaptState.target.loader || selected?.variant.loader || "") as string;
    var mc = (($("adapt-mc") as HTMLInputElement | null)?.value || adaptState.target.minecraftVersion || selected?.variant.mcVersion || "").trim();
    if (!loader || !mc) {
      showError("请先选择加载器和 Minecraft 版本");
      return;
    }
    showModal("准备外部模组源码", "正在下载文件并准备源码...");
    try {
      var started = await api("/api/mod-intel/sources", {
        method: "POST",
        body: {
          target: adaptState.target,
          loader: loader,
          mcVersion: mc,
          projectPath: selected?.variant.projectPath,
          preferredSourceKind: selectedAdaptSourceKind(),
        },
      }) as any;
      var taskId = started.task?.id;
      if (!taskId) throw new Error("服务端未返回源码任务");
      while (true) {
        var status = await api("/api/mod-intel/status") as any;
        var task = status.task;
        if (!task || task.id !== taskId) throw new Error("源码任务状态已丢失");
        setModalLogContent(
          (task.phase ? "阶段: " + task.phase + "\n" : "")
          + (task.logs || []).join("\n"),
          { scrollToEnd: true },
        );
        if (task.state !== "running") {
          if (task.state === "completed") {
            adaptState.lastSourceResult = task.result;
            var openSourcePath = task.result.projectModSourcePath || task.result.sourcePath;
            await api("/api/open-folder", { method: "POST", body: { path: openSourcePath } });
            if (selected) await saveAdaptProfile(task.result.unitId, false);
            renderAdaptDetail(adaptState.target);
            showModal("外部模组源码已准备", "源码目录:\n" + openSourcePath + (task.result.projectSourcePath ? "\n\n项目源码入口:\n" + task.result.projectSourcePath : "") + "\n\n报告:\n" + (task.result.reportPath || "无"));
            notify("外部模组源码已准备", "success");
          } else {
            var taskLog = (task.logs || []).join("\n");
            throw new Error((task.lastError || "源码准备失败") + (taskLog ? "\n\n" + taskLog : ""));
          }
          break;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 900); });
      }
    } catch (e) {
      showError("外部模组源码准备失败：" + (e as Error).message);
      showModal("外部模组源码准备失败", (e as Error).message);
    }
  }

  async function saveAdaptProfile(sourceUnitId?: string, notifyUser = true) {
    if (!adaptState.target) return;
    var selected = selectedAdaptVariant();
    if (!selected) {
      if (notifyUser) notify("请先绑定一个变体", "warning");
      return;
    }
    var profile = await api("/api/variants/" + encodeURIComponent(selected.variant.id) + "/compat", {
      method: "POST",
      body: {
        target: {
          ...adaptState.target,
          loader: (($("adapt-loader") as HTMLInputElement | null)?.value || adaptState.target.loader || selected.variant.loader),
          minecraftVersion: (($("adapt-mc") as HTMLInputElement | null)?.value || adaptState.target.minecraftVersion || selected.variant.mcVersion),
        },
        sourceUnitId: sourceUnitId || adaptState.lastSourceResult?.unitId,
        dependencySnippets: adaptState.target.dependencySnippets || [],
      },
    }) as any;
    if (notifyUser) notify("适配档案已保存", "success");
    return profile;
  }

  async function openAdaptSource() {
    var result = adaptState.lastSourceResult;
    if (!result) return;
    if (result.projectModSourcePath) {
      await api("/api/open-folder", { method: "POST", body: { path: result.projectModSourcePath } });
      return;
    }
    await api("/api/mod-intel/sources/" + encodeURIComponent(result.unitId) + "/open", { method: "POST" });
  }

  async function openAdaptReport() {
    var unitId = adaptState.lastSourceResult?.unitId;
    if (!unitId) return;
    var report = await api("/api/mod-intel/sources/" + encodeURIComponent(unitId) + "/report") as any;
    showLogModal("外部模组 API 报告", report.content || "", { copyLabel: "复制报告" });
  }

  async function copyAdaptSnippet() {
    var snippet = $("adapt-snippet")?.textContent || "";
    if (!snippet.trim()) return;
    await navigator.clipboard.writeText(snippet);
    notify("依赖片段已复制", "success");
  }

  async function refreshAllMetaFromSettings() {
    var btn = $("btn-settings-refresh-versions") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      await api("/api/meta/refresh", { method: "POST", body: { force: true } });
      state.versionsCache = {};
      invalidateDetailCache();
      await loadMetaCacheStatus();
      notify("版本列表已全量刷新（含全部 Forge MDK 重探）");
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
  $("modal-copy-log")?.addEventListener("click", async function () {
    var text = getLastLogModalText();
    if (!text.trim()) {
      notify("没有可复制的内容", "warning");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      notify("日志已复制到剪贴板", "success");
    } catch {
      var logEl = $("modal-log");
      if (logEl) {
        var range = document.createRange();
        range.selectNodeContents(logEl);
        var sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        notify("自动复制失败，请 Ctrl+C 复制已选中文本", "warning");
      }
    }
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
    if (event.target === $("modal-overlay")) {
      closeModal();
    }
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
      else if (visibleOverlay.id === "add-variant-modal") closeAddVariantModal();
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
        if (view === "adapt") loadAdaptView();
        if (view === "external") loadExternalView();
        if (view === "list") loadMods(true);
      }
    });
  });

  $("detail-back").addEventListener("click", function () {
    state.currentModId = null;
    showView("list");
    loadMods(true);
  });

  $("btn-new-mod").addEventListener("click", function () {
    document.querySelector('.nav-btn[data-view="create"]').click();
  });

  $("btn-adapt-search")?.addEventListener("click", function () {
    void searchAdaptMods(true);
  });
  $("adapt-query")?.addEventListener("keydown", function (event) {
    if ((event as KeyboardEvent).key === "Enter") void searchAdaptMods(true);
  });
  $("adapt-mc")?.addEventListener("keydown", function (event) {
    if ((event as KeyboardEvent).key === "Enter") {
      renderAdaptFilters();
      void searchAdaptMods(true);
    }
  });
  $("adapt-mc")?.addEventListener("input", function () {
    renderAdaptFilters();
  });
  $("adapt-show-all-versions")?.addEventListener("change", function () {
    renderAdaptFilters();
  });
  $("adapt-source")?.addEventListener("change", function () { void searchAdaptMods(true); });
  $("adapt-sort")?.addEventListener("change", function () { void searchAdaptMods(true); });
  $("adapt-limit")?.addEventListener("change", function () { void searchAdaptMods(true); });
  $("view-adapt")?.addEventListener("click", function (event) {
    var target = event.target as HTMLElement;
    var button = target.closest<HTMLElement>("[data-adapt-mc], [data-adapt-loader], [data-adapt-category], [data-adapt-clear]");
    if (!button) return;
    if (button.dataset.adaptMc !== undefined) {
      var mc = $("adapt-mc") as HTMLInputElement | null;
      if (mc) mc.value = button.dataset.adaptMc || "";
    } else if (button.dataset.adaptLoader !== undefined) {
      var loader = $("adapt-loader") as HTMLInputElement | null;
      if (loader) loader.value = button.dataset.adaptLoader || "";
    } else if (button.dataset.adaptCategory !== undefined) {
      adaptState.category = button.dataset.adaptCategory || "";
      var category = $("adapt-category") as HTMLInputElement | null;
      if (category) category.value = adaptState.category;
    } else if (button.dataset.adaptClear === "mc") {
      var mcInput = $("adapt-mc") as HTMLInputElement | null;
      if (mcInput) mcInput.value = "";
    } else if (button.dataset.adaptClear === "loader") {
      var loaderInput = $("adapt-loader") as HTMLInputElement | null;
      if (loaderInput) loaderInput.value = "";
    } else if (button.dataset.adaptClear === "category") {
      adaptState.category = "";
      var categoryInput = $("adapt-category") as HTMLInputElement | null;
      if (categoryInput) categoryInput.value = "";
    }
    renderAdaptFilters();
    void searchAdaptMods(true);
  });
  $("btn-adapt-refresh")?.addEventListener("click", function () {
    void loadMods(true).then(function () {
      renderAdaptVariantSelect();
      if (adaptState.results.length) void searchAdaptMods(false);
    });
  });
  $("adapt-prev")?.addEventListener("click", function () {
    adaptState.offset = Math.max(0, adaptState.offset - adaptState.limit);
    void searchAdaptMods(false);
  });
  $("adapt-next")?.addEventListener("click", function () {
    if (adaptState.offset + adaptState.limit >= adaptState.totalHits) return;
    adaptState.offset += adaptState.limit;
    void searchAdaptMods(false);
  });
  $("adapt-variant-select")?.addEventListener("change", function () {
    adaptState.variantId = (($("adapt-variant-select") as HTMLSelectElement | null)?.value || "");
    applyAdaptVariantToFilters();
    renderAdaptFilters();
    void searchAdaptMods(true);
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

  async function deleteModWithProgress(modId: string, body: { deleteFiles?: boolean }) {
    var mod = state.mods.find(function (m) { return m.id === modId; });
    var variantCount = mod ? (mod.variants || []).length : 0;
    var useStream = !!(body.deleteFiles && variantCount > 1);

    if (useStream) {
      showModal("正在删除模组", "准备删除 " + variantCount + " 个变体项目…");
      var log = $("modal-log");
      var closeBtn = $("modal-close") as HTMLButtonElement | null;
      if (closeBtn) closeBtn.disabled = true;

      var resp = await apiFetch("/api/mods/" + modId, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        closeModal();
        var errData = await resp.json().catch(function () { return {}; }) as { error?: string };
        throw new Error(errData.error || ("HTTP " + resp.status));
      }

      var reader = resp.body!.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      var result: Record<string, unknown> | null = null;

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (var li = 0; li < lines.length; li++) {
          var line = lines[li].trim();
          if (!line) continue;
          var evt = JSON.parse(line) as { type?: string; done?: number; total?: number; path?: string; error?: string };
          if (evt.type === "progress" && log) {
            var pct = evt.total ? Math.round((evt.done || 0) / evt.total * 100) : 0;
            log.innerHTML = "";
            var div = document.createElement("div");
            div.textContent = "正在删除 " + (evt.done || 0) + "/" + evt.total + "（" + pct + "%）";
            log.appendChild(div);
            if (evt.path) {
              var pathDiv = document.createElement("div");
              pathDiv.className = "path";
              pathDiv.textContent = evt.path;
              log.appendChild(pathDiv);
            }
          } else if (evt.type === "error") {
            closeModal();
            throw new Error(evt.error || "删除失败");
          } else if (evt.type === "done") {
            result = evt;
          }
        }
      }
      closeModal();
      if (closeBtn) closeBtn.disabled = false;
      return result || {};
    }

    return api("/api/mods/" + modId, { method: "DELETE", body: body });
  }

  $("btn-delete-mod").addEventListener("click", async function () {
    if (!state.currentModId) return;
    var mod = state.mods.find(function (m) { return m.id === state.currentModId; });
    if (!mod) return;
    var paths = (mod.variants || []).map(function (v) { return v.projectPath; }).join("\n  · ");
    var msg = "删除整个模组「" + mod.displayName + "」？\n\n将删除 " + mod.variants.length +
      " 个变体的项目文件夹：\n  · " + (paths || "(无变体)") +
      "\n\n此操作不可恢复。";
    if (!await confirmAction({ title: "永久删除模组", message: "将删除「" + mod.displayName + "」及其 " + mod.variants.length + " 个变体项目，此操作不可恢复。", detail: paths || "(无变体目录)", confirmLabel: "删除模组与文件", danger: true })) return;
    var deletingId = state.currentModId;
    try {
      var result = await deleteModWithProgress(deletingId!, { deleteFiles: true }) as {
        fileResult?: { deleted?: string[] };
      };
      state.currentModId = null;
      invalidateDetailCache();
      showView("list");
      await loadMods(true);
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
      if (opts.failedOnly && variantStatusOf(v).state !== "failed") return false;
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
        var cell = (matrix.cells || []).find(function (c) {
          return c.loader === loader && c.mcVersion === mcVersion;
        });
        if (cell && cell.status !== "available") return;
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
          + (totalCount >= 8 ? " 大批量时若失败增多，请在设置中降低 Gradle 构建并发（2～4）后重试失败项。" : "")
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
    var buildAllSource = pickSourceVariant(mod);
    var frozenBuildSourceId = buildAllSource ? buildAllSource.id : undefined;
    var genErrors: string[] = [];

    hideError();
    setBuildAllBusy(true, "准备中…");

    try {
      if (includeMissingLoaders && targets.pending.length) {
        for (var i = 0; i < targets.pending.length; i++) {
          var pending = targets.pending[i];
          var already = (mod.variants || []).some(function (v) {
            return v.loader === pending.loader && v.mcVersion === pending.mcVersion;
          });
          if (already) continue;
          setBuildAllBusy(
            true,
            "正在生成 " + (LOADER_LABELS[pending.loader] || pending.loader) + " "
              + pending.mcVersion + "（" + (i + 1) + "/" + targets.pending.length + "）…",
          );
          try {
            await generateVariantQuiet(mod, pending.loader, pending.mcVersion, undefined, {
              modUuid: modId,
              sourceVariantId: frozenBuildSourceId,
            });
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

  var addVariantPendingMod: Record<string, unknown> | null = null;
  var addVariantPendingMatrix: Record<string, unknown> | null = null;
  var addVariantReturnFocus: HTMLElement | null = null;
  var addVariantBusy = false;
  var addVariantBatchJobId: string | null = null;
  var addVariantPollTimer: ReturnType<typeof setInterval> | null = null;
  var addVariantPollInFlight = false;
  var addVariantTaskStates: Array<{
    loader: string;
    mcVersion: string;
    status: "pending" | "running" | "done" | "failed";
    message: string;
  }> = [];
  function stopAddVariantPolling() {
    if (addVariantPollTimer) {
      clearInterval(addVariantPollTimer);
      addVariantPollTimer = null;
    }
  }

  function mapBatchTargetStatus(status: string): "pending" | "running" | "done" | "failed" {
    if (status === "done" || status === "skipped") return "done";
    if (status === "failed" || status === "cancelled") return "failed";
    if (status === "generating" || status === "verifying") return "running";
    return "pending";
  }

  function syncAddVariantProgressFromJob(job: {
    phase?: string;
    targets?: Array<{ loader: string; mcVersion: string; status: string; message?: string; error?: string }>;
    successes?: number;
    failures?: number;
    skipped?: number;
    total?: number;
    verifyParallel?: number;
    gradleParallel?: number;
  }) {
    if (!job.targets?.length) return;
    job.targets.forEach(function (target, index) {
      if (!addVariantTaskStates[index]) return;
      addVariantTaskStates[index].status = mapBatchTargetStatus(target.status);
      addVariantTaskStates[index].message = target.error || target.message || "";
    });
    renderAddVariantProgress();
    var summary = $("add-variant-summary");
    if (summary) {
      var phaseLabel = job.phase === "verify"
        ? "构建验证中"
        : job.phase === "generate" ? "生成项目中" : "收尾中";
      summary.textContent = phaseLabel + " · 成功 " + (job.successes || 0)
        + " / " + (job.total || job.targets.length)
        + (job.skipped ? " · 跳过 " + job.skipped : "")
        + (job.failures ? " · 失败 " + job.failures : "")
        + (job.verifyParallel
          ? " · 验证 worker " + job.verifyParallel + " 路 · Gradle "
            + (job.gradleParallel ?? 1) + " 路"
          : "");
    }
  }

  function startAddVariantJobPolling(jobId: string, modId: string) {
    stopAddVariantPolling();
    addVariantBatchJobId = jobId;
    addVariantPollTimer = setInterval(function () {
      void (async function () {
        if (addVariantPollInFlight) return;
        addVariantPollInFlight = true;
        try {
          var data = await api("/api/batch-jobs/" + encodeURIComponent(jobId)) as {
            job?: {
              state: string;
              phase?: string;
              targets?: Array<{ loader: string; mcVersion: string; status: string; message?: string; error?: string }>;
              successes?: number;
              failures?: number;
              skipped?: number;
              total?: number;
              verifyParallel?: number;
              gradleParallel?: number;
            };
          };
          var job = data.job;
          if (!job) return;
          syncAddVariantProgressFromJob(job);
          if (job.state === "running" || job.state === "pending") return;

          stopAddVariantPolling();
          addVariantBatchJobId = null;
          setAddVariantBusy(true, "完成：成功 " + (job.successes || 0)
            + (job.skipped ? "，跳过 " + job.skipped : "")
            + (job.failures ? "，失败 " + job.failures : ""));

          closeAddVariantModal(true);
          invalidateDetailCache(modId);
          await refreshDetail({ force: true });
          await loadMods(true);

          var errors = (job.targets || [])
            .filter(function (t) { return t.status === "failed"; })
            .map(function (t) {
              return (LOADER_LABELS[t.loader] || t.loader) + " " + t.mcVersion
                + "：" + (t.error || t.message || "失败");
            });

          if (job.successes || job.skipped) {
            notify("批量完成：成功 " + (job.successes || 0)
              + (job.skipped ? "，跳过 " + job.skipped : "")
              + (job.failures ? "，失败 " + job.failures : ""),
              job.failures ? "warning" : "success");
          } else {
            showError("批量创建失败：" + (errors[0] || "未知错误"));
          }
          if (errors.length > 1) {
            showModal("部分变体创建或验证失败", errors.join("\n"));
          }
          setAddVariantBusy(false);
        } catch (e) {
          /* 轮询失败时继续重试 */
        } finally {
          addVariantPollInFlight = false;
        }
      })();
    }, 1200);
  }

  var ADD_VARIANT_LOADER_ORDER: Record<string, number> = {
    fabric: 0,
    forge: 1,
    neoforge: 2,
  };

  type MatrixCell = { loader: string; mcVersion: string; status: string };

  function collectMatrixAvailable(
    matrix: Record<string, unknown> | null,
    mod: Record<string, unknown> | null,
    loader?: string,
  ): Array<{ loader: string; mcVersion: string }> {
    var cells = (matrix?.cells || []) as MatrixCell[];
    var order = ((matrix?.versions || []) as string[]);
    var registered = (mod?.variants || []) as Array<{ loader: string; mcVersion: string }>;
    var out = cells.filter(function (c) {
      if (c.status !== "available") return false;
      if (loader && c.loader !== loader) return false;
      if (registered.some(function (v) {
        return v.loader === c.loader && v.mcVersion === c.mcVersion;
      })) return false;
      return true;
    }).map(function (c) {
      return { loader: c.loader, mcVersion: c.mcVersion };
    });
    out.sort(function (a, b) {
      var lo = (ADD_VARIANT_LOADER_ORDER[a.loader] ?? 99) - (ADD_VARIANT_LOADER_ORDER[b.loader] ?? 99);
      if (lo !== 0) return lo;
      var ai = order.indexOf(a.mcVersion);
      var bi = order.indexOf(b.mcVersion);
      if (ai < 0 && bi < 0) return b.mcVersion.localeCompare(a.mcVersion);
      if (ai < 0) return 1;
      if (bi < 0) return -1;
      return ai - bi;
    });
    return out;
  }

  function addVariantLoaderFilterValue(): string | undefined {
    var loaderEl = $("add-variant-loader") as HTMLSelectElement | null;
    var value = loaderEl ? loaderEl.value : "";
    return value || undefined;
  }

  function setAddVariantProgressVisible(visible: boolean) {
    var panel = $("add-variant-progress-panel") as HTMLElement | null;
    var list = $("add-variant-list") as HTMLElement | null;
    if (panel) panel.hidden = !visible;
    if (list) list.hidden = visible;
  }

  function renderAddVariantProgress() {
    var statsEl = $("add-variant-progress-stats");
    var listEl = $("add-variant-progress-list");
    if (!statsEl || !listEl) return;

    var done = addVariantTaskStates.filter(function (t) { return t.status === "done"; }).length;
    var failed = addVariantTaskStates.filter(function (t) { return t.status === "failed"; }).length;
    var running = addVariantTaskStates.filter(function (t) { return t.status === "running"; }).length;
    var pending = addVariantTaskStates.filter(function (t) { return t.status === "pending"; }).length;
    statsEl.textContent = "进度 " + (done + failed) + "/" + addVariantTaskStates.length
      + " · 进行中 " + running + " · 等待 " + pending
      + (failed ? " · 失败 " + failed : "");

    listEl.innerHTML = "";
    addVariantTaskStates.forEach(function (task, index) {
      var li = document.createElement("li");
      li.className = "add-variant-progress-item";
      li.dataset.status = task.status;

      var badge = document.createElement("span");
      badge.className = "add-variant-progress-badge";
      badge.textContent = task.status === "done" ? "✓"
        : task.status === "failed" ? "!"
          : task.status === "running" ? "…"
            : String(index + 1);

      var copy = document.createElement("div");
      copy.className = "add-variant-progress-copy";
      var title = document.createElement("strong");
      title.textContent = (LOADER_LABELS[task.loader] || task.loader) + " " + task.mcVersion;
      var detail = document.createElement("span");
      detail.textContent = task.message || (task.status === "pending" ? "等待中…" : "");
      copy.appendChild(title);
      copy.appendChild(detail);

      li.appendChild(badge);
      li.appendChild(copy);
      listEl.appendChild(li);
    });
  }

  function initAddVariantProgress(
    targets: Array<{ loader: string; mcVersion: string }>,
  ) {
    addVariantTaskStates = targets.map(function (target) {
      return {
        loader: target.loader,
        mcVersion: target.mcVersion,
        status: "pending",
        message: "等待中…",
      };
    });
    setAddVariantProgressVisible(true);
    renderAddVariantProgress();
  }

  function patchAddVariantTask(
    index: number,
    patch: Partial<{ status: "pending" | "running" | "done" | "failed"; message: string }>,
  ) {
    if (!addVariantTaskStates[index]) return;
    if (patch.status) addVariantTaskStates[index].status = patch.status;
    if (patch.message !== undefined) addVariantTaskStates[index].message = patch.message;
    renderAddVariantProgress();
  }

  function resetAddVariantProgress() {
    addVariantTaskStates = [];
    setAddVariantProgressVisible(false);
    var listEl = $("add-variant-progress-list");
    var statsEl = $("add-variant-progress-stats");
    if (listEl) listEl.innerHTML = "";
    if (statsEl) statsEl.textContent = "";
  }

  function setAddVariantBusy(busy: boolean, message?: string) {
    addVariantBusy = busy;
    var confirmBtn = $("add-variant-confirm") as HTMLButtonElement | null;
    var cancelBtn = $("add-variant-cancel") as HTMLButtonElement | null;
    var options = $("add-variant-modal")?.querySelector(".add-variant-options");
    if (confirmBtn) {
      confirmBtn.disabled = busy;
      confirmBtn.textContent = busy ? "创建并验证中…" : "开始创建并验证";
    }
    if (cancelBtn) cancelBtn.disabled = busy;
    if (options) {
      options.querySelectorAll("input, select").forEach(function (el) {
        (el as HTMLInputElement).disabled = busy;
      });
    }
    var list = $("add-variant-list");
    if (list) {
      list.querySelectorAll("input").forEach(function (el) {
        (el as HTMLInputElement).disabled = busy;
      });
    }
    if (busy && message) {
      var summary = $("add-variant-summary");
      if (summary) summary.textContent = message;
    }
  }

  function refreshAddVariantModalList() {
    if (!addVariantPendingMatrix) return;
    var loaderFilter = addVariantLoaderFilterValue();
    var available = collectMatrixAvailable(addVariantPendingMatrix, addVariantPendingMod, loaderFilter);
    var list = $("add-variant-list");
    var summary = $("add-variant-summary");
    var selectAllEl = $("add-variant-select-all") as HTMLInputElement | null;
    var confirmBtn = $("add-variant-confirm") as HTMLButtonElement | null;
    var loaderLabel = loaderFilter ? LOADER_LABELS[loaderFilter] : "全部加载器";

    if (summary) {
      summary.textContent = available.length
        ? "为「" + (addVariantPendingMod?.displayName || "模组") + "」创建并验证 "
          + loaderLabel + " 变体，共 " + available.length + " 个可选："
        : loaderLabel + " 当前没有可创建的版本（矩阵中已全部存在或不支持）。";
    }

    if (list) {
      list.innerHTML = "";
      if (!available.length) {
        var empty = document.createElement("p");
        empty.className = "add-variant-list-empty";
        empty.textContent = loaderFilter
          ? "请切换加载器，或在矩阵中查看其他可创建单元格。"
          : "当前 Fabric / Forge / NeoForge 均没有可创建的版本。";
        list.appendChild(empty);
      } else {
        available.forEach(function (item) {
          var label = document.createElement("label");
          label.className = "checkbox-row";
          var input = document.createElement("input");
          input.type = "checkbox";
          input.checked = !!(selectAllEl && selectAllEl.checked);
          input.dataset.loader = item.loader;
          input.dataset.mc = item.mcVersion;
          var span = document.createElement("span");
          span.textContent = LOADER_LABELS[item.loader] + " " + item.mcVersion;
          label.appendChild(input);
          label.appendChild(span);
          list.appendChild(label);
        });
      }
    }

    if (confirmBtn) confirmBtn.disabled = available.length === 0 || addVariantBusy;
    if (selectAllEl) selectAllEl.disabled = available.length === 0 || addVariantBusy;
  }

  function openAddVariantModal(mod: Record<string, unknown>, matrix: Record<string, unknown>) {
    if (!(mod.variants as unknown[])?.length) {
      notify("请先至少有一个变体作为源码来源", "warning");
      return;
    }
    resetAddVariantProgress();
    addVariantReturnFocus = document.activeElement as HTMLElement | null;
    addVariantPendingMod = mod;
    addVariantPendingMatrix = matrix;

    var loaderEl = $("add-variant-loader") as HTMLSelectElement | null;
    var selectAllEl = $("add-variant-select-all") as HTMLInputElement | null;
    if (selectAllEl) selectAllEl.checked = true;

    var allCount = collectMatrixAvailable(matrix, mod).length;
    if (loaderEl) loaderEl.value = allCount > 0 ? "" : "fabric";

    refreshAddVariantModalList();
    $("add-variant-modal")?.classList.add("visible");
    requestAnimationFrame(function () {
      (selectAllEl && !selectAllEl.disabled ? selectAllEl : $("add-variant-cancel"))?.focus();
    });
  }

  function closeAddVariantModal(force?: boolean) {
    if (addVariantBusy && addVariantBatchJobId && !force) {
      notify("后台任务继续运行，再次点击「批量创建」可查看进度");
      stopAddVariantPolling();
      addVariantBatchJobId = null;
      addVariantPendingMod = null;
      addVariantPendingMatrix = null;
      setAddVariantBusy(false);
      resetAddVariantProgress();
      $("add-variant-modal")?.classList.remove("visible");
      addVariantReturnFocus?.focus();
      addVariantReturnFocus = null;
      return;
    }
    stopAddVariantPolling();
    addVariantBatchJobId = null;
    addVariantPendingMod = null;
    addVariantPendingMatrix = null;
    setAddVariantBusy(false);
    resetAddVariantProgress();
    $("add-variant-modal")?.classList.remove("visible");
    addVariantReturnFocus?.focus();
    addVariantReturnFocus = null;
  }

  function getSelectedAddVariantTargets(): Array<{ loader: string; mcVersion: string }> {
    var list = $("add-variant-list");
    if (!list) return [];
    var targets: Array<{ loader: string; mcVersion: string }> = [];
    list.querySelectorAll<HTMLInputElement>("input[type=checkbox][data-loader]").forEach(function (input) {
      if (!input.checked) return;
      targets.push({ loader: input.dataset.loader || "", mcVersion: input.dataset.mc || "" });
    });
    return targets;
  }

  async function confirmAddVariants() {
    if (addVariantBusy || !addVariantPendingMod) return;
    var modId = String(addVariantPendingMod.id || "");
    if (!modId) {
      notify("模组信息无效", "warning");
      return;
    }

    var targets = getSelectedAddVariantTargets();
    if (!targets.length) {
      notify("请至少选择一个版本", "warning");
      return;
    }

    var modName = String(addVariantPendingMod.displayName || "模组");
    var batchSource = pickSourceVariant(addVariantPendingMod);
    if (!batchSource) {
      notify("请先至少有一个变体作为源码来源", "warning");
      return;
    }

    var buildOnly = targets.length >= 8;
    if (targets.length > 1 && !await confirmAction({
      title: "批量创建变体",
      message: "将为「" + modName + "」在服务端创建并验证 " + targets.length + " 个变体。",
      detail: "后台持久化任务：先串行生成全部项目，再并行 Gradle 构建验证。"
        + (buildOnly ? "\n大批量：仅 Gradle 构建（跳过客户端）。" : "\n含客户端启动验证。")
        + "\nForge 版本会先探测 MDK 可用性，不可用的将跳过。"
        + "\n任务写入 ~/.dmcl/batch-jobs/，关闭窗口也不会中断；重启应用可自动恢复。"
        + "\n已存在的目录会跳过生成并继续验证。",
      confirmLabel: "开始批量创建",
    })) return;

    hideError();
    initAddVariantProgress(targets);
    setAddVariantBusy(true, "正在启动后台批量任务（" + targets.length + " 个）…");

    try {
      var result = await api("/api/mods/" + encodeURIComponent(modId) + "/variants/batch", {
        method: "POST",
        body: {
          sourceVariantId: batchSource.id,
          targets: targets,
          buildOnly: buildOnly,
          modName: modName,
        },
      }) as { job?: { id: string; verifyParallel?: number; gradleParallel?: number } };

      if (!result.job?.id) throw new Error("未收到任务 ID");
      setAddVariantBusy(true, "后台任务已启动 · 验证 worker "
        + (result.job.verifyParallel || 1) + " 路 · Gradle "
        + (result.job.gradleParallel ?? 1) + " 路…");
      startAddVariantJobPolling(result.job.id, modId);
    } catch (e) {
      showError("批量创建失败：" + (e as Error).message);
      setAddVariantBusy(false);
      refreshAddVariantModalList();
    }
  }

  $("btn-add-variant").addEventListener("click", async function () {
    if (!state.currentModId) return;
    hideError();
    try {
      var active = await api("/api/batch-jobs/active") as { job?: { id: string; modUuid: string; targets: unknown[]; state: string } };
      if (active.job && (active.job.state === "running" || active.job.state === "pending")) {
        if (active.job.modUuid === state.currentModId) {
          openAddVariantModalFromActiveJob(active.job);
          return;
        }
        notify("已有其他模组的批量任务进行中（" + active.job.targets.length + " 个）", "warning");
      }
      var cached = state.detailCache[state.currentModId];
      if (cached && !isDetailStale(cached)) {
        openAddVariantModal(cached.mod, cached.matrix);
        return;
      }
      var detailData = await api("/api/mods/" + state.currentModId + "/detail") as {
        mod: Record<string, unknown>;
        matrix: Record<string, unknown>;
      };
      openAddVariantModal(detailData.mod, detailData.matrix);
    } catch (e) {
      showError("加载模组信息失败：" + (e as Error).message);
    }
  });

  function openAddVariantModalFromActiveJob(job: {
    id: string;
    targets: Array<{ loader: string; mcVersion: string; status: string; message?: string; error?: string }>;
    phase?: string;
    successes?: number;
    failures?: number;
    skipped?: number;
    total?: number;
    verifyParallel?: number;
    gradleParallel?: number;
  }) {
    resetAddVariantProgress();
    addVariantReturnFocus = document.activeElement as HTMLElement | null;
    addVariantTaskStates = job.targets.map(function (t) {
      return {
        loader: t.loader,
        mcVersion: t.mcVersion,
        status: mapBatchTargetStatus(t.status),
        message: t.error || t.message || "等待中…",
      };
    });
    setAddVariantProgressVisible(true);
    renderAddVariantProgress();
    syncAddVariantProgressFromJob(job);
    setAddVariantBusy(true, "后台任务进行中…");
    $("add-variant-modal")?.classList.add("visible");
    startAddVariantJobPolling(job.id, String(state.currentModId || ""));
  }

  $("add-variant-cancel")?.addEventListener("click", async function () {
    if (addVariantBusy && addVariantBatchJobId) {
      if (await confirmAction({
        title: "取消批量任务",
        message: "确定取消后台批量创建？",
        detail: "已完成的变体会保留，进行中的项将停止。",
        confirmLabel: "取消任务",
      })) {
        try {
          await api("/api/batch-jobs/" + encodeURIComponent(addVariantBatchJobId) + "/cancel", { method: "POST" });
          stopAddVariantPolling();
          addVariantBatchJobId = null;
          closeAddVariantModal(true);
          notify("批量任务已取消");
        } catch (e) {
          showError("取消失败：" + (e as Error).message);
        }
      }
      return;
    }
    closeAddVariantModal();
  });
  $("add-variant-confirm")?.addEventListener("click", function () { void confirmAddVariants(); });
  $("add-variant-loader")?.addEventListener("change", refreshAddVariantModalList);
  $("add-variant-select-all")?.addEventListener("change", function () {
    var checked = ($("add-variant-select-all") as HTMLInputElement).checked;
    $("add-variant-list")?.querySelectorAll<HTMLInputElement>("input[type=checkbox][data-loader]").forEach(function (input) {
      input.checked = checked;
    });
  });
  $("add-variant-modal")?.addEventListener("click", function (e) {
    if (e.target === $("add-variant-modal")) closeAddVariantModal();
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

  $("queue-open")?.addEventListener("click", function () {
    panel.reopen();
    updateQueueBar();
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
  loadMods(true);
  loadDefaultDir();
  updateQueueBar();

  console.log("[dmcl] Workbench ready");
}
