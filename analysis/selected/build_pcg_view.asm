; Analyst label: build_pcg_view; export span 0x00423b20..0x00423c10
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00423b20 55                       push ebp
00423b21 89e5                     mov ebp, esp
00423b23 53                       push ebx
00423b24 51                       push ecx
00423b25 52                       push edx
00423b26 56                       push esi
00423b27 83ec10                   sub esp, 0x10
00423b2a 89c1                     mov ecx, eax
00423b2c 8b4020                   mov eax, dword ptr [eax + 0x20]
00423b2f 8b10                     mov edx, dword ptr [eax]
00423b31 895104                   mov dword ptr [ecx + 4], edx
00423b34 8a5008                   mov dl, byte ptr [eax + 8]
00423b37 8855e4                   mov byte ptr [ebp - 0x1c], dl
00423b3a 8a5009                   mov dl, byte ptr [eax + 9]
00423b3d 31db                     xor ebx, ebx
00423b3f 8855e8                   mov byte ptr [ebp - 0x18], dl
00423b42 8a500a                   mov dl, byte ptr [eax + 0xa]
00423b45 8b7004                   mov esi, dword ptr [eax + 4]
00423b48 8855ec                   mov byte ptr [ebp - 0x14], dl
00423b4b 8a400b                   mov al, byte ptr [eax + 0xb]
00423b4e baba090000               mov edx, 0x9ba
00423b53 8845e0                   mov byte ptr [ebp - 0x20], al
00423b56 b8e8855400               mov eax, 0x5485e8
00423b5b e8206afeff               call 0x40a580
00423b60 31c0                     xor eax, eax
00423b62 56                       push esi
00423b63 8a45e4                   mov al, byte ptr [ebp - 0x1c]
00423b66 50                       push eax
00423b67 31c0                     xor eax, eax
00423b69 8a45e8                   mov al, byte ptr [ebp - 0x18]
00423b6c 50                       push eax
00423b6d 31c0                     xor eax, eax
00423b6f 8a45e0                   mov al, byte ptr [ebp - 0x20]
00423b72 50                       push eax
00423b73 31c0                     xor eax, eax
00423b75 8a45ec                   mov al, byte ptr [ebp - 0x14]
00423b78 50                       push eax
00423b79 8b11                     mov edx, dword ptr [ecx]
00423b7b 52                       push edx
00423b7c 68a0895400               push 0x5489a0
00423b81 e85a69feff               call 0x40a4e0
00423b86 8b4120                   mov eax, dword ptr [ecx + 0x20]
00423b89 83c010                   add eax, 0x10
00423b8c 894124                   mov dword ptr [ecx + 0x24], eax
00423b8f 8b5120                   mov edx, dword ptr [ecx + 0x20]
00423b92 8b4104                   mov eax, dword ptr [ecx + 4]
00423b95 83c210                   add edx, 0x10
00423b98 c1e004                   shl eax, 4
00423b9b 01d0                     add eax, edx
00423b9d 83c07f                   add eax, 0x7f
00423ba0 2480                     and al, 0x80
00423ba2 83c41c                   add esp, 0x1c
00423ba5 894128                   mov dword ptr [ecx + 0x28], eax
00423ba8 8d65f0                   lea esp, [ebp - 0x10]
00423bab 5e                       pop esi
00423bac 5a                       pop edx
00423bad 59                       pop ecx
00423bae 5b                       pop ebx
00423baf 5d                       pop ebp
00423bb0 c3                       ret 
00423bb1 8d8000000000             lea eax, [eax]
00423bb7 8d9200000000             lea edx, [edx]
00423bbd 8d4000                   lea eax, [eax]
00423bc0 53                       push ebx
00423bc1 51                       push ecx
00423bc2 52                       push edx
00423bc3 56                       push esi
00423bc4 89c6                     mov esi, eax
00423bc6 8b500c                   mov edx, dword ptr [eax + 0xc]
00423bc9 83fa01                   cmp edx, 1
00423bcc 7541                     jne 0x423c0f
00423bce 8b4008                   mov eax, dword ptr [eax + 8]
00423bd1 39d0                     cmp eax, edx
00423bd3 7268                     jb 0x423c3d
00423bd5 763d                     jbe 0x423c14
00423bd7 83f802                   cmp eax, 2
00423bda 7561                     jne 0x423c3d
00423bdc 8b06                     mov eax, dword ptr [esi]
00423bde bb80000000               mov ebx, 0x80
00423be3 e8e87cfeff               call 0x40b8d0
00423be8 8b4e14                   mov ecx, dword ptr [esi + 0x14]
00423beb 89c2                     mov edx, eax
00423bed 89c8                     mov eax, ecx
00423bef e8ec7afeff               call 0x40b6e0
00423bf4 89c1                     mov ecx, eax
00423bf6 8b16                     mov edx, dword ptr [esi]
00423bf8 894618                   mov dword ptr [esi + 0x18], eax
00423bfb 31db                     xor ebx, ebx
00423bfd 8b4614                   mov eax, dword ptr [esi + 0x14]
00423c00 e85b4dfeff               call 0x408960
00423c05 c7460c02000000           mov dword ptr [esi + 0xc], 2
00423c0c 89461c                   mov dword ptr [esi + 0x1c], eax
00423c0f 5e                       pop esi
