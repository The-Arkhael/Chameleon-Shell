---
name: chameleon-rust
description: >-
  Use when planning, implementing, reviewing, debugging or testing any Rust
  change in Chameleon-Shell's engine crate (engine/src/*.rs, engine/Cargo.toml,
  engine/rust-toolchain.toml): CPU and memory state, instruction handlers, the
  ELF loader, syscalls, wasm-bindgen exports, self-tests, rustfmt/clippy gates,
  dependency or feature changes. Encodes the pinned toolchain and CI parity, the
  Result<_, String> guest-error convention, the no-panic-on-guest-input rule
  (with a panic-site scanner), state invariants, generated-file limits and the
  real pnpm engine:* commands. Layers on .agents/skills/rust-skills without
  repeating it. Not for TypeScript or web work, and not for deciding x86 semantics.
---

# chameleon-rust

A standing procedure for every Rust change under `engine/`, from first plan to final report. The generic Rust handbook is `.agents/skills/rust-skills/`; this skill adds only what is particular to this repository. Evidence tags: `[project]` repo decision, `[observed]` read or run in the checkout, `[hypothesis]` unverified. Facts that go stale live in `references/` under a `SNAPSHOT` banner with a refresh command; this file contains only things that stay true.

## Consult this skill when

- **Planning**: scoping a change in `engine/`, deciding where code belongs, choosing which gates apply.
- **Implementing**: before the first edit, and again whenever a gate fails or you touch a new file.
- **Reviewing**: any Rust diff, yours or someone else's (use "Review mode").
- **Debugging**: a panic, `RuntimeError: unreachable`, a clippy or rustfmt failure, a test that passes natively but fails in wasm.
- **Maintaining**: dependency, feature, toolchain or CI-parity questions; where a test should live.

## Standing invariants (true before and after every change)

1. **Toolchain is a constraint.** `engine/rust-toolchain.toml` pins the compiler; `engine/Cargo.toml` fixes edition and dependencies; CI and `.cursor/Dockerfile` mirror them. Do not change them as a side effect, use only APIs available in the pinned version (check the "Stable since" tag; the rust-skills handbook targets newer Rust and the 2024 edition), and report a mismatch between the three places instead of silently editing one. `[project]`
2. **Guest-derived failure is `Err(String)`, never a panic.** Anything the guest program or an ELF file controls (opcode form, operand kind, width, address, syscall number, argument, header field) returns an error naming mnemonic or field, address and reason. `expect("<invariant>")` is only for facts the code itself guarantees. On wasm32 a panic aborts as `RuntimeError: unreachable` with no message. `[project]`
3. **Error text is an interface.** `lib.rs`, tests, `scripts/golden.mjs` and `web/src/App.tsx` match prefixes and blocks (for example `unsupported syscall:`, `unimplemented instruction:`, the `Execution trace (last 16 instructions):` block, the export prefixes `Execution error:`, `ELF execution error:`, `ELF parse error:`). Change wording only together with every dependent.
4. **State invariants.** Registers are private: use `get_register`/`set_register` (32-bit writes zero-extend; 8/16-bit preserve). Guest memory only through `read_memory`/`write_memory` (bounds-checked, flat). Flags are a four-bool subset; widening the model is an architectural change. Never derive `Debug` for `ExecCpu` (large buffer): assert with `is_err()`. `[project]`
5. **Generated files are never edited.** `engine/src/generated.rs` and `engine/src/exec_generated.rs` come from `generator/generate.ts`: change the source, run `pnpm generate` (see `typescript-codegen`).
6. **Dependencies, `unsafe`, threads, async need a measured or architectural justification.** The crate had none of the latter when audited `[observed]`; binary size matters.
7. **Tests live where they can run.** The crate is cdylib-only, so tests are `#[cfg(test)]` unit tests inside `src/`; `engine/tests/` holds fixtures `[observed]`. Do not plan `engine/tests/*.rs` integration tests that import the crate without proving they link `[hypothesis]`. A known-answer test must be a function in `engine/src/self_test.rs` **and** be called from `run_self_test()`, otherwise it never runs; `scripts/golden.mjs` enforces a minimum PASS count.
8. **`usize` differs by target.** Native `cargo test` is 64-bit; the shipped wasm is 32-bit. Boundary and address-conversion code must also be exercised through the built wasm.

## Workflow

### 1. Orient (derive current state, never trust a snapshot)

- Read `AGENTS.md` (hard rules, report format) and the part of `docs/STATUS.md` relevant to the task (implemented, measured gaps, known simplifications).
- Check tools: `cargo --version`, `wasm-pack --version`. A gate you cannot run is reported "not run", never passed.
- Locate code by role: `lib.rs` (wasm exports, run loop, error wrapping), `exec_cpu.rs` (state), `exec_ops.rs` (handlers, helpers, syscall dispatch), `elf.rs` (parse and load), `self_test.rs` (known-answer tests), `cpu.rs` and `generated.rs` (legacy toy ISA, do not extend).
- Before touching core files, take a baseline: `node .cursor/skills/chameleon-rust/scripts/panic-sites.mjs --json` saved to a temp file.

### 2. Plan

State the smallest change the evidence demands (AGENTS.md rule 2: measure before implementing), where it lives, which test proves it, and which gates apply. If it needs new state, a new dependency, or a wider flag model, say so and ask before building.

### 3. Implement

Reuse the existing helpers instead of re-deriving widths or masks. Keep modeling shortcuts explicit with a short comment and a `docs/STATUS.md` entry. Do not "fix" unrelated findings in the same change: list them in the report (AGENTS.md report item 6).

### 4. Verify (from the repository root; one command per line)

- `pnpm engine:test` for the quick loop; inside `engine/`, `cargo test <name> -- --nocapture` shows assertion output.
- `pnpm engine:check` before finishing: generator drift, `cargo fmt --all -- --check`, clippy with `-D clippy::correctness -D clippy::suspicious` on all targets, then `cargo test`.
- `pnpm engine:build` and then `pnpm golden` whenever Rust changed: this is the path the browser runs. Paste both outputs.
- `node .cursor/skills/chameleon-rust/scripts/panic-sites.mjs --compare <before.json>`: must report no new non-test site.
- Reading failures: fmt means run `cargo fmt --all` in `engine/` and confirm the diff touches only your files; clippy failures are fixed in code, not silenced; a failing self-test prints `FAIL: <name>` with actual values; a golden failure names the stage.

### 5. Review mode (for any Rust diff)

A **defect** is: a new panic or unchecked index/conversion on guest-derived data; behavior changed without a test that fails beforehand; error text changed without its dependents; an API newer than the pinned toolchain; a new dependency, feature, `unsafe`, or `#[allow]` without justification; a hand edit of a generated file; a change to a limit or memory size without a security and performance note; docs left stale. Gather evidence by running the gates and the scanner, quote the file and line, and label each finding **confirmed** (reproduced), **likely** (code reading), or **question** (needs the author). Do not report a gate as passed unless it ran.

### 6. Record

Update `docs/STATUS.md` when behavior, limits or known simplifications change; update `AGENTS.md` only when a rule changes; refresh or delete any `SNAPSHOT` line in `references/` that your change falsified. Report in the six-part `AGENTS.md` format, listing every command with its real result and every gate not run.

## Using rust-skills

Per `AGENTS.md`, apply the `num-`, `err-`, `anti-`, `test-`, `lint-` rule families in `../../../.agents/skills/rust-skills/rules/` and skip `api-`, `async-`, `conc-`, `serde-`, `macro-`. Where the handbook conflicts with this repo, the repo wins: `err-thiserror-lib.md` and `err-anyhow-app.md` do not apply (convention is `Result<_, String>`, no such dependencies) and `test-integration-dir.md` does not apply (cdylib). Useful rules: [num-cast-try-from](../../../.agents/skills/rust-skills/rules/num-cast-try-from.md), [num-overflow-explicit](../../../.agents/skills/rust-skills/rules/num-overflow-explicit.md), [err-expect-bugs-only](../../../.agents/skills/rust-skills/rules/err-expect-bugs-only.md), [anti-panic-expected](../../../.agents/skills/rust-skills/rules/anti-panic-expected.md), [test-cfg-test-module](../../../.agents/skills/rust-skills/rules/test-cfg-test-module.md). Do not modify or relocate rust-skills; do not run its `checks/` project as part of engine work.

## Related skills (each stands alone)

`x86-64-isa` (semantics), `typescript-codegen` (generator), `elf-linux-abi` (loader, syscalls), `wasm-runtime-boundary` (exports, wasm build), `browser-sandbox-security` (untrusted input, limits), `emulator-performance` (throughput), `differential-emulation-testing` (evidence and regression tests).

## References and scripts

- `references/project-rust-conventions.md`: stable conventions plus a dated SNAPSHOT of toolchain, dependency and test-layout facts with refresh commands.
- `scripts/panic-sites.mjs`: lists panic-capable constructs in non-test code, saves JSON, and compares before/after.
