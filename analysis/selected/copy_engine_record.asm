; Analyst label: copy_engine_record; export span 0x00522c80..0x00522ec0
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00522c80 53                       push ebx
00522c81 51                       push ecx
00522c82 56                       push esi
00522c83 57                       push edi
00522c84 89c3                     mov ebx, eax
00522c86 b948000000               mov ecx, 0x48
00522c8b 8a4214                   mov al, byte ptr [edx + 0x14]
00522c8e 8d723c                   lea esi, [edx + 0x3c]
00522c91 884314                   mov byte ptr [ebx + 0x14], al
00522c94 8d7b3c                   lea edi, [ebx + 0x3c]
00522c97 8b421c                   mov eax, dword ptr [edx + 0x1c]
00522c9a 89431c                   mov dword ptr [ebx + 0x1c], eax
00522c9d 8b4220                   mov eax, dword ptr [edx + 0x20]
00522ca0 894320                   mov dword ptr [ebx + 0x20], eax
00522ca3 8b4224                   mov eax, dword ptr [edx + 0x24]
00522ca6 894324                   mov dword ptr [ebx + 0x24], eax
00522ca9 8b4228                   mov eax, dword ptr [edx + 0x28]
00522cac 894328                   mov dword ptr [ebx + 0x28], eax
00522caf 8b422c                   mov eax, dword ptr [edx + 0x2c]
00522cb2 89432c                   mov dword ptr [ebx + 0x2c], eax
00522cb5 8b4230                   mov eax, dword ptr [edx + 0x30]
00522cb8 894330                   mov dword ptr [ebx + 0x30], eax
00522cbb 8b4234                   mov eax, dword ptr [edx + 0x34]
00522cbe 894334                   mov dword ptr [ebx + 0x34], eax
00522cc1 8b4238                   mov eax, dword ptr [edx + 0x38]
00522cc4 894338                   mov dword ptr [ebx + 0x38], eax
00522cc7 57                       push edi
00522cc8 89c8                     mov eax, ecx
00522cca c1e902                   shr ecx, 2
00522ccd f2a5                     movsd dword ptr es:[edi], dword ptr [esi]
00522ccf 8ac8                     mov cl, al
00522cd1 80e103                   and cl, 3
00522cd4 f2a4                     repne movsb byte ptr es:[edi], byte ptr [esi]
00522cd6 5f                       pop edi
00522cd7 8b8284000000             mov eax, dword ptr [edx + 0x84]
00522cdd 898384000000             mov dword ptr [ebx + 0x84], eax
00522ce3 8b8288000000             mov eax, dword ptr [edx + 0x88]
00522ce9 898388000000             mov dword ptr [ebx + 0x88], eax
00522cef 8b828c000000             mov eax, dword ptr [edx + 0x8c]
00522cf5 89838c000000             mov dword ptr [ebx + 0x8c], eax
00522cfb 8b8290000000             mov eax, dword ptr [edx + 0x90]
00522d01 898390000000             mov dword ptr [ebx + 0x90], eax
00522d07 8a8294000000             mov al, byte ptr [edx + 0x94]
00522d0d 888394000000             mov byte ptr [ebx + 0x94], al
00522d13 8a8295000000             mov al, byte ptr [edx + 0x95]
00522d19 888395000000             mov byte ptr [ebx + 0x95], al
00522d1f 8b8298000000             mov eax, dword ptr [edx + 0x98]
00522d25 898398000000             mov dword ptr [ebx + 0x98], eax
00522d2b 8b829c000000             mov eax, dword ptr [edx + 0x9c]
00522d31 89839c000000             mov dword ptr [ebx + 0x9c], eax
00522d37 8b82a0000000             mov eax, dword ptr [edx + 0xa0]
00522d3d 8983a0000000             mov dword ptr [ebx + 0xa0], eax
00522d43 8b82a4000000             mov eax, dword ptr [edx + 0xa4]
00522d49 8983a4000000             mov dword ptr [ebx + 0xa4], eax
00522d4f 8b82a8000000             mov eax, dword ptr [edx + 0xa8]
00522d55 8983a8000000             mov dword ptr [ebx + 0xa8], eax
00522d5b 8b82ac000000             mov eax, dword ptr [edx + 0xac]
00522d61 8983ac000000             mov dword ptr [ebx + 0xac], eax
00522d67 5f                       pop edi
00522d68 5e                       pop esi
00522d69 59                       pop ecx
00522d6a 5b                       pop ebx
00522d6b c3                       ret 
00522d6c 8d442000                 lea eax, [eax]
00522d70 53                       push ebx
00522d71 51                       push ecx
00522d72 52                       push edx
00522d73 56                       push esi
00522d74 89c6                     mov esi, eax
00522d76 a118745900               mov eax, dword ptr [0x597418]
00522d7b 8b4810                   mov ecx, dword ptr [eax + 0x10]
00522d7e 85c9                     test ecx, ecx
00522d80 7417                     je 0x522d99
00522d82 8d5920                   lea ebx, [ecx + 0x20]
00522d85 89f2                     mov edx, esi
00522d87 89d8                     mov eax, ebx
00522d89 e8f21b0100               call 0x534980
00522d8e 85c0                     test eax, eax
00522d90 740e                     je 0x522da0
00522d92 8b4910                   mov ecx, dword ptr [ecx + 0x10]
00522d95 85c9                     test ecx, ecx
00522d97 75e9                     jne 0x522d82
00522d99 31c0                     xor eax, eax
00522d9b 5e                       pop esi
00522d9c 5a                       pop edx
00522d9d 59                       pop ecx
00522d9e 5b                       pop ebx
00522d9f c3                       ret 
00522da0 89d8                     mov eax, ebx
00522da2 5e                       pop esi
00522da3 5a                       pop edx
00522da4 59                       pop ecx
00522da5 5b                       pop ebx
00522da6 c3                       ret 
00522da7 0000                     add byte ptr [eax], al
00522da9 0000                     add byte ptr [eax], al
00522dab 0000                     add byte ptr [eax], al
00522dad 0000                     add byte ptr [eax], al
00522daf 005589                   add byte ptr [ebp - 0x77], dl
00522db2 e553                     in eax, 0x53
00522db4 51                       push ecx
00522db5 52                       push edx
00522db6 56                       push esi
00522db7 57                       push edi
00522db8 81ecc8000000             sub esp, 0xc8
00522dbe 6a00                     push 0
00522dc0 bbb0315200               mov ebx, 0x5231b0
00522dc5 6a00                     push 0
00522dc7 ba70000000               mov edx, 0x70
00522dcc b82c1d5800               mov eax, 0x581d2c
00522dd1 6a00                     push 0
00522dd3 31c9                     xor ecx, ecx
00522dd5 31ff                     xor edi, edi
00522dd7 e874bff0ff               call 0x42ed50
00522ddc 686b010000               push 0x16b
00522de1 b9944d5900               mov ecx, 0x594d94
00522de6 ba401d5800               mov edx, 0x581d40
00522deb a31c745900               mov dword ptr [0x59741c], eax
00522df0 31db                     xor ebx, ebx
00522df2 b80e000000               mov eax, 0xe
00522df7 897de8                   mov dword ptr [ebp - 0x18], edi
00522dfa e8b161fdff               call 0x4f8fb0
00522dff 8b4804                   mov ecx, dword ptr [eax + 4]
00522e02 89c6                     mov esi, eax
00522e04 85c9                     test ecx, ecx
00522e06 0f8485030000             je 0x523191
00522e0c ba02000000               mov edx, 2
00522e11 89f0                     mov eax, esi
00522e13 e818b7f0ff               call 0x42e530
00522e18 89c1                     mov ecx, eax
00522e1a 3d99000000               cmp eax, 0x99
00522e1f 7d33                     jge 0x522e54
00522e21 83f869                   cmp eax, 0x69
00522e24 0f8d48010000             jge 0x522f72
00522e2a 83f8f2                   cmp eax, -0xe
00522e2d 0f8de0020000             jge 0x523113
00522e33 ba16010000               mov edx, 0x116
00522e38 b8501d5800               mov eax, 0x581d50
00522e3d 31db                     xor ebx, ebx
00522e3f e83c77eeff               call 0x40a580
00522e44 51                       push ecx
00522e45 688c1d5800               push 0x581d8c
00522e4a e8f177eeff               call 0x40a640
00522e4f 83c408                   add esp, 8
00522e52 ebb8                     jmp 0x522e0c
00522e54 7f11                     jg 0x522e67
00522e56 bb20000000               mov ebx, 0x20
00522e5b 8d5720                   lea edx, [edi + 0x20]
00522e5e 89f0                     mov eax, esi
00522e60 e85bb9f0ff               call 0x42e7c0
00522e65 eba5                     jmp 0x522e0c
00522e67 3db2000000               cmp eax, 0xb2
00522e6c 7d72                     jge 0x522ee0
00522e6e 3dac000000               cmp eax, 0xac
00522e73 0f8dce000000             jge 0x522f47
00522e79 3d9b000000               cmp eax, 0x9b
00522e7e 75b3                     jne 0x522e33
00522e80 bb40000000               mov ebx, 0x40
00522e85 8d55a4                   lea edx, [ebp - 0x5c]
00522e88 89f0                     mov eax, esi
00522e8a e831b9f0ff               call 0x42e7c0
00522e8f 8d55a4                   lea edx, [ebp - 0x5c]
00522e92 8d8524ffffff             lea eax, [ebp - 0xdc]
00522e98 bb71060000               mov ebx, 0x671
00522e9d e84e9ceeff               call 0x40caf0
00522ea2 bac8555900               mov edx, 0x5955c8
00522ea7 8d8524ffffff             lea eax, [ebp - 0xdc]
00522ead e8febdf0ff               call 0x42ecb0
00522eb2 89475c                   mov dword ptr [edi + 0x5c], eax
00522eb5 85c0                     test eax, eax
00522eb7 0f854fffffff             jne 0x522e0c
