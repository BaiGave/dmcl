/**
 * mcdev-wizard GUI - 纯前端渲染层
 * 设计原则：用户只需 1) 选加载器 2) 起名字 3) 点一键创建。
 * 其他全部自动：modid/包名自动生成、版本默认最新、目录默认桌面、生成后自动构建验证。
 */
(function () {
  "use strict";

  var loaders = [
    { id: "fabric", label: "Fabric", icon: "🧵", hint: "轻量、更新快（推荐新手）" },
    { id: "neoforge", label: "NeoForge", icon: "🦊", hint: "Forge 现代分支，1.20.1+" },
    { id: "forge", label: "Forge", icon: "⚒️", hint: "老牌加载器，版本覆盖最全" },
  ];

  var selectedLoader = "";
  var selectedMc = "";
  var selectedMappings = "";
  var projectDir = "";
  var modidTouched = false;   // 用户手动改过 modid 后就不再自动生成
  var groupTouched = false;

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

  // ============ 自动生成 modid / 包名 ============

  /** 把任意名字转成合法 modid：小写、字母开头、只保留字母数字下划线 */
  function nameToModId(name) {
    var s = name.toLowerCase()
      .replace(/[\u4e00-\u9fa5]+/g, "")        // 去掉中文（拼音转换太复杂，直接去掉）
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_{2,}/g, "_");
    if (!s || !/^[a-z]/.test(s)) s = "mod" + (s || "");
    s = s.slice(0, 32);
    if (!/^[a-z][a-z0-9_]*$/.test(s)) s = "mymod";
    if (s.length < 2) s = s + "mod";
    return s;
  }

  function autoFill() {
    var name = $("inp-name").value.trim();
    if (!modidTouched) {
      var mid = name ? nameToModId(name) : "";
      $("inp-modid").value = mid;
    }
    if (!groupTouched) {
      var m = $("inp-modid").value.trim() || "mymod";
      $("inp-group").value = "com.example." + m.replace(/_/g, "");
    }
    updateDirPreview();
  }

  function updateDirPreview() {
    var el = $("dir-preview");
    if (!el) return;
    var mId = $("inp-modid").value.trim();
    var pDir = $("inp-dir").value.trim().replace(/[\\/]+$/, "");
    if (!pDir) {
      el.textContent = "";
      return;
    }
    el.textContent = "项目将创建在: " + pDir + "\\" + (mId || "…");
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
    loadDefaultDir();
    showStep("step-config");
  });

  // ============ Step 2: Config ============
  var btnBack = $("config-back");
  var btnGen = $("config-gen");
  var btnBrowse = $("btn-browse");
  if (btnBack) btnBack.addEventListener("click", function () { showStep("step-loader"); });
  if (btnGen) btnGen.addEventListener("click", startGeneration);

  // 名字 → 自动生成 modid / 包名
  $("inp-name").addEventListener("input", autoFill);
  $("inp-modid").addEventListener("input", function () {
    modidTouched = true;
    if (!groupTouched) {
      var m = $("inp-modid").value.trim() || "mymod";
      $("inp-group").value = "com.example." + m.replace(/_/g, "");
    }
    updateDirPreview();
  });
  $("inp-group").addEventListener("input", function () { groupTouched = true; });
  $("inp-dir").addEventListener("input", updateDirPreview);

  // 默认目录：桌面
  async function loadDefaultDir() {
    var inp = $("inp-dir");
    if (inp.value.trim()) return; // 已有值不覆盖
    try {
      var resp = await fetch("/api/default-dir");
      var data = await resp.json();
      if (data.path) {
        inp.value = data.path;
        updateDirPreview();
      }
    } catch (e) {
      inp.placeholder = "请输入或浏览选择文件夹";
    }
  }

  // 浏览按钮：调 Electron 原生目录选择器
  if (btnBrowse) {
    btnBrowse.addEventListener("click", async function () {
      try {
        var resp = await fetch("/api/select-dir");
        var data = await resp.json();
        if (data.path) {
          $("inp-dir").value = data.path;
          updateDirPreview();
        }
      } catch (e) {
        console.warn("目录选择器不可用，请手动输入路径");
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
      sel.innerHTML = "<option>加载失败，请检查网络后点返回重试</option>";
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

    var results = {};
    try {
      var queries = [];

      queries.push(Promise.resolve({ key: "mojmap", ok: true }));

      queries.push(
        fetch("https://maven.parchmentmc.org/org/parchmentmc/data/parchment-" + mc + "/maven-metadata.xml")
          .then(function (r) { return r.ok ? r.text() : Promise.reject("http " + r.status); })
          .then(function (xml) {
            var m = xml.match(/<release>([^<]+)<\/release>/);
            return { key: "parchment", ok: !!(m && m[1] && !m[1].endsWith("-SNAPSHOT")) };
          })
          .catch(function () { return { key: "parchment", ok: false }; })
      );

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
      results = { mojmap: true };
    }

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
      if (!results[key]) continue;
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

  // ============ Step 3: Generate + Build ============
  var genCancel = $("gen-cancel");
  var activeAbort = null;
  var generationCancelled = false;

  if (genCancel) genCancel.addEventListener("click", function () {
    generationCancelled = true;
    if (activeAbort) activeAbort.abort();
    fetch("/api/cancel").catch(function () {});
    genCancel.textContent = "取消";
    showStep("step-config");
  });

  function setPhase(phase) {
    // phase: "gen" | "build" | "client" | "done"
    var pg = $("phase-gen"), pb = $("phase-build"), pc = $("phase-client"), pd = $("phase-done");
    pg.classList.remove("active", "done");
    pb.classList.remove("active", "done");
    if (pc) pc.classList.remove("active", "done");
    pd.classList.remove("active", "done");

    if (phase === "gen") {
      pg.classList.add("active");
      pg.innerHTML = '<span class="spinner"></span>创建项目';
      pb.innerHTML = "验证构建";
      if (pc) pc.innerHTML = "启动客户端";
      $("gen-hint").textContent = "正在下载模板并生成项目，大约 10~30 秒…";
    } else if (phase === "build") {
      pg.classList.add("done");
      pg.innerHTML = "✓ 创建项目";
      pb.classList.add("active");
      pb.innerHTML = '<span class="spinner"></span>验证构建';
      if (pc) pc.innerHTML = "启动客户端";
      $("gen-hint").textContent = "正在验证构建（首次要下载 Minecraft，约 5~20 分钟，可以去喝杯水）…";
    } else if (phase === "client") {
      pg.classList.add("done");
      pg.innerHTML = "✓ 创建项目";
      pb.classList.add("done");
      pb.innerHTML = "✓ 验证构建";
      if (pc) pc.classList.add("active");
      if (pc) pc.innerHTML = '<span class="spinner"></span>启动客户端';
      $("gen-hint").textContent = "正在启动 Minecraft 客户端（会弹出游戏窗口，加载成功后自动关闭）…";
    } else if (phase === "done") {
      pg.classList.add("done");
      pg.innerHTML = "✓ 创建项目";
      pb.classList.add("done");
      pb.innerHTML = "✓ 验证构建";
      if (pc) pc.classList.add("done");
      if (pc) pc.innerHTML = "✓ 启动客户端";
      pd.classList.add("done");
    }
  }

  async function startGeneration() {
    var name = $("inp-name").value.trim();
    var modId = $("inp-modid").value.trim();
    var group = $("inp-group").value.trim();
    var parentDir = $("inp-dir").value.trim().replace(/[\\/]+$/, "");
    var mirror = $("chk-mirror") ? $("chk-mirror").checked : true;

    // 防呆校验，给出具体可操作的提示
    if (!name) { showError("请给模组起个名字"); return; }
    if (!modId) { modId = nameToModId(name); $("inp-modid").value = modId; }
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(modId)) {
      showError("模组 ID 不合法（需小写字母开头，仅含小写字母/数字/下划线）。点开「高级选项」修改，或改个英文名字自动生成");
      return;
    }
    if (!group) { group = "com.example." + modId.replace(/_/g, ""); $("inp-group").value = group; }
    if (!parentDir) { showError("请选择项目保存位置"); return; }
    if (!selectedMc) { showError("Minecraft 版本还没加载出来，请稍等或点返回重试"); return; }
    hideError();

    // 项目实际目录 = 父目录 + modid 子文件夹
    var dir = parentDir + "\\" + modId;
    projectDir = dir;

    showStep("step-gen");
    setPhase("gen");
    generationCancelled = false;
    activeAbort = new AbortController();
    if (genCancel) genCancel.textContent = "取消";
    var log = $("gen-log");
    log.innerHTML = "";

    var args = [
      "--yes",
      "--loader", selectedLoader,
      "--mc", selectedMc,
      "--modid", modId,
      "--name", name || modId,
      "--group", group,
      "--dir", dir,
      "--mappings", selectedMappings || "mojmap",
    ];
    if (!mirror) args.push("--no-mirror");

    try {
      var resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: args }),
        signal: activeAbort.signal,
      });

      if (!resp.ok) throw new Error("HTTP " + resp.status);

      var reader = resp.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buffer = "";
      var exitCode = null;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (generationCancelled) return;
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
          // 检测到各阶段开始，切换进度条
          if (line.indexOf("正在验证构建") >= 0) {
            setPhase("build");
          } else if (line.indexOf("正在启动 Minecraft") >= 0) {
            setPhase("client");
          }
          var div = document.createElement("div");
          if (line.indexOf("错误") >= 0 || line.indexOf("失败") >= 0 || line.indexOf("FAIL") >= 0 || line.indexOf("ERROR") >= 0 || line.indexOf("崩溃") >= 0) {
            div.className = "log-err";
          } else if (line.indexOf("成功") >= 0 || line.indexOf("完成") >= 0 || line.indexOf("已生成") >= 0 || line.indexOf("BUILD SUCCESSFUL") >= 0 || line.indexOf("构建验证通过") >= 0 || line.indexOf("客户端验证通过") >= 0 || line.indexOf("已成功加载") >= 0) {
            div.className = "log-ok";
          }
          div.textContent = line;
          log.appendChild(div);
        }
        log.scrollTop = log.scrollHeight;
      }

      if (generationCancelled) return;

      if (exitCode !== null && exitCode !== 0) {
        throw new Error("流程未完成（退出码 " + exitCode + "），请查看上方日志后点「返回修改」重试");
      }
    } catch (err) {
      if (generationCancelled || err.name === "AbortError") return;
      var div = document.createElement("div");
      div.className = "log-err";
      div.textContent = "出错了：" + (err.message || String(err));
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      if (genCancel) genCancel.textContent = "返回修改";
      return;
    }

    setPhase("done");
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
      }).catch(function () {});
    });
  }

  console.log("[mcdev] Renderer ready ✓");
})();
