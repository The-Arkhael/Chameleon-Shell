import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

// Register indices used by the fake CPU (see /engine/src/cpu.rs).
const RAX = 0;
const RBX = 1;
const RCX = 2;

// Opcodes for the fake instruction set (see /generator/generate.ts, which
// generates /engine/src/generated.rs from this same table).
const OPCODE_MOV = 0x01;
const OPCODE_SYSCALL = 0x05;

// The engine seeds this exact message into its internal memory at address 0.
const MESSAGE_LEN = "Hello from Chameleon Shell\n".length;
const FAKE_SYS_WRITE = 1;

// Hardcoded x86-64 machine code for a real disassembly demo (step 1-3):
//   mov eax, 1
//   add eax, eax
//   ret
const DISASSEMBLY_DEMO_BYTES = new Uint8Array([
  0xb8, 0x01, 0x00, 0x00, 0x00, 0x01, 0xc0, 0xc3,
]);

/** MOV dst, imm64 — 1 opcode byte + 1 register byte + 8 little-endian bytes. */
function encodeMov(dstRegister: number, immediate: number): number[] {
  const bytes = new Array(8).fill(0);
  let value = BigInt(immediate);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return [OPCODE_MOV, dstRegister, ...bytes];
}

/**
 * Hardcoded demo program: point RBX/RCX at the pre-seeded message, set RAX to
 * the fake sys_write syscall number, then SYSCALL to copy it into output.
 */
function buildDemoProgram(): Uint8Array {
  const program = [
    ...encodeMov(RBX, 0), // RBX = address of message (0)
    ...encodeMov(RCX, MESSAGE_LEN), // RCX = length of message
    ...encodeMov(RAX, FAKE_SYS_WRITE), // RAX = 1 (fake sys_write)
    OPCODE_SYSCALL,
  ];
  return new Uint8Array(program);
}

function App() {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (!terminalContainerRef.current || hasRunRef.current) return;
    hasRunRef.current = true;

    const term = new Terminal({
      convertEol: true,
      fontFamily: "Menlo, monospace",
      fontSize: 14,
      theme: { background: "#0b0e14", foreground: "#d6deeb" },
    });
    term.open(terminalContainerRef.current);
    term.writeln("Chameleon Shell — Milestone 1 proof of concept");
    term.writeln("Loading Wasm engine...");

    (async () => {
      try {
        // Files in /public are served as-is and can't be imported as a module
        // specifier through Vite's dev transform pipeline. Fetch the
        // wasm-bindgen glue as text and import it via a blob URL instead.
        const jsUrl = `${import.meta.env.BASE_URL}wasm/chameleon_engine.js`;
        const jsSource = await (await fetch(jsUrl)).text();
        const blobUrl = URL.createObjectURL(new Blob([jsSource], { type: "text/javascript" }));
        const engine = await import(/* @vite-ignore */ blobUrl);
        URL.revokeObjectURL(blobUrl);
        await engine.default({
          module_or_path: `${import.meta.env.BASE_URL}wasm/chameleon_engine_bg.wasm`,
        });

        term.writeln("Engine loaded. Running hardcoded program...");
        const program = buildDemoProgram();
        const output: Uint8Array = engine.run(program);
        const text = new TextDecoder().decode(output);
        term.write(text);

        term.writeln("");
        term.writeln("Disassembling hardcoded x86-64 bytes...");
        const disassembly: string = engine.disassemble(DISASSEMBLY_DEMO_BYTES);
        term.write(disassembly);

        term.writeln("");
        term.writeln("Executing the same bytes for real...");
        const executionResult: string = engine.execute(DISASSEMBLY_DEMO_BYTES);
        term.writeln(executionResult);

        term.writeln("");
        term.writeln("Running self-test suite (CodeAssembler-built test vectors)...");
        const selfTestResult: string = engine.self_test();
        term.write(selfTestResult);
        term.writeln("");
        const loopTestResult: string = engine.loop_test();
        term.writeln(loopTestResult);

        term.writeln("");
        term.writeln("Running embedded ELF fixture...");
        const embeddedElf: Uint8Array = engine.embedded_elf();
        const elfResult: string = engine.run_elf(embeddedElf);
        term.write(elfResult);

        term.writeln("");
        term.writeln("Running C fixture (sum_squares)...");
        const sumSquares: Uint8Array = engine.embedded_sum_squares();
        term.writeln(engine.coverage_report(sumSquares));
        term.writeln("");
        term.writeln("C fixture execution:");
        term.writeln(engine.run_elf(sumSquares));
      } catch (err) {
        term.writeln("");
        term.writeln(`Error running engine: ${(err as Error).message}`);
      }
    })();

    return () => {
      term.dispose();
    };
  }, []);

  return (
    <div className="min-h-screen w-full bg-[#0b0e14] flex items-center justify-center p-6">
      <div className="w-full max-w-3xl">
        <h1 className="text-xl font-semibold text-gray-200 mb-3">Chameleon Shell</h1>
        <div
          ref={terminalContainerRef}
          className="w-full rounded-lg border border-gray-700 overflow-hidden p-2"
          style={{ backgroundColor: "#0b0e14" }}
        />
      </div>
    </div>
  );
}

export default App;
