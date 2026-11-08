# Threat model method, per-capability checklists and the dated register

Evidence tags: `[observed]` measured by running something, `[reading]` from code reading only, `[doc]`, `[project]`, `[hypothesis]`. Statuses: **Confirmed** (reproduced), **Potential** (credible, not reproduced), **Hardening** (defense in depth), **Verified OK** (tested or read and found enforced). Re-run `scripts/probe-malformed.mjs` and `../wasm-runtime-boundary/scripts/boundary-check.mjs` rather than trusting the register.

## Why WebAssembly does not settle it

The wasm sandbox keeps the *engine* away from the host: the module can only use what the page hands it through imports (today a single externref-table initializer `[observed]`). It does not make the **guest** harmless to the engine: a malformed ELF or a hostile program can still trap the instance, exhaust memory or CPU, mislead the loader, or (once a virtual filesystem, networking or shared state exists) reach what those features expose. Treat guest bytes as untrusted input to a parser and interpreter written in Rust, and treat each new capability as a new attack surface.

## Trust boundaries

| ID | Boundary | Attacker-controlled input today | Future inputs |
| --- | --- | --- | --- |
| TB1 | guest program or ELF bytes to the engine (loader, decoder, interpreter, syscalls) | bytes passed to `run_elf`, `execute`, `disassemble`, `coverage_report`, `parse_elf`, `run` by whoever calls the exports | uploaded binaries, rootfs images, `execve` of guest files |
| TB2 | page script to wasm exports | any script on the origin can call any export with any bytes | URL/query parameters, drag-and-drop, terminal input |
| TB3 | wasm module to host (imports) | none: allowlisted imports only | Worker messages, filesystem or network bridges |
| TB4 | build and supply chain | crate and npm dependencies, CI actions, wasm tooling | new dependencies, tool downloads |
| TB5 | browser policy | page loads fonts from a third-party origin; no CSP; no isolation headers | CSP, COOP/COEP, Worker and `SharedArrayBuffer` needs |

## Threat entry template (use for every significant threat and every new feature)

```text
Threat:             one sentence
Attacker input:     exactly what the attacker controls (bytes, fields, syscall args, sizes, timing)
Trust boundary:     TB1..TB5 (or new)
Invariant:          the property that must always hold ("no export traps on any input")
Enforcement point:  file and function where it is enforced (or "missing")
Validation test:    the probe, unit test or fixture that fails when the invariant breaks
Status:             Confirmed / Potential / Hardening / Verified OK, with the evidence
```

## Review procedure for any change

1. List the new inputs and capabilities the change introduces (bytes, sizes, strings/paths, descriptors, addresses, counts, durations, new imports, new origins, new dependencies).
2. For each, fill an entry; prefer enforcement in the engine (bounds, quotas, validation) over documentation.
3. Add or extend a probe or test so the invariant is checked mechanically (`scripts/probe-malformed.mjs` categories: MUST no trap/hang/growth; SHOULD reject invalid input; INFO measured behavior).
4. Distinguish confirmed from potential in the report; do not present a code-reading hunch as a vulnerability, and do not dismiss a reproduced failure because the shipped UI does not trigger it.
5. Do not fix unrelated findings in the same change: list them (AGENTS.md report item 6). Respect legitimate execution requirements: the step limit, memory size and unsupported-feature errors are product decisions; raising a limit needs cancellation or yielding design, not just a bigger constant.

## Capability checklists (use when the milestone arrives)

- **Virtual filesystem / file descriptors**: guest paths never reach a host path; normalize and reject traversal and symlink loops; bound path length, directory depth, file size, total bytes and descriptor count; fd numbers validated on every use; close/dup bookkeeping cannot underflow; per-process quotas.
- **`mmap`/`mprotect`/`brk`**: ranges checked with overflow-safe arithmetic against the address space and against existing mappings; `brk` must stay within its region and not overlap mappings; permissions enforced if modeled; total memory bounded.
- **Terminal / stdin**: bounded buffers, rate limits, no unbounded queueing; decide what a blocked `read` does (Worker plus cancellation) before adding it.
- **Processes (`fork`/`execve`/`wait`)**: bound process count and total memory; `execve` input is untrusted ELF again; no leaked descriptors across `execve`.
- **Workers / `SharedArrayBuffer`**: message validation, termination for cancellation, isolation headers affect every cross-origin resource.
- **Networking or host bridges**: default deny; explicit allowlists; never expose host capabilities through imports without review.
- **Dependencies**: new crate or package needs a reason, a lockfile diff review, and for npm a release age consistent with `minimumReleaseAge`.

## SNAPSHOT register (audit date 2026-10-27)

Perishable: statuses change as controls land. Update or delete rows in the same change that alters them.

| ID | Threat | Status | Evidence | Enforcement today / needed |
| --- | --- | --- | --- | --- |
| S1 | Legacy `run(bytes)` export traps on malformed bytes (unknown opcode, truncated operand, register index above 3) | Confirmed | probe suite, `RuntimeError: unreachable` | none; return an error or remove the export (TB2); shipped UI passes constants |
| S2 | Invalid ELF identity accepted and executed (wrong `e_machine`, `e_type`, `e_version`; non-power-of-two `p_align`; misaligned `p_vaddr`) | Confirmed (correctness and policy, not memory safety) | probe suite | validate in `engine/src/elf.rs`; one test per rule |
| S3 | Guest stdout accumulates with no cap until the step limit | Confirmed (growth measured); exhaustion Potential | probe: 4 KiB writes in a loop took wasm memory from 28 MiB to 268 MiB; writes up to guest-memory size would scale this `[hypothesis]` | cap total captured output, fail with a clear error |
| S4 | Integer overflow and range abuse in segment headers (sizes, offsets, vaddr+memsz, truncated or enormous tables) | Verified OK | probe suite: all MUST cases reject, 300 seeded mutations and a truncation sweep without a trap | bounds in `engine/src/elf.rs`, `exec_cpu.rs` |
| S5 | Infinite loop in guest code | Verified OK for CPU bound per call; Potential for UI freeze | step limit returns an error; call is synchronous on the page thread | cancellation needs a Worker (`wasm-runtime-boundary`) |
| S6 | Memory leak across repeated calls | Verified OK | probe: 200 calls, no growth | n/a |
| S7 | `brk` accepts any value up to the memory size, including below loaded segments | Potential | `[reading]` | constrain once a real heap/`mmap` exists (`elf-linux-abi`) |
| S8 | Wasm import surface | Verified OK | single allowlisted import | `boundary-check.mjs` allowlist |
| S9 | No CSP; fonts from a third-party origin; blob-URL module import | Hardening | `[reading]`, `docs/STATUS.md` notes the intended policy | design with `wasm-runtime-boundary` before changing |
| S10 | Supply chain: lockfiles committed, CI `pnpm install --frozen-lockfile`, `minimumReleaseAge` 1 day, build scripts limited to `esbuild`, `cargo fetch --locked` in the cloud environment; CI actions pinned by tag not commit; no automated dependency or advisory scanning configured | Hardening | `[reading]` of CI and workspace config | pin actions by commit, add advisory scanning only if wanted |
