; Analyst label: seek_tag; export span 0x0042e5a0..0x0042e610
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042e5a0 51                       push ecx
0042e5a1 56                       push esi
0042e5a2 57                       push edi
0042e5a3 89c6                     mov esi, eax
0042e5a5 89d7                     mov edi, edx
0042e5a7 8b00                     mov eax, dword ptr [eax]
0042e5a9 b9ffffffff               mov ecx, 0xffffffff
0042e5ae 83f801                   cmp eax, 1
0042e5b1 7313                     jae 0x42e5c6
0042e5b3 85c0                     test eax, eax
0042e5b5 7516                     jne 0x42e5cd
0042e5b7 39f9                     cmp ecx, edi
0042e5b9 7405                     je 0x42e5c0
0042e5bb 83f9f5                   cmp ecx, -0xb
0042e5be 753b                     jne 0x42e5fb
0042e5c0 89c8                     mov eax, ecx
0042e5c2 5f                       pop edi
0042e5c3 5e                       pop esi
0042e5c4 59                       pop ecx
0042e5c5 c3                       ret 
0042e5c6 7628                     jbe 0x42e5f0
0042e5c8 83f802                   cmp eax, 2
0042e5cb 74ea                     je 0x42e5b7
0042e5cd bae7010000               mov edx, 0x1e7
0042e5d2 b8ecba5400               mov eax, 0x54baec
0042e5d7 31db                     xor ebx, ebx
0042e5d9 e8a2bffdff               call 0x40a580
0042e5de 8b16                     mov edx, dword ptr [esi]
0042e5e0 52                       push edx
0042e5e1 6808bb5400               push 0x54bb08
0042e5e6 e855c0fdff               call 0x40a640
0042e5eb 83c408                   add esp, 8
0042e5ee ebd0                     jmp 0x42e5c0
0042e5f0 89f0                     mov eax, esi
0042e5f2 e869f5ffff               call 0x42db60
0042e5f7 89c1                     mov ecx, eax
0042e5f9 ebc5                     jmp 0x42e5c0
0042e5fb 89da                     mov edx, ebx
0042e5fd 89f0                     mov eax, esi
0042e5ff e89cecffff               call 0x42d2a0
0042e604 89c1                     mov ecx, eax
0042e606 ebaf                     jmp 0x42e5b7
0042e608 8d8000000000             lea eax, [eax]
0042e60e 8bd2                     mov edx, edx
