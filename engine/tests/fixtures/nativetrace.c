// nativetrace.c - run a static, non-PIE x86-64 Linux ELF on the real CPU under ptrace
// single-step and record the address of every instruction it executes.
//
// Two ways to start the guest (both are single-stepped from its first instruction):
//   --kernel : plain execve(); the kernel builds the initial stack and auxiliary vector.
//   --custom : this program maps the PT_LOAD segments itself, builds a minimal initial
//              process stack (argc/argv/envp/auxv, 16-byte aligned, at a fixed address
//              below 16 MiB) and points RIP at e_entry. This is the environment the
//              Chameleon engine can reproduce, so it is the reference for the engine.
//
// Output (stderr is diagnostics, the guest's own stdout/stderr pass through untouched):
//   --trace FILE   one line per executed instruction:  "<step> <rip>"  (or with --regs all GPRs)
//   --stack FILE   a readable description of the initial stack at the entry point
//
// Build: gcc -O1 -g -Wall -Wextra -o nativetrace nativetrace.c   (default PIE on purpose:
// the guest lives at 0x400000.., so this tool must not).

#define _GNU_SOURCE
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/ptrace.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <unistd.h>

#define STACK_TOP 0x1000000ULL  /* 16 MiB: same as the engine's MEMORY_SIZE */
#define STACK_SIZE 0x100000ULL  /* 1 MiB window below it */
#define MAX_STEPS 20000000ULL

static void die(const char *msg) {
    fprintf(stderr, "nativetrace: %s: %s\n", msg, strerror(errno));
    exit(2);
}

static void fail(const char *msg) {
    fprintf(stderr, "nativetrace: %s\n", msg);
    exit(2);
}

/* ---------- custom environment (child side, before PTRACE_TRACEME) ---------- */

struct custom {
    uint64_t entry;
    uint64_t sp;          /* initial RSP: points at argc */
    uint64_t stack_lo;    /* lowest address of the filled initial-stack area (== sp) */
};

static uint8_t *read_file(const char *path, size_t *len) {
    int fd = open(path, O_RDONLY);
    if (fd < 0) die("open elf");
    struct stat st;
    if (fstat(fd, &st) < 0) die("fstat");
    uint8_t *buf = malloc((size_t)st.st_size);
    if (!buf) die("malloc");
    size_t got = 0;
    while (got < (size_t)st.st_size) {
        ssize_t n = read(fd, buf + got, (size_t)st.st_size - got);
        if (n <= 0) die("read elf");
        got += (size_t)n;
    }
    close(fd);
    *len = got;
    return buf;
}

/* A tiny bump writer that fills guest memory top-down. */
struct stackw {
    uint64_t sp;
};

static uint64_t push_bytes(struct stackw *w, const void *data, size_t len) {
    w->sp -= len;
    memcpy((void *)(uintptr_t)w->sp, data, len);
    return w->sp;
}

static uint64_t push_str(struct stackw *w, const char *s) {
    return push_bytes(w, s, strlen(s) + 1);
}

static void setup_custom(const char *path, char *const guest_argv[], char *const guest_envp[],
                         const uint8_t rnd[16], struct custom *out) {
    size_t len;
    uint8_t *img = read_file(path, &len);
    if (len < sizeof(Elf64_Ehdr)) fail("file too small for an ELF header");
    Elf64_Ehdr *eh = (Elf64_Ehdr *)img;
    if (memcmp(eh->e_ident, ELFMAG, SELFMAG) != 0) fail("not an ELF file");
    if (eh->e_ident[EI_CLASS] != ELFCLASS64 || eh->e_machine != EM_X86_64) fail("not x86-64 ELF64");
    if (eh->e_type != ET_EXEC) fail("only static non-PIE (ET_EXEC) is supported");
    if (eh->e_phoff + (uint64_t)eh->e_phnum * sizeof(Elf64_Phdr) > len) fail("phdrs outside file");
    Elf64_Phdr *ph = (Elf64_Phdr *)(img + eh->e_phoff);

    uint64_t lo = UINT64_MAX, hi = 0;
    for (int i = 0; i < eh->e_phnum; i++) {
        if (ph[i].p_type != PT_LOAD) continue;
        uint64_t s = ph[i].p_vaddr & ~0xfffULL;
        uint64_t e = (ph[i].p_vaddr + ph[i].p_memsz + 0xfff) & ~0xfffULL;
        if (s < lo) lo = s;
        if (e > hi) hi = e;
    }
    if (lo == UINT64_MAX) fail("no PT_LOAD");
    if (hi > STACK_TOP - STACK_SIZE) fail("image overlaps the stack window");
    void *m = mmap((void *)(uintptr_t)lo, hi - lo, PROT_READ | PROT_WRITE | PROT_EXEC,
                   MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (m == MAP_FAILED) die("mmap image");
    for (int i = 0; i < eh->e_phnum; i++) {
        if (ph[i].p_type != PT_LOAD) continue;
        if (ph[i].p_offset + ph[i].p_filesz > len) fail("segment outside file");
        memcpy((void *)(uintptr_t)ph[i].p_vaddr, img + ph[i].p_offset, ph[i].p_filesz);
    }

    /* AT_PHDR: address of the program header table in guest memory. */
    uint64_t phdr_addr = 0;
    for (int i = 0; i < eh->e_phnum; i++) {
        if (ph[i].p_type == PT_LOAD && eh->e_phoff >= ph[i].p_offset &&
            eh->e_phoff < ph[i].p_offset + ph[i].p_filesz) {
            phdr_addr = ph[i].p_vaddr + (eh->e_phoff - ph[i].p_offset);
            break;
        }
    }
    if (!phdr_addr) fail("program headers are not inside any PT_LOAD");

    void *st = mmap((void *)(uintptr_t)(STACK_TOP - STACK_SIZE), STACK_SIZE,
                    PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (st == MAP_FAILED) die("mmap stack");

    struct stackw w = {.sp = STACK_TOP};
    uint64_t zero8 = 0;
    push_bytes(&w, &zero8, 8); /* a little headroom at the very top, like the kernel's end marker */

    int argc = 0, envc = 0;
    while (guest_argv[argc]) argc++;
    while (guest_envp[envc]) envc++;

    uint64_t execfn = push_str(&w, guest_argv[0]);
    uint64_t *envp_addr = calloc((size_t)envc + 1, sizeof(uint64_t));
    uint64_t *argv_addr = calloc((size_t)argc + 1, sizeof(uint64_t));
    for (int i = envc - 1; i >= 0; i--) envp_addr[i] = push_str(&w, guest_envp[i]);
    for (int i = argc - 1; i >= 0; i--) argv_addr[i] = push_str(&w, guest_argv[i]);
    uint64_t platform = push_str(&w, "x86_64");
    w.sp &= ~0xfULL;
    uint64_t random_addr = push_bytes(&w, rnd, 16);

    /* auxv: (type, value) pairs, AT_NULL last. Order is the order we emit. */
    uint64_t aux[][2] = {
        {AT_PHDR, phdr_addr},
        {AT_PHENT, eh->e_phentsize},
        {AT_PHNUM, eh->e_phnum},
        {AT_PAGESZ, 4096},
        {AT_ENTRY, eh->e_entry},
        {AT_UID, 1000},
        {AT_EUID, 1000},
        {AT_GID, 1000},
        {AT_EGID, 1000},
        {AT_SECURE, 0},
        {AT_RANDOM, random_addr},
        {AT_HWCAP, 0},
        {AT_CLKTCK, 100},
        {AT_PLATFORM, platform},
        {AT_EXECFN, execfn},
        {AT_NULL, 0},
    };
    size_t naux = sizeof(aux) / sizeof(aux[0]);

    size_t words = 1 + (size_t)argc + 1 + (size_t)envc + 1 + naux * 2;
    w.sp &= ~0xfULL;
    w.sp -= words * 8;
    if (w.sp & 0xf) w.sp -= 8; /* final RSP (-> argc) must be 16-byte aligned */
    uint64_t *p = (uint64_t *)(uintptr_t)w.sp;
    size_t k = 0;
    p[k++] = (uint64_t)argc;
    for (int i = 0; i < argc; i++) p[k++] = argv_addr[i];
    p[k++] = 0;
    for (int i = 0; i < envc; i++) p[k++] = envp_addr[i];
    p[k++] = 0;
    for (size_t i = 0; i < naux; i++) {
        p[k++] = aux[i][0];
        p[k++] = aux[i][1];
    }
    out->entry = eh->e_entry;
    out->sp = w.sp;
    out->stack_lo = w.sp;
    free(img);
    free(envp_addr);
    free(argv_addr);
}

/* ---------- initial stack description (parent side, reads child memory) ---------- */

static int peek(pid_t pid, uint64_t addr, uint64_t *val) {
    errno = 0;
    long v = ptrace(PTRACE_PEEKDATA, pid, (void *)(uintptr_t)addr, 0);
    if (v == -1 && errno) return -1;
    *val = (uint64_t)v;
    return 0;
}

static void peek_str(pid_t pid, uint64_t addr, char *buf, size_t cap) {
    size_t n = 0;
    while (n + 1 < cap) {
        uint64_t w;
        if (peek(pid, addr + n, &w) < 0) break;
        for (int i = 0; i < 8 && n + 1 < cap; i++) {
            char c = (char)((w >> (8 * i)) & 0xff);
            buf[n++] = c;
            if (!c) {
                return;
            }
        }
    }
    buf[n] = 0;
}

static const char *at_name(uint64_t t) {
    switch (t) {
    case 0: return "AT_NULL";
    case 3: return "AT_PHDR";
    case 4: return "AT_PHENT";
    case 5: return "AT_PHNUM";
    case 6: return "AT_PAGESZ";
    case 7: return "AT_BASE";
    case 8: return "AT_FLAGS";
    case 9: return "AT_ENTRY";
    case 11: return "AT_UID";
    case 12: return "AT_EUID";
    case 13: return "AT_GID";
    case 14: return "AT_EGID";
    case 15: return "AT_PLATFORM";
    case 16: return "AT_HWCAP";
    case 17: return "AT_CLKTCK";
    case 23: return "AT_SECURE";
    case 24: return "AT_BASE_PLATFORM";
    case 25: return "AT_RANDOM";
    case 26: return "AT_HWCAP2";
    case 31: return "AT_EXECFN";
    case 32: return "AT_SYSINFO";
    case 33: return "AT_SYSINFO_EHDR";
    case 51: return "AT_MINSIGSTKSZ";
    default: return "AT_?";
    }
}

static void describe_stack(pid_t pid, uint64_t rsp, FILE *f) {
    uint64_t argc;
    if (peek(pid, rsp, &argc) < 0) {
        fprintf(f, "cannot read argc at rsp=0x%" PRIx64 "\n", rsp);
        return;
    }
    fprintf(f, "rsp_at_entry=0x%" PRIx64 " (rsp %% 16 = %" PRIu64 ")\n", rsp, rsp % 16);
    fprintf(f, "argc=%" PRIu64 "\n", argc);
    uint64_t a = rsp + 8;
    char buf[512];
    for (uint64_t i = 0; i < argc; i++, a += 8) {
        uint64_t p;
        peek(pid, a, &p);
        peek_str(pid, p, buf, sizeof buf);
        fprintf(f, "argv[%" PRIu64 "]=0x%" PRIx64 " \"%s\"\n", i, p, buf);
    }
    a += 8; /* argv NULL */
    int i = 0;
    for (;; i++, a += 8) {
        uint64_t p;
        peek(pid, a, &p);
        if (!p) break;
        peek_str(pid, p, buf, sizeof buf);
        if (i < 6) fprintf(f, "envp[%d]=0x%" PRIx64 " \"%s\"\n", i, p, buf);
    }
    fprintf(f, "envc=%d\n", i);
    a += 8; /* envp NULL */
    for (;; a += 16) {
        uint64_t t, v;
        peek(pid, a, &t);
        peek(pid, a + 8, &v);
        fprintf(f, "auxv %-16s (%2" PRIu64 ") = 0x%" PRIx64 "\n", at_name(t), t, v);
        if (t == 0) break;
    }
    fprintf(f, "auxv_end=0x%" PRIx64 "\n", a + 16);
}

/* ---------- main ---------- */

int main(int argc, char **argv) {
    int custom = 0, regs_out = 0;
    const char *trace_path = NULL, *stack_path = NULL;
    int i = 1;
    for (; i < argc && argv[i][0] == '-' && argv[i][1] == '-'; i++) {
        if (!strcmp(argv[i], "--kernel")) custom = 0;
        else if (!strcmp(argv[i], "--custom")) custom = 1;
        else if (!strcmp(argv[i], "--regs")) regs_out = 1;
        else if (!strcmp(argv[i], "--trace") && i + 1 < argc) trace_path = argv[++i];
        else if (!strcmp(argv[i], "--stack") && i + 1 < argc) stack_path = argv[++i];
        else if (!strcmp(argv[i], "--")) { i++; break; }
        else fail("unknown option");
    }
    if (i >= argc) fail("usage: nativetrace [--kernel|--custom] [--regs] [--trace F] [--stack F] ELF [guest-argv0 ...]");
    const char *elf = argv[i++];
    /* guest argv: if none given, argv[0] = the ELF path */
    char *default_argv[2] = {(char *)elf, NULL};
    char **gargv = (i < argc) ? &argv[i] : default_argv;

    static char env0[] = "PATH=/usr/bin:/bin";
    static char env1[] = "HOME=/root";
    char *custom_envp[] = {env0, env1, NULL};
    static const uint8_t rnd[16] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
                                    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff};

    struct custom c = {0};
    pid_t pid = fork();
    if (pid < 0) die("fork");
    if (pid == 0) {
        if (custom) setup_custom(elf, gargv, custom_envp, rnd, &c);
        if (ptrace(PTRACE_TRACEME, 0, 0, 0) < 0) die("PTRACE_TRACEME");
        if (custom) {
            raise(SIGSTOP);
            _exit(99); /* never reached: the parent redirects RIP to the guest entry */
        }
        execv(elf, gargv);
        die("execv");
    }

    int status;
    if (waitpid(pid, &status, 0) < 0) die("waitpid");
    if (!WIFSTOPPED(status)) fail("child did not stop at start");

    struct user_regs_struct r;
    if (ptrace(PTRACE_GETREGS, pid, 0, &r) < 0) die("GETREGS");

    if (custom) {
        /* The child filled its own address space and stopped itself. 'c' is a local of
         * main(); fork() keeps the layout, so the same address in the child holds the
         * entry point and stack pointer the child chose. Read them out of the child. */
        uint64_t entry, sp;
        if (peek(pid, (uint64_t)(uintptr_t)&c.entry, &entry) < 0) die("peek c.entry");
        if (peek(pid, (uint64_t)(uintptr_t)&c.sp, &sp) < 0) die("peek c.sp");
        memset(&r, 0, sizeof r);
        r.rip = entry;
        r.rsp = sp;
        r.eflags = 0x202;
        r.cs = 0x33;
        r.ss = 0x2b;
        r.orig_rax = (unsigned long long)-1;
        if (ptrace(PTRACE_SETREGS, pid, 0, &r) < 0) die("SETREGS");
        if (ptrace(PTRACE_GETREGS, pid, 0, &r) < 0) die("GETREGS 2");
    }

    if (stack_path) {
        FILE *sf = fopen(stack_path, "w");
        if (!sf) die("open stack file");
        fprintf(sf, "mode=%s\nentry_rip=0x%llx\n", custom ? "custom" : "kernel", r.rip);
        describe_stack(pid, r.rsp, sf);
        fclose(sf);
    }

    FILE *tf = NULL;
    if (trace_path) {
        tf = fopen(trace_path, "w");
        if (!tf) die("open trace file");
    }

    uint64_t steps = 0;
    int exit_code = -1, term_sig = 0;
    for (;;) {
        if (tf) {
            if (regs_out)
                fprintf(tf,
                        "%" PRIu64 " %llx rax=%llx rbx=%llx rcx=%llx rdx=%llx rsi=%llx rdi=%llx rbp=%llx "
                        "rsp=%llx r8=%llx r9=%llx r10=%llx r11=%llx r12=%llx r13=%llx r14=%llx r15=%llx "
                        "fl=%llx\n",
                        steps, r.rip, r.rax, r.rbx, r.rcx, r.rdx, r.rsi, r.rdi, r.rbp, r.rsp, r.r8, r.r9,
                        r.r10, r.r11, r.r12, r.r13, r.r14, r.r15, r.eflags);
            else
                fprintf(tf, "%" PRIu64 " %llx\n", steps, r.rip);
        }
        steps++;
        if (steps > MAX_STEPS) {
            kill(pid, SIGKILL);
            fail("step limit exceeded");
        }
        if (ptrace(PTRACE_SINGLESTEP, pid, 0, 0) < 0) die("SINGLESTEP");
        if (waitpid(pid, &status, 0) < 0) die("waitpid step");
        if (WIFEXITED(status)) {
            exit_code = WEXITSTATUS(status);
            break;
        }
        if (WIFSIGNALED(status)) {
            term_sig = WTERMSIG(status);
            break;
        }
        if (WIFSTOPPED(status) && WSTOPSIG(status) != SIGTRAP) {
            fprintf(stderr, "nativetrace: guest stopped by signal %d at rip=0x%llx after %" PRIu64 " steps\n",
                    WSTOPSIG(status), r.rip, steps);
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            term_sig = WSTOPSIG(status);
            break;
        }
        if (ptrace(PTRACE_GETREGS, pid, 0, &r) < 0) die("GETREGS step");
    }
    if (tf) fclose(tf);
    fprintf(stderr, "nativetrace: mode=%s steps=%" PRIu64 " exit_code=%d term_sig=%d\n",
            custom ? "custom" : "kernel", steps, exit_code, term_sig);
    return term_sig ? 3 : 0;
}
