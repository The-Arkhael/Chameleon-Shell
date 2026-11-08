---
name: browser-sandbox-security
description: >-
  Use when planning, implementing, reviewing or testing anything that handles
  untrusted guest bytes or decides what a guest can reach in Chameleon-Shell:
  ELF validation, guest memory bounds and integer overflow, instruction and
  syscall argument validation, file-descriptor and future virtual-filesystem
  isolation, step, memory and output limits and cancellation, the wasm import
  surface, the JavaScript boundary, CSP and cross-origin isolation, and
  dependency or supply-chain changes - including a security review of every
  new feature or syscall. Produces threat entries (attacker input, trust
  boundary, invariant, enforcement point, test) separating confirmed from
  potential issues, and includes a malformed-input probe suite. Not generic
  caution and not performance tuning.
---

# browser-sandbox-security

A standing procedure for keeping enforceable security boundaries while executing untrusted guest binaries, applied to every new capability, not only today's. Evidence tags: `[observed]` (reproduced), `[reading]`, `[doc]`, `[project]`, `[hypothesis]`. The current state is measured by `scripts/probe-malformed.mjs` and `../wasm-runtime-boundary/scripts/boundary-check.mjs`; `references/threat-register.md` holds the method, per-capability checklists and a dated register.

## Consult this skill when

- **Planning**: a feature that adds input (upload, terminal, URL), a syscall, a file or memory capability, a Worker, a new import, a new dependency, or a limit change; any "run this binary" scenario.
- **Implementing**: ELF loading, memory access helpers, syscall handlers, the wasm exports, loaders and policy files (`web/index.html`, `web/vite.config.ts`).
- **Reviewing**: any diff that parses guest-controlled data, does arithmetic on guest-controlled numbers, or widens what a guest can do; any claim "this is safe because it is WebAssembly".
- **Testing**: choosing malformed-input and resource-exhaustion cases; extending the probe suite.
- **Triaging**: a trap, hang, runaway memory, or a report of suspicious behavior.

## Standing invariants

1. **The guest is untrusted input to the engine.** The wasm sandbox protects the host from the engine's *imports*, not the engine from the guest. No export may trap, hang or grow without bound on any input.
2. **Header- and syscall-derived numbers are hostile**: checked arithmetic, `usize::try_from` (the shipped wasm is 32-bit), bounds-checked guest memory access only, errors as `Err(String)`.
3. **Capabilities are explicit.** The import allowlist, descriptor table, filesystem namespace, memory quota and process count define what a guest can reach; nothing is reachable by default.
4. **Limits are product decisions with enforcement**: step limit, memory size, output size, input size. Raising one needs cancellation or yielding design and a probe, not a bigger constant.
5. **Evidence over adjectives**: every significant threat has attacker input, boundary, invariant, enforcement point and a validation test; "be careful" is not an enforcement point.
6. **Confirmed is not Potential.** Say which you have: reproduced behavior, or a code-reading hypothesis with what would confirm it.

## Workflow

### 1. Orient (measure current behavior)

- `node .cursor/skills/browser-sandbox-security/scripts/probe-malformed.mjs` (needs the built wasm from `pnpm engine:build`): header and segment mutations, empty and truncated inputs, step limit, a truncation sweep, seeded mutation fuzz, repeated-call memory stability and an output-accumulation measurement. MUST rows should always pass; SHOULD rows are validation gaps and move from GAP to PASS as controls land; INFO rows are measurements.
- `node .cursor/skills/wasm-runtime-boundary/scripts/boundary-check.mjs --print-imports`: the host-capability surface.
- `node .cursor/skills/chameleon-rust/scripts/panic-sites.mjs`: panic-capable code a guest could reach.
- Read the dated register in `references/threat-register.md` for context, then trust the probes over the register.

### 2. Plan (threat entries before code)

For each new input or capability fill the entry template (threat, attacker input, boundary, invariant, enforcement point, validation test, status) and use the matching capability checklist (filesystem, `mmap`/`brk`, terminal, processes, Workers, networking, dependencies). Decide the enforcement in the engine first.

### 3. Implement

Enforce at the earliest boundary that owns the invariant (parser, memory API, syscall entry, export). Prefer rejecting with a precise error to clamping silently. Keep the change focused: log unrelated findings instead of fixing them in passing.

### 4. Verify

Add or extend a probe or unit test per invariant, run the probe suite (`--level should` makes SHOULD gaps fail the run), then `pnpm engine:check`, `pnpm engine:build`, `pnpm golden`. For policy changes (CSP, headers, loaders, Workers) test every loader in `wasm-runtime-boundary` and say what was not verified in a browser. Report executed versus recommended checks.

### 5. Review mode

A **defect** is: guest-controlled arithmetic without overflow handling; a guest-reachable panic or unbounded allocation; a syscall or loader path that accepts what the spec says to reject without an explicit decision; a new import, descriptor, path or quota-less resource without a threat entry; a limit raised without a probe; a security claim without a test; a new dependency or tool download without justification and lockfile review. Classify each finding Confirmed / Potential / Hardening, include the reproduction or the reasoning, and state uncertainty plainly. Do not call something a vulnerability if the only evidence is that code "looks risky".

### 6. Record

Update the register in `references/threat-register.md` (new entries, changed statuses, deleted rows that no longer hold), the probe catalog if you added invariants, and `docs/STATUS.md` for new limits or known gaps.

## Related skills (each stands alone)

`elf-linux-abi` (what the ELF and syscall rules should be), `wasm-runtime-boundary` (imports, CSP, loaders, Workers), `x86-64-isa` (guest-controlled operands and forms), `chameleon-rust` (no panics on guest input), `differential-emulation-testing` (regression tests), `emulator-performance` (limits trade-offs).

## References and scripts

- `references/threat-register.md`: why wasm does not settle it, trust boundaries, entry template, review procedure, capability checklists, dated register.
- `scripts/probe-malformed.mjs`: reusable malformed-input and resource probe suite against the built wasm.

## Sources

- WebAssembly security model: <https://webassembly.org/docs/security/>
- MDN Content-Security-Policy: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy>
- MDN cross-origin isolation (`SharedArrayBuffer` requirements): <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer>
- Linux `execve(2)` and `mmap(2)` for the semantics a loader must respect: <https://man7.org/linux/man-pages/man2/execve.2.html>, <https://man7.org/linux/man-pages/man2/mmap.2.html>
- `minimumReleaseAge` and related supply-chain settings (pnpm.io settings reference): <https://pnpm.io/settings>
