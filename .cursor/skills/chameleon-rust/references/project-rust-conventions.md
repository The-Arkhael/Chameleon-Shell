# Project Rust conventions

Evidence tags: `[observed]` read in the checked-out files, `[project]` repository decision, `[hypothesis]` unverified.

## Stable conventions `[project]`

- Guest-derived failure returns `Err(String)`; panics are for impossible internal states only. A panic in the shipped wasm traps with no message.
- Gates run from the repository root through `scripts/engine.mjs` (cwd is `engine/` for cargo): `pnpm engine:check` (drift, fmt, clippy on correctness and suspicious, tests), `pnpm engine:test`, `pnpm engine:build` (check, then `wasm-pack build --target web`, then copy the three artifacts into `web/public/wasm/`; `SKIP_CHECKS=1` skips the check), `pnpm golden` (built wasm against committed fixtures). CI repeats the build, golden and fixture regeneration.
- Other clippy lints do not fail the gate, but do not add new warnings.
- `self_test.rs` is compiled into the shipped wasm because it backs the `self_test()` export: keep its `expect` calls to assembler/encoder invariants.
- Only functions called from `run_self_test()` run in the browser self-test and in the cargo wrapper test.
- Naming traps: two constants called `MEMORY_SIZE` exist in different modules (the legacy toy CPU and the real engine); `MAX_EXEC_STEPS` is local to the run function in `lib.rs`; the real `Syscall` handler is unrelated to the legacy fake SYSCALL opcode.
- iced-x86 and goblin gotchas are maintained in `AGENTS.md` ("gotchas already paid for"); do not duplicate them.

## SNAPSHOT (audit date 2026-10-27): values that can go stale

Refresh by re-reading the named source; delete or update a row when your change falsifies it.

| Fact | Source of truth | Value at audit time |
| --- | --- | --- |
| Rust channel, components, target | `engine/rust-toolchain.toml` | 1.86.0; clippy, rustfmt; `wasm32-unknown-unknown` |
| Edition, crate type, release profile | `engine/Cargo.toml` | 2021; `cdylib`; `opt-level = "s"` |
| Dependencies | `engine/Cargo.toml`, `engine/Cargo.lock` | `wasm-bindgen` 0.2 (lock 0.2.126), `iced-x86` 1 (lock 1.21.0), `goblin` 0.9 (lock 0.9.3) |
| wasm-pack, Node, pnpm | `.github/workflows/ci.yml`, `.cursor/Dockerfile`, `.nvmrc`, `package.json` | wasm-pack 0.13.1; Node 22; pnpm 10.x |
| `#[cfg(test)]` tests | `grep -c '#\[test\]' engine/src/*.rs` | 9 (elf 2, exec_cpu 1, lib 4, self_test 2) |
| `unsafe` in `engine/src` | `grep -rn unsafe engine/src` | none |
| Panic-capable sites outside tests | `node .cursor/skills/chameleon-rust/scripts/panic-sites.mjs` | core 13, legacy 3, self-test 169; the legacy `cpu.rs`/`generated.rs` sites are reachable through the exported `run(bytes)` |

What the scanner cannot see: slice indexing, unchecked `as` conversions, arithmetic overflow, and panics inside dependencies. Review those by reading.
