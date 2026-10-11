#!/usr/bin/env node
/**
 * Bump the app version everywhere it's written down.
 *
 *   npm run bump              # patch: 1.2.1 → 1.2.2
 *   npm run bump -- minor     # 1.2.1 → 1.3.0
 *   npm run bump -- major     # 1.2.1 → 2.0.0
 *   npm run bump -- 1.4.0     # explicit version
 *   npm run bump -- minor --dry-run
 *
 * The current version is read from package.json. Each file is edited with a
 * pattern that only matches *our* version (lockfiles also contain unrelated
 * packages at the same version number). If a pattern no longer matches, the
 * script stops before writing anything, so a moved string is noticed rather
 * than silently left behind.
 */
/* global process, console */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const kind = args.find((a) => !a.startsWith("--")) ?? "patch";

const current = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const m = SEMVER.exec(current);
if (!m) fail(`package.json version "${current}" is not x.y.z`);
const [maj, min, pat] = m.slice(1).map(Number);

let next;
if (kind === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (kind === "minor") next = `${maj}.${min + 1}.0`;
else if (kind === "major") next = `${maj + 1}.0.0`;
else if (SEMVER.test(kind)) next = kind;
else fail(`unknown bump "${kind}" (use patch, minor, major or x.y.z)`);
if (next === current) fail(`already at ${current}`);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const v = esc(current);

/** [file, pattern (must match), replacement, expected match count] */
const edits = [
  ["package.json", new RegExp(`("version": ")${v}(")`), `$1${next}$2`, 1],
  // Root entry and packages[""] — the first two "version" keys.
  [
    "package-lock.json",
    new RegExp(`^(  "version": ")${v}(")`, "m"),
    `$1${next}$2`,
    1,
  ],
  [
    "package-lock.json",
    new RegExp(
      `("": \\{\\n      "name": "devnest",\\n      "version": ")${v}(")`,
    ),
    `$1${next}$2`,
    1,
  ],
  [
    "src-tauri/tauri.conf.json",
    new RegExp(`("version": ")${v}(")`),
    `$1${next}$2`,
    1,
  ],
  [
    "src-tauri/Cargo.toml",
    new RegExp(`^(version = ")${v}(")`, "m"),
    `$1${next}$2`,
    1,
  ],
  [
    "src-tauri/Cargo.lock",
    new RegExp(`(name = "devnest"\\nversion = ")${v}(")`),
    `$1${next}$2`,
    1,
  ],
  ["README.md", new RegExp(`(Version )${v}( ·)`), `$1${next}$2`, 1],
  ["index.html", new RegExp(`(v)${v}( &middot;)`, "g"), `$1${next}$2`, 1],
  [
    "docs/index.html",
    new RegExp(`(brand-version">v)${v}(<)`),
    `$1${next}$2`,
    1,
  ],
  ["docs/index.html", new RegExp(`(v)${v}( · Let's)`), `$1${next}$2`, 1],
  [
    "docs/index.html",
    new RegExp(`(<strong>v)${v}(</strong>)`),
    `$1${next}$2`,
    1,
  ],
  [
    "src/panels/SettingsPanel.tsx",
    new RegExp(`(font-mono">)${v}(<)`),
    `$1${next}$2`,
    1,
  ],
];

// Apply everything in memory first; write only if every edit matched.
const contents = new Map();
const problems = [];
for (const [file, re, rep, expected] of edits) {
  const text = contents.get(file) ?? readFileSync(join(root, file), "utf8");
  const count = (
    text.match(
      new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"),
    ) ?? []
  ).length;
  if (count !== expected) {
    problems.push(
      `${file}: expected ${expected} match(es) of /${re.source}/, found ${count}`,
    );
    continue;
  }
  contents.set(file, text.replace(re, rep));
}
if (problems.length) fail(`nothing written:\n  ${problems.join("\n  ")}`);

for (const [file, text] of contents) {
  if (!dryRun) writeFileSync(join(root, file), text);
  console.log(`${dryRun ? "would update" : "updated"} ${file}`);
}

console.log(`\n${current} → ${next}${dryRun ? " (dry run)" : ""}`);

function fail(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}
