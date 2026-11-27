; Analyst label: copy_brake_record; export span 0x005209d0..0x00520a1d
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
005209d0 53                       push ebx
005209d1 51                       push ecx
005209d2 56                       push esi
005209d3 57                       push edi
005209d4 89c3                     mov ebx, eax
005209d6 d94214                   fld dword ptr [edx + 0x14]
005209d9 b90c000000               mov ecx, 0xc
005209de 8d7218                   lea esi, [edx + 0x18]
005209e1 8d7818                   lea edi, [eax + 0x18]
005209e4 d95814                   fstp dword ptr [eax + 0x14]
005209e7 57                       push edi
005209e8 89c8                     mov eax, ecx
005209ea c1e902                   shr ecx, 2
005209ed f2a5                     movsd dword ptr es:[edi], dword ptr [esi]
005209ef 8ac8                     mov cl, al
005209f1 80e103                   and cl, 3
005209f4 f2a4                     repne movsb byte ptr es:[edi], byte ptr [esi]
005209f6 5f                       pop edi
005209f7 b90c000000               mov ecx, 0xc
005209fc 8d7224                   lea esi, [edx + 0x24]
005209ff 8d7b24                   lea edi, [ebx + 0x24]
00520a02 57                       push edi
00520a03 89c8                     mov eax, ecx
00520a05 c1e902                   shr ecx, 2
00520a08 f2a5                     movsd dword ptr es:[edi], dword ptr [esi]
00520a0a 8ac8                     mov cl, al
00520a0c 80e103                   and cl, 3
00520a0f f2a4                     repne movsb byte ptr es:[edi], byte ptr [esi]
00520a11 5f                       pop edi
00520a12 8b4230                   mov eax, dword ptr [edx + 0x30]
00520a15 894330                   mov dword ptr [ebx + 0x30], eax
00520a18 5f                       pop edi
00520a19 5e                       pop esi
00520a1a 59                       pop ecx
00520a1b 5b                       pop ebx
00520a1c c3                       ret 
