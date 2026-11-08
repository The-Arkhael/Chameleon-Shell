---
name: wasm-runtime-boundary
description: >-
  Use when planning, implementing, reviewing or debugging anything that crosses
  the Rust, WebAssembly, JavaScript and browser boundary in Chameleon-Shell:
  #[wasm_bindgen] exports and their types, wasm-pack builds and the copy into
  web/public/wasm, the generated glue, module loading and initialization in
  web/src/App.tsx (blob-URL import), Uint8Array and String data crossing, panics
  surfacing as RuntimeError, memory growth and step limits, terminal input and
  output, and any Worker, SharedArrayBuffer, Atomics, CSP or cross-origin
  isolation change. Includes a boundary contract checker. Not for instruction
  semantics or ELF and syscall behavior.
---

# wasm-runtime-boundary

A standing procedure for keeping the Rust engine, the generated wasm, the glue, and the browser page consistent as exports, limits and loaders evolve. Evidence tags: `[spec]`, `[doc]` (MDN/tool docs), `[observed]` (read or measured here), `[project]`, `[hypothesis]`. The current export list, import list and consumers are derived by `scripts/boundary-check.mjs`; the architecture description in `references/boundary-facts.md` separates stable constraints from a dated snapshot.

## Consult this skill when

- **Planning**: adding or removing an export, moving execution off the main thread, changing the loader, tightening CSP, adding isolation headers, upgrading wasm-bindgen/wasm-pack, adding terminal input.
- **Implementing**: any edit to `engine/src/lib.rs` exports, `web/src/App.tsx` loading or calls, `scripts/engine.mjs`/`scripts/golden.mjs`, `web/vite.config.ts`, `web/index.html`.
- **Debugging**: `RuntimeError: unreachable`, "failed to fetch/instantiate wasm", MIME or CSP errors, stale-build symptoms, behavior that differs between `cargo test` and the browser, UI freezes.
- **Reviewing**: any diff touching the boundary files, or claiming browser behavior.

## Standing invariants

1. **One build**: the glue, `.wasm` and `.d.ts` come from the same `pnpm engine:build`; never hand-edit, mix, or commit them (`web/public/wasm/` is build output).
2. **The import list is the host-capability surface.** The wasm module may import only what the allowlist in `scripts/boundary-check.mjs` names; a new import needs a security review first (`browser-sandbox-security`).
3. **Exports are attack surface and contract.** Every export has a consumer, a stable error prefix, and no reachable panic; unused exports are removed or documented.
4. **No browser claim without a browser.** If you could not run the page, say "not verified in a browser" and name the loaders affected (blob import, wasm compile, xterm styles, fonts, dev client).
5. **Boundary data is copied, memory grows, panics trap.** Never cache views of wasm memory across calls; cap sizes before calling; treat a trap as the end of that instance.
6. **Current requirement versus future redesign.** Workers, `SharedArrayBuffer`, CSP and isolation are design questions with cross-cutting effects (dev server, production host, wrapper, fonts). Do not change them as a side effect of another task.

## Workflow

### 1. Orient

- `node .cursor/skills/wasm-runtime-boundary/scripts/boundary-check.mjs` (add `--print-imports` to see the import surface): checks Rust exports vs the built `.d.ts` vs the real wasm exports, type mapping, consumers (`web/src/App.tsx`, `scripts/golden.mjs`), and the import allowlist. It needs a built wasm; if absent run `pnpm engine:build` (Rust and wasm-pack required, otherwise say it was not run).
- Read the load path in `web/src/App.tsx` and `scripts/golden.mjs` before changing anything that either relies on.

### 2. Plan

State which procedure applies (`references/boundary-facts.md`: A add/change/remove an export, B bigger data, C Worker, D CSP/isolation, E replace the blob loader, F toolchain upgrade, G terminal input), the consumers affected, what must be tested in a browser, and what stays unchanged.

### 3. Implement

Change the Rust export, rebuild, then update consumers. Keep errors as strings with stable prefixes. Prefer removing a dead export to keeping it. Keep CSP, header and loader changes in their own change with their own verification.

### 4. Verify

`pnpm engine:build` then `node .cursor/skills/wasm-runtime-boundary/scripts/boundary-check.mjs`, `pnpm typecheck`, `pnpm golden`; for web changes `pnpm --filter @chameleon/web build` (CI runs it) and, when a browser is available, `pnpm dev` and a manual run. For failures: a boundary-check ERROR names the mismatching artifact; `RuntimeError: unreachable` means a panic (reproduce natively with `cargo test`, use `panic-sites.mjs` from `chameleon-rust`); a loader error is usually blob/CSP/MIME/`module_or_path`.

### 5. Review mode

A **defect** is: a stale or mixed artifact; an export with no consumer or no test; a new import without review; a reachable panic or unbounded input/output at the boundary; a CSP/loader/Worker/header change without testing each loader and both dev and build; a claim verified only natively; docs not updated. Gather evidence from the checker, golden output and a browser run when possible; label confirmed / likely / question.

### 6. Record

Update `docs/STATUS.md` (boundary contract, limits, loader notes) and the SNAPSHOT in `references/boundary-facts.md`; if the allowlist changed, say who reviewed it and why.

## Related skills (each stands alone)

`chameleon-rust` (Rust side), `browser-sandbox-security` (imports, input caps, CSP risk), `emulator-performance` (copy and call overhead), `differential-emulation-testing` (golden and wasm-level checks), `typescript-codegen` (not the web app; the generator only).

## References and scripts

- `references/boundary-facts.md`: stable constraints, change procedures A-G, review checklist, dated snapshot.
- `scripts/boundary-check.mjs`: derives the contract and enforces the import allowlist.

## Sources

- wasm-bindgen reference: <https://rustwasm.github.io/wasm-bindgen/>
- MDN WebAssembly: <https://developer.mozilla.org/en-US/docs/WebAssembly/Concepts>; `WebAssembly.Memory` <https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory>
- MDN CSP `script-src` (including `'wasm-unsafe-eval'`): <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src>
- MDN `SharedArrayBuffer` and cross-origin isolation requirements: <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer>; `Atomics.wait` <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait>
- WebAssembly CSP proposal: <https://github.com/WebAssembly/content-security-policy/blob/main/proposals/CSP.md>
- wasm-pack: <https://rustwasm.github.io/wasm-pack/>
