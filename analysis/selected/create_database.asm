; Analyst label: create_database; export span 0x0042ed50..0x0042edf5
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042ed50 55                       push ebp
0042ed51 89e5                     mov ebp, esp
0042ed53 56                       push esi
0042ed54 57                       push edi
0042ed55 83ec0c                   sub esp, 0xc
0042ed58 8955f4                   mov dword ptr [ebp - 0xc], edx
0042ed5b 895dec                   mov dword ptr [ebp - 0x14], ebx
0042ed5e 894df0                   mov dword ptr [ebp - 0x10], ecx
0042ed61 ba24000000               mov edx, 0x24
0042ed66 a180d77300               mov eax, dword ptr [0x73d780]
0042ed6b 31db                     xor ebx, ebx
0042ed6d e86ec9fdff               call 0x40b6e0
0042ed72 bb24000000               mov ebx, 0x24
0042ed77 89c6                     mov esi, eax
0042ed79 31d2                     xor edx, edx
0042ed7b 89c1                     mov ecx, eax
0042ed7d e80e591000               call 0x534690
0042ed82 8b4508                   mov eax, dword ptr [ebp + 8]
0042ed85 894608                   mov dword ptr [esi + 8], eax
0042ed88 85c0                     test eax, eax
0042ed8a 7f3f                     jg 0x42edcb
0042ed8c 8b45f4                   mov eax, dword ptr [ebp - 0xc]
0042ed8f c6411801                 mov byte ptr [ecx + 0x18], 1
0042ed93 8901                     mov dword ptr [ecx], eax
0042ed95 8b45ec                   mov eax, dword ptr [ebp - 0x14]
0042ed98 894114                   mov dword ptr [ecx + 0x14], eax
0042ed9b 8a45f0                   mov al, byte ptr [ebp - 0x10]
0042ed9e 8b35401b5900             mov esi, dword ptr [0x591b40]
0042eda4 884119                   mov byte ptr [ecx + 0x19], al
0042eda7 85f6                     test esi, esi
0042eda9 7545                     jne 0x42edf0
0042edab a1401b5900               mov eax, dword ptr [0x591b40]
0042edb0 c7411c00000000           mov dword ptr [ecx + 0x1c], 0
0042edb7 890d401b5900             mov dword ptr [0x591b40], ecx
0042edbd 894120                   mov dword ptr [ecx + 0x20], eax
0042edc0 89c8                     mov eax, ecx
0042edc2 8d65f8                   lea esp, [ebp - 8]
0042edc5 5f                       pop edi
0042edc6 5e                       pop esi
0042edc7 5d                       pop ebp
0042edc8 c20c00                   ret 0xc
0042edcb 8b7df4                   mov edi, dword ptr [ebp - 0xc]
0042edce 83c720                   add edi, 0x20
0042edd1 0faff8                   imul edi, eax
0042edd4 31db                     xor ebx, ebx
0042edd6 a180d77300               mov eax, dword ptr [0x73d780]
0042eddb 89fa                     mov edx, edi
0042eddd e8fec8fdff               call 0x40b6e0
0042ede2 89fb                     mov ebx, edi
0042ede4 31d2                     xor edx, edx
0042ede6 89460c                   mov dword ptr [esi + 0xc], eax
0042ede9 e8a2581000               call 0x534690
0042edee eb9c                     jmp 0x42ed8c
0042edf0 894e1c                   mov dword ptr [esi + 0x1c], ecx
0042edf3 ebb6                     jmp 0x42edab
