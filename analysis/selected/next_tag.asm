; Analyst label: next_tag; export span 0x0042e530..0x0042e5a0
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042e530 53                       push ebx
0042e531 51                       push ecx
0042e532 56                       push esi
0042e533 89c1                     mov ecx, eax
0042e535 8b00                     mov eax, dword ptr [eax]
0042e537 beffffffff               mov esi, 0xffffffff
0042e53c 83f801                   cmp eax, 1
0042e53f 7313                     jae 0x42e554
0042e541 85c0                     test eax, eax
0042e543 7516                     jne 0x42e55b
0042e545 89c8                     mov eax, ecx
0042e547 e854ebffff               call 0x42d0a0
0042e54c 89c6                     mov esi, eax
0042e54e 89f0                     mov eax, esi
0042e550 5e                       pop esi
0042e551 59                       pop ecx
0042e552 5b                       pop ebx
0042e553 c3                       ret 
0042e554 762c                     jbe 0x42e582
0042e556 83f802                   cmp eax, 2
0042e559 74ea                     je 0x42e545
0042e55b baab010000               mov edx, 0x1ab
0042e560 b8ecba5400               mov eax, 0x54baec
0042e565 31db                     xor ebx, ebx
0042e567 e814c0fdff               call 0x40a580
0042e56c 8b11                     mov edx, dword ptr [ecx]
0042e56e 52                       push edx
0042e56f 6808bb5400               push 0x54bb08
0042e574 e8c7c0fdff               call 0x40a640
0042e579 83c408                   add esp, 8
0042e57c 89f0                     mov eax, esi
0042e57e 5e                       pop esi
0042e57f 59                       pop ecx
0042e580 5b                       pop ebx
0042e581 c3                       ret 
0042e582 89c8                     mov eax, ecx
0042e584 e8c7f4ffff               call 0x42da50
0042e589 89c6                     mov esi, eax
0042e58b 89f0                     mov eax, esi
0042e58d 5e                       pop esi
0042e58e 59                       pop ecx
0042e58f 5b                       pop ebx
0042e590 c3                       ret 
0042e591 8d8000000000             lea eax, [eax]
0042e597 8d9200000000             lea edx, [edx]
0042e59d 8d4000                   lea eax, [eax]
