; Analyst label: register_tag_tables; export span 0x0042e2c0..0x0042e380
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042e2c0 53                       push ebx
0042e2c1 51                       push ecx
0042e2c2 52                       push edx
0042e2c3 57                       push edi
0042e2c4 b8b4ba5400               mov eax, 0x54bab4
0042e2c9 e81230fdff               call 0x4012e0
0042e2ce 31d2                     xor edx, edx
0042e2d0 a3f01a5900               mov dword ptr [0x591af0], eax
0042e2d5 31c0                     xor eax, eax
0042e2d7 83c010                   add eax, 0x10
0042e2da 31c9                     xor ecx, ecx
0042e2dc 899010d77300             mov dword ptr [eax + 0x73d710], edx
0042e2e2 898814d77300             mov dword ptr [eax + 0x73d714], ecx
0042e2e8 898818d77300             mov dword ptr [eax + 0x73d718], ecx
0042e2ee 42                       inc edx
0042e2ef 89881cd77300             mov dword ptr [eax + 0x73d71c], ecx
0042e2f5 83fa06                   cmp edx, 6
0042e2f8 7cdd                     jl 0x42e2d7
0042e2fa bf01000000               mov edi, 1
0042e2ff b9f41a5900               mov ecx, 0x591af4
0042e304 bbeeffffff               mov ebx, 0xffffffee
0042e309 baffffffff               mov edx, 0xffffffff
0042e30e 89f8                     mov eax, edi
0042e310 893dec1a5900             mov dword ptr [0x591aec], edi
0042e316 e825000000               call 0x42e340
0042e31b 5f                       pop edi
0042e31c 5a                       pop edx
0042e31d 59                       pop ecx
0042e31e 5b                       pop ebx
0042e31f c3                       ret 
0042e320 52                       push edx
0042e321 31d2                     xor edx, edx
0042e323 89d0                     mov eax, edx
0042e325 42                       inc edx
0042e326 e855000000               call 0x42e380
0042e32b 83fa06                   cmp edx, 6
0042e32e 7cf3                     jl 0x42e323
0042e330 31d2                     xor edx, edx
0042e332 8915ec1a5900             mov dword ptr [0x591aec], edx
0042e338 5a                       pop edx
0042e339 c3                       ret 
0042e33a 8d8000000000             lea eax, [eax]
0042e340 55                       push ebp
0042e341 89e5                     mov ebp, esp
0042e343 56                       push esi
0042e344 57                       push edi
0042e345 83ec04                   sub esp, 4
0042e348 8945f4                   mov dword ptr [ebp - 0xc], eax
0042e34b 89d6                     mov esi, edx
0042e34d 89df                     mov edi, ebx
0042e34f 89c8                     mov eax, ecx
0042e351 e83a000000               call 0x42e390
0042e356 8b45f4                   mov eax, dword ptr [ebp - 0xc]
0042e359 c1e004                   shl eax, 4
0042e35c 8b55f4                   mov edx, dword ptr [ebp - 0xc]
0042e35f 899020d77300             mov dword ptr [eax + 0x73d720], edx
0042e365 89b024d77300             mov dword ptr [eax + 0x73d724], esi
0042e36b 89b828d77300             mov dword ptr [eax + 0x73d728], edi
0042e371 89882cd77300             mov dword ptr [eax + 0x73d72c], ecx
0042e377 8d65f8                   lea esp, [ebp - 8]
0042e37a 5f                       pop edi
0042e37b 5e                       pop esi
0042e37c 5d                       pop ebp
0042e37d c3                       ret 
0042e37e 8bc0                     mov eax, eax
