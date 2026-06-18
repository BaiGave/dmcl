import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(__dirname, "..");

/** 动态 import，避免 tsc(commonjs) 将其编译为 require(ESM)。 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const dynamicImport = new Function(
  "specifier",
  "return import(specifier)",
) as <T = unknown>(specifier: string) => Promise<T>;

export function repoDist(...segments: string[]): string {
  return path.join(repoRoot, "dist", ...segments);
}

export function loadDist<T = any>(absolutePath: string): Promise<T> {
  return dynamicImport<T>(pathToFileURL(path.resolve(absolutePath)).href);
}
