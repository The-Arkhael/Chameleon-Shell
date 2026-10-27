// Hand-written per-mnemonic execution logic, dispatched to by the generated
// match block in exec_generated.rs. The *mapping* from mnemonic to handler
// is generated (see /generator/generate.ts); the addressing-mode and
// width-handling logic below is shared machinery, not per-instruction data,
// so it isn't a generation target itself.

use crate::exec_cpu::{ExecCpu, Flags};
use iced_x86::{Instruction, Mnemonic, OpKind, Register};

const SYS_READ: u64 = 0;
const SYS_WRITE: u64 = 1;
const SYS_BRK: u64 = 12;
const SYS_EXIT: u64 = 60;
const SYS_ARCH_PRCTL: u64 = 158;
const SYS_SET_TID_ADDRESS: u64 = 218;
const SYS_EXIT_GROUP: u64 = 231;
const ARCH_SET_FS: u64 = 0x1002;

/// Computes the effective address of a memory operand from whatever
/// iced-x86 decoded: base register (optional), index register * scale
/// (optional), plus a displacement.
fn effective_address(instr: &Instruction, cpu: &ExecCpu) -> Result<u64, String> {
    let base = instr.memory_base();
    let mut address = if base == Register::RIP {
        // iced-x86 exposes the resolved RIP-relative target as the memory
        // displacement, so do not add it to next_ip() a second time.
        instr.ip_rel_memory_address()
    } else if base != Register::None {
        cpu.get_register(base)?
    } else {
        0
    };

    let index = instr.memory_index();
    if index != Register::None {
        let scale = u64::from(instr.memory_index_scale());
        address = address.wrapping_add(cpu.get_register(index)?.wrapping_mul(scale));
    }

    if base != Register::RIP {
        address = address.wrapping_add(instr.memory_displacement64());
    }
    if instr.segment_prefix() == Register::FS {
        address = address.wrapping_add(cpu.fs_base);
    }
    Ok(address)
}

/// The operation width (in bytes) for this instruction, derived from
/// whichever operand is a register (mov/add/sub/cmp always have at least one —
/// there's no memory-to-memory form in x86). This lets memory operands,
/// which don't carry their own width in the unified `Instruction` view we
/// use here, borrow the width of their register counterpart.
fn operand_width_bytes_for_operand(instr: &Instruction, operand: u32) -> Result<usize, String> {
    match instr.op_kind(operand) {
        OpKind::Register => Ok(instr.op_register(operand).size()),
        OpKind::Memory => {
            let width = instr.memory_size().size();
            if width != 0 {
                Ok(width)
            } else {
                Err(format!(
                    "unsupported memory operand width for {:?}",
                    instr.mnemonic()
                ))
            }
        }
        _ => Err(format!(
            "operand {operand} of {:?} does not carry a width",
            instr.mnemonic()
        )),
    }
}

fn operand_width_bytes(instr: &Instruction) -> Result<usize, String> {
    for operand in 0..instr.op_count() {
        if let Ok(width) = operand_width_bytes_for_operand(instr, operand) {
            return Ok(width);
        }
    }
    Err(format!(
        "unsupported operand form for {:?}: instruction has no sized operand",
        instr.mnemonic()
    ))
}

/// Reads the value of operand `operand`, whether it's a register, a memory
/// location, or an immediate.
fn read_operand_value(
    instr: &Instruction,
    operand: u32,
    cpu: &ExecCpu,
    width_bytes: usize,
) -> Result<u64, String> {
    match instr.op_kind(operand) {
        OpKind::Register => cpu.get_register(instr.op_register(operand)),
        OpKind::Memory => {
            let address = effective_address(instr, cpu)?;
            let bytes = cpu.read_memory(address, width_bytes)?;
            let mut buf = [0u8; 8];
            buf[..width_bytes].copy_from_slice(bytes);
            Ok(u64::from_le_bytes(buf))
        }
        _ => Ok(instr.immediate(operand)),
    }
}

/// Writes `value` into operand `operand`, which must be a register or a
/// memory location (writing to an immediate operand is not a valid
/// instruction encoding).
fn write_operand_value(
    instr: &Instruction,
    operand: u32,
    cpu: &mut ExecCpu,
    value: u64,
    width_bytes: usize,
) -> Result<(), String> {
    match instr.op_kind(operand) {
        OpKind::Register => {
            cpu.set_register(instr.op_register(operand), value)?;
            Ok(())
        }
        OpKind::Memory => {
            let address = effective_address(instr, cpu)?;
            let bytes = value.to_le_bytes();
            cpu.write_memory(address, &bytes[..width_bytes])
        }
        other => Err(format!("unsupported destination operand kind: {other:?}")),
    }
}

fn width_mask(width: usize) -> u64 {
    match width {
        1 => 0xFF,
        2 => 0xFFFF,
        4 => 0xFFFF_FFFF,
        8 => u64::MAX,
        _ => panic!("unsupported operand width: {width}"),
    }
}

fn flags_for_logic(result: u64, width: usize) -> Flags {
    let mask = width_mask(width);
    Flags {
        cf: false,
        of: false,
        zf: result & mask == 0,
        sf: result & (1u64 << (width * 8 - 1)) != 0,
    }
}

fn sign_extend_to_i128(value: u64, width: usize) -> i128 {
    let bits = width * 8;
    let value = value & width_mask(width);
    let sign_bit = 1u64 << (bits - 1);
    if value & sign_bit == 0 {
        i128::from(value)
    } else {
        i128::from(value) - (1i128 << bits)
    }
}

fn truncate_i128(value: i128, width: usize) -> u64 {
    (value as u128 & u128::from(width_mask(width))) as u64
}

fn accumulator_register(width: usize) -> Register {
    match width {
        1 => Register::AL,
        2 => Register::AX,
        4 => Register::EAX,
        8 => Register::RAX,
        _ => panic!("unsupported implicit accumulator width: {width}"),
    }
}

fn high_product_register(width: usize) -> Register {
    match width {
        1 => Register::AH,
        2 => Register::DX,
        4 => Register::EDX,
        8 => Register::RDX,
        _ => panic!("unsupported implicit high-product width: {width}"),
    }
}

/// Computes the four status flags (CF/ZF/SF/OF) that result from an ADD
/// of `dst + src` at the given operand `width` in bytes.
///
/// Both unsigned and signed overflow are computed independently at the
/// exact operand width using Rust's `overflowing_add`:
///   - Unsigned cast → overflow bool is CF.
///   - Signed cast   → overflow bool is OF.
///     This prevents the most common implementation bug where one flag is
///     derived from the other rather than computed independently.
fn flags_for_add(dst: u64, src: u64, width: usize) -> Flags {
    match width {
        1 => {
            let (r, cf) = (dst as u8).overflowing_add(src as u8);
            let (_, of) = (dst as i8).overflowing_add(src as i8);
            Flags {
                cf,
                of,
                zf: r == 0,
                sf: (r >> 7) != 0,
            }
        }
        2 => {
            let (r, cf) = (dst as u16).overflowing_add(src as u16);
            let (_, of) = (dst as i16).overflowing_add(src as i16);
            Flags {
                cf,
                of,
                zf: r == 0,
                sf: (r >> 15) != 0,
            }
        }
        4 => {
            let (r, cf) = (dst as u32).overflowing_add(src as u32);
            let (_, of) = (dst as i32).overflowing_add(src as i32);
            Flags {
                cf,
                of,
                zf: r == 0,
                sf: (r >> 31) != 0,
            }
        }
        8 => {
            let (r, cf) = dst.overflowing_add(src);
            let (_, of) = (dst as i64).overflowing_add(src as i64);
            Flags {
                cf,
                of,
                zf: r == 0,
                sf: (r >> 63) != 0,
            }
        }
        _ => panic!("unsupported width for ADD flag computation: {width}"),
    }
}

/// Computes the four status flags (CF/ZF/SF/OF) that result from a SUB
/// of `dst - src` at the given operand `width` in bytes.
///
/// Same independent-computation approach as `flags_for_add`; note that for
/// SUB, CF is borrow (set when the unsigned subtraction underflows).
fn flags_for_sub(dst: u64, src: u64, width: usize) -> Flags {
    match width {
        1 => {
            let (r, cf) = (dst as u8).overflowing_sub(src as u8);
            let (_, of) = (dst as i8).overflowing_sub(src as i8);
            Flags {
                cf,
                of,
                zf: r == 0,
                sf: (r >> 7) != 0,
            }
        }
        2 => {
            let (r, cf) = (dst as u16).overflowing_sub(src as u16);
            let (_, of) = (dst as i16).overflowing_sub(src as i16);
            Flags {
                cf,
                of,
                zf: r == 0,
                sf: (r >> 15) != 0,
            }
        }
        4 => {
            let (r, cf) = (dst as u32).overflowing_sub(src as u32);
            let (_, of) = (dst as i32).overflowing_sub(src as i32);
            Flags {
                cf,
                of,
                zf: r == 0,
                sf: (r >> 31) != 0,
            }
        }
        8 => {
            let (r, cf) = dst.overflowing_sub(src);
            let (_, of) = (dst as i64).overflowing_sub(src as i64);
            Flags {
                cf,
                of,
                zf: r == 0,
                sf: (r >> 63) != 0,
            }
        }
        _ => panic!("unsupported width for SUB flag computation: {width}"),
    }
}

/// MOV dst, src — dst = src. Handles register<->register, register<->memory
/// (both directions), register<-immediate, and memory<-immediate at every
/// supported width. MOV does not affect flags.
pub fn exec_mov(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    let width = operand_width_bytes(instr)?;
    let value = read_operand_value(instr, 1, cpu, width)?;
    write_operand_value(instr, 0, cpu, value, width)?;
    Ok(true)
}

/// LEA computes the address of its memory operand without reading memory.
pub fn exec_lea(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    if instr.op_kind(0) != OpKind::Register || instr.op_kind(1) != OpKind::Memory {
        return Err("LEA requires a register destination and memory source".to_string());
    }
    let address = effective_address(instr, cpu)?;
    cpu.set_register(instr.op_register(0), address)?;
    Ok(true)
}

/// XOR dst, src — writes the bitwise XOR and sets logical-operation flags.
pub fn exec_xor(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    let width = operand_width_bytes(instr)?;
    let dst = read_operand_value(instr, 0, cpu, width)?;
    let src = read_operand_value(instr, 1, cpu, width)?;
    let result = dst ^ src;
    cpu.flags = flags_for_logic(result, width);
    write_operand_value(instr, 0, cpu, result, width)?;
    Ok(true)
}

/// AND dst, src — writes the bitwise AND and sets logical-operation flags.
pub fn exec_and(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    let width = operand_width_bytes(instr)?;
    let dst = read_operand_value(instr, 0, cpu, width)?;
    let src = read_operand_value(instr, 1, cpu, width)?;
    let result = dst & src;
    cpu.flags = flags_for_logic(result, width);
    write_operand_value(instr, 0, cpu, result, width)?;
    Ok(true)
}

/// TEST dst, src — sets logical-operation flags without modifying dst.
pub fn exec_test(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    let width = operand_width_bytes(instr)?;
    let dst = read_operand_value(instr, 0, cpu, width)?;
    let src = read_operand_value(instr, 1, cpu, width)?;
    cpu.flags = flags_for_logic(dst & src, width);
    Ok(true)
}

/// MOVZX reads the source at its own width and zero-extends it into dst.
pub fn exec_movzx(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    if instr.op_kind(0) != OpKind::Register {
        return Err("MOVZX requires a register destination".to_string());
    }
    let source_width = operand_width_bytes_for_operand(instr, 1)?;
    let value = read_operand_value(instr, 1, cpu, source_width)?;
    cpu.set_register(instr.op_register(0), value)?;
    Ok(true)
}

/// MUL performs unsigned widening multiplication using the implicit
/// accumulator and high-product registers.
pub fn exec_mul(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    if instr.op_count() != 1 {
        return Err("MUL currently supports only the one-operand form".to_string());
    }
    let width = operand_width_bytes_for_operand(instr, 0)?;
    let source = read_operand_value(instr, 0, cpu, width)?;
    let accumulator = accumulator_register(width);
    let product = u128::from(cpu.get_register(accumulator)? & width_mask(width))
        * u128::from(source & width_mask(width));
    let bits = width * 8;
    let low = (product & u128::from(width_mask(width))) as u64;
    let high = (product >> bits) as u64 & width_mask(width);
    cpu.set_register(accumulator, low)?;
    cpu.set_register(high_product_register(width), high)?;
    cpu.flags.cf = high != 0;
    cpu.flags.of = high != 0;
    Ok(true)
}

/// IMUL supports the one-operand widening form and the two-/three-operand
/// truncating forms emitted by the current compiler fixture.
pub fn exec_imul(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    match instr.op_count() {
        1 => {
            let width = operand_width_bytes_for_operand(instr, 0)?;
            let source = sign_extend_to_i128(read_operand_value(instr, 0, cpu, width)?, width);
            let accumulator = accumulator_register(width);
            let left = sign_extend_to_i128(cpu.get_register(accumulator)?, width);
            let product = left * source;
            let low = truncate_i128(product, width);
            let high = ((product as u128 >> (width * 8)) as u64) & width_mask(width);
            cpu.set_register(accumulator, low)?;
            cpu.set_register(high_product_register(width), high)?;
            let overflow = sign_extend_to_i128(low, width) != product;
            cpu.flags.cf = overflow;
            cpu.flags.of = overflow;
            Ok(true)
        }
        2 | 3 => {
            if instr.op_kind(0) != OpKind::Register {
                return Err("IMUL truncating form requires a register destination".to_string());
            }
            let width = operand_width_bytes_for_operand(instr, 0)?;
            let left = if instr.op_count() == 2 {
                read_operand_value(instr, 0, cpu, width)?
            } else {
                read_operand_value(instr, 1, cpu, width)?
            };
            let right = if instr.op_count() == 2 {
                read_operand_value(instr, 1, cpu, width)?
            } else {
                instr.immediate(2)
            };
            let product = sign_extend_to_i128(left, width) * sign_extend_to_i128(right, width);
            let result = truncate_i128(product, width);
            cpu.set_register(instr.op_register(0), result)?;
            let overflow = sign_extend_to_i128(result, width) != product;
            cpu.flags.cf = overflow;
            cpu.flags.of = overflow;
            Ok(true)
        }
        count => Err(format!("unsupported IMUL operand count: {count}")),
    }
}

/// SHR performs a logical right shift and updates the defined shift flags.
pub fn exec_shr(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    let width = operand_width_bytes_for_operand(instr, 0)?;
    let value = read_operand_value(instr, 0, cpu, width)?;
    let raw_count = read_operand_value(instr, 1, cpu, width)?;
    let count_mask = (width * 8 - 1) as u64;
    let count = raw_count & count_mask;
    if count == 0 {
        return Ok(true);
    }

    let result = (value & width_mask(width)) >> count;
    cpu.flags.cf = ((value >> (count - 1)) & 1) != 0;
    cpu.flags.of = count == 1 && (value & (1u64 << (width * 8 - 1)) != 0);
    cpu.flags.zf = result == 0;
    cpu.flags.sf = result & (1u64 << (width * 8 - 1)) != 0;
    write_operand_value(instr, 0, cpu, result, width)?;
    Ok(true)
}

/// NOP intentionally leaves every part of CPU state untouched.
pub fn exec_nop(_instr: &Instruction, _cpu: &mut ExecCpu) -> Result<bool, String> {
    Ok(true)
}

/// ADD dst, src — dst += src, and sets CF/ZF/SF/OF from the result.
/// Register or immediate source, register or memory destination.
pub fn exec_add(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    let width = operand_width_bytes(instr)?;
    let dst = read_operand_value(instr, 0, cpu, width)?;
    let src = read_operand_value(instr, 1, cpu, width)?;
    cpu.flags = flags_for_add(dst, src, width);
    write_operand_value(instr, 0, cpu, dst.wrapping_add(src), width)?;
    Ok(true)
}

/// SUB dst, src — dst -= src, and sets CF/ZF/SF/OF from the result.
/// Register or immediate source, register or memory destination.
pub fn exec_sub(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    let width = operand_width_bytes(instr)?;
    let dst = read_operand_value(instr, 0, cpu, width)?;
    let src = read_operand_value(instr, 1, cpu, width)?;
    cpu.flags = flags_for_sub(dst, src, width);
    write_operand_value(instr, 0, cpu, dst.wrapping_sub(src), width)?;
    Ok(true)
}

/// CMP dst, src — sets CF/ZF/SF/OF exactly as SUB would, but discards
/// the result without writing it back to dst. This is the canonical way to
/// set flags for a conditional jump without side-effecting a register.
pub fn exec_cmp(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    let width = operand_width_bytes(instr)?;
    let dst = read_operand_value(instr, 0, cpu, width)?;
    let src = read_operand_value(instr, 1, cpu, width)?;
    cpu.flags = flags_for_sub(dst, src, width);
    Ok(true)
}

pub fn exec_push(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    if instr.op_kind(0) != OpKind::Register || instr.op_register(0).size() != 8 {
        return Err("PUSH currently supports only 64-bit registers".to_string());
    }
    cpu.stack_push_u64(cpu.get_register(instr.op_register(0))?)?;
    Ok(true)
}

pub fn exec_pop(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    if instr.op_kind(0) != OpKind::Register || instr.op_register(0).size() != 8 {
        return Err("POP currently supports only 64-bit registers".to_string());
    }
    let value = cpu.stack_pop_u64()?;
    cpu.set_register(instr.op_register(0), value)?;
    Ok(true)
}

pub fn exec_call(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    cpu.stack_push_u64(instr.next_ip())?;
    cpu.call_depth = cpu
        .call_depth
        .checked_add(1)
        .ok_or_else(|| "call depth overflow".to_string())?;
    cpu.pending_jump = Some(instr.near_branch64());
    Ok(true)
}

pub fn exec_ret(_instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    if cpu.call_depth == 0 {
        return Ok(false);
    }

    let return_address = cpu.stack_pop_u64()?;
    cpu.call_depth -= 1;
    cpu.pending_jump = Some(return_address);
    Ok(true)
}

fn unsupported_syscall_error(instr: &Instruction, cpu: &ExecCpu, number: u64) -> String {
    format!(
        "unsupported syscall: number {number}, RIP=0x{:X}, args: RDI=0x{:X}, RSI=0x{:X}, RDX=0x{:X}, R10=0x{:X}, R8=0x{:X}, R9=0x{:X}",
        instr.ip(),
        cpu.get_register(Register::RDI).expect("RDI is a general-purpose register"),
        cpu.get_register(Register::RSI).expect("RSI is a general-purpose register"),
        cpu.get_register(Register::RDX).expect("RDX is a general-purpose register"),
        cpu.get_register(Register::R10).expect("R10 is a general-purpose register"),
        cpu.get_register(Register::R8).expect("R8 is a general-purpose register"),
        cpu.get_register(Register::R9).expect("R9 is a general-purpose register"),
    )
}

/// Executes the real x86-64 Linux syscall ABI. This is intentionally named
/// differently from the legacy one-byte fake SYSCALL opcode in `cpu.rs`.
pub fn dispatch_real_syscall(instr: &Instruction, cpu: &mut ExecCpu) -> Result<bool, String> {
    if instr.mnemonic() != Mnemonic::Syscall || instr.op_count() != 0 {
        return Err("real syscall handler received an invalid instruction".to_string());
    }

    let number = cpu.get_register(Register::RAX)?;
    match number {
        SYS_READ => {
            // Stub: there is no modeled stdin source yet, so read always
            // reports EOF after recognizing the ABI arguments.
            let fd = cpu.get_register(Register::RDI)?;
            let buffer = cpu.get_register(Register::RSI)?;
            let count = cpu.get_register(Register::RDX)?;
            let _ = (fd, buffer, count);
            cpu.set_register(Register::RAX, 0)?;
            Ok(true)
        }
        SYS_WRITE => {
            let fd = cpu.get_register(Register::RDI)?;
            if fd != 1 && fd != 2 {
                return Err(format!(
                    "write syscall: unsupported file descriptor {fd}; only fd 1 and 2 are supported"
                ));
            }

            let address = cpu.get_register(Register::RSI)?;
            let count_u64 = cpu.get_register(Register::RDX)?;
            let count = usize::try_from(count_u64)
                .map_err(|_| "write syscall count does not fit in usize".to_string())?;
            let bytes = cpu.read_memory(address, count)?.to_vec();
            cpu.captured_output.extend_from_slice(&bytes);
            cpu.set_register(Register::RAX, count_u64)?;
            Ok(true)
        }
        SYS_BRK => {
            let requested = cpu.get_register(Register::RDI)?;
            let memory_size = u64::try_from(cpu.memory.len())
                .map_err(|_| "memory size does not fit in the syscall address width".to_string())?;
            if requested != 0 && requested <= memory_size {
                cpu.program_break = requested;
            }
            cpu.set_register(Register::RAX, cpu.program_break)?;
            Ok(true)
        }
        SYS_EXIT => {
            let code = cpu.get_register(Register::RDI)?;
            cpu.completion = Some(crate::exec_cpu::CompletionPath::SyscallExit { code });
            Ok(false)
        }
        SYS_EXIT_GROUP => {
            let code = cpu.get_register(Register::RDI)?;
            cpu.completion = Some(crate::exec_cpu::CompletionPath::SyscallExitGroup { code });
            Ok(false)
        }
        SYS_SET_TID_ADDRESS => {
            let _tid_address = cpu.get_register(Register::RDI)?;
            cpu.set_register(Register::RAX, 1)?;
            Ok(true)
        }
        SYS_ARCH_PRCTL => {
            let code = cpu.get_register(Register::RDI)?;
            if code != ARCH_SET_FS {
                return Err(unsupported_syscall_error(instr, cpu, number));
            }
            cpu.fs_base = cpu.get_register(Register::RSI)?;
            cpu.set_register(Register::RAX, 0)?;
            Ok(true)
        }
        other => Err(unsupported_syscall_error(instr, cpu, other)),
    }
}
