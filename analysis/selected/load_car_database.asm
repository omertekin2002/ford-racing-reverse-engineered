; Analyst label: load_car_database; export span 0x00520a60..0x005211f5
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00520a60 55                       push ebp
00520a61 89e5                     mov ebp, esp
00520a63 53                       push ebx
00520a64 51                       push ecx
00520a65 52                       push edx
00520a66 56                       push esi
00520a67 57                       push edi
00520a68 81ecd0000000             sub esp, 0xd0
00520a6e 6a00                     push 0
00520a70 bb10125200               mov ebx, 0x521210
00520a75 babc010000               mov edx, 0x1bc
00520a7a b874185800               mov eax, 0x581874
00520a7f 6a00                     push 0
00520a81 31c9                     xor ecx, ecx
00520a83 31f6                     xor esi, esi
00520a85 6a00                     push 0
00520a87 8975e8                   mov dword ptr [ebp - 0x18], esi
00520a8a 8975e4                   mov dword ptr [ebp - 0x1c], esi
00520a8d e8bee2f0ff               call 0x42ed50
00520a92 686b010000               push 0x16b
00520a97 b9944d5900               mov ecx, 0x594d94
00520a9c ba84185800               mov edx, 0x581884
00520aa1 a3c8735900               mov dword ptr [0x5973c8], eax
00520aa6 b809000000               mov eax, 9
00520aab 31db                     xor ebx, ebx
00520aad e8ce84fdff               call 0x4f8f80
00520ab2 e869def0ff               call 0x42e920
00520ab7 8b5804                   mov ebx, dword ptr [eax + 4]
00520aba 89c7                     mov edi, eax
00520abc 85db                     test ebx, ebx
00520abe 0f84ae060000             je 0x521172
00520ac4 ba02000000               mov edx, 2
00520ac9 89f8                     mov eax, edi
00520acb e860daf0ff               call 0x42e530
00520ad0 89c1                     mov ecx, eax
00520ad2 83f848                   cmp eax, 0x48
00520ad5 7d3c                     jge 0x520b13
00520ad7 83f83e                   cmp eax, 0x3e
00520ada 0f8d66030000             jge 0x520e46
00520ae0 83f839                   cmp eax, 0x39
00520ae3 0f8d34050000             jge 0x52101d
00520ae9 83f8f5                   cmp eax, -0xb
00520aec 0f8d46060000             jge 0x521138
00520af2 ba23020000               mov edx, 0x223
00520af7 b894185800               mov eax, 0x581894
00520afc 31db                     xor ebx, ebx
00520afe e87d9aeeff               call 0x40a580
00520b03 51                       push ecx
00520b04 68581a5800               push 0x581a58
00520b09 e8329beeff               call 0x40a640
00520b0e 83c408                   add esp, 8
00520b11 ebb1                     jmp 0x520ac4
00520b13 7f10                     jg 0x520b25
00520b15 89f8                     mov eax, edi
00520b17 e8f4daf0ff               call 0x42e610
00520b1c 66898690010000           mov word ptr [esi + 0x190], ax
00520b23 eb9f                     jmp 0x520ac4
00520b25 3d9a000000               cmp eax, 0x9a
00520b2a 7d47                     jge 0x520b73
00520b2c 83f84c                   cmp eax, 0x4c
00520b2f 0f8d28020000             jge 0x520d5d
00520b35 83f84a                   cmp eax, 0x4a
00520b38 7cb8                     jl 0x520af2
00520b3a 0f8f68060000             jg 0x5211a8
00520b40 bb07000000               mov ebx, 7
00520b45 bacc735900               mov edx, 0x5973cc
00520b4a 89f8                     mov eax, edi
00520b4c e8cfdcf0ff               call 0x42e820
00520b51 89c2                     mov edx, eax
00520b53 89f8                     mov eax, edi
00520b55 e826dbf0ff               call 0x42e680
00520b5a 8d049500000000           lea eax, [edx*4]
00520b61 d95de0                   fstp dword ptr [ebp - 0x20]
00520b64 8b55e0                   mov edx, dword ptr [ebp - 0x20]
00520b67 89940670010000           mov dword ptr [esi + eax + 0x170], edx
00520b6e e951ffffff               jmp 0x520ac4
00520b73 7f60                     jg 0x520bd5
00520b75 bb40000000               mov ebx, 0x40
00520b7a 8d559c                   lea edx, [ebp - 0x64]
00520b7d 89f8                     mov eax, edi
00520b7f e83cdcf0ff               call 0x42e7c0
00520b84 8d559c                   lea edx, [ebp - 0x64]
00520b87 8d851cffffff             lea eax, [ebp - 0xe4]
00520b8d bb71060000               mov ebx, 0x671
00520b92 e859bfeeff               call 0x40caf0
00520b97 bac8555900               mov edx, 0x5955c8
00520b9c 8d851cffffff             lea eax, [ebp - 0xe4]
00520ba2 e809e1f0ff               call 0x42ecb0
00520ba7 89464c                   mov dword ptr [esi + 0x4c], eax
00520baa 85c0                     test eax, eax
00520bac 0f8512ffffff             jne 0x520ac4
00520bb2 ba09010000               mov edx, 0x109
00520bb7 b894185800               mov eax, 0x581894
00520bbc 31db                     xor ebx, ebx
00520bbe e8bd99eeff               call 0x40a580
00520bc3 681c195800               push 0x58191c
00520bc8 e8739aeeff               call 0x40a640
00520bcd 83c404                   add esp, 4
00520bd0 e9effeffff               jmp 0x520ac4
00520bd5 3d13010000               cmp eax, 0x113
00520bda 7d6b                     jge 0x520c47
00520bdc 3d9b000000               cmp eax, 0x9b
00520be1 0f8f4f010000             jg 0x520d36
00520be7 bb40000000               mov ebx, 0x40
00520bec 8d559c                   lea edx, [ebp - 0x64]
00520bef 89f8                     mov eax, edi
00520bf1 e8cadbf0ff               call 0x42e7c0
00520bf6 8d559c                   lea edx, [ebp - 0x64]
00520bf9 8d851cffffff             lea eax, [ebp - 0xe4]
00520bff bb71060000               mov ebx, 0x671
00520c04 e8e7beeeff               call 0x40caf0
00520c09 bac8555900               mov edx, 0x5955c8
00520c0e 8d851cffffff             lea eax, [ebp - 0xe4]
00520c14 e897e0f0ff               call 0x42ecb0
00520c19 894644                   mov dword ptr [esi + 0x44], eax
00520c1c 85c0                     test eax, eax
00520c1e 0f85a0feffff             jne 0x520ac4
00520c24 baf8000000               mov edx, 0xf8
00520c29 b894185800               mov eax, 0x581894
00520c2e 31db                     xor ebx, ebx
00520c30 e84b99eeff               call 0x40a580
00520c35 681c195800               push 0x58191c
00520c3a e8019aeeff               call 0x40a640
00520c3f 83c404                   add esp, 4
00520c42 e97dfeffff               jmp 0x520ac4
00520c47 7f1c                     jg 0x520c65
00520c49 bb06000000               mov ebx, 6
00520c4e baac315900               mov edx, 0x5931ac
00520c53 89f8                     mov eax, edi
00520c55 e8c6dbf0ff               call 0x42e820
00520c5a 898658010000             mov dword ptr [esi + 0x158], eax
00520c60 e95ffeffff               jmp 0x520ac4
00520c65 3d17010000               cmp eax, 0x117
00520c6a 7d1f                     jge 0x520c8b
00520c6c 3d16010000               cmp eax, 0x116
00520c71 0f857bfeffff             jne 0x520af2
00520c77 bb10000000               mov ebx, 0x10
00520c7c 8d5623                   lea edx, [esi + 0x23]
00520c7f 89f8                     mov eax, edi
00520c81 e83adbf0ff               call 0x42e7c0
00520c86 e939feffff               jmp 0x520ac4
00520c8b 7f60                     jg 0x520ced
00520c8d bb40000000               mov ebx, 0x40
00520c92 8d559c                   lea edx, [ebp - 0x64]
00520c95 89f8                     mov eax, edi
00520c97 e824dbf0ff               call 0x42e7c0
00520c9c 8d559c                   lea edx, [ebp - 0x64]
00520c9f 8d851cffffff             lea eax, [ebp - 0xe4]
00520ca5 bb71060000               mov ebx, 0x671
00520caa e841beeeff               call 0x40caf0
00520caf bac8555900               mov edx, 0x5955c8
00520cb4 8d851cffffff             lea eax, [ebp - 0xe4]
00520cba e8f1dff0ff               call 0x42ecb0
00520cbf 894648                   mov dword ptr [esi + 0x48], eax
00520cc2 85c0                     test eax, eax
00520cc4 0f85fafdffff             jne 0x520ac4
00520cca bab1010000               mov edx, 0x1b1
00520ccf b894185800               mov eax, 0x581894
00520cd4 31db                     xor ebx, ebx
00520cd6 e8a598eeff               call 0x40a580
00520cdb 683c1a5800               push 0x581a3c
00520ce0 e85b99eeff               call 0x40a640
00520ce5 83c404                   add esp, 4
00520ce8 e9d7fdffff               jmp 0x520ac4
00520ced 3d5f010000               cmp eax, 0x15f
00520cf2 0f85fafdffff             jne 0x520af2
00520cf8 bb0d000000               mov ebx, 0xd
00520cfd bac4315900               mov edx, 0x5931c4
00520d02 89f8                     mov eax, edi
00520d04 e817dbf0ff               call 0x42e820
00520d09 31d2                     xor edx, edx
00520d0b 8a5602                   mov dl, byte ptr [esi + 2]
00520d0e 6bd214                   imul edx, edx, 0x14
00520d11 89443260                 mov dword ptr [edx + esi + 0x60], eax
00520d15 31c0                     xor eax, eax
00520d17 8a4602                   mov al, byte ptr [esi + 2]
00520d1a 6bc014                   imul eax, eax, 0x14
00520d1d 8d5650                   lea edx, [esi + 0x50]
00520d20 bb10000000               mov ebx, 0x10
00520d25 01c2                     add edx, eax
00520d27 89f8                     mov eax, edi
00520d29 e832daf0ff               call 0x42e760
00520d2e fe4602                   inc byte ptr [esi + 2]
00520d31 e98efdffff               jmp 0x520ac4
00520d36 3df7000000               cmp eax, 0xf7
00520d3b 0f85b1fdffff             jne 0x520af2
00520d41 bbe2000000               mov ebx, 0xe2
00520d46 ba0c365900               mov edx, 0x59360c
00520d4b 89f8                     mov eax, edi
00520d4d e8cedaf0ff               call 0x42e820
00520d52 898660010000             mov dword ptr [esi + 0x160], eax
00520d58 e967fdffff               jmp 0x520ac4
00520d5d 7f4d                     jg 0x520dac
00520d5f bb40000000               mov ebx, 0x40
00520d64 8d559c                   lea edx, [ebp - 0x64]
00520d67 89f8                     mov eax, edi
00520d69 e852daf0ff               call 0x42e7c0
00520d6e 8d459c                   lea eax, [ebp - 0x64]
00520d71 e8ea0f0000               call 0x521d60
00520d76 8986a0010000             mov dword ptr [esi + 0x1a0], eax
00520d7c 85c0                     test eax, eax
00520d7e 0f8540fdffff             jne 0x520ac4
00520d84 ba90010000               mov edx, 0x190
00520d89 b894185800               mov eax, 0x581894
00520d8e 31db                     xor ebx, ebx
00520d90 e8eb97eeff               call 0x40a580
00520d95 8d459c                   lea eax, [ebp - 0x64]
00520d98 50                       push eax
00520d99 ba1c1a5800               mov edx, 0x581a1c
00520d9e 52                       push edx
00520d9f e89c98eeff               call 0x40a640
00520da4 83c408                   add esp, 8
00520da7 e918fdffff               jmp 0x520ac4
00520dac 83f859                   cmp eax, 0x59
00520daf 7d5a                     jge 0x520e0b
00520db1 83f84d                   cmp eax, 0x4d
00520db4 0f8538fdffff             jne 0x520af2
00520dba 8b55e4                   mov edx, dword ptr [ebp - 0x1c]
00520dbd a1c8735900               mov eax, dword ptr [0x5973c8]
00520dc2 31c9                     xor ecx, ecx
00520dc4 31db                     xor ebx, ebx
00520dc6 e805e1f0ff               call 0x42eed0
00520dcb 8b5de8                   mov ebx, dword ptr [ebp - 0x18]
00520dce 8b15c8735900             mov edx, dword ptr [0x5973c8]
00520dd4 89c1                     mov ecx, eax
00520dd6 e8f5e1f0ff               call 0x42efd0
00520ddb 8a45e4                   mov al, byte ptr [ebp - 0x1c]
00520dde 894de8                   mov dword ptr [ebp - 0x18], ecx
00520de1 8d7120                   lea esi, [ecx + 0x20]
00520de4 bb20000000               mov ebx, 0x20
00520de9 8d5603                   lea edx, [esi + 3]
00520dec 8806                     mov byte ptr [esi], al
00520dee 89f8                     mov eax, edi
00520df0 e8cbd9f0ff               call 0x42e7c0
00520df5 8b5de4                   mov ebx, dword ptr [ebp - 0x1c]
00520df8 43                       inc ebx
00520df9 c7865c01000000000000     mov dword ptr [esi + 0x15c], 0
00520e03 895de4                   mov dword ptr [ebp - 0x1c], ebx
00520e06 e9b9fcffff               jmp 0x520ac4
00520e0b 7f14                     jg 0x520e21
00520e0d bb10000000               mov ebx, 0x10
00520e12 8d5633                   lea edx, [esi + 0x33]
00520e15 89f8                     mov eax, edi
00520e17 e8a4d9f0ff               call 0x42e7c0
00520e1c e9a3fcffff               jmp 0x520ac4
00520e21 83f85a                   cmp eax, 0x5a
00520e24 0f85c8fcffff             jne 0x520af2
00520e2a bb08000000               mov ebx, 8
00520e2f baac325900               mov edx, 0x5932ac
00520e34 89f8                     mov eax, edi
00520e36 e8e5d9f0ff               call 0x42e820
00520e3b 89865c010000             mov dword ptr [esi + 0x15c], eax
00520e41 e97efcffff               jmp 0x520ac4
00520e46 7f4d                     jg 0x520e95
00520e48 bb40000000               mov ebx, 0x40
00520e4d 8d559c                   lea edx, [ebp - 0x64]
00520e50 89f8                     mov eax, edi
00520e52 e869d9f0ff               call 0x42e7c0
00520e57 8d459c                   lea eax, [ebp - 0x64]
00520e5a e8c1fbffff               call 0x520a20
00520e5f 898698010000             mov dword ptr [esi + 0x198], eax
00520e65 85c0                     test eax, eax
00520e67 0f8557fcffff             jne 0x520ac4
00520e6d ba27010000               mov edx, 0x127
00520e72 b894185800               mov eax, 0x581894
00520e77 31db                     xor ebx, ebx
00520e79 e80297eeff               call 0x40a580
00520e7e 8d459c                   lea eax, [ebp - 0x64]
00520e81 50                       push eax
00520e82 ba54195800               mov edx, 0x581954
00520e87 52                       push edx
00520e88 e8b397eeff               call 0x40a640
00520e8d 83c408                   add esp, 8
00520e90 e92ffcffff               jmp 0x520ac4
00520e95 83f842                   cmp eax, 0x42
00520e98 7d1b                     jge 0x520eb5
00520e9a 83f83f                   cmp eax, 0x3f
00520e9d 0f8f27010000             jg 0x520fca
00520ea3 89f8                     mov eax, edi
00520ea5 e8d6d7f0ff               call 0x42e680
00520eaa d99e6c010000             fstp dword ptr [esi + 0x16c]
00520eb0 e90ffcffff               jmp 0x520ac4
00520eb5 7f4d                     jg 0x520f04
00520eb7 bb40000000               mov ebx, 0x40
00520ebc 8d559c                   lea edx, [ebp - 0x64]
00520ebf 89f8                     mov eax, edi
00520ec1 e8fad8f0ff               call 0x42e7c0
00520ec6 8d459c                   lea eax, [ebp - 0x64]
00520ec9 e8a21e0000               call 0x522d70
00520ece 8986a8010000             mov dword ptr [esi + 0x1a8], eax
00520ed4 85c0                     test eax, eax
00520ed6 0f85e8fbffff             jne 0x520ac4
00520edc ba54010000               mov edx, 0x154
00520ee1 b894185800               mov eax, 0x581894
00520ee6 31db                     xor ebx, ebx
00520ee8 e89396eeff               call 0x40a580
00520eed 8d459c                   lea eax, [ebp - 0x64]
00520ef0 50                       push eax
00520ef1 baa4195800               mov edx, 0x5819a4
00520ef6 52                       push edx
00520ef7 e84497eeff               call 0x40a640
00520efc 83c408                   add esp, 8
00520eff e9c0fbffff               jmp 0x520ac4
00520f04 83f844                   cmp eax, 0x44
00520f07 7d4d                     jge 0x520f56
00520f09 bb40000000               mov ebx, 0x40
00520f0e 8d559c                   lea edx, [ebp - 0x64]
00520f11 89f8                     mov eax, edi
00520f13 e8a8d8f0ff               call 0x42e7c0
00520f18 8d459c                   lea eax, [ebp - 0x64]
00520f1b e8c0310000               call 0x5240e0
00520f20 8986b4010000             mov dword ptr [esi + 0x1b4], eax
00520f26 85c0                     test eax, eax
00520f28 0f8596fbffff             jne 0x520ac4
00520f2e ba81010000               mov edx, 0x181
00520f33 b894185800               mov eax, 0x581894
00520f38 31db                     xor ebx, ebx
00520f3a e84196eeff               call 0x40a580
00520f3f 8d459c                   lea eax, [ebp - 0x64]
00520f42 50                       push eax
00520f43 bafc195800               mov edx, 0x5819fc
00520f48 52                       push edx
00520f49 e8f296eeff               call 0x40a640
00520f4e 83c408                   add esp, 8
00520f51 e96efbffff               jmp 0x520ac4
00520f56 7f4d                     jg 0x520fa5
00520f58 bb40000000               mov ebx, 0x40
00520f5d 8d559c                   lea edx, [ebp - 0x64]
00520f60 89f8                     mov eax, edi
00520f62 e859d8f0ff               call 0x42e7c0
00520f67 8d459c                   lea eax, [ebp - 0x64]
00520f6a e841250000               call 0x5234b0
00520f6f 8986ac010000             mov dword ptr [esi + 0x1ac], eax
00520f75 85c0                     test eax, eax
00520f77 0f8547fbffff             jne 0x520ac4
00520f7d ba63010000               mov edx, 0x163
00520f82 b894185800               mov eax, 0x581894
00520f87 31db                     xor ebx, ebx
00520f89 e8f295eeff               call 0x40a580
00520f8e 8d459c                   lea eax, [ebp - 0x64]
00520f91 50                       push eax
00520f92 bac0195800               mov edx, 0x5819c0
00520f97 52                       push edx
00520f98 e8a396eeff               call 0x40a640
00520f9d 83c408                   add esp, 8
00520fa0 e91ffbffff               jmp 0x520ac4
00520fa5 83f846                   cmp eax, 0x46
00520fa8 0f8544fbffff             jne 0x520af2
00520fae bb06000000               mov ebx, 6
00520fb3 baac315900               mov edx, 0x5931ac
00520fb8 89f8                     mov eax, edi
00520fba e861d8f0ff               call 0x42e820
00520fbf 898654010000             mov dword ptr [esi + 0x154], eax
00520fc5 e9fafaffff               jmp 0x520ac4
00520fca 83f840                   cmp eax, 0x40
00520fcd 0f851ffbffff             jne 0x520af2
00520fd3 8d559c                   lea edx, [ebp - 0x64]
00520fd6 89c3                     mov ebx, eax
00520fd8 89f8                     mov eax, edi
00520fda e8e1d7f0ff               call 0x42e7c0
00520fdf 8d459c                   lea eax, [ebp - 0x64]
00520fe2 e8c9170000               call 0x5227b0
00520fe7 8986a4010000             mov dword ptr [esi + 0x1a4], eax
00520fed 85c0                     test eax, eax
00520fef 0f85cffaffff             jne 0x520ac4
00520ff5 ba45010000               mov edx, 0x145
00520ffa b894185800               mov eax, 0x581894
00520fff 31db                     xor ebx, ebx
00521001 e87a95eeff               call 0x40a580
00521006 8d459c                   lea eax, [ebp - 0x64]
00521009 50                       push eax
0052100a ba88195800               mov edx, 0x581988
0052100f 52                       push edx
00521010 e82b96eeff               call 0x40a640
00521015 83c408                   add esp, 8
00521018 e9a7faffff               jmp 0x520ac4
0052101d 7f0f                     jg 0x52102e
0052101f 89f8                     mov eax, edi
00521021 e8ead5f0ff               call 0x42e610
00521026 884601                   mov byte ptr [esi + 1], al
00521029 e996faffff               jmp 0x520ac4
0052102e 83f83b                   cmp eax, 0x3b
00521031 7d60                     jge 0x521093
00521033 89f8                     mov eax, edi
00521035 e846d6f0ff               call 0x42e680
0052103a 8b96b8010000             mov edx, dword ptr [esi + 0x1b8]
00521040 d99e64010000             fstp dword ptr [esi + 0x164]
00521046 85d2                     test edx, edx
00521048 0f852e010000             jne 0x52117c
0052104e ba9d000000               mov edx, 0x9d
00521053 b894185800               mov eax, 0x581894
00521058 31db                     xor ebx, ebx
0052105a e82195eeff               call 0x40a580
0052105f 68b8185800               push 0x5818b8
00521064 e8d795eeff               call 0x40a640
00521069 83c404                   add esp, 4
0052106c d98664010000             fld dword ptr [esi + 0x164]
00521072 d80d7c1a5800             fmul dword ptr [0x581a7c]
00521078 d80d801a5800             fmul dword ptr [0x581a80]
0052107e 83ec04                   sub esp, 4
00521081 89f0                     mov eax, esi
00521083 d91c24                   fstp dword ptr [esp]
00521086 e8d5020000               call 0x521360
0052108b d95ddc                   fstp dword ptr [ebp - 0x24]
0052108e e931faffff               jmp 0x520ac4
00521093 7f4d                     jg 0x5210e2
00521095 bb40000000               mov ebx, 0x40
0052109a 8d559c                   lea edx, [ebp - 0x64]
0052109d 89f8                     mov eax, edi
0052109f e81cd7f0ff               call 0x42e7c0
005210a4 8d459c                   lea eax, [ebp - 0x64]
005210a7 e834300000               call 0x5240e0
005210ac 8986b8010000             mov dword ptr [esi + 0x1b8], eax
005210b2 85c0                     test eax, eax
005210b4 0f850afaffff             jne 0x520ac4
005210ba ba72010000               mov edx, 0x172
005210bf b894185800               mov eax, 0x581894
005210c4 31db                     xor ebx, ebx
005210c6 e8b594eeff               call 0x40a580
005210cb 8d459c                   lea eax, [ebp - 0x64]
005210ce 50                       push eax
005210cf badc195800               mov edx, 0x5819dc
005210d4 52                       push edx
005210d5 e86695eeff               call 0x40a640
005210da 83c408                   add esp, 8
005210dd e9e2f9ffff               jmp 0x520ac4
005210e2 83f83d                   cmp eax, 0x3d
005210e5 0f8507faffff             jne 0x520af2
005210eb bb40000000               mov ebx, 0x40
005210f0 8d559c                   lea edx, [ebp - 0x64]
005210f3 89f8                     mov eax, edi
005210f5 e8c6d6f0ff               call 0x42e7c0
005210fa 8d459c                   lea eax, [ebp - 0x64]
005210fd e8aef1ffff               call 0x5202b0
00521102 898694010000             mov dword ptr [esi + 0x194], eax
00521108 85c0                     test eax, eax
0052110a 0f85b4f9ffff             jne 0x520ac4
00521110 ba36010000               mov edx, 0x136
00521115 b894185800               mov eax, 0x581894
0052111a 31db                     xor ebx, ebx
0052111c e85f94eeff               call 0x40a580
00521121 8d459c                   lea eax, [ebp - 0x64]
00521124 50                       push eax
00521125 ba70195800               mov edx, 0x581970
0052112a 52                       push edx
0052112b e81095eeff               call 0x40a640
00521130 83c408                   add esp, 8
00521133 e98cf9ffff               jmp 0x520ac4
00521138 7e1b                     jle 0x521155
0052113a 83f806                   cmp eax, 6
0052113d 0f85aff9ffff             jne 0x520af2
00521143 89f8                     mov eax, edi
00521145 e836d5f0ff               call 0x42e680
0052114a d99e68010000             fstp dword ptr [esi + 0x168]
00521150 e96ff9ffff               jmp 0x520ac4
00521155 b809000000               mov eax, 9
0052115a 89fa                     mov edx, edi
0052115c e81f7efdff               call 0x4f8f80
00521161 e8dad8f0ff               call 0x42ea40
00521166 a1c8735900               mov eax, dword ptr [0x5973c8]
0052116b 31d2                     xor edx, edx
0052116d e84edff0ff               call 0x42f0c0
00521172 8d65ec                   lea esp, [ebp - 0x14]
00521175 5f                       pop edi
00521176 5e                       pop esi
00521177 5a                       pop edx
00521178 59                       pop ecx
00521179 5b                       pop ebx
0052117a 5d                       pop ebp
0052117b c3                       ret 
0052117c 83bea801000000           cmp dword ptr [esi + 0x1a8], 0
00521183 0f84c5feffff             je 0x52104e
00521189 83be9c01000000           cmp dword ptr [esi + 0x19c], 0
00521190 0f84b8feffff             je 0x52104e
00521196 83beac01000000           cmp dword ptr [esi + 0x1ac], 0
0052119d 0f84abfeffff             je 0x52104e
005211a3 e9c4feffff               jmp 0x52106c
005211a8 bb40000000               mov ebx, 0x40
005211ad 8d559c                   lea edx, [ebp - 0x64]
005211b0 89f8                     mov eax, edi
005211b2 e809d6f0ff               call 0x42e7c0
005211b7 8d459c                   lea eax, [ebp - 0x64]
005211ba e821390000               call 0x524ae0
005211bf 89869c010000             mov dword ptr [esi + 0x19c], eax
005211c5 85c0                     test eax, eax
005211c7 0f85f7f8ffff             jne 0x520ac4
005211cd ba18010000               mov edx, 0x118
005211d2 b894185800               mov eax, 0x581894
005211d7 31db                     xor ebx, ebx
005211d9 e8a293eeff               call 0x40a580
005211de 8d459c                   lea eax, [ebp - 0x64]
005211e1 50                       push eax
005211e2 ba34195800               mov edx, 0x581934
005211e7 52                       push edx
005211e8 e85394eeff               call 0x40a640
005211ed 83c408                   add esp, 8
005211f0 e9cff8ffff               jmp 0x520ac4
