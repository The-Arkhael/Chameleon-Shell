#!/usr/bin/env bash
# Rebuild the ELF test fixtures from their sources into a scratch directory and
# compare BEHAVIOR (stdout + exit code, plus the syscall sequence for libc_startup)
# against the committed oracle files in this directory. The last section re-measures the
# native oracles (libc_startup.steptrace.txt, libc_startup.initial_stack.txt, flags_oracle.txt)
# on this CPU and diffs them against the committed files.
#
# Why behavior and not bytes: compiler/linker versions change section layout,
# alignment and notes, so a rebuilt binary is equivalent but NOT byte-identical.
# The committed binaries here are the authoritative test inputs (the Rust tests
# include_bytes! them, and several tests assert exact instruction counts/addresses
# of THESE binaries). This script therefore never overwrites them; it proves the
# recipes still work and lets you produce candidate replacements.
#
# Needs Linux or WSL2 (native execution of the ELF files is part of the check):
#   gcc, as, ld, musl-gcc (Debian/Ubuntu package: musl-tools); strace is optional.
#   The native-oracle section also needs ptrace (it single-steps libc_startup) and an x86-64 CPU.
#
# Usage: bash engine/tests/fixtures/regenerate.sh [OUTPUT_DIR]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$(mktemp -d)}"
mkdir -p "$OUT"
echo "Rebuilding fixtures into: $OUT"

# --- Recipes -----------------------------------------------------------------
# elf_write_exit: hand-written assembly; the exact original command was not
# recorded, so this is a reconstructed, behavior-equivalent recipe.
build_elf_write_exit() {
  as "$HERE/elf_write_exit.s" -o "$OUT/elf_write_exit.o"
  ld -static -o "$OUT/elf_write_exit" "$OUT/elf_write_exit.o"
}
# sum_squares: freestanding C, real compiler output. Exact flags as originally used.
build_sum_squares() {
  gcc -O2 -ffreestanding -fno-pie -fno-stack-protector \
    -nostdlib -static -no-pie -Wl,-e,_start \
    -o "$OUT/sum_squares" "$HERE/sum_squares.c"
}
# libc_startup: ordinary static musl program (real crt startup, no special flags).
build_libc_startup() {
  musl-gcc -static -o "$OUT/libc_startup" "$HERE/libc_startup.c"
}

# --- Verification ------------------------------------------------------------
fail=0
verify() {
  local name="$1" code=0
  "$OUT/$name" > "$OUT/$name.stdout" || code=$?
  local want_code; want_code="$(tr -d '[:space:]' < "$HERE/$name.exitcode")"
  local status="OK"
  if ! cmp -s "$OUT/$name.stdout" "$HERE/$name.stdout"; then status="STDOUT MISMATCH"; fi
  if [ "$code" != "$want_code" ]; then status="EXIT CODE MISMATCH (got $code, want $want_code)"; fi
  local bytes="bytes differ from committed"
  if cmp -s "$OUT/$name" "$HERE/$name"; then bytes="byte-identical to committed"; fi
  printf '%-16s %-8s exit=%s  (%s)\n' "$name" "$status" "$code" "$bytes"
  [ "$status" = "OK" ] || fail=1
}

for name in elf_write_exit sum_squares libc_startup; do
  "build_$name"
  verify "$name"
done

if command -v strace >/dev/null 2>&1; then
  syscalls() { sed -E '/\+\+\+/d; s/^[0-9]+ +//; s/\(.*//' "$1"; }
  strace -f -o "$OUT/libc_startup.strace.txt" "$OUT/libc_startup" >/dev/null
  if diff <(syscalls "$OUT/libc_startup.strace.txt") <(syscalls "$HERE/libc_startup.strace.txt") >/dev/null; then
    echo "libc_startup     syscall sequence matches committed strace: $(syscalls "$OUT/libc_startup.strace.txt" | tr '\n' ' ')"
  else
    echo "libc_startup     SYSCALL SEQUENCE DIFFERS from committed strace"; fail=1
  fi
else
  echo "(strace not installed: skipped syscall-sequence check)"
fi

# --- Native oracles: measurements taken on the real CPU ------------------------
# nativetrace.c single-steps the COMMITTED libc_startup (the committed trace belongs to those
# exact bytes; a rebuilt binary may differ) on a stack it builds itself, then folds the repeated
# addresses of `rep` iterations. flags_oracle.c runs single NEG/SHR/SAR instructions natively.
# Neither output holds a timestamp or machine name, so the check is a diff of the non-comment lines.
if [ "$(uname -sm)" = "Linux x86_64" ] && command -v gcc >/dev/null 2>&1; then
  same() {  # name, regenerated file, committed file
    if diff <(grep -v '^#' "$2") <(grep -v '^#' "$3") >/dev/null; then echo "$1 matches the committed file"
    else echo "$1 DIFFERS from the committed file: diff <(grep -v '^#' $2) <(grep -v '^#' $3)"; fail=1; fi
  }
  # Default PIE is deliberate for nativetrace: the guest lives at 0x400000, so the tool must not.
  gcc -O1 -g -Wall -Wextra -o "$OUT/nativetrace" "$HERE/nativetrace.c"
  gcc -O1 -mno-red-zone -Wall -Wextra -o "$OUT/flags_oracle" "$HERE/flags_oracle.c"
  if "$OUT/nativetrace" --custom --trace "$OUT/libc_startup.rawtrace.txt" --stack "$OUT/libc_startup.initial_stack.txt" \
       "$HERE/libc_startup" /bin/prog >/dev/null; then
    awk '$2 != prev { print $2 } { prev = $2 }' "$OUT/libc_startup.rawtrace.txt" > "$OUT/libc_startup.steptrace.txt"
    same libc_startup.steptrace "$OUT/libc_startup.steptrace.txt" "$HERE/libc_startup.steptrace.txt"
    same libc_startup.initial_stack "$OUT/libc_startup.initial_stack.txt" "$HERE/libc_startup.initial_stack.txt"
  else
    echo "nativetrace FAILED (is ptrace permitted here?)"; fail=1
  fi
  "$OUT/flags_oracle" > "$OUT/flags_oracle.txt"
  same flags_oracle "$OUT/flags_oracle.txt" "$HERE/flags_oracle.txt"
else
  echo "(not x86-64 Linux with gcc: skipped the native-oracle check)"
fi

exit "$fail"
