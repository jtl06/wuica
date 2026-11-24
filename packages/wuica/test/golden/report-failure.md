**analysis failed:** assembly failed: line 2: invalid instruction mnemonic 'foo'

```
<input>:2:1: error: invalid instruction mnemonic 'foo'
foo bar, baz
^~~
```

```asm
add rax, rbx
foo bar, baz
```
