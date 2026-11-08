#!/usr/bin/env node
// Current instruction inventory, modeled state, and operand-form guard matrix, derived from the source.
// Use it at the start of ISA work (instead of trusting any prose snapshot) and again before review.
//   node .cursor/skills/x86-64-isa/scripts/isa-inventory.mjs [--root <repo>]
//
// Output: (1) mnemonic -> handler table from generator/generate.ts, (2) the modeled state (flag fields, memory size,
// step limit), (3) a guard matrix for every handler: which operand-form / prefix / error checks the handler body
// itself contains, and (4) attention items. The matrix is HEURISTIC text matching: helpers such as
// read_operand_value validate operand kinds on behalf of their callers, so a zero is a prompt to read the code,
// not a verdict. Exit code is always 0 unless the inputs cannot be parsed (2).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const i0 = argv.indexOf("--root");
const root = i0 >= 0 ? resolve(argv[i0 + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
let gen, ops, cpu, generated, lib;
try {
  gen = read("generator/generate.ts");
  ops = read("engine/src/exec_ops.rs");
  cpu = read("engine/src/exec_cpu.rs");
  generated = read("engine/src/exec_generated.rs");
  lib = read("engine/src/lib.rs");
} catch (e) {
  console.error(`cannot read inputs: ${e.message}`);
  process.exit(2);
}

const t0 = gen.indexOf("const SEMANTIC_INSTRUCTIONS");
const table = gen.slice(t0, gen.indexOf("\n];", t0));
const entries = [...table.matchAll(/\{\s*mnemonic:\s*"(\w+)",\s*handler:\s*"(\w+)",(?:\s*jumpCondition:\s*"([^"]*)",)?/g)].map((m) => ({ mnemonic: m[1], handler: m[2], jump: m[3] }));
if (!entries.length) {
  console.error("could not parse SEMANTIC_INSTRUCTIONS");
  process.exit(2);
}

function bodyOf(text, name) {
  const m = new RegExp(`^(?:pub )?fn ${name}\\b`, "m").exec(text);
  if (!m) return null;
  let i = text.indexOf("{", m.index);
  const start = i;
  for (let depth = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) break;
  }
  return text.slice(start, i + 1);
}
const count = (s, re) => (s.match(re) || []).length;
const guards = (b) => ({
  lines: b.split("\n").length,
  opKind: count(b, /\bop[01]?_kind\(/g),
  opCount: count(b, /\bop_count\(/g),
  prefix: count(b, /has_(lock|rep|repe|repne)_prefix\(|segment_prefix\(/g),
  errs: count(b, /\bErr\(|return Err|\.ok_or|map_err/g),
  panics: count(b, /\bpanic!|\.unwrap\(\)|\.expect\(/g),
  flags: [...new Set([...b.matchAll(/flags\.(cf|zf|sf|of)\s*=/g)].map((m) => m[1].toUpperCase()))].join(""),
  helpers: [...new Set([...b.matchAll(/\b(flags_for_add|flags_for_sub|flags_for_logic|read_operand_value|write_operand_value|effective_address|read_memory|write_memory)\b/g)].map((m) => m[1]))].join(","),
});

console.log(`implemented mnemonics: ${entries.length} (source of truth: generator/generate.ts SEMANTIC_INSTRUCTIONS)`);
const flagFields = [...(/pub struct Flags \{([^}]*)\}/.exec(cpu)?.[1] ?? "").matchAll(/pub (\w+): bool/g)].map((m) => m[1].toUpperCase());
const memConst = /const MEMORY_SIZE: usize = ([^;]+);/.exec(cpu)?.[1] ?? "?";
const steps = /const MAX_EXEC_STEPS: usize = ([^;]+);/.exec(lib)?.[1] ?? "?";
console.log(`modeled state: flags {${flagFields.join(", ") || "?"}}; guest memory ${memConst} bytes (flat, bounds-checked); step limit ${steps}; regs ${/regs: \[u64; (\d+)\]/.exec(cpu)?.[1] ?? "?"} GPRs`);
console.log(`not modeled unless listed above: other EFLAGS bits (PF AF DF ...), XMM/x87/MXCSR, segment bases other than FS (${/fs_base/.test(cpu) ? "fs_base present" : "no fs_base"}), page permissions\n`);

console.log("mnemonic     handler              lines opKind opCount prefix errs panics flags-written  helpers");
const seen = new Set();
const attention = [];
for (const e of entries) {
  if (e.handler === "Jump" || e.handler === "Halt") {
    console.log(`${e.mnemonic.padEnd(12)} ${("<generated " + e.handler + ">").padEnd(20)} ${"-".padStart(5)} (jump condition: ${e.jump ?? "unconditional"})`);
    continue;
  }
  const b = bodyOf(ops, e.handler) ?? (e.handler === "dispatch_real_syscall" ? bodyOf(ops, e.handler) : null);
  if (!b) {
    console.log(`${e.mnemonic.padEnd(12)} ${e.handler.padEnd(20)} (body not found)`);
    continue;
  }
  const g = guards(b);
  console.log(`${e.mnemonic.padEnd(12)} ${e.handler.padEnd(20)} ${String(g.lines).padStart(5)} ${String(g.opKind).padStart(6)} ${String(g.opCount).padStart(7)} ${String(g.prefix).padStart(6)} ${String(g.errs).padStart(4)} ${String(g.panics).padStart(6)} ${(g.flags || "-").padEnd(14)}  ${g.helpers}`);
  if (!seen.has(e.handler)) {
    seen.add(e.handler);
    if (g.opKind + g.opCount === 0 && !/read_operand_value|write_operand_value/.test(g.helpers) && e.mnemonic !== "Syscall" && e.handler !== "exec_nop") attention.push(`${e.handler}: no operand-kind/count check in the body and no operand helper: confirm it cannot run on a form it does not implement`);
    if (g.panics) attention.push(`${e.handler}: ${g.panics} panic/unwrap/expect site(s) in the body (guest-derived input must return Err)`);
  }
}
const jumpArms = count(generated, /near_branch64\(\)/g);
const jumpGuards = count(generated, /\bop[01]?_kind\(/g);
console.log(`\ngenerated dispatch (engine/src/exec_generated.rs): ${jumpArms} use(s) of near_branch64(), ${jumpGuards} operand-kind check(s)`);
if (jumpArms && !jumpGuards) attention.push("generated Jump arms use near_branch64() with no operand-kind check: an indirect jmp/jcc form would not be recognized as unsupported");
const callBody = bodyOf(ops, "exec_call");
if (callBody && /near_branch64\(\)/.test(callBody) && !/\bop[01]?_kind\(/.test(callBody)) attention.push("exec_call uses near_branch64() with no operand-kind check (indirect call forms)");
const retBody = bodyOf(ops, "exec_ret");
if (retBody && !/immediate|op_count|op0_kind/.test(retBody)) attention.push("exec_ret never looks at operands (a `ret imm16` form would not adjust RSP)");
const prefixSites = [...ops.matchAll(/has_(?:lock|rep|repe|repne)_prefix\(|segment_prefix\(/g)].length;
console.log(`prefix inspection sites in exec_ops.rs: ${prefixSites} (see effective_address for segment-override handling)`);
if (!/segment_prefix\(\)\s*==\s*Register::GS|Register::GS/.test(ops)) attention.push("no GS segment handling in exec_ops.rs: a GS-prefixed operand is computed without a GS base");
if (!/has_lock_prefix/.test(ops)) attention.push("no handler inspects the LOCK prefix (acceptable in a single-threaded model, but state the assumption)");
console.log(attention.length ? "\nattention (heuristic; read the code before concluding):" : "\nattention: none from the heuristics");
for (const a of attention) console.log(`  - ${a}`);
