---
name: typescript-codegen
description: >-
  Use when planning, changing, reviewing or debugging Chameleon-Shell's code
  generator (generator/generate.ts) or any generated Rust file
  (engine/src/generated.rs, engine/src/exec_generated.rs): adding, renaming or
  removing table entries, adding a new generated artifact or output shape,
  jump-condition vocabulary, determinism and idempotency, formatting stability,
  generator-drift failures from pnpm engine:check, merge conflicts in generated
  files, and reviewing generated diffs. Enforces change-the-source then
  regenerate, and includes a read-only mapping audit. Not for writing
  instruction semantics (x86-64-isa) or for React/web TypeScript.
---

# typescript-codegen

A standing procedure that keeps the generator authoritative and the generated Rust reproducible, whatever table or artifact comes next. Evidence tags: `[observed]` read or run here, `[project]`, `[hypothesis]`. The current table, counts and mappings are derived by `scripts/audit-mappings.mjs`; `references/generator-anatomy.md` explains the mechanism, procedures and validation gaps.

**The rule:** change the authoritative source, regenerate derived output with the repository's workflow, review the generated diff, then validate. Never edit generated output by hand.

## Consult this skill when

- **Planning**: any change that adds a mnemonic, a new generated artifact, a new field in the table, or a new output format; deciding whether something belongs in the generator or in hand-written code.
- **Implementing**: any edit to `generator/generate.ts`, or any task that makes you want to touch `engine/src/generated.rs` or `engine/src/exec_generated.rs`.
- **Debugging**: `pnpm engine:check` reporting drift, rustc errors that point into generated files, a generated diff that looks wrong, a merge conflict in generated files, CRLF or formatting churn.
- **Reviewing**: any PR containing generated changes (are they exactly what the source implies?) or generator changes (is output still deterministic?).

## Standing invariants

1. **Source of truth**: `generator/generate.ts` (its tables) plus the hand-written handlers in `engine/src/exec_ops.rs` that the table names. Generated files carry an "AUTO-GENERATED, DO NOT EDIT" header, are marked `linguist-generated`, and their module declarations are `#[rustfmt::skip]` `[observed]`.
2. **Deterministic and idempotent output**: same input, same bytes; order is table order; no timestamps, absolute paths, or unordered iteration.
3. **Generated diffs are reviewed**, not just committed: every line must be explained by the source change.
4. **The generator stays as it is** unless the task needs a different generator: no architecture changes, new data formats, or new runtime dependencies without a concrete reason.
5. **Mapping validity is checked by tools, not hoped for**: the Rust build catches unknown mnemonics, missing handlers and bad expressions; duplicates and doc drift are caught only by the audit script (see validation gaps in the reference).
6. **Importing `generate.ts` runs it** (`main()` executes at load): never import it from other tooling; run it as a process or parse its text.

## Workflow

### 1. Orient

- `node .cursor/skills/typescript-codegen/scripts/audit-mappings.mjs`: table size, duplicates, missing handlers, jump-condition vocabulary, generated-constant agreement, and doc cross-checks. Exit 1 means a real inconsistency; warnings are findings to report.
- Read the part of `generator/generate.ts` you will change and the matching generated section. Confirm commands with `package.json`: `pnpm generate`, `pnpm engine:check`, `pnpm typecheck`.

### 2. Plan

Name the source change, the generated files that will change, and what the diff should look like (for one new mnemonic: one header comment line, one `IMPLEMENTED_MNEMONICS` entry, one match arm). Decide the tests that will prove it (known-answer test via `x86-64-isa`, the drift check, the audit).

### 3. Implement: modify source, regenerate, inspect

1. Edit the table or emitter in `generator/generate.ts`.
2. `pnpm generate`.
3. Inspect `git diff -- engine/src/generated.rs engine/src/exec_generated.rs` against the plan; investigate every unexpected hunk before moving on.
4. Run it twice and confirm the second run changes nothing (idempotency).

### 4. Verify: validate, then regression tests

`node .cursor/skills/typescript-codegen/scripts/audit-mappings.mjs`, `pnpm typecheck`, `pnpm engine:check` (includes the drift check, fmt, clippy, cargo test), then `pnpm engine:build` and `pnpm golden`. A generator change is only proven by the drift check passing from a clean state *and* the engine tests passing against the regenerated code. Report which of these ran; the Rust gates need a toolchain that may not be installed.

### 5. Review mode

A **defect** is: a hand-edited generated file; a generated diff not explained by the source diff; non-deterministic or order-unstable output; a duplicated mnemonic; a handler named in the table but missing or unused; a jump condition over unmodeled flags; docs or counts left stale; a generator refactor bundled with a table change; missing regression test for new behavior. Evidence: the diff, the audit output, a clean double generation; label confirmed / likely / question.

### 6. Record

Update `docs/STATUS.md` (implemented list and counts). If the generator's behavior or commands changed, update `AGENTS.md` and `references/generator-anatomy.md` in the same change.

## Related skills (each stands alone)

`x86-64-isa` (what the handler must do), `chameleon-rust` (the Rust side and gates), `differential-emulation-testing` (regression evidence), `elf-linux-abi` (if the table grows syscall metadata).

## References and scripts

- `references/generator-anatomy.md`: mechanism, procedures A-E (add mnemonic, change output shape, drift, merge conflict, new jump condition), validation gaps.
- `scripts/audit-mappings.mjs`: read-only audit of table, handlers, generated constant and docs.

## Sources

- tsx (TypeScript runner used by `pnpm generate`): <https://tsx.is/>
- TypeScript compiler options (`tsc --noEmit`): <https://www.typescriptlang.org/tsconfig/>
- Package manager documentation (scripts, workspaces): <https://pnpm.io/>
- rustfmt `#[rustfmt::skip]`: <https://github.com/rust-lang/rustfmt#tips>
- Repo conventions: `AGENTS.md` (generated files), `.gitattributes`, `scripts/engine.mjs` (drift check).
