; Analyst label: copy_gearbox_record; export span 0x00523470..0x00523540
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00523470 53                       push ebx
00523471 51                       push ecx
00523472 8b4a1c                   mov ecx, dword ptr [edx + 0x1c]
00523475 89481c                   mov dword ptr [eax + 0x1c], ecx
00523478 8b4a14                   mov ecx, dword ptr [edx + 0x14]
0052347b 894814                   mov dword ptr [eax + 0x14], ecx
0052347e 8b4a18                   mov ecx, dword ptr [edx + 0x18]
00523481 894818                   mov dword ptr [eax + 0x18], ecx
00523484 8b4a20                   mov ecx, dword ptr [edx + 0x20]
00523487 894820                   mov dword ptr [eax + 0x20], ecx
0052348a 8b4a24                   mov ecx, dword ptr [edx + 0x24]
0052348d 894824                   mov dword ptr [eax + 0x24], ecx
00523490 8b4a28                   mov ecx, dword ptr [edx + 0x28]
00523493 894828                   mov dword ptr [eax + 0x28], ecx
00523496 8b4a2c                   mov ecx, dword ptr [edx + 0x2c]
00523499 89482c                   mov dword ptr [eax + 0x2c], ecx
0052349c 8a5a30                   mov bl, byte ptr [edx + 0x30]
0052349f 885830                   mov byte ptr [eax + 0x30], bl
005234a2 8a5231                   mov dl, byte ptr [edx + 0x31]
005234a5 885031                   mov byte ptr [eax + 0x31], dl
005234a8 59                       pop ecx
005234a9 5b                       pop ebx
005234aa c3                       ret 
005234ab 8d4000                   lea eax, [eax]
005234ae 8bc9                     mov ecx, ecx
005234b0 53                       push ebx
005234b1 51                       push ecx
005234b2 52                       push edx
005234b3 56                       push esi
005234b4 89c6                     mov esi, eax
005234b6 a174745900               mov eax, dword ptr [0x597474]
005234bb 8b4810                   mov ecx, dword ptr [eax + 0x10]
005234be 85c9                     test ecx, ecx
005234c0 7417                     je 0x5234d9
005234c2 8d5920                   lea ebx, [ecx + 0x20]
005234c5 89f2                     mov edx, esi
005234c7 89d8                     mov eax, ebx
005234c9 e8b2140100               call 0x534980
005234ce 85c0                     test eax, eax
005234d0 740e                     je 0x5234e0
005234d2 8b4910                   mov ecx, dword ptr [ecx + 0x10]
005234d5 85c9                     test ecx, ecx
005234d7 75e9                     jne 0x5234c2
005234d9 31c0                     xor eax, eax
005234db 5e                       pop esi
005234dc 5a                       pop edx
005234dd 59                       pop ecx
005234de 5b                       pop ebx
005234df c3                       ret 
005234e0 89d8                     mov eax, ebx
005234e2 5e                       pop esi
005234e3 5a                       pop edx
005234e4 59                       pop ecx
005234e5 5b                       pop ebx
005234e6 c3                       ret 
005234e7 0000                     add byte ptr [eax], al
005234e9 0000                     add byte ptr [eax], al
005234eb 0000                     add byte ptr [eax], al
005234ed 0000                     add byte ptr [eax], al
005234ef 005589                   add byte ptr [ebp - 0x77], dl
005234f2 e553                     in eax, 0x53
005234f4 51                       push ecx
005234f5 52                       push edx
005234f6 56                       push esi
005234f7 57                       push edi
005234f8 83ec04                   sub esp, 4
005234fb 6a00                     push 0
005234fd 6a00                     push 0
005234ff bb00375200               mov ebx, 0x523700
00523504 ba28000000               mov edx, 0x28
00523509 6a00                     push 0
0052350b b8581f5800               mov eax, 0x581f58
00523510 31c9                     xor ecx, ecx
00523512 e839b8f0ff               call 0x42ed50
00523517 686b010000               push 0x16b
0052351c b9944d5900               mov ecx, 0x594d94
00523521 a378745900               mov dword ptr [0x597478], eax
00523526 31d2                     xor edx, edx
00523528 31db                     xor ebx, ebx
0052352a b810000000               mov eax, 0x10
0052352f 8955e8                   mov dword ptr [ebp - 0x18], edx
00523532 ba6c1f5800               mov edx, 0x581f6c
00523537 31ff                     xor edi, edi
00523539 e8725afdff               call 0x4f8fb0
