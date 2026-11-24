; Analyst label: open_database_file; export span 0x004f8f80..0x004f8fc7
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
004f8f80 8b048530388e00           mov eax, dword ptr [eax*4 + 0x8e3830]
004f8f87 c3                       ret 
004f8f88 8d8000000000             lea eax, [eax]
004f8f8e 8bd2                     mov edx, edx
004f8f90 e8ebffffff               call 0x4f8f80
004f8f95 e9a689f2ff               jmp 0x421940
004f8f9a 8d8000000000             lea eax, [eax]
004f8fa0 e8dbffffff               call 0x4f8f80
004f8fa5 e906aef2ff               jmp 0x423db0
004f8faa 8d8000000000             lea eax, [eax]
004f8fb0 55                       push ebp
004f8fb1 89e5                     mov ebp, esp
004f8fb3 56                       push esi
004f8fb4 8b7508                   mov esi, dword ptr [ebp + 8]
004f8fb7 56                       push esi
004f8fb8 e8c3ffffff               call 0x4f8f80
004f8fbd e85e59f3ff               call 0x42e920
004f8fc2 5e                       pop esi
004f8fc3 5d                       pop ebp
004f8fc4 c20400                   ret 4
