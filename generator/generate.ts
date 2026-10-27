// /generator/generate.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

//
// Dev-time only. This script is the source of truth for the fake instruction
// set. It is never shipped to the browser — its only job is to programmatically
// emit /engine/src/generated.rs (a Rust match block) from the data below.
//
// This is the whole point of the "Chameleon Shell" architecture: instruction
// definitions live in one place (here), and the Rust decode/execute logic is
// generated from them rather than hand-written.

interface FakeInstruction {
  name: string;
  opcode: number; // 1-byte opcode
  description: string;
}

const INSTRUCTIONS: FakeInstruction[] = [
  {
    name: "MOV",
    opcode: 0x01,
    description:
      "MOV dst, imm64 — loads an 8-byte little-endian immediate value into a register.",
  },
  {
    name: "ADD",
    opcode: 0x02,
    description: "ADD dst, src — adds the value of src register into dst register.",
  },
  {
    name: "SUB",
    opcode: 0x03,
    description:
      "SUB dst, src — subtracts the value of src register from dst register.",
  },
  {
    name: "LOAD",
    opcode: 0x04,
    description:
      "LOAD dst, imm64 — loads an 8-byte little-endian address into dst, then reads 8 bytes from internal memory at that address into dst.",
  },
  {
    name: "SYSCALL",
    opcode: 0x05,
    description:
      "SYSCALL — invokes a fake syscall. If RAX == 1 (fake sys_write), copies RCX bytes from internal memory starting at address RBX and returns them from run().",
  },
];

function registerEnumVariant(index: number): string {
  const names = ["Rax", "Rbx", "Rcx", "Rdx"];
  return names[index] ?? "Rax";
}

//
// --- Real x86-64 execution semantics (step 1-5 of the "real engine" track) ---
//
// This table describes, for a handful of real x86-64 mnemonics (as decoded by
// iced-x86), what executing that instruction actually *does* to CPU state.
// It is the source of truth for /engine/src/exec_generated.rs — a Rust match
// keyed on iced_x86::Instruction::mnemonic(), generated below rather than
// hand-written.
//

/**
 * A semantic instruction is one of:
 *   - "Halt"  — stops execution (returns Ok(false)).
 *   - A named exec_ops handler function (e.g. "exec_mov") — called as
 *     exec_ops::<handler>(instr, cpu).
 *   - "Jump"  — sets cpu.pending_jump if the condition (a Rust bool expression
 *     on cpu.flags) is met.  jumpCondition === undefined means unconditional.
 *
 * Jump flag-condition reference (classic source of bugs — get these right):
 *   Je  / Jz  → cpu.flags.zf
 *   Jne / Jnz → !cpu.flags.zf
 *   Jl        → cpu.flags.sf != cpu.flags.of   (signed less-than)
 *   Jge       → cpu.flags.sf == cpu.flags.of   (signed greater-or-equal)
 *   Ja        → !cpu.flags.cf && !cpu.flags.zf (unsigned greater-than)
 *   Jae       → !cpu.flags.cf (unsigned greater-or-equal)
 *   Jb        → cpu.flags.cf (unsigned less-than)
 */
interface SemanticInstruction {
  /** Exact iced_x86::Mnemonic enum variant name. */
  mnemonic: string;
  /** Dispatch kind. */
  handler: string | "Halt" | "Jump";
  description: string;
  /**
   * For handler === "Jump": a Rust bool expression evaluated against
   * `cpu.flags`.  Omit (or leave undefined) for an unconditional jump.
   */
  jumpCondition?: string;
}

const SEMANTIC_INSTRUCTIONS: SemanticInstruction[] = [
  {
    mnemonic: "Mov",
    handler: "exec_mov",
    description:
      "MOV dst, src — dst = src. Handles register<->register, register<->memory (both directions), and register<-immediate.",
  },
  {
    mnemonic: "Add",
    handler: "exec_add",
    description:
      "ADD dst, src — dst += src, sets CF/ZF/SF/OF. Register or immediate source, register or memory destination.",
  },
  {
    mnemonic: "Sub",
    handler: "exec_sub",
    description:
      "SUB dst, src — dst -= src, sets CF/ZF/SF/OF. Register or immediate source, register or memory destination.",
  },
  {
    mnemonic: "Cmp",
    handler: "exec_cmp",
    description:
      "CMP dst, src — sets CF/ZF/SF/OF as SUB would, but discards the result (does not write back).",
  },
  {
    mnemonic: "Push",
    handler: "exec_push",
    description:
      "PUSH r64 — decrements RSP by 8 and writes the register value to the stack.",
  },
  {
    mnemonic: "Pop",
    handler: "exec_pop",
    description:
      "POP r64 — reads an 8-byte value from the stack and increments RSP by 8.",
  },
  {
    mnemonic: "Call",
    handler: "exec_call",
    description:
      "CALL rel — pushes the next instruction address, increments call depth, and jumps to the target.",
  },
  {
    mnemonic: "Ret",
    handler: "exec_ret",
    description:
      "RET — returns through the stack when inside a call; at top level, stops execution.",
  },
  {
    mnemonic: "Syscall",
    handler: "dispatch_real_syscall",
    description:
      "SYSCALL — dispatches the real x86-64 Linux syscall ABI and falls through unless exit is requested.",
  },
  {
    mnemonic: "Jmp",
    handler: "Jump",
    description: "JMP rel — unconditional near jump to target address.",
  },
  {
    mnemonic: "Je",
    handler: "Jump",
    jumpCondition: "cpu.flags.zf",
    description: "JE/JZ rel — jump if ZF=1 (result was zero / operands were equal).",
  },
  {
    mnemonic: "Jne",
    handler: "Jump",
    jumpCondition: "!cpu.flags.zf",
    description: "JNE/JNZ rel — jump if ZF=0 (result was non-zero / operands were unequal).",
  },
  {
    mnemonic: "Jl",
    handler: "Jump",
    jumpCondition: "cpu.flags.sf != cpu.flags.of",
    description: "JL/JNGE rel — jump if SF≠OF (signed less-than).",
  },
  {
    mnemonic: "Jge",
    handler: "Jump",
    jumpCondition: "cpu.flags.sf == cpu.flags.of",
    description: "JGE/JNL rel — jump if SF=OF (signed greater-or-equal).",
  },
  {
    mnemonic: "Lea",
    handler: "exec_lea",
    description: "LEA dst, mem — stores the effective address without reading memory.",
  },
  {
    mnemonic: "Xor",
    handler: "exec_xor",
    description: "XOR dst, src — bitwise XOR, clears CF/OF, and sets ZF/SF.",
  },
  {
    mnemonic: "Test",
    handler: "exec_test",
    description: "TEST dst, src — bitwise AND for flags only; dst is unchanged.",
  },
  {
    mnemonic: "Movzx",
    handler: "exec_movzx",
    description: "MOVZX dst, src — reads the source width and zero-extends it into dst.",
  },
  {
    mnemonic: "Mul",
    handler: "exec_mul",
    description: "MUL r/m — unsigned widening multiply into the implicit accumulator pair.",
  },
  {
    mnemonic: "Imul",
    handler: "exec_imul",
    description: "IMUL — signed widening or truncating multiply with overflow flags.",
  },
  {
    mnemonic: "Shr",
    handler: "exec_shr",
    description: "SHR dst, count — logical right shift with x86 shift flags.",
  },
  {
    mnemonic: "Ja",
    handler: "Jump",
    jumpCondition: "!cpu.flags.cf && !cpu.flags.zf",
    description: "JA/JNBE rel — jump if unsigned greater-than.",
  },
  {
    mnemonic: "Jae",
    handler: "Jump",
    jumpCondition: "!cpu.flags.cf",
    description: "JAE/JNB/JNC rel — jump if unsigned greater-or-equal.",
  },
  {
    mnemonic: "Jb",
    handler: "Jump",
    jumpCondition: "cpu.flags.cf",
    description: "JB/JNAE/JC rel — jump if unsigned less-than.",
  },
  {
    mnemonic: "And",
    handler: "exec_and",
    description: "AND dst, src — bitwise AND, clears CF/OF, and sets ZF/SF.",
  },
  {
    mnemonic: "Endbr64",
    handler: "exec_nop",
    description: "ENDBR64 — architectural no-op when CET enforcement is not modeled.",
  },
  {
    mnemonic: "Nop",
    handler: "exec_nop",
    description: "NOP — advances execution without changing state.",
  },
];

/** Emits the Rust match arm body for one semantic instruction. */
function generateDispatchArmBody(instr: SemanticInstruction): string {
  if (instr.handler === "Halt") {
    return "Ok(false)";
  }
  if (instr.handler === "Jump") {
    if (instr.jumpCondition) {
      // Conditional jump: only set pending_jump when the condition is met.
      return `{ if ${instr.jumpCondition} { cpu.pending_jump = Some(instr.near_branch64()); } Ok(true) }`;
    } else {
      // Unconditional jump: always take it.
      return `{ cpu.pending_jump = Some(instr.near_branch64()); Ok(true) }`;
    }
  }
  return `exec_ops::${instr.handler}(instr, cpu)`;
}

function generateExecRustMatchBlock(instructions: SemanticInstruction[]): string {
  const header = `// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
//
// Generated by /generator/generate.ts from a hardcoded semantic-instruction
// table. Re-run \`npx tsx generator/generate.ts\` (or the codegen script) to
// regenerate this file after changing the table.
//
// Mnemonic reference:
${instructions.map((i) => `// ${i.mnemonic.padEnd(8)} — ${i.description}`).join("\n")}

use crate::exec_cpu::ExecCpu;
use crate::exec_ops;
use iced_x86::{Instruction, Mnemonic};

/// The semantic table's implemented mnemonic set, used by coverage reporting.
pub const IMPLEMENTED_MNEMONICS: &[Mnemonic] = &[
${instructions.map((i) => `    Mnemonic::${i.mnemonic},`).join("\n")}
];

pub fn is_implemented(mnemonic: Mnemonic) -> bool {
    IMPLEMENTED_MNEMONICS.contains(&mnemonic)
}

/// Executes a single decoded instruction against \`cpu\`.
/// Returns \`Ok(true)\` if execution should continue, \`Ok(false)\` if the
/// program should halt (e.g. after a RET), or \`Err\` with a clear message on
/// a runtime fault (e.g. an out-of-bounds memory access).
pub fn dispatch(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    match instr.mnemonic() {
`;

  const arms = instructions
    .map((instr) => {
      return `        // ${instr.mnemonic} — ${instr.description}
        Mnemonic::${instr.mnemonic} => ${generateDispatchArmBody(instr)},`;
    })
    .join("\n\n");

  const footer = `

        other => {
            Err(format!("unsupported mnemonic for real execution: {other:?}"))
        }
    }
}
`;

  return header + arms + footer;
}

function generateRustMatchBlock(instructions: FakeInstruction[]): string {
  const header = `// AUTO-GENERATED FILE — DO NOT EDIT BY HAND.
//
// Generated by /generator/generate.ts from a hardcoded instruction table.
// Re-run \`npx tsx generator/generate.ts\` (or the codegen script) to regenerate
// this file after changing the instruction set.
//
// Opcode reference:
${instructions
  .map((i) => `// 0x${i.opcode.toString(16).padStart(2, "0")} ${i.name.padEnd(8)} — ${i.description}`)
  .join("\n")}

use crate::cpu::Cpu;

/// Decode and execute a single instruction starting at \`cpu.pc\`.
/// Returns \`true\` if execution should continue, \`false\` if the program
/// should halt (e.g. after a SYSCALL that has been fully handled).
pub fn step(cpu: &mut Cpu) -> bool {
    let opcode = cpu.fetch_u8();

    match opcode {
`;

  const arms = instructions
    .map((instr) => {
      const constName = `OPCODE_${instr.name}`;
      return `        // ${instr.name} (0x${instr.opcode
        .toString(16)
        .padStart(2, "0")}) — ${instr.description}
        ${constName} => cpu.exec_${instr.name.toLowerCase()}(),`;
    })
    .join("\n\n");

  const footer = `

        other => {
            panic!("unknown opcode: 0x{other:02x}");
        }
    }
}

${instructions
  .map(
    (i) =>
      `pub const OPCODE_${i.name}: u8 = 0x${i.opcode.toString(16).padStart(2, "0")};`
  )
  .join("\n")}
`;

  return header + arms + footer;
}

function main() {
  const rust = generateRustMatchBlock(INSTRUCTIONS);
  const outPath = process.env.GENERATOR_OUTPUT_ROOT
    ? join(process.env.GENERATOR_OUTPUT_ROOT, "engine/src/generated.rs")
    : fileURLToPath(new URL("../engine/src/generated.rs", import.meta.url));
  writeFileSync(outPath, rust, "utf-8");
  console.log(`Generated ${outPath} from ${INSTRUCTIONS.length} instructions.`);

  const execRust = generateExecRustMatchBlock(SEMANTIC_INSTRUCTIONS);
  const execOutPath = process.env.GENERATOR_OUTPUT_ROOT
    ? join(process.env.GENERATOR_OUTPUT_ROOT, "engine/src/exec_generated.rs")
    : fileURLToPath(new URL("../engine/src/exec_generated.rs", import.meta.url));
  writeFileSync(execOutPath, execRust, "utf-8");
  console.log(
    `Generated ${execOutPath} from ${SEMANTIC_INSTRUCTIONS.length} semantic instructions.`
  );
}

main();

// Exported for potential reuse/testing.
export {
  INSTRUCTIONS,
  generateRustMatchBlock,
  registerEnumVariant,
  SEMANTIC_INSTRUCTIONS,
  generateExecRustMatchBlock,
};
