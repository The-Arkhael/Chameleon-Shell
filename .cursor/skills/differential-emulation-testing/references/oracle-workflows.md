# Oracle workflows (how the committed evidence is produced and used)

Stable procedures first; the dated SNAPSHOT of wiring status is at the end.

Evidence tags: `[observed]` verified by running or reading in this repo during the audit, `[doc]` stated by repo docs, `[hypothesis]` unverified. Commands are for Linux x86-64 unless noted. Run them from `engine/tests/fixtures/`. Keep one command per line (PowerShell-friendly docs); the native tools themselves cannot run on Windows.

## Artifact map

| File(s) in `engine/tests/fixtures/` | What it is | Produced by |
| --- | --- | --- |
| `elf_write_exit`, `sum_squares`, `libc_startup` | committed static ELF fixtures (authoritative) | `as`+`ld`; `gcc -ffreestanding -nostdlib -static`; `musl-gcc -static` (recipes in `regenerate.sh`) |
| `*.stdout`, `*.exitcode` | expected guest stdout and exit status | running the fixture natively |
| `libc_startup.strace.txt` | native syscall sequence of the musl fixture | `strace -f` |
| `libc_startup.steptrace.txt` | executed-RIP sequence, `rep` folded | `nativetrace --custom`, consecutive duplicate RIPs collapsed by `awk` |
| `libc_startup.initial_stack.txt` | readable initial stack and auxv at the entry point | `nativetrace --custom --stack` |
| `flags_oracle.txt` | native NEG/SHR/SAR rows (count: see the snapshot below) | `flags_oracle.c` run on hardware |
| `*.objdump.txt`, `*.readelf.txt` | disassembly and headers (never from memory) | `objdump -d`, `readelf` |

## Native tools `[observed]` (re-run successfully in the audit sandbox)

`nativetrace.c`: single-steps a static non-PIE x86-64 ELF under ptrace.

```text
gcc -O1 -g -Wall -Wextra -o nativetrace nativetrace.c
./nativetrace --custom --trace raw.txt --stack stack.txt libc_startup /bin/prog
./nativetrace --custom --regs --trace raw_regs.txt libc_startup /bin/prog
./nativetrace --kernel --trace raw_kernel.txt libc_startup /bin/prog
```

- It must be built PIE (the default) because guests live at 0x400000; do not add `-no-pie`.
- `--custom` maps the PT_LOAD segments itself, builds the initial stack at a fixed address below 16 MiB (the engine's memory size) and starts at `e_entry`: this is the environment the engine can reproduce, so it is the reference. `--kernel` uses plain `execve`, so addresses and auxv are whatever the kernel chose.
- Trace lines are `<step> <rip>` in hex without `0x` (step 0 is the first instruction). With `--regs`, each line also carries `rax rbx rcx rdx rsi rdi rbp rsp r8..r15` and `fl=<rflags>`, all hex, sampled **before** the instruction at `rip` executes. Compare only the engine's modeled flag bits: CF = 0x1, ZF = 0x40, SF = 0x80, OF = 0x800.
- Fold `rep` iterations with the same `awk` the recipe uses: `awk '$2 != prev { print $2 } { prev = $2 }' raw.txt > steptrace.txt`. An engine trace counts one step per executed instruction, so compare after folding.
- `MAX_STEPS` is 20,000,000; the guest's stdout passes through; diagnostics go to stderr. Ptrace may be blocked in some containers: the tool then fails with a clear message, and the check must be reported as not run.

`flags_oracle.c`: executes NEG/SHR/SAR with chosen inputs and records resulting flags.

```text
gcc -O1 -mno-red-zone -Wall -Wextra -o flags_oracle flags_oracle.c
./flags_oracle > flags_oracle.new.txt
diff <(grep -v '^#' flags_oracle.new.txt) <(grep -v '^#' flags_oracle.txt)
```

(The `diff` line is bash syntax; on PowerShell use the regenerate script in CI/cloud instead.) Row format: `op width rax_in cl_in | rax_out cf zf sf of`; each flag cell is `0`, `1`, `=` (unchanged) or `-` (architecturally undefined). The program checks every defined cell natively and reports the row count.

`regenerate.sh` (`pnpm fixtures:regenerate`): rebuilds the three fixtures into a temp directory, checks stdout and exit code, compares the syscall sequence (names only) with the committed strace, rebuilds the two native tools and checks the step trace and initial stack against the committed files. Passing means the recipes still work, not that bytes are identical.

## Comparison recipes

1. **First divergence in a failing ELF run.** Save the engine failure text (it includes `Execution trace (last 16 instructions):`), then run `node .cursor/skills/differential-emulation-testing/scripts/steptrace-context.mjs --engine-output failure.txt`. Output is either "window matches native steps a-b: no divergence, failure is a missing behavior at the last instruction" (then fix that instruction) or the first mismatching position with native context. The window is 16 instructions: if earlier history matters, reproduce with a smaller program.
2. **Where is this address in the native run?** `steptrace-context.mjs 401077 --before 12 --after 6` prints hits, step numbers, and objdump text; "never executed" means the address is not on the measured path.
3. **Flag semantics for a new instruction.** Extend `flags_oracle.c` (new op, rows, undefined-cell classification from the SDM), regenerate the file on a Linux x86-64 host, and add engine assertions for every defined cell. Keep undefined cells out of assertions.
4. **Syscall behavior.** Compare the engine's syscall order and return values with `libc_startup.strace.txt`; the engine returns `Err` for syscalls it does not implement. For a new syscall, record native behavior with `strace -f` first, then write the test.
5. **Guest-visible output.** Assert the exact stdout bytes and the exit code; note that Linux gives the parent only the low 8 bits of the exit status, while the engine reports the raw value it was given.

## Pitfalls

- Treating a green `cargo test` as proof for the wasm path: run `pnpm engine:build` and `pnpm golden` (different `usize`, different error text for huge addresses).
- Comparing an undefined flag cell, a raw timestamp, a `getrandom`/`AT_RANDOM` byte, a thread id, or an ASLR address.
- Editing a measured file to make a test pass, or rebuilding a committed fixture.
- Calling an oracle "ground truth" without its assumptions: it is one binary, one kernel/CPU, one environment mode.
- Claiming a differential check ran when only the committed files were read: say "compared against committed `*.steptrace.txt`", not "ran natively".

## SNAPSHOT (audit date 2026-10-27): what is wired up

Perishable: re-check with a code search before relying on it, and update this section when it changes.

- Re-run in the audit sandbox with matching results: the generator drift check, `node scripts/golden.mjs` on the prebuilt wasm, `flags_oracle` (704 rows, identical to the committed file), and `nativetrace --custom` (step trace and initial stack identical to the committed files). `cargo`, `wasm-pack` and `pnpm` were not available there, so the Rust gates were not run.
- Nothing in the repository reads `flags_oracle.txt`, and no engine hook exports per-step register state, so oracle rows and `--regs` traces cannot yet be diffed against the engine automatically. A harness would need either a Rust unit test (using `include_str!` plus the `CodeAssembler`) or a new trace export; build one as part of the task and say what it covers, rather than implying it exists.
- The only fixture with a step trace and initial-stack oracle is the musl static one; new fixtures need their own recipe in `regenerate.sh`.
