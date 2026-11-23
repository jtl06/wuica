// minimal headers for building XED without a libc (wasm32-unknown-unknown); see ../libc_min.c
typedef void FILE;
extern void* stderr;
int fprintf(void*, const char*, ...);
