// Tiny virtual CPU for Chameleon Shell's Milestone 1 proof-of-concept.
//
// Registers: RAX, RBX, RCX, RDX (u64) + a program counter.
// Memory: a small internal byte buffer the fake SYSCALL reads from.

pub struct Cpu {
    pub regs: [u64; 4], // 0 = RAX, 1 = RBX, 2 = RCX, 3 = RDX
    pub pc: usize,
    pub program: Vec<u8>,
    pub memory: Vec<u8>,
    pub output: Vec<u8>,
}

pub const RAX: usize = 0;
pub const RBX: usize = 1;
pub const RCX: usize = 2;

impl Cpu {
    pub fn new(program: &[u8], memory: Vec<u8>) -> Self {
        Cpu {
            regs: [0; 4],
            pc: 0,
            program: program.to_vec(),
            memory,
            output: Vec::new(),
        }
    }

    pub fn fetch_u8(&mut self) -> u8 {
        let byte = self.program[self.pc];
        self.pc += 1;
        byte
    }

    pub fn fetch_u64(&mut self) -> u64 {
        let bytes: [u8; 8] = self.program[self.pc..self.pc + 8]
            .try_into()
            .expect("truncated u64 operand in program stream");
        self.pc += 8;
        u64::from_le_bytes(bytes)
    }

    pub fn has_next(&self) -> bool {
        self.pc < self.program.len()
    }

    // --- Instruction implementations, one per fake opcode ---
    // Each returns `true` to keep running, `false` to halt.

    pub fn exec_mov(&mut self) -> bool {
        let dst = self.fetch_u8() as usize;
        let imm = self.fetch_u64();
        self.regs[dst] = imm;
        true
    }

    pub fn exec_add(&mut self) -> bool {
        let dst = self.fetch_u8() as usize;
        let src = self.fetch_u8() as usize;
        self.regs[dst] = self.regs[dst].wrapping_add(self.regs[src]);
        true
    }

    pub fn exec_sub(&mut self) -> bool {
        let dst = self.fetch_u8() as usize;
        let src = self.fetch_u8() as usize;
        self.regs[dst] = self.regs[dst].wrapping_sub(self.regs[src]);
        true
    }

    pub fn exec_load(&mut self) -> bool {
        let dst = self.fetch_u8() as usize;
        let addr = self.fetch_u64() as usize;
        let bytes: [u8; 8] = self.memory[addr..addr + 8]
            .try_into()
            .expect("LOAD address out of bounds");
        self.regs[dst] = u64::from_le_bytes(bytes);
        true
    }

    /// Fake SYSCALL. Only sys_write (RAX == 1) is implemented: copies RCX
    /// bytes from internal memory starting at address RBX into `self.output`.
    pub fn exec_syscall(&mut self) -> bool {
        const FAKE_SYS_WRITE: u64 = 1;

        if self.regs[RAX] == FAKE_SYS_WRITE {
            let addr = self.regs[RBX] as usize;
            let len = self.regs[RCX] as usize;
            let slice = &self.memory[addr..addr + len];
            self.output.extend_from_slice(slice);
        }

        // Halt after SYSCALL, per Milestone 1 spec.
        false
    }
}
