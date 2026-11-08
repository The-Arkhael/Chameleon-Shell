#!/usr/bin/env node
// Current syscall inventory of the engine, derived from the source (not from this skill's prose).
//   node .cursor/skills/elf-linux-abi/scripts/syscall-inventory.mjs [--header <unistd_64.h>] [--root <repo>]
//
// Reports: constants in engine/src/exec_ops.rs, which have a dispatch arm, whether each number matches the
// kernel header (when a header is available: Linux dev machines and CI have one, a Windows checkout does not),
// and which syscalls the committed strace fixtures need that the engine does not implement yet.
// Exit code: 0 = consistent (gaps are information), 1 = a constant disagrees with the header or has no arm.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const root = resolve(opt("root", resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")));
const ops = readFileSync(join(root, "engine", "src", "exec_ops.rs"), "utf8").replace(/\r\n/g, "\n");

const consts = [...ops.matchAll(/^const ((?:SYS|ARCH)_[A-Z0-9_]+): u64 = (0x[0-9a-fA-F]+|\d+);/gm)].map((m) => ({ name: m[1], value: Number(m[2]) }));
const start = ops.indexOf("pub fn dispatch_real_syscall");
const body = start < 0 ? "" : ops.slice(start);
const arms = new Set([...body.matchAll(/^\s+((?:SYS)_[A-Z0-9_]+)\s*=>/gm)].map((m) => m[1]));

const headerCandidates = [opt("header", ""), "/usr/include/x86_64-linux-gnu/asm/unistd_64.h", "/usr/include/asm/unistd_64.h"].filter(Boolean);
const headerPath = headerCandidates.find((p) => existsSync(p));
const nr = new Map();
if (headerPath) for (const m of readFileSync(headerPath, "utf8").matchAll(/^#define __NR_(\w+)\s+(\d+)/gm)) nr.set(m[1], Number(m[2]));

let bad = 0;
console.log(`engine syscall constants (engine/src/exec_ops.rs); kernel header: ${headerPath ?? "not available (numbers not cross-checked)"}`);
for (const c of consts.filter((x) => x.name.startsWith("SYS_"))) {
  const lower = c.name.slice(4).toLowerCase();
  const hv = nr.get(lower);
  const numberOk = hv === undefined ? "n/a" : hv === c.value ? "ok" : `MISMATCH (header ${hv})`;
  const arm = arms.has(c.name) ? "arm" : "NO ARM";
  if (numberOk.startsWith("MISMATCH") || arm === "NO ARM") bad++;
  console.log(`  ${c.name.padEnd(22)} ${String(c.value).padStart(4)}  number: ${numberOk.padEnd(10)} ${arm}`);
}
for (const c of consts.filter((x) => x.name.startsWith("ARCH_"))) console.log(`  ${c.name.padEnd(22)} 0x${c.value.toString(16)}  (arch_prctl code; verify against asm/prctl.h)`);
console.log("  anything else falls through to the 'unsupported syscall' error (a deliberate design choice, not -ENOSYS)");

const fx = join(root, "engine", "tests", "fixtures");
const implemented = new Set(consts.filter((x) => x.name.startsWith("SYS_")).map((x) => x.name.slice(4).toLowerCase()));
const loaderSide = new Set(["execve"]); // appears in a native strace only because the tracer started the process
if (existsSync(fx)) {
  for (const f of readdirSync(fx).filter((n) => n.endsWith(".strace.txt"))) {
    const names = new Set();
    for (const l of readFileSync(join(fx, f), "utf8").split(/\r?\n/)) {
      const m = /^(?:\d+\s+)?([a-z_0-9]+)\(/.exec(l);
      if (m) names.add(m[1]);
    }
    const missing = [...names].filter((n) => !implemented.has(n) && !loaderSide.has(n));
    console.log(`fixture ${f}: needs ${[...names].join(", ")}`);
    console.log(missing.length ? `  NOT IMPLEMENTED by the engine: ${missing.join(", ")}` : "  every needed syscall has an engine constant");
  }
}
console.log(bad ? `inventory FAILED (${bad} problem(s))` : "inventory OK");
process.exit(bad ? 1 : 0);
