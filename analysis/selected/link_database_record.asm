; Analyst label: link_database_record; export span 0x0042efd0..0x0042f005
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
0042efd0 51                       push ecx
0042efd1 895008                   mov dword ptr [eax + 8], edx
0042efd4 85db                     test ebx, ebx
0042efd6 7515                     jne 0x42efed
0042efd8 8b5a10                   mov ebx, dword ptr [edx + 0x10]
0042efdb 85db                     test ebx, ebx
0042efdd 7403                     je 0x42efe2
0042efdf 89430c                   mov dword ptr [ebx + 0xc], eax
0042efe2 895810                   mov dword ptr [eax + 0x10], ebx
0042efe5 894210                   mov dword ptr [edx + 0x10], eax
0042efe8 ff4204                   inc dword ptr [edx + 4]
0042efeb 59                       pop ecx
0042efec c3                       ret 
0042efed 8b4b10                   mov ecx, dword ptr [ebx + 0x10]
0042eff0 894310                   mov dword ptr [ebx + 0x10], eax
0042eff3 89580c                   mov dword ptr [eax + 0xc], ebx
0042eff6 85c9                     test ecx, ecx
0042eff8 74ee                     je 0x42efe8
0042effa 89410c                   mov dword ptr [ecx + 0xc], eax
0042effd 894810                   mov dword ptr [eax + 0x10], ecx
0042f000 ff4204                   inc dword ptr [edx + 4]
0042f003 59                       pop ecx
0042f004 c3                       ret 
