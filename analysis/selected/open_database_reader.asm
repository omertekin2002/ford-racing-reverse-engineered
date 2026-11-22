; Analyst label: open_database_reader; export span 0x0042e920..0x0042ea40
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042e920 55                       push ebp
0042e921 89e5                     mov ebp, esp
0042e923 56                       push esi
0042e924 57                       push edi
0042e925 81ec08010000             sub esp, 0x108
0042e92b 89c7                     mov edi, eax
0042e92d 89d6                     mov esi, edx
0042e92f 895df0                   mov dword ptr [ebp - 0x10], ebx
0042e932 ba08000000               mov edx, 8
0042e937 31db                     xor ebx, ebx
0042e939 e8a2cdfdff               call 0x40b6e0
0042e93e bb08000000               mov ebx, 8
0042e943 89c1                     mov ecx, eax
0042e945 31d2                     xor edx, edx
0042e947 8945f4                   mov dword ptr [ebp - 0xc], eax
0042e94a e8415d1000               call 0x534690
0042e94f bb00010000               mov ebx, 0x100
0042e954 8d85f0feffff             lea eax, [ebp - 0x110]
0042e95a 31d2                     xor edx, edx
0042e95c e82f5d1000               call 0x534690
0042e961 8b55f0                   mov edx, dword ptr [ebp - 0x10]
0042e964 83fa03                   cmp edx, 3
0042e967 7729                     ja 0x42e992
0042e969 89d0                     mov eax, edx
0042e96b ff248510e94200           jmp dword ptr [eax*4 + 0x42e910]
0042e972 56                       push esi
0042e973 6830bb5400               push 0x54bb30
0042e978 6800010000               push 0x100
0042e97d 8d85f0feffff             lea eax, [ebp - 0x110]
0042e983 50                       push eax
0042e984 c70100000000             mov dword ptr [ecx], 0
0042e98a e85131fdff               call 0x401ae0
0042e98f 83c410                   add esp, 0x10
0042e992 8d95f0feffff             lea edx, [ebp - 0x110]
0042e998 89f8                     mov eax, edi
0042e99a e8e12efdff               call 0x401880
0042e99f 8b55f4                   mov edx, dword ptr [ebp - 0xc]
0042e9a2 894204                   mov dword ptr [edx + 4], eax
0042e9a5 85c0                     test eax, eax
0042e9a7 7461                     je 0x42ea0a
0042e9a9 8b45f4                   mov eax, dword ptr [ebp - 0xc]
0042e9ac 8d65f8                   lea esp, [ebp - 8]
0042e9af 5f                       pop edi
0042e9b0 5e                       pop esi
0042e9b1 5d                       pop ebp
0042e9b2 c20400                   ret 4
0042e9b5 56                       push esi
0042e9b6 6844bb5400               push 0x54bb44
0042e9bb 6800010000               push 0x100
0042e9c0 8d85f0feffff             lea eax, [ebp - 0x110]
0042e9c6 50                       push eax
0042e9c7 c70102000000             mov dword ptr [ecx], 2
0042e9cd ebbb                     jmp 0x42e98a
0042e9cf 56                       push esi
0042e9d0 6854bb5400               push 0x54bb54
0042e9d5 6800010000               push 0x100
0042e9da 8d85f0feffff             lea eax, [ebp - 0x110]
0042e9e0 50                       push eax
0042e9e1 c70101000000             mov dword ptr [ecx], 1
0042e9e7 eba1                     jmp 0x42e98a
0042e9e9 ba8d000000               mov edx, 0x8d
0042e9ee b868bb5400               mov eax, 0x54bb68
0042e9f3 31db                     xor ebx, ebx
0042e9f5 e886bbfdff               call 0x40a580
0042e9fa 56                       push esi
0042e9fb 6884bb5400               push 0x54bb84
0042ea00 e83bbcfdff               call 0x40a640
0042ea05 83c408                   add esp, 8
0042ea08 eb88                     jmp 0x42e992
0042ea0a ba9e000000               mov edx, 0x9e
0042ea0f b868bb5400               mov eax, 0x54bb68
0042ea14 31db                     xor ebx, ebx
0042ea16 e865bbfdff               call 0x40a580
0042ea1b 8d85f0feffff             lea eax, [ebp - 0x110]
0042ea21 50                       push eax
0042ea22 68b8bb5400               push 0x54bbb8
0042ea27 e814bcfdff               call 0x40a640
0042ea2c 83c408                   add esp, 8
0042ea2f 8b45f4                   mov eax, dword ptr [ebp - 0xc]
0042ea32 8d65f8                   lea esp, [ebp - 8]
0042ea35 5f                       pop edi
0042ea36 5e                       pop esi
0042ea37 5d                       pop ebp
0042ea38 c20400                   ret 4
0042ea3b 8d4000                   lea eax, [eax]
0042ea3e 8bc9                     mov ecx, ecx
