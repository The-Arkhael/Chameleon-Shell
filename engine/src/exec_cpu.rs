// CPU state for real x86-64 execution (memory + full GP register file + status flags).
//
// The stack is a real region at the top of linear memory. CALL/RET use a
// separate depth counter because the CPU's architectural registers are kept
// independent from the interpreter's control-flow bookkeeping.

use iced_x86::Register;

/// 16 MiB of addressable linear memory for real user-space ELF addresses.
pub const MEMORY_SIZE: usize = 16 * 1024 * 1024;

/// The temporary heap start used until ELF loading can provide a real break.
/// Keep this legacy placeholder stable so existing self-test output remains
/// unchanged while the addressable memory buffer grows.
pub const INITIAL_PROGRAM_BREAK: u64 = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionPath {
    TopLevelRet,
    SyscallExit { code: u64 },
    SyscallExitGroup { code: u64 },
}

/// Simplified EFLAGS — models only the four status flags used by integer
/// arithmetic and conditional jumps.
///
/// NOTE: this is deliberately NOT a faithful model of the real EFLAGS
/// register layout (32-bit register, specific bit positions, auxiliary
/// carry, direction flag, etc.).  We store four named bools because nothing
/// in scope reads EFLAGS directly — pushfq/popfq, sahf/lahf, and the
/// conditional-move forms that inspect EFLAGS as a whole are all out of
/// scope for this round.  If any of those are ever added, replace this
/// struct with a real u64 EFLAGS model and update every flag-setting site.
#[derive(Debug, Default, Clone, Copy)]
pub struct Flags {
    /// Carry Flag — set when an unsigned operation overflows its width.
    pub cf: bool,
    /// Zero Flag — set when the result is zero.
    pub zf: bool,
    /// Sign Flag — set when the result's most-significant bit is 1.
    pub sf: bool,
    /// Overflow Flag — set when a signed operation overflows its width.
    pub of: bool,
}

pub struct ExecCpu {
    /// All 16 general-purpose registers, each stored as its full 64-bit
    /// value (RAX..R15, in that order). Sub-register reads/writes go through
    /// `get_register`/`set_register`, which handle width correctly.
    regs: [u64; 16],
    pub memory: Vec<u8>,
    /// Status flags set by the last arithmetic/compare instruction.
    pub flags: Flags,
    /// Set by jump handlers to request a transfer of control; cleared and
    /// consumed by the main execution loop in run_exec_program().
    pub pending_jump: Option<u64>,
    /// Number of active direct CALL frames. A top-level RET remains the
    /// synthetic program exit; nested RETs pop a real return address.
    pub call_depth: usize,
    /// Bytes written by the modeled stdout/stderr syscalls.
    pub captured_output: Vec<u8>,
    /// Current program break. The initial value is a temporary placeholder
    /// until ELF loading defines the heap start.
    pub program_break: u64,
    /// Set when execution stops through a modeled completion instruction.
    pub completion: Option<CompletionPath>,
    /// Base address used by FS-prefixed memory operands.
    pub fs_base: u64,
}

/// Maps any GP register (whatever its width — AL, AX, EAX, RAX, ...) to the
/// index of its parent 64-bit register in `ExecCpu::regs`, using iced-x86's
/// own notion of "the full register this is part of".
fn register_slot(register: Register) -> Result<usize, String> {
    match register.full_register() {
        Register::RAX => Ok(0),
        Register::RCX => Ok(1),
        Register::RDX => Ok(2),
        Register::RBX => Ok(3),
        Register::RSP => Ok(4),
        Register::RBP => Ok(5),
        Register::RSI => Ok(6),
        Register::RDI => Ok(7),
        Register::R8 => Ok(8),
        Register::R9 => Ok(9),
        Register::R10 => Ok(10),
        Register::R11 => Ok(11),
        Register::R12 => Ok(12),
        Register::R13 => Ok(13),
        Register::R14 => Ok(14),
        Register::R15 => Ok(15),
        other => Err(format!(
            "unimplemented register for real execution: {other:?}"
        )),
    }
}

/// The legacy 8-bit "high byte" registers (AH/CH/DH/BH) alias bits 8-15 of
/// their parent register, unlike every other GP register form which starts
/// at bit 0. iced-x86 represents these as distinct `Register` variants.
fn is_high_byte_register(register: Register) -> bool {
    matches!(
        register,
        Register::AH | Register::CH | Register::DH | Register::BH
    )
}

impl ExecCpu {
    pub fn new() -> Self {
        let memory = vec![0u8; MEMORY_SIZE];
        let mut cpu = ExecCpu {
            regs: [0; 16],
            memory,
            flags: Flags::default(),
            pending_jump: None,
            call_depth: 0,
            captured_output: Vec::with_capacity(1024),
            program_break: INITIAL_PROGRAM_BREAK,
            completion: None,
            fs_base: 0,
        };
        cpu.set_register(Register::RSP, cpu.memory.len() as u64)
            .expect("RSP is a supported general-purpose register");
        cpu
    }

    pub fn stack_push_u64(&mut self, value: u64) -> Result<(), String> {
        let rsp = self.get_register(Register::RSP)?;
        let new_rsp = rsp
            .checked_sub(8)
            .ok_or_else(|| format!("stack underflow: cannot push 8 bytes with RSP at 0x{rsp:X}"))?;
        self.write_memory(new_rsp, &value.to_le_bytes())?;
        self.set_register(Register::RSP, new_rsp)?;
        Ok(())
    }

    pub fn stack_pop_u64(&mut self) -> Result<u64, String> {
        let rsp = self.get_register(Register::RSP)?;
        let bytes = self.read_memory(rsp, 8)?;
        let value = u64::from_le_bytes(
            bytes
                .try_into()
                .map_err(|_| "stack read did not return 8 bytes".to_string())?,
        );
        let new_rsp = rsp
            .checked_add(8)
            .ok_or_else(|| format!("stack overflow: cannot pop 8 bytes with RSP at 0x{rsp:X}"))?;
        self.set_register(Register::RSP, new_rsp)?;
        Ok(value)
    }

    /// Reads `register` at its own width (zero-extended into a u64 for
    /// convenience — callers that need the raw sub-register value should
    /// mask further themselves).
    pub fn get_register(&self, register: Register) -> Result<u64, String> {
        let full = self.regs[register_slot(register)?];
        match register.size() {
            1 if is_high_byte_register(register) => Ok((full >> 8) & 0xFF),
            1 => Ok(full & 0xFF),
            2 => Ok(full & 0xFFFF),
            4 => Ok(full & 0xFFFF_FFFF),
            8 => Ok(full),
            other => Err(format!(
                "unimplemented register size for real execution: {register:?} ({other} byte(s))"
            )),
        }
    }

    /// Writes `value` into `register`, applying the correct sub-register
    /// semantics for its width:
    /// - 32-bit (EAX, ...): zero-extends, clearing the upper 32 bits of the
    ///   parent 64-bit register (this is real x86-64 behavior, and the
    ///   single most common source of subtle bugs if skipped).
    /// - 16-bit (AX) / 8-bit (AL, AH, ...): leaves the rest of the parent
    ///   register untouched.
    /// - 64-bit (RAX, ...): overwrites the whole register.
    pub fn set_register(&mut self, register: Register, value: u64) -> Result<(), String> {
        let slot = register_slot(register)?;
        let existing = self.regs[slot];
        self.regs[slot] = match register.size() {
            4 => value & 0xFFFF_FFFF,
            2 => (existing & !0xFFFF) | (value & 0xFFFF),
            1 if is_high_byte_register(register) => (existing & !0xFF00) | ((value & 0xFF) << 8),
            1 => (existing & !0xFF) | (value & 0xFF),
            8 => value,
            other => {
                return Err(format!(
                    "unimplemented register size for real execution: {register:?} ({other} byte(s))"
                ))
            }
        };
        Ok(())
    }

    /// Bounds-checked read. Returns a clear error string instead of
    /// panicking on out-of-bounds access (a wasm panic is painful to debug
    /// from the browser console).
    pub fn read_memory(&self, address: u64, len: usize) -> Result<&[u8], String> {
        let start = usize::try_from(address)
            .map_err(|_| format!("address 0x{address:X} does not fit in this platform's usize"))?;
        let end = start
            .checked_add(len)
            .ok_or_else(|| format!("address overflow reading {len} byte(s) at 0x{address:X}"))?;
        if end > self.memory.len() {
            return Err(format!(
                "out-of-bounds read: {} byte(s) at 0x{:X} (memory size is {} bytes)",
                len,
                address,
                self.memory.len()
            ));
        }
        Ok(&self.memory[start..end])
    }

    /// Bounds-checked write. Returns a clear error string instead of
    /// panicking on out-of-bounds access.
    pub fn write_memory(&mut self, address: u64, bytes: &[u8]) -> Result<(), String> {
        let start = usize::try_from(address)
            .map_err(|_| format!("address 0x{address:X} does not fit in this platform's usize"))?;
        let end = start.checked_add(bytes.len()).ok_or_else(|| {
            format!(
                "address overflow writing {} byte(s) at 0x{:X}",
                bytes.len(),
                address
            )
        })?;
        if end > self.memory.len() {
            return Err(format!(
                "out-of-bounds write: {} byte(s) at 0x{:X} (memory size is {} bytes)",
                bytes.len(),
                address,
                self.memory.len()
            ));
        }
        self.memory[start..end].copy_from_slice(bytes);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::ExecCpu;
    use iced_x86::Register;

    #[test]
    fn unknown_register_reads_return_an_unimplemented_error() {
        let cpu = ExecCpu::new();
        let error = cpu
            .get_register(Register::RIP)
            .expect_err("RIP is not in the modeled general-purpose register file");
        assert!(error.contains("unimplemented register for real execution"));
        assert!(error.contains("RIP"));
    }
}
