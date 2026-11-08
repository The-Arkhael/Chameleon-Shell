# SNAPSHOT of the engine's instruction support (audit date 2026-10-27)

**This file is perishable.** It records what was true when the skills were written. Never use it as the current inventory: run `node .cursor/skills/x86-64-isa/scripts/isa-inventory.mjs` and read `docs/STATUS.md`. **Maintenance rule:** when a change fixes or adds something listed here, update or delete that line in the same change; an entry that is no longer true is worse than none. The reusable value of this file is the *kinds* of hazard it illustrates (operand-form validation, prefix handling, count masking, model subsets), which recur with every new instruction.

Evidence tags: `[observed]` read in source or probed against the prebuilt wasm during the audit, `[doc]` stated in `docs/STATUS.md`, `[hypothesis]` unverified. The authoritative lists are `generator/generate.ts` (table) and `engine/src/exec_generated.rs` (`IMPLEMENTED_MNEMONICS`).

## Machine model `[observed]`

- 16 general-purpose registers in a private array (`ExecCpu::get_register`/`set_register`), flags CF ZF SF OF, `fs_base`, flat 16 MiB zero-initialized memory identity-mapped from address 0 with bounds checks only (no page permissions, no unmapped-page distinction, no alignment faults).
- The program counter lives in the run loop (`engine/src/lib.rs`), which decodes each executable segment once with a linear sweep, indexes instructions by address, and applies `pending_jump`. Consequences: code is not re-decoded after memory writes, and `execute(bytes)` runs the bytes at address 0 **without copying them into guest memory** (a load from address 0 reads zeros) `[observed]`, whereas ELF loading copies segments into memory.

## Mnemonics and supported forms (27 in the generator table)

| Mnemonic | Handler | Supported forms / notes |
| --- | --- | --- |
| Mov | `exec_mov` | register, memory, immediate combinations at widths 1/2/4/8; segment/control registers fail through `register_slot` with `Err` |
| Add, Sub, Cmp | `exec_add`, `exec_sub`, `exec_cmp` | same operand forms; CF ZF SF OF only |
| And, Xor, Test | `exec_and`, `exec_xor`, `exec_test` | CF=OF=0, ZF SF from result |
| Lea | `exec_lea` | register destination, memory source; writes via `set_register` (so 32-bit zero-extends) |
| Movzx | `exec_movzx` | register destination, 8/16-bit source; `movsx`/`movsxd` are not implemented |
| Mul, Imul | `exec_mul`, `exec_imul` | one-operand widening forms; `imul` also 2- and 3-operand forms; flags per SDM subset |
| Shr | `exec_shr` | immediate, CL, and 1; **known defects below** |
| Push, Pop | `exec_push`, `exec_pop` | 64-bit register operand only; `push imm`, `push m64`, `pop m64` return `Err` |
| Call, Ret | `exec_call`, `exec_ret` | near relative call; `ret` at depth 0 is the synthetic program end |
| Jmp, Je, Jne, Jl, Jge, Ja, Jae, Jb | generated `Jump` arms | near relative; conditions use CF/ZF/SF/OF |
| Syscall | `dispatch_real_syscall` | see `elf-linux-abi` |
| Endbr64, Nop | `exec_nop` | no state change |

Not implemented (examples measured or likely soon): `Jbe Js Jns Jle Jg Jo Jno Jp Jnp`, `cmovcc`, `setcc`, `or`, `adc`, `sbb`, `neg`, `not`, `inc`, `dec`, `sar`, `shl`, rotates, `div`, `idiv`, `movsx`, `xchg`, `cld`/`std`, string instructions, `bt` family, `leave`, `cpuid`, and all SSE/x87 state. `docs/STATUS.md` ("What does not work yet") lists what the measured `libc_startup` run needs first; follow that list rather than a generic instruction wish-list (AGENTS.md rule 2).

## Deviations known at audit time (do not copy these as models; delete each when fixed)

1. **`exec_shr` count mask and zero-extension** `[doc][observed]`. The mask is `width*8 - 1` (7/15 for 8/16-bit operands) where the SDM masks to 5 bits (6 for 64-bit) at every width, and the early return on a masked count of 0 skips the 32-bit destination zero-extension. Found by `flags_oracle.txt`, latent today, and the planned fix is to drive the oracle's SHR/SAR/NEG rows through the engine. Nothing in the repo reads `flags_oracle.txt` yet `[observed]`.
2. **Indirect `jmp`/`call` are silently mis-executed** `[observed]`. The generated `Jump` arms and `exec_call` use `instr.near_branch64()` without checking the operand kind. Probes on the prebuilt wasm: `mov eax,12 / jmp rax / mov eax,99 / ret` returns `EAX = 99` (hardware: 12), `call rax` likewise, and `jmp [rip+0]` finishes without an error. There is no "unsupported form" error. Treat any indirect-branch task as new feature work: add an operand-kind check that returns `Err` first, then implement.
3. **`ret imm16` ignores its immediate** `[observed]`: `exec_ret` takes no operand and never adds imm16 to RSP.
4. **Prefixes are ignored rather than rejected** `[observed]`: a `lock` prefix (harmless in a single-threaded model), a **GS** segment override (`effective_address` handles FS only), and the 67h address-size prefix (no 32-bit address wrap) are accepted without error. Probes run clean; whether the result is right depends on the data.
5. **`syscall` does not clobber RCX/R11** `[observed]`, which the `syscall` instruction does (RCX = next RIP, R11 = RFLAGS). Guest code normally treats them as clobbered, so this rarely shows; matters when comparing full register state with an oracle.
6. **Flag model is a subset** `[doc]`: PF, AF, DF absent; flags such as OF for non-1-bit shifts are written as `false` where the SDM says undefined. Do not assert undefined cells.
7. **Panics on impossible widths** exist in helper functions `[observed]`; see `chameleon-rust`.

## Where measured evidence lives

- `engine/tests/fixtures/libc_startup.steptrace.txt`: native executed-RIP sequence (653 steps) for the musl fixture.
- `engine/tests/fixtures/flags_oracle.txt`: 704 native NEG/SHR/SAR rows, each flag cell `0`/`1`/`=` (unchanged)/`-` (undefined).
- `engine/tests/fixtures/*.objdump.txt`, `*.readelf.txt`: disassembly and headers of the committed fixtures.
- `docs/STATUS.md`: measured gaps, known defects, simplifications, roadmap.
