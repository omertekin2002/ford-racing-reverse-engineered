; Analyst label: skip_ascii_separators; export span 0x0042cfc0..0x0042d040
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042cfc0 55                       push ebp
0042cfc1 89e5                     mov ebp, esp
0042cfc3 53                       push ebx
0042cfc4 51                       push ecx
0042cfc5 52                       push edx
0042cfc6 83ec04                   sub esp, 4
0042cfc9 89c1                     mov ecx, eax
0042cfcb ba02000000               mov edx, 2
0042cfd0 8b5804                   mov ebx, dword ptr [eax + 4]
0042cfd3 8d45f0                   lea eax, [ebp - 0x10]
0042cfd6 e8d549fdff               call 0x4019b0
0042cfdb 8a65f0                   mov ah, byte ptr [ebp - 0x10]
0042cfde 80fc28                   cmp ah, 0x28
0042cfe1 7324                     jae 0x42d007
0042cfe3 80fc0a                   cmp ah, 0xa
0042cfe6 7346                     jae 0x42d02e
0042cfe8 80fc09                   cmp ah, 9
0042cfeb 7426                     je 0x42d013
0042cfed bb01000000               mov ebx, 1
0042cff2 baffffffff               mov edx, 0xffffffff
0042cff7 8b4104                   mov eax, dword ptr [ecx + 4]
0042cffa e84149fdff               call 0x401940
0042cfff 8d65f4                   lea esp, [ebp - 0xc]
0042d002 5a                       pop edx
0042d003 59                       pop ecx
0042d004 5b                       pop ebx
0042d005 5d                       pop ebp
0042d006 c3                       ret 
0042d007 760a                     jbe 0x42d013
0042d009 80fc2c                   cmp ah, 0x2c
0042d00c 7312                     jae 0x42d020
0042d00e 80fc29                   cmp ah, 0x29
0042d011 75da                     jne 0x42cfed
0042d013 ba02000000               mov edx, 2
0042d018 8d45f0                   lea eax, [ebp - 0x10]
0042d01b 8b5904                   mov ebx, dword ptr [ecx + 4]
0042d01e ebb6                     jmp 0x42cfd6
0042d020 76f1                     jbe 0x42d013
0042d022 80fc3b                   cmp ah, 0x3b
0042d025 72c6                     jb 0x42cfed
0042d027 76ea                     jbe 0x42d013
0042d029 80fc7b                   cmp ah, 0x7b
0042d02c ebbd                     jmp 0x42cfeb
0042d02e 76e3                     jbe 0x42d013
0042d030 80fc0d                   cmp ah, 0xd
0042d033 72b8                     jb 0x42cfed
0042d035 76dc                     jbe 0x42d013
0042d037 80fc20                   cmp ah, 0x20
0042d03a ebaf                     jmp 0x42cfeb
0042d03c 8d442000                 lea eax, [eax]
