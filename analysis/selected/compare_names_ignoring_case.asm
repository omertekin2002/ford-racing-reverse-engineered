; Analyst label: compare_names_ignoring_case; export span 0x00534980..0x005349bb
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00534980 53                       push ebx
00534981 89c3                     mov ebx, eax
00534983 8a03                     mov al, byte ptr [ebx]
00534985 8a22                     mov ah, byte ptr [edx]
00534987 3c41                     cmp al, 0x41
00534989 7206                     jb 0x534991
0053498b 3c5a                     cmp al, 0x5a
0053498d 7702                     ja 0x534991
0053498f 0420                     add al, 0x20
00534991 80fc41                   cmp ah, 0x41
00534994 7208                     jb 0x53499e
00534996 80fc5a                   cmp ah, 0x5a
00534999 7703                     ja 0x53499e
0053499b 80c420                   add ah, 0x20
0053499e 38e0                     cmp al, ah
005349a0 7508                     jne 0x5349aa
005349a2 84e4                     test ah, ah
005349a4 7404                     je 0x5349aa
005349a6 43                       inc ebx
005349a7 42                       inc edx
005349a8 ebd9                     jmp 0x534983
005349aa 31d2                     xor edx, edx
005349ac 88c2                     mov dl, al
005349ae 88e0                     mov al, ah
005349b0 25ff000000               and eax, 0xff
005349b5 29c2                     sub edx, eax
005349b7 89d0                     mov eax, edx
005349b9 5b                       pop ebx
005349ba c3                       ret 
