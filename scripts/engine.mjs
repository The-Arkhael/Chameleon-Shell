#!/usr/bin/env node
// Cross-platform engine tasks (Windows PowerShell, macOS, Linux). No bash required.
//
//   node scripts/engine.mjs check   generator drift + cargo fmt --check + clippy + cargo test
//   node scripts/engine.mjs test    cargo test only
//   node scripts/engine.mjs build   check, then wasm-pack build, then copy to web/public/wasm
//
// Extra arguments after `build` go to wasm-pack (e.g. --dev). SKIP_CHECKS=1 skips the gates in `build`.
// cargo always runs with cwd = engine/ so rustup honors engine/rust-toolchain.toml.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(repoRoot, "engine");
const GENERATED = ["generated.rs", "exec_generated.rs"];

const HINTS = {
  cargo: "Install Rust from https://rustup.rs, then open a new terminal.",
  rustup: "Install Rust from https://rustup.rs, then open a new terminal.",
  "wasm-pack": "Install it with: cargo install wasm-pack --locked (takes several minutes).",
};

function fail(message) {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

function run(label, cmd, args, options = {}) {
  console.log(`\n> ${label}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { cwd: engineDir, stdio: "inherit", ...options });
  if (result.error) {
    if (result.error.code === "ENOENT") fail(`'${cmd}' was not found on PATH. ${HINTS[cmd] ?? ""}`);
    fail(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) fail(`${label} failed (exit code ${result.status}).`);
  console.log(`ok  ${label}`);
}

const normalize = (buffer) => buffer.toString("utf8").replace(/\r\n/g, "\n");

function checkGeneratorDrift() {
  console.log("\n> generator drift check");
  const tmp = mkdtempSync(join(tmpdir(), "chameleon-gen-"));
  try {
    mkdirSync(join(tmp, "engine", "src"), { recursive: true });
    const result = spawnSync(process.execPath, ["--import", "tsx", "generator/generate.ts"], {
      cwd: repoRoot,
      env: { ...process.env, GENERATOR_OUTPUT_ROOT: tmp },
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.error || result.status !== 0) {
      fail("the generator failed to run. Did you run `pnpm install` at the repo root?");
    }
    for (const file of GENERATED) {
      const committed = normalize(readFileSync(join(engineDir, "src", file)));
      const fresh = normalize(readFileSync(join(tmp, "engine", "src", file)));
      if (committed !== fresh) {
        fail(`engine/src/${file} is stale relative to generator/generate.ts. Run: pnpm generate`);
      }
    }
    console.log("ok  generator drift check");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function check() {
  checkGeneratorDrift();
  run("rustfmt", "cargo", ["fmt", "--all", "--", "--check"]);
  run("clippy", "cargo", ["clippy", "--all-targets", "--", "-D", "clippy::correctness", "-D", "clippy::suspicious"]);
  run("cargo test", "cargo", ["test"]);
}

function build(extraArgs) {
  if (process.env.SKIP_CHECKS !== "1") check();
  run("wasm-pack", "wasm-pack", ["build", "--target", "web", ...extraArgs]);
  const destination = join(repoRoot, "web", "public", "wasm");
  mkdirSync(destination, { recursive: true });
  for (const file of ["chameleon_engine_bg.wasm", "chameleon_engine.js", "chameleon_engine.d.ts"]) {
    const source = join(engineDir, "pkg", file);
    if (!existsSync(source)) fail(`wasm-pack did not produce ${file}`);
    copyFileSync(source, join(destination, file));
  }
  console.log("ok  copied wasm output to web/public/wasm");
}

const [command, ...rest] = process.argv.slice(2);
if (command === "check") check();
else if (command === "test") run("cargo test", "cargo", ["test"]);
else if (command === "build") build(rest);
else fail("usage: node scripts/engine.mjs <check|test|build> [wasm-pack args]");
