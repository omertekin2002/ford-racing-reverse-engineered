; Analyst label: find_tyre_record; export span 0x005240e0..0x00524117
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
005240e0 53                       push ebx
005240e1 51                       push ecx
005240e2 52                       push edx
005240e3 56                       push esi
005240e4 89c6                     mov esi, eax
005240e6 a17c745900               mov eax, dword ptr [0x59747c]
005240eb 8b4810                   mov ecx, dword ptr [eax + 0x10]
005240ee 85c9                     test ecx, ecx
005240f0 7417                     je 0x524109
005240f2 8d5920                   lea ebx, [ecx + 0x20]
005240f5 89f2                     mov edx, esi
005240f7 89d8                     mov eax, ebx
005240f9 e882080100               call 0x534980
005240fe 85c0                     test eax, eax
00524100 740e                     je 0x524110
00524102 8b4910                   mov ecx, dword ptr [ecx + 0x10]
00524105 85c9                     test ecx, ecx
00524107 75e9                     jne 0x5240f2
00524109 31c0                     xor eax, eax
0052410b 5e                       pop esi
0052410c 5a                       pop edx
0052410d 59                       pop ecx
0052410e 5b                       pop ebx
0052410f c3                       ret 
00524110 89d8                     mov eax, ebx
00524112 5e                       pop esi
00524113 5a                       pop edx
00524114 59                       pop ecx
00524115 5b                       pop ebx
00524116 c3                       ret 
