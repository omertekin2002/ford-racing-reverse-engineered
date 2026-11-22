; Analyst label: read_ascii_tag; export span 0x0042d0a0..0x0042d2a0
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042d0a0 55                       push ebp
0042d0a1 89e5                     mov ebp, esp
0042d0a3 53                       push ebx
0042d0a4 51                       push ecx
0042d0a5 56                       push esi
0042d0a6 57                       push edi
0042d0a7 81ec10010000             sub esp, 0x110
0042d0ad 89c6                     mov esi, eax
0042d0af 8955ec                   mov dword ptr [ebp - 0x14], edx
0042d0b2 e809ffffff               call 0x42cfc0
0042d0b7 bb04010000               mov ebx, 0x104
0042d0bc 8d85e0feffff             lea eax, [ebp - 0x120]
0042d0c2 31d2                     xor edx, edx
0042d0c4 e8c7751000               call 0x534690
0042d0c9 31c9                     xor ecx, ecx
0042d0cb baf5ffffff               mov edx, 0xfffffff5
0042d0d0 31ff                     xor edi, edi
0042d0d2 8955e8                   mov dword ptr [ebp - 0x18], edx
0042d0d5 ba02000000               mov edx, 2
0042d0da 8d45e4                   lea eax, [ebp - 0x1c]
0042d0dd 8b5e04                   mov ebx, dword ptr [esi + 4]
0042d0e0 e8cb48fdff               call 0x4019b0
0042d0e5 85c0                     test eax, eax
0042d0e7 7465                     je 0x42d14e
0042d0e9 807de42f                 cmp byte ptr [ebp - 0x1c], 0x2f
0042d0ed 7531                     jne 0x42d120
0042d0ef 83f92f                   cmp ecx, 0x2f
0042d0f2 752c                     jne 0x42d120
0042d0f4 ba00010000               mov edx, 0x100
0042d0f9 8d85e0feffff             lea eax, [ebp - 0x120]
0042d0ff 8b5e04                   mov ebx, dword ptr [esi + 4]
0042d102 e8a948fdff               call 0x4019b0
0042d107 bb04010000               mov ebx, 0x104
0042d10c 8d85e0feffff             lea eax, [ebp - 0x120]
0042d112 31d2                     xor edx, edx
0042d114 e877751000               call 0x534690
0042d119 31c9                     xor ecx, ecx
0042d11b 8a4de4                   mov cl, byte ptr [ebp - 0x1c]
0042d11e ebb5                     jmp 0x42d0d5
0042d120 31c0                     xor eax, eax
0042d122 8a45e4                   mov al, byte ptr [ebp - 0x1c]
0042d125 f6806d7a5900c0           test byte ptr [eax + 0x597a6d], 0xc0
0042d12c 0f84e0000000             je 0x42d212
0042d132 83f95c                   cmp ecx, 0x5c
0042d135 0f84df000000             je 0x42d21a
0042d13b 8b4604                   mov eax, dword ptr [esi + 4]
0042d13e b9f1ffffff               mov ecx, 0xfffffff1
0042d143 e85848fdff               call 0x4019a0
0042d148 8d78ff                   lea edi, [eax - 1]
0042d14b 894de8                   mov dword ptr [ebp - 0x18], ecx
0042d14e 8a45e4                   mov al, byte ptr [ebp - 0x1c]
0042d151 8885e0feffff             mov byte ptr [ebp - 0x120], al
0042d157 31c0                     xor eax, eax
0042d159 8a45e4                   mov al, byte ptr [ebp - 0x1c]
0042d15c e8dffeffff               call 0x42d040
0042d161 85c0                     test eax, eax
0042d163 756f                     jne 0x42d1d4
0042d165 ba02000000               mov edx, 2
0042d16a 8d45e4                   lea eax, [ebp - 0x1c]
0042d16d 8b5e04                   mov ebx, dword ptr [esi + 4]
0042d170 b901000000               mov ecx, 1
0042d175 e83648fdff               call 0x4019b0
0042d17a 31c0                     xor eax, eax
0042d17c 8a45e4                   mov al, byte ptr [ebp - 0x1c]
0042d17f e8bcfeffff               call 0x42d040
0042d184 85c0                     test eax, eax
0042d186 754c                     jne 0x42d1d4
0042d188 41                       inc ecx
0042d189 8a45e4                   mov al, byte ptr [ebp - 0x1c]
0042d18c 888429dffeffff           mov byte ptr [ecx + ebp - 0x121], al
0042d193 81f904010000             cmp ecx, 0x104
0042d199 7625                     jbe 0x42d1c0
0042d19b babe000000               mov edx, 0xbe
0042d1a0 b8dcb75400               mov eax, 0x54b7dc
0042d1a5 31db                     xor ebx, ebx
0042d1a7 e8d4d3fdff               call 0x40a580
0042d1ac 8d85e0feffff             lea eax, [ebp - 0x120]
0042d1b2 50                       push eax
0042d1b3 68f8b75400               push 0x54b7f8
0042d1b8 e883d4fdff               call 0x40a640
0042d1bd 83c408                   add esp, 8
0042d1c0 ba02000000               mov edx, 2
0042d1c5 8d45e4                   lea eax, [ebp - 0x1c]
0042d1c8 8b5e04                   mov ebx, dword ptr [esi + 4]
0042d1cb e8e047fdff               call 0x4019b0
0042d1d0 85c0                     test eax, eax
0042d1d2 75a6                     jne 0x42d17a
0042d1d4 807de400                 cmp byte ptr [ebp - 0x1c], 0
0042d1d8 0f84aa000000             je 0x42d288
0042d1de 8b55ec                   mov edx, dword ptr [ebp - 0x14]
0042d1e1 8d85e0feffff             lea eax, [ebp - 0x120]
0042d1e7 e824010000               call 0x42d310
0042d1ec 89c1                     mov ecx, eax
0042d1ee 83f8ee                   cmp eax, -0x12
0042d1f1 7503                     jne 0x42d1f6
0042d1f3 8b4de8                   mov ecx, dword ptr [ebp - 0x18]
0042d1f6 83f9f1                   cmp ecx, -0xf
0042d1f9 750c                     jne 0x42d207
0042d1fb 89fa                     mov edx, edi
0042d1fd 8b4604                   mov eax, dword ptr [esi + 4]
0042d200 31db                     xor ebx, ebx
0042d202 e83947fdff               call 0x401940
0042d207 89c8                     mov eax, ecx
0042d209 8d65f0                   lea esp, [ebp - 0x10]
0042d20c 5f                       pop edi
0042d20d 5e                       pop esi
0042d20e 59                       pop ecx
0042d20f 5b                       pop ebx
0042d210 5d                       pop ebp
0042d211 c3                       ret 
0042d212 3c21                     cmp al, 0x21
0042d214 0f8418ffffff             je 0x42d132
0042d21a 31c0                     xor eax, eax
0042d21c 8a45e4                   mov al, byte ptr [ebp - 0x1c]
0042d21f f6806d7a5900e0           test byte ptr [eax + 0x597a6d], 0xe0
0042d226 7436                     je 0x42d25e
0042d228 83f95c                   cmp ecx, 0x5c
0042d22b 753b                     jne 0x42d268
0042d22d 8a65e4                   mov ah, byte ptr [ebp - 0x1c]
0042d230 80fc5b                   cmp ah, 0x5b
0042d233 0f8415ffffff             je 0x42d14e
0042d239 80fc3d                   cmp ah, 0x3d
0042d23c 0f840cffffff             je 0x42d14e
0042d242 80fc7d                   cmp ah, 0x7d
0042d245 0f8403ffffff             je 0x42d14e
0042d24b 80fc5d                   cmp ah, 0x5d
0042d24e 0f84fafeffff             je 0x42d14e
0042d254 31c9                     xor ecx, ecx
0042d256 8a4de4                   mov cl, byte ptr [ebp - 0x1c]
0042d259 e977feffff               jmp 0x42d0d5
0042d25e 3c2d                     cmp al, 0x2d
0042d260 74c6                     je 0x42d228
0042d262 3c2b                     cmp al, 0x2b
0042d264 74c2                     je 0x42d228
0042d266 ebc5                     jmp 0x42d22d
0042d268 bb01000000               mov ebx, 1
0042d26d baffffffff               mov edx, 0xffffffff
0042d272 8b4604                   mov eax, dword ptr [esi + 4]
0042d275 e8c646fdff               call 0x401940
0042d27a b8f0ffffff               mov eax, 0xfffffff0
0042d27f 8d65f0                   lea esp, [ebp - 0x10]
0042d282 5f                       pop edi
0042d283 5e                       pop esi
0042d284 59                       pop ecx
0042d285 5b                       pop ebx
0042d286 5d                       pop ebp
0042d287 c3                       ret 
0042d288 b9f5ffffff               mov ecx, 0xfffffff5
0042d28d 89c8                     mov eax, ecx
0042d28f 8d65f0                   lea esp, [ebp - 0x10]
0042d292 5f                       pop edi
0042d293 5e                       pop esi
0042d294 59                       pop ecx
0042d295 5b                       pop ebx
0042d296 5d                       pop ebp
0042d297 c3                       ret 
0042d298 8d8000000000             lea eax, [eax]
0042d29e 8bd2                     mov edx, edx
