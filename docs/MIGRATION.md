# Migration notes (Replit -> Cursor on Windows laptop + Cursor web/mobile)

## Removed (Replit-only or dead)
`.replit`, `replit.nix`, `.replitignore`, `replit.md` (stale template: described an API server/Postgres that no longer exist),
`.replit-artifact/` dirs, `artifacts/mockup-sandbox` (Replit Canvas), all `@replit/*` packages and plugins, the Nix/rustup
workaround notes, `.agents/memory` (converted to `AGENTS.md` + `.cursor/rules`), `scripts/` (its `post-merge.sh` called a `db`
package that was deleted), ~50 unused shadcn/Radix component files, and `engine/target/` (~880 MB of build output that was
tracked in git).

## Changed on purpose
- `pnpm-workspace.yaml`: the Replit file blocked every non-linux-x64 native binary (esbuild, rollup, lightningcss,
  @tailwindcss/oxide) via `overrides`, which breaks Vite on macOS and Windows. Removed.
- `web/vite.config.ts`: plain Vite; no PORT/BASE_PATH env requirement. Layout restored to the spec's `web/`.
- `engine/rust-toolchain.toml` is a real pin now (rustup works on a normal machine).
- Gate/build scripts are Node (`scripts/engine.mjs`), not bash, so they run in PowerShell. Only `fixtures:regenerate`
  needs Linux (it executes the ELF fixtures); it runs in the cloud agent and in CI.
- `web/public/wasm/` is gitignored build output. A prebuilt copy ships in the zip so `pnpm dev` works before Rust is installed.
- New safety nets: `pnpm golden` (asserts every oracle result against the built wasm) and a GitHub Actions CI that runs the
  same gates. They matter because on a phone you review a summary and a green check, not a 2000-line diff.
- Two test assertions `assert!(matches!(x, Err(_)))` became `assert!(x.is_err())` (clippy style). No behavior change.

## A. Windows laptop (PowerShell, no WSL needed)
```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup     # if it says the C++ Build Tools are missing, accept installing them
npm install -g pnpm
# Open a NEW terminal so PATH updates, then:
cargo install wasm-pack --locked   # several minutes
# If pnpm says "running scripts is disabled on this system":
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```
Rust on Windows (MSVC) needs Visual Studio Build Tools with the "Desktop development with C++" workload.
```powershell
cd Chameleon-Shell
pnpm install
pnpm dev               # http://localhost:5173 using the shipped wasm
pnpm engine:check      # drift + fmt + clippy + tests
pnpm engine:build      # rebuilds web/public/wasm from source
pnpm golden            # asserts oracle results
```
`pnpm fixtures:regenerate` cannot run on Windows (it executes Linux ELF files). Skip it locally; CI and cloud agents run it.

## B. GitHub (required by cloud agents)
Create an empty **private** repo on github.com (no README), then:
```powershell
git init -b main
git add -A
git commit -m "Import from Replit: milestone 2a"
git remote add origin https://github.com/<you>/chameleon-shell.git
git push -u origin main
```
Start from this clean tree. The old repo tracks `engine/target/` and `.gitattributes` there referenced Git LFS.
To keep old history instead: clone it, `git filter-repo --path engine/target --invert-paths`, then overlay this tree.
Optional but recommended: in GitHub settings, protect `main` and require the `verify` check before merging.

## C. Cursor cloud agents (web / mobile)
Cloud agents run on an isolated Ubuntu VM, clone the repo from GitHub, work on their own branch and push it; you review
and merge a PR. They read `AGENTS.md` and `.cursor/rules`.
1. In the Cursor dashboard connect GitHub and grant the Cursor GitHub app read-write access to this repo.
2. Open cursor.com/agents on your phone (iOS app, or Android: Chrome > Install app), pick the repo and `main`, give a task.
3. The first run builds `.cursor/Dockerfile` (Node, pnpm, Rust 1.86 + wasm32, wasm-pack, gcc, musl, strace) and snapshots it;
   expect several minutes once. Build logs are visible in the dashboard. If a download fails, check the network allowlist
   there. This Dockerfile is untested: if it fails, use the dashboard's guided setup instead and keep its generated config.
4. Cloud agents are usage-billed on most plans; older Cursor docs also required privacy mode to be off. Check your plan/settings.

## D. Daily loop across both places
- Phone: start an agent with one evidence-driven slice -> it opens a PR on its own branch -> read the 5-line summary and the
  CI check -> merge, or comment a follow-up. "Open in Cursor" moves a branch to the laptop.
- Laptop: `git pull`, work on a branch, same gates, open a PR. Do not point two agents at the same files at once.
- `main` only moves through green PRs. Generated-file conflicts: take either side, run `pnpm generate`.
