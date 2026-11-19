#!/usr/bin/env node
// Structural validator for the eight Chameleon-Shell skills in .agents/skills (no dependencies, Node >= 22).
//
//   node .agents/skills/check-skills.mjs
//
// Checks, for each of the eight expected skill directories (other skills in .agents/skills are ignored):
//   - frontmatter keys are limited to the two Antigravity documents (name, description); `name` matches the
//     folder name and the lowercase-hyphen pattern; `description` is present, within 1024 characters (Agent
//     Skills limit), and written in the third person (Antigravity's guidance), not "Use when ..." or "you ..."
//   - relative markdown links and `resources/...`, `scripts/...` mentions resolve to real files
//   - every file under resources/ and scripts/ is mentioned in SKILL.md (no orphans)
//   - `pnpm <script>` names exist in the root package.json (or are pnpm built-ins)
//   - `node <path>.mjs` / `tsx <path>.ts` paths exist
//   - no CRLF, no trailing whitespace, files end with a newline
// It does NOT check external URLs (no network access) and does NOT prove Antigravity discovers the skills.
// Exit code 0 = no errors (warnings allowed), 1 = errors.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillsRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(skillsRoot, "..", "..");
const EXPECTED = [
  "chameleon-rust",
  "x86-64-isa",
  "differential-emulation-testing",
  "elf-linux-abi",
  "wasm-runtime-boundary",
  "typescript-codegen",
  "browser-sandbox-security",
  "emulator-performance",
];
const ALLOWED_KEYS = new Set(["name", "description"]);
const PNPM_BUILTINS = new Set(["install", "i", "add", "remove", "update", "up", "exec", "dlx", "run", "audit", "why", "list", "ls", "outdated", "store", "approve-builds", "--filter", "-r", "-w", "--frozen-lockfile"]);
const errors = [];
const warnings = [];
const err = (file, msg) => errors.push(`${relative(repoRoot, file)}: ${msg}`);
const warn = (file, msg) => warnings.push(`${relative(repoRoot, file)}: ${msg}`);

let pkgScripts = new Set();
try {
  pkgScripts = new Set(Object.keys(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts ?? {}));
} catch {
  warnings.push("root package.json not readable: pnpm script names were not checked");
}

function parseFrontmatter(text, file) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) {
    err(file, "missing YAML frontmatter delimited by --- lines");
    return null;
  }
  const out = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const k = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!k) {
      if (lines[i].trim() && !/^\s/.test(lines[i])) err(file, `unparseable frontmatter line: ${lines[i]}`);
      continue;
    }
    let [, key, val] = k;
    if (/^[>|][+-]?$/.test(val.trim())) {
      const folded = val.trim().startsWith(">");
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === "")) block.push(lines[++i].trim());
      val = folded ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    } else if (val === "" ) {
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) i++; // nested mapping/sequence: value not needed
      val = "(nested)";
    } else {
      val = val.replace(/^(["'])(.*)\1$/, "$2");
    }
    if (key in out) err(file, `duplicate frontmatter key: ${key}`);
    out[key] = val;
  }
  return out;
}

const stripCode = (t) => t.replace(/```[\s\S]*?```/g, (b) => "\n".repeat(b.split("\n").length - 1));
function checkHygiene(file, text) {
  if (text.includes("\r")) err(file, "contains CR characters (repository uses LF; see .gitattributes)");
  if (!text.endsWith("\n")) err(file, "does not end with a newline");
  text.split("\n").forEach((l, i) => {
    if (/[ \t]+$/.test(l)) err(file, `trailing whitespace on line ${i + 1}`);
  });
}
function checkLinks(file, text, skillDir) {
  const body = stripCode(text);
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const p = resolve(dirname(file), target.split("#")[0]);
    if (!existsSync(p)) err(file, `broken relative link: ${target}`);
  }
  if (skillDir) {
    for (const m of text.matchAll(/`((?:resources|scripts|examples)\/[A-Za-z0-9_./-]+)`/g)) {
      // `scripts/...` may also name a repository script (scripts/golden.mjs); accept either location.
      if (!existsSync(join(skillDir, m[1])) && !existsSync(join(repoRoot, m[1]))) err(file, `mentioned file exists neither in the skill nor in the repository: ${m[1]}`);
    }
  }
  for (const m of text.matchAll(/\bpnpm\s+((?:--?[A-Za-z-]+\s+\S+\s+)?[A-Za-z][A-Za-z0-9:._-]*)(\*)?/g)) {
    if (m[2]) continue; // wildcard such as `pnpm engine:*`
    const tok = m[1].split(/\s+/).pop();
    if (pkgScripts.size && !pkgScripts.has(tok) && !PNPM_BUILTINS.has(tok)) err(file, `\`pnpm ${tok}\` is not a script in the root package.json`);
  }
  for (const m of text.matchAll(/\b(?:node|tsx)\s+((?:\.agents|scripts|generator|engine|web)\/[A-Za-z0-9_./-]+\.(?:mjs|js|ts))/g)) {
    if (!existsSync(join(repoRoot, m[1]))) err(file, `command references a missing file: ${m[1]}`);
  }
}
const listFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? listFiles(p) : [p];
      })
    : [];

const present = readdirSync(skillsRoot).filter((n) => statSync(join(skillsRoot, n)).isDirectory() && existsSync(join(skillsRoot, n, "SKILL.md")));
const dirs = EXPECTED.filter((e) => present.includes(e));
for (const e of EXPECTED) if (!present.includes(e)) errors.push(`expected skill directory missing or has no SKILL.md: ${e}`);
const others = present.filter((n) => !EXPECTED.includes(n));
if (others.length) console.log(`note: ignoring ${others.length} other skill(s) in this directory: ${others.join(", ")}`);

for (const d of dirs) {
  const dir = join(skillsRoot, d);
  const file = join(dir, "SKILL.md");
  const text = readFileSync(file, "utf8");
  checkHygiene(file, text);
  for (const f of new Set([file, ...listFiles(dir)])) {
    if (/\.(md|mjs)$/.test(f) && readFileSync(f, "utf8").includes(".cursor/" + "skills")) err(f, "leftover Cursor path (.cursor/skills): this suite lives in .agents/skills");
  }
  const fm = parseFrontmatter(text, file);
  if (fm) {
    for (const k of Object.keys(fm)) if (!ALLOWED_KEYS.has(k)) err(file, `unsupported frontmatter key: ${k}`);
    if (!fm.name) err(file, "missing name");
    else {
      if (fm.name !== d) err(file, `name "${fm.name}" does not match folder "${d}"`);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name) || fm.name.length > 64) err(file, `name "${fm.name}" must be lowercase letters/digits/single hyphens, at most 64 chars`);
    }
    if (!fm.description) err(file, "missing description");
    else {
      if (fm.description.length > 1024) err(file, `description is ${fm.description.length} chars (limit 1024)`);
      if (fm.description.length < 200) warn(file, `description is only ${fm.description.length} chars; activation quality usually needs more specifics`);
      if (/^Use (when|this)\b/i.test(fm.description) || /\b(you|your)\b/i.test(fm.description)) warn(file, "description is not third person (Antigravity guidance: describe what the skill does and when it applies)");
    }
  }
  const lines = text.split("\n").length;
  if (lines > 500) warn(file, `SKILL.md has ${lines} lines (guidance: keep under 500, move detail to references/)`);
  checkLinks(file, text, dir);
  for (const f of listFiles(dir)) {
    if (f === file) continue;
    const rel = relative(dir, f);
    if (/\.(md|mjs)$/.test(f)) checkHygiene(f, readFileSync(f, "utf8"));
    if (f.endsWith(".md")) checkLinks(f, readFileSync(f, "utf8"), null);
    if (!text.includes(rel)) warn(file, `file not mentioned in SKILL.md (orphan?): ${rel}`);
  }
}
const readme = join(skillsRoot, "README.md");
if (existsSync(readme)) {
  const t = readFileSync(readme, "utf8");
  checkHygiene(readme, t);
  checkLinks(readme, t, null);
}
for (const f of [join(repoRoot, ".cursor", "skills")]) if (existsSync(f)) warnings.push(`${relative(repoRoot, f)} exists: Cursor also reads .agents/skills, so with both copies installed Cursor sees every skill twice. Keep one copy.`);

for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`ERROR:   ${e}`);
console.log(`${dirs.length} skill(s) checked: ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
