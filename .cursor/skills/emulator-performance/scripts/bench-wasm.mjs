#!/usr/bin/env node
// Micro-benchmark harness for the BUILT wasm engine (emulator-performance skill).
// The repository has no benchmark infrastructure of its own; this measures the same artifacts that
// scripts/golden.mjs and the web app load (web/public/wasm, produced by `pnpm engine:build`).
//
//   node .cursor/skills/emulator-performance/scripts/bench-wasm.mjs                       # table
//   node .cursor/skills/emulator-performance/scripts/bench-wasm.mjs --json > baseline.json
//   node .cursor/skills/emulator-performance/scripts/bench-wasm.mjs --compare baseline.json
// Options: --runs 30  --warmup 5  --loop-iters 25000  --filter <substring>  --wasm-dir <dir>
//          --elf <path>   (repeatable) add run_elf(<file>) as a workload, e.g. a new fixture; it must finish without an error
//
// Notes: every workload is checked for a correct result before it is timed, so a "faster" build that
// computes something else fails here. engine/src/lib.rs caps a run at MAX_EXEC_STEPS = 100_000 guest
// steps, so workloads are short and per-call overhead (16 MiB guest memory, decode, trace formatting,
// the disassembly text that run_elf builds) is part of what is measured.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cpus, platform, arch, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const wasmDir = resolve(opt("wasm-dir", join(root, "web", "public", "wasm")));
const runs = Number(opt("runs", 30));
const warmup = Number(opt("warmup", 5));
const loopIters = Number(opt("loop-iters", 25000));
const filter = opt("filter", "");
const MAX_EXEC_STEPS = 100_000; // mirror of engine/src/lib.rs; re-check there if it changes

if (!Number.isInteger(loopIters) || loopIters < 1 || 3 * loopIters + 2 >= MAX_EXEC_STEPS) {
  console.error(`--loop-iters must keep 3*N+2 below ${MAX_EXEC_STEPS} guest steps (got ${loopIters})`);
  process.exit(2);
}
const wasmPath = join(wasmDir, "chameleon_engine_bg.wasm");
const gluePath = join(wasmDir, "chameleon_engine.js");
if (!existsSync(wasmPath) || !existsSync(gluePath)) {
  console.error(`built wasm not found in ${wasmDir}. Run \`pnpm engine:build\` first (needs Rust + wasm-pack).`);
  process.exit(2);
}
const wasmBytes = readFileSync(wasmPath);
const engine = await import(pathToFileURL(gluePath).href);
engine.initSync({ module: wasmBytes });

// mov eax,0 ; add eax,1 ; cmp eax,N ; jl -10 ; ret   => 3N+2 guest steps, returns EAX = N
function countedLoop(n) {
  const le = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  return new Uint8Array([0xb8, 0, 0, 0, 0, 0x83, 0xc0, 0x01, 0x3d, ...le, 0x7c, 0xf6, 0xc3]);
}
const loop = countedLoop(loopIters);
const sumSquares = engine.embedded_sum_squares();
const workloads = [
  { name: `execute:counted-loop(${loopIters})`, run: () => engine.execute(loop), ok: (r) => r.trim() === `EAX = ${loopIters}` },
  { name: "run_elf:sum_squares", run: () => engine.run_elf(sumSquares), ok: (r) => !/error/i.test(r) && /Exit code: 0/.test(r) },
  { name: "run_elf:elf_write_exit", run: () => engine.run_elf(engine.embedded_elf()), ok: (r) => !/error/i.test(r) && /Exit code: 37/.test(r) },
  { name: "self_test", run: () => engine.self_test(), ok: (r) => !/FAIL/.test(r) && (r.match(/PASS/g) || []).length >= 19 },
];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--elf") continue;
  const bytes = new Uint8Array(readFileSync(resolve(args[i + 1])));
  workloads.push({ name: `run_elf:${args[i + 1].split(/[\\/]/).pop()}`, run: () => engine.run_elf(bytes), ok: (r) => !/error/i.test(r.split("\n")[0]) });
}
workloads.splice(0, workloads.length, ...workloads.filter((w) => w.name.includes(filter)));

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil(p * a.length) - 1)];
const results = [];
for (const w of workloads) {
  const t0 = performance.now();
  const first = w.run();
  const firstMs = performance.now() - t0;
  if (!w.ok(first)) {
    console.error(`workload ${w.name} produced an unexpected result; refusing to time it:\n${String(first).slice(0, 400)}`);
    process.exit(1);
  }
  for (let i = 0; i < warmup; i++) w.run();
  const xs = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    w.run();
    xs.push(performance.now() - s);
  }
  const med = median(xs);
  results.push({
    name: w.name,
    runs,
    firstMs,
    min: Math.min(...xs),
    median: med,
    p90: pct(xs, 0.9),
    mad: median(xs.map((x) => Math.abs(x - med))),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  });
}
const report = {
  env: { node: process.version, platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model ?? "unknown", cpus: cpus().length },
  wasm: { file: wasmPath, bytes: wasmBytes.length, sha256: createHash("sha256").update(wasmBytes).digest("hex") },
  params: { runs, warmup, loopIters },
  results,
};

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const f = (x) => x.toFixed(x < 10 ? 3 : 1).padStart(9);
console.log(`node ${report.env.node} | ${report.env.platform} | ${report.env.cpu} x${report.env.cpus}`);
console.log(`wasm ${report.wasm.bytes} bytes sha256 ${report.wasm.sha256.slice(0, 16)}... | runs=${runs} warmup=${warmup}  (ms per call)`);
console.log(`${"workload".padEnd(34)}${"min".padStart(9)}${"median".padStart(9)}${"p90".padStart(9)}${"MAD".padStart(9)}${"first".padStart(9)}`);
for (const r of results) console.log(`${r.name.padEnd(34)}${f(r.min)}${f(r.median)}${f(r.p90)}${f(r.mad)}${f(r.firstMs)}`);

const basePath = opt("compare", null);
if (basePath) {
  const base = JSON.parse(readFileSync(resolve(basePath), "utf8"));
  if (base.wasm?.sha256 === report.wasm.sha256) console.log("\nwarning: baseline and current wasm are byte-identical; any difference below is noise");
  console.log("\nvs baseline (heuristic: 'improved'/'regressed' only when median +/- 2*MAD intervals do not overlap):");
  for (const r of results) {
    const b = base.results?.find((x) => x.name === r.name);
    if (!b) {
      console.log(`${r.name.padEnd(34)} no baseline entry`);
      continue;
    }
    const verdict = r.median + 2 * r.mad < b.median - 2 * b.mad ? "improved" : r.median - 2 * r.mad > b.median + 2 * b.mad ? "REGRESSED" : "within noise";
    console.log(`${r.name.padEnd(34)} ${b.median.toFixed(3)} -> ${r.median.toFixed(3)} ms (${((r.median / b.median - 1) * 100).toFixed(1)}%)  ${verdict}`);
  }
}
