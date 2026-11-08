---
name: x86-64-isa
description: >-
  Use when planning, implementing, reviewing, debugging or testing x86-64
  instruction semantics in Chameleon-Shell's interpreter (engine/src/exec_ops.rs,
  exec_cpu.rs, the generator's mnemonic table): any time a handler, flag effect,
  operand form, operand width, sub-register write, addressing mode, prefix,
  condition code, shift/rotate, mul/div, push/pop/call/ret, string or rep
  instruction, SSE state, or unsupported-encoding path is added, changed,
  reviewed or triaged from a failing trace. Requires a per-instruction semantic
  contract and never treats a successful iced-x86 decode as proof of correct
  execution. Includes an inventory script. Not for ELF loading, syscalls or wasm.
---

# x86-64-isa

A standing procedure that keeps instruction semantics correct for the whole life of the interpreter, whichever instruction is next. Evidence tags: `[spec]` Intel/AMD manuals, `[observed]` measured on this repo's native oracles or read in its source, `[project]` repo decision, `[hypothesis]` unverified. What the engine implements *today* is derived by `scripts/isa-inventory.mjs` and `docs/STATUS.md`, never from this file; the dated notes in `references/project-isa-state.md` are a perishable snapshot.

## Consult this skill when

- **Planning**: choosing the next instruction slice from the measured gap list; deciding whether a failure is a missing instruction, wrong semantics, or an unsupported operand form.
- **Implementing**: adding or changing any handler, flag helper, or operand/addressing helper.
- **Reviewing**: any diff touching `exec_ops.rs`, `exec_cpu.rs`, `exec_generated.rs` (generated) or `generator/generate.ts` mnemonic entries; any PR claiming "implements X".
- **Debugging**: a trace stopping at an `unimplemented instruction` error, a wrong register/flag/memory value, a native-vs-engine mismatch.
- **Testing**: judging whether tests prove an instruction (values, flags, edge cases, negative forms).

## Standing invariants

1. Decoding is not semantics. Dispatch is by `Mnemonic` only, and one mnemonic spans many encodings: **a handler must reject every operand form, prefix and width it does not implement** with `Err(String)`; it must not run a lookalike path. `[observed]`
2. A write to a 32-bit register zeroes the upper half; 8/16-bit writes preserve it; immediates are sign-extended per encoding then truncated once to the operand width.
3. Only architecturally defined outputs are asserted. Undefined flag cells are neither asserted nor "fixed" to match one CPU.
4. Hardware faults (#DE, #GP, #PF, alignment) become structured `Err`, never a panic and never a silent success.
5. Every semantic change ships with a regression test that fails without it.

## Per-instruction contract (fill in before writing code)

1. **Exact semantics**: the SDM page by name, with operand-size and 64-bit-mode rules.
2. **Reads**: operands, implicit registers, flags consumed.
3. **Writes**: registers (how many bits), memory, flags set, flags preserved, flags undefined.
4. **Memory and faults in this emulator's model**: flat, bounds-checked, no permissions, no alignment faults; each hardware fault maps to an `Err`.
5. **Source of expected behavior**: `[spec]` page or `[observed]` native oracle row/trace; never memory alone.
6. **Regression test**: the `self_test.rs` function that proves it, wired into `run_self_test()`.

Templates, test skeleton and review rubric: `references/instruction-checklist.md`.

## Workflow

### 1. Orient

- `node .cursor/skills/x86-64-isa/scripts/isa-inventory.mjs`: current mnemonic-to-handler table, modeled state (flag fields, memory, step limit), a heuristic guard matrix, and attention items. Read the attention list as questions, then read the code.
- `docs/STATUS.md` ("What does not work yet", known defects, simplifications): the measured next step. Take the exact first failure (address, instruction, last 16 instructions) from `pnpm golden` or `run_elf`; implement only what that evidence demands (AGENTS.md rule 2). Locating the divergence against a native trace is covered by `differential-emulation-testing`.

### 2. Plan

Fill the contract. Decide which model extension (if any) the instruction needs: new flags, XMM state, DF, GS base. Those are architectural changes: state them and ask before building unless the measured failure demands them.

### 3. Implement

Reuse the helpers in `engine/src/exec_ops.rs` (operand width, operand read/write, effective address, flag helpers) and `ExecCpu::get_register`/`set_register`; do not re-derive masks by hand. Add the mnemonic through `generator/generate.ts` and `pnpm generate` (`typescript-codegen`). Rust conventions are in `chameleon-rust`.

### 4. Verify

Known-answer tests built with the iced `CodeAssembler` (no hand-typed bytes): exact register, flag and memory values; both initial states of every flag the instruction reads; boundary values (0, 1, max, min signed, width edges); neighbors untouched; an unsupported-form case asserting `is_err()` with a message naming the form. For flag-writing instructions beyond the ones already in the native oracle, extend `engine/tests/fixtures/flags_oracle.c` instead of reasoning from memory. Gates: `pnpm engine:check`, then `pnpm engine:build` and `pnpm golden`.

### 5. Review mode

A **defect** is: a wrong value or flag where the SDM defines the output; an unsupported form or prefix that runs silently; a panic or unchecked index on guest-derived data; a width or mask mistake; an asserted undefined flag; a missing regression or negative test. Evidence: SDM page or oracle row, plus a failing test or a worked trace. Label each finding confirmed (reproduced), likely (reading), or question; say which claims were run and which came from the manual only.

### 6. Record

Update `docs/STATUS.md` (implemented list, known simplifications, measured gaps) and remove or correct any falsified line in `references/project-isa-state.md`. Report with the six-part `AGENTS.md` format.

## Edge cases that repeatedly hide bugs

32-bit write zero-extension; AH..BH only without REX; shift/rotate counts masked to 5 bits (6 for 64-bit) at every width, masked count 0 leaving flags alone but still zero-extending a 32-bit destination; `inc`/`dec` preserving CF; signed versus unsigned condition codes; `mul`/`imul` undefined ZF/SF; `div` faults on zero or overflow; `push rsp`, `pop rsp`, `pop [rsp+x]` ordering; `ret imm16`; RIP-relative uses `ip_rel_memory_address()`; `lea` never touches memory; indirect branch forms versus relative ones; prefixes (`lock`, `rep`, segment, address-size) the handler does not honor.

## Related skills (each stands alone)

`differential-emulation-testing` (oracles, first divergence), `typescript-codegen` (mnemonic table), `chameleon-rust` (Rust rules), `elf-linux-abi` (the `syscall` instruction's ABI), `emulator-performance` (hot-path changes), `browser-sandbox-security` (guest-controlled operands and bounds).

## References and scripts

- `references/instruction-checklist.md`: contract, test skeleton, review rubric.
- `references/semantics-reference.md`: architectural rules (registers, widths, addressing, flags, condition codes, shifts, stack, strings, SSE).
- `references/project-isa-state.md`: dated SNAPSHOT of what existed at audit time and the deviations then known.
- `scripts/isa-inventory.mjs`: derives the current inventory and guard matrix from source.

## Sources

- Intel SDM (Vol. 1 basic architecture, Vol. 2 instruction set reference): <https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html>
- AMD64 Architecture Programmer's Manual: <https://www.amd.com/en/search/documentation/hub.html>
- System V AMD64 psABI: <https://gitlab.com/x86-psABIs/x86-64-ABI>
- iced-x86 API: <https://docs.rs/iced-x86/>
