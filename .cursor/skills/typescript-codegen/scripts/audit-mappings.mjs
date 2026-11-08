#!/usr/bin/env node
// Read-only audit of generator/generate.ts SEMANTIC_INSTRUCTIONS against the hand-written
// handlers (engine/src/exec_ops.rs), the generated table (engine/src/exec_generated.rs) and docs/STATUS.md.
// Does NOT import generator/generate.ts: importing it would run main() and rewrite the generated files.
// It adds checks the generator does not perform itself; it is not a replacement for `pnpm engine:check`.
//
//   node .cursor/skills/typescript-codegen/scripts/audit-mappings.mjs [--root <repo>]
// Exit code: 0 = no errors (warnings allowed), 1 = errors, 2 = could not parse the inputs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf("--root");
const root = i > 0 ? resolve(process.argv[i + 1]) : resolve(here, "..", "..", "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const errors = [];
const warnings = [];
const notes = [];

let gen, ops, generated;
try {
  gen = read("generator/generate.ts");
  ops = read("engine/src/exec_ops.rs");
  generated = read("engine/src/exec_generated.rs");
} catch (e) {
  console.error(`cannot read inputs under ${root}: ${e.message}`);
  process.exit(2);
}
const statusPath = join(root, "docs", "STATUS.md");
const status = existsSync(statusPath) ? read("docs/STATUS.md") : "";

// 1. Parse the semantic table (text-level; the generator keeps one object literal per entry).
const start = gen.indexOf("const SEMANTIC_INSTRUCTIONS");
const end = gen.indexOf("\n];", start);
if (start < 0 || end < 0) {
  console.error("cannot locate SEMANTIC_INSTRUCTIONS in generator/generate.ts");
  process.exit(2);
}
const table = gen.slice(start, end);
const entries = [...table.matchAll(/\{\s*mnemonic:\s*"([A-Za-z0-9_]+)",\s*handler:\s*"([A-Za-z0-9_]+)",(?:\s*jumpCondition:\s*"([^"]*)",)?/g)].map(
  (m) => ({ mnemonic: m[1], handler: m[2], jump: m[3] }),
);
const declared = (table.match(/\bmnemonic:/g) || []).length;
if (declared !== entries.length) {
  console.error(`parse mismatch: ${declared} 'mnemonic:' keys but ${entries.length} parsed entries; the table layout changed, update this script`);
  process.exit(2);
}

// 2. Duplicates (rustc only warns about an unreachable match arm; the engine gates do not deny that lint).
const seen = new Map();
for (const e of entries) seen.set(e.mnemonic, (seen.get(e.mnemonic) ?? 0) + 1);
for (const [m, n] of seen) if (n > 1) errors.push(`duplicate mnemonic ${m} appears ${n} times (the first arm silently wins)`);

// 3. Every non-Jump/Halt handler must be a hand-written function in exec_ops.rs.
const fns = new Set([...ops.matchAll(/^pub fn ([a-z_0-9]+)\(/gm)].map((m) => m[1]));
for (const e of entries) {
  if (e.handler === "Jump" || e.handler === "Halt") continue;
  if (!fns.has(e.handler)) errors.push(`${e.mnemonic}: handler ${e.handler} is not a pub fn in engine/src/exec_ops.rs`);
}

// 4. Jump conditions may only use the four modeled flags.
const allowed = /^(?:\s|!|\(|\)|&&|\|\||==|!=|cpu\.flags\.(?:cf|zf|sf|of))*$/;
for (const e of entries.filter((x) => x.handler === "Jump")) {
  if (e.jump === undefined) notes.push(`${e.mnemonic}: Jump without jumpCondition (unconditional)`);
  else if (!allowed.test(e.jump)) warnings.push(`${e.mnemonic}: jumpCondition "${e.jump}" uses something other than CF/ZF/SF/OF (PF/AF/DF are not modeled)`);
}
for (const e of entries.filter((x) => x.handler !== "Jump" && x.jump !== undefined)) {
  warnings.push(`${e.mnemonic}: jumpCondition is set but handler is ${e.handler}`);
}

// 5. The generated const must list the same mnemonics in the same order (cheap drift signal).
const cStart = generated.indexOf("pub const IMPLEMENTED_MNEMONICS");
const cEnd = generated.indexOf("];", cStart);
const emitted = cStart < 0 ? [] : [...generated.slice(cStart, cEnd).matchAll(/Mnemonic::([A-Za-z0-9_]+),/g)].map((m) => m[1]);
if (cStart < 0 || cEnd < 0) errors.push("IMPLEMENTED_MNEMONICS not found in engine/src/exec_generated.rs");
else if (emitted.join(",") !== entries.map((e) => e.mnemonic).join(",")) {
  errors.push("exec_generated.rs IMPLEMENTED_MNEMONICS differs from the generator table: run `pnpm generate` and review the diff");
}

// 6. Handlers that no table entry uses (informational: helpers like exec_nop may be shared).
const used = new Set(entries.map((e) => e.handler));
const unused = [...fns].filter((f) => /^(exec_|dispatch_)/.test(f) && !used.has(f));
if (unused.length) notes.push(`exec_ops.rs handlers not referenced by the table: ${unused.join(", ")}`);

// 7. docs/STATUS.md claims about the implemented set.
// The list wraps onto indented continuation lines; stop at the next list item or blank line.
const m = /Implemented mnemonics \((\d+)\):([^\n]*(?:\n {2,}(?!- )[^\n]*)*)/.exec(status);
if (m) {
  const docNames = m[2].replace(/\.\s*$/, "").trim().split(/\s+/).filter(Boolean);
  const tableNames = new Set(entries.map((e) => e.mnemonic));
  if (Number(m[1]) !== entries.length) warnings.push(`docs/STATUS.md says ${m[1]} implemented mnemonics; the generator table has ${entries.length}`);
  const missingInDocs = [...tableNames].filter((n) => !docNames.includes(n));
  const extraInDocs = docNames.filter((n) => !tableNames.has(n));
  if (missingInDocs.length) warnings.push(`in the table but not listed in docs/STATUS.md: ${missingInDocs.join(", ")}`);
  if (extraInDocs.length) warnings.push(`listed in docs/STATUS.md but not in the table: ${extraInDocs.join(", ")}`);
} else {
  notes.push("docs/STATUS.md has no 'Implemented mnemonics (N):' line to cross-check");
}

console.log(`semantic table: ${entries.length} entries (${entries.filter((e) => e.handler === "Jump").length} Jump, ${entries.filter((e) => e.handler === "Halt").length} Halt)`);
console.log(`generated const: ${emitted.length} mnemonics; exec_ops.rs: ${fns.size} pub fns`);
for (const n of notes) console.log(`note:    ${n}`);
for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`ERROR:   ${e}`);
console.log(errors.length ? `audit FAILED (${errors.length} error(s), ${warnings.length} warning(s))` : `audit OK (${warnings.length} warning(s))`);
process.exit(errors.length ? 1 : 0);
