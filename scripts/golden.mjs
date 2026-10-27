#!/usr/bin/env node
// Golden regression check against the BUILT wasm in web/public/wasm.
// Run after `pnpm engine:build`:  pnpm golden
// Every expected value below comes from a native oracle (see engine/tests/fixtures/*.stdout, *.exitcode)
// or from the closed-form math (sum of squares 1..100 = 338350). Exits non-zero on any mismatch.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmDir = join(root, "web", "public", "wasm");
const engine = await import(pathToFileURL(join(wasmDir, "chameleon_engine.js")).href);
engine.initSync({ module: readFileSync(join(wasmDir, "chameleon_engine_bg.wasm")) });

let failures = 0;
function expect(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
}

const lines = engine.self_test().split("\n").filter(Boolean);
const passes = lines.filter((l) => l.startsWith("PASS")).length;
const fails = lines.filter((l) => l.startsWith("FAIL"));
expect(`self_test: no FAIL lines, at least 19 PASS lines (got ${passes})`, fails.length === 0 && passes >= 19, fails.join(" | "));

expect("loop program ends with ECX = 5", engine.loop_test().includes("ECX = 5"), engine.loop_test());
expect(
  "execute(mov eax,1; add eax,eax; ret) gives EAX = 2",
  engine.execute(new Uint8Array([0xb8, 1, 0, 0, 0, 1, 0xc0, 0xc3])) === "EAX = 2",
);

const hello = engine.run_elf(engine.embedded_elf());
expect('elf_write_exit: stdout "hello\\n"', hello.includes('Captured stdout: "hello\\n"'), hello.split("\n").slice(-3).join(" | "));
expect("elf_write_exit: exit code 37", hello.includes("Exit code: 37"));

const squares = engine.run_elf(engine.embedded_sum_squares());
expect('sum_squares: stdout "sum=338350\\n"', squares.includes('Captured stdout: "sum=338350\\n"'), squares.split("\n").slice(-3).join(" | "));
expect("sum_squares: exit code 0", squares.includes("Exit code: 0"));

const coverage = engine.coverage_report(engine.embedded_sum_squares());
for (const needle of ["Instruction count: 70", "Undecodable bytes: 0", "Objdump address comparison: MATCH (70 instruction starts)"]) {
  expect(`sum_squares coverage: ${needle}`, coverage.includes(needle));
}

// Informational only: the next milestone. Not asserted, so progress here never breaks the gate.
const libc = new Uint8Array(readFileSync(join(root, "engine", "tests", "fixtures", "libc_startup")));
let libcStatus;
try {
  libcStatus = engine.run_elf(libc).split("\n").filter(Boolean).slice(-2).join(" | ");
} catch (error) {
  libcStatus = `TRAP (wasm panic): ${error}`;
}
console.log(`INFO  libc_startup (milestone 2b, expected to fail until initial stack lands): ${libcStatus}`);

console.log(failures === 0 ? "\nGOLDEN OK" : `\nGOLDEN FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
