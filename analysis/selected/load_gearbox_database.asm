; Analyst label: load_gearbox_database; export span 0x00523220..0x00523470
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00523220 55                       push ebp
00523221 89e5                     mov ebp, esp
00523223 53                       push ebx
00523224 51                       push ecx
00523225 52                       push edx
00523226 56                       push esi
00523227 57                       push edi
00523228 83ec1c                   sub esp, 0x1c
0052322b 6a00                     push 0
0052322d 6a00                     push 0
0052322f bb60345200               mov ebx, 0x523460
00523234 ba34000000               mov edx, 0x34
00523239 6a00                     push 0
0052323b b8e41e5800               mov eax, 0x581ee4
00523240 31c9                     xor ecx, ecx
00523242 e809bbf0ff               call 0x42ed50
00523247 686b010000               push 0x16b
0052324c b9944d5900               mov ecx, 0x594d94
00523251 a374745900               mov dword ptr [0x597474], eax
00523256 31d2                     xor edx, edx
00523258 31db                     xor ebx, ebx
0052325a b80f000000               mov eax, 0xf
0052325f 8955e4                   mov dword ptr [ebp - 0x1c], edx
00523262 baf81e5800               mov edx, 0x581ef8
00523267 31ff                     xor edi, edi
00523269 e8425dfdff               call 0x4f8fb0
0052326e 8b4804                   mov ecx, dword ptr [eax + 4]
00523271 89c6                     mov esi, eax
00523273 85c9                     test ecx, ecx
00523275 0f84c4010000             je 0x52343f
0052327b ba02000000               mov edx, 2
00523280 89f0                     mov eax, esi
00523282 e8a9b2f0ff               call 0x42e530
00523287 89c1                     mov ecx, eax
00523289 83f85f                   cmp eax, 0x5f
0052328c 7d33                     jge 0x5232c1
0052328e 83f80e                   cmp eax, 0xe
00523291 0f8df9000000             jge 0x523390
00523297 83f8f2                   cmp eax, -0xe
0052329a 0f8d43010000             jge 0x5233e3
005232a0 bae5000000               mov edx, 0xe5
005232a5 b8081f5800               mov eax, 0x581f08
005232aa 31db                     xor ebx, ebx
005232ac e8cf72eeff               call 0x40a580
005232b1 51                       push ecx
005232b2 68301f5800               push 0x581f30
005232b7 e88473eeff               call 0x40a640
005232bc 83c408                   add esp, 8
005232bf ebba                     jmp 0x52327b
005232c1 7f0c                     jg 0x5232cf
005232c3 89f0                     mov eax, esi
005232c5 e8b6b3f0ff               call 0x42e680
005232ca d95f14                   fstp dword ptr [edi + 0x14]
005232cd ebac                     jmp 0x52327b
005232cf 83f877                   cmp eax, 0x77
005232d2 7d21                     jge 0x5232f5
005232d4 83f86d                   cmp eax, 0x6d
005232d7 7cc7                     jl 0x5232a0
005232d9 0f8f99000000             jg 0x523378
005232df bb04000000               mov ebx, 4
005232e4 ba60745900               mov edx, 0x597460
005232e9 89f0                     mov eax, esi
005232eb e830b5f0ff               call 0x42e820
005232f0 894728                   mov dword ptr [edi + 0x28], eax
005232f3 eb86                     jmp 0x52327b
005232f5 7f19                     jg 0x523310
005232f7 bb04000000               mov ebx, 4
005232fc ba4c745900               mov edx, 0x59744c
00523301 89f0                     mov eax, esi
00523303 e818b5f0ff               call 0x42e820
00523308 89472c                   mov dword ptr [edi + 0x2c], eax
0052330b e96bffffff               jmp 0x52327b
00523310 3d1a010000               cmp eax, 0x11a
00523315 7d2c                     jge 0x523343
00523317 3d9c000000               cmp eax, 0x9c
0052331c 7582                     jne 0x5232a0
0052331e bb14000000               mov ebx, 0x14
00523323 8d55d0                   lea edx, [ebp - 0x30]
00523326 89f0                     mov eax, esi
00523328 e893b4f0ff               call 0x42e7c0
0052332d 8d45d0                   lea eax, [ebp - 0x30]
00523330 e87b010000               call 0x5234b0
00523335 89c2                     mov edx, eax
00523337 89f8                     mov eax, edi
00523339 e832010000               call 0x523470
0052333e e938ffffff               jmp 0x52327b
00523343 7f0f                     jg 0x523354
00523345 89f0                     mov eax, esi
00523347 e834b3f0ff               call 0x42e680
0052334c d95f1c                   fstp dword ptr [edi + 0x1c]
0052334f e927ffffff               jmp 0x52327b
00523354 3d59010000               cmp eax, 0x159
00523359 0f8541ffffff             jne 0x5232a0
0052335f bb04000000               mov ebx, 4
00523364 ba3c745900               mov edx, 0x59743c
00523369 89f0                     mov eax, esi
0052336b e8b0b4f0ff               call 0x42e820
00523370 894724                   mov dword ptr [edi + 0x24], eax
00523373 e903ffffff               jmp 0x52327b
00523378 83f876                   cmp eax, 0x76
0052337b 0f851fffffff             jne 0x5232a0
00523381 89f0                     mov eax, esi
00523383 e8f8b2f0ff               call 0x42e680
00523388 d95f20                   fstp dword ptr [edi + 0x20]
0052338b e9ebfeffff               jmp 0x52327b
00523390 7f1a                     jg 0x5233ac
00523392 89f0                     mov eax, esi
00523394 e8e7b2f0ff               call 0x42e680
00523399 e85c1f0100               call 0x5352fa
0052339e db5de8                   fistp dword ptr [ebp - 0x18]
005233a1 8a45e8                   mov al, byte ptr [ebp - 0x18]
005233a4 884731                   mov byte ptr [edi + 0x31], al
005233a7 e9cffeffff               jmp 0x52327b
005233ac 83f80f                   cmp eax, 0xf
005233af 7f1a                     jg 0x5233cb
005233b1 89f0                     mov eax, esi
005233b3 e8c8b2f0ff               call 0x42e680
005233b8 e83d1f0100               call 0x5352fa
005233bd db5de8                   fistp dword ptr [ebp - 0x18]
005233c0 8a45e8                   mov al, byte ptr [ebp - 0x18]
005233c3 884730                   mov byte ptr [edi + 0x30], al
005233c6 e9b0feffff               jmp 0x52327b
005233cb 83f85e                   cmp eax, 0x5e
005233ce 0f85ccfeffff             jne 0x5232a0
005233d4 89f0                     mov eax, esi
005233d6 e8a5b2f0ff               call 0x42e680
005233db d95f18                   fstp dword ptr [edi + 0x18]
005233de e998feffff               jmp 0x52327b
005233e3 7f39                     jg 0x52341e
005233e5 8b55e4                   mov edx, dword ptr [ebp - 0x1c]
005233e8 a174745900               mov eax, dword ptr [0x597474]
005233ed 31c9                     xor ecx, ecx
005233ef 31db                     xor ebx, ebx
005233f1 e8dabaf0ff               call 0x42eed0
005233f6 8b1574745900             mov edx, dword ptr [0x597474]
005233fc 31db                     xor ebx, ebx
005233fe 89c7                     mov edi, eax
00523400 e8cbbbf0ff               call 0x42efd0
00523405 bb14000000               mov ebx, 0x14
0052340a 83c720                   add edi, 0x20
0052340d 89f0                     mov eax, esi
0052340f 89fa                     mov edx, edi
00523411 e8aab3f0ff               call 0x42e7c0
00523416 ff45e4                   inc dword ptr [ebp - 0x1c]
00523419 e95dfeffff               jmp 0x52327b
0052341e 83f8f5                   cmp eax, -0xb
00523421 0f8579feffff             jne 0x5232a0
00523427 b80f000000               mov eax, 0xf
0052342c 89f2                     mov edx, esi
0052342e e89d5bfdff               call 0x4f8fd0
00523433 a174745900               mov eax, dword ptr [0x597474]
00523438 31d2                     xor edx, edx
0052343a e881bcf0ff               call 0x42f0c0
0052343f 8d65ec                   lea esp, [ebp - 0x14]
00523442 5f                       pop edi
00523443 5e                       pop esi
00523444 5a                       pop edx
00523445 59                       pop ecx
00523446 5b                       pop ebx
00523447 5d                       pop ebp
00523448 c3                       ret 
00523449 8d8000000000             lea eax, [eax]
0052344f 90                       nop 
00523450 a174745900               mov eax, dword ptr [0x597474]
00523455 e9a6b9f0ff               jmp 0x42ee00
0052345a 8d8000000000             lea eax, [eax]
00523460 c3                       ret 
00523461 8d8000000000             lea eax, [eax]
00523467 8d9200000000             lea edx, [edx]
0052346d 8d4000                   lea eax, [eax]
