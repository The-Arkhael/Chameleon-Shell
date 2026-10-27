# System Architecture & Engineering Context: Project "Chameleon Shell"

> Original architecture document, preserved verbatim (minus a stray citation marker). Status and deviations: see STATUS.md.

## 1. Overview (4W1H Framework)

* WHAT: A hyper-lightweight, serverless Linux execution environment running natively inside a single web browser tab. It consists of a custom-built, user-space x86_64 CPU instruction interpreter and a POSIX system call (syscall) translation table compiled directly to WebAssembly (Wasm). It mounts a minimal, compressed Debian root filesystem (rootfs) into browser memory, presenting a fully functional CLI environment (like a bash shell) to the user.
* WHERE: Executing 100% client-side inside a standard sandboxed web browser tab (e.g., Chrome, Firefox, Safari). It operates completely offline and serverless, requiring zero native host installations, zero system modifications, and no remote backend servers.
* WHO: Designed for web developers, tool creators, and software engineers who want to deliver local, sandboxed development utilities, custom command-line tools, or isolated Linux environments to users instantly via a simple web URL.
* WHY: Traditional hardware emulators (like v86 or QEMU) are too heavy for quick web deployments because they emulate redundant physical hardware (BIOS, VGA, floppy disks, network cards) and boot a full guest kernel, consuming hundreds of megabytes of RAM and crushing performance. Conversely, native system-call tools (like PRoot) cannot run in a browser because browsers block the required ptrace kernel hooks. This architecture bridges the gap: it strips away the useless hardware layer to match the lightweight footprint of PRoot (~300KB engine), but handles the x86_64 instructions internally via WebAssembly to bypass browser sandbox limitations.
* HOW: By using a Meta-Compiler Strategy. A backend code generator parses a machine-readable specification of the x86_64 ISA and automatically outputs thousands of lines of highly optimized execution logic. This generated code is compiled into WebAssembly, while a custom Virtual File System (VFS) and System Call Translation Table trap and handle the application's operating system requests entirely in browser memory.

---

## 2. Technical Stack & Languages
To maximize execution efficiency while keeping the workflow maintainable, the architecture is split into a modular, multi-language pipeline:

1. The Code Generator (Development Backend): Written in TypeScript (running on Node.js or Bun). It runs strictly on the developer's local machine. It handles massive JSON/XML data specifications of the x86_64 architecture and programmatically generates the core source code for the execution engine.
2. The Core Runtime Engine (The Guest CPU/OS Layer): Written in Rust (compiled via wasm-bindgen) or Zig. It consumes the generated instruction code. It manages the virtual register state, parses the incoming compiled Linux binary streams, handles CPU flag calculations, and maps the Linux System Call Translation Table. This compiles into the final high-performance .wasm file.
3. The User Interface (Frontend Web Stack): Written in HTML5, CSS3, and JavaScript/TypeScript. It loads the .wasm engine into the browser tab, downloads and serves the compressed Debian rootfs, and handles I/O via Xterm.js to render a high-fidelity visual terminal interface for the user.

---

## 3. Core Architectural Components
Any assisting AI model must focus on generating, optimizing, or debugging code for these four distinct pillars:

### Pillar A: The Instruction Decoder Generator
Because x86_64 is a Complex Instruction Set (CISC) architecture with variable-length instructions (1 to 15 bytes) and over 1,500 operations, writing a decoder loop manually is impractical.

* Mechanism: The TypeScript generator reads a structured data schema of the x86_64 ISA (derived from Ghidra or the Capstone engine).
* Output: It outputs a programmatic Rust/Zig match or switch block. For each opcode, it generates the exact bit-shifting and masking logic needed to isolate operands (registers, immediate values, memory displacements) and executes the corresponding mathematical operation on the virtual CPU state.

*(Deviation, decided during the build: byte decoding is delegated to the iced-x86 crate; the generator owns the mnemonic->handler dispatch.)*

### Pillar B: The WebAssembly System Call (Syscall) Trap
When an unmodified Debian binary wants to interact with the outside world (e.g., printing text via printf or allocating memory), it executes a native syscall instruction.

* Mechanism: The Rust/Wasm engine catches this instruction and checks the index register (RAX).
* Translation: It routes the request through a lightweight translation map containing roughly 50 to 100 essential POSIX system calls. For example, sys_write (ID 1) takes the memory address from the binary's registers, reads the data out of the WebAssembly memory array buffer, and channels it directly to JavaScript's console or Xterm.js. sys_brk (ID 12) or sys_mmap (ID 9) slices off regions of the continuous WebAssembly.Memory() buffer to handle the application's heap allocation.

### Pillar C: The In-Memory Virtual File System (VFS)
Standard Debian command-line utilities are dynamically linked and heavily dependent on specific directory structures (e.g., searching for /lib/x86_64-linux-gnu/libc.so.6 or reading configurations from /etc).

* Mechanism: A stripped-down, minimal x86_64 Debian filesystem bundle (created via debootstrap) is compressed into a .tar.gz payload (ideally <15MB) and shipped to the client browser.
* Mapping: The frontend extracts this directory layout into an in-memory structured store (like a JavaScript Object map or browser IndexedDB). File-related syscalls (like sys_openat, sys_read, sys_write, sys_stat) are intercepted by the Wasm engine and serviced directly from this browser-memory data store, tricking the Debian software into believing a standard Linux hard drive structure is present.

### Pillar D: Automated Verification & Testing
To ensure the generated instruction set handles calculations and status flags identically to a real physical CPU, the system uses an automated test harness.

* Mechanism: It passes standardized assembly test vectors with known input profiles and expected status flag mutations (Zero Flag, Carry Flag, Sign Flag) through the compiled Wasm engine.
* Validation: It systematically compares the virtual register array profiles step-by-step against the outputs of a native reference environment (like QEMU or a physical Linux box) to discover instruction translation anomalies programmatically.

---

## 4. Engineering Milestones & Execution Roadmap
To bring Project "Chameleon Shell" to life, development will proceed across the following phased milestones:

* Milestone 1: Prototype Core Loop & Simple Script Execution
  * Build a rudimentary TypeScript generator script to output a tiny, 5-instruction Rust engine (ADD, SUB, MOV, LOAD, SYSCALL).
  * Compile the output to WebAssembly and execute a custom-crafted, mock binary array directly inside a webpage console.
* Milestone 2: Expand to Unmodified Static Binaries
  * Scale the TypeScript engine generator to fully map basic x86_64 computational, logical, and control-flow instructions.
  * Implement fundamental I/O and memory management syscalls (sys_read, sys_write, sys_brk).
  * Successfully run a fully compiled, statically linked user-space executable (e.g., a custom CLI tool written in C or Go compiled with the -static flag) directly in the browser tab via Xterm.js.
* Milestone 3: Build the Virtual File System & Run Dynamic Binaries
  * Implement file-handling system calls (sys_openat, sys_close, sys_fstat).
  * Design the browser-memory data structure to mount the extracted rootfs array layout.
  * Load and execute a standard, dynamically linked binary by allowing it to successfully read its shared C library dependencies (libc.so) out of the virtual file system space.
* Milestone 4: Boot a Live Debian Bash Shell
  * Map advanced operational and environment syscalls (sys_execve, sys_fork illusions, signal handling, terminal ioctl properties).
  * Package and load a comprehensive, minimal Debian shell environment profile.
  * Achieve a fully interactive, responsive Debian terminal interface capable of executing pipeline expressions, managing directories, and testing complex multi-dependency CLI applications natively in the tab.
