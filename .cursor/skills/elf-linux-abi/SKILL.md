---
name: elf-linux-abi
description: >-
  Use when planning, implementing, reviewing, debugging or testing ELF loading,
  process image and initial-stack construction (argc, argv, envp, auxv), entry
  state, Linux x86-64 syscall dispatch (numbers, arguments, return and errno
  conventions, per-syscall semantics), brk/mmap/file-descriptor behavior,
  TLS and arch_prctl, PIE, dynamic linking and PT_INTERP, or musl/glibc startup
  behavior in Chameleon-Shell (engine/src/elf.rs, exec_ops.rs dispatch_real_syscall,
  lib.rs run_elf) - and when deciding what a milestone slice should and should
  not include. Keeps ELF format, psABI, syscall ABI, kernel process init, C
  runtime init and dynamic linking separate, and derives implemented-versus-planned
  from source at use time. Includes ELF and syscall inventory scripts. Not for
  instruction semantics or browser/wasm integration.
---

# elf-linux-abi

A standing procedure for everything between "bytes of an ELF file" and "a Linux process the guest believes it runs in", for every milestone, not only the current one. Evidence tags: `[spec]` ELF/psABI/Linux man-pages, `[observed]` measured here, `[project]` repo decision, `[hypothesis]` unverified. Implemented-versus-planned is **derived** with the scripts and `docs/STATUS.md`; the dated snapshot in `references/loader-and-process-model.md` is perishable.

## Consult this skill when

- **Planning**: scoping a loader, stack, auxv, syscall, or libc-startup slice; judging what a milestone task should and should not include.
- **Implementing**: changing `engine/src/elf.rs`, `dispatch_real_syscall` in `engine/src/exec_ops.rs`, or the process setup in `engine/src/lib.rs`.
- **Debugging**: a fixture failing at startup (stack or auxv reads), an `unsupported syscall` error, a wrong exit code or output, a binary that loads but misbehaves.
- **Reviewing**: any diff adding a syscall, an ELF rule, a stack/auxv builder, or a claim like "supports PIE/dynamic/`ls`".
- **Testing**: choosing oracles for new process-level behavior (with `differential-emulation-testing`).

## Standing invariants

1. **Parser is not process.** A working ELF parser does not give you a Linux process: the initial stack, auxv, entry registers, TLS path and syscalls are separate things that each need evidence.
2. **No implicit milestones.** Implement the smallest measured slice that the failing evidence demands. A prompt that mentions PIE, `mmap`, dynamic linking or "run a shell" does not authorize them; state what remains.
3. **Unsupported means a structured error**, not a silent success and not a panic (`[project]`; whether to return `-ENOSYS` instead is a per-syscall decision backed by strace evidence).
4. **Every header-derived number is untrusted**: checked arithmetic, `usize::try_from`, guest memory only through the bounds-checked API.
5. **Numbers come from authority**, not memory: syscall numbers and constants are verified against kernel headers (`scripts/syscall-inventory.mjs` does this for the engine's constants).
6. **Layers stay separate**: ELF format, psABI, syscall ABI, kernel process init, C runtime init, dynamic linking (table in `references/loader-and-process-model.md`).

## Workflow

### 1. Orient (derive the current state)

- `node .cursor/skills/elf-linux-abi/scripts/elf-inspect.mjs <elf-file>`: headers, program headers and loader-relevant checks for any binary, on any OS (no `readelf` needed).
- `node .cursor/skills/elf-linux-abi/scripts/syscall-inventory.mjs`: engine syscall constants, whether each has a dispatch arm, whether the numbers match the kernel header on this machine, and which syscalls the committed `*.strace.txt` fixtures need that the engine lacks.
- `docs/STATUS.md` (measured failures, known simplifications, roadmap) and `docs/SPEC.md` (milestones). Take the exact first failure from `pnpm golden` or `run_elf`.

### 2. Plan

Name the slice, the evidence that motivates it (a trace line, an strace line, an oracle file), what is explicitly out of scope, and the test that will prove it. For stack/auxv work, the measured reference is `engine/tests/fixtures/*.initial_stack.txt`; for a new libc or binary shape, produce a new oracle first.

### 3. Implement (procedures)

- **Add a syscall**: read the man page (kernel vs libc-wrapper differences), record the native `strace` line, add the constant (verify the number), add the arm in `dispatch_real_syscall`, validate pointers/lengths with checked arithmetic, return `-errno` per the raw ABI, keep limits in mind (`browser-sandbox-security`), add a known-answer test and, if a fixture needs it, extend the oracle. Checklist: `references/loader-and-process-model.md`.
- **Change loader validation**: add the rule with a precise error message, one rejecting test per rule, and re-run the malformed-input probes; keep the accepted static non-PIE path unchanged and tested.
- **Build the initial stack**: replicate the oracle byte for byte (strings, alignment, auxv set), set `RSP` and entry registers accordingly, and compare with `*.initial_stack.txt`.
- **PIE or dynamic work**: design first (load base, relocations, `AT_BASE`, interpreter mapping, filesystem needs) and ask; do not start implementing from a mention.

### 4. Verify

`pnpm engine:check`, `pnpm engine:build`, `pnpm golden`; compare syscall sequences and output with the native evidence; for new rules run `node .cursor/skills/browser-sandbox-security/scripts/probe-malformed.mjs`. Report what ran and what could not (no Rust toolchain, no ptrace, Windows).

### 5. Review mode

A **defect** is: a number or constant not verified against an authority; an unvalidated header or syscall argument; an unsupported case that proceeds silently; a layer mix-up (psABI register rules applied to syscalls, libc wrapper semantics applied to the raw ABI); an implicit extra milestone; missing oracle or test; docs claiming support that does not exist. Evidence: the man page or header, the oracle line, or a failing probe; label confirmed / likely / question.

### 6. Record

Update `docs/STATUS.md` (implemented syscalls, loader scope, known simplifications), add new fixtures/oracles to `engine/tests/fixtures/regenerate.sh`, and refresh the SNAPSHOT section of the reference.

## Related skills (each stands alone)

`differential-emulation-testing` (oracles), `browser-sandbox-security` (untrusted headers, syscall argument validation, limits), `x86-64-isa` (the `syscall` instruction and TLS addressing), `chameleon-rust` (Rust conventions), `wasm-runtime-boundary` (when exports or limits change).

## References and scripts

- `references/loader-and-process-model.md`: layers, loading checklist, process entry state, syscall semantics checklist, slice discipline, dated snapshot.
- `references/linux-x86-64-constants.md`: syscall numbers, `AT_*`, ELF and relocation constants, errno, mmap and arch_prctl values generated from local kernel/libc headers (re-verify against the target headers).
- `scripts/elf-inspect.mjs`, `scripts/syscall-inventory.mjs`: derive current facts.

## Sources

- ELF: `elf(5)` <https://man7.org/linux/man-pages/man5/elf.5.html>
- System V AMD64 psABI: <https://gitlab.com/x86-psABIs/x86-64-ABI>
- Syscall convention: `syscall(2)` <https://man7.org/linux/man-pages/man2/syscall.2.html>; process start: `execve(2)` <https://man7.org/linux/man-pages/man2/execve.2.html>; auxv: `getauxval(3)` <https://man7.org/linux/man-pages/man3/getauxval.3.html>
- Per-syscall semantics: `brk(2)` <https://man7.org/linux/man-pages/man2/brk.2.html>, `mmap(2)` <https://man7.org/linux/man-pages/man2/mmap.2.html>, `arch_prctl(2)` <https://man7.org/linux/man-pages/man2/arch_prctl.2.html>, `_exit(2)` <https://man7.org/linux/man-pages/man2/_exit.2.html>
- Kernel syscall table (authoritative numbers): `arch/x86/entry/syscalls/syscall_64.tbl` in the Linux source tree.
