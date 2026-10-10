; Analyst label: load_directx_libraries; export span 0x00409b80..0x00409d80
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00409b80 53                       push ebx
00409b81 51                       push ecx
00409b82 52                       push edx
00409b83 56                       push esi
00409b84 57                       push edi
00409b85 688c6a5400               push 0x546a8c
00409b8a e801951300               call 0x543090
00409b8f a3e49f5800               mov dword ptr [0x589fe4], eax
00409b94 85c0                     test eax, eax
00409b96 7506                     jne 0x409b9e
00409b98 5f                       pop edi
00409b99 5e                       pop esi
00409b9a 5a                       pop edx
00409b9b 59                       pop ecx
00409b9c 5b                       pop ebx
00409b9d c3                       ret 
00409b9e 68986a5400               push 0x546a98
00409ba3 e8e8941300               call 0x543090
00409ba8 a3e89f5800               mov dword ptr [0x589fe8], eax
00409bad 85c0                     test eax, eax
00409baf 74e7                     je 0x409b98
00409bb1 68a46a5400               push 0x546aa4
00409bb6 e8d5941300               call 0x543090
00409bbb a3ec9f5800               mov dword ptr [0x589fec], eax
00409bc0 85c0                     test eax, eax
00409bc2 74d4                     je 0x409b98
00409bc4 68b06a5400               push 0x546ab0
00409bc9 e8c2941300               call 0x543090
00409bce a3f09f5800               mov dword ptr [0x589ff0], eax
00409bd3 85c0                     test eax, eax
00409bd5 74c1                     je 0x409b98
00409bd7 68bc6a5400               push 0x546abc
00409bdc 8b15e49f5800             mov edx, dword ptr [0x589fe4]
00409be2 52                       push edx
00409be3 e8a2941300               call 0x54308a
00409be8 68d06a5400               push 0x546ad0
00409bed 8b0de49f5800             mov ecx, dword ptr [0x589fe4]
00409bf3 51                       push ecx
00409bf4 a3fc9f5800               mov dword ptr [0x589ffc], eax
00409bf9 e88c941300               call 0x54308a
00409bfe 68e86a5400               push 0x546ae8
00409c03 8b1de89f5800             mov ebx, dword ptr [0x589fe8]
00409c09 53                       push ebx
00409c0a a300a05800               mov dword ptr [0x58a000], eax
00409c0f e876941300               call 0x54308a
00409c14 68fc6a5400               push 0x546afc
00409c19 8b35ec9f5800             mov esi, dword ptr [0x589fec]
00409c1f 56                       push esi
00409c20 a304a05800               mov dword ptr [0x58a004], eax
00409c25 e860941300               call 0x54308a
00409c2a 680c6b5400               push 0x546b0c
00409c2f 8b3df09f5800             mov edi, dword ptr [0x589ff0]
00409c35 57                       push edi
00409c36 a3f89f5800               mov dword ptr [0x589ff8], eax
00409c3b e84a941300               call 0x54308a
00409c40 a308a05800               mov dword ptr [0x58a008], eax
00409c45 b801000000               mov eax, 1
00409c4a 5f                       pop edi
00409c4b 5e                       pop esi
00409c4c 5a                       pop edx
00409c4d 59                       pop ecx
00409c4e 5b                       pop ebx
00409c4f c3                       ret 
00409c50 53                       push ebx
00409c51 51                       push ecx
00409c52 52                       push edx
00409c53 57                       push edi
00409c54 31d2                     xor edx, edx
00409c56 a1e49f5800               mov eax, dword ptr [0x589fe4]
00409c5b 891500a05800             mov dword ptr [0x58a000], edx
00409c61 891504a05800             mov dword ptr [0x58a004], edx
00409c67 8915f89f5800             mov dword ptr [0x589ff8], edx
00409c6d 891508a05800             mov dword ptr [0x58a008], edx
00409c73 8915fc9f5800             mov dword ptr [0x589ffc], edx
00409c79 85c0                     test eax, eax
00409c7b 753e                     jne 0x409cbb
00409c7d 8b1de89f5800             mov ebx, dword ptr [0x589fe8]
00409c83 85db                     test ebx, ebx
00409c85 740e                     je 0x409c95
00409c87 53                       push ebx
00409c88 31ff                     xor edi, edi
00409c8a e8f5931300               call 0x543084
00409c8f 893de89f5800             mov dword ptr [0x589fe8], edi
00409c95 a1ec9f5800               mov eax, dword ptr [0x589fec]
00409c9a 85c0                     test eax, eax
00409c9c 740e                     je 0x409cac
00409c9e 50                       push eax
00409c9f e8e0931300               call 0x543084
00409ca4 31c9                     xor ecx, ecx
00409ca6 890dec9f5800             mov dword ptr [0x589fec], ecx
00409cac 8b1df09f5800             mov ebx, dword ptr [0x589ff0]
00409cb2 85db                     test ebx, ebx
00409cb4 7515                     jne 0x409ccb
00409cb6 5f                       pop edi
00409cb7 5a                       pop edx
00409cb8 59                       pop ecx
00409cb9 5b                       pop ebx
00409cba c3                       ret 
00409cbb 50                       push eax
00409cbc e8c3931300               call 0x543084
00409cc1 31c9                     xor ecx, ecx
00409cc3 890de49f5800             mov dword ptr [0x589fe4], ecx
00409cc9 ebb2                     jmp 0x409c7d
00409ccb 53                       push ebx
00409ccc 31ff                     xor edi, edi
00409cce e8b1931300               call 0x543084
00409cd3 893df09f5800             mov dword ptr [0x589ff0], edi
00409cd9 5f                       pop edi
00409cda 5a                       pop edx
00409cdb 59                       pop ecx
00409cdc 5b                       pop ebx
00409cdd c3                       ret 
00409cde 8bc0                     mov eax, eax
00409ce0 27                       daa 
00409ce1 9d                       popfd 
00409ce2 40                       inc eax
00409ce3 0027                     add byte ptr [edi], ah
00409ce5 9d                       popfd 
00409ce6 40                       inc eax
00409ce7 00fa                     add dl, bh
00409ce9 9d                       popfd 
00409cea 40                       inc eax
00409ceb 00ee                     add dh, ch
00409ced 9d                       popfd 
00409cee 40                       inc eax
00409cef 0006                     add byte ptr [esi], al
00409cf1 9e                       sahf 
00409cf2 40                       inc eax
00409cf3 0012                     add byte ptr [edx], dl
00409cf5 9e                       sahf 
00409cf6 40                       inc eax
00409cf7 008d80000000             add byte ptr [ebp + 0x80], cl
00409cfd 008bd25589e5             add byte ptr [ebx - 0x1a76aa2e], cl
00409d03 56                       push esi
00409d04 57                       push edi
00409d05 81ec10040000             sub esp, 0x410
00409d0b 89c7                     mov edi, eax
00409d0d 8955f4                   mov dword ptr [ebp - 0xc], edx
00409d10 895de8                   mov dword ptr [ebp - 0x18], ebx
00409d13 894dec                   mov dword ptr [ebp - 0x14], ecx
00409d16 a1c0325b00               mov eax, dword ptr [0x5b32c0]
00409d1b 83f805                   cmp eax, 5
00409d1e 7707                     ja 0x409d27
00409d20 ff2485e09c4000           jmp dword ptr [eax*4 + 0x409ce0]
00409d27 31d2                     xor edx, edx
00409d29 8955f0                   mov dword ptr [ebp - 0x10], edx
00409d2c b9c0635800               mov ecx, 0x5863c0
00409d31 31f6                     xor esi, esi
00409d33 89ca                     mov edx, ecx
00409d35 89f8                     mov eax, edi
00409d37 e8e4ac1200               call 0x534a20
00409d3c 85c0                     test eax, eax
00409d3e 0f85da000000             jne 0x409e1e
00409d44 8b5df0                   mov ebx, dword ptr [ebp - 0x10]
00409d47 ba00040000               mov edx, 0x400
00409d4c 8d85e8fbffff             lea eax, [ebp - 0x418]
00409d52 01cb                     add ebx, ecx
00409d54 e8c77dffff               call 0x401b20
00409d59 83fe06                   cmp esi, 6
00409d5c 7512                     jne 0x409d70
00409d5e ba00040000               mov edx, 0x400
00409d63 8d85e8fbffff             lea eax, [ebp - 0x418]
00409d69 89fb                     mov ebx, edi
00409d6b e8b07dffff               call 0x401b20
00409d70 837df400                 cmp dword ptr [ebp - 0xc], 0
00409d74 745a                     je 0x409dd0
00409d76 b9c0635800               mov ecx, 0x5863c0
00409d7b 31f6                     xor esi, esi
00409d7d 8b45f4                   mov eax, dword ptr [ebp - 0xc]
