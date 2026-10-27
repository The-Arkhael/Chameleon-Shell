// Chameleon Shell — Milestone 1 engine.
//
// A tiny virtual CPU compiled to WebAssembly. This is NOT a real x86_64
// interpreter yet — it understands exactly 5 fake instructions (see
// generated.rs, which is generated from /generator/generate.ts) and exposes
// a single `run()` entry point to the browser.

mod cpu;
mod exec_cpu;
#[rustfmt::skip]
mod exec_generated;
mod elf;
mod exec_ops;
#[rustfmt::skip]
mod generated;
mod self_test;

use cpu::Cpu;
use elf::{load_segments, parse_elf_bytes, ParsedElf};
use exec_cpu::{CompletionPath, ExecCpu};
use iced_x86::{
    Decoder, DecoderOptions, FlowControl, Formatter, Instruction, NasmFormatter, Register,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use wasm_bindgen::prelude::*;

/// Size of the fake internal memory buffer instructions can read from.
const MEMORY_SIZE: usize = 256;

/// Runs a fake-instruction program until SYSCALL halts it.
///
/// `program` is a byte stream encoding MOV / ADD / SUB / LOAD / SYSCALL
/// instructions (see generated.rs for opcode values and operand layout).
///
/// The fake syscall convention (RAX == 1, i.e. sys_write) copies RCX bytes
/// from the internal memory buffer starting at address RBX and returns them
/// here. The internal memory buffer is pre-seeded with a demo message at a
/// fixed address so Milestone 1 has something real to print end-to-end.
#[wasm_bindgen]
pub fn run(program: &[u8]) -> Vec<u8> {
    let mut memory = vec![0u8; MEMORY_SIZE];

    // Seed the demo message into memory at a fixed address (0) so a program
    // can MOV the address/length into registers and trigger the fake
    // sys_write syscall to read it back out.
    let message = b"Hello from Chameleon Shell\n";
    memory[0..message.len()].copy_from_slice(message);

    let mut vcpu = Cpu::new(program, memory);

    while vcpu.has_next() {
        let keep_running = generated::step(&mut vcpu);
        if !keep_running {
            break;
        }
    }

    vcpu.output
}

/// Disassembles a buffer of real x86-64 machine code using iced-x86.
///
/// This is standalone decoding only — nothing here executes the bytes. It's
/// step 1 towards a real x86-64 engine, run alongside (not replacing) the
/// Milestone 1 fake-instruction `run()` above.
///
/// Returns one formatted line per decoded instruction, joined with `\n`.
#[wasm_bindgen]
pub fn disassemble(code: &[u8]) -> String {
    disassemble_at(code, 0x0000)
}

fn disassemble_at(code: &[u8], ip: u64) -> String {
    let mut decoder = Decoder::with_ip(64, code, ip, DecoderOptions::NONE);
    let mut formatter = NasmFormatter::new();
    let mut output = String::new();
    let mut line = String::new();

    while decoder.can_decode() {
        let instruction = decoder.decode();
        line.clear();
        formatter.format(&instruction, &mut line);
        output.push_str(&format!("{:04X}  {}\n", instruction.ip(), line));
    }

    output
}

/// Parses an ELF file without loading or executing it.
///
/// The report contains the entry point and every PT_LOAD segment's file
/// offset, virtual address, file size, memory size, and executable flag.
#[wasm_bindgen]
pub fn parse_elf(bytes: &[u8]) -> String {
    match elf::parse_elf_bytes(bytes) {
        Ok(parsed) => parsed.report(),
        Err(message) => format!("ELF parse error: {message}"),
    }
}

/// Decodes and executes `bytes` against a fresh `ExecCpu`, stopping on the
/// first halting instruction (top-level RET or real exit syscall) or the first
/// runtime fault (e.g. an out-of-bounds memory access).
///
/// Shared by `execute()` and `self_test()` so both run the exact same
/// decode/dispatch loop.
pub(crate) fn run_exec_program(bytes: &[u8]) -> Result<ExecCpu, String> {
    run_exec_program_with_setup(bytes, |_| Ok(()))
}

pub(crate) fn run_exec_program_with_setup(
    bytes: &[u8],
    setup: impl FnOnce(&mut ExecCpu) -> Result<(), String>,
) -> Result<ExecCpu, String> {
    run_exec_program_segments_with_setup(&[(bytes, 0x0000)], 0x0000, setup)
}

fn format_instruction(instruction: &Instruction) -> String {
    let mut formatter = NasmFormatter::new();
    let mut text = String::new();
    formatter.format(instruction, &mut text);
    text
}

fn with_execution_trace(message: String, trace: &VecDeque<String>) -> String {
    let trace_text = if trace.is_empty() {
        "  (none)".to_string()
    } else {
        trace
            .iter()
            .map(|entry| format!("  {entry}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!("{message}\nExecution trace (last 16 instructions):\n{trace_text}")
}

fn decode_segments(segments: &[(&[u8], u64)]) -> Vec<Instruction> {
    let mut instructions = Vec::new();
    for (bytes, ip) in segments {
        let mut decoder = Decoder::with_ip(64, bytes, *ip, DecoderOptions::NONE);
        while decoder.can_decode() {
            instructions.push(decoder.decode());
        }
    }
    instructions
}

fn run_exec_program_segments_with_setup(
    segments: &[(&[u8], u64)],
    entry: u64,
    setup: impl FnOnce(&mut ExecCpu) -> Result<(), String>,
) -> Result<ExecCpu, String> {
    const MAX_EXEC_STEPS: usize = 100_000;

    let instructions = decode_segments(segments);

    let address_to_index = instructions
        .iter()
        .enumerate()
        .map(|(index, instruction)| (instruction.ip(), index))
        .collect::<HashMap<_, _>>();
    let mut cpu = ExecCpu::new();
    let mut trace = VecDeque::with_capacity(16);
    setup(&mut cpu).map_err(|message| with_execution_trace(message, &trace))?;
    let mut pc = match address_to_index.get(&entry) {
        Some(index) => *index,
        None if instructions.is_empty() => 0,
        None => {
            return Err(format!(
                "entry point 0x{entry:X} is not an instruction in an executable segment"
            ))
        }
    };
    let mut steps = 0usize;

    while pc < instructions.len() {
        if steps >= MAX_EXEC_STEPS {
            return Err(with_execution_trace(
                format!("execution step limit ({MAX_EXEC_STEPS}) reached; program may be looping"),
                &trace,
            ));
        }
        steps += 1;

        cpu.pending_jump = None;
        let instruction = &instructions[pc];
        let instruction_text = format_instruction(instruction);
        if trace.len() == 16 {
            trace.pop_front();
        }
        trace.push_back(format!("0x{:X}: {}", instruction.ip(), instruction_text));
        if instruction.is_invalid() {
            return Err(with_execution_trace(
                format!("undecodable bytes at 0x{:X}", instruction.ip()),
                &trace,
            ));
        }
        if !exec_generated::is_implemented(instruction.mnemonic()) {
            return Err(with_execution_trace(
                format!(
                    "unimplemented instruction: mnemonic={:?}, address=0x{:X}, instruction={instruction_text}",
                    instruction.mnemonic(),
                    instruction.ip(),
                ),
                &trace,
            ));
        }
        let flow_control = instruction.flow_control();
        let keep_running = match exec_generated::dispatch(instruction, &mut cpu) {
            Ok(keep_running) => keep_running,
            Err(message) => {
                let message = if message.starts_with("unsupported syscall:") {
                    message
                } else {
                    format!(
                        "unimplemented instruction: mnemonic={:?}, address=0x{:X}, instruction={instruction_text}; reason: {message}",
                        instruction.mnemonic(),
                        instruction.ip(),
                    )
                };
                return Err(with_execution_trace(message, &trace));
            }
        };
        if !keep_running {
            if cpu.completion.is_none() {
                cpu.completion = Some(CompletionPath::TopLevelRet);
            }
            break;
        }

        if matches!(
            flow_control,
            FlowControl::UnconditionalBranch
                | FlowControl::ConditionalBranch
                | FlowControl::Call
                | FlowControl::Return
        ) {
            if let Some(target) = cpu.pending_jump.take() {
                pc = match address_to_index.get(&target) {
                    Some(index) => *index,
                    None => {
                        return Err(with_execution_trace(
                            format!(
                                "branch target 0x{target:X} is not an instruction in this program"
                            ),
                            &trace,
                        ))
                    }
                };
            } else {
                pc += 1;
            }
        } else {
            pc += 1;
        }
    }

    Ok(cpu)
}

/// Actually executes a buffer of real x86-64 machine code, as opposed to
/// `disassemble()`'s decode-only view.
///
/// Decodes the same way `disassemble()` does, then dispatches each decoded
/// instruction to the generated semantic handlers in `exec_generated.rs`,
/// mutating a real `ExecCpu` (full 16-register GP file + 16 MiB of memory).
/// Stops on RET.
///
/// Supports the four modeled arithmetic flags, a real stack, direct
/// conditional/unconditional branches and calls, and the modeled Linux
/// `read`, `write`, `brk`, and `exit` syscalls. ELF loading is exposed
/// separately through `run_elf()`.
#[wasm_bindgen]
pub fn execute(bytes: &[u8]) -> String {
    match run_exec_program(bytes) {
        Ok(cpu) => format!(
            "EAX = {}",
            cpu.get_register(Register::EAX)
                .expect("EAX is a general-purpose register")
        ),
        Err(message) => format!("Execution error: {message}"),
    }
}

fn run_elf_bytes(bytes: &[u8]) -> Result<String, String> {
    let parsed = parse_elf_bytes(bytes)?;
    let executable_segments = executable_segments(&parsed, bytes)?;
    let mut disassembly = String::new();

    for (code, virtual_address) in &executable_segments {
        disassembly.push_str(&disassemble_at(code, *virtual_address));
    }

    let cpu = run_exec_program_segments_with_setup(&executable_segments, parsed.entry, |cpu| {
        load_segments(&parsed, bytes, cpu)
    })?;
    let exit_code = match cpu.completion {
        Some(CompletionPath::SyscallExit { code }) => code,
        Some(CompletionPath::SyscallExitGroup { code }) => code,
        Some(CompletionPath::TopLevelRet) => {
            return Err("ELF stopped at a top-level RET instead of exit syscall".to_string())
        }
        None => return Err("ELF stopped without a completion path".to_string()),
    };

    Ok(format!(
        "Disassembly:\n{disassembly}Captured stdout: {:?}\nExit code: {exit_code}",
        String::from_utf8_lossy(&cpu.captured_output)
    ))
}

fn executable_segments<'a>(
    parsed: &ParsedElf,
    bytes: &'a [u8],
) -> Result<Vec<(&'a [u8], u64)>, String> {
    let mut executable_segments = Vec::new();
    for (index, segment) in parsed.load_segments.iter().enumerate() {
        if !segment.executable {
            continue;
        }

        let start = usize::try_from(segment.file_offset).map_err(|_| {
            format!(
                "PT_LOAD[{index}] executable file offset 0x{:X} does not fit in usize",
                segment.file_offset
            )
        })?;
        let file_size = usize::try_from(segment.file_size).map_err(|_| {
            format!(
                "PT_LOAD[{index}] executable file size 0x{:X} does not fit in usize",
                segment.file_size
            )
        })?;
        let end = start.checked_add(file_size).ok_or_else(|| {
            format!(
                "PT_LOAD[{index}] executable file range overflows at offset 0x{:X}",
                segment.file_offset
            )
        })?;
        let code = bytes.get(start..end).ok_or_else(|| {
            format!(
                "PT_LOAD[{index}] executable file range 0x{:X}..0x{:X} exceeds ELF size {}",
                segment.file_offset,
                segment.file_offset.saturating_add(segment.file_size),
                bytes.len()
            )
        })?;

        executable_segments.push((code, segment.virtual_address));
    }

    if executable_segments.is_empty() {
        Err("ELF has no executable PT_LOAD segment".to_string())
    } else {
        Ok(executable_segments)
    }
}

const SUM_SQUARES_BYTES: &[u8] = include_bytes!("../tests/fixtures/sum_squares");
const SUM_SQUARES_OBJDUMP: &str = include_str!("../tests/fixtures/sum_squares.objdump.txt");

fn objdump_addresses(text: &str) -> BTreeSet<u64> {
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let (address, bytes_and_mnemonic) = trimmed.split_once(':')?;
            if address.is_empty()
                || !address
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
            {
                return None;
            }
            let mut has_mnemonic = false;
            for token in bytes_and_mnemonic.split_whitespace() {
                if token.len() == 2 && token.chars().all(|c| c.is_ascii_hexdigit()) {
                    continue;
                }
                has_mnemonic = true;
                break;
            }
            if !has_mnemonic {
                return None;
            }
            u64::from_str_radix(address, 16).ok()
        })
        .collect()
}

fn format_address_set(addresses: &BTreeSet<u64>) -> String {
    if addresses.is_empty() {
        return "none".to_string();
    }
    addresses
        .iter()
        .map(|address| format!("0x{address:X}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn coverage_report_bytes(bytes: &[u8]) -> Result<String, String> {
    let parsed = parse_elf_bytes(bytes)?;
    let segments = executable_segments(&parsed, bytes)?;
    let instructions = decode_segments(&segments);
    let mut mnemonic_counts = BTreeMap::<String, (usize, bool)>::new();
    let mut instruction_addresses = BTreeSet::new();
    let mut undecodable_addresses = BTreeSet::new();

    for instruction in &instructions {
        if instruction.is_invalid() {
            undecodable_addresses.insert(instruction.ip());
            continue;
        }
        instruction_addresses.insert(instruction.ip());
        let mnemonic = format!("{:?}", instruction.mnemonic());
        let entry = mnemonic_counts
            .entry(mnemonic)
            .or_insert((0, exec_generated::is_implemented(instruction.mnemonic())));
        entry.0 += 1;
    }

    let mut report = vec![format!(
        "Instruction count: {}",
        instruction_addresses.len()
    )];
    report.push("Mnemonic counts:".to_string());
    for (mnemonic, (count, implemented)) in &mnemonic_counts {
        report.push(format!(
            "  {mnemonic}: {count} ({})",
            if *implemented {
                "implemented"
            } else {
                "missing"
            }
        ));
    }

    let mut missing = mnemonic_counts
        .iter()
        .filter(|(_, (_, implemented))| !implemented)
        .map(|(mnemonic, (count, _))| (mnemonic, *count))
        .collect::<Vec<_>>();
    missing.sort_by(|(left_name, left_count), (right_name, right_count)| {
        right_count
            .cmp(left_count)
            .then_with(|| left_name.cmp(right_name))
    });
    report.push("Missing mnemonics (sorted by count descending):".to_string());
    if missing.is_empty() {
        report.push("  (none)".to_string());
    } else {
        report.extend(
            missing
                .iter()
                .map(|(mnemonic, count)| format!("  {mnemonic}: {count}")),
        );
    }

    report.push(format!(
        "Undecodable bytes: {}",
        undecodable_addresses.len()
    ));
    report.push(format!(
        "Undecodable addresses: {}",
        format_address_set(&undecodable_addresses)
    ));

    if bytes == SUM_SQUARES_BYTES {
        let objdump = objdump_addresses(SUM_SQUARES_OBJDUMP);
        let missing_from_decoder = objdump
            .difference(&instruction_addresses)
            .copied()
            .collect::<BTreeSet<_>>();
        let extra_in_decoder = instruction_addresses
            .difference(&objdump)
            .copied()
            .collect::<BTreeSet<_>>();
        if missing_from_decoder.is_empty() && extra_in_decoder.is_empty() {
            report.push(format!(
                "Objdump address comparison: MATCH ({} instruction starts)",
                objdump.len()
            ));
        } else {
            report.push(format!(
                "Objdump address comparison: DIFFERENCES; missing from decoder: {}; extra in decoder: {}",
                format_address_set(&missing_from_decoder),
                format_address_set(&extra_in_decoder)
            ));
        }
    } else {
        report.push(
            "Objdump address comparison: unavailable (no matching embedded objdump listing)"
                .to_string(),
        );
    }

    Ok(report.join("\n"))
}

/// Parses, loads, disassembles, and executes an ELF image in the virtual CPU.
#[wasm_bindgen]
pub fn run_elf(bytes: &[u8]) -> String {
    match run_elf_bytes(bytes) {
        Ok(report) => report,
        Err(message) => format!("ELF execution error: {message}"),
    }
}

/// Reports instruction coverage and decoder boundaries for executable ELF segments.
#[wasm_bindgen]
pub fn coverage_report(bytes: &[u8]) -> String {
    match coverage_report_bytes(bytes) {
        Ok(report) => report,
        Err(message) => format!("Coverage error: {message}"),
    }
}

/// Returns the statically embedded fixture so the frontend never fetches it.
#[wasm_bindgen]
pub fn embedded_elf() -> Vec<u8> {
    include_bytes!("../tests/fixtures/elf_write_exit").to_vec()
}

/// Returns the statically embedded compiler-generated C fixture.
#[wasm_bindgen]
pub fn embedded_sum_squares() -> Vec<u8> {
    SUM_SQUARES_BYTES.to_vec()
}

/// Runs a small suite of self-checks built with iced-x86's own encoder
/// (CodeAssembler), rather than hand-typed byte arrays, to verify the
/// sub-register write semantics and the memory read/write path. See
/// self_test.rs for the individual cases.
#[wasm_bindgen]
pub fn self_test() -> String {
    self_test::run_self_test()
}

/// Builds and runs an encoder-generated signed loop to verify real branches.
#[wasm_bindgen]
pub fn loop_test() -> String {
    self_test::run_jump_loop_test()
}

#[cfg(test)]
mod tests {
    use super::{coverage_report_bytes, run_elf_bytes};
    use iced_x86::code_asm::CodeAssembler;

    #[test]
    fn embedded_fixture_loads_and_executes() {
        let report =
            run_elf_bytes(include_bytes!("../tests/fixtures/elf_write_exit")).expect("fixture");

        println!("{report}");
        assert_eq!(
            report,
            concat!(
                "Disassembly:\n",
                "401000  mov rax,1\n",
                "401007  mov rdi,1\n",
                "40100E  mov rsi,402000h\n",
                "401015  mov rdx,6\n",
                "40101C  syscall\n",
                "40101E  mov rax,3Ch\n",
                "401025  mov rdi,25h\n",
                "40102C  syscall\n",
                "Captured stdout: \"hello\\n\"\n",
                "Exit code: 37"
            )
        );
    }

    #[test]
    fn compiled_fixture_reports_coverage_and_executes() {
        let bytes = include_bytes!("../tests/fixtures/sum_squares");
        let coverage = coverage_report_bytes(bytes).expect("compiled fixture should parse");
        let report = run_elf_bytes(bytes).expect("compiled fixture should execute");

        println!("C fixture coverage:\n{coverage}");
        println!("C fixture execution:\n{report}");
        assert!(coverage.contains("Objdump address comparison: MATCH"));
        assert!(coverage.contains("Missing mnemonics (sorted by count descending):\n  (none)"));
        assert!(report.contains("Captured stdout: \"sum=338350\\n\""));
        assert!(report.contains("Exit code: 0"));
    }

    #[test]
    fn unsupported_syscall_returns_arguments_and_trace() {
        let mut assembler = CodeAssembler::new(64).expect("assembler");
        assembler.mov(iced_x86::code_asm::rax, 999i64).expect("mov");
        assembler.syscall().expect("syscall");
        let bytes = assembler.assemble(0).expect("program");

        let failure = super::run_exec_program(&bytes);
        assert!(failure.is_err(), "syscall should be unsupported");
        let failure = failure.err().expect("failure was asserted above");
        assert!(failure.contains("unsupported syscall: number 999"));
        assert!(failure.contains("RIP=0x"));
        assert!(failure.contains("RDI=0x"));
        assert!(failure.contains("RSI=0x"));
        assert!(failure.contains("RDX=0x"));
        assert!(failure.contains("R10=0x"));
        assert!(failure.contains("R8=0x"));
        assert!(failure.contains("R9=0x"));
        assert!(failure.contains("Execution trace (last 16 instructions):"));
    }

    #[test]
    fn undecodable_bytes_return_an_error_with_trace() {
        let failure = super::run_exec_program(&[0x0F]);
        assert!(failure.is_err(), "truncated opcode should fail");
        let failure = failure.err().expect("failure was asserted above");
        assert!(failure.contains("undecodable bytes at 0x0"));
        assert!(failure.contains("Execution trace (last 16 instructions):"));
    }
}
