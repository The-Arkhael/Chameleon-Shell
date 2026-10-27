typedef unsigned long size_t;

static inline long sys_write(long fd, const char *buffer, size_t count) {
    long result;
    __asm__ volatile(
        "syscall"
        : "=a"(result)
        : "a"(1L), "D"(fd), "S"(buffer), "d"(count)
        : "rcx", "r11", "memory");
    return result;
}

__attribute__((noreturn)) static inline void sys_exit(long status) {
    __asm__ volatile(
        "syscall"
        :
        : "a"(60L), "D"(status)
        : "rcx", "r11", "memory");
    for (;;) {
    }
}

__attribute__((noinline)) static unsigned long sum_squares(unsigned long limit) {
    unsigned long sum = 0;
    for (unsigned long i = 1; i <= limit; i++) {
        sum += i * i;
    }
    return sum;
}

static size_t append_unsigned_decimal(unsigned long value, char *output) {
    char digits[32];
    size_t digit_count = 0;

    do {
        digits[digit_count++] = (char)('0' + value % 10);
        value /= 10;
    } while (value != 0);

    for (size_t i = 0; i < digit_count; i++) {
        output[i] = digits[digit_count - i - 1];
    }
    return digit_count;
}

void c_main(void) {
    char output[32];
    size_t length = 0;

    output[length++] = 's';
    output[length++] = 'u';
    output[length++] = 'm';
    output[length++] = '=';
    length += append_unsigned_decimal(sum_squares(100), output + length);
    output[length++] = '\n';

    sys_write(1, output, length);
    sys_exit(0);
}

__asm__(
    ".global _start\n"
    ".type _start, @function\n"
    "_start:\n"
    "    call c_main\n"
    ".size _start, .-_start\n");