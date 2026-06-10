// @ts-check
/// <reference types="./preload" />

const mcdev = window.mcdev;

// ============ state ============
const loaders = [
  { id: "fabric", label: "Fabric", icon: "🧵", hint: "轻量、更新快，社区活跃" },
  { id: "neoforge", label: "NeoForge", icon: "🦊", hint: "Forge 现代分支，1.20.1+" },
  { id: "forge", label: "Forge", icon: "⚒️", hint: "老牌加载器，版本覆盖最全" },
];

const mappingsLabels = {
  yarn: "Yarn（社区映射，默认）",
  mojmap: "MojMap（官方映射）",
  parchment: "Parchment（MojMap + 参数名）",
};

let selectedLoader = "";
let selectedMc = "";
let selectedMappings = "";
let projectDir = "";

// ============ DOM refs ============
const $ = (id) => document.getElementById(id);
const stepLoader = $("step-loader");
const stepConfig = $("step-config");
const stepGen = $("step-gen");
const stepDone = $("step-done");
const genLog = $("gen-log");

function showStep(id) {
  for (const el of document.querySelectorAll(".step")) {
    el.classList.toggle("active", el.id === id);
  }
}

// ============ Step 1: Loader ============
const loaderCards = $("loader-cards");
const loaderNext = $("loader-next");

loaders.forEach((l) => {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.loader = l.id;
  card.innerHTML = `<div class="icon">${l.icon}</div><div class="label">${l.label}</div><div class="hint">${l.hint}</div>`;
  card.addEventListener("click", () => {
    document.querySelectorAll(".card").forEach((c) => c.classList.remove("selected"));
    card.classList.add("selected");
    selectedLoader = l.id;
    loaderNext.disabled = false;
  });
  loaderCards.appendChild(card);
});

loaderNext.addEventListener("click", () => {
  loadVersions(selectedLoader);
  showStep("step-config");
});

// ============ Step 2: Config ============
$("config-back").addEventListener("click", () => showStep("step-loader"));
$("config-gen").addEventListener("click", startGeneration);

async function loadVersions(loader) {
  const sel = $("sel-mc");
  sel.innerHTML = '<option>加载中…</option>';
  sel.disabled = true;

  try {
    // Direct API calls to Mojang and Fabric for version listings
    const releaseRes = await fetch(
      "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
    );
    const releaseData = await releaseRes.json();
    const releases = releaseData.versions
      .filter((v) => v.type === "release")
      .map((v) => v.id);

    let versions = releases;
    if (loader === "fabric") {
      const fabRes = await fetch("https://meta.fabricmc.net/v2/versions/game");
      const fabData = await fabRes.json();
      const fabSet = new Set(fabData.filter((v) => v.stable).map((v) => v.version));
      versions = releases.filter((v) => fabSet.has(v));
    } else if (loader === "forge") {
      // For Forge/NeoForge, we can't easily filter in the browser. Show all releases.
      // The CLI will validate when generating.
    } else if (loader === "neoforge") {
      // Same - let CLI validate
    }

    sel.innerHTML = versions
      .map((v, i) => `<option value="${v}">${v}${i === 0 ? "（最新）" : ""}</option>`)
      .join("");
    sel.selectedIndex = 0;
    selectedMc = versions[0];

    // Setup mappings
    const mapSel = $("sel-mappings");
    if (loader === "fabric") {
      mapSel.innerHTML =
        '<option value="yarn">Yarn（社区映射，默认）</option>' +
        '<option value="mojmap">MojMap（官方映射）</option>' +
        '<option value="parchment">Parchment（MojMap + 参数名）</option>';
      selectedMappings = "yarn";
    } else {
      mapSel.innerHTML =
        '<option value="mojmap">MojMap（官方映射，默认）</option>' +
        '<option value="parchment">Parchment（MojMap + 参数名）</option>';
      selectedMappings = "mojmap";
    }
  } catch (err) {
    sel.innerHTML = '<option>加载失败，请检查网络</option>';
  }
  sel.disabled = false;
}

$("sel-mc").addEventListener("change", () => {
  selectedMc = $("sel-mc").value;
});
$("sel-mappings").addEventListener("change", () => {
  selectedMappings = $("sel-mappings").value;
});

// ============ Step 3: Generate ============
$("gen-cancel").addEventListener("click", () => showStep("step-config"));

async function startGeneration() {
  const modId = $("inp-modid").value.trim();
  const name = $("inp-name").value.trim();
  const group = $("inp-group").value.trim();
  const dir = $("inp-dir").value.trim();
  const mirror = $("chk-mirror").checked;

  if (!/^[a-z][a-z0-9_]{1,63}$/.test(modId)) {
    alert("模组 ID 需以小写字母开头，仅含小写字母、数字、下划线");
    return;
  }

  showStep("step-gen");
  genLog.innerHTML = "";

  const args = [
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

  // Start listening for progress
  mcdev.onProgress((line) => {
    const div = document.createElement("div");
    if (line.includes("错误") || line.includes("失败") || line.includes("FAIL")) {
      div.className = "err";
    } else if (line.includes("成功") || line.includes("BUILD SUCCESS")) {
      div.className = "ok";
    }
    div.textContent = line;
    genLog.appendChild(div);
    genLog.scrollTop = genLog.scrollHeight;
  });

  try {
    await mcdev.generate(args);
    // After generation, show done
    projectDir = dir;
    $("done-path").textContent = dir;
    showStep("step-done");
  } catch (err) {
    const div = document.createElement("div");
    div.className = "err";
    div.textContent = String(err);
    genLog.appendChild(div);
    $("gen-cancel").textContent = "返回修改";
  }
}

// ============ Step 4: Done ============
$("done-open").addEventListener("click", () => {
  mcdev.openDir(projectDir);
});
$("done-restart").addEventListener("click", () => {
  location.reload();
});
