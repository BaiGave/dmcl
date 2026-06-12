/**
 * mcdev-wizard GUI - 纯前端渲染层
 * 通过 fetch POST /api/generate 调用后端 CLI
 */
(function () {
  "use strict";

  var loaders = [
    { id: "fabric", label: "Fabric", icon: "🧵", hint: "轻量、更新快，社区活跃" },
    { id: "neoforge", label: "NeoForge", icon: "🦊", hint: "Forge 现代分支，1.20.1+" },
    { id: "forge", label: "Forge", icon: "⚒️", hint: "老牌加载器，版本覆盖最全" },
  ];

  var selectedLoader = "";
  var selectedMc = "";
  var selectedMappings = "";
  var projectDir = "";

  function $(id) { return document.getElementById(id); }

  function showStep(id) {
    var all = document.querySelectorAll(".step");
    for (var i = 0; i < all.length; i++) {
      all[i].classList.toggle("active", all[i].id === id);
    }
  }

  function showError(msg) {
    var box = $("error-box");
    var txt = $("error-text");
    if (txt) txt.textContent = msg;
    if (box) box.style.display = "block";
    console.error("[mcdev]", msg);
  }

  function hideError() {
    var box = $("error-box");
    if (box) box.style.display = "none";
  }

  // ============ Step 1: Loader cards ============
  var cardsContainer = $("loader-cards");
  var btnNext = $("loader-next");

  if (!cardsContainer || !btnNext) {
    showError("初始化失败：页面元素未找到");
    return;
  }

  for (var i = 0; i < loaders.length; i++) {
    (function (ldr) {
      var c = document.createElement("div");
      c.className = "card";
      c.dataset.loader = ldr.id;
      c.innerHTML =
        '<div class="icon">' + ldr.icon + "</div>" +
        '<div class="label">' + ldr.label + "</div>" +
        '<div class="hint">' + ldr.hint + "</div>";
      c.style.cursor = "pointer";
      c.addEventListener("click", function () {
        var all = document.querySelectorAll(".card");
        for (var j = 0; j < all.length; j++) all[j].classList.remove("selected");
        c.classList.add("selected");
        selectedLoader = ldr.id;
        btnNext.disabled = false;
        hideError();
      });
      cardsContainer.appendChild(c);
    })(loaders[i]);
  }

  btnNext.addEventListener("click", function () {
    if (!selectedLoader) { showError("请先选择一个模组加载器"); return; }
    loadVersions(selectedLoader);
    showStep("step-config");
  });

  // ============ Step 2: Config ============
  var btnBack = $("config-back");
  var btnGen = $("config-gen");
  var btnBrowse = $("btn-browse");
  if (btnBack) btnBack.addEventListener("click", function () { showStep("step-loader"); });
  if (btnGen) btnGen.addEventListener("click", startGeneration);

  // 浏览按钮：调 Electron 原生目录选择器
  if (btnBrowse) {
    btnBrowse.addEventListener("click", async function () {
      try {
        var resp = await fetch("/api/select-dir");
        var data = await resp.json();
        if (data.path) {
          var inpDir = $("inp-dir");
          if (inpDir) inpDir.value = data.path;
        }
      } catch (e) {
        console.warn("目录选择器不可用（非 Electron 环境），请手动输入路径");
      }
    });
  }

  async function loadVersions(loader) {
    var sel = $("sel-mc");
    if (!sel) return;
    sel.innerHTML = "<option>加载中…</option>";
    sel.disabled = true;

    try {
      var res1 = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
      var data1 = await res1.json();
      var releases = data1.versions.filter(function (v) { return v.type === "release"; }).map(function (v) { return v.id; });

      var versions = releases;
      if (loader === "fabric") {
        try {
          var res2 = await fetch("https://meta.fabricmc.net/v2/versions/game");
          var data2 = await res2.json();
          var fabSet = {};
          for (var k = 0; k < data2.length; k++) {
            if (data2[k].stable) fabSet[data2[k].version] = true;
          }
          versions = releases.filter(function (v) { return fabSet[v]; });
        } catch (e) { /* show all releases */ }
      }

      sel.innerHTML = versions.map(function (v, idx) {
        return '<option value="' + v + '">' + v + (idx === 0 ? "（最新）" : "") + "</option>";
      }).join("");
      sel.selectedIndex = 0;
      selectedMc = versions[0] || "";

      refreshMappings();
    } catch (err) {
      sel.innerHTML = "<option>加载失败，请检查网络</option>";
    }
    sel.disabled = false;
  }

  /** 根据当前 loader + mc 版本查询哪些映射可用，动态更新下拉框 */
  async function refreshMappings() {
    var mapSel = $("sel-mappings");
    if (!mapSel || !selectedMc || !selectedLoader) return;

    mapSel.innerHTML = "<option>检查中…</option>";
    mapSel.disabled = true;

    var mc = selectedMc;
    var loader = selectedLoader;

    // 并行查询各映射的可用性
    var results = {};
    try {
      var queries = [];

      // MojMap：总是可用
      queries.push(Promise.resolve({ key: "mojmap", ok: true }));

      // Parchment：查 Maven metadata
      queries.push(
        fetch("https://maven.parchmentmc.org/org/parchmentmc/data/parchment-" + mc + "/maven-metadata.xml")
          .then(function (r) { return r.ok ? r.text() : Promise.reject("http " + r.status); })
          .then(function (xml) {
            var m = xml.match(/<release>([^<]+)<\/release>/);
            return { key: "parchment", ok: !!(m && m[1] && !m[1].endsWith("-SNAPSHOT")) };
          })
          .catch(function () { return { key: "parchment", ok: false }; })
      );

      // Yarn：仅 Fabric 查询
      if (loader === "fabric") {
        queries.push(
          fetch("https://meta.fabricmc.net/v2/versions/yarn/" + mc)
            .then(function (r) { return r.ok ? r.json() : Promise.reject("http " + r.status); })
            .then(function (data) {
              return { key: "yarn", ok: Array.isArray(data) && data.length > 0 };
            })
            .catch(function () { return { key: "yarn", ok: false }; })
        );
      }

      var settled = await Promise.all(queries);
      for (var i = 0; i < settled.length; i++) {
        results[settled[i].key] = settled[i].ok;
      }
    } catch (e) {
      // 全部失败时至少保证 MojMap 可用
      results = { mojmap: true };
    }

    // 构建下拉框（只显示确认可用的映射）
    // MojMap 总是可用；Yarn / Parchment 需运行时查询确认
    var order = loader === "fabric"
      ? ["yarn", "mojmap", "parchment"]
      : ["mojmap", "parchment"];

    var labels = {
      yarn: "Yarn（社区映射）",
      mojmap: "MojMap（官方映射）",
      parchment: "Parchment（MojMap + 参数名）",
    };

    var options = [];
    var defaultVal = "";
    for (var j = 0; j < order.length; j++) {
      var key = order[j];
      if (!results[key]) continue;  // 不可用则不显示
      options.push('<option value="' + key + '">' + labels[key] + "</option>");
      if (!defaultVal) defaultVal = key;
    }

    mapSel.innerHTML = options.join("");
    selectedMappings = defaultVal;
    mapSel.value = defaultVal;
    mapSel.disabled = false;
  }

  var selMc = $("sel-mc");
  var selMappings = $("sel-mappings");
  if (selMc) selMc.addEventListener("change", function () {
    selectedMc = selMc.value;
    refreshMappings();
  });
  if (selMappings) selMappings.addEventListener("change", function () { selectedMappings = selMappings.value; });

  // ============ Step 3: Generate ============
  var genCancel = $("gen-cancel");
  if (genCancel) genCancel.addEventListener("click", function () { showStep("step-config"); });

  async function startGeneration() {
    var inpModid = $("inp-modid");
    var inpName = $("inp-name");
    var inpGroup = $("inp-group");
    var inpDir = $("inp-dir");
    var chkMirror = $("chk-mirror");

    if (!inpModid || !inpName || !inpGroup || !inpDir) {
      showError("无法读取表单数据，请刷新页面重试");
      return;
    }

    var modId = inpModid.value.trim();
    var name = inpName.value.trim();
    var group = inpGroup.value.trim();
    var dir = inpDir.value.trim();
    var mirror = chkMirror ? chkMirror.checked : true;

    if (!/^[a-z][a-z0-9_]{1,63}$/.test(modId)) {
      showError("模组 ID 需以小写字母开头，仅含小写字母、数字、下划线");
      return;
    }

    showStep("step-gen");
    var log = $("gen-log");
    log.innerHTML = "";
    log.style.color = "#c9d1d9";

    var args = [
      "--yes",
      "--loader", selectedLoader,
      "--mc", selectedMc,
      "--modid", modId,
      "--name", name,
      "--group", group,
      "--dir", dir,
      "--mappings", selectedMappings,
    ];
    if (!mirror) args.push("--no-mirror");

    try {
      var resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: args }),
      });

      if (!resp.ok) throw new Error("HTTP " + resp.status);

      var reader = resp.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buffer = "";
      var exitCode = null;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        var { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        var lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (var li = 0; li < lines.length; li++) {
          var line = lines[li].trim();
          if (!line) continue;
          if (line.indexOf("__EXIT__:") === 0) {
            exitCode = parseInt(line.slice("__EXIT__:".length), 10);
            continue;
          }
          var div = document.createElement("div");
          if (line.indexOf("错误") >= 0 || line.indexOf("失败") >= 0 || line.indexOf("FAIL") >= 0 || line.indexOf("ERROR") >= 0) {
            div.style.color = "#f85149";
          } else if (line.indexOf("成功") >= 0 || line.indexOf("完成") >= 0 || line.indexOf("已生成") >= 0) {
            div.style.color = "#3fb950";
          }
          div.textContent = line;
          log.appendChild(div);
        }
        log.scrollTop = log.scrollHeight;
      }

      if (exitCode !== null && exitCode !== 0) {
        throw new Error("生成进程退出码 " + exitCode + "（请查看上方日志）");
      }
    } catch (err) {
      var div = document.createElement("div");
      div.style.color = "#f85149";
      div.textContent = "生成失败：" + (err.message || String(err));
      log.appendChild(div);
      if (genCancel) genCancel.textContent = "返回修改";
      return;
    }

    projectDir = dir;
    $("done-path").textContent = dir;
    showStep("step-done");
  }

  // ============ Step 4: Done ============
  var doneClose = $("done-close");
  var doneOpenFolder = $("done-open-folder");
  if (doneClose) {
    doneClose.addEventListener("click", function () {
      fetch("/api/close").then(function () {
        window.close();
      }).catch(function () {
        window.close();
      });
    });
  }
  if (doneOpenFolder) {
    doneOpenFolder.addEventListener("click", function () {
      fetch("/api/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: projectDir }),
      }).catch(function () {
        // 非 Electron 环境回退：什么都不做
      });
    });
  }

  console.log("[mcdev] Renderer ready ✓");
})();
