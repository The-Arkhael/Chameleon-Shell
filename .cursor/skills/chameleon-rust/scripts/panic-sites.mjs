#!/usr/bin/env node
// Lists panic-capable constructs in non-test Rust code under engine/src and compares two snapshots.
// Guest-derived failure must be Err(String), never a panic (a panic is a wasm trap with no message).
//   node .cursor/skills/chameleon-rust/scripts/panic-sites.mjs                    # list sites
//   node .cursor/skills/chameleon-rust/scripts/panic-sites.mjs --json > before.json   # before your change
//   node .cursor/skills/chameleon-rust/scripts/panic-sites.mjs --compare before.json  # after: new sites, exit 1 if any
//
// Finds: panic!, unwrap(), expect(), unreachable!, todo!/unimplemented!, unsafe. It skips #[cfg(test)] modules and
// comment lines, and does NOT find indexing (a[i]) or unchecked `as` conversions: review those by reading.
// Sites are keyed by file + kind + trimmed source text (line numbers shift), so the comparison survives edits.
// File classes: core (lib/exec_cpu/exec_ops/elf), selftest (ships in the wasm), legacy (cpu.rs, generated.rs), generated.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const src = join(root, "engine", "src");
const klass = (f) => (["lib.rs", "exec_cpu.rs", "exec_ops.rs", "elf.rs"].includes(f) ? "core" : f === "self_test.rs" ? "selftest" : ["cpu.rs", "generated.rs"].includes(f) ? "legacy" : f === "exec_generated.rs" ? "generated" : "other");
const kinds = [
  ["panic!", /\bpanic!\s*\(/],
  ["unwrap", /\.unwrap\(\)/],
  ["expect", /\.expect\(/],
  ["unreachable!", /\bunreachable!\s*\(/],
  ["todo!", /\b(?:todo|unimplemented)!\s*\(/],
  ["unsafe", /\bunsafe\b/],
];

function testRanges(text) {
  const ranges = [];
  for (const m of text.matchAll(/#\[cfg\(test\)\]/g)) {
    const open = text.indexOf("{", m.index);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) break;
    }
    ranges.push([m.index, i]);
  }
  return ranges;
}
const sites = [];
for (const f of readdirSync(src).filter((n) => n.endsWith(".rs")).sort()) {
  const text = readFileSync(join(src, f), "utf8").replace(/\r\n/g, "\n");
  const skip = testRanges(text);
  let offset = 0;
  text.split("\n").forEach((line, idx) => {
    const here = offset;
    offset += line.length + 1;
    const t = line.trim();
    if (t.startsWith("//") || skip.some(([a, b]) => here >= a && here <= b)) return;
    for (const [kind, re] of kinds) if (re.test(line)) sites.push({ file: f, cls: klass(f), kind, line: idx + 1, text: t.slice(0, 140) });
  });
}
const key = (s) => `${s.file}|${s.kind}|${s.text}`;

if (argv.includes("--json")) {
  console.log(JSON.stringify(sites, null, 1));
  process.exit(0);
}
const ci = argv.indexOf("--compare");
if (ci >= 0) {
  const p = resolve(argv[ci + 1]);
  if (!existsSync(p)) {
    console.error(`snapshot not found: ${p}`);
    process.exit(2);
  }
  const before = new Map();
  for (const s of JSON.parse(readFileSync(p, "utf8"))) before.set(key(s), (before.get(key(s)) ?? 0) + 1);
  const added = [];
  for (const s of sites) {
    const n = before.get(key(s)) ?? 0;
    if (n > 0) before.set(key(s), n - 1);
    else added.push(s);
  }
  const removed = [...before.values()].reduce((a, b) => a + b, 0);
  for (const s of added) console.log(`NEW   ${s.file}:${s.line} [${s.cls}] ${s.kind}: ${s.text}`);
  console.log(`${added.length} new site(s), ${removed} removed`);
  process.exit(added.some((s) => s.cls !== "selftest") ? 1 : 0);
}
const byFile = new Map();
for (const s of sites) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
for (const [f, list] of byFile) {
  console.log(`${f} [${klass(f)}]: ${list.length}`);
  for (const s of list) console.log(`  ${String(s.line).padStart(4)}  ${s.kind.padEnd(12)} ${s.text}`);
}
const core = sites.filter((s) => s.cls === "core");
console.log(`\ntotal non-test sites: ${sites.length} (core: ${core.length}; legacy: ${sites.filter((s) => s.cls === "legacy").length}; selftest: ${sites.filter((s) => s.cls === "selftest").length})`);
