; Analyst label: binary_search; export span 0x0042f440..0x0042f495
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042f440 55                       push ebp
0042f441 89e5                     mov ebp, esp
0042f443 56                       push esi
0042f444 57                       push edi
0042f445 83ec04                   sub esp, 4
0042f448 89c7                     mov edi, eax
0042f44a 89d8                     mov eax, ebx
0042f44c 89de                     mov esi, ebx
0042f44e 8955f4                   mov dword ptr [ebp - 0xc], edx
0042f451 89cb                     mov ebx, ecx
0042f453 39c8                     cmp eax, ecx
0042f455 7f29                     jg 0x42f480
0042f457 8d141e                   lea edx, [esi + ebx]
0042f45a 89d0                     mov eax, edx
0042f45c c1fa1f                   sar edx, 0x1f
0042f45f 2bc2                     sub eax, edx
0042f461 d1f8                     sar eax, 1
0042f463 8b5508                   mov edx, dword ptr [ebp + 8]
0042f466 0fafd0                   imul edx, eax
0042f469 89c1                     mov ecx, eax
0042f46b 0355f4                   add edx, dword ptr [ebp - 0xc]
0042f46e 89f8                     mov eax, edi
0042f470 ff550c                   call dword ptr [ebp + 0xc]
0042f473 85c0                     test eax, eax
0042f475 7c19                     jl 0x42f490
0042f477 7e0c                     jle 0x42f485
0042f479 8d7101                   lea esi, [ecx + 1]
0042f47c 39de                     cmp esi, ebx
0042f47e 7ed7                     jle 0x42f457
0042f480 b9ffffffff               mov ecx, 0xffffffff
0042f485 89c8                     mov eax, ecx
0042f487 8d65f8                   lea esp, [ebp - 8]
0042f48a 5f                       pop edi
0042f48b 5e                       pop esi
0042f48c 5d                       pop ebp
0042f48d c20800                   ret 8
0042f490 8d59ff                   lea ebx, [ecx - 1]
0042f493 ebe7                     jmp 0x42f47c
