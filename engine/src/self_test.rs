// Self-test suite verifying CPU semantics using programs built with
// iced-x86's own encoder (CodeAssembler), instead of hand-typed byte
// arrays. This is the trustworthy way to build test vectors going forward —
// hand-typed hex is exactly how subtle encoding mistakes sneak in unnoticed.

use crate::exec_cpu::{CompletionPath, ExecCpu, INITIAL_PROGRAM_BREAK, MEMORY_SIZE};
use crate::{run_exec_program, run_exec_program_with_setup};
use iced_x86::code_asm::{byte_ptr, dword_ptr, qword_ptr, CodeAssembler};
use iced_x86::{Decoder, DecoderOptions, Register};

fn gp(cpu: &ExecCpu, register: Register) -> u64 {
    cpu.get_register(register)
        .expect("self-test accesses only supported general-purpose registers")
}

struct TestCase {
    name: &'static str,
    passed: bool,
    expected: i64,
    actual: i64,
}

impl TestCase {
    fn report(&self) -> String {
        if self.passed {
            format!("PASS: {}", self.name)
        } else {
            format!(
                "FAIL: {} (expected {}, got {})",
                self.name, self.expected, self.actual
            )
        }
    }
}

/// (a) mov rax, -1 then mov eax, 1 — proves a 32-bit register write
/// zero-extends and clears the upper 32 bits of its parent 64-bit register,
/// rather than merely overwriting the lower half.
fn test_32bit_write_zero_extends() -> TestCase {
    let name = "mov rax,-1 ; mov eax,1 -> RAX == 1 (32-bit write zero-extends)";

    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rax, -1i64).unwrap();
    asm.mov(iced_x86::code_asm::eax, 1u32).unwrap();
    asm.ret().unwrap();
    let bytes = asm
        .assemble(0x0000)
        .expect("failed to assemble test program");

    let expected: i64 = 1;
    match run_exec_program(&bytes) {
        Ok(cpu) => {
            let actual = gp(&cpu, Register::RAX) as i64;
            TestCase {
                name,
                passed: actual == expected,
                expected,
                actual,
            }
        }
        Err(message) => TestCase {
            name,
            passed: false,
            expected,
            actual: -1, // sentinel: program faulted instead of producing a value
        }
        .with_error(message),
    }
}

/// (b) mov ebx, <addr> ; mov eax, 42 ; mov [rbx], eax ; mov ecx, [rbx] —
/// proves a real store-then-load round trip through actual memory, landing
/// in a register different from the one that was stored, so it can't pass
/// by accident from leftover state.
fn test_memory_round_trip() -> TestCase {
    let name = "mov [rbx],eax ; mov ecx,[rbx] -> ECX == 42 (memory round trip)";
    const TEST_ADDRESS: u32 = 0x1000;

    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::ebx, TEST_ADDRESS).unwrap();
    asm.mov(iced_x86::code_asm::eax, 42u32).unwrap();
    asm.mov(dword_ptr(iced_x86::code_asm::rbx), iced_x86::code_asm::eax)
        .unwrap();
    asm.mov(iced_x86::code_asm::ecx, dword_ptr(iced_x86::code_asm::rbx))
        .unwrap();
    asm.ret().unwrap();
    let bytes = asm
        .assemble(0x0000)
        .expect("failed to assemble test program");

    let expected: i64 = 42;
    match run_exec_program(&bytes) {
        Ok(cpu) => {
            let actual = gp(&cpu, Register::ECX) as i64;
            TestCase {
                name,
                passed: actual == expected,
                expected,
                actual,
            }
        }
        Err(message) => TestCase {
            name,
            passed: false,
            expected,
            actual: -1,
        }
        .with_error(message),
    }
}

fn test_memory_immediate_writes_preserve_neighbors() -> String {
    const BYTE_ADDRESS: u64 = 0x1100;
    const DWORD_ADDRESS: u64 = 0x1200;
    let name = "mov immediate to memory -> 8-bit and 32-bit writes preserve neighbors";

    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rbx, BYTE_ADDRESS as i64)
        .unwrap();
    asm.mov(byte_ptr(iced_x86::code_asm::rbx), 0xA5i32).unwrap();
    asm.mov(iced_x86::code_asm::rbx, DWORD_ADDRESS as i64)
        .unwrap();
    asm.mov(dword_ptr(iced_x86::code_asm::rbx), 0x1122_3344u32)
        .unwrap();
    asm.ret().unwrap();
    let bytes = asm
        .assemble(0)
        .expect("failed to assemble immediate stores");

    let result = run_exec_program_with_setup(&bytes, |cpu| {
        cpu.write_memory(BYTE_ADDRESS - 1, &[0x11, 0, 0x22])?;
        cpu.write_memory(DWORD_ADDRESS - 1, &[0x33, 0, 0, 0, 0, 0x44])
    });
    match result {
        Ok(cpu) => {
            let byte_window = cpu
                .read_memory(BYTE_ADDRESS - 1, 3)
                .expect("byte window should be in bounds");
            let dword_window = cpu
                .read_memory(DWORD_ADDRESS - 1, 6)
                .expect("dword window should be in bounds");
            if byte_window == [0x11, 0xA5, 0x22]
                && dword_window == [0x33, 0x44, 0x33, 0x22, 0x11, 0x44]
            {
                format!("PASS: {name}")
            } else {
                format!("FAIL: {name} (byte window={byte_window:?}, dword window={dword_window:?})")
            }
        }
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_lea_does_not_read_memory() -> String {
    const BASE: u64 = 0x1300;
    const INDEX: u64 = 3;
    const DISPLACEMENT: u64 = 8;
    let target = BASE + INDEX * 4 + DISPLACEMENT;
    let name = "lea computes effective address without reading memory";

    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rbx, BASE as i64).unwrap();
    asm.mov(iced_x86::code_asm::rcx, INDEX as i64).unwrap();
    asm.lea(
        iced_x86::code_asm::rax,
        qword_ptr(iced_x86::code_asm::rbx + iced_x86::code_asm::rcx * 4 + DISPLACEMENT),
    )
    .unwrap();
    asm.ret().unwrap();
    let bytes = asm.assemble(0).expect("failed to assemble LEA test");

    let result = run_exec_program_with_setup(&bytes, |cpu| {
        cpu.write_memory(target, &0xDEAD_BEEF_CAFE_BABEu64.to_le_bytes())
    });
    match result {
        Ok(cpu) => {
            let sentinel = cpu.read_memory(target, 8).expect("LEA target is in bounds");
            if gp(&cpu, Register::RAX) == target
                && sentinel == 0xDEAD_BEEF_CAFE_BABEu64.to_le_bytes()
            {
                format!("PASS: {name}")
            } else {
                format!(
                    "FAIL: {name} (RAX=0x{:X}, memory={sentinel:?})",
                    gp(&cpu, Register::RAX)
                )
            }
        }
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_rip_relative_lea_uses_next_ip() -> String {
    let name = "lea rax,[rip+0] resolves to the following instruction address";
    let base_ip = 0;
    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    let mut next_instruction = asm.create_label();
    asm.lea(iced_x86::code_asm::rax, qword_ptr(next_instruction))
        .unwrap();
    asm.set_label(&mut next_instruction).unwrap();
    asm.mov(iced_x86::code_asm::rbx, 1i64).unwrap();
    asm.ret().unwrap();
    let bytes = asm
        .assemble(base_ip)
        .expect("failed to assemble RIP-relative LEA");

    let mut decoder = Decoder::with_ip(64, &bytes, base_ip, DecoderOptions::NONE);
    let lea = decoder.decode();
    let expected = lea.next_ip();
    match run_exec_program(&bytes) {
        Ok(cpu) if gp(&cpu, Register::RAX) == expected => format!("PASS: {name}"),
        Ok(cpu) => format!(
            "FAIL: {name} (expected RAX=0x{expected:X}, got 0x{:X})",
            gp(&cpu, Register::RAX)
        ),
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_fs_relative_load() -> String {
    const FS_BASE: u64 = 0x5000;
    const SENTINEL: u64 = 0x0123_4567_89AB_CDEF;
    let name = "fs:[0] load adds fs_base to the effective address";

    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rax, qword_ptr(0).fs()).unwrap();
    asm.ret().unwrap();
    let bytes = asm.assemble(0).expect("failed to assemble FS load");
    let result = run_exec_program_with_setup(&bytes, |cpu| {
        cpu.fs_base = FS_BASE;
        cpu.write_memory(FS_BASE, &SENTINEL.to_le_bytes())
    });

    match result {
        Ok(cpu) if gp(&cpu, Register::RAX) == SENTINEL => format!("PASS: {name}"),
        Ok(cpu) => format!(
            "FAIL: {name} (expected RAX=0x{SENTINEL:X}, got 0x{:X})",
            gp(&cpu, Register::RAX)
        ),
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_and_exact_value_and_flags() -> String {
    let name = "and eax,-16 -> exact masked value, CF=false, OF=false";
    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::eax, 0x1234_567Bu32).unwrap();
    asm.and(iced_x86::code_asm::eax, -16i32).unwrap();
    asm.ret().unwrap();
    let bytes = asm.assemble(0).expect("failed to assemble AND test");

    match run_exec_program(&bytes) {
        Ok(cpu) if gp(&cpu, Register::EAX) == 0x1234_5670 && !cpu.flags.cf && !cpu.flags.of => {
            format!("PASS: {name}")
        }
        Ok(cpu) => format!(
            "FAIL: {name} (EAX=0x{:X}, CF={}, OF={})",
            gp(&cpu, Register::EAX),
            cpu.flags.cf,
            cpu.flags.of
        ),
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_thread_and_fs_syscalls() -> Vec<String> {
    let mut exit_group = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    exit_group.mov(iced_x86::code_asm::rax, 231i64).unwrap();
    exit_group.mov(iced_x86::code_asm::rdi, 7i64).unwrap();
    exit_group.syscall().unwrap();
    exit_group.mov(iced_x86::code_asm::rbx, 99i64).unwrap();
    let exit_group_bytes = exit_group
        .assemble(0)
        .expect("failed to assemble exit_group");

    let mut set_tid = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    set_tid.mov(iced_x86::code_asm::rax, 218i64).unwrap();
    set_tid.mov(iced_x86::code_asm::rdi, 0x1234i64).unwrap();
    set_tid.syscall().unwrap();
    set_tid.ret().unwrap();
    let set_tid_bytes = set_tid
        .assemble(0)
        .expect("failed to assemble set_tid_address");

    let mut set_fs = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    set_fs.mov(iced_x86::code_asm::rax, 158i64).unwrap();
    set_fs.mov(iced_x86::code_asm::rdi, 0x1002i64).unwrap();
    set_fs.mov(iced_x86::code_asm::rsi, 0x5000i64).unwrap();
    set_fs.syscall().unwrap();
    set_fs.ret().unwrap();
    let set_fs_bytes = set_fs.assemble(0).expect("failed to assemble arch_prctl");

    let mut unsupported_arch_prctl =
        CodeAssembler::new(64).expect("failed to create CodeAssembler");
    unsupported_arch_prctl
        .mov(iced_x86::code_asm::rax, 158i64)
        .unwrap();
    unsupported_arch_prctl
        .mov(iced_x86::code_asm::rdi, 0x1003i64)
        .unwrap();
    unsupported_arch_prctl.syscall().unwrap();
    let unsupported_arch_prctl_bytes = unsupported_arch_prctl
        .assemble(0)
        .expect("failed to assemble unsupported arch_prctl");

    let mut reports = Vec::with_capacity(4);

    match run_exec_program(&exit_group_bytes) {
        Ok(cpu) => {
            let actual_code = match cpu.completion {
                Some(CompletionPath::SyscallExitGroup { code }) => Some(code),
                _ => None,
            };
            let actual_rbx = gp(&cpu, Register::RBX);
            if let Some(code) = actual_code.filter(|code| *code == 7) {
                if actual_rbx == 0 {
                    reports.push(format!("PASS: exit_group recorded code = {code}"));
                } else {
                    reports.push(format!(
                        "FAIL: exit_group recorded code = {code}, RBX = {actual_rbx}"
                    ));
                }
            } else {
                reports.push(format!(
                    "FAIL: exit_group recorded code = {actual_code:?}, RBX = {actual_rbx}"
                ));
            }
        }
        Err(message) => reports.push(format!("FAIL: exit_group execution error: {message}")),
    }

    match run_exec_program(&set_tid_bytes) {
        Ok(cpu) => {
            let actual_rax = gp(&cpu, Register::RAX);
            if actual_rax == 1 {
                reports.push(format!("PASS: set_tid_address returned RAX = {actual_rax}"));
            } else {
                reports.push(format!(
                    "FAIL: set_tid_address returned RAX = {actual_rax}, expected 1"
                ));
            }
        }
        Err(message) => reports.push(format!("FAIL: set_tid_address execution error: {message}")),
    }

    match run_exec_program(&set_fs_bytes) {
        Ok(cpu) => {
            let actual_rax = gp(&cpu, Register::RAX);
            let actual_fs_base = cpu.fs_base;
            if actual_rax == 0 && actual_fs_base == 0x5000 {
                reports.push(format!(
                    "PASS: arch_prctl(ARCH_SET_FS) returned RAX = {actual_rax}, stored FS_BASE = 0x{actual_fs_base:X}"
                ));
            } else {
                reports.push(format!(
                    "FAIL: arch_prctl(ARCH_SET_FS) returned RAX = {actual_rax}, stored FS_BASE = 0x{actual_fs_base:X}; expected RAX = 0, FS_BASE = 0x5000"
                ));
            }
        }
        Err(message) => reports.push(format!(
            "FAIL: arch_prctl(ARCH_SET_FS) execution error: {message}"
        )),
    }

    match run_exec_program(&unsupported_arch_prctl_bytes) {
        Err(message) if message.starts_with("unsupported syscall: number 158") => {
            reports.push(
                "PASS: unsupported arch_prctl command returns a structured error".to_string(),
            );
        }
        Err(message) => reports.push(format!(
            "FAIL: unsupported arch_prctl returned the wrong error: {message}"
        )),
        Ok(cpu) => reports.push(format!(
            "FAIL: unsupported arch_prctl unexpectedly completed with RAX = {}",
            gp(&cpu, Register::RAX)
        )),
    }

    reports
}

fn test_xor_and_test_flags() -> String {
    let name = "xor/test -> logical result and flags, with TEST leaving destination unchanged";

    let mut zeroing = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    zeroing.mov(iced_x86::code_asm::eax, 0xFFu32).unwrap();
    zeroing
        .xor(iced_x86::code_asm::eax, iced_x86::code_asm::eax)
        .unwrap();
    zeroing.ret().unwrap();
    let zeroing_bytes = zeroing
        .assemble(0)
        .expect("failed to assemble XOR zeroing test");

    let mut bitwise = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    bitwise.mov(iced_x86::code_asm::eax, 0b1010u32).unwrap();
    bitwise.xor(iced_x86::code_asm::eax, 0b0110u32).unwrap();
    bitwise.ret().unwrap();
    let bitwise_bytes = bitwise
        .assemble(0)
        .expect("failed to assemble XOR bitwise test");

    let mut testing = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    testing.mov(iced_x86::code_asm::eax, 0u32).unwrap();
    testing
        .test(iced_x86::code_asm::eax, iced_x86::code_asm::eax)
        .unwrap();
    testing.ret().unwrap();
    let testing_bytes = testing.assemble(0).expect("failed to assemble TEST test");

    let zeroing_result = run_exec_program(&zeroing_bytes);
    let bitwise_result = run_exec_program(&bitwise_bytes);
    let testing_result = run_exec_program(&testing_bytes);
    match (zeroing_result, bitwise_result, testing_result) {
        (Ok(zeroing_cpu), Ok(bitwise_cpu), Ok(testing_cpu))
            if gp(&zeroing_cpu, Register::EAX) == 0
                && !zeroing_cpu.flags.cf
                && !zeroing_cpu.flags.of
                && gp(&bitwise_cpu, Register::EAX) == 0b1100
                && gp(&testing_cpu, Register::EAX) == 0
                && testing_cpu.flags.zf =>
        {
            format!("PASS: {name}")
        }
        (zeroing, bitwise, testing) => format!(
            "FAIL: {name} (zeroing={:?}, bitwise={:?}, testing={:?})",
            zeroing.map(|cpu| (gp(&cpu, Register::EAX), cpu.flags)),
            bitwise.map(|cpu| (gp(&cpu, Register::EAX), cpu.flags)),
            testing.map(|cpu| (gp(&cpu, Register::EAX), cpu.flags))
        ),
    }
}

fn test_movzx_zero_extends_source_width() -> String {
    const TEST_ADDRESS: u64 = 0x1400;
    let name = "movzx byte memory source -> EAX == 0x000000FF";

    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rbx, TEST_ADDRESS as i64)
        .unwrap();
    asm.movzx(iced_x86::code_asm::eax, byte_ptr(iced_x86::code_asm::rbx))
        .unwrap();
    asm.ret().unwrap();
    let bytes = asm.assemble(0).expect("failed to assemble MOVZX test");

    match run_exec_program_with_setup(&bytes, |cpu| cpu.write_memory(TEST_ADDRESS, &[0xFF])) {
        Ok(cpu) if gp(&cpu, Register::EAX) == 0x0000_00FF => format!("PASS: {name}"),
        Ok(cpu) => format!("FAIL: {name} (EAX=0x{:08X})", gp(&cpu, Register::EAX)),
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_mul_and_imul() -> String {
    let name = "mul rbx and imul eax,ecx -> exact low/high and truncating results";

    let mut mul = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    mul.mov(iced_x86::code_asm::rax, 100i64).unwrap();
    mul.mov(iced_x86::code_asm::rbx, 7i64).unwrap();
    mul.mul(iced_x86::code_asm::rbx).unwrap();
    mul.ret().unwrap();
    let mul_bytes = mul.assemble(0).expect("failed to assemble MUL test");

    let mut imul = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    imul.mov(iced_x86::code_asm::eax, 6u32).unwrap();
    imul.mov(iced_x86::code_asm::ecx, 7u32).unwrap();
    imul.imul_2(iced_x86::code_asm::eax, iced_x86::code_asm::ecx)
        .unwrap();
    imul.ret().unwrap();
    let imul_bytes = imul.assemble(0).expect("failed to assemble IMUL test");

    match (run_exec_program(&mul_bytes), run_exec_program(&imul_bytes)) {
        (Ok(mul_cpu), Ok(imul_cpu))
            if gp(&mul_cpu, Register::RAX) == 700
                && gp(&mul_cpu, Register::RDX) == 0
                && gp(&imul_cpu, Register::EAX) == 42 =>
        {
            format!("PASS: {name}")
        }
        (mul, imul) => format!(
            "FAIL: {name} (mul={:?}, imul={:?})",
            mul.map(|cpu| (gp(&cpu, Register::RAX), gp(&cpu, Register::RDX))),
            imul.map(|cpu| gp(&cpu, Register::EAX))
        ),
    }
}

fn test_shr_carry_bit() -> String {
    let name = "shr -> logical result and carry from the bit shifted out";
    let run = |value: u32| {
        let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
        asm.mov(iced_x86::code_asm::eax, value).unwrap();
        asm.shr(iced_x86::code_asm::eax, 1i32).unwrap();
        asm.ret().unwrap();
        let bytes = asm.assemble(0).expect("failed to assemble SHR test");
        run_exec_program(&bytes)
    };

    match (run(0b1010), run(0b1011)) {
        (Ok(even), Ok(odd))
            if gp(&even, Register::EAX) == 5
                && !even.flags.cf
                && gp(&odd, Register::EAX) == 5
                && odd.flags.cf =>
        {
            format!("PASS: {name}")
        }
        (even, odd) => format!(
            "FAIL: {name} (even={:?}, odd={:?})",
            even.map(|cpu| (gp(&cpu, Register::EAX), cpu.flags.cf)),
            odd.map(|cpu| (gp(&cpu, Register::EAX), cpu.flags.cf))
        ),
    }
}

fn test_unsigned_jumps() -> String {
    let name = "unsigned jae/jb -> 0xFFFFFFFF is not below 1 and is above-or-equal";
    let assemble = |jump: fn(
        &mut CodeAssembler,
        iced_x86::code_asm::CodeLabel,
    ) -> Result<(), iced_x86::IcedError>| {
        let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
        let mut target = asm.create_label();
        asm.mov(iced_x86::code_asm::eax, 0xFFFF_FFFFu32).unwrap();
        asm.cmp(iced_x86::code_asm::eax, 1u32).unwrap();
        asm.mov(iced_x86::code_asm::ecx, 1u32).unwrap();
        jump(&mut asm, target).unwrap();
        asm.ret().unwrap();
        asm.set_label(&mut target).unwrap();
        asm.mov(iced_x86::code_asm::ecx, 2u32).unwrap();
        asm.ret().unwrap();
        asm.assemble(0)
            .expect("failed to assemble unsigned jump test")
    };

    let jb_bytes = assemble(|asm, target| asm.jb(target));
    let jae_bytes = assemble(|asm, target| asm.jae(target));
    match (run_exec_program(&jb_bytes), run_exec_program(&jae_bytes)) {
        (Ok(jb_cpu), Ok(jae_cpu))
            if gp(&jb_cpu, Register::ECX) == 1 && gp(&jae_cpu, Register::ECX) == 2 =>
        {
            format!("PASS: {name}")
        }
        (jb, jae) => format!(
            "FAIL: {name} (jb={:?}, jae={:?})",
            jb.map(|cpu| gp(&cpu, Register::ECX)),
            jae.map(|cpu| gp(&cpu, Register::ECX))
        ),
    }
}

/// Verifies signed and unsigned overflow independently: 0x7fffffff + 1
/// overflows a signed 32-bit integer but not an unsigned 32-bit integer.
fn test_add_flags_are_independent() -> String {
    let name = "add eax,1 after 0x7fffffff -> OF=true, CF=false";

    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::eax, 0x7FFF_FFFFu32).unwrap();
    asm.add(iced_x86::code_asm::eax, 1u32).unwrap();
    asm.ret().unwrap();
    let bytes = asm
        .assemble(0x0000)
        .expect("failed to assemble test program");

    match run_exec_program(&bytes) {
        Ok(cpu) if cpu.flags.of && !cpu.flags.cf => format!("PASS: {name}"),
        Ok(cpu) => format!(
            "FAIL: {name} (expected OF=true, CF=false; got OF={}, CF={})",
            cpu.flags.of, cpu.flags.cf
        ),
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_push_pop_round_trip() -> String {
    let name = "push/pop rax -> RAX == 0x1234 and RSP restored";
    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rax, 0x1234i64).unwrap();
    asm.push(iced_x86::code_asm::rax).unwrap();
    asm.mov(iced_x86::code_asm::rax, 0i64).unwrap();
    asm.pop(iced_x86::code_asm::rax).unwrap();
    asm.ret().unwrap();
    let bytes = asm.assemble(0x0000).expect("failed to assemble stack test");

    match run_exec_program(&bytes) {
        Ok(cpu) => {
            let actual_rax = gp(&cpu, Register::RAX);
            let actual_rsp = gp(&cpu, Register::RSP);
            if actual_rax == 0x1234 && actual_rsp == MEMORY_SIZE as u64 {
                format!("PASS: {name}")
            } else {
                format!(
                    "FAIL: {name} (expected RAX=0x1234, RSP=0x{MEMORY_SIZE:X}; got RAX=0x{actual_rax:X}, RSP=0x{actual_rsp:X})"
                )
            }
        }
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_call_return() -> String {
    let name = "call/ret subroutine -> EAX == 111";
    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    let mut subroutine = asm.create_label();

    asm.mov(iced_x86::code_asm::eax, 1u32).unwrap();
    asm.call(subroutine).unwrap();
    asm.add(iced_x86::code_asm::eax, 100u32).unwrap();
    asm.ret().unwrap();
    asm.set_label(&mut subroutine).unwrap();
    asm.add(iced_x86::code_asm::eax, 10u32).unwrap();
    asm.ret().unwrap();
    let bytes = asm.assemble(0x0000).expect("failed to assemble call test");

    match run_exec_program(&bytes) {
        Ok(cpu) => {
            let actual = gp(&cpu, Register::EAX);
            if actual == 111 {
                format!("PASS: {name}")
            } else {
                format!("FAIL: {name} (expected 111, got {actual})")
            }
        }
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_write_syscall() -> (String, Vec<u8>) {
    const TEST_ADDRESS: u64 = 0x1000;
    let name = "write syscall -> captured stdout == \"hi\\n\" and RAX == 3";
    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rax, 1i64).unwrap();
    asm.mov(iced_x86::code_asm::rdi, 1i64).unwrap();
    asm.mov(iced_x86::code_asm::rsi, TEST_ADDRESS as i64)
        .unwrap();
    asm.mov(iced_x86::code_asm::rdx, 3i64).unwrap();
    asm.syscall().unwrap();
    asm.ret().unwrap();
    let bytes = asm.assemble(0x0000).expect("failed to assemble write test");

    let result = run_exec_program_with_setup(&bytes, |cpu| cpu.write_memory(TEST_ADDRESS, b"hi\n"));
    match result {
        Ok(cpu) => {
            let passed = cpu.captured_output == b"hi\n" && gp(&cpu, Register::RAX) == 3;
            let report = if passed {
                format!("PASS: {name}")
            } else {
                format!(
                    "FAIL: {name} (got stdout={:?}, RAX={})",
                    String::from_utf8_lossy(&cpu.captured_output),
                    gp(&cpu, Register::RAX)
                )
            };
            (report, cpu.captured_output)
        }
        Err(message) => (
            format!("FAIL: {name} (execution error: {message})"),
            Vec::new(),
        ),
    }
}

fn test_exit_syscall() -> String {
    let name = "exit syscall -> exited via syscall";
    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rax, 60i64).unwrap();
    asm.mov(iced_x86::code_asm::rdi, 42i64).unwrap();
    asm.syscall().unwrap();
    asm.mov(iced_x86::code_asm::rdi, 999i64).unwrap();
    let bytes = asm.assemble(0x0000).expect("failed to assemble exit test");

    match run_exec_program(&bytes) {
        Ok(cpu) => {
            let actual_rdi = gp(&cpu, Register::RDI);
            if cpu.completion == Some(CompletionPath::SyscallExit { code: 42 }) && actual_rdi == 42
            {
                format!("PASS: {name}, RDI = {actual_rdi}")
            } else {
                format!(
                    "FAIL: {name} (completion={:?}, RDI={actual_rdi})",
                    cpu.completion
                )
            }
        }
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

fn test_brk_syscall() -> String {
    let name = "brk syscall";
    let requested = INITIAL_PROGRAM_BREAK + 0x1000;
    let requested_i64 = i64::try_from(requested).expect("test break address fits in i64");
    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    asm.mov(iced_x86::code_asm::rax, 12i64).unwrap();
    asm.mov(iced_x86::code_asm::rdi, 0i64).unwrap();
    asm.syscall().unwrap();
    asm.mov(iced_x86::code_asm::rbx, iced_x86::code_asm::rax)
        .unwrap();
    asm.mov(iced_x86::code_asm::rax, 12i64).unwrap();
    asm.mov(iced_x86::code_asm::rdi, requested_i64).unwrap();
    asm.syscall().unwrap();
    asm.ret().unwrap();
    let bytes = asm.assemble(0x0000).expect("failed to assemble brk test");

    match run_exec_program(&bytes) {
        Ok(cpu) => {
            let query_return = gp(&cpu, Register::RBX);
            let update_return = gp(&cpu, Register::RAX);
            let stored_break = cpu.program_break;
            if query_return == INITIAL_PROGRAM_BREAK
                && update_return == requested
                && stored_break == requested
            {
                format!(
                    "PASS: {name} -> query={query_return}, update={update_return}, program_break={stored_break}"
                )
            } else {
                format!(
                    "FAIL: {name} (query={query_return}, update={update_return}, program_break={stored_break})"
                )
            }
        }
        Err(message) => format!("FAIL: {name} (execution error: {message})"),
    }
}

impl TestCase {
    fn with_error(mut self, message: String) -> Self {
        self.name =
            Box::leak(format!("{} (execution error: {})", self.name, message).into_boxed_str());
        self
    }
}

pub fn run_self_test() -> String {
    let cases = [test_32bit_write_zero_extends(), test_memory_round_trip()];
    let mut reports = cases.iter().map(TestCase::report).collect::<Vec<_>>();
    reports.push(test_memory_immediate_writes_preserve_neighbors());
    reports.push(test_lea_does_not_read_memory());
    reports.push(test_rip_relative_lea_uses_next_ip());
    reports.push(test_fs_relative_load());
    reports.push(test_and_exact_value_and_flags());
    reports.extend(test_thread_and_fs_syscalls());
    reports.push(test_xor_and_test_flags());
    reports.push(test_movzx_zero_extends_source_width());
    reports.push(test_mul_and_imul());
    reports.push(test_shr_carry_bit());
    reports.push(test_unsigned_jumps());
    reports.push(test_add_flags_are_independent());
    reports.push(test_push_pop_round_trip());
    reports.push(test_call_return());
    let (write_report, captured_output) = test_write_syscall();
    reports.push(write_report);
    reports.push(format!(
        "Captured stdout: {:?}",
        String::from_utf8_lossy(&captured_output)
    ));
    reports.push(test_exit_syscall());
    reports.push(test_brk_syscall());
    reports.join("\n")
}

/// Runs a signed less-than loop assembled with a symbolic label, so iced-x86
/// resolves the backward branch rather than relying on hand-calculated bytes.
pub fn run_jump_loop_test() -> String {
    let mut asm = CodeAssembler::new(64).expect("failed to create CodeAssembler");
    let mut loop_start = asm.create_label();

    asm.mov(iced_x86::code_asm::ecx, 0u32).unwrap();
    asm.set_label(&mut loop_start).unwrap();
    asm.add(iced_x86::code_asm::ecx, 1u32).unwrap();
    asm.cmp(iced_x86::code_asm::ecx, 5u32).unwrap();
    asm.jl(loop_start).unwrap();
    asm.ret().unwrap();
    let bytes = asm
        .assemble(0x0000)
        .expect("failed to assemble conditional-jump loop");

    match run_exec_program(&bytes) {
        Ok(cpu) => format!("Loop program final ECX = {}", gp(&cpu, Register::ECX)),
        Err(message) => format!("FAIL: loop program execution error: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{run_jump_loop_test, run_self_test};

    #[test]
    fn encoder_built_self_tests_pass() {
        let report = run_self_test();
        println!("{report}");
        assert!(
            report
                .lines()
                .all(|line| { line.starts_with("PASS:") || line.starts_with("Captured stdout:") }),
            "{report}"
        );
    }

    #[test]
    fn signed_loop_finishes_at_five() {
        assert_eq!(run_jump_loop_test(), "Loop program final ECX = 5");
    }
}
