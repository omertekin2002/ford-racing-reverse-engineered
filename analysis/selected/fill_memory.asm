; Analyst label: fill_memory; export span 0x00534690..0x005346a8
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00534690 51                       push ecx
00534691 89d9                     mov ecx, ebx
00534693 50                       push eax
00534694 88d6                     mov dh, dl
00534696 c1e208                   shl edx, 8
00534699 88f2                     mov dl, dh
0053469b c1e208                   shl edx, 8
0053469e 88f2                     mov dl, dh
005346a0 e89b2b0000               call 0x537240
005346a5 58                       pop eax
005346a6 59                       pop ecx
005346a7 c3                       ret 
