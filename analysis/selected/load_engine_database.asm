; Analyst label: load_engine_database; export span 0x005227f0..0x00522c80
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
005227f0 55                       push ebp
005227f1 89e5                     mov ebp, esp
005227f3 53                       push ebx
005227f4 51                       push ecx
005227f5 52                       push edx
005227f6 56                       push esi
005227f7 57                       push edi
005227f8 83ec2c                   sub esp, 0x2c
005227fb 6a00                     push 0
005227fd 6a00                     push 0
005227ff bb702c5200               mov ebx, 0x522c70
00522804 bab0000000               mov edx, 0xb0
00522809 6a00                     push 0
0052280b b8a41c5800               mov eax, 0x581ca4
00522810 31c9                     xor ecx, ecx
00522812 e839c5f0ff               call 0x42ed50
00522817 686b010000               push 0x16b
0052281c b9944d5900               mov ecx, 0x594d94
00522821 a318745900               mov dword ptr [0x597418], eax
00522826 31d2                     xor edx, edx
00522828 31db                     xor ebx, ebx
0052282a b80d000000               mov eax, 0xd
0052282f 8955e4                   mov dword ptr [ebp - 0x1c], edx
00522832 bab41c5800               mov edx, 0x581cb4
00522837 31ff                     xor edi, edi
00522839 e87267fdff               call 0x4f8fb0
0052283e 89c6                     mov esi, eax
00522840 85c0                     test eax, eax
00522842 0f84fc030000             je 0x522c44
00522848 ba02000000               mov edx, 2
0052284d 89f0                     mov eax, esi
0052284f e8dcbcf0ff               call 0x42e530
00522854 89c1                     mov ecx, eax
00522856 3dab000000               cmp eax, 0xab
0052285b 7d3c                     jge 0x522899
0052285d 83f87f                   cmp eax, 0x7f
00522860 0f8d6b020000             jge 0x522ad1
00522866 83f801                   cmp eax, 1
00522869 0f8d26030000             jge 0x522b95
0052286f 83f8f2                   cmp eax, -0xe
00522872 0f8d70030000             jge 0x522be8
00522878 baa0010000               mov edx, 0x1a0
0052287d b8c41c5800               mov eax, 0x581cc4
00522882 31db                     xor ebx, ebx
00522884 e8f77ceeff               call 0x40a580
00522889 51                       push ecx
0052288a 68ec1c5800               push 0x581cec
0052288f e8ac7deeff               call 0x40a640
00522894 83c408                   add esp, 8
00522897 ebaf                     jmp 0x522848
00522899 7f0f                     jg 0x5228aa
0052289b 89f0                     mov eax, esi
0052289d e8debdf0ff               call 0x42e680
005228a2 d99f9c000000             fstp dword ptr [edi + 0x9c]
005228a8 eb9e                     jmp 0x522848
005228aa 3dc8000000               cmp eax, 0xc8
005228af 7d2a                     jge 0x5228db
005228b1 3db0000000               cmp eax, 0xb0
005228b6 0f8db1010000             jge 0x522a6d
005228bc 3dad000000               cmp eax, 0xad
005228c1 7cb5                     jl 0x522878
005228c3 0f8feb010000             jg 0x522ab4
005228c9 89f0                     mov eax, esi
005228cb e8b0bdf0ff               call 0x42e680
005228d0 d99fac000000             fstp dword ptr [edi + 0xac]
005228d6 e96dffffff               jmp 0x522848
005228db 7f12                     jg 0x5228ef
005228dd 89f0                     mov eax, esi
005228df e82cbdf0ff               call 0x42e610
005228e4 888794000000             mov byte ptr [edi + 0x94], al
005228ea e959ffffff               jmp 0x522848
005228ef 3d18010000               cmp eax, 0x118
005228f4 7d20                     jge 0x522916
005228f6 3de4000000               cmp eax, 0xe4
005228fb 0f8c77ffffff             jl 0x522878
00522901 0f8f4c010000             jg 0x522a53
00522907 89f0                     mov eax, esi
00522909 e872bdf0ff               call 0x42e680
0052290e d95f28                   fstp dword ptr [edi + 0x28]
00522911 e932ffffff               jmp 0x522848
00522916 0f8fe4000000             jg 0x522a00
0052291c bb48000000               mov ebx, 0x48
00522921 8d473c                   lea eax, [edi + 0x3c]
00522924 31d2                     xor edx, edx
00522926 e8651d0100               call 0x534690
0052292b d94730                   fld dword ptr [edi + 0x30]
0052292e d805181d5800             fadd dword ptr [0x581d18]
00522934 d80d101d5800             fmul dword ptr [0x581d10]
0052293a e8bb290100               call 0x5352fa
0052293f db5dd8                   fistp dword ptr [ebp - 0x28]
00522942 8b5dd8                   mov ebx, dword ptr [ebp - 0x28]
00522945 43                       inc ebx
00522946 31c9                     xor ecx, ecx
00522948 895dd8                   mov dword ptr [ebp - 0x28], ebx
0052294b 85db                     test ebx, ebx
0052294d 7e21                     jle 0x522970
0052294f 8b5dd8                   mov ebx, dword ptr [ebp - 0x28]
00522952 89fa                     mov edx, edi
00522954 89f0                     mov eax, esi
00522956 e825bdf0ff               call 0x42e680
0052295b 83c204                   add edx, 4
0052295e 41                       inc ecx
0052295f 89f0                     mov eax, esi
00522961 d95dd4                   fstp dword ptr [ebp - 0x2c]
00522964 e817bdf0ff               call 0x42e680
00522969 d95a38                   fstp dword ptr [edx + 0x38]
0052296c 39d9                     cmp ecx, ebx
0052296e 7ce4                     jl 0x522954
00522970 31c0                     xor eax, eax
00522972 d9ee                     fldz 
00522974 8945dc                   mov dword ptr [ebp - 0x24], eax
00522977 8945e8                   mov dword ptr [ebp - 0x18], eax
0052297a d85f30                   fcomp dword ptr [edi + 0x30]
0052297d dfe0                     fnstsw ax
0052297f 9e                       sahf 
00522980 7356                     jae 0x5229d8
00522982 d945e8                   fld dword ptr [ebp - 0x18]
00522985 d9c0                     fld st(0)
00522987 d805281d5800             fadd dword ptr [0x581d28]
0052298d d80d101d5800             fmul dword ptr [0x581d10]
00522993 e862290100               call 0x5352fa
00522998 db5dd4                   fistp dword ptr [ebp - 0x2c]
0052299b 8b45d4                   mov eax, dword ptr [ebp - 0x2c]
0052299e d84c873c                 fmul dword ptr [edi + eax*4 + 0x3c]
005229a2 d80d141d5800             fmul dword ptr [0x581d14]
005229a8 d945dc                   fld dword ptr [ebp - 0x24]
005229ab d9c9                     fxch st(1)
005229ad d95de0                   fstp dword ptr [ebp - 0x20]
005229b0 d85de0                   fcomp dword ptr [ebp - 0x20]
005229b3 dfe0                     fnstsw ax
005229b5 9e                       sahf 
005229b6 730c                     jae 0x5229c4
005229b8 8b45e0                   mov eax, dword ptr [ebp - 0x20]
005229bb 8945dc                   mov dword ptr [ebp - 0x24], eax
005229be 8b45e8                   mov eax, dword ptr [ebp - 0x18]
005229c1 89472c                   mov dword ptr [edi + 0x2c], eax
005229c4 d945e8                   fld dword ptr [ebp - 0x18]
005229c7 d8051c1d5800             fadd dword ptr [0x581d1c]
005229cd d955e8                   fst dword ptr [ebp - 0x18]
005229d0 d85f30                   fcomp dword ptr [edi + 0x30]
005229d3 dfe0                     fnstsw ax
005229d5 9e                       sahf 
005229d6 72aa                     jb 0x522982
005229d8 d9472c                   fld dword ptr [edi + 0x2c]
005229db d86730                   fsub dword ptr [edi + 0x30]
005229de d9e1                     fabs 
005229e0 d81d201d5800             fcomp dword ptr [0x581d20]
005229e6 dfe0                     fnstsw ax
005229e8 9e                       sahf 
005229e9 0f8359feffff             jae 0x522848
005229ef d94730                   fld dword ptr [edi + 0x30]
005229f2 d805241d5800             fadd dword ptr [0x581d24]
005229f8 d95f2c                   fstp dword ptr [edi + 0x2c]
005229fb e948feffff               jmp 0x522848
00522a00 3d19010000               cmp eax, 0x119
00522a05 7f0f                     jg 0x522a16
00522a07 89f0                     mov eax, esi
00522a09 e872bcf0ff               call 0x42e680
00522a0e d95f24                   fstp dword ptr [edi + 0x24]
00522a11 e932feffff               jmp 0x522848
00522a16 3d5b010000               cmp eax, 0x15b
00522a1b 0f8557feffff             jne 0x522878
00522a21 89f0                     mov eax, esi
00522a23 e858bcf0ff               call 0x42e680
00522a28 d99fa0000000             fstp dword ptr [edi + 0xa0]
00522a2e f787a0000000ffffff7f     test dword ptr [edi + 0xa0], 0x7fffffff
00522a38 0f8410020000             je 0x522c4e
00522a3e d987a0000000             fld dword ptr [edi + 0xa0]
00522a44 d9e8                     fld1 
00522a46 def1                     fdivrp st(1)
00522a48 d99fa4000000             fstp dword ptr [edi + 0xa4]
00522a4e e9f5fdffff               jmp 0x522848
00522a53 3d12010000               cmp eax, 0x112
00522a58 0f851afeffff             jne 0x522878
00522a5e 89f0                     mov eax, esi
00522a60 e81bbcf0ff               call 0x42e680
00522a65 d95f38                   fstp dword ptr [edi + 0x38]
00522a68 e9dbfdffff               jmp 0x522848
00522a6d 7f0f                     jg 0x522a7e
00522a6f 89f0                     mov eax, esi
00522a71 e80abcf0ff               call 0x42e680
00522a76 d95f30                   fstp dword ptr [edi + 0x30]
00522a79 e9cafdffff               jmp 0x522848
00522a7e 3db1000000               cmp eax, 0xb1
00522a83 7f12                     jg 0x522a97
00522a85 89f0                     mov eax, esi
00522a87 e8f4bbf0ff               call 0x42e680
00522a8c d99f84000000             fstp dword ptr [edi + 0x84]
00522a92 e9b1fdffff               jmp 0x522848
00522a97 3dc6000000               cmp eax, 0xc6
00522a9c 0f85d6fdffff             jne 0x522878
00522aa2 89f0                     mov eax, esi
00522aa4 e867bbf0ff               call 0x42e610
00522aa9 888795000000             mov byte ptr [edi + 0x95], al
00522aaf e994fdffff               jmp 0x522848
00522ab4 3dae000000               cmp eax, 0xae
00522ab9 0f85b9fdffff             jne 0x522878
00522abf 89f0                     mov eax, esi
00522ac1 e8babbf0ff               call 0x42e680
00522ac6 d99fa8000000             fstp dword ptr [edi + 0xa8]
00522acc e977fdffff               jmp 0x522848
00522ad1 7f0f                     jg 0x522ae2
00522ad3 89f0                     mov eax, esi
00522ad5 e8a6bbf0ff               call 0x42e680
00522ada d95f20                   fstp dword ptr [edi + 0x20]
00522add e966fdffff               jmp 0x522848
00522ae2 3d8a000000               cmp eax, 0x8a
00522ae7 7d23                     jge 0x522b0c
00522ae9 3d87000000               cmp eax, 0x87
00522aee 0f8c84fdffff             jl 0x522878
00522af4 0f8f7e000000             jg 0x522b78
00522afa 89f0                     mov eax, esi
00522afc e87fbbf0ff               call 0x42e680
00522b01 d99f88000000             fstp dword ptr [edi + 0x88]
00522b07 e93cfdffff               jmp 0x522848
00522b0c 7f0f                     jg 0x522b1d
00522b0e 89f0                     mov eax, esi
00522b10 e86bbbf0ff               call 0x42e680
00522b15 d95f1c                   fstp dword ptr [edi + 0x1c]
00522b18 e92bfdffff               jmp 0x522848
00522b1d 3d9c000000               cmp eax, 0x9c
00522b22 0f8c50fdffff             jl 0x522878
00522b28 7f2a                     jg 0x522b54
00522b2a bb14000000               mov ebx, 0x14
00522b2f 8d55c0                   lea edx, [ebp - 0x40]
00522b32 89f0                     mov eax, esi
00522b34 e887bcf0ff               call 0x42e7c0
00522b39 8d45c0                   lea eax, [ebp - 0x40]
00522b3c e82f020000               call 0x522d70
00522b41 89c1                     mov ecx, eax
00522b43 89c2                     mov edx, eax
00522b45 89f8                     mov eax, edi
00522b47 e834010000               call 0x522c80
00522b4c 894f18                   mov dword ptr [edi + 0x18], ecx
00522b4f e9f4fcffff               jmp 0x522848
00522b54 3da5000000               cmp eax, 0xa5
00522b59 0f8519fdffff             jne 0x522878
00522b5f bb03000000               mov ebx, 3
00522b64 ba08745900               mov edx, 0x597408
00522b69 89f0                     mov eax, esi
00522b6b e8b0bcf0ff               call 0x42e820
00522b70 884714                   mov byte ptr [edi + 0x14], al
00522b73 e9d0fcffff               jmp 0x522848
00522b78 3d88000000               cmp eax, 0x88
00522b7d 0f85f5fcffff             jne 0x522878
00522b83 89f0                     mov eax, esi
00522b85 e8f6baf0ff               call 0x42e680
00522b8a d99f8c000000             fstp dword ptr [edi + 0x8c]
00522b90 e9b3fcffff               jmp 0x522848
00522b95 7f12                     jg 0x522ba9
00522b97 89f0                     mov eax, esi
00522b99 e8e2baf0ff               call 0x42e680
00522b9e d99f90000000             fstp dword ptr [edi + 0x90]
00522ba4 e99ffcffff               jmp 0x522848
00522ba9 83f810                   cmp eax, 0x10
00522bac 0f8cc6fcffff             jl 0x522878
00522bb2 7f1c                     jg 0x522bd0
00522bb4 bb03000000               mov ebx, 3
00522bb9 baf8735900               mov edx, 0x5973f8
00522bbe 89f0                     mov eax, esi
00522bc0 e85bbcf0ff               call 0x42e820
00522bc5 898798000000             mov dword ptr [edi + 0x98], eax
00522bcb e978fcffff               jmp 0x522848
00522bd0 83f837                   cmp eax, 0x37
00522bd3 0f859ffcffff             jne 0x522878
00522bd9 89f0                     mov eax, esi
00522bdb e8a0baf0ff               call 0x42e680
00522be0 d95f34                   fstp dword ptr [edi + 0x34]
00522be3 e960fcffff               jmp 0x522848
00522be8 7f39                     jg 0x522c23
00522bea 8b55e4                   mov edx, dword ptr [ebp - 0x1c]
00522bed 31c1                     xor ecx, eax
00522bef 31db                     xor ebx, ebx
00522bf1 a118745900               mov eax, dword ptr [0x597418]
00522bf6 e8d5c2f0ff               call 0x42eed0
00522bfb 8b1518745900             mov edx, dword ptr [0x597418]
00522c01 31db                     xor ebx, ebx
00522c03 89c7                     mov edi, eax
00522c05 e8c6c3f0ff               call 0x42efd0
00522c0a bb14000000               mov ebx, 0x14
00522c0f 83c720                   add edi, 0x20
00522c12 89f0                     mov eax, esi
00522c14 89fa                     mov edx, edi
00522c16 e8a5bbf0ff               call 0x42e7c0
00522c1b ff45e4                   inc dword ptr [ebp - 0x1c]
00522c1e e925fcffff               jmp 0x522848
00522c23 83f8f5                   cmp eax, -0xb
00522c26 0f854cfcffff             jne 0x522878
00522c2c b80d000000               mov eax, 0xd
00522c31 89f2                     mov edx, esi
00522c33 e89863fdff               call 0x4f8fd0
00522c38 a118745900               mov eax, dword ptr [0x597418]
00522c3d 31d2                     xor edx, edx
00522c3f e87cc4f0ff               call 0x42f0c0
00522c44 8d65ec                   lea esp, [ebp - 0x14]
00522c47 5f                       pop edi
00522c48 5e                       pop esi
00522c49 5a                       pop edx
00522c4a 59                       pop ecx
00522c4b 5b                       pop ebx
00522c4c 5d                       pop ebp
00522c4d c3                       ret 
00522c4e c787a40000000000803f     mov dword ptr [edi + 0xa4], 0x3f800000
00522c58 e9ebfbffff               jmp 0x522848
00522c5d 8d4000                   lea eax, [eax]
00522c60 a118745900               mov eax, dword ptr [0x597418]
00522c65 e996c1f0ff               jmp 0x42ee00
00522c6a 8d8000000000             lea eax, [eax]
00522c70 c3                       ret 
00522c71 8d8000000000             lea eax, [eax]
00522c77 8d9200000000             lea edx, [edx]
00522c7d 8d4000                   lea eax, [eax]
