# Boundary facts, change procedures and design constraints

Evidence tags: `[spec]` WebAssembly/browser specifications, `[doc]` MDN or tool documentation, `[observed]` read or measured in this repo, `[project]` repo decision, `[hypothesis]` unverified. The current export list, import list and consumers are derived by `scripts/boundary-check.mjs`; the dated snapshot at the end is perishable.

## How the pieces connect (stable architecture) `[observed]`

1. `engine/src/lib.rs` exposes `#[wasm_bindgen]` functions. `wasm-pack build --target web` (run by `pnpm engine:build`) writes `chameleon_engine.js` (glue), `chameleon_engine_bg.wasm`, `chameleon_engine.d.ts` into `engine/pkg/`; `scripts/engine.mjs` copies those three into `web/public/wasm/` (gitignored build output).
2. `web/src/App.tsx` fetches the glue as **text**, makes a Blob URL, loads it with a dynamic `import(/* @vite-ignore */ blobUrl)` (files in `public/` cannot be imported as module specifiers through Vite's dev pipeline), then calls `engine.default({ module_or_path: <wasm url> })`. Because the module's `import.meta.url` is the blob URL, the glue's default relative wasm path cannot resolve: the explicit `module_or_path` is required.
3. `scripts/golden.mjs` loads the same glue in Node with `initSync({ module: bytes })` and checks the built wasm against the committed fixtures.
4. All engine calls are **synchronous on the calling thread**. The only bound on a run is the engine's step limit. No Worker, `SharedArrayBuffer`, `Atomics`, COOP/COEP headers, or CSP exists in the shipped web app, and the terminal is output-only (no input handler).
5. The generated glue copies data across the boundary: `&[u8]` arguments are copied into wasm memory (`passArray8ToWasm0` with `__wbindgen_malloc`) and freed after the call; `String` results are read out and freed; `Vec<u8>` results become a fresh `Uint8Array`. `[observed]` in the glue; wasm-bindgen documents the same model `[doc]`.

## Stable constraints

- Panics: on `wasm32-unknown-unknown` a Rust panic aborts the call as `RuntimeError: unreachable` and carries no message `[observed]`. After a trap, do not keep using the same instance; re-instantiate (`browser-sandbox-security` probes do this) `[hypothesis]`. Every reachable panic is a user-visible bug (see `chameleon-rust`).
- `usize` is 32-bit in the shipped wasm and 64-bit in native tests: conversions of guest `u64` values and their error text can differ between `cargo test` and the wasm.
- Wasm memory can grow but never shrinks `[spec]`; growing detaches earlier `ArrayBuffer` views of `memory.buffer` `[doc: MDN WebAssembly.Memory]`. Never cache a view across a call into wasm.
- The glue, the `.wasm` and the `.d.ts` must come from one build: the glue calls wasm exports by generated names and layouts. Never hand-edit or partially replace them; `scripts/boundary-check.mjs` detects mixed builds by comparing the three.
- The wasm module's import list is its host-capability surface. Today it asks the host for nothing but the externref-table initializer. A new import is a new capability: it needs a security review before `ALLOWED_IMPORTS` in `scripts/boundary-check.mjs` is edited.
- Streaming instantiation requires the server to send `Content-Type: application/wasm` `[doc: MDN]`; `initSync` (Node, tests) needs the bytes.
- `import(blobUrl)` needs `blob:` in `script-src`, compiling wasm under a CSP needs `'wasm-unsafe-eval'` `[doc: MDN script-src]`. The xterm terminal injects styles, so a strict `style-src` needs `'unsafe-inline'` or a nonce approach (the repo's STATUS notes it measured this in Chromium) `[project]`. Google Fonts are loaded from external hosts by `index.html`, which any strict CSP must allow or replace.
- `SharedArrayBuffer` is available only in a cross-origin-isolated page: `Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) `[doc: MDN SharedArrayBuffer]`. `Atomics.wait` is not allowed on the main thread of a page; it is a worker-side primitive `[doc: MDN Atomics.wait]`. Isolation also affects every cross-origin resource the page loads (fonts, images).

## Change procedures

**A. Add, change or remove an export**

1. Edit `engine/src/lib.rs` (types the glue supports; `&[u8]`, `Vec<u8>`, `String` are what exist today). Keep errors as strings with a stable prefix (`chameleon-rust`).
2. `pnpm engine:build`, then `node .cursor/skills/wasm-runtime-boundary/scripts/boundary-check.mjs`. It must report matching Rust, `.d.ts` and wasm exports, no unknown consumers, and no new imports.
3. Update consumers (`web/src/App.tsx`, `scripts/golden.mjs`), then `pnpm typecheck` and `pnpm golden`. Remove dead exports instead of keeping them: every export is attack surface.
4. Update `docs/STATUS.md` if the contract the docs describe changed.

**B. Pass bigger or more frequent data**: each call copies in and out, so peak memory is roughly twice the payload plus the engine's own buffers. Cap input size before calling (`browser-sandbox-security`) and measure with `emulator-performance`.

**C. Move execution to a Worker** (for cancellation or blocking `read`): design first. Cover: module loading inside the worker (the blob-URL trick, `worker-src` under a CSP), message protocol and transfer of `ArrayBuffer`s, `terminate()` as the cancellation mechanism, output streaming instead of a single string, whether blocking stdin truly needs `SharedArrayBuffer` plus `Atomics.wait` (which forces cross-origin isolation for dev server, production host and any wrapper) or can use an asynchronous protocol, error and trap reporting across `postMessage`. Do not change CSP, headers or loading as a side effect.

**D. Tighten CSP or add isolation headers**: list every current loader (blob import, wasm compile, xterm styles, fonts, Vite dev client and HMR in `pnpm dev`) and test both `pnpm dev` and the production build output (`pnpm --filter @chameleon/web build`); state which were tested in a browser and which were not.

**E. Replace the blob-URL loader** (STATUS notes this is needed before any desktop wrapper): choose a bundler-friendly import or a different wasm-pack target deliberately; re-check `module_or_path`, `base` URLs, golden's `initSync` use, and CSP.

**F. Upgrade wasm-bindgen or wasm-pack**: the glue and the wasm schema must come from matching versions; change `engine/Cargo.lock`, CI and `.cursor/Dockerfile` together, rebuild, run `boundary-check`, `golden`, and the web build. Not a drive-by.

**G. Terminal input**: today output-only. Input implies a read path into the guest (`read` syscall design) and a buffering/limit policy: treat it as a new untrusted input channel.

## Review checklist

A **defect** is: an export changed without rebuilding or without updating consumers; a hand-edited or mixed-build artifact; a new wasm import or host capability without review; a panic reachable from an export; unbounded input or output across the boundary; a CSP/header/loader change without testing the loaders above; behavior verified only natively; an unverified browser claim. Evidence: the checker output, `pnpm golden`, and a browser run when one was possible (say when it was not).

## SNAPSHOT (audit date 2026-10-27): what existed

Perishable: regenerate with `boundary-check.mjs` and update when it changes.

- Ten exports: `run` (legacy toy ISA, panics on malformed bytes), `disassemble`, `parse_elf`, `execute`, `run_elf`, `coverage_report`, `embedded_elf`, `embedded_sum_squares`, `self_test`, `loop_test`; one allowlisted import. `parse_elf` had no consumer in `App.tsx` or `golden.mjs`.
- No Worker, `SharedArrayBuffer`, CSP, or isolation headers; terminal output-only; engine memory is a fresh 16 MiB buffer per run; first call in a fresh instance was much slower than later calls (see `emulator-performance`).
