.global _start
.section .text

_start:
    mov $1, %rax
    mov $1, %rdi
    mov $message, %rsi
    mov $6, %rdx
    syscall

    mov $60, %rax
    mov $37, %rdi
    syscall

.section .rodata
message:
    .ascii "hello\n"
