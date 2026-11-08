# Measurement method, hot-path candidates and the dated baseline

Evidence tags: `[observed]` measured with `scripts/bench-wasm.mjs`, `[reading]` from code reading only (a hypothesis until measured), `[project]`, `[hypothesis]`. Nothing in the candidate list is a finding: each is a place to *test* a hypothesis.

## Measurement method (stable)

1. **Same artifact, same machine, same settings.** Build once (`pnpm engine:build`), record the wasm size and hash that the harness prints, avoid debug builds (`pnpm engine:build -- --dev` passes `--dev` to wasm-pack) unless the comparison is debug versus debug, and keep other load off the machine.
2. **Representative workloads, checked for correctness.** The harness refuses to time a workload whose result is wrong. Add real workloads with `--elf <file>` (it must finish without an error). The engine stops a run at its step limit (100,000 guest steps at audit time: check `isa-inventory.mjs` output for the current value), so long loops need new design, not bigger constants.
3. **Separate cold from steady state.** The first call in a fresh wasm instance includes memory growth and engine warm-up; later calls are the steady state. Report both and say which one a claim is about. Browser behavior can differ from Node: for browser claims, measure in the browser.
4. **Statistics.** Use at least 30 runs after warm-up; compare medians with the spread (MAD) and the min..p90 range; treat differences inside the noise as no difference. `--compare baseline.json` applies a conservative heuristic (median +/- 2 MAD intervals must not overlap) `[project recommendation]`.
5. **Profile before optimizing.** Candidate tools: Chrome DevTools Performance on the page or `node --cpu-prof` on a script that calls the wasm; wasm function names depend on the build keeping its name section `[hypothesis]`. Use the profile to choose the hypothesis, then measure the change with the harness.
6. **Correctness gates are part of the experiment**: `pnpm engine:check`, `pnpm engine:build`, `pnpm golden`, plus `differential-emulation-testing` for anything that could change guest-visible behavior. A faster wrong emulator is not a result.
7. **Keep or revert on evidence**: keep a change only if the harness shows an improvement outside the noise on the workload that motivated it, and nothing regressed elsewhere or in size.

## Hot-path candidates by code reading `[reading]` (test each before acting)

Per executed instruction in `run_exec_program_segments_with_setup` (`engine/src/lib.rs`):

| Candidate | Why it may matter | How to test the hypothesis | Risk to guest-visible behavior |
| --- | --- | --- | --- |
| `format_instruction` builds a new `NasmFormatter` and a `String` every step, plus a second `format!` and a `VecDeque` push for the trace | allocation and formatting per step for text only used on failure | count formatting share in a profile; try formatting lazily from instruction indices when an error is built | the trace text is part of the error contract (tests, golden, UI): output must stay byte-identical |
| `exec_generated::is_implemented` is a linear `contains` over the implemented-mnemonic slice, then `dispatch` matches again | a scan per step before dispatch | profile; compare with a precomputed per-instruction flag or letting `dispatch` report unimplemented | message order and text for undecodable versus unimplemented instructions must not change |
| `flow_control()` and `pending_jump` bookkeeping | small per-step cost | only if the profile shows it | none expected |
| `HashMap<u64, usize>` (default hasher) for taken branches | branch-heavy loops pay a hash per taken jump | a branch-heavy workload; compare against a dense table | error for a non-instruction target must stay |
| Operand helpers (`read_operand_value`, `write_operand_value`, `get_register`, `flags_for_*`) | width matches and slice copies per operand | profile on an arithmetic-heavy workload | flag and width semantics: differential tests mandatory |
| Per-run fixed cost: `ExecCpu::new()` zeroes a 16 MiB buffer; the address map is rebuilt; `run_elf_bytes` decodes and formats a full disassembly, then decodes again for execution; the captured output is `{:?}`-formatted | dominates short programs and repeated calls | the fixed overhead measured by tiny workloads; time each phase by experiment | the output contract includes the "Disassembly:" text; memory model changes touch correctness and security |
| JS-to-wasm boundary: input copied in, output string copied out | matters for large inputs/outputs and many small calls | measure call overhead with a trivial export; size sweeps | none if semantics are untouched; keep size caps (`browser-sandbox-security`) |
| Release profile `opt-level = "s"` and wasm-opt settings | size versus speed trade-off | build variants and measure both speed and size | none; the project values small wasm |

Do not start with speculative caching, `unsafe`, SIMD, threads, or a new dispatch scheme: each needs a profile that points at it, a simpler alternative ruled out, and differential evidence.

## SNAPSHOT (audit date 2026-10-27): illustrative baseline

Perishable and environment-specific: Node v22.22.2, Linux x64 sandbox, one virtual Xeon core, prebuilt wasm of 682,376 bytes (sha256 prefix ccf05d1472b88e0b). Milliseconds per call, 30 runs after 5 warm-ups (`node .cursor/skills/emulator-performance/scripts/bench-wasm.mjs`).

| Workload | median | min | p90 | first call |
| --- | --- | --- | --- | --- |
| `execute:counted-loop(25000)` (75,002 guest steps) | 21.5 | 21.3 | 21.8 | 99.7 |
| `run_elf:sum_squares` | 1.50 | 1.42 | 1.63 | 29.3 |
| `run_elf:elf_write_exit` (a handful of steps) | 1.19 | 1.14 | 1.25 | 2.2 |
| `self_test` (about twenty programs) | 31.9 | 31.3 | 32.8 | 213.5 |

Reading it `[observed]` then `[hypothesis]`: a program of a few instructions already costs about 1.2 ms per call, and the loop adds roughly 0.27 ms per thousand steps, so per-call fixed cost dominates short runs and per-step cost dominates long ones; the cold first call is far slower than steady state. Which part of each is formatting, allocation or dispatch is **not yet known**: profile before choosing. Re-measure on your machine; these numbers support no speedup claim.
