---
name: emulator-performance
description: >-
  Use when planning, implementing, reviewing or measuring any change meant to
  improve, or that might affect, Chameleon-Shell's throughput, latency, memory
  or wasm size: the run loop and per-step work in engine/src/lib.rs, decode and
  address lookup, instruction dispatch, operand/flag/memory helpers, trace
  formatting, per-run allocation, step limits, opt-level and wasm-opt settings,
  and JS-to-wasm call overhead - including reviewing performance claims.
  Requires baseline, profile, hypothesis, focused change, correctness gates,
  comparison and keep-or-revert, with a wasm benchmark harness; forbids
  unmeasured speedup claims and speculative caching, unsafe, SIMD, concurrency
  or new dispatch schemes. Not for correctness bugs.
---

# emulator-performance

A standing procedure for improving speed, memory and size without losing correctness, debuggability or security, and for judging anyone's performance claim. Evidence tags: `[observed]` (measured with the harness), `[reading]` (code reading, a hypothesis), `[project]`, `[hypothesis]`. The method, the candidate hot-path list and a dated baseline are in `references/hot-path-map.md`; the numbers there are an illustration, not a target.

## Consult this skill when

- **Planning**: someone asks for "faster", "smaller", "less memory", a longer step limit, a new execution strategy (decode on demand, caching, a different dispatch), or proposes an optimization.
- **Implementing**: any edit on the per-step path (`engine/src/lib.rs` run loop, `exec_generated.rs` dispatch, `exec_ops.rs` helpers, `exec_cpu.rs` memory/register access) or in build settings (`engine/Cargo.toml` profile, wasm-pack/wasm-opt flags).
- **Reviewing**: any diff or PR description that claims a speedup, or a change on the hot path justified "for performance".
- **Debugging**: a UI freeze, a slow fixture, memory growth, an unexpectedly large wasm.

## Standing invariants

1. **No speedup claim without a measurement** on a recorded build, with spread, on a named workload. "Should be faster" is a hypothesis.
2. **Behavior is frozen.** An optimization must not change registers, flags, memory, output, error text, or step accounting. Error and trace text are an interface (tests, golden, UI).
3. **Profile first, then hypothesize, then change one thing.** Do not begin with caching, `unsafe`, SIMD, threads or a bespoke dispatch scheme; each needs a profile pointing at it and a simpler alternative ruled out.
4. **Limits are not performance knobs.** The step limit, memory size and output size protect the page (`browser-sandbox-security`); raising one is a design change.
5. **Size and debuggability count.** The release profile is size-optimized; keep the wasm small and keep failures explainable (trace, messages).
6. **Revert what the evidence does not support**, and say so.

## Workflow

### 1. Orient and baseline

- Build the artifact being measured: `pnpm engine:build` (needs Rust and wasm-pack; if unavailable, say the measurement could not be done and use an existing prebuilt wasm only if that is what is being judged).
- `node .cursor/skills/emulator-performance/scripts/bench-wasm.mjs --json` saved to a file is the baseline: it prints the environment, wasm size and hash, and per-workload min/median/p90/MAD plus the cold first call. Add workloads with `--elf <file>` or `--loop-iters N`; the harness refuses a workload that gives a wrong result.
- Record the baseline before editing; keep the machine quiet.

### 2. Measure representative workloads and profile

Pick workloads that match the claim (a branch-heavy loop, an arithmetic loop, a syscall-heavy ELF, short per-call overhead, startup-sized binaries). Profile the relevant path (browser DevTools or `node --cpu-prof`). Use the candidate table in `references/hot-path-map.md` as a source of hypotheses, not as findings.

### 3. Hypothesis, then one focused change

Write the hypothesis ("formatting every step costs X% of a 75k-step run; formatting lazily removes it"), the expected effect, and the guest-visible risk. Make the smallest change that tests it. Rust conventions: `chameleon-rust`; the generator if the dispatch is touched: `typescript-codegen`.

### 4. Correctness gates (before looking at the numbers)

`pnpm engine:check`, `pnpm engine:build`, `pnpm golden`. Anything that could change guest-visible behavior also needs differential evidence (`differential-emulation-testing`): oracle comparisons, the flag oracle for flag helpers, error-text checks for trace changes.

### 5. Compare and decide

Rebuild, then `node .cursor/skills/emulator-performance/scripts/bench-wasm.mjs --compare <baseline.json>`. It reports improved, REGRESSED or within noise per workload, and warns when both builds are byte-identical. Also compare wasm size. Keep the change only when the motivating workload improves outside the noise and nothing regressed; otherwise revert and record what you learned.

### 6. Review mode (for performance claims and hot-path diffs)

A **defect** is: a claim with no measurement, no baseline, or only one run; a measurement on a different build/profile than the one shipped; a comparison inside the noise reported as a win; a behavior change hidden in an optimization (including trace or error text); a speculative structure (cache, `unsafe`, concurrency) with no profile; a raised limit presented as a speedup; a benchmark that never checks correctness. Ask for the harness output (environment, hash, table, comparison) and the gate results. Label findings confirmed / likely / question.

### 7. Record

Put the baseline and comparison in the report (and, when it is lasting knowledge, update the dated snapshot in `references/hot-path-map.md`; delete numbers that no longer hold). Update `docs/STATUS.md` if limits or the execution strategy changed.

## Related skills (each stands alone)

`differential-emulation-testing` (the correctness gate), `chameleon-rust` (conventions and gates), `wasm-runtime-boundary` (call and copy overhead, Workers), `browser-sandbox-security` (limits), `x86-64-isa` (helper semantics), `typescript-codegen` (dispatch is generated).

## References and scripts

- `references/hot-path-map.md`: measurement method, hot-path hypotheses with tests and risks, dated baseline snapshot.
- `scripts/bench-wasm.mjs`: benchmark and comparison harness for the built wasm.

## Sources

- The Rust Performance Book: <https://nnethercote.github.io/perf-book/>
- Cargo profiles (`opt-level`, `lto`, `codegen-units`): <https://doc.rust-lang.org/cargo/reference/profiles.html>
- wasm-pack build profiles: <https://rustwasm.github.io/wasm-pack/book/cargo-toml-configuration.html>
- Node.js CPU profiling (`--cpu-prof`): <https://nodejs.org/api/cli.html#--cpu-prof>
- Chrome DevTools performance panel: <https://developer.chrome.com/docs/devtools/performance>
