; Analyst label: load_brake_database; export span 0x00520820..0x005209ae
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00520820 55                       push ebp
00520821 89e5                     mov ebp, esp
00520823 53                       push ebx
00520824 51                       push ecx
00520825 52                       push edx
00520826 56                       push esi
00520827 57                       push edi
00520828 83ec18                   sub esp, 0x18
0052082b 6a00                     push 0
0052082d 6a00                     push 0
0052082f bbc0095200               mov ebx, 0x5209c0
00520834 ba34000000               mov edx, 0x34
00520839 6a00                     push 0
0052083b b8b4175800               mov eax, 0x5817b4
00520840 31c9                     xor ecx, ecx
00520842 e809e5f0ff               call 0x42ed50
00520847 686b010000               push 0x16b
0052084c b9944d5900               mov ecx, 0x594d94
00520851 a3c4735900               mov dword ptr [0x5973c4], eax
00520856 31d2                     xor edx, edx
00520858 31db                     xor ebx, ebx
0052085a b807000000               mov eax, 7
0052085f 8955e8                   mov dword ptr [ebp - 0x18], edx
00520862 bac4175800               mov edx, 0x5817c4
00520867 31ff                     xor edi, edi
00520869 e84287fdff               call 0x4f8fb0
0052086e 8b4804                   mov ecx, dword ptr [eax + 4]
00520871 89c6                     mov esi, eax
00520873 85c9                     test ecx, ecx
00520875 0f8405010000             je 0x520980
0052087b ba02000000               mov edx, 2
00520880 89f0                     mov eax, esi
00520882 e8a9dcf0ff               call 0x42e530
00520887 89c1                     mov ecx, eax
00520889 83f817                   cmp eax, 0x17
0052088c 7d48                     jge 0x5208d6
0052088e 83f8f5                   cmp eax, -0xb
00520891 0f8dbb000000             jge 0x520952
00520897 83f8f2                   cmp eax, -0xe
0052089a 0f85ea000000             jne 0x52098a
005208a0 8b55e8                   mov edx, dword ptr [ebp - 0x18]
005208a3 a1c4735900               mov eax, dword ptr [0x5973c4]
005208a8 31c9                     xor ecx, ecx
005208aa 31db                     xor ebx, ebx
005208ac e81fe6f0ff               call 0x42eed0
005208b1 8b15c4735900             mov edx, dword ptr [0x5973c4]
005208b7 31db                     xor ebx, ebx
005208b9 89c7                     mov edi, eax
005208bb e810e7f0ff               call 0x42efd0
005208c0 bb14000000               mov ebx, 0x14
005208c5 83c720                   add edi, 0x20
005208c8 89f0                     mov eax, esi
005208ca 89fa                     mov edx, edi
005208cc e8efdef0ff               call 0x42e7c0
005208d1 ff45e8                   inc dword ptr [ebp - 0x18]
005208d4 eba5                     jmp 0x52087b
005208d6 7f16                     jg 0x5208ee
005208d8 89f0                     mov eax, esi
005208da e8a1ddf0ff               call 0x42e680
005208df 89f0                     mov eax, esi
005208e1 d95f28                   fstp dword ptr [edi + 0x28]
005208e4 e897ddf0ff               call 0x42e680
005208e9 d95f2c                   fstp dword ptr [edi + 0x2c]
005208ec eb8d                     jmp 0x52087b
005208ee 83f81a                   cmp eax, 0x1a
005208f1 7d22                     jge 0x520915
005208f3 83f819                   cmp eax, 0x19
005208f6 0f858e000000             jne 0x52098a
005208fc 89f0                     mov eax, esi
005208fe e87dddf0ff               call 0x42e680
00520903 89f0                     mov eax, esi
00520905 d95f1c                   fstp dword ptr [edi + 0x1c]
00520908 e873ddf0ff               call 0x42e680
0052090d d95f20                   fstp dword ptr [edi + 0x20]
00520910 e966ffffff               jmp 0x52087b
00520915 7f0f                     jg 0x520926
00520917 89f0                     mov eax, esi
00520919 e862ddf0ff               call 0x42e680
0052091e d95f14                   fstp dword ptr [edi + 0x14]
00520921 e955ffffff               jmp 0x52087b
00520926 3d9c000000               cmp eax, 0x9c
0052092b 755d                     jne 0x52098a
0052092d bb14000000               mov ebx, 0x14
00520932 8d55d4                   lea edx, [ebp - 0x2c]
00520935 89f0                     mov eax, esi
00520937 e884def0ff               call 0x42e7c0
0052093c 8d45d4                   lea eax, [ebp - 0x2c]
0052093f e8dc000000               call 0x520a20
00520944 89c2                     mov edx, eax
00520946 89f8                     mov eax, edi
00520948 e883000000               call 0x5209d0
0052094d e929ffffff               jmp 0x52087b
00520952 7e14                     jle 0x520968
00520954 83f802                   cmp eax, 2
00520957 7531                     jne 0x52098a
00520959 89f0                     mov eax, esi
0052095b e820ddf0ff               call 0x42e680
00520960 d95f30                   fstp dword ptr [edi + 0x30]
00520963 e913ffffff               jmp 0x52087b
00520968 b807000000               mov eax, 7
0052096d 89f2                     mov edx, esi
0052096f e85c86fdff               call 0x4f8fd0
00520974 a1c4735900               mov eax, dword ptr [0x5973c4]
00520979 31d2                     xor edx, edx
0052097b e840e7f0ff               call 0x42f0c0
00520980 8d65ec                   lea esp, [ebp - 0x14]
00520983 5f                       pop edi
00520984 5e                       pop esi
00520985 5a                       pop edx
00520986 59                       pop ecx
00520987 5b                       pop ebx
00520988 5d                       pop ebp
00520989 c3                       ret 
0052098a bab5000000               mov edx, 0xb5
0052098f b8d4175800               mov eax, 0x5817d4
00520994 31db                     xor ebx, ebx
00520996 e8e59beeff               call 0x40a580
0052099b 51                       push ecx
0052099c 68fc175800               push 0x5817fc
005209a1 e89a9ceeff               call 0x40a640
005209a6 83c408                   add esp, 8
005209a9 e9cdfeffff               jmp 0x52087b
