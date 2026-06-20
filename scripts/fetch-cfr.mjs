import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.152";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "resources", "tools", "cfr.jar");
const urls = [
  `https://maven.aliyun.com/repository/public/org/benf/cfr/${VERSION}/cfr-${VERSION}.jar`,
  `https://repo1.maven.org/maven2/org/benf/cfr/${VERSION}/cfr-${VERSION}.jar`,
];

if (fs.existsSync(destination) && fs.statSync(destination).size > 1_000_000) {
  console.log(`CFR ${VERSION} already prepared: ${destination}`);
  process.exit(0);
}

await fs.promises.mkdir(path.dirname(destination), { recursive: true });
const localCandidates = [process.env.DMCL_CFR_JAR];
const cursorExtensions = path.join(os.homedir(), ".cursor", "extensions");
if (fs.existsSync(cursorExtensions)) {
  for (const entry of fs.readdirSync(cursorExtensions, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("minecraft-dev.minecraft-mod-launcher-")) {
      localCandidates.push(path.join(cursorExtensions, entry.name, "cfr-jar", "cfr.jar"));
    }
  }
}
for (const candidate of localCandidates) {
  if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).size > 1_000_000) {
    await fs.promises.copyFile(candidate, destination);
    console.log(`Prepared CFR ${VERSION} from local cache: ${destination}`);
    process.exit(0);
  }
}

let lastError;
for (const url of urls) {
  try {
    console.log(`Downloading CFR ${VERSION} from ${url}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length < 1_000_000) throw new Error("download is unexpectedly small");
    await fs.promises.writeFile(destination, data);
    console.log(`Prepared ${destination}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
  }
}
throw new Error(`Unable to prepare CFR ${VERSION}: ${lastError?.message ?? lastError}`);
