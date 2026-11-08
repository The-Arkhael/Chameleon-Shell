# x86-64 semantics reference (actionable subset)

Evidence tags: `[spec]` architecture manual (Intel SDM / AMD APM / psABI), `[observed]` measured in this repo, `[project]` repo decision, `[hypothesis]` unverified. This file states rules without copying the manuals; open the SDM Vol. 2 page for the exact instruction before implementing, and verify any flag row with a native oracle before relying on it. Section numbers are deliberately omitted: look the instruction up by name.

## Registers and writes `[spec]`

- 16 general-purpose registers RAX RCX RDX RBX RSP RBP RSI RDI R8..R15. Encodings 0..15; REX.R, REX.X, REX.B supply bit 3 of reg, index and base/rm.
- A 64-bit write replaces all 64 bits. A **32-bit write zero-extends** into bits 63:32. 16-bit and 8-bit writes merge and **preserve** the rest of the register.
- Byte registers: encodings 4..7 mean AH, CH, DH, BH only when no REX prefix is present; with any REX prefix they mean SPL, BPL, SIL, DIL. AH..BH read/write bits 15:8 of RAX..RBX.
- iced reports the concrete `Register`; use `Register::size()` (bytes) and `full_register()` (needs the `instr_info` feature) rather than decoding encodings yourself. `[observed]` AGENTS.md.

## Operand size and immediates `[spec]`

- Default operand size in 64-bit mode is 32 bits. REX.W selects 64. The 66h prefix selects 16 (REX.W wins over 66h). Byte forms are chosen by opcode, not prefixes.
- Stack operations (`push`, `pop`, `call`, `ret`, `leave`) default to 64-bit operand size; 32-bit is not encodable. Do not depend on 66h with near branches.
- Immediates: imm8 forms are sign-extended (for example opcode 83 group, `imul r, r/m, imm8`, `push imm8`); imm32 is sign-extended to 64 bits when the operand size is 64; `mov r64, imm64` (REX.W B8+r) carries a full 64-bit immediate; `mov r/m64, imm32` sign-extends. Read with `instr.immediate(n)` and truncate once to the operand width.

## Addressing `[spec]`

- Effective address = base + index * scale + displacement, computed modulo 2^64 with 64-bit address size. The 67h prefix selects 32-bit address size (the address wraps at 32 bits).
- ModRM `rm = 100` (with mod != 11) means a SIB byte follows. ModRM `mod = 00, rm = 101` means `[RIP + disp32]` in 64-bit mode (no base register). In SIB, `index = 100` without REX.X means no index; base `101` with `mod = 00` means no base plus disp32. iced resolves all of this: use `memory_base()`, `memory_index()`, `memory_index_scale()`, `memory_displacement64()`, `is_ip_rel_memory_operand()`.
- RIP-relative displacement is relative to the address of the **next** instruction (after any immediate bytes). iced already resolves it in `ip_rel_memory_address()`; do not add `next_ip()` again. `[observed]` AGENTS.md.
- In 64-bit mode the CS/DS/ES/SS segment bases are treated as 0. FS and GS add their base (FSBASE/GSBASE). This engine models FS only; see `project-isa-state.md`.
- `lea` computes the address and never touches memory; the destination write follows the destination register width (32-bit `lea` zero-extends, 16-bit `lea` merges).

## Flag effects (CF OF SF ZF; PF and AF listed for completeness, not modeled here) `[spec]`

| Instruction | Writes | Rule |
| --- | --- | --- |
| ADD, ADC | CF OF SF ZF AF PF | CF = unsigned carry out, OF = signed overflow; ADC includes the incoming CF in both |
| SUB, SBB, CMP | CF OF SF ZF AF PF | CF = borrow (unsigned dst < src, plus borrow in for SBB), OF = signed overflow |
| INC, DEC | OF SF ZF AF PF | **CF preserved** |
| NEG | CF OF SF ZF AF PF | CF = (source != 0); OF = (source is the most negative value). Confirmed natively: `flags_oracle.txt` `[observed]` |
| AND, OR, XOR, TEST | CF OF SF ZF PF | CF = OF = 0; SF/ZF/PF from the result; AF undefined |
| NOT | none | no flags |
| MUL | CF OF | CF = OF = 1 when the upper half of the product is nonzero; SF ZF AF PF undefined |
| IMUL | CF OF | CF = OF = 1 when the result does not fit the signed destination size (one-operand form: upper half is not the sign extension of the lower half); SF ZF AF PF undefined |
| DIV, IDIV | none defined | all six flags undefined; **#DE** when the divisor is 0 or the quotient overflows (this engine must return `Err`) |
| SHL, SHR, SAR | see next section | |
| ROL, ROR | CF, OF | rotate count masked like shifts; masked count 0 leaves flags unchanged; CF = last bit rotated out; OF defined only for count 1; SF ZF AF PF unaffected |
| MOV, LEA, MOVZX, MOVSX, PUSH, POP, XCHG, SETcc, CMOVcc, Jcc | none | SETcc/CMOVcc/Jcc only read flags |

## Shift counts `[spec]` + `[observed]`

- The count (immediate, CL, or the implicit 1) is masked to **5 bits, or 6 bits when the operand size is 64**, for every operand width. 8- and 16-bit operands therefore accept counts up to 31.
- Masked count 0: no flag changes, but a 32-bit destination is still written (upper half zeroed). Confirmed natively in `flags_oracle.txt` `[observed]`.
- Masked count > 0: CF = last bit shifted out; ZF, SF from the result. OF is defined only for count 1 (SHL: MSB(result) XOR CF; SHR: MSB of the original value; SAR: 0). For counts at or above the operand width, CF is undefined for SHL/SHR on 8/16-bit operands. `engine/tests/fixtures/flags_oracle.c` encodes these classes and the oracle proves every defined cell on real hardware; its `-` cells are undefined: do not assert them.

## Condition codes `[spec]`

The low nibble `cc` selects the condition for `Jcc` (short `70+cc`, near `0F 80+cc`), `SETcc` (`0F 90+cc`) and `CMOVcc` (`0F 40+cc`).

| cc | Name(s) | Condition | cc | Name(s) | Condition |
| --- | --- | --- | --- | --- | --- |
| 0 | O | OF=1 | 8 | S | SF=1 |
| 1 | NO | OF=0 | 9 | NS | SF=0 |
| 2 | B, C, NAE | CF=1 | A | P, PE | PF=1 (PF not modeled) |
| 3 | AE, NB, NC | CF=0 | B | NP, PO | PF=0 (PF not modeled) |
| 4 | E, Z | ZF=1 | C | L, NGE | SF != OF |
| 5 | NE, NZ | ZF=0 | D | GE, NL | SF = OF |
| 6 | BE, NA | CF=1 or ZF=1 | E | LE, NG | ZF=1 or SF != OF |
| 7 | A, NBE | CF=0 and ZF=0 | F | G, NLE | ZF=0 and SF = OF |

Signed comparisons (L/GE/LE/G) use SF and OF; unsigned (B/AE/BE/A) use CF and ZF. A signed jump after an operation that sets OF wrongly is a classic bug.

## Stack, call, return `[spec]`

- `push`: RSP decreases by the operand size, then the value is written. `push rsp` pushes the value RSP had **before** the decrement. For a memory source, the effective address is computed before RSP changes.
- `pop`: read the value, then RSP increases. `pop rsp` ends with RSP equal to the popped value. For `pop [rsp+disp]`, the effective address is computed **after** RSP has been incremented.
- `call rel32` pushes the address of the next instruction. Indirect calls read their target operand before the push. `ret` pops RIP; `ret imm16` additionally adds imm16 to RSP after the pop.
- The psABI requires RSP 16-byte aligned at the `call` instruction (so RSP+8 is 16-aligned at function entry). Hardware does not enforce it except through aligned SSE accesses.
- `[project]` A `ret` at call depth 0 is a synthetic program end for test programs; real programs end through `exit`/`exit_group`.

## String instructions and REP `[spec]`

- `movs`, `stos`, `lods`, `scas`, `cmps` use RSI (source, DS) and RDI (destination, ES; no override) and step by the element size, forward when DF=0 and backward when DF=1. This engine has no DF: forward-only is an explicit simplification that must be documented if you rely on it.
- `rep` repeats while RCX != 0 (count register follows address size) and decrements RCX each iteration; a zero count executes nothing and changes no flags. `repe`/`repne` apply to `cmps`/`scas` and also test ZF each iteration. After the loop RSI/RDI/RCX hold their advanced values.
- The native step trace folds a `rep` instruction into one step (see `differential-emulation-testing`), so compare architectural state at instruction boundaries, not iteration counts.

## SSE and SIMD state `[spec]`

- 16 XMM registers of 128 bits plus MXCSR. Legacy SSE instructions leave bits above 127 (YMM upper) unchanged; VEX-encoded forms zero them.
- `movaps`/`movdqa` faulting rule: a memory operand that is not 16-byte aligned raises #GP; `movups`/`movdqu` do not. `movq xmm, r64` and `movd` zero the remaining upper bits of the destination.
- `[project]` There is no XMM state yet; `docs/STATUS.md` lists the measured need (a `movq`, `punpcklqdq`, `movaps`/`movdqa`/`movups` group from libc startup). Add state and instructions only for forms the measured trace needs; map hardware faults to `Err`.

## Invalid, unsupported and prefix handling `[project]`

- `instruction.is_invalid()` means the bytes did not decode: report `undecodable bytes at 0x...`.
- A decoded but unimplemented mnemonic yields `unimplemented instruction: mnemonic=..., address=..., instruction=...` plus the last 16 instructions. Do not weaken that format.
- Handlers should reject, not ignore, prefixes and forms they do not implement (`instr.has_lock_prefix()`, `has_rep_prefix()`, `has_repne_prefix()`, `segment_prefix()`, `op_kind(n)`, `op_count()`).
- The decoded `Instruction` is valid input only for the **form** you check. `near_branch64()` is meaningful for `OpKind::NearBranch64`; check `op_kind(0)` first `[hypothesis]` for other operand kinds.
