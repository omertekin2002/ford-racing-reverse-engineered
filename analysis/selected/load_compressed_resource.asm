; Analyst label: load_compressed_resource; export span 0x0040ba30..0x0040bb60
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0040ba30 55                       push ebp
0040ba31 89e5                     mov ebp, esp
0040ba33 56                       push esi
0040ba34 57                       push edi
0040ba35 83ec4c                   sub esp, 0x4c
0040ba38 8945e0                   mov dword ptr [ebp - 0x20], eax
0040ba3b 8955dc                   mov dword ptr [ebp - 0x24], edx
0040ba3e 895dd8                   mov dword ptr [ebp - 0x28], ebx
0040ba41 894de4                   mov dword ptr [ebp - 0x1c], ecx
0040ba44 e837450200               call 0x42ff80
0040ba49 85c0                     test eax, eax
0040ba4b 7422                     je 0x40ba6f
0040ba4d ba34010000               mov edx, 0x134
0040ba52 b8286d5400               mov eax, 0x546d28
0040ba57 31db                     xor ebx, ebx
0040ba59 e822ebffff               call 0x40a580
0040ba5e 8b55dc                   mov edx, dword ptr [ebp - 0x24]
0040ba61 52                       push edx
0040ba62 68a46d5400               push 0x546da4
0040ba67 e8d4ebffff               call 0x40a640
0040ba6c 83c408                   add esp, 8
0040ba6f 8b45dc                   mov eax, dword ptr [ebp - 0x24]
0040ba72 e839feffff               call 0x40b8b0
0040ba77 85c0                     test eax, eax
0040ba79 0f84eb000000             je 0x40bb6a
0040ba7f bb2c000000               mov ebx, 0x2c
0040ba84 baf06d5400               mov edx, 0x546df0
0040ba89 8d45ac                   lea eax, [ebp - 0x54]
0040ba8c e85fa3ffff               call 0x405df0
0040ba91 31ff                     xor edi, edi
0040ba93 31f6                     xor esi, esi
0040ba95 8b45dc                   mov eax, dword ptr [ebp - 0x24]
0040ba98 ba846d5400               mov edx, 0x546d84
0040ba9d e82efeffff               call 0x40b8d0
0040baa2 89c1                     mov ecx, eax
0040baa4 8945e8                   mov dword ptr [ebp - 0x18], eax
0040baa7 8b45dc                   mov eax, dword ptr [ebp - 0x24]
0040baaa 897df0                   mov dword ptr [ebp - 0x10], edi
0040baad e81e040000               call 0x40bed0
0040bab2 8945ec                   mov dword ptr [ebp - 0x14], eax
0040bab5 85c9                     test ecx, ecx
0040bab7 7e64                     jle 0x40bb1d
0040bab9 8b4dec                   mov ecx, dword ptr [ebp - 0x14]
0040babc bb00400000               mov ebx, 0x4000
0040bac1 ba01000000               mov edx, 1
0040bac6 b8b0f25a00               mov eax, 0x5af2b0
0040bacb e830060000               call 0x40c100
0040bad0 89c1                     mov ecx, eax
0040bad2 8945f4                   mov dword ptr [ebp - 0xc], eax
0040bad5 85ff                     test edi, edi
0040bad7 0f857b000000             jne 0x40bb58
0040badd 8b5de4                   mov ebx, dword ptr [ebp - 0x1c]
0040bae0 8b35b0f25a00             mov esi, dword ptr [0x5af2b0]
0040bae6 8b45e0                   mov eax, dword ptr [ebp - 0x20]
0040bae9 89f2                     mov edx, esi
0040baeb 83e904                   sub ecx, 4
0040baee e8edfbffff               call 0x40b6e0
0040baf3 bab4f25a00               mov edx, 0x5af2b4
0040baf8 8945f0                   mov dword ptr [ebp - 0x10], eax
0040bafb 894db4                   mov dword ptr [ebp - 0x4c], ecx
0040bafe 8945b0                   mov dword ptr [ebp - 0x50], eax
0040bb01 8d45ac                   lea eax, [ebp - 0x54]
0040bb04 8955ac                   mov dword ptr [ebp - 0x54], edx
0040bb07 31d2                     xor edx, edx
0040bb09 8975bc                   mov dword ptr [ebp - 0x44], esi
0040bb0c e82fa3ffff               call 0x405e40
0040bb11 8b45f4                   mov eax, dword ptr [ebp - 0xc]
0040bb14 8b55e8                   mov edx, dword ptr [ebp - 0x18]
0040bb17 01c7                     add edi, eax
0040bb19 39d7                     cmp edi, edx
0040bb1b 7c9c                     jl 0x40bab9
0040bb1d ba04000000               mov edx, 4
0040bb22 8d45ac                   lea eax, [ebp - 0x54]
0040bb25 e816a3ffff               call 0x405e40
0040bb2a 8d45ac                   lea eax, [ebp - 0x54]
0040bb2d 8b4dd8                   mov ecx, dword ptr [ebp - 0x28]
0040bb30 e86ba1ffff               call 0x405ca0
0040bb35 85c9                     test ecx, ecx
0040bb37 740b                     je 0x40bb44
0040bb39 8b45f0                   mov eax, dword ptr [ebp - 0x10]
0040bb3c 897108                   mov dword ptr [ecx + 8], esi
0040bb3f 894104                   mov dword ptr [ecx + 4], eax
0040bb42 8901                     mov dword ptr [ecx], eax
0040bb44 8b45ec                   mov eax, dword ptr [ebp - 0x14]
0040bb47 e8b4040000               call 0x40c000
0040bb4c 8b45f0                   mov eax, dword ptr [ebp - 0x10]
0040bb4f 8d65f8                   lea esp, [ebp - 8]
0040bb52 5f                       pop edi
0040bb53 5e                       pop esi
0040bb54 5d                       pop ebp
0040bb55 c20400                   ret 4
0040bb58 bbb0f25a00               mov ebx, 0x5af2b0
0040bb5d 8945b4                   mov dword ptr [ebp - 0x4c], eax
