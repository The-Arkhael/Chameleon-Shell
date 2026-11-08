---
name: differential-emulation-testing
description: >-
  Use when planning, writing, running, reviewing or debugging tests that decide
  whether Chameleon-Shell's emulator is correct: choosing expected-value
  evidence (native ptrace step traces, initial-stack dumps, flags_oracle rows,
  strace sequences, fixture stdout and exit codes, specification-derived known
  answers), building minimal reproducers, finding the first divergence between
  engine and reference, adding encoder-built known-answer tests, golden and
  wasm-level checks, malformed-input tests, onboarding a new fixture or oracle,
  and judging whether a change is adequately tested. Treats oracle output as
  evidence with stated assumptions. Not a generic unit-testing guide and not
  for performance measurement.
---

# differential-emulation-testing

A standing procedure for evidence-driven correctness through the whole workflow: choose the evidence, reproduce, compare, find the **first** divergence, fix the cause, keep a regression test, and keep the oracles themselves healthy. Evidence tags: `[spec]`, `[observed]` (measured on this repo's artifacts), `[project]`, `[hypothesis]`. Counts, trace lengths and fixture lists are deliberately not stated here: derive them from `engine/tests/fixtures/` and `scripts/golden.mjs`.

## Consult this skill when

- **Planning**: deciding how a change will be proven (which evidence, which test layer) before writing it.
- **Implementing**: writing the reproducer, the known-answer test, the oracle extension, or a new fixture.
- **Debugging**: any engine-versus-reference mismatch, a golden failure, a CI `fixtures:regenerate` failure, or "works natively, fails in wasm".
- **Reviewing**: judging whether a diff's tests prove its claims (including other skills' changes: new instruction, loader rule, optimization).
- **Maintaining**: adding a fixture, regenerating oracle files, changing `golden.mjs`.

## Standing invariants

1. Expected values come from evidence outside the engine: a specification rule, a native oracle, or a committed measured file. Never from the engine's own output.
2. Measured files (`*.steptrace.txt`, `*.initial_stack.txt`, `*.strace.txt`, `flags_oracle.txt`, committed fixture binaries) are never edited or rebuilt to make a test pass: a disagreement means the engine is wrong until a regeneration proves otherwise (AGENTS.md rule 6).
3. Only defined outputs are compared. Undefined flag cells, timestamps, randomness, thread ids and ASLR addresses are not.
4. A meaningful semantic fix is not done until a test fails without it. A green `cargo test` alone is not proof for the wasm path: run `pnpm engine:build` and `pnpm golden`.
5. Separate **executed** from **recommended**: report each check with its command and real result; anything not run is "not run".

## Workflow

### 1. Orient

List what evidence exists for the area: `engine/tests/fixtures/` (fixtures and their oracle files), `scripts/golden.mjs` (what the wasm is checked against), `engine/src/self_test.rs` (known-answer tests), `docs/STATUS.md` (measured gaps). Check which tools you actually have: Rust toolchain, `gcc`, `musl-gcc`, `strace`, ptrace permission, Linux versus Windows (native oracles cannot run on the maintainer's Windows laptop; cloud agents and CI can).

### 2. Choose the evidence

| Question | Evidence | Notes |
| --- | --- | --- |
| Flag results of an instruction | native `flags_oracle` rows (extend `flags_oracle.c`) | Compare only defined cells; `-` is undefined |
| Which instructions run, in what order | `nativetrace --custom` step trace | `rep` iterations fold into one step |
| Initial stack and auxv | `nativetrace --custom --stack` | Reference for what the engine must build |
| Syscall sequence, stdout, exit code | `strace -f`, `*.stdout`, `*.exitcode` | Compare exact stdout bytes |
| Pure data movement, encodings | specification plus a known-answer test | No native run needed |
| Faults (#DE, #GP, #PF) | specification | The engine returns `Err` by design |
| Time, randomness, `cpuid`, `rdtsc`, ASLR | invariants only | Never raw values |

Native execution is not required for every test; a deterministic case with a cited `[spec]` rule is enough.

### 3. Reproduce, run both sides, compare

Reduce to the smallest program that still fails (a `CodeAssembler` snippet, or a fixture plus the failing address). Run the engine side (`run_exec_program` in a test, or the built wasm through `pnpm golden`) and the reference side (committed oracle file, or a fresh native run: `references/oracle-workflows.md`). Compare at instruction boundaries: modeled registers and flag bits (CF/ZF/SF/OF), owned memory, the executed-address sequence, and guest-visible output.

### 4. Find the first divergence

`node .cursor/skills/differential-emulation-testing/scripts/steptrace-context.mjs <hex-address>` locates an address in a native step trace with disassembly; `... --engine-output failure.txt` (or `-` for stdin) aligns the engine's last-16-instruction trace with the native trace and prints the first mismatch, or confirms the path matches and the failure is a missing behavior. `--fixture <name>` selects another fixture's trace. Stop at the first mismatch, not the last symptom.

### 5. Fix, then preserve

Fix through the domain skill (`x86-64-isa`, `elf-linux-abi`, `chameleon-rust`). Preserve it: snippet cases in `engine/src/self_test.rs` (registered in `run_self_test()`); fixture-level cases in `scripts/golden.mjs`; flag semantics as new `flags_oracle` rows plus engine assertions. When the fix is about rejecting input, add a malformed-input case that asserts `is_err()` and that the message names the cause (a rejection must never become a panic; `browser-sandbox-security` has a probe suite).

### 6. Review mode

Judge tests, not just code. A **test defect** is: expectation derived from the engine; an undefined cell asserted; a happy path only; no negative or boundary case; a test not registered so it never runs; a fixture or oracle file edited; a claim of "tested" with no command run. Gather evidence by running the tests, then mutating the fix mentally or actually (does the test fail without it?). Say what evidence class backs each claim.

### 7. Record

New fixture or oracle: add the recipe next to the others (`engine/tests/fixtures/regenerate.sh`), commit the measured files, extend `scripts/golden.mjs`, note it in `docs/STATUS.md`. Changed assumptions: update `references/oracle-workflows.md` in the same change.

## Oracle assumptions to state whenever you use one

Host is Linux x86-64 with ptrace allowed. The oracle describes one committed binary built one way; recompiled bytes differ, and tests assert exact addresses. `--custom` reproduces the environment the engine can build, `--kernel` shows what the real kernel does. Host-CPU differences affect only undefined flag bits and feature probes. The assembler may choose encodings other than a compiler: assert architectural results in snippets, addresses only against committed fixtures. Check `references/oracle-workflows.md` for what is and is not wired up today (for example whether anything feeds oracle rows or per-step register traces through the engine) instead of assuming.

## Related skills (each stands alone)

`x86-64-isa`, `elf-linux-abi`, `typescript-codegen` (when a fix adds a mnemonic), `emulator-performance` (use this skill as its correctness gate; never for timing claims), `browser-sandbox-security` (malformed-input probes), `chameleon-rust` (test layout and gates).

## References and scripts

- `references/oracle-workflows.md`: how each oracle is produced, file formats, exact build/run commands, comparison recipes, pitfalls.
- `scripts/steptrace-context.mjs`: read-only helper for addresses and first divergences in a step trace.

## Sources

- Linux `ptrace(2)`: <https://man7.org/linux/man-pages/man2/ptrace.2.html>
- Linux `strace(1)`: <https://man7.org/linux/man-pages/man1/strace.1.html>
- Intel SDM Vol. 2 (instruction pages define undefined flags): <https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html>
