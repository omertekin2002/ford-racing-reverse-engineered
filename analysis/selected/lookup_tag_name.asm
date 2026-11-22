; Analyst label: lookup_tag_name; export span 0x0042d310..0x0042d350
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042d310 53                       push ebx
0042d311 51                       push ecx
0042d312 89c1                     mov ecx, eax
0042d314 89d3                     mov ebx, edx
0042d316 89c2                     mov edx, eax
0042d318 89d8                     mov eax, ebx
0042d31a e871150000               call 0x42e890
0042d31f 83f8ee                   cmp eax, -0x12
0042d322 750a                     jne 0x42d32e
0042d324 83fb01                   cmp ebx, 1
0042d327 7508                     jne 0x42d331
0042d329 b8eeffffff               mov eax, 0xffffffee
0042d32e 59                       pop ecx
0042d32f 5b                       pop ebx
0042d330 c3                       ret 
0042d331 b801000000               mov eax, 1
0042d336 89ca                     mov edx, ecx
0042d338 e853150000               call 0x42e890
0042d33d 83f8ee                   cmp eax, -0x12
0042d340 74e7                     je 0x42d329
0042d342 59                       pop ecx
0042d343 5b                       pop ebx
0042d344 c3                       ret 
0042d345 8d8000000000             lea eax, [eax]
0042d34b 8d5200                   lea edx, [edx]
0042d34e 8bdb                     mov ebx, ebx
