// Renders the GUI against the mock API in an offscreen Electron window and saves screenshots.
// Usage: npm run gui:bundle && electron scripts/gui-screenshots.mjs [outDir]
// Never launches Gradle or Minecraft; the mock only fakes job progress and logs.
import { app, BrowserWindow, nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
import { startMockApi } from "./gui-mock-api.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.resolve(process.argv[2] || process.env.DMCL_SCREENSHOT || path.join(root, "build", "screenshots"));
const WIDTH = 1440;
const HEIGHT = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, expr, timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await win.webContents.executeJavaScript(`!!(${expr})`)) return;
    await sleep(100);
  }
  throw new Error("timeout waiting for " + expr);
}

const click = (win, selector) => win.webContents.executeJavaScript(
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("missing ${selector.replace(/"/g, "'")}"); el.click(); })()`,
);

async function shot(win, name) {
  await sleep(350);
  const image = await win.webContents.capturePage();
  const file = path.join(outDir, name + ".png");
  fs.writeFileSync(file, image.toPNG());
  console.log("saved", file);
}

async function scenario(mockUrl, theme) {
  nativeTheme.themeSource = theme;
  await fetch(mockUrl + "__mock/reset");
  await fetch(mockUrl + "__mock/host?busy=0");
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, show: false, useContentSize: true,
    backgroundColor: theme === "dark" ? "#121513" : "#f4f5f3",
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  win.webContents.setFrameRate(30);
  await win.loadURL(mockUrl);
  await waitFor(win, `document.querySelector(".mod-card")`);
  await sleep(900);
  await shot(win, `01-mod-list-${theme}`);

  await click(win, ".mod-card-main");
  await waitFor(win, `document.querySelector(".vcard")`);
  await sleep(500);
  await shot(win, `02-variant-list-${theme}`);

  // Launch a variant and capture mid-run (the mock walks through the phases in ~18 s).
  await click(win, '[data-variant-id="v-fab-1214"] [data-action="run"]');
  await waitFor(win, `document.querySelector(".launch-panel:not([hidden]) .lp-state[data-state='running']")`);
  await waitFor(win, `document.querySelector(".lp-step[data-state='active'] .lp-step-label")?.textContent === "资源"`, 30_000);
  await sleep(1500);
  await shot(win, `03-launch-running-${theme}`);

  // A failing launch: reason + highlighted error lines.
  await click(win, ".lp-close");
  await click(win, '[data-variant-id="v-forge-1201"] [data-action="run"]');
  await waitFor(win, `document.querySelector(".launch-panel:not([hidden])[data-state='failed'] .lp-failure-lines li")`, 30_000);
  await sleep(600);
  await shot(win, `04-launch-failed-${theme}`);

  // Linker tests running on the same host: header chip, job list and the busy warning.
  await click(win, ".lp-close");
  await fetch(mockUrl + "__mock/host?busy=1");
  await waitFor(win, `document.querySelector(".host-chip:not([hidden])")`, 15_000);
  await click(win, '[data-variant-id="v-neo-1206"] [data-action="run"]');
  await waitFor(win, `document.querySelector(".busy-warning")`);
  await shot(win, `05-busy-warning-${theme}`);
  await click(win, '.busy-warning [data-choice="later"]');
  await sleep(300);
  await click(win, ".host-chip");
  await waitFor(win, `document.querySelector(".host-popover:not([hidden]) li")`);
  await shot(win, `06-host-activity-${theme}`);
  win.destroy();
}

app.disableHardwareAcceleration();
// Windows are recreated per theme; do not quit when one closes.
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const mock = await startMockApi({ guiDir: path.join(root, "gui") });
  let code = 0;
  try {
    for (const theme of ["light", "dark"]) await scenario(mock.url, theme);
  } catch (err) {
    console.error(err);
    code = 1;
  } finally {
    await mock.close();
    app.exit(code);
  }
});
