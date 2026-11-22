; Analyst label: is_ascii_delimiter; export span 0x0042d040..0x0042d0a0
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042d040 83f829                   cmp eax, 0x29
0042d043 7d17                     jge 0x42d05c
0042d045 83f80a                   cmp eax, 0xa
0042d048 7d3b                     jge 0x42d085
0042d04a 83f8ff                   cmp eax, -1
0042d04d 7c20                     jl 0x42d06f
0042d04f 7e05                     jle 0x42d056
0042d051 83f809                   cmp eax, 9
0042d054 7519                     jne 0x42d06f
0042d056 b801000000               mov eax, 1
0042d05b c3                       ret 
0042d05c 7ef8                     jle 0x42d056
0042d05e 83f83a                   cmp eax, 0x3a
0042d061 7d0f                     jge 0x42d072
0042d063 83f82c                   cmp eax, 0x2c
0042d066 7c07                     jl 0x42d06f
0042d068 7eec                     jle 0x42d056
0042d06a 83f82e                   cmp eax, 0x2e
0042d06d 74e7                     je 0x42d056
0042d06f 31c0                     xor eax, eax
0042d071 c3                       ret 
0042d072 7ee2                     jle 0x42d056
0042d074 83f85b                   cmp eax, 0x5b
0042d077 7d05                     jge 0x42d07e
0042d079 83f83b                   cmp eax, 0x3b
0042d07c ebef                     jmp 0x42d06d
0042d07e 7ed6                     jle 0x42d056
0042d080 83f85d                   cmp eax, 0x5d
0042d083 ebe8                     jmp 0x42d06d
0042d085 7ecf                     jle 0x42d056
0042d087 83f80d                   cmp eax, 0xd
0042d08a 7ce3                     jl 0x42d06f
0042d08c 7ec8                     jle 0x42d056
0042d08e 83f820                   cmp eax, 0x20
0042d091 74c3                     je 0x42d056
0042d093 31c0                     xor eax, eax
0042d095 c3                       ret 
0042d096 8d8000000000             lea eax, [eax]
0042d09c 8d542200                 lea edx, [edx]
