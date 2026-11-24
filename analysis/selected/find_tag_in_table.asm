; Analyst label: find_tag_in_table; export span 0x0042e880..0x0042e910
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042e880 8b00                     mov eax, dword ptr [eax]
0042e882 8b12                     mov edx, dword ptr [edx]
0042e884 e9f7601000               jmp 0x534980
0042e889 8d8000000000             lea eax, [eax]
0042e88f 90                       nop 
0042e890 55                       push ebp
0042e891 89e5                     mov ebp, esp
0042e893 53                       push ebx
0042e894 51                       push ecx
0042e895 56                       push esi
0042e896 57                       push edi
0042e897 83ec04                   sub esp, 4
0042e89a 89c6                     mov esi, eax
0042e89c 8955ec                   mov dword ptr [ebp - 0x14], edx
0042e89f c1e004                   shl eax, 4
0042e8a2 8b9824d77300             mov ebx, dword ptr [eax + 0x73d724]
0042e8a8 8b8828d77300             mov ecx, dword ptr [eax + 0x73d728]
0042e8ae 85db                     test ebx, ebx
0042e8b0 7c47                     jl 0x42e8f9
0042e8b2 31ff                     xor edi, edi
0042e8b4 89d8                     mov eax, ebx
0042e8b6 99                       cdq 
0042e8b7 31d0                     xor eax, edx
0042e8b9 29d0                     sub eax, edx
0042e8bb 8d5801                   lea ebx, [eax + 1]
0042e8be 89c8                     mov eax, ecx
0042e8c0 99                       cdq 
0042e8c1 31d0                     xor eax, edx
0042e8c3 29d0                     sub eax, edx
0042e8c5 6880e84200               push 0x42e880
0042e8ca 8d48ff                   lea ecx, [eax - 1]
0042e8cd 89f2                     mov edx, esi
0042e8cf 6a04                     push 4
0042e8d1 c1e204                   shl edx, 4
0042e8d4 8d45ec                   lea eax, [ebp - 0x14]
0042e8d7 8b922cd77300             mov edx, dword ptr [edx + 0x73d72c]
0042e8dd e85e0b0000               call 0x42f440
0042e8e2 89c2                     mov edx, eax
0042e8e4 85c0                     test eax, eax
0042e8e6 7c18                     jl 0x42e900
0042e8e8 85ff                     test edi, edi
0042e8ea 7402                     je 0x42e8ee
0042e8ec f7da                     neg edx
0042e8ee 89d0                     mov eax, edx
0042e8f0 8d65f0                   lea esp, [ebp - 0x10]
0042e8f3 5f                       pop edi
0042e8f4 5e                       pop esi
0042e8f5 59                       pop ecx
0042e8f6 5b                       pop ebx
0042e8f7 5d                       pop ebp
0042e8f8 c3                       ret 
0042e8f9 bf01000000               mov edi, 1
0042e8fe ebb4                     jmp 0x42e8b4
0042e900 b8eeffffff               mov eax, 0xffffffee
0042e905 8d65f0                   lea esp, [ebp - 0x10]
0042e908 5f                       pop edi
0042e909 5e                       pop esi
0042e90a 59                       pop ecx
0042e90b 5b                       pop ebx
0042e90c 5d                       pop ebp
0042e90d c3                       ret 
0042e90e 0000                     add byte ptr [eax], al
