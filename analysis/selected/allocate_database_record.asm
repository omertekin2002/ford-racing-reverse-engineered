; Analyst label: allocate_database_record; export span 0x0042eed0..0x0042ef62
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042eed0 55                       push ebp
0042eed1 89e5                     mov ebp, esp
0042eed3 56                       push esi
0042eed4 57                       push edi
0042eed5 83ec0c                   sub esp, 0xc
0042eed8 89c6                     mov esi, eax
0042eeda 8955ec                   mov dword ptr [ebp - 0x14], edx
0042eedd 8b38                     mov edi, dword ptr [eax]
0042eedf 8b4808                   mov ecx, dword ptr [eax + 8]
0042eee2 31d2                     xor edx, edx
0042eee4 83c720                   add edi, 0x20
0042eee7 8955f4                   mov dword ptr [ebp - 0xc], edx
0042eeea 85c9                     test ecx, ecx
0042eeec 7e48                     jle 0x42ef36
0042eeee 31c0                     xor eax, eax
0042eef0 85c9                     test ecx, ecx
0042eef2 7e1d                     jle 0x42ef11
0042eef4 8b560c                   mov edx, dword ptr [esi + 0xc]
0042eef7 8955f0                   mov dword ptr [ebp - 0x10], edx
0042eefa 89fa                     mov edx, edi
0042eefc 6bcf00                   imul ecx, edi, 0
0042eeff 034df0                   add ecx, dword ptr [ebp - 0x10]
0042ef02 803900                   cmp byte ptr [ecx], 0
0042ef05 741c                     je 0x42ef23
0042ef07 40                       inc eax
0042ef08 8b5e08                   mov ebx, dword ptr [esi + 8]
0042ef0b 01d1                     add ecx, edx
0042ef0d 39d8                     cmp eax, ebx
0042ef0f 7cf1                     jl 0x42ef02
0042ef11 8b55f4                   mov edx, dword ptr [ebp - 0xc]
0042ef14 8b45ec                   mov eax, dword ptr [ebp - 0x14]
0042ef17 894204                   mov dword ptr [edx + 4], eax
0042ef1a 89d0                     mov eax, edx
0042ef1c 8d65f8                   lea esp, [ebp - 8]
0042ef1f 5f                       pop edi
0042ef20 5e                       pop esi
0042ef21 5d                       pop ebp
0042ef22 c3                       ret 
0042ef23 89fb                     mov ebx, edi
0042ef25 89c8                     mov eax, ecx
0042ef27 31d2                     xor edx, edx
0042ef29 e862571000               call 0x534690
0042ef2e 894df4                   mov dword ptr [ebp - 0xc], ecx
0042ef31 c60101                   mov byte ptr [ecx], 1
0042ef34 ebdb                     jmp 0x42ef11
0042ef36 a180d77300               mov eax, dword ptr [0x73d780]
0042ef3b 89fa                     mov edx, edi
0042ef3d 31db                     xor ebx, ebx
0042ef3f e89cc7fdff               call 0x40b6e0
0042ef44 89fb                     mov ebx, edi
0042ef46 31d2                     xor edx, edx
0042ef48 8945f4                   mov dword ptr [ebp - 0xc], eax
0042ef4b e840571000               call 0x534690
0042ef50 8b55f4                   mov edx, dword ptr [ebp - 0xc]
0042ef53 8b45ec                   mov eax, dword ptr [ebp - 0x14]
0042ef56 894204                   mov dword ptr [edx + 4], eax
0042ef59 89d0                     mov eax, edx
0042ef5b 8d65f8                   lea esp, [ebp - 8]
0042ef5e 5f                       pop edi
0042ef5f 5e                       pop esi
0042ef60 5d                       pop ebp
0042ef61 c3                       ret 
