; Analyst label: copy_tyre_scalar_fields; export span 0x00524090..0x005240e0
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00524090 51                       push ecx
00524091 8b4a24                   mov ecx, dword ptr [edx + 0x24]
00524094 894824                   mov dword ptr [eax + 0x24], ecx
00524097 8b4a2c                   mov ecx, dword ptr [edx + 0x2c]
0052409a 89482c                   mov dword ptr [eax + 0x2c], ecx
0052409d 8b4a28                   mov ecx, dword ptr [edx + 0x28]
005240a0 894828                   mov dword ptr [eax + 0x28], ecx
005240a3 8b4a30                   mov ecx, dword ptr [edx + 0x30]
005240a6 894830                   mov dword ptr [eax + 0x30], ecx
005240a9 8b4a34                   mov ecx, dword ptr [edx + 0x34]
005240ac 894834                   mov dword ptr [eax + 0x34], ecx
005240af 8b4a18                   mov ecx, dword ptr [edx + 0x18]
005240b2 894818                   mov dword ptr [eax + 0x18], ecx
005240b5 8b4a20                   mov ecx, dword ptr [edx + 0x20]
005240b8 894820                   mov dword ptr [eax + 0x20], ecx
005240bb 8b4a1c                   mov ecx, dword ptr [edx + 0x1c]
005240be 89481c                   mov dword ptr [eax + 0x1c], ecx
005240c1 8b4a40                   mov ecx, dword ptr [edx + 0x40]
005240c4 894840                   mov dword ptr [eax + 0x40], ecx
005240c7 8b4a3c                   mov ecx, dword ptr [edx + 0x3c]
005240ca 89483c                   mov dword ptr [eax + 0x3c], ecx
005240cd 8b4a38                   mov ecx, dword ptr [edx + 0x38]
005240d0 894838                   mov dword ptr [eax + 0x38], ecx
005240d3 59                       pop ecx
005240d4 c3                       ret 
005240d5 8d8000000000             lea eax, [eax]
005240db 8d5200                   lea edx, [edx]
005240de 8bdb                     mov ebx, ebx
