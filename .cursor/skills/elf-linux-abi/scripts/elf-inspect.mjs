#!/usr/bin/env node
// Dependency-free ELF64 inspector: header, program headers, and loader-relevant checks.
// Works on Windows (no readelf needed). Read-only.
//   node .cursor/skills/elf-linux-abi/scripts/elf-inspect.mjs engine/tests/fixtures/libc_startup
//   node .cursor/skills/elf-linux-abi/scripts/elf-inspect.mjs some.elf --memory 16777216
//
// The checks encode ELF/psABI rules and the *intended* scope of a simple static loader (static, non-PIE ET_EXEC,
// x86-64, little-endian). Whether the engine itself performs each check is a separate question: confirm with
// the malformed-input probes in the browser-sandbox-security skill. Exit code 1 when any FAIL is reported.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const file = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--memory");
if (!file) {
  console.error("usage: elf-inspect.mjs <elf-file> [--memory <bytes>]");
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
let memory = 16n * 1024n * 1024n;
const mi = argv.indexOf("--memory");
if (mi >= 0) memory = BigInt(argv[mi + 1]);
else {
  const p = join(root, "engine", "src", "exec_cpu.rs");
  const m = existsSync(p) && /const MEMORY_SIZE: usize = ([0-9 *]+);/.exec(readFileSync(p, "utf8"));
  if (m) memory = m[1].split("*").reduce((a, b) => a * BigInt(b.trim()), 1n);
}

const buf = readFileSync(resolve(file));
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const hex = (v) => "0x" + BigInt(v).toString(16);
const results = [];
const note = (level, msg) => results.push([level, msg]);
if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) {
  console.error("not an ELF file (missing \\x7fELF magic or shorter than an ELF64 header)");
  process.exit(1);
}
const cls = buf[4], data = buf[5], version = buf[6], osabi = buf[7];
const eType = dv.getUint16(16, true), eMachine = dv.getUint16(18, true);
const entry = dv.getBigUint64(24, true), phoff = dv.getBigUint64(32, true);
const phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
const typeNames = { 0: "ET_NONE", 1: "ET_REL", 2: "ET_EXEC", 3: "ET_DYN", 4: "ET_CORE" };
const ptNames = { 0: "PT_NULL", 1: "PT_LOAD", 2: "PT_DYNAMIC", 3: "PT_INTERP", 4: "PT_NOTE", 5: "PT_SHLIB", 6: "PT_PHDR", 7: "PT_TLS", 0x6474e550: "PT_GNU_EH_FRAME", 0x6474e551: "PT_GNU_STACK", 0x6474e552: "PT_GNU_RELRO", 0x6474e553: "PT_GNU_PROPERTY" };
console.log(`file: ${file} (${buf.length} bytes)`);
console.log(`header: class=${cls === 2 ? "ELF64" : cls === 1 ? "ELF32" : cls} data=${data === 1 ? "LSB" : data === 2 ? "MSB" : data} version=${version} osabi=${osabi} type=${typeNames[eType] ?? eType} machine=${eMachine === 62 ? "EM_X86_64" : eMachine} entry=${hex(entry)} phoff=${phoff} phentsize=${phentsize} phnum=${phnum}`);

if (cls !== 2) note("FAIL", "not ELFCLASS64");
if (data !== 1) note("FAIL", "not little-endian (ELFDATA2LSB)");
if (eMachine !== 62) note("FAIL", `e_machine is ${eMachine}, not EM_X86_64 (62)`);
if (eType === 3) note("WARN", "ET_DYN: PIE or shared object; needs a load-base choice, relocations, and auxv fixes beyond a static loader");
else if (eType !== 2) note("FAIL", `e_type is ${typeNames[eType] ?? eType}; a static loader expects ET_EXEC`);
if (phentsize !== 56) note("FAIL", `e_phentsize is ${phentsize}, expected 56 for ELF64`);
const tableEnd = phoff + BigInt(phnum) * BigInt(phentsize);
if (tableEnd > BigInt(buf.length)) note("FAIL", "program header table extends beyond the end of the file");

const ph = [];
if (phentsize === 56 && tableEnd <= BigInt(buf.length)) {
  for (let i = 0; i < phnum; i++) {
    const o = Number(phoff) + i * 56;
    ph.push({ i, type: dv.getUint32(o, true), flags: dv.getUint32(o + 4, true), offset: dv.getBigUint64(o + 8, true), vaddr: dv.getBigUint64(o + 16, true), filesz: dv.getBigUint64(o + 32, true), memsz: dv.getBigUint64(o + 40, true), align: dv.getBigUint64(o + 48, true) });
  }
}
const fl = (f) => `${f & 4 ? "R" : "-"}${f & 2 ? "W" : "-"}${f & 1 ? "X" : "-"}`;
console.log("program headers:");
console.log("  idx type             flags offset     vaddr      filesz     memsz      align");
for (const p of ph) console.log(`  ${String(p.i).padStart(3)} ${(ptNames[p.type] ?? hex(p.type)).padEnd(16)} ${fl(p.flags)}   ${hex(p.offset).padEnd(10)} ${hex(p.vaddr).padEnd(10)} ${hex(p.filesz).padEnd(10)} ${hex(p.memsz).padEnd(10)} ${hex(p.align)}`);

const loads = ph.filter((p) => p.type === 1);
if (!loads.length) note("FAIL", "no PT_LOAD segments");
const isPow2 = (a) => a > 0n && (a & (a - 1n)) === 0n;
for (const p of loads) {
  const tag = `PT_LOAD[${p.i}]`;
  if (p.filesz > p.memsz) note("FAIL", `${tag}: p_filesz > p_memsz`);
  if (p.offset + p.filesz > BigInt(buf.length)) note("FAIL", `${tag}: file range extends past the end of the file`);
  if (p.vaddr + p.memsz >= 1n << 64n) note("FAIL", `${tag}: p_vaddr + p_memsz overflows 64 bits`);
  else if (p.vaddr + p.memsz > memory) note("FAIL", `${tag}: ends at ${hex(p.vaddr + p.memsz)}, beyond the engine memory (${hex(memory)})`);
  if (p.align > 1n) {
    if (!isPow2(p.align)) note("FAIL", `${tag}: p_align ${p.align} is not a power of two`);
    else if (p.vaddr % p.align !== p.offset % p.align) note("FAIL", `${tag}: p_vaddr and p_offset are not congruent modulo p_align`);
  }
  if (p.flags & 1 && p.flags & 2) note("WARN", `${tag}: writable and executable (the engine has no page permissions, so W^X is not enforced)`);
}
const sorted = [...loads].sort((a, b) => (a.vaddr < b.vaddr ? -1 : 1));
for (let k = 1; k < sorted.length; k++) if (sorted[k].vaddr < sorted[k - 1].vaddr + sorted[k - 1].memsz) note("WARN", `PT_LOAD[${sorted[k - 1].i}] and PT_LOAD[${sorted[k].i}] overlap in memory`);
const entryOk = loads.some((p) => p.flags & 1 && entry >= p.vaddr && entry < p.vaddr + p.filesz);
if (!entryOk) note("FAIL", `entry ${hex(entry)} is not inside an executable PT_LOAD's file-backed range`);
if (ph.some((p) => p.type === 3)) note("FAIL", "PT_INTERP present: dynamically linked (needs the interpreter, auxv AT_BASE, relocations)");
if (ph.some((p) => p.type === 2)) note("WARN", "PT_DYNAMIC present: dynamic linking metadata (static-PIE also has one)");
if (ph.some((p) => p.type === 7)) note("WARN", "PT_TLS present: the C runtime sets up thread-local storage; needs arch_prctl(ARCH_SET_FS) at least");
const stack = ph.find((p) => p.type === 0x6474e551);
if (stack && stack.flags & 1) note("WARN", "PT_GNU_STACK requests an executable stack");
console.log("checks:");
if (!results.length) console.log("  all structural checks passed (static non-PIE x86-64 shape)");
for (const [l, m] of results) console.log(`  ${l}: ${m}`);
process.exit(results.some(([l]) => l === "FAIL") ? 1 : 0);
