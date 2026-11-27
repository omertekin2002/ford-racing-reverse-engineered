; Analyst label: find_brake_record; export span 0x00520a20..0x00520a57
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00520a20 53                       push ebx
00520a21 51                       push ecx
00520a22 52                       push edx
00520a23 56                       push esi
00520a24 89c6                     mov esi, eax
00520a26 a1c4735900               mov eax, dword ptr [0x5973c4]
00520a2b 8b4810                   mov ecx, dword ptr [eax + 0x10]
00520a2e 85c9                     test ecx, ecx
00520a30 7417                     je 0x520a49
00520a32 8d5920                   lea ebx, [ecx + 0x20]
00520a35 89f2                     mov edx, esi
00520a37 89d8                     mov eax, ebx
00520a39 e8423f0100               call 0x534980
00520a3e 85c0                     test eax, eax
00520a40 740e                     je 0x520a50
00520a42 8b4910                   mov ecx, dword ptr [ecx + 0x10]
00520a45 85c9                     test ecx, ecx
00520a47 75e9                     jne 0x520a32
00520a49 31c0                     xor eax, eax
00520a4b 5e                       pop esi
00520a4c 5a                       pop edx
00520a4d 59                       pop ecx
00520a4e 5b                       pop ebx
00520a4f c3                       ret 
00520a50 89d8                     mov eax, ebx
00520a52 5e                       pop esi
00520a53 5a                       pop edx
00520a54 59                       pop ecx
00520a55 5b                       pop ebx
00520a56 c3                       ret 
