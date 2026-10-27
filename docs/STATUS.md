# Status

Snapshot taken when leaving Replit, extended with the native oracles measured for M2b (see "Native oracles").

Re-verified outside Replit (`pnpm golden` now asserts the oracle results): `cargo test` 9/9 (native, Rust 1.89 and pinned 1.86 results agree), clippy
clean, generator output identical to the committed Rust, and the prebuilt wasm reproduces every golden result in plain Node.

## What works
- Legacy Milestone 1 toy pipeline: generator -> Rust -> wasm -> xterm page (5 fake opcodes; unrelated to the real `syscall`).
- Real x86-64 decoding (iced-x86), 16 GPRs with correct sub-register write rules (incl. AH..BH), flags CF/ZF/SF/OF,
  16 MiB flat memory with bounds-checked access, stack (push/pop/call/ret), direct jumps and calls, FS-relative addressing.
- Implemented mnemonics (26): Add And Call Cmp Endbr64 Imul Ja Jae Jb Je Jge Jl Jmp Jne Lea Mov Movzx Mul Nop Pop Push
  Ret Shr Sub Syscall Test Xor.
- Real Linux syscalls: read(0, stub: EOF), write(1; fd 1,2 only), brk(12), exit(60), exit_group(231), set_tid_address(218),
  arch_prctl(158, ARCH_SET_FS only).
- ELF64 static non-PIE loader (goblin): PT_LOAD copy + BSS zero-fill; decode of executable segments; run from entry point.
- Verified against native oracles: `elf_write_exit` -> "hello\n" exit 37; `sum_squares` (real gcc -O2 output, 70 instructions,
  objdump boundaries 70/70) -> "sum=338350\n" exit 0. 19 encoder-built self-tests PASS in the browser.

## Native oracles (measured on the real CPU, committed in `engine/tests/fixtures/`)
Measurements, not opinions: never hand-edit them. `regenerate.sh` re-measures all of them on x86-64 Linux (needs ptrace) and diffs them.
- `libc_startup.steptrace.txt`: the address of every instruction the real CPU executes in `libc_startup`, in order. 690 ptrace
  single-steps = 653 instruction executions (a `rep` instruction counts once), 365 distinct addresses, 4 syscalls. Made by `nativetrace.c`.
- `libc_startup.initial_stack.txt`: the process stack that trace started on (argv ["/bin/prog"], 2 env strings, 15 auxv entries,
  rsp 0xfffe70). Its header lists which values decide musl's loop counts and branches, so the engine must reproduce them.
- `flags_oracle.txt`: 704 native NEG/SHR/SAR rows (8/16/32/64-bit, edge values and counts, both initial flag states). Each flag cell is
  defined (0/1), unchanged (`=`) or architecturally undefined (`-`, never asserted). `flags_oracle.c` aborts if the CPU contradicts the SDM
  rules, so the table cannot encode a wrong rule.
- `libc_startup.strace.txt` (older) holds the syscall arguments: `arch_prctl(ARCH_SET_FS, 0x404138)`, `set_tid_address(0x404270)`
  (returns the host tid; the engine returns 1, which is fine), `write(1, "hello\n", 6)`, `exit_group(0)`.
- Measured, not guessed: execution never reaches the three `hlt` (0x40130b, 0x401329, 0x401768), the `poll`/`open` fallback in
  `__init_libc` (0x40129a-0x40132a) or any syscall other than those four.

## What does not work yet (evidence, not guesses)
**`libc_startup` (musl static hello) fails at once:**
`unimplemented instruction: mnemonic=Mov, address=0x401077, instruction=mov esi,[rdi]; reason: out-of-bounds read: 4 byte(s) at 0x1000000`
1. **No initial process stack.** RSP is set to the top of memory, so musl's read of `argc` at `[rsp]` is out of bounds.
   Needed: the stack described in `libc_startup.initial_stack.txt` (argc, argv[], NULL, envp[], NULL, auxv pairs, AT_NULL,
   16-byte aligned at entry, x86-64 psABI). glibc will need more entries later (AT_BASE, AT_SYSINFO_EHDR, AT_HWCAP2, ...).
2. **Decode-once linear sweep is structurally unsound for real binaries.** One sweep over a whole executable segment loses
   alignment across gaps: in `libc_startup`, `.init` is 3 bytes at 0x401000 and `.text` starts at 0x401020 in the same
   PT_LOAD; padding decodes as `add [rax],al` and swallows the first bytes of `exit` (0x401020), so a call to it would
   miss the address map. It also produces a false `Sti` (0x401022). Fix: decode on demand at RIP with an address-keyed
   cache (invalidate when code pages are written), and run `coverage_report` per ELF section, not per segment. Required for
   Milestone 3 anyway (code in mmap'd regions, dynamically loaded libraries).
3. **Measured gap list for `libc_startup`** (decoded from the 365 distinct executed addresses). It replaces the old static list.
   Mnemonics that execution reaches and the engine lacks (11): Movsxd (4 sites), Neg (2), Sar (2), Js (1), Jbe (1), `rep Stosq`
   (1 site, 38 iterations), and SSE Movq xmm,r64 / Punpcklqdq / Movaps / Movdqa / Movups (1 site each; these need an XMM register file).
   Forms of "implemented" mnemonics that are not handled: indirect `call [rbx]` (2 sites) and `call r12`, `jmp rax`, `push 0` (imm).
   Never reached, so do not implement yet: Dec Cmova Cmovne Jns Movsb Movsq Pxor and the three `hlt`.
   Other operand forms of implemented mnemonics may still fail; the first divergence from the step trace finds them.
4. **`exec_shr` is wrong in two places** (found by `flags_oracle.txt`; latent, `libc_startup` only uses `shr rsi,3Fh`):
   the count mask is `width*8-1` (7/15 for 8/16-bit) where the SDM masks to 5 bits (6 for 64-bit) at every width, and the early return
   on a masked count of 0 skips the 32-bit zero-extension of the destination (`shr eax,32` still clears RAX[63:32]).
5. **The run loop formats every executed instruction into a `String`** for the 16-entry trace ring (by code reading, not profiled).
   Keep (address, length) and format only when an error is reported. `MAX_EXEC_STEPS` is 100,000: fine for 653 steps, too low for glibc startup.

## Known simplifications (deliberate, commented in code)
- Flags: CF ZF SF OF only (no PF/AF, no real EFLAGS bit layout, so no pushfq/popfq).
- `brk` starts at a placeholder (0x80000); should start page-aligned after the highest loaded segment.
- Top-level `ret` ends the program (synthetic exit for test snippets); real programs exit via exit/exit_group.
- Memory is flat, identity-mapped from 0 (fine for static non-PIE). PIE, mmap, dynamic linking need an address-space layer.
- `read` always returns EOF. Only fds 1 and 2 for write.

## Decisions
- Target is Debian/glibc. musl static is a stepping stone (simpler startup), not the goal.
- Interpreter first. CheerpX's architecture is the reference (interpreter tier + JIT tier + syscall emulation + block-based
  Ext2 filesystem); the JIT tier is deferred, not dropped. Nothing here blocks adding it later.
- iced-x86 owns decoding; the TypeScript generator owns mnemonic->handler dispatch and the implemented-mnemonic list.
- Toolchain: rustup with `engine/rust-toolchain.toml` (1.86.0). Replit's Nix workarounds are gone.
- Desktop packaging with Tauri v2 is optional and thin: the same `web/` build in a system webview, no native engine, no host access.
  It starts after M2b is green, as its own PR touching only `web/` and `src-tauri/`. Not built yet; the Tauri facts below come from
  tauri.app docs, the CSP facts from Chromium runs (Playwright), not yet re-measured in WebView2, WKWebView or WebKitGTK.
  - Security stance: explicit CSP; empty capabilities; no shell/fs/process plugins and no custom host commands (registered commands are
    callable from every window by default); `freeze_prototype`; the guest filesystem lives in engine memory, never on the host.
  - Before any wrapper: replace the blob-URL dynamic import with a bundled loader (a `blob:` import needs `blob:` in `script-src`) and
    drop the Google Fonts links (external request). Target `script-src 'self' 'wasm-unsafe-eval'` (Wasm instantiation needs it).
  - xterm.js 6.0.0 injects `<style>` tags at runtime and has no nonce support: without `style-src 'unsafe-inline'` the terminal is
    black on black (screenshot-verified). A nonce in `style-src` makes `'unsafe-inline'` ignored, so Tauri's automatic nonce/hash
    injection must be checked against it (`dangerousDisableAssetCspModification` is the documented switch). Unverified in a Tauri build.
  - COOP/COEP headers give `crossOriginIsolated` and SharedArrayBuffer; needed only if blocking `read` ends up as Worker + Atomics.wait.
  - Interactive terminal input waits until the engine supports a real `read`; the Worker-versus-cooperative-loop choice is made then.

## Roadmap
- **M2b (next):** `libc_startup` prints "hello\n" and exits 0, proven against the native oracles:
  initial stack builder matching `libc_startup.initial_stack.txt`; decode on demand at RIP; implement only the measured gaps above with
  known-answer tests; run the NEG/SHR/SAR rows of `flags_oracle.txt` through the engine and fix `exec_shr`; the engine's executed-RIP
  sequence must equal `libc_startup.steptrace.txt` and its syscall log must match `libc_startup.strace.txt`. Then a static program
  using stdio/printf, then a static Go binary.
- **M3:** VFS (evaluate Ext2-style block device vs in-memory tree), open/openat/read/close/fstat/lseek/getdents64/readlink,
  mmap/munmap/mprotect, ET_DYN/PIE and the ELF interpreter (ld.so), relocations, glibc TLS; run dynamically linked Debian `ls`/`cat`.
- **M4:** fork/execve/wait4 semantics, pipes, signals, TTY ioctls, job control -> interactive bash.
- **After M2b, independent of M3:** web hardening and the Tauri wrapper (see Decisions), then Android/iOS.
- **Later:** JIT tier (a Wasm-emitting JIT can still run inside iOS WebViews, because JavaScriptCore JIT-compiles Wasm there; native JIT is
  what iOS forbids. Secondary sources only, no Apple primary document found). Extend the native flag oracle beyond NEG/SHR/SAR as
  instructions arrive.
