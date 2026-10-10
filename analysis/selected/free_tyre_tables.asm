; Analyst label: free_tyre_tables; export span 0x00523dc0..0x00523e50
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00523dc0 53                       push ebx
00523dc1 51                       push ecx
00523dc2 52                       push edx
00523dc3 56                       push esi
00523dc4 57                       push edi
00523dc5 8b5044                   mov edx, dword ptr [eax + 0x44]
00523dc8 89c1                     mov ecx, eax
00523dca 85d2                     test edx, edx
00523dcc 7555                     jne 0x523e23
00523dce 8b5948                   mov ebx, dword ptr [ecx + 0x48]
00523dd1 85db                     test ebx, ebx
00523dd3 7411                     je 0x523de6
00523dd5 b816000000               mov eax, 0x16
00523dda 89da                     mov edx, ebx
00523ddc e89f51fdff               call 0x4f8f80
00523de1 e8ba79eeff               call 0x40b7a0
00523de6 8b714c                   mov esi, dword ptr [ecx + 0x4c]
00523de9 85f6                     test esi, esi
00523deb 7411                     je 0x523dfe
00523ded b816000000               mov eax, 0x16
00523df2 89f2                     mov edx, esi
00523df4 e88751fdff               call 0x4f8f80
00523df9 e8a279eeff               call 0x40b7a0
00523dfe 8b7950                   mov edi, dword ptr [ecx + 0x50]
00523e01 85ff                     test edi, edi
00523e03 7411                     je 0x523e16
00523e05 b816000000               mov eax, 0x16
00523e0a 89fa                     mov edx, edi
00523e0c e86f51fdff               call 0x4f8f80
00523e11 e88a79eeff               call 0x40b7a0
00523e16 8b4154                   mov eax, dword ptr [ecx + 0x54]
00523e19 85c0                     test eax, eax
00523e1b 7517                     jne 0x523e34
00523e1d 5f                       pop edi
00523e1e 5e                       pop esi
00523e1f 5a                       pop edx
00523e20 59                       pop ecx
00523e21 5b                       pop ebx
00523e22 c3                       ret 
00523e23 b816000000               mov eax, 0x16
00523e28 e85351fdff               call 0x4f8f80
00523e2d e86e79eeff               call 0x40b7a0
00523e32 eb9a                     jmp 0x523dce
00523e34 89c2                     mov edx, eax
00523e36 b816000000               mov eax, 0x16
00523e3b e84051fdff               call 0x4f8f80
00523e40 e85b79eeff               call 0x40b7a0
00523e45 5f                       pop edi
00523e46 5e                       pop esi
00523e47 5a                       pop edx
00523e48 59                       pop ecx
00523e49 5b                       pop ebx
00523e4a c3                       ret 
00523e4b 8d4000                   lea eax, [eax]
00523e4e 8bc9                     mov ecx, ecx
