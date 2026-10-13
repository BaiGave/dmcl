import fs from "node:fs";

/**
 * Java `.properties` parsing, the one parser for gradle.properties, gradle-wrapper.properties and
 * gradle-daemon-jvm.properties. Follows java.util.Properties#load: LF / CRLF / CR line ends, `#` and `!`
 * comments, `=`, `:` or whitespace separators, backslash line continuations and escapes (`\\uXXXX`, `\\t`,
 * `\\:`, Windows paths written as `C\\:\\\\jdk`). Later keys win, as in Java.
 */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^[ \t\f]+/, "");
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    // An odd number of trailing backslashes continues the logical line.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i].replace(/^[ \t\f]+/, "");
    }
    let keyEnd = 0;
    while (keyEnd < line.length) {
      const ch = line[keyEnd];
      if (ch === "\\") {
        keyEnd += 2;
        continue;
      }
      if (ch === "=" || ch === ":" || ch === " " || ch === "\t" || ch === "\f") break;
      keyEnd++;
    }
    const key = unescape(line.slice(0, keyEnd));
    let rest = line.slice(keyEnd).replace(/^[ \t\f]+/, "");
    if (rest.startsWith("=") || rest.startsWith(":")) rest = rest.slice(1).replace(/^[ \t\f]+/, "");
    out[key] = unescape(rest);
  }
  return out;
}

function unescape(value: string): string {
  if (!value.includes("\\")) return value;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\" || i + 1 >= value.length) {
      if (ch !== "\\") out += ch;
      continue;
    }
    const next = value[++i];
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(value.slice(i + 1, i + 5))) {
      out += String.fromCharCode(Number.parseInt(value.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "f") out += "\f";
    else out += next;
  }
  return out;
}

/** Parses a `.properties` file; a missing or unreadable file yields an empty object. */
export function readPropertiesFile(file: string): Record<string, string> {
  try {
    return parseProperties(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
