; Analyst label: register_application_tags; export span 0x004fa470..0x004fa48d
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
004fa470 53                       push ebx
004fa471 51                       push ecx
004fa472 52                       push edx
004fa473 b9944d5900               mov ecx, 0x594d94
004fa478 bb6b010000               mov ebx, 0x16b
004fa47d b802000000               mov eax, 2
004fa482 31d2                     xor edx, edx
004fa484 e8b73ef3ff               call 0x42e340
004fa489 5a                       pop edx
004fa48a 59                       pop ecx
004fa48b 5b                       pop ebx
004fa48c c3                       ret 
