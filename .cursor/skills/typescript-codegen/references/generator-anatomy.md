# Generator anatomy, procedures and validation gaps

Evidence tags: `[observed]` read or run in this repo, `[project]` repo decision, `[hypothesis]` unverified. Derive current counts and tables with `scripts/audit-mappings.mjs`; do not copy them here.

## How generation works `[observed]`

- `generator/generate.ts` holds two hardcoded tables and writes two Rust files:
  - the **semantic table** (`SEMANTIC_INSTRUCTIONS`: `mnemonic`, `handler`, `description`, optional `jumpCondition`) produces `engine/src/exec_generated.rs`: a header comment per mnemonic (taken from `description`), the `IMPLEMENTED_MNEMONICS` constant, an `is_implemented` helper and the `match instr.mnemonic()` dispatch;
  - the **legacy table** (`INSTRUCTIONS`, the Milestone-1 fake ISA) produces `engine/src/generated.rs`, which `cpu.rs` and the exported `run` use. It is legacy: do not extend it.
- `handler` is the name of a hand-written `pub fn` in `engine/src/exec_ops.rs`, or the special value `Jump`, whose arm is generated from `jumpCondition` (a Rust boolean expression over `cpu.flags.*` pasted verbatim), or `Halt`. A `description` edit changes generated comments, so it changes the generated diff.
- Output paths default to the repository's `engine/src/`; the environment variable `GENERATOR_OUTPUT_ROOT` redirects both files under another root (used by the drift check). `main()` runs unconditionally when the module is loaded, so **importing `generate.ts` writes files**: tooling must run it as a process, or parse the text (as `audit-mappings.mjs` does).
- Commands: `pnpm generate` (`tsx generator/generate.ts`) regenerates both files in place; `pnpm engine:check` regenerates into a temporary root and compares with the committed files after normalizing CRLF to LF (drift check); `pnpm typecheck` includes `tsc -p generator/tsconfig.json --noEmit`. `.gitattributes` forces LF and marks both files `linguist-generated`; `engine/src/lib.rs` marks their module declarations `#[rustfmt::skip]` so `cargo fmt` does not rewrite them.
- Generation is deterministic and idempotent: two runs into separate roots were byte-identical during the audit `[observed]`; output order is table order, with no timestamps.

## Procedures

**A. Add, rename or remove a mnemonic**

1. Edit the table in `generator/generate.ts` (mnemonic must be an exact `iced_x86::Mnemonic` variant name; keep the description factual and short). Add the handler in `exec_ops.rs` (semantics: `x86-64-isa`).
2. `pnpm generate`, then inspect the diff of both generated files: expect exactly one new header comment line, one `IMPLEMENTED_MNEMONICS` entry and one match arm per new mnemonic (and nothing else).
3. Run `node .cursor/skills/typescript-codegen/scripts/audit-mappings.mjs`, `pnpm engine:check`, then the known-answer test, `pnpm engine:build`, `pnpm golden`.
4. Update `docs/STATUS.md` (implemented list) and fix any count the audit flags.

**B. Change the generated output shape** (new artifact, new helper, new comment format): decide it is needed first; change the emitter, regenerate, review the *whole* diff of every generated file, confirm the drift check passes from a clean temp root, confirm `cargo fmt --check` and clippy are unaffected, and keep idempotency (run twice, compare). Do not introduce timestamps, absolute paths, or unordered iteration.

**C. `pnpm engine:check` reports drift**: someone edited a generated file or forgot to regenerate. Do not patch the Rust: run `pnpm generate`, look at `git diff` of the generated files, and if the diff is not what the table implies, find the stale edit.

**D. Merge conflict in a generated file**: resolve the *table* conflict in `generate.ts` first, take either side of the generated file, then `pnpm generate` and verify the result (AGENTS.md).

**E. New jump condition**: it can only use what the flag model contains. Expressions over unmodeled flags (PF) will not mean what the instruction means; extend the model first (architectural change, `x86-64-isa`).

## Validation gaps (what the generator does not check) `[observed]`

The generator emits text without validating it; the Rust build is the only validator. Consequences, and what to do:

- A mnemonic that is not an `iced_x86::Mnemonic` variant, a missing handler, or an invalid jump expression fails the Rust build: caught by `pnpm engine:check`.
- A **duplicate mnemonic** produces an unreachable match arm: rustc warns, but the gates deny only clippy correctness and suspicious lints, so the first arm silently wins. `audit-mappings.mjs` reports duplicates as errors.
- A `description` that disagrees with the handler, or docs that disagree with the table (for example the implemented-count line in `docs/STATUS.md`), is caught only by the audit script's warnings.
- `Halt` is accepted but unused; do not rely on it without a test.

Do not add a new validation layer to the generator unless a concrete failure justifies it; prefer improving `audit-mappings.mjs` or the drift check.
