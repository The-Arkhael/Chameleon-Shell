use goblin::elf::{program_header::PT_LOAD, Elf};

use crate::exec_cpu::ExecCpu;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LoadSegment {
    pub(crate) file_offset: u64,
    pub(crate) virtual_address: u64,
    pub(crate) file_size: u64,
    pub(crate) memory_size: u64,
    pub(crate) executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedElf {
    pub(crate) entry: u64,
    pub(crate) load_segments: Vec<LoadSegment>,
}

impl ParsedElf {
    pub(crate) fn report(&self) -> String {
        let mut lines = vec![format!("entry=0x{:X}", self.entry)];
        lines.extend(self.load_segments.iter().enumerate().map(|(index, segment)| {
            format!(
                "PT_LOAD[{index}] offset=0x{:X} vaddr=0x{:X} filesz=0x{:X} memsz=0x{:X} executable={}",
                segment.file_offset,
                segment.virtual_address,
                segment.file_size,
                segment.memory_size,
                segment.executable
            )
        }));
        lines.join("\n")
    }
}

pub(crate) fn parse_elf_bytes(bytes: &[u8]) -> Result<ParsedElf, String> {
    let elf = Elf::parse(bytes).map_err(|error| format!("ELF parse error: {error}"))?;
    let load_segments = elf
        .program_headers
        .iter()
        .filter(|header| header.p_type == PT_LOAD)
        .map(|header| LoadSegment {
            file_offset: header.p_offset,
            virtual_address: header.p_vaddr,
            file_size: header.p_filesz,
            memory_size: header.p_memsz,
            executable: header.is_executable(),
        })
        .collect();

    Ok(ParsedElf {
        entry: elf.entry,
        load_segments,
    })
}

pub(crate) fn load_segments(
    parsed: &ParsedElf,
    file_bytes: &[u8],
    cpu: &mut ExecCpu,
) -> Result<(), String> {
    for (index, segment) in parsed.load_segments.iter().enumerate() {
        if segment.memory_size < segment.file_size {
            return Err(format!(
                "PT_LOAD[{index}] memory size 0x{:X} is smaller than file size 0x{:X}",
                segment.memory_size, segment.file_size
            ));
        }

        let file_start = usize::try_from(segment.file_offset).map_err(|_| {
            format!(
                "PT_LOAD[{index}] file offset 0x{:X} does not fit in usize",
                segment.file_offset
            )
        })?;
        let file_size = usize::try_from(segment.file_size).map_err(|_| {
            format!(
                "PT_LOAD[{index}] file size 0x{:X} does not fit in usize",
                segment.file_size
            )
        })?;
        let file_end = file_start.checked_add(file_size).ok_or_else(|| {
            format!(
                "PT_LOAD[{index}] file range overflows at offset 0x{:X}",
                segment.file_offset
            )
        })?;
        if file_end > file_bytes.len() {
            return Err(format!(
                "PT_LOAD[{index}] file range 0x{:X}..0x{:X} exceeds ELF size {}",
                segment.file_offset,
                segment.file_offset.saturating_add(segment.file_size),
                file_bytes.len()
            ));
        }

        let memory_start = usize::try_from(segment.virtual_address).map_err(|_| {
            format!(
                "PT_LOAD[{index}] virtual address 0x{:X} does not fit in usize",
                segment.virtual_address
            )
        })?;
        let memory_size = usize::try_from(segment.memory_size).map_err(|_| {
            format!(
                "PT_LOAD[{index}] memory size 0x{:X} does not fit in usize",
                segment.memory_size
            )
        })?;
        let memory_end = memory_start.checked_add(memory_size).ok_or_else(|| {
            format!(
                "PT_LOAD[{index}] memory range overflows at address 0x{:X}",
                segment.virtual_address
            )
        })?;
        if memory_end > cpu.memory.len() {
            return Err(format!(
                "PT_LOAD[{index}] memory range 0x{:X}..0x{:X} exceeds memory size {}",
                segment.virtual_address,
                segment.virtual_address.saturating_add(segment.memory_size),
                cpu.memory.len()
            ));
        }

        cpu.write_memory(segment.virtual_address, &file_bytes[file_start..file_end])?;

        let zero_size = memory_size - file_size;
        if zero_size > 0 {
            let zeroes = vec![0; zero_size];
            let zero_start = segment
                .virtual_address
                .checked_add(segment.file_size)
                .ok_or_else(|| {
                    format!(
                        "PT_LOAD[{index}] zero-fill address overflows at 0x{:X}",
                        segment.virtual_address
                    )
                })?;
            cpu.write_memory(zero_start, &zeroes)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{load_segments, parse_elf_bytes, LoadSegment, ParsedElf};
    use crate::exec_cpu::ExecCpu;

    #[test]
    fn fixture_matches_readelf_entry_and_load_segments() {
        let bytes = include_bytes!("../tests/fixtures/elf_write_exit");
        let parsed = parse_elf_bytes(bytes).expect("fixture ELF should parse");
        let expected_segments = vec![
            LoadSegment {
                file_offset: 0,
                virtual_address: 0x400000,
                file_size: 0x188,
                memory_size: 0x188,
                executable: false,
            },
            LoadSegment {
                file_offset: 0x1000,
                virtual_address: 0x401000,
                file_size: 0x2E,
                memory_size: 0x2E,
                executable: true,
            },
            LoadSegment {
                file_offset: 0x2000,
                virtual_address: 0x402000,
                file_size: 0x6,
                memory_size: 0x6,
                executable: false,
            },
        ];

        assert_eq!(parsed.entry, 0x401000);
        assert_eq!(parsed.load_segments, expected_segments);
        println!("{}", parsed.report());
    }

    #[test]
    fn loader_copies_file_bytes_and_zero_fills_bss() {
        let parsed = ParsedElf {
            entry: 0x100,
            load_segments: vec![LoadSegment {
                file_offset: 2,
                virtual_address: 0x100,
                file_size: 3,
                memory_size: 5,
                executable: false,
            }],
        };
        let file_bytes = [0xAA, 0xBB, 1, 2, 3];
        let mut cpu = ExecCpu::new();

        load_segments(&parsed, &file_bytes, &mut cpu).expect("segment should load");

        assert_eq!(cpu.read_memory(0x100, 5).unwrap(), &[1, 2, 3, 0, 0]);
    }
}
