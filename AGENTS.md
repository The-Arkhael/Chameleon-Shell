# Chameleon Shell: agent instructions

A client-side x86-64 Linux user-space environment: a Rust interpreter (iced-x86 decoder, our own
syscall layer, in-memory VFS later) compiled to WebAssembly, driven from a Vite/React + xterm.js page.
**Target: unmodified Debian (glibc) binaries, bash and coreutils, running fully in the browser tab.**
Not an Alpine/musl-only system; the musl fixtures are stepping stones. No backend server, ever.
Design reference is CheerpX's first tier (interpreter + Linux syscall emulation, no real kernel).
A JIT-to-Wasm tier is explicitly deferred until the interpreter runs real Debian programs.

Read `docs/STATUS.md` first (verified state, known gaps, roadmap), `docs/SPEC.md` for the original architecture.

## Layout
- `engine/`: Rust crate -> wasm (`src/lib.rs` exports, `exec_cpu.rs`/`exec_ops.rs` CPU+handlers, `elf.rs`, `self_test.rs`)
- `engine/src/generated.rs`, `engine/src/exec_generated.rs`: **generated, never hand-edit**
- `generator/generate.ts`: source of truth for instruction tables and the mnemonic->handler dispatch
- `engine/tests/fixtures/`: real ELF programs + native oracles (`*.stdout`, `*.exitcode`, `*.strace.txt`, `*.objdump.txt`,
  and measured on the real CPU: `*.steptrace.txt`, `*.initial_stack.txt`, `flags_oracle.txt`)
- `web/`: Vite + React + xterm.js demo page; loads `web/public/wasm/` (build output of the engine)

## Commands (repo root; all work in PowerShell, macOS and Linux)
- `pnpm install` once; `pnpm dev` runs the page on :5173
- `pnpm generate` regenerates the two generated Rust files
- `pnpm engine:check` = generator drift + `cargo fmt --check` + clippy (correctness, suspicious) + `cargo test`
- `pnpm engine:build` = the checks + `wasm-pack build --target web` + copy to `web/public/wasm/`
- `pnpm golden` = asserts the built wasm still reproduces every oracle result (run after `engine:build`)
- `pnpm typecheck`; `pnpm fixtures:regenerate` (x86-64 Linux only: it executes the ELF fixtures natively and needs ptrace)
Before declaring any engine change done: `pnpm engine:build` then `pnpm golden`, and paste both outputs.

## Hard rules
1. **Never edit generated files.** Change `generator/generate.ts`, run `pnpm generate`, commit both. The drift check enforces it.
2. **Measure before implementing.** Run the target binary, read the exact first failure (address, instruction, 16-instruction
   trace), implement only what that evidence demands. No speculative instruction sets.
3. **Known-answer tests for every behavior.** Build test programs with iced-x86 `CodeAssembler` (no hand-typed hex), assert
   exact values (registers, flags, memory), and include a negative check where a bug could hide (e.g. neighbor bytes untouched).
   Tests print actual values, not "PASS because it ran".
4. **Native oracles beat reasoning.** Expected stdout/exit code/syscall sequence come from running the real binary
   (`*.stdout`, `*.exitcode`, strace), flags/encodings from objdump/readelf, never from memory. The measured files
   (`*.steptrace.txt`, `*.initial_stack.txt`, `flags_oracle.txt`) are never edited to make a test pass: a disagreement means the
   engine is wrong until `pnpm fixtures:regenerate` shows otherwise.
5. **No panics on guest behavior.** Unsupported instruction/operand/syscall/register returns a structured error string with
   mnemonic, address and the last 16 executed instructions. A wasm panic is just `RuntimeError: unreachable`.
6. **Fixtures are authoritative.** Do not rebuild or overwrite committed fixture binaries; tests assert exact addresses in them.
   `regenerate.sh` only proves the recipes still work (by behavior, not bytes).
7. Keep simplifications explicit: anything modeled loosely (flags subset, placeholder brk, top-level `ret` as synthetic exit)
   has a comment and an entry in `docs/STATUS.md`.

## iced-x86 / Rust gotchas already paid for
- `Register::size()` and `full_register()` return **bytes** and need the `instr_info` feature.
- RIP-relative operands: use `ip_rel_memory_address()`; `memory_displacement64()` is already the resolved target. Never add `next_ip()` again.
- goblin with default features off needs `elf32`, `elf64`, `endian_fd`, `std` for the unified `Elf` parser.
- Debug guest panics with native `cargo test` (real message/backtrace), not in the browser.
- The real `syscall` instruction (mnemonic `Syscall`, dispatch through the real Linux ABI) is unrelated to the legacy
  single-byte fake SYSCALL opcode of the Milestone-1 toy CPU (`cpu.rs`, `generated.rs`). Keep the names distinct.

## Rust style scope (skills in `.agents/skills/rust-skills`)
Apply rule families `num-`, `err-`, `anti-`, `test-`, plus `lint-`. Skip `api-`, `async-`, `conc-`, `serde-`, `macro-`:
single-threaded engine crate, no public API, nothing serialized. Revisit `unsafe-`/`api-` only when the crate gains an
embedding API or raw-memory boundary. Do not add `Debug` to `ExecCpu` (16 MiB buffer); use `is_err()` in tests.

## Working from two places (read this before running or writing scripts)
The maintainer uses **Cursor on a Windows laptop (PowerShell, no WSL)** and **Cursor web/mobile cloud agents** (Linux VM,
GitHub branches and pull requests). So:
- Keep every dev script cross-platform (Node `.mjs`, no bash, no `&&`-only PowerShell-hostile one-liners in docs).
  The only Linux-only script is `fixtures:regenerate`; it runs in the cloud agent and in CI.
- Shell scripts and generated files must stay LF (`.gitattributes` enforces it).
- Fixtures are x86-64 Linux ELF: never try to execute them on Windows; the engine tests do not need to.

## Cloud agent / PR conventions
- Environment: `.cursor/environment.json` + `.cursor/Dockerfile` (Node 22, pnpm, Rust 1.86.0 + wasm32, wasm-pack, gcc,
  musl-gcc, strace). If a tool is missing, say so; never report a gate as passed that you did not run.
- Work on a branch and open a PR; never push to `main`. One milestone slice per PR.
- PR description: first 5 lines are a plain summary readable on a phone, then the six-part report below. CI (`.github/workflows/ci.yml`)
  must be green; it repeats `engine:build`, `golden` and `fixtures:regenerate`.
- Merge conflicts in `generated.rs` / `exec_generated.rs`: take either side, then run `pnpm generate`. Do not hand-merge them.
- Do not commit `web/public/wasm/`, `engine/target/`, `node_modules/` or `dist/`.

## Reporting format when a task finishes
1) what was done per step; 2) every new test/terminal line verbatim; 3) confirmation prior outputs are unchanged;
4) compiler/clippy warnings; 5) deviations and why; 6) out-of-scope findings worth flagging before acting on them.
