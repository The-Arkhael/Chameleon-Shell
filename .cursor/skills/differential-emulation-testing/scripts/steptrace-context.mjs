#!/usr/bin/env node
// Locate an address, or an engine failure trace, inside the committed native step trace.
// Read-only helper for the differential-emulation-testing skill. No dependencies.
//
//   node .cursor/skills/differential-emulation-testing/scripts/steptrace-context.mjs 401077
//   node .cursor/skills/differential-emulation-testing/scripts/steptrace-context.mjs 0x401077 --before 8 --after 4
//   node .cursor/skills/differential-emulation-testing/scripts/steptrace-context.mjs --engine-output failure.txt   (or "-" for stdin)
//
// Options: --fixture <name>  (uses <name>.steptrace.txt and <name>.objdump.txt in engine/tests/fixtures; default libc_startup)
//          --trace <file>  --objdump <file>  (explicit paths, override --fixture)
// The step trace folds `rep` iterations into one step; see engine/tests/fixtures/regenerate.sh.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fx = join(root, "engine", "tests", "fixtures");
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const fixture = opt("fixture", "libc_startup");
const tracePath = resolve(opt("trace", join(fx, `${fixture}.steptrace.txt`)));
const objdumpPath = resolve(opt("objdump", join(fx, `${fixture}.objdump.txt`)));
const before = Number(opt("before", 8));
const after = Number(opt("after", 3));
const engineOut = opt("engine-output", null);
const norm = (s) => s.trim().replace(/^0x/i, "").toLowerCase().replace(/^0+(?=.)/, "");

if (!existsSync(tracePath)) {
  const have = existsSync(fx) ? readdirSync(fx).filter((n) => n.endsWith(".steptrace.txt")).map((n) => n.replace(".steptrace.txt", "")) : [];
  console.error(`step trace not found: ${tracePath}\nfixtures with a step trace: ${have.join(", ") || "(none)"}`);
  process.exit(2);
}
const trace = readFileSync(tracePath, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map(norm);
const text = new Map();
if (existsSync(objdumpPath)) {
  for (const l of readFileSync(objdumpPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([0-9a-f]+):\t[0-9a-f ]+\t(.+)$/.exec(l);
    if (m) text.set(norm(m[1]), m[2].trim().replace(/\s+/g, " "));
  }
}
const show = (i) => `  step ${String(i + 1).padStart(4)}  0x${trace[i]}  ${text.get(trace[i]) ?? "(no objdump text)"}`;

if (engineOut !== null) {
  const raw = engineOut === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(engineOut), "utf8");
  const reason = raw.split(/\r?\n/).find((l) => /error:/i.test(l));
  const e = [...raw.matchAll(/^\s*0x([0-9A-Fa-f]+):\s/gm)].map((m) => norm(m[1]));
  if (!e.length) {
    console.error("no '  0xADDR: instruction' trace lines found in the engine output");
    process.exit(2);
  }
  if (reason) console.log(`engine: ${reason.slice(0, 220)}`);
  let best = { len: -1, starts: [] };
  trace.forEach((a, j) => {
    if (a !== e[0]) return;
    let k = 0;
    while (k < e.length && trace[j + k] === e[k]) k++;
    if (k > best.len) best = { len: k, starts: [j] };
    else if (k === best.len) best.starts.push(j);
  });
  if (best.len < 0) {
    console.log(`first engine address 0x${e[0]} never appears in the native trace`);
    process.exit(1);
  }
  const j = best.starts[0];
  if (best.starts.length > 1) {
    console.log(`note: ${best.starts.length} equally good alignments (steps ${best.starts.slice(0, 5).map((s) => s + 1).join(", ")}...); showing the first`);
  }
  if (best.len === e.length) {
    console.log(`engine path (${e.length} steps) matches native steps ${j + 1}-${j + e.length}: no divergence inside the window.`);
    console.log("the failure is a missing feature/behaviour at the engine's last instruction; the next native step is:");
    if (trace[j + e.length] !== undefined) console.log(show(j + e.length));
  } else {
    console.log(`FIRST DIVERGENCE at window position ${best.len + 1}/${e.length}:`);
    console.log(`  engine executed 0x${e[best.len]}`);
    console.log(`  native executed 0x${trace[j + best.len]}  ${text.get(trace[j + best.len]) ?? ""}`);
    for (let i = Math.max(0, j + best.len - before); i <= j + best.len; i++) console.log(show(i));
  }
  process.exit(0);
}

const target = argv.find((a) => !a.startsWith("--") && /^(0x)?[0-9a-fA-F]+$/.test(a));
if (!target) {
  console.error("usage: steptrace-context.mjs <hex-address> | --engine-output <file|->");
  process.exit(2);
}
const t = norm(target);
const hits = trace.flatMap((a, i) => (a === t ? [i] : []));
console.log(`native trace: ${trace.length} steps; address 0x${t} executed ${hits.length} time(s)`);
if (!hits.length) {
  console.log("never executed in the native oracle run (not on the measured path).");
  process.exit(1);
}
const f = hits[0];
for (let i = Math.max(0, f - before); i <= Math.min(trace.length - 1, f + after); i++) {
  console.log((i === f ? ">" : " ") + show(i).slice(1));
}
if (hits.length > 1) console.log(`later hits at steps: ${hits.slice(1, 8).map((i) => i + 1).join(", ")}${hits.length > 8 ? ", ..." : ""}`);
