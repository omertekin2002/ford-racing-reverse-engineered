; Analyst label: skip_to_colon_and_read_tag; export span 0x0042d2a0..0x0042d310
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042d2a0 55                       push ebp
0042d2a1 89e5                     mov ebp, esp
0042d2a3 53                       push ebx
0042d2a4 51                       push ecx
0042d2a5 56                       push esi
0042d2a6 81ec08010000             sub esp, 0x108
0042d2ac 89c1                     mov ecx, eax
0042d2ae 89d6                     mov esi, edx
0042d2b0 e80bfdffff               call 0x42cfc0
0042d2b5 bb04010000               mov ebx, 0x104
0042d2ba 8d85ecfeffff             lea eax, [ebp - 0x114]
0042d2c0 31d2                     xor edx, edx
0042d2c2 e8c9731000               call 0x534690
0042d2c7 ba02000000               mov edx, 2
0042d2cc 8d45f0                   lea eax, [ebp - 0x10]
0042d2cf 8b5904                   mov ebx, dword ptr [ecx + 4]
0042d2d2 e8d946fdff               call 0x4019b0
0042d2d7 85c0                     test eax, eax
0042d2d9 7406                     je 0x42d2e1
0042d2db 807df03a                 cmp byte ptr [ebp - 0x10], 0x3a
0042d2df 75e6                     jne 0x42d2c7
0042d2e1 bb01000000               mov ebx, 1
0042d2e6 baffffffff               mov edx, 0xffffffff
0042d2eb 8b4104                   mov eax, dword ptr [ecx + 4]
0042d2ee e84d46fdff               call 0x401940
0042d2f3 89f2                     mov edx, esi
0042d2f5 89c8                     mov eax, ecx
0042d2f7 e8a4fdffff               call 0x42d0a0
0042d2fc 8d65f4                   lea esp, [ebp - 0xc]
0042d2ff 5e                       pop esi
0042d300 59                       pop ecx
0042d301 5b                       pop ebx
0042d302 5d                       pop ebp
0042d303 c3                       ret 
0042d304 8d8000000000             lea eax, [eax]
0042d30a 8d9200000000             lea edx, [edx]
