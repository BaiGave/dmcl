import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const output = path.resolve(
  process.env.DMCL_PACKAGE_OUT ?? path.join(root, "release", `v${appPackage.version}`),
);
const electronPackage = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8"));
const electronVersion = electronPackage.version;

function findFile(rootDir, name) {
  if (!fs.existsSync(rootDir)) return undefined;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const file = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) {
      const nested = findFile(file, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

const cachedElectron = findFile(
  process.env.ELECTRON_CACHE ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "electron", "Cache"),
  `electron-v${electronVersion}-win32-x64.zip`,
);

const appPaths = await packager({
  dir: root,
  name: "DMCL",
  executableName: "DMCL",
  platform: "win32",
  arch: "x64",
  electronVersion,
  ...(cachedElectron ? { electronZipDir: path.dirname(cachedElectron) } : {}),
  out: output,
  overwrite: true,
  icon: path.join(root, "gui", "assets", "brand", "dmcl-app-icon.ico"),
  extraResource: [path.join(root, "resources", "tools")],
  ignore: [
    /^\/(?:\.git|\.github|tests|src|scripts|resources|release|_e2e_)(?:\/|$)/,
  ],
  win32metadata: {
    CompanyName: "DMCL",
    FileDescription: "Developer Minecraft Launcher",
    ProductName: "DMCL",
    InternalName: "DMCL",
    OriginalFilename: "DMCL.exe",
  },
});

console.log(`Packaged DMCL: ${appPaths.join(", ")}`);
