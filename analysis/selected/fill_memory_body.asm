; Analyst label: fill_memory_body; export span 0x00537240..0x005372e3
; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.
00537240 09c9                     or ecx, ecx
00537242 742c                     je 0x537270
00537244 3810                     cmp byte ptr [eax], dl
00537246 a803                     test al, 3
00537248 7409                     je 0x537253
0053724a 8810                     mov byte ptr [eax], dl
0053724c 40                       inc eax
0053724d c1ca08                   ror edx, 8
00537250 49                       dec ecx
00537251 75f3                     jne 0x537246
00537253 51                       push ecx
00537254 c1e902                   shr ecx, 2
00537257 e81b000000               call 0x537277
0053725c 59                       pop ecx
0053725d 83e103                   and ecx, 3
00537260 740e                     je 0x537270
00537262 8810                     mov byte ptr [eax], dl
00537264 49                       dec ecx
00537265 7409                     je 0x537270
00537267 887001                   mov byte ptr [eax + 1], dh
0053726a 49                       dec ecx
0053726b 7403                     je 0x537270
0053726d 885002                   mov byte ptr [eax + 2], dl
00537270 c3                       ret 
00537271 90                       nop 
00537272 90                       nop 
00537273 90                       nop 
00537274 90                       nop 
00537275 90                       nop 
00537276 90                       nop 
00537277 09c9                     or ecx, ecx
00537279 7467                     je 0x5372e2
0053727b a81f                     test al, 0x1f
0053727d 7408                     je 0x537287
0053727f 8910                     mov dword ptr [eax], edx
00537281 8d4004                   lea eax, [eax + 4]
00537284 49                       dec ecx
00537285 75f4                     jne 0x53727b
00537287 51                       push ecx
00537288 c1e902                   shr ecx, 2
0053728b 743a                     je 0x5372c7
0053728d 49                       dec ecx
0053728e 7429                     je 0x5372b9
00537290 8910                     mov dword ptr [eax], edx
00537292 895004                   mov dword ptr [eax + 4], edx
00537295 49                       dec ecx
00537296 895008                   mov dword ptr [eax + 8], edx
00537299 89500c                   mov dword ptr [eax + 0xc], edx
0053729c 7418                     je 0x5372b6
0053729e 385020                   cmp byte ptr [eax + 0x20], dl
005372a1 895010                   mov dword ptr [eax + 0x10], edx
005372a4 895014                   mov dword ptr [eax + 0x14], edx
005372a7 49                       dec ecx
005372a8 895018                   mov dword ptr [eax + 0x18], edx
005372ab 89501c                   mov dword ptr [eax + 0x1c], edx
005372ae 8d4020                   lea eax, [eax + 0x20]
005372b1 75dd                     jne 0x537290
005372b3 8d40f0                   lea eax, [eax - 0x10]
005372b6 8d4010                   lea eax, [eax + 0x10]
005372b9 8910                     mov dword ptr [eax], edx
005372bb 895004                   mov dword ptr [eax + 4], edx
005372be 895008                   mov dword ptr [eax + 8], edx
005372c1 89500c                   mov dword ptr [eax + 0xc], edx
005372c4 8d4010                   lea eax, [eax + 0x10]
005372c7 59                       pop ecx
005372c8 83e103                   and ecx, 3
005372cb 7415                     je 0x5372e2
005372cd 8910                     mov dword ptr [eax], edx
005372cf 8d4004                   lea eax, [eax + 4]
005372d2 49                       dec ecx
005372d3 740d                     je 0x5372e2
005372d5 8910                     mov dword ptr [eax], edx
005372d7 8d4004                   lea eax, [eax + 4]
005372da 49                       dec ecx
005372db 7405                     je 0x5372e2
005372dd 8910                     mov dword ptr [eax], edx
005372df 8d4004                   lea eax, [eax + 4]
005372e2 c3                       ret 
