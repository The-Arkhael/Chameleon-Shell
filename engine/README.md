# engine

Rust crate (`cdylib`) compiled to WebAssembly with `wasm-pack`. Contents:

| File | Role |
|------|------|
| `src/lib.rs` | `#[wasm_bindgen]` exports (`run_elf`, `execute`, `disassemble`, `self_test`, `coverage_report`, ...) |
| `src/exec_cpu.rs`, `src/exec_ops.rs` | CPU state (16 GPRs, flags, 16 MiB memory), effective-address math, instruction/syscall handlers |
| `src/exec_generated.rs` | **Generated** dispatcher (`mnemonic -> handler`). Source of truth: `../generator/generate.ts` |
| `src/generated.rs`, `src/cpu.rs` | **Generated** + legacy Milestone-1 fake ISA (unrelated to the real `syscall` instruction) |
| `src/elf.rs` | goblin-based ELF64 parser + PT_LOAD loader |
| `src/self_test.rs` | Encoder-built known-answer tests (also exposed to the browser) |
| `tests/fixtures/` | Real ELF programs + native oracles (see `regenerate.sh`) |

## Toolchain

Pinned in `rust-toolchain.toml` (Rust 1.86.0, `wasm32-unknown-unknown`, clippy, rustfmt).

```sh
cd engine && rustup toolchain install   # once per machine
cargo install wasm-pack --locked        # once per machine
```

On Windows the default MSVC host toolchain needs Visual Studio Build Tools ("Desktop development with C++").

## Gates and build (from the repo root; the scripts are Node, so PowerShell works)

```sh
pnpm engine:check   # generator drift + rustfmt --check + clippy + cargo test
pnpm engine:build   # gates + wasm-pack + copy to web/public/wasm
pnpm golden         # asserts the built wasm still reproduces the oracle results
```

Never edit `generated.rs` / `exec_generated.rs` by hand: change `generator/generate.ts`
and run `pnpm generate`. The drift check fails the build if they disagree.

## Debugging tip

A panic inside wasm surfaces only as `RuntimeError: unreachable`. Reproduce it with
native `cargo test` to get the real message and backtrace.
