// flags_oracle.c - execute single NEG / SHR / SAR instructions on the real CPU and print,
// for each (operation, width, input, count), the resulting register and the four status
// flags the Chameleon engine models (CF, ZF, SF, OF).
//
// Every row is run twice, once with all status flags clear and once with all of them set.
// That separates the three kinds of flag cell:
//   0 / 1 : the instruction DEFINES this flag; both runs produced the same value.
//   =     : the instruction must leave the flag UNCHANGED (run 1 kept 0, run 2 kept 1).
//   -     : architecturally UNDEFINED for this input (Intel SDM); the value is not recorded.
// The classification of each cell comes from the Intel SDM rules coded in expect_class();
// the native results are used to CHECK those rules (the generator aborts if the CPU
// disagrees), so the table cannot silently encode a wrong rule or CPU-specific behavior.
//
// Build:  gcc -O1 -mno-red-zone -Wall -Wextra -o flags_oracle flags_oracle.c
//         (-mno-red-zone: the inline asm pushes/pops the stack)
// Run:    ./flags_oracle > flags_oracle.txt        (x86-64 only; the output is identical on every conforming CPU)

#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define F_CF 0x001ULL
#define F_PF 0x004ULL
#define F_AF 0x010ULL
#define F_ZF 0x040ULL
#define F_SF 0x080ULL
#define F_OF 0x800ULL
#define INIT0 0x002ULL /* only the always-set reserved bit: all status flags clear */
#define INIT1 (0x002ULL | F_CF | F_PF | F_AF | F_ZF | F_SF | F_OF)

typedef struct {
    uint64_t rax;
    uint64_t fl;
} res_t;

#define SHIFT_FN(NAME, INSN, REG)                                                              \
    static res_t NAME(uint64_t rax_in, uint64_t cl_in, uint64_t init) {                        \
        uint64_t rax = rax_in, rcx = cl_in, fl;                                                \
        __asm__ volatile("push %[init]\n\t"                                                    \
                         "popfq\n\t" INSN " %%cl, " REG "\n\t"                                 \
                         "pushfq\n\t"                                                          \
                         "pop %[fl]\n\t"                                                       \
                         : "+a"(rax), "+c"(rcx), [fl] "=r"(fl)                                 \
                         : [init] "r"(init)                                                    \
                         : "cc", "memory");                                                    \
        return (res_t){rax, fl};                                                               \
    }

#define NEG_FN(NAME, REG)                                                                      \
    static res_t NAME(uint64_t rax_in, uint64_t unused, uint64_t init) {                       \
        (void)unused;                                                                          \
        uint64_t rax = rax_in, fl;                                                             \
        __asm__ volatile("push %[init]\n\t"                                                    \
                         "popfq\n\t"                                                           \
                         "neg " REG "\n\t"                                                     \
                         "pushfq\n\t"                                                          \
                         "pop %[fl]\n\t"                                                       \
                         : "+a"(rax), [fl] "=r"(fl)                                            \
                         : [init] "r"(init)                                                    \
                         : "cc", "memory");                                                    \
        return (res_t){rax, fl};                                                               \
    }

SHIFT_FN(shr8, "shr", "%%al")
SHIFT_FN(shr16, "shr", "%%ax")
SHIFT_FN(shr32, "shr", "%%eax")
SHIFT_FN(shr64, "shr", "%%rax")
SHIFT_FN(sar8, "sar", "%%al")
SHIFT_FN(sar16, "sar", "%%ax")
SHIFT_FN(sar32, "sar", "%%eax")
SHIFT_FN(sar64, "sar", "%%rax")
NEG_FN(neg8, "%%al")
NEG_FN(neg16, "%%ax")
NEG_FN(neg32, "%%eax")
NEG_FN(neg64, "%%rax")

typedef res_t (*fn_t)(uint64_t, uint64_t, uint64_t);

struct op {
    const char *name;
    int width;
    fn_t fn;
    int is_shift;
    int is_sar;
};

static const struct op OPS[] = {
    {"neg", 8, neg8, 0, 0},   {"neg", 16, neg16, 0, 0}, {"neg", 32, neg32, 0, 0},
    {"neg", 64, neg64, 0, 0}, {"shr", 8, shr8, 1, 0},   {"shr", 16, shr16, 1, 0},
    {"shr", 32, shr32, 1, 0}, {"shr", 64, shr64, 1, 0}, {"sar", 8, sar8, 1, 1},
    {"sar", 16, sar16, 1, 1}, {"sar", 32, sar32, 1, 1}, {"sar", 64, sar64, 1, 1},
};

static uint64_t wmask(int w) { return w == 64 ? ~0ULL : ((1ULL << w) - 1); }

enum cls { DEFINED, PRESERVED, UNDEFINED };

/* Intel SDM rules for the four modeled flags. idx: 0=CF 1=ZF 2=SF 3=OF. */
static enum cls expect_class(const struct op *o, uint64_t count, int idx) {
    if (!o->is_shift) return DEFINED; /* NEG defines CF, ZF, SF, OF for every input */
    uint64_t m = count & (o->width == 64 ? 63 : 31);
    if (m == 0) return PRESERVED; /* "If the count is 0, the flags are not affected." */
    switch (idx) {
    case 0: /* CF: last bit shifted out; undefined for SHR when count >= operand size */
        if (!o->is_sar && m >= (uint64_t)o->width) return UNDEFINED;
        return DEFINED;
    case 1:
    case 2: /* ZF, SF from the result */
        return DEFINED;
    default: /* OF is only defined for 1-bit shifts */
        return m == 1 ? DEFINED : UNDEFINED;
    }
}

static const uint64_t FLAGBIT[4] = {F_CF, F_ZF, F_SF, F_OF};

static void cpu_model(char *buf, size_t cap) {
    buf[0] = 0;
    FILE *f = fopen("/proc/cpuinfo", "r");
    if (!f) { snprintf(buf, cap, "unknown"); return; }
    char line[512];
    while (fgets(line, sizeof line, f)) {
        if (!strncmp(line, "model name", 10)) {
            char *c = strchr(line, ':');
            if (c) { snprintf(buf, cap, "%s", c + 2); buf[strcspn(buf, "\n")] = 0; }
            break;
        }
    }
    fclose(f);
    if (!buf[0]) snprintf(buf, cap, "unknown");
}

int main(void) {
    char model[256];
    cpu_model(model, sizeof model);
    printf("# flags_oracle.txt - native single-instruction results (generated by flags_oracle.c)\n");
    fprintf(stderr, "flags_oracle: running on %s\n", model); /* not in the table: the file must not depend on the machine */
    printf("# row:  op width rax_in cl_in | rax_out cf zf sf of        (all hex, rax is the full 64-bit register)\n");
    printf("# cell: 0/1 = defined result, '=' = flag must be unchanged from its initial value, '-' = undefined (not asserted)\n");
    printf("# rax_in carries a marker pattern above the operand width so partial-register writes are checked too;\n");
    printf("# the engine test must start from rax_in, cl_in and BOTH flag states (all clear, all set) and compare rax_out.\n");

    int rows = 0;
    for (size_t oi = 0; oi < sizeof OPS / sizeof OPS[0]; oi++) {
        const struct op *o = &OPS[oi];
        int w = o->width;
        uint64_t mk = wmask(w), minv = 1ULL << (w - 1);
        uint64_t vals[] = {0, 1, minv - 1, minv, minv + 1, mk, 0x5555555555555555ULL & mk, 0xAAAAAAAAAAAAAAAAULL & mk};
        uint64_t cnts[] = {0, 1, 2, (uint64_t)w - 1, (uint64_t)w, (uint64_t)w + 1, 31, 32, 33, 63, 64, 65};
        size_t nv = sizeof vals / sizeof vals[0], nc = o->is_shift ? sizeof cnts / sizeof cnts[0] : 1;
        for (size_t vi = 0; vi < nv; vi++) {
            int dup = 0;
            for (size_t k = 0; k < vi; k++) if (vals[k] == vals[vi]) dup = 1;
            if (dup) continue;
            for (size_t ci = 0; ci < nc; ci++) {
                int cdup = 0;
                for (size_t k = 0; k < ci; k++) if (cnts[k] == cnts[ci]) cdup = 1;
                if (cdup) continue;
                uint64_t count = o->is_shift ? cnts[ci] : 0;
                uint64_t rax_in = (w == 64) ? vals[vi] : ((0xDEADBEEFCAFEF00DULL & ~mk) | vals[vi]);
                res_t a = o->fn(rax_in, count, INIT0);
                res_t b = o->fn(rax_in, count, INIT1);
                if (a.rax != b.rax) {
                    fprintf(stderr, "ABORT: %s%d result depends on initial flags (rax_in=%" PRIx64 ")\n", o->name, w, rax_in);
                    return 1;
                }
                char cell[4];
                for (int fi = 0; fi < 4; fi++) {
                    uint64_t bit = FLAGBIT[fi];
                    int a1 = (a.fl & bit) != 0, b1 = (b.fl & bit) != 0;
                    enum cls c = expect_class(o, count, fi);
                    if (c == DEFINED) {
                        if (a1 != b1) {
                            fprintf(stderr, "ABORT: SDM says flag %d is defined for %s%d rax_in=%" PRIx64 " count=%" PRIu64 " but the CPU result depends on the initial flags\n", fi, o->name, w, rax_in, count);
                            return 1;
                        }
                        cell[fi] = a1 ? '1' : '0';
                    } else if (c == PRESERVED) {
                        if (a1 != 0 || b1 != 1) {
                            fprintf(stderr, "ABORT: SDM says flag %d is unchanged for %s%d count=%" PRIu64 " but the CPU changed it\n", fi, o->name, w, count);
                            return 1;
                        }
                        cell[fi] = '=';
                    } else {
                        cell[fi] = '-';
                    }
                }
                if (o->is_shift)
                    printf("%s %d %016" PRIX64 " %02" PRIX64 " | %016" PRIX64 " %c %c %c %c\n", o->name, w, rax_in, count, a.rax, cell[0], cell[1], cell[2], cell[3]);
                else
                    printf("%s %d %016" PRIX64 " -- | %016" PRIX64 " %c %c %c %c\n", o->name, w, rax_in, a.rax, cell[0], cell[1], cell[2], cell[3]);
                rows++;
            }
        }
    }
    fprintf(stderr, "flags_oracle: %d rows, every SDM-defined/unchanged cell confirmed natively\n", rows);
    return 0;
}
