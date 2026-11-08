#!/usr/bin/env node
// Malformed-input probe suite for the BUILT wasm engine. Re-run it after any change to the ELF loader, the run
// loop, syscall handling, memory access, or the wasm boundary: it measures what the engine does today, so its
// output moves from GAP to PASS as validation lands (and a new TRAP shows up the moment a panic is introduced).
//   node .cursor/skills/browser-sandbox-security/scripts/probe-malformed.mjs [--level must|should] [--fuzz 300] [--seed 1]
//        [--elf <base-fixture>] [--wasm-dir <dir>] [--budget-ms 3000]
//
// Levels: MUST   = no trap (panic), no hang, no unbounded growth, on any input.        --level must   fails on a MUST problem (default)
//         SHOULD = invalid input is rejected with an error instead of being executed.   --level should also fails on a SHOULD gap
//         INFO   = measured behavior with no pass/fail verdict.
// Outcomes: REJECTED (engine returned an error text), ACCEPTED (engine ran it), TRAP (wasm trap, e.g. a Rust panic),
//           SLOW (exceeded the time budget). Everything runs the real wasm in Node; no Rust toolchain needed.
// Exit code: 0 = no failing probe at the chosen level, 1 = failures, 2 = setup problem.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const wasmDir = resolve(opt("wasm-dir", join(root, "web", "public", "wasm")));
const level = opt("level", "must");
const fuzzCount = Number(opt("fuzz", 300));
const seed = Number(opt("seed", 1));
const budget = Number(opt("budget-ms", 3000));
const basePath = resolve(opt("elf", join(root, "engine", "tests", "fixtures", "elf_write_exit")));
for (const p of [join(wasmDir, "chameleon_engine_bg.wasm"), join(wasmDir, "chameleon_engine.js"), basePath]) {
  if (!existsSync(p)) {
    console.error(`missing ${p}\nbuild the wasm with \`pnpm engine:build\` (needs Rust + wasm-pack) or pass --wasm-dir / --elf`);
    process.exit(2);
  }
}
const compiled = new WebAssembly.Module(readFileSync(join(wasmDir, "chameleon_engine_bg.wasm")));
let counter = 0;
async function fresh() {
  const glue = await import(pathToFileURL(join(wasmDir, "chameleon_engine.js")).href + `?probe=${++counter}`);
  const out = glue.initSync({ module: compiled });
  return { glue, mem: () => out.memory.buffer.byteLength };
}
let inst = await fresh();
const base = new Uint8Array(readFileSync(basePath));

function patch(edits) {
  const b = new Uint8Array(base);
  const dv = new DataView(b.buffer);
  for (const [off, size, value] of edits) {
    if (off + size > b.length) continue;
    if (size === 1) dv.setUint8(off, Number(value));
    else if (size === 2) dv.setUint16(off, Number(value), true);
    else if (size === 4) dv.setUint32(off, Number(value), true);
    else dv.setBigUint64(off, BigInt(value) & 0xffffffffffffffffn, true);
  }
  return b;
}
// ELF64 field offsets: e_type 16, e_machine 18, e_entry 24, e_phoff 32, e_phentsize 54, e_phnum 56; phdr i at 64 + 56*i:
// p_type +0, p_flags +4, p_offset +8, p_vaddr +16, p_filesz +32, p_memsz +40, p_align +48.
const ph = (i, f) => 64 + 56 * i + f;
const MAX = 0xffffffffffffffffn;

async function call(fn, bytes) {
  const t0 = performance.now();
  try {
    const out = String(inst.glue[fn](bytes));
    const ms = performance.now() - t0;
    if (ms > budget) return { outcome: "SLOW", detail: `${ms.toFixed(0)} ms` };
    return /error/i.test(out.split("\n")[0]) ? { outcome: "REJECTED", detail: out.split("\n")[0].slice(0, 110) } : { outcome: "ACCEPTED", detail: out.split("\n").slice(-2).join(" | ").slice(0, 110) };
  } catch (e) {
    inst = await fresh(); // a trap can leave the instance inconsistent: never reuse it
    return { outcome: "TRAP", detail: `${e?.constructor?.name}: ${String(e?.message).slice(0, 60)}` };
  }
}

const probes = [];
const add = (level, name, fn, bytes) => probes.push({ level, name, fn, bytes });
// MUST: nothing may trap or hang, whatever the bytes.
add("must", "empty input -> run_elf", "run_elf", new Uint8Array(0));
add("must", "empty input -> parse_elf", "parse_elf", new Uint8Array(0));
add("must", "empty input -> disassemble", "disassemble", new Uint8Array(0));
add("must", "empty input -> execute", "execute", new Uint8Array(0));
add("must", "empty input -> coverage_report", "coverage_report", new Uint8Array(0));
add("must", "ELF magic only -> run_elf", "run_elf", new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
add("must", "execute: jmp $ (step limit)", "execute", new Uint8Array([0xeb, 0xfe]));
add("must", "execute: truncated opcode 0F", "execute", new Uint8Array([0x0f]));
add("must", "execute: invalid bytes FF FF", "execute", new Uint8Array([0xff, 0xff, 0xff, 0xff]));
add("must", "p_memsz = 0x40000000", "run_elf", patch([[ph(1, 40), 8, 0x40000000n]]));
add("must", "p_memsz = 2^64-1", "run_elf", patch([[ph(1, 40), 8, MAX]]));
add("must", "p_vaddr near 2^64 (vaddr+memsz overflow)", "run_elf", patch([[ph(1, 16), 8, 0xfffffffffffff000n], [ph(1, 40), 8, 0x2000]]));
add("must", "p_offset near 2^64 (offset+filesz overflow)", "run_elf", patch([[ph(1, 8), 8, 0xfffffffffffffff0n], [ph(1, 32), 8, 0x20]]));
add("must", "p_filesz > file size", "run_elf", patch([[ph(1, 32), 8, 0x100000n]]));
add("must", "p_memsz < p_filesz", "run_elf", patch([[ph(1, 40), 8, 1]]));
add("must", "e_phnum = 65535", "run_elf", patch([[56, 2, 65535]]));
add("must", "e_phoff = 2^64-1", "run_elf", patch([[32, 8, MAX]]));
add("must", "e_phentsize = 0", "run_elf", patch([[54, 2, 0]]));
add("must", "e_entry = 2^64-1", "run_elf", patch([[24, 8, MAX]]));
add("must", "e_entry = 1 (mid-instruction / outside)", "run_elf", patch([[24, 8, 1]]));
add("must", "big-endian EI_DATA", "run_elf", patch([[5, 1, 2]]));
// SHOULD: invalid ELFs are rejected, not executed.
add("should", "ELFCLASS32", "run_elf", patch([[4, 1, 1]]));
add("should", "e_machine = EM_386", "run_elf", patch([[18, 2, 3]]));
add("should", "e_machine = EM_AARCH64", "run_elf", patch([[18, 2, 183]]));
add("should", "e_type = ET_REL", "run_elf", patch([[16, 2, 1]]));
add("should", "e_type = ET_CORE", "run_elf", patch([[16, 2, 4]]));
add("should", "e_type = ET_DYN (PIE/shared; unsupported until an address-space layer exists)", "run_elf", patch([[16, 2, 3]]));
add("should", "e_version = 0", "run_elf", patch([[6, 1, 0]]));
add("should", "no PT_LOAD (e_phnum = 0)", "run_elf", patch([[56, 2, 0]]));
add("should", "p_align not a power of two", "run_elf", patch([[ph(1, 48), 8, 3]]));
add("should", "p_vaddr/p_offset not congruent modulo p_align (entry moved with it)", "run_elf", patch([[ph(1, 16), 8, 0x401001], [24, 8, 0x401001]]));
add("should", "segment beyond engine memory (vaddr 0x2000000)", "run_elf", patch([[ph(1, 16), 8, 0x2000000]]));
// Legacy export: reachable from any script in the page with caller-chosen bytes.
add("should", "legacy run(): unknown opcode", "run", new Uint8Array([0xff]));
add("should", "legacy run(): truncated operand", "run", new Uint8Array([0x01]));
add("should", "legacy run(): register index out of range", "run", new Uint8Array([0x01, 9, 0, 0, 0, 0, 0, 0, 0, 0]));

const results = [];
for (const p of probes) {
  const r = await call(p.fn, p.bytes);
  const good = p.level === "must" ? ["REJECTED", "ACCEPTED"].includes(r.outcome) : r.outcome === "REJECTED";
  results.push({ ...p, ...r, pass: good });
}
// Truncation sweep: every prefix of the base ELF header region must be handled without a trap.
let trunc = { traps: 0, n: 0 };
for (let n = 0; n <= Math.min(base.length, 600); n++) {
  const r = await call("run_elf", base.subarray(0, n));
  trunc.n++;
  if (r.outcome === "TRAP" || r.outcome === "SLOW") trunc.traps++;
}
results.push({ level: "must", name: `truncation sweep (${trunc.n} prefixes)`, outcome: trunc.traps ? "TRAP" : "REJECTED/ACCEPTED", detail: `${trunc.traps} bad`, pass: trunc.traps === 0 });
// Seeded mutation fuzz over header + program headers + the first code bytes.
let s = seed >>> 0;
const rnd = () => ((s = (s + 0x6d2b79f5) >>> 0), (t => ((t = Math.imul(t ^ (t >>> 15), t | 1)), (t ^= t + Math.imul(t ^ (t >>> 7), t | 61)), ((t ^ (t >>> 14)) >>> 0) / 4294967296))(s));
const tally = { REJECTED: 0, ACCEPTED: 0, TRAP: 0, SLOW: 0 };
const bad = [];
for (let k = 0; k < fuzzCount; k++) {
  const b = new Uint8Array(base);
  const edits = [];
  for (let j = 0, m = 1 + Math.floor(rnd() * 4); j < m; j++) {
    const off = Math.floor(rnd() * Math.min(b.length, 64 + 56 * 6));
    const val = Math.floor(rnd() * 256);
    b[off] = val;
    edits.push(`${off}=0x${val.toString(16)}`);
  }
  const r = await call("run_elf", b);
  tally[r.outcome]++;
  if (r.outcome === "TRAP" || r.outcome === "SLOW") bad.push(`#${k}: ${edits.join(",")} -> ${r.outcome} ${r.detail}`);
}
results.push({ level: "must", name: `seeded mutation fuzz (seed ${seed}, ${fuzzCount} cases)`, outcome: bad.length ? "TRAP/SLOW" : "no trap", detail: JSON.stringify(tally), pass: bad.length === 0 });
// Memory stability across repeated calls (a per-call leak would show as steady growth).
const loop = new Uint8Array([0xb8, 0, 0, 0, 0, 0x83, 0xc0, 1, 0x3d, 100, 0, 0, 0, 0x7c, 0xf6, 0xc3]);
for (let i = 0; i < 20; i++) inst.glue.execute(loop);
const m0 = inst.mem();
for (let i = 0; i < 200; i++) inst.glue.execute(loop);
const grew = inst.mem() - m0;
results.push({ level: "must", name: "memory stable over 200 repeated calls", outcome: grew === 0 ? "STABLE" : "GREW", detail: `${(m0 / 1048576).toFixed(1)} MiB -> +${(grew / 1048576).toFixed(2)} MiB`, pass: grew <= 1048576 });
// Output accumulation: a write loop with no cap (measured, INFO). mov eax,1; mov edi,1; xor esi,esi; mov edx,4096; syscall; jmp start
const flood = new Uint8Array([0xb8, 1, 0, 0, 0, 0xbf, 1, 0, 0, 0, 0xbe, 0, 0, 0, 0, 0xba, 0, 0x10, 0, 0, 0x0f, 0x05, 0xeb, 0xe8]);
const before = inst.mem();
const fr = await call("execute", flood);
results.push({ level: "info", name: "output accumulation: 4 KiB write in a loop until the step limit", outcome: fr.outcome, detail: `${fr.detail}; wasm memory ${(before / 1048576).toFixed(0)} -> ${(inst.mem() / 1048576).toFixed(0)} MiB (no output cap; scale count for the worst case)`, pass: true });

const mark = (r) => (r.pass ? "PASS" : r.level === "must" ? "FAIL" : r.level === "should" ? "GAP " : "INFO");
console.log(`wasm: ${wasmDir}\nbase ELF: ${basePath}\n`);
for (const r of results) console.log(`${mark(r)}  [${r.level.padEnd(6)}] ${r.name.padEnd(76)} ${r.outcome.padEnd(11)} ${r.detail}`);
for (const b of bad.slice(0, 5)) console.log(`  fuzz repro: ${b}`);
const count = (f) => results.filter(f).length;
const mustFail = count((r) => r.level === "must" && !r.pass);
const shouldGap = count((r) => r.level === "should" && !r.pass);
console.log(`\nMUST: ${count((r) => r.level === "must" && r.pass)} pass, ${mustFail} fail | SHOULD: ${count((r) => r.level === "should" && r.pass)} pass, ${shouldGap} gap | INFO: ${count((r) => r.level === "info")}`);
process.exit(mustFail || (level === "should" && shouldGap) ? 1 : 0);
