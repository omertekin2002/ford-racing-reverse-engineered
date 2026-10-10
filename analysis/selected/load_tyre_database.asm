; Analyst label: load_tyre_database; export span 0x00523820..0x00523dc0
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00523820 55                       push ebp
00523821 89e5                     mov ebp, esp
00523823 53                       push ebx
00523824 51                       push ecx
00523825 52                       push edx
00523826 56                       push esi
00523827 57                       push edi
00523828 83ec28                   sub esp, 0x28
0052382b 6a00                     push 0
0052382d 6a00                     push 0
0052382f bbc03d5200               mov ebx, 0x523dc0
00523834 ba58000000               mov edx, 0x58
00523839 6a00                     push 0
0052383b b8d81f5800               mov eax, 0x581fd8
00523840 31c9                     xor ecx, ecx
00523842 e809b5f0ff               call 0x42ed50
00523847 686b010000               push 0x16b
0052384c b9944d5900               mov ecx, 0x594d94
00523851 a37c745900               mov dword ptr [0x59747c], eax
00523856 31d2                     xor edx, edx
00523858 31db                     xor ebx, ebx
0052385a b816000000               mov eax, 0x16
0052385f 8955e0                   mov dword ptr [ebp - 0x20], edx
00523862 8955e8                   mov dword ptr [ebp - 0x18], edx
00523865 bae81f5800               mov edx, 0x581fe8
0052386a e81157fdff               call 0x4f8f80
0052386f e8acb0f0ff               call 0x42e920
00523874 8b5804                   mov ebx, dword ptr [eax + 4]
00523877 8945e4                   mov dword ptr [ebp - 0x1c], eax
0052387a 85db                     test ebx, ebx
0052387c 0f84c6040000             je 0x523d48
00523882 ba02000000               mov edx, 2
00523887 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
0052388a e8a1acf0ff               call 0x42e530
0052388f 89c1                     mov ecx, eax
00523891 3dd5000000               cmp eax, 0xd5
00523896 7d5b                     jge 0x5238f3
00523898 3d9c000000               cmp eax, 0x9c
0052389d 0f8d76020000             jge 0x523b19
005238a3 83f8f5                   cmp eax, -0xb
005238a6 0f8d12040000             jge 0x523cbe
005238ac 83f8f2                   cmp eax, -0xe
005238af 0f8535010000             jne 0x5239ea
005238b5 8b55e0                   mov edx, dword ptr [ebp - 0x20]
005238b8 31c1                     xor ecx, eax
005238ba 31db                     xor ebx, ebx
005238bc a17c745900               mov eax, dword ptr [0x59747c]
005238c1 8b75e0                   mov esi, dword ptr [ebp - 0x20]
005238c4 e807b6f0ff               call 0x42eed0
005238c9 46                       inc esi
005238ca 8b157c745900             mov edx, dword ptr [0x59747c]
005238d0 31db                     xor ebx, ebx
005238d2 89c1                     mov ecx, eax
005238d4 e8f7b6f0ff               call 0x42efd0
005238d9 8975e0                   mov dword ptr [ebp - 0x20], esi
005238dc bb14000000               mov ebx, 0x14
005238e1 83c120                   add ecx, 0x20
005238e4 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
005238e7 89ca                     mov edx, ecx
005238e9 894de8                   mov dword ptr [ebp - 0x18], ecx
005238ec e8cfaef0ff               call 0x42e7c0
005238f1 eb8f                     jmp 0x523882
005238f3 7f1a                     jg 0x52390f
005238f5 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
005238f8 e883adf0ff               call 0x42e680
005238fd 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523900 d95028                   fst dword ptr [eax + 0x28]
00523903 d9e8                     fld1 
00523905 def1                     fdivrp st(1)
00523907 d9583c                   fstp dword ptr [eax + 0x3c]
0052390a e973ffffff               jmp 0x523882
0052390f 3d5c010000               cmp eax, 0x15c
00523914 7d37                     jge 0x52394d
00523916 3de3000000               cmp eax, 0xe3
0052391b 0f8d1c010000             jge 0x523a3d
00523921 3dde000000               cmp eax, 0xde
00523926 0f85be000000             jne 0x5239ea
0052392c 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
0052392f e84cadf0ff               call 0x42e680
00523934 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523937 d90584745900             fld dword ptr [0x597484]
0052393d d9c9                     fxch st(1)
0052393f d95818                   fstp dword ptr [eax + 0x18]
00523942 d84818                   fmul dword ptr [eax + 0x18]
00523945 d95818                   fstp dword ptr [eax + 0x18]
00523948 e935ffffff               jmp 0x523882
0052394d 7f13                     jg 0x523962
0052394f 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523952 e829adf0ff               call 0x42e680
00523957 8b45e8                   mov eax, dword ptr [ebp - 0x18]
0052395a d95824                   fstp dword ptr [eax + 0x24]
0052395d e920ffffff               jmp 0x523882
00523962 3d62010000               cmp eax, 0x162
00523967 7d1e                     jge 0x523987
00523969 3d5d010000               cmp eax, 0x15d
0052396e 0f8576000000             jne 0x5239ea
00523974 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523977 e804adf0ff               call 0x42e680
0052397c 8b45e8                   mov eax, dword ptr [ebp - 0x18]
0052397f d9582c                   fstp dword ptr [eax + 0x2c]
00523982 e9fbfeffff               jmp 0x523882
00523987 7f5a                     jg 0x5239e3
00523989 b816000000               mov eax, 0x16
0052398e ba28000000               mov edx, 0x28
00523993 31db                     xor ebx, ebx
00523995 e8e655fdff               call 0x4f8f80
0052399a e8417deeff               call 0x40b6e0
0052399f 8b55e8                   mov edx, dword ptr [ebp - 0x18]
005239a2 31f6                     xor esi, esi
005239a4 bb28000000               mov ebx, 0x28
005239a9 89424c                   mov dword ptr [edx + 0x4c], eax
005239ac 31d2                     xor edx, edx
005239ae 8975e0                   mov dword ptr [ebp - 0x20], esi
005239b1 e8da0c0100               call 0x534690
005239b6 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
005239b9 e852acf0ff               call 0x42e610
005239be 89c2                     mov edx, eax
005239c0 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
005239c3 8b7de0                   mov edi, dword ptr [ebp - 0x20]
005239c6 e8b5acf0ff               call 0x42e680
005239cb 8b45e8                   mov eax, dword ptr [ebp - 0x18]
005239ce 47                       inc edi
005239cf 8b404c                   mov eax, dword ptr [eax + 0x4c]
005239d2 897de0                   mov dword ptr [ebp - 0x20], edi
005239d5 d91c90                   fstp dword ptr [eax + edx*4]
005239d8 83ff0a                   cmp edi, 0xa
005239db 0f8da1feffff             jge 0x523882
005239e1 ebd3                     jmp 0x5239b6
005239e3 3d64010000               cmp eax, 0x164
005239e8 7d24                     jge 0x523a0e
005239ea ba8a010000               mov edx, 0x18a
005239ef b8f81f5800               mov eax, 0x581ff8
005239f4 31db                     xor ebx, ebx
005239f6 e8856beeff               call 0x40a580
005239fb 51                       push ecx
005239fc 681c205800               push 0x58201c
00523a01 e83a6ceeff               call 0x40a640
00523a06 83c408                   add esp, 8
00523a09 e974feffff               jmp 0x523882
00523a0e 7f13                     jg 0x523a23
00523a10 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523a13 e868acf0ff               call 0x42e680
00523a18 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523a1b d95820                   fstp dword ptr [eax + 0x20]
00523a1e e95ffeffff               jmp 0x523882
00523a23 3d6a010000               cmp eax, 0x16a
00523a28 75c0                     jne 0x5239ea
00523a2a 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523a2d e84eacf0ff               call 0x42e680
00523a32 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523a35 d95830                   fstp dword ptr [eax + 0x30]
00523a38 e945feffff               jmp 0x523882
00523a3d 7f13                     jg 0x523a52
00523a3f 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523a42 e839acf0ff               call 0x42e680
00523a47 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523a4a d95840                   fstp dword ptr [eax + 0x40]
00523a4d e930feffff               jmp 0x523882
00523a52 3df0000000               cmp eax, 0xf0
00523a57 7591                     jne 0x5239ea
00523a59 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523a5c 83785400                 cmp dword ptr [eax + 0x54], 0
00523a60 752a                     jne 0x523a8c
00523a62 b816000000               mov eax, 0x16
00523a67 bad0020000               mov edx, 0x2d0
00523a6c 31db                     xor ebx, ebx
00523a6e e80d55fdff               call 0x4f8f80
00523a73 e8687ceeff               call 0x40b6e0
00523a78 bbd0020000               mov ebx, 0x2d0
00523a7d 31d2                     xor edx, edx
00523a7f 89c1                     mov ecx, eax
00523a81 e80a0c0100               call 0x534690
00523a86 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523a89 894854                   mov dword ptr [eax + 0x54], ecx
00523a8c ba02000000               mov edx, 2
00523a91 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523a94 bb0f000000               mov ebx, 0xf
00523a99 e892aaf0ff               call 0x42e530
00523a9e baf43a5900               mov edx, 0x593af4
00523aa3 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523aa6 e875adf0ff               call 0x42e820
00523aab ba02000000               mov edx, 2
00523ab0 8945dc                   mov dword ptr [ebp - 0x24], eax
00523ab3 89c7                     mov edi, eax
00523ab5 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523ab8 e873aaf0ff               call 0x42e530
00523abd 6bcf28                   imul ecx, edi, 0x28
00523ac0 83f8ef                   cmp eax, -0x11
00523ac3 0f8489020000             je 0x523d52
00523ac9 bb0f000000               mov ebx, 0xf
00523ace baf43a5900               mov edx, 0x593af4
00523ad3 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523ad6 e845adf0ff               call 0x42e820
00523adb 89c2                     mov edx, eax
00523add 6bf228                   imul esi, edx, 0x28
00523ae0 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523ae3 8b4054                   mov eax, dword ptr [eax + 0x54]
00523ae6 83c078                   add eax, 0x78
00523ae9 01c6                     add esi, eax
00523aeb 8d3c08                   lea edi, [eax + ecx]
00523aee b928000000               mov ecx, 0x28
00523af3 57                       push edi
00523af4 89c8                     mov eax, ecx
00523af6 c1e902                   shr ecx, 2
00523af9 f2a5                     movsd dword ptr es:[edi], dword ptr [esi]
00523afb 8ac8                     mov cl, al
00523afd 80e103                   and cl, 3
00523b00 f2a4                     repne movsb byte ptr es:[edi], byte ptr [esi]
00523b02 5f                       pop edi
00523b03 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523b06 8b4054                   mov eax, dword ptr [eax + 0x54]
00523b09 8b4ddc                   mov ecx, dword ptr [ebp - 0x24]
00523b0c 8b5c903c                 mov ebx, dword ptr [eax + edx*4 + 0x3c]
00523b10 895c883c                 mov dword ptr [eax + ecx*4 + 0x3c], ebx
00523b14 e969fdffff               jmp 0x523882
00523b19 7f2f                     jg 0x523b4a
00523b1b bb14000000               mov ebx, 0x14
00523b20 8d55c4                   lea edx, [ebp - 0x3c]
00523b23 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523b26 e895acf0ff               call 0x42e7c0
00523b2b 8d45c4                   lea eax, [ebp - 0x3c]
00523b2e e8ad050000               call 0x5240e0
00523b33 89c1                     mov ecx, eax
00523b35 89c2                     mov edx, eax
00523b37 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523b3a e851050000               call 0x524090
00523b3f 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523b42 894814                   mov dword ptr [eax + 0x14], ecx
00523b45 e938fdffff               jmp 0x523882
00523b4a 3da6000000               cmp eax, 0xa6
00523b4f 0f8d7d000000             jge 0x523bd2
00523b55 3da3000000               cmp eax, 0xa3
00523b5a 0f858afeffff             jne 0x5239ea
00523b60 be48030000               mov esi, 0x348
00523b65 31c1                     xor ecx, eax
00523b67 b816000000               mov eax, 0x16
00523b6c 89cb                     mov ebx, ecx
00523b6e 89f2                     mov edx, esi
00523b70 e80b54fdff               call 0x4f8f80
00523b75 e8667beeff               call 0x40b6e0
00523b7a 8b55e8                   mov edx, dword ptr [ebp - 0x18]
00523b7d 894248                   mov dword ptr [edx + 0x48], eax
00523b80 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523b83 89f3                     mov ebx, esi
00523b85 31d2                     xor edx, edx
00523b87 8b4048                   mov eax, dword ptr [eax + 0x48]
00523b8a e8010b0100               call 0x534690
00523b8f 31c0                     xor eax, eax
00523b91 8945e0                   mov dword ptr [ebp - 0x20], eax
00523b94 6bd854                   imul ebx, eax, 0x54
00523b97 83c354                   add ebx, 0x54
00523b9a 6bf054                   imul esi, eax, 0x54
00523b9d 89d9                     mov ecx, ebx
00523b9f 89f2                     mov edx, esi
00523ba1 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523ba4 e8d7aaf0ff               call 0x42e680
00523ba9 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523bac 83c204                   add edx, 4
00523baf 8b4048                   mov eax, dword ptr [eax + 0x48]
00523bb2 d95c02fc                 fstp dword ptr [edx + eax - 4]
00523bb6 39ca                     cmp edx, ecx
00523bb8 75e7                     jne 0x523ba1
00523bba 8b45e0                   mov eax, dword ptr [ebp - 0x20]
00523bbd 83c654                   add esi, 0x54
00523bc0 40                       inc eax
00523bc1 83c354                   add ebx, 0x54
00523bc4 8945e0                   mov dword ptr [ebp - 0x20], eax
00523bc7 83f80a                   cmp eax, 0xa
00523bca 0f8db2fcffff             jge 0x523882
00523bd0 ebcb                     jmp 0x523b9d
00523bd2 0f8f93000000             jg 0x523c6b
00523bd8 31f6                     xor esi, esi
00523bda 89f3                     mov ebx, esi
00523bdc 8975e0                   mov dword ptr [ebp - 0x20], esi
00523bdf 6bf62c                   imul esi, esi, 0x2c
00523be2 b98c010000               mov ecx, 0x18c
00523be7 b816000000               mov eax, 0x16
00523bec 89ca                     mov edx, ecx
00523bee e88d53fdff               call 0x4f8f80
00523bf3 e8e87aeeff               call 0x40b6e0
00523bf8 8b55e8                   mov edx, dword ptr [ebp - 0x18]
00523bfb 894244                   mov dword ptr [edx + 0x44], eax
00523bfe 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523c01 89cb                     mov ebx, ecx
00523c03 31d2                     xor edx, edx
00523c05 8b4044                   mov eax, dword ptr [eax + 0x44]
00523c08 31c9                     xor ecx, ecx
00523c0a e8810a0100               call 0x534690
00523c0f 83c62c                   add esi, 0x2c
00523c12 6bd92c                   imul ebx, ecx, 0x2c
00523c15 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523c18 e863aaf0ff               call 0x42e680
00523c1d 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523c20 8b4044                   mov eax, dword ptr [eax + 0x44]
00523c23 8d4b04                   lea ecx, [ebx + 4]
00523c26 89f2                     mov edx, esi
00523c28 d91c03                   fstp dword ptr [ebx + eax]
00523c2b 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523c2e e84daaf0ff               call 0x42e680
00523c33 83c104                   add ecx, 4
00523c36 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523c39 d91d88745900             fstp dword ptr [0x597488]
00523c3f 8b4044                   mov eax, dword ptr [eax + 0x44]
00523c42 8b3d88745900             mov edi, dword ptr [0x597488]
00523c48 897c01fc                 mov dword ptr [ecx + eax - 4], edi
00523c4c 39d1                     cmp ecx, edx
00523c4e 75db                     jne 0x523c2b
00523c50 8b7de0                   mov edi, dword ptr [ebp - 0x20]
00523c53 83c32c                   add ebx, 0x2c
00523c56 47                       inc edi
00523c57 83c62c                   add esi, 0x2c
00523c5a 897de0                   mov dword ptr [ebp - 0x20], edi
00523c5d 81fb8c010000             cmp ebx, 0x18c
00523c63 0f8d19fcffff             jge 0x523882
00523c69 ebaa                     jmp 0x523c15
00523c6b 3da8000000               cmp eax, 0xa8
00523c70 0f8c74fdffff             jl 0x5239ea
00523c76 7f1a                     jg 0x523c92
00523c78 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523c7b e800aaf0ff               call 0x42e680
00523c80 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523c83 d95034                   fst dword ptr [eax + 0x34]
00523c86 d9e8                     fld1 
00523c88 def1                     fdivrp st(1)
00523c8a d95838                   fstp dword ptr [eax + 0x38]
00523c8d e9f0fbffff               jmp 0x523882
00523c92 3dcc000000               cmp eax, 0xcc
00523c97 0f854dfdffff             jne 0x5239ea
00523c9d 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523ca0 e8dba9f0ff               call 0x42e680
00523ca5 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523ca8 d90584745900             fld dword ptr [0x597484]
00523cae d9c9                     fxch st(1)
00523cb0 d9581c                   fstp dword ptr [eax + 0x1c]
00523cb3 d8481c                   fmul dword ptr [eax + 0x1c]
00523cb6 d9581c                   fstp dword ptr [eax + 0x1c]
00523cb9 e9c4fbffff               jmp 0x523882
00523cbe 7e6a                     jle 0x523d2a
00523cc0 83f81e                   cmp eax, 0x1e
00523cc3 0f8521fdffff             jne 0x5239ea
00523cc9 be28000000               mov esi, 0x28
00523cce 31c1                     xor ecx, eax
00523cd0 b816000000               mov eax, 0x16
00523cd5 89cb                     mov ebx, ecx
00523cd7 89f2                     mov edx, esi
00523cd9 e8a252fdff               call 0x4f8f80
00523cde e8fd79eeff               call 0x40b6e0
00523ce3 8b55e8                   mov edx, dword ptr [ebp - 0x18]
00523ce6 894250                   mov dword ptr [edx + 0x50], eax
00523ce9 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523cec 89f3                     mov ebx, esi
00523cee 31d2                     xor edx, edx
00523cf0 8b4050                   mov eax, dword ptr [eax + 0x50]
00523cf3 e898090100               call 0x534690
00523cf8 31db                     xor ebx, ebx
00523cfa 895de0                   mov dword ptr [ebp - 0x20], ebx
00523cfd 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523d00 e80ba9f0ff               call 0x42e610
00523d05 89c2                     mov edx, eax
00523d07 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523d0a 8b5de0                   mov ebx, dword ptr [ebp - 0x20]
00523d0d e86ea9f0ff               call 0x42e680
00523d12 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523d15 43                       inc ebx
00523d16 8b4050                   mov eax, dword ptr [eax + 0x50]
00523d19 895de0                   mov dword ptr [ebp - 0x20], ebx
00523d1c d91c90                   fstp dword ptr [eax + edx*4]
00523d1f 83fb0a                   cmp ebx, 0xa
00523d22 0f8d5afbffff             jge 0x523882
00523d28 ebd3                     jmp 0x523cfd
00523d2a b816000000               mov eax, 0x16
00523d2f 8b55e4                   mov edx, dword ptr [ebp - 0x1c]
00523d32 e84952fdff               call 0x4f8f80
00523d37 e804adf0ff               call 0x42ea40
00523d3c a17c745900               mov eax, dword ptr [0x59747c]
00523d41 31d2                     xor edx, edx
00523d43 e878b3f0ff               call 0x42f0c0
00523d48 8d65ec                   lea esp, [ebp - 0x14]
00523d4b 5f                       pop edi
00523d4c 5e                       pop esi
00523d4d 5a                       pop edx
00523d4e 59                       pop ecx
00523d4f 5b                       pop ebx
00523d50 5d                       pop ebp
00523d51 c3                       ret 
00523d52 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523d55 e8b6a8f0ff               call 0x42e610
00523d5a 31d2                     xor edx, edx
00523d5c 8945d8                   mov dword ptr [ebp - 0x28], eax
00523d5f 85c0                     test eax, eax
00523d61 7e27                     jle 0x523d8a
00523d63 89ce                     mov esi, ecx
00523d65 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523d68 e8a3a8f0ff               call 0x42e610
00523d6d 89c1                     mov ecx, eax
00523d6f 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523d72 e809a9f0ff               call 0x42e680
00523d77 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523d7a 8b4054                   mov eax, dword ptr [eax + 0x54]
00523d7d 8d1c30                   lea ebx, [eax + esi]
00523d80 42                       inc edx
00523d81 d95c8b78                 fstp dword ptr [ebx + ecx*4 + 0x78]
00523d85 3b55d8                   cmp edx, dword ptr [ebp - 0x28]
00523d88 7cdb                     jl 0x523d65
00523d8a ba02000000               mov edx, 2
00523d8f 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523d92 e899a7f0ff               call 0x42e530
00523d97 8b45e4                   mov eax, dword ptr [ebp - 0x1c]
00523d9a e8e1a8f0ff               call 0x42e680
00523d9f 8b45e8                   mov eax, dword ptr [ebp - 0x18]
00523da2 8b4054                   mov eax, dword ptr [eax + 0x54]
00523da5 d95cb83c                 fstp dword ptr [eax + edi*4 + 0x3c]
00523da9 e9d4faffff               jmp 0x523882
00523dae 8bc0                     mov eax, eax
00523db0 a17c745900               mov eax, dword ptr [0x59747c]
00523db5 e946b0f0ff               jmp 0x42ee00
00523dba 8d8000000000             lea eax, [eax]
