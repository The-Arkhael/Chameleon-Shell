# Instruction contract, test template and review rubric

Evidence tags: `[spec]` architecture manual, `[observed]` measured or read in this repo, `[project]` repo decision, `[hypothesis]` unverified.

## 1. Contract template (copy, fill every line, say "n/a" explicitly)

```text
Instruction / form:      e.g. SHR r/m32, imm8 (opcode C1 /5), SHR r/m32, CL, SHR r/m32, 1
Source of semantics:     SDM Vol. 2 page "SAL/SAR/SHL/SHR" [spec]; native rows in flags_oracle.txt [observed]
Operand width rules:     32-bit default; REX.W -> 64; 66h -> 16; byte form by opcode
Reads:                   dst operand, count (imm8 | CL | 1), CF/OF not read
Writes:                  dst (32-bit write zero-extends into the 64-bit register), CF, OF, SF, ZF
Preserved:               all other registers and memory; flags when masked count == 0
Undefined (not asserted): AF, PF (not modeled); OF when count != 1; CF when count > width (8/16-bit)
Memory/faults here:      memory dst/src go through read_memory/write_memory; out of range -> Err(String)
Unsupported forms:       list them and the Err text returned (no silent fallthrough)
Regression test:         self_test.rs fn test_..., listed in run_self_test()
Oracle needed?           yes: extend flags_oracle.c rows (flags), no: known-answer only (pure data movement)
```

## 2. Known-answer test template (shape of the existing tests in `engine/src/self_test.rs`)

```rust
fn test_xxx_description() -> String {
    let name = "xxx -> what is proven, in words";
    let run = |value: u32| {
        let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
        asm.mov(iced_x86::code_asm::eax, value).unwrap();
        asm.xxx(iced_x86::code_asm::eax, 1i32).unwrap();
        asm.ret().unwrap(); // a top-level ret is the synthetic program end
        let bytes = asm.assemble(0).expect("failed to assemble test");
        run_exec_program(&bytes) // Result<ExecCpu, String>
    };
    match (run(A), run(B)) {
        (Ok(a), Ok(b)) if gp(&a, Register::EAX) == EXPECT_A && a.flags.cf == CF_A && /* ... */ => {
            format!("PASS: {name}")
        }
        (a, b) => format!("FAIL: {name} (a={:?}, b={:?})", /* actual values, not "it ran" */),
    }
}
```

Then add `reports.push(test_xxx_description());` to `run_self_test()`; without that line the test never runs. `scripts/golden.mjs` demands at least 19 PASS lines: if you add tests and want the floor to rise, change it deliberately and mention why. Use `run_exec_program_with_setup` when the test needs pre-set registers or memory.

Cover at least: exact result at the boundary widths; both initial values of any flag the instruction reads; each flag the instruction writes, asserted separately; a case where the SDM says a flag is preserved (assert it stayed); a neighbor-untouched check (adjacent bytes or the upper register half); one unsupported-form case asserting `is_err()` and that the message names the form (never `unwrap_err()` on `ExecCpu`: it has no `Debug`).

## 3. Review rubric

| Finding | Class | Evidence required |
| --- | --- | --- |
| Wrong value or flag where the SDM defines the output | Defect | SDM page, or oracle row, plus a failing test or a hand trace |
| Unsupported operand form or prefix runs silently | Defect | The `Instruction` form that reaches the handler (use `code()` / `op_kind()`) |
| Panic, unchecked index, or unchecked `as` conversion on guest-derived data | Defect | The guest input that reaches it |
| Flag asserted that the SDM leaves undefined | Defect in the test | SDM wording |
| Difference only in undefined flag bits | Not a defect | Note it; never copy one CPU's behavior |
| Missing regression test for a semantic fix | Defect | Diff shows no new `self_test.rs` case |
| Suspicion without evidence | Question | Label "unverified" and say what would settle it |

Report which claims you verified by running something and which you derived from the manual only.
