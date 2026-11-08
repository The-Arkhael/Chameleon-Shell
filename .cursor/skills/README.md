# Chameleon-Shell skills for Cursor

Eight project skills that Cursor's Agent discovers from `.cursor/skills/<name>/SKILL.md` and applies automatically from each skill's `description`, or manually by typing `/<skill-name>` in Agent chat (format confirmed against <https://cursor.com/docs/skills> and <https://cursor.com/help/customization/skills>; the skills use only `name` and `description` frontmatter). They sit next to the always-on, glob-scoped rules in `.cursor/rules/*.mdc` (short hard constraints) and the generic Rust handbook in `.agents/skills/rust-skills/` (not duplicated here).

## What they are: standing procedures, not issue fixes

Every skill is written to stay useful for the whole life of the project: it names the situations that call for it across **planning, implementing, debugging, reviewing, testing and maintaining**, states invariants that stay true, and gives the same lifecycle each time: **Orient, Plan, Implement, Verify, Review, Record**. Anything that changes as the engine evolves (which mnemonics exist, which syscalls, which probes fail, benchmark numbers) is **not** written into the procedure. It is derived at use time by a script, or kept in a dated `SNAPSHOT` section of a reference file that says how to refresh it.

| Skill | Use it when | Derives current state with |
| --- | --- | --- |
| `chameleon-rust` | any Rust change in `engine/` | `scripts/panic-sites.mjs` |
| `x86-64-isa` | any instruction semantics work or review | `scripts/isa-inventory.mjs` |
| `differential-emulation-testing` | deciding or reviewing how something is proven; engine-versus-reference mismatches | `scripts/steptrace-context.mjs` |
| `elf-linux-abi` | ELF loading, process startup, syscalls, libc startup, milestone scoping | `scripts/elf-inspect.mjs`, `scripts/syscall-inventory.mjs` |
| `wasm-runtime-boundary` | exports, wasm build, loader, CSP/Worker/isolation questions | `scripts/boundary-check.mjs` |
| `typescript-codegen` | the generator or any generated file | `scripts/audit-mappings.mjs` |
| `browser-sandbox-security` | untrusted input, limits, capabilities, supply chain | `scripts/probe-malformed.mjs` |
| `emulator-performance` | any speed, memory or size work, and any performance claim | `scripts/bench-wasm.mjs` |

## Which skills for which task

| Task | Skills |
| --- | --- |
| New or corrected x86 instruction | `x86-64-isa`, `differential-emulation-testing` (+ `typescript-codegen` for the table, `chameleon-rust` for the handler) |
| ELF loading or process startup | `elf-linux-abi`, `differential-emulation-testing` (+ `browser-sandbox-security` for validation) |
| Rust implementation change | `chameleon-rust` plus the relevant domain skill |
| Rust/Wasm boundary change | `wasm-runtime-boundary` (+ `browser-sandbox-security` when imports, input or policy change) |
| Generator or metadata change | `typescript-codegen` (+ `x86-64-isa`, `differential-emulation-testing`) |
| Interpreter optimization | `emulator-performance`, `differential-emulation-testing` |
| Malicious guest input or memory safety | `browser-sandbox-security` (+ `x86-64-isa` or `elf-linux-abi`) |
| Reviewing someone's diff | the domain skill's "Review mode", plus `differential-emulation-testing` for test adequacy |

Skills do not depend on each other: each carries its own core instructions and only points to the others.

## Activation checks (to run in Cursor; not yet run)

Paste each prompt into Agent chat in a fresh conversation and check that the named skill is selected (or invoke it with `/<skill-name>`) and that the "expected evidence" appears. A skill that fires on the "should not" prompt needs a narrower description.

| Skill | Should activate | Hard edge case (must be handled) | Should not activate | Expected evidence of usefulness |
| --- | --- | --- | --- | --- |
| `chameleon-rust` | "clippy fails in exec_ops.rs" | cargo test passes but `pnpm golden` fails in wasm (32-bit `usize`) | "restyle the terminal panel" | gates run versus not run are listed; no new panic site |
| `x86-64-isa` | "implement `or r/m, imm` with correct flags" | a trace stops at an indirect `call` or `jmp` | "why is the Vite dev server slow" | six-point contract filled; assembler-built tests; oracle rows for new flag semantics |
| `differential-emulation-testing` | "engine disagrees with the native trace at step 5" | a flag differs only in an undefined cell (not a defect) | "rename a struct field" | first divergence located; regression test registered |
| `elf-linux-abi` | "build the initial stack so musl startup gets past argc" | "make `ls` work" (must scope to the measured slice, not VFS/PIE/dynamic) | "implement `shl`" | `elf-inspect` and `syscall-inventory` output; oracle comparison |
| `wasm-runtime-boundary` | "add an export that takes two byte arrays" | "set `script-src 'self'`" (must list the blob import, wasm compile, xterm styles, fonts, dev client) | "fix a wrong carry flag" | `boundary-check` output; browser verification stated or declined |
| `typescript-codegen` | "add `Or` to the generator" | `engine:check` reports drift after a merge (regenerate, do not patch Rust) | "speed up the run loop" | audit output; generated diff reviewed; double generation |
| `browser-sandbox-security` | "let users upload their own ELF" | "raise the step limit to 10 million" (needs cancellation design and a probe) | "add `rol` flags" | threat entries filled; probe suite run; tests proposed |
| `emulator-performance` | "make the interpreter faster" | a PR claims 30% faster from one timing | "fix the missing `ret imm16` handling" | baseline, comparison, gates; unmeasured claim rejected |

## Evidence tags used in the skills

`[spec]` architecture or ABI specification, `[doc]` vendor/project documentation, `[observed]` measured or read in this repository, `[project]` a design decision of this repository, `[hypothesis]` unverified: check before relying.

## The scripts

All are dependency-free Node (22+) `.mjs` files that run on Windows, macOS and Linux and never modify the repository. Scripts that exercise the wasm need the artifacts from `pnpm engine:build` (`web/public/wasm/`); the others read source files only. They exist because a snapshot in prose goes stale and a script does not.

## Maintaining the skills

- When a change makes a `SNAPSHOT` line false, update or delete that line in the same change. Run the relevant script to refresh; an outdated fact is worse than none.
- When a command, script or path named in a skill changes, update the skill. `node .cursor/skills/check-skills.mjs` verifies frontmatter, name-equals-folder, description length, relative links, mentioned files, that every `pnpm <script>` named exists in `package.json`, and that referenced `node`/`tsx` paths exist, plus basic whitespace hygiene. It does not check external URLs and cannot prove that Cursor discovers the skills.
- Keep `SKILL.md` files under 500 lines and move detail into `references/`.
- Do not copy these skills into `.claude/skills/` or `.agents/skills/`.

## Reference status

Links in the `Sources` sections point to specifications, man pages, MDN, and tool documentation. The Cursor documentation pages, the MDN CSP, WebAssembly and cross-origin-isolation pages, and the syscall man page were fetched or seen in search results while writing; other links are canonical addresses that were not re-fetched, so a periodic link check in an environment with network access is worthwhile. Numeric constants in `elf-linux-abi/references/linux-x86-64-constants.md` were extracted from local kernel and libc headers (provenance stated in that file) and should be re-verified against the target headers before use in code.
