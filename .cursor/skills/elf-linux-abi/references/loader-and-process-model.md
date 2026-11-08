# Loader and process model

Evidence tags: `[spec]` ELF / psABI / Linux man-pages, `[observed]` measured in this repo, `[project]` repo decision, `[hypothesis]` unverified. Numeric constants are in `linux-x86-64-constants.md`; current implementation status is derived by `scripts/syscall-inventory.mjs`, `scripts/elf-inspect.mjs` and `docs/STATUS.md`, with a dated snapshot at the end of this file.

## The layers (keep them distinct)

| Layer | Authority | Defines | Typical confusion |
| --- | --- | --- | --- |
| ELF file format | gABI and `elf(5)` | headers, program headers, sections, relocation encodings | assuming a parsed ELF is a runnable process |
| AMD64 System V psABI | psABI document | calling convention, initial stack and register state, TLS models, x86-64 relocation types | using psABI call rules to describe syscalls |
| Linux syscall ABI | `syscall(2)`, kernel headers | syscall registers, numbers, errno-return convention | the libc wrapper's `-1`/`errno` is not what the raw syscall returns |
| Linux process init | `execve(2)`, kernel | what the kernel maps and puts on the initial stack (argv, envp, auxv) | mixing it with what libc does afterwards |
| C runtime init | musl / glibc sources | `_start`, TLS setup, stdio, auxv consumption | each libc probes different syscalls and auxv entries |
| Dynamic linking | `ld.so(8)`, psABI | `PT_INTERP`, relocations, symbol resolution | the kernel loads the interpreter, not the libraries |

## ELF loading checklist (validate before executing anything)

1. Header: magic, class `ELFCLASS64`, data little-endian, version, `e_machine` = `EM_X86_64`, `e_type` (`ET_EXEC` for static non-PIE; `ET_DYN` means PIE or shared object and needs a load-base choice), `e_phentsize` = 56, program header table inside the file.
2. Each `PT_LOAD`: `p_filesz <= p_memsz`; file range inside the file; `p_vaddr + p_memsz` free of overflow and inside the guest address space; `p_align` a power of two with `p_vaddr` congruent to `p_offset` modulo it; bytes between file size and memory size zero-filled (BSS); decide and document overlap and permission policy (the engine has no page permissions).
3. Entry point inside an executable segment.
4. Unsupported headers rejected with a clear message: `PT_INTERP` (dynamic linking). `PT_TLS` needs the C runtime to set the thread pointer (at least `arch_prctl(ARCH_SET_FS)`); `PT_GNU_STACK` may request an executable stack; `PT_GNU_RELRO`, `PT_NOTE`, `PT_GNU_PROPERTY` are informational for a static loader.
5. Use checked arithmetic and `usize::try_from` on every header-derived value (wasm32 `usize` is 32-bit).
6. Inspect any binary first: `node .cursor/skills/elf-linux-abi/scripts/elf-inspect.mjs <file>` (works on Windows; rules above plus the guest memory size). What the engine *actually* validates is measured by the SHOULD-level probes of `browser-sandbox-security/scripts/probe-malformed.mjs`; do not assume.

## Process entry state `[spec]` unless noted

- Initial stack at entry, low to high: `argc`, `argv[0..argc-1]`, NULL, `envp[...]`, NULL, auxiliary vector pairs ending with `AT_NULL`, then the string data the pointers refer to (argv and envp strings, platform string, 16 `AT_RANDOM` bytes, exec filename). The psABI requires `RSP` 16-byte aligned at entry and defines `RDX` as an `atexit` function pointer (0 if none); confirm exact wording in the psABI "process initialization" material and observe the real kernel with `nativetrace --kernel --regs`.
- The **measured reference** for this repo is `engine/tests/fixtures/*.initial_stack.txt` (from `nativetrace --custom`): it fixes concrete addresses and which auxv entries a static musl program received. Reproduce it exactly when building the stack; for another libc or for PIE/dynamic programs, produce a new oracle first (`differential-emulation-testing`).
- Auxv: entries are `(type, value)` pairs; type numbers are in the constants file. What a libc requires is found by reading its startup code and tracing a run, not by guessing: static musl needs little (program header location/count, page size, entry, random bytes); glibc and dynamic programs need more (for example `AT_BASE`, `AT_HWCAP`, `AT_PLATFORM`, the vDSO pointer) `[hypothesis]` until measured.
- PIE and dynamic: PIE adds a load bias, so `AT_PHDR` and `AT_ENTRY` are biased addresses; static-PIE self-relocates but needs `AT_PHDR` and a readable dynamic section; a dynamic executable additionally needs the interpreter mapped, `AT_BASE`, and a filesystem to find libraries.

## Syscall semantics (checklist for every syscall you add)

1. Registers `[spec]`: number in `RAX`; arguments `RDI`, `RSI`, `RDX`, `R10`, `R8`, `R9` (note `R10`, not `RCX`); result in `RAX`. The `syscall` instruction itself overwrites `RCX` (return RIP) and `R11` (RFLAGS).
2. Errors `[spec]`: the raw kernel interface returns `-errno` in `RAX` (values -4095..-1); libc wrappers convert that to `-1` plus `errno`. Man pages usually describe the wrapper: read their "C library/kernel differences" notes (for example for `brk`).
3. Unsupported numbers `[project]`: this engine returns a structured `unsupported syscall:` error and stops, which keeps gaps visible. Linux would return `-ENOSYS`, and libc feature probes rely on that fallback. Decide per syscall from strace evidence whether returning `-ENOSYS` is the faithful behavior, and say so.
4. Validate every guest pointer and length through the bounds-checked memory API with checked arithmetic; a bad pointer is an engine `Err` today, whereas Linux returns `-EFAULT`: choose deliberately.
5. Side effects (memory, break, descriptors, mappings) must keep engine invariants and respect limits (`browser-sandbox-security`).
6. Evidence: record the native `strace` line for the case, add a test, and add the fixture or oracle if a libc needs it.
7. Exit status: Linux hands the parent only the low 8 bits of the status; the engine reports the raw value it was given: compare accordingly.

## Slice discipline

The roadmap in `docs/STATUS.md` and `docs/SPEC.md` names later slices (initial stack, decode on demand, filesystem, `mmap`, PIE, dynamic linking, processes, signals, TTY). A task that mentions one does not authorize the others. Implement the smallest measured slice, list what remains in the report, and keep unsupported cases as structured errors. A loaded image without initial stack, entry registers, auxv, TLS path and syscalls is not a Linux process.

## SNAPSHOT (audit date 2026-10-27): status at audit time

Perishable: regenerate with the scripts named above and update this section when behavior changes.

- Loader: static non-PIE `ET_EXEC` via goblin: `PT_LOAD` copy and zero-fill with range checks against the 16 MiB guest memory; run from `e_entry`. No initial stack: `RSP` starts at the top of memory and the first libc fixture fails when it dereferences `argc`/`argv`.
- Probed against the prebuilt wasm `[observed]`: wrong `e_machine`, `e_type` (`ET_REL`, `ET_CORE`, `ET_DYN`), `e_version`, non-power-of-two `p_align`, and misaligned `p_vaddr` are accepted and executed; segment range, size-overflow, bad entry and truncation cases are rejected cleanly.
- Syscalls: `read` (stub returning EOF), `write` (fd 1 and 2), `brk` (placeholder break), `exit`, `exit_group`, `set_tid_address`, `arch_prctl` (`ARCH_SET_FS` only); everything else errors.
