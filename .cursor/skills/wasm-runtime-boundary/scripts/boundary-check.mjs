#!/usr/bin/env node
// Checks the Rust <-> wasm <-> JavaScript contract of the engine. Re-run it every time an export, a type,
// the wasm build, or a consumer (web/src/App.tsx, scripts/golden.mjs) changes.
//   node .cursor/skills/wasm-runtime-boundary/scripts/boundary-check.mjs [--wasm-dir <dir>] [--consumer <file>]... [--print-imports]
//
// Compares: #[wasm_bindgen] exports in engine/src/lib.rs, the generated .d.ts, the real wasm module exports and
// imports, and every `engine.<name>(` call in the known consumers. Also enforces the wasm IMPORT ALLOWLIST: the
// engine currently asks the host for nothing but the wasm-bindgen externref table initializer. A new import is a
// new host capability and needs a security review (browser-sandbox-security skill) before this list is edited.
// Exit code 1 on any ERROR.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opts = (n) => argv.flatMap((a, i) => (a === `--${n}` ? [argv[i + 1]] : []));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const wasmDir = resolve(opts("wasm-dir")[0] ?? join(root, "web", "public", "wasm"));
const consumers = ["web/src/App.tsx", "scripts/golden.mjs", ...opts("consumer")].map((p) => resolve(root, p));
// POLICY SNAPSHOT: edit only together with a security review of the new host capability.
const ALLOWED_IMPORTS = new Set(["./chameleon_engine_bg.js::__wbindgen_init_externref_table"]);

const errors = [];
const infos = [];
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const lib = read(join(root, "engine", "src", "lib.rs"));
const rustTypeMap = { "&[u8]": "Uint8Array", "Vec<u8>": "Uint8Array", String: "string", "&str": "string" };

const rust = new Map();
for (const m of lib.matchAll(/#\[wasm_bindgen[^\]]*\]\s*pub fn (\w+)\s*\(([^)]*)\)\s*(?:->\s*([^{]+?))?\s*\{/g)) {
  rust.set(m[1], { params: m[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split(":").slice(1).join(":").trim()), ret: (m[3] ?? "").trim() });
}
const dtsPath = join(wasmDir, "chameleon_engine.d.ts");
const wasmPath = join(wasmDir, "chameleon_engine_bg.wasm");
const gluePath = join(wasmDir, "chameleon_engine.js");
for (const p of [dtsPath, wasmPath, gluePath]) if (!existsSync(p)) errors.push(`missing build artifact ${p} (run \`pnpm engine:build\`)`);
if (errors.length) {
  errors.forEach((e) => console.log(`ERROR: ${e}`));
  process.exit(1);
}
const dts = new Map();
for (const m of read(dtsPath).matchAll(/^export function (\w+)\(([^)]*)\): ([^;]+);/gm)) {
  if (["initSync", "default"].includes(m[1])) continue;
  dts.set(m[1], { params: m[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split(":").slice(1).join(":").trim()), ret: m[3].trim() });
}
const mod = new WebAssembly.Module(readFileSync(wasmPath));
const wasmExports = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
const wasmImports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);

console.log(`Rust exports (${rust.size}): ${[...rust.keys()].join(", ")}`);
for (const n of rust.keys()) if (!dts.has(n)) errors.push(`export ${n} is in lib.rs but not in the built .d.ts: the artifacts are stale, rebuild`);
for (const n of dts.keys()) if (!rust.has(n)) errors.push(`export ${n} is in the built .d.ts but no longer in lib.rs: stale artifacts`);
for (const n of dts.keys()) if (!wasmExports.has(n)) errors.push(`.d.ts declares ${n} but the wasm module does not export it: glue and wasm come from different builds`);
for (const [n, r] of rust) {
  const d = dts.get(n);
  if (!d) continue;
  const mapped = r.params.map((t) => rustTypeMap[t] ?? `?${t}`);
  if (mapped.length !== d.params.length) errors.push(`${n}: parameter count differs (Rust ${mapped.length}, .d.ts ${d.params.length})`);
  const want = rustTypeMap[r.ret] ?? (r.ret === "" ? "void" : `?${r.ret}`);
  if (want.startsWith("?")) infos.push(`${n}: return type ${r.ret} is not covered by this script's type map; review the .d.ts by hand`);
  else if (want !== d.ret) errors.push(`${n}: return type differs (Rust ${r.ret} -> expected ${want}, .d.ts ${d.ret})`);
  mapped.forEach((t, i) => {
    if (t.startsWith("?")) infos.push(`${n}: parameter type ${r.params[i]} is not covered by this script's type map`);
    else if (d.params[i] !== undefined && !d.params[i].startsWith(t)) errors.push(`${n}: parameter ${i} differs (Rust ${r.params[i]} -> ${t}, .d.ts ${d.params[i]})`);
  });
}
const used = new Map();
for (const c of consumers) {
  if (!existsSync(c)) {
    infos.push(`consumer not found, skipped: ${c}`);
    continue;
  }
  for (const m of read(c).matchAll(/\bengine\.([A-Za-z_]\w*)\b/g)) {
    if (["default", "initSync"].includes(m[1])) continue;
    used.set(m[1], [...(used.get(m[1]) ?? []), c.replace(root, "").replace(/^[\\/]/, "")]);
  }
}
for (const [n, files] of used) if (!rust.has(n)) errors.push(`${[...new Set(files)].join(", ")} use engine.${n}, which lib.rs does not export`);
const unused = [...rust.keys()].filter((n) => !used.has(n));
if (unused.length) infos.push(`exports no known consumer calls: ${unused.join(", ")} (every export is attack surface: remove it or document who uses it)`);

if (argv.includes("--print-imports")) console.log(`wasm imports: ${wasmImports.join(", ") || "(none)"}`);
for (const i of wasmImports) if (!ALLOWED_IMPORTS.has(i)) errors.push(`NEW HOST CAPABILITY imported by the wasm module: ${i} (needs a security review before it is allowlisted)`);
console.log(`wasm imports: ${wasmImports.length} (${wasmImports.every((i) => ALLOWED_IMPORTS.has(i)) ? "all allowlisted" : "NOT all allowlisted"}); wasm exports: ${[...wasmExports].filter((n) => !n.startsWith("__")).join(", ")}`);
for (const i of infos) console.log(`info:  ${i}`);
for (const e of errors) console.log(`ERROR: ${e}`);
console.log(errors.length ? `boundary check FAILED (${errors.length} error(s))` : "boundary check OK");
process.exit(errors.length ? 1 : 0);
