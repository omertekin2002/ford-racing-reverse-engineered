; Analyst label: tyre_table_accessors; export span 0x00523e50..0x00523f30
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00523e50 51                       push ecx
00523e51 52                       push edx
00523e52 8b504c                   mov edx, dword ptr [eax + 0x4c]
00523e55 85d2                     test edx, edx
00523e57 750c                     jne 0x523e65
00523e59 8b484c                   mov ecx, dword ptr [eax + 0x4c]
00523e5c 85c9                     test ecx, ecx
00523e5e 750a                     jne 0x523e6a
00523e60 8b4014                   mov eax, dword ptr [eax + 0x14]
00523e63 ebf4                     jmp 0x523e59
00523e65 89d0                     mov eax, edx
00523e67 5a                       pop edx
00523e68 59                       pop ecx
00523e69 c3                       ret 
00523e6a 89c8                     mov eax, ecx
00523e6c 5a                       pop edx
00523e6d 59                       pop ecx
00523e6e c3                       ret 
00523e6f 90                       nop 
00523e70 51                       push ecx
00523e71 52                       push edx
00523e72 8b5050                   mov edx, dword ptr [eax + 0x50]
00523e75 85d2                     test edx, edx
00523e77 750c                     jne 0x523e85
00523e79 8b4850                   mov ecx, dword ptr [eax + 0x50]
00523e7c 85c9                     test ecx, ecx
00523e7e 750a                     jne 0x523e8a
00523e80 8b4014                   mov eax, dword ptr [eax + 0x14]
00523e83 ebf4                     jmp 0x523e79
00523e85 89d0                     mov eax, edx
00523e87 5a                       pop edx
00523e88 59                       pop ecx
00523e89 c3                       ret 
00523e8a 89c8                     mov eax, ecx
00523e8c 5a                       pop edx
00523e8d 59                       pop ecx
00523e8e c3                       ret 
00523e8f 90                       nop 
00523e90 51                       push ecx
00523e91 52                       push edx
00523e92 8b5044                   mov edx, dword ptr [eax + 0x44]
00523e95 85d2                     test edx, edx
00523e97 750c                     jne 0x523ea5
00523e99 8b4844                   mov ecx, dword ptr [eax + 0x44]
00523e9c 85c9                     test ecx, ecx
00523e9e 750a                     jne 0x523eaa
00523ea0 8b4014                   mov eax, dword ptr [eax + 0x14]
00523ea3 ebf4                     jmp 0x523e99
00523ea5 89d0                     mov eax, edx
00523ea7 5a                       pop edx
00523ea8 59                       pop ecx
00523ea9 c3                       ret 
00523eaa 89c8                     mov eax, ecx
00523eac 5a                       pop edx
00523ead 59                       pop ecx
00523eae c3                       ret 
00523eaf 90                       nop 
00523eb0 51                       push ecx
00523eb1 52                       push edx
00523eb2 8b5048                   mov edx, dword ptr [eax + 0x48]
00523eb5 85d2                     test edx, edx
00523eb7 750c                     jne 0x523ec5
00523eb9 8b4848                   mov ecx, dword ptr [eax + 0x48]
00523ebc 85c9                     test ecx, ecx
00523ebe 750a                     jne 0x523eca
00523ec0 8b4014                   mov eax, dword ptr [eax + 0x14]
00523ec3 ebf4                     jmp 0x523eb9
00523ec5 89d0                     mov eax, edx
00523ec7 5a                       pop edx
00523ec8 59                       pop ecx
00523ec9 c3                       ret 
00523eca 89c8                     mov eax, ecx
00523ecc 5a                       pop edx
00523ecd 59                       pop ecx
00523ece c3                       ret 
00523ecf 90                       nop 
00523ed0 53                       push ebx
00523ed1 51                       push ecx
00523ed2 89d1                     mov ecx, edx
00523ed4 83785400                 cmp dword ptr [eax + 0x54], 0
00523ed8 7511                     jne 0x523eeb
00523eda 83785400                 cmp dword ptr [eax + 0x54], 0
00523ede 7505                     jne 0x523ee5
00523ee0 8b4014                   mov eax, dword ptr [eax + 0x14]
00523ee3 ebf5                     jmp 0x523eda
00523ee5 83785400                 cmp dword ptr [eax + 0x54], 0
00523ee9 74ef                     je 0x523eda
00523eeb 8d148d00000000           lea edx, [ecx*4]
00523ef2 8b5854                   mov ebx, dword ptr [eax + 0x54]
00523ef5 01ca                     add edx, ecx
00523ef7 8d4378                   lea eax, [ebx + 0x78]
00523efa c1e203                   shl edx, 3
00523efd 01d0                     add eax, edx
00523eff 59                       pop ecx
00523f00 5b                       pop ebx
00523f01 c3                       ret 
00523f02 8d8000000000             lea eax, [eax]
00523f08 8d9200000000             lea edx, [edx]
00523f0e 8bc0                     mov eax, eax
00523f10 83785400                 cmp dword ptr [eax + 0x54], 0
00523f14 7511                     jne 0x523f27
00523f16 83785400                 cmp dword ptr [eax + 0x54], 0
00523f1a 7505                     jne 0x523f21
00523f1c 8b4014                   mov eax, dword ptr [eax + 0x14]
00523f1f ebf5                     jmp 0x523f16
00523f21 83785400                 cmp dword ptr [eax + 0x54], 0
00523f25 74ef                     je 0x523f16
00523f27 8b4054                   mov eax, dword ptr [eax + 0x54]
00523f2a c3                       ret 
00523f2b 8d4000                   lea eax, [eax]
00523f2e 8bc9                     mov ecx, ecx
