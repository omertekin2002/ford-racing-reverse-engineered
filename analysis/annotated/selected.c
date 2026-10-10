/* Analyst-labelled Ghidra pseudocode. Selected register signatures corrected; unresolved callees and inferred types still require review. */

/* 00409b80 fr3_load_directx_libraries */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */
/* Analyst-assigned name; not an original symbol. LoadLibraryA/GetProcAddress references to DirectX
   DLLs and entry points. Only selected signatures are corrected; unresolved callees retain the
   baseline Windows model. */

undefined8 __fastcall fr3_load_directx_libraries(undefined4 param_1,undefined4 param_2)

{
  HMODULE pHVar1;
  
  pHVar1 = LoadLibraryA(s_ddraw_dll_00546a8c);
  DAT_00589fe4 = pHVar1;
  if (pHVar1 != (HMODULE)0x0) {
    pHVar1 = LoadLibraryA(s_dinput8_dll_00546a98);
    DAT_00589fe8 = pHVar1;
    if (pHVar1 != (HMODULE)0x0) {
      pHVar1 = LoadLibraryA(s_d3d9_dll_00546aa4);
      DAT_00589fec = pHVar1;
      if (pHVar1 != (HMODULE)0x0) {
        pHVar1 = LoadLibraryA(s_dsound_dll_00546ab0);
        DAT_00589ff0 = pHVar1;
        if (pHVar1 != (HMODULE)0x0) {
          _DAT_00589ffc = GetProcAddress(DAT_00589fe4,s_DirectDrawCreateEx_00546abc);
          _DAT_0058a000 = GetProcAddress(DAT_00589fe4,s_DirectDrawEnumerateExA_00546ad0);
          DAT_0058a004 = GetProcAddress(DAT_00589fe8,s_DirectInput8Create_00546ae8);
          DAT_00589ff8 = GetProcAddress(DAT_00589fec,s_Direct3DCreate9_00546afc);
          _DAT_0058a008 = GetProcAddress(DAT_00589ff0,s_DirectSoundCreate8_00546b0c);
          return CONCAT44(param_2,1);
        }
      }
    }
  }
  return CONCAT44(param_2,pHVar1);
}



/* 0040ba30 fr3_load_compressed_resource */

/* Analyst-assigned name; not an original symbol. File-size prefix and inflate path; actual
   resources decode as length plus zlib stream. Only selected signatures are corrected; unresolved
   callees retain the baseline Windows model. */

undefined4 __fastcall fr3_load_compressed_resource(undefined4 param_1,undefined4 param_2)

{
  undefined4 uVar1;
  int iVar2;
  int iVar3;
  int extraout_ECX;
  undefined4 *extraout_ECX_00;
  undefined4 extraout_ECX_01;
  undefined4 uVar4;
  int iVar5;
  undefined4 *puVar6;
  undefined4 local_14;
  
  iVar2 = FUN_0042ff80();
  if (iVar2 != 0) {
    FUN_0040a580();
    FUN_0040a640(s_safe_compressed_mopen_Error___s__00546da4,param_2);
  }
  iVar2 = FUN_0040b8b0();
  if (iVar2 != 0) {
    FUN_00405df0();
    iVar5 = 0;
    uVar4 = 0;
    iVar2 = FUN_0040b8d0();
    local_14 = 0;
    FUN_0040bed0();
    if (0 < extraout_ECX) {
      do {
        iVar3 = thunk_FUN_00535550();
        uVar1 = DAT_005af2b0;
        if (iVar5 == 0) {
          local_14 = FUN_0040b6e0();
          puVar6 = (undefined4 *)&DAT_005af2b4;
          uVar4 = uVar1;
        }
        else {
          puVar6 = &DAT_005af2b0;
        }
        FUN_00405e40(puVar6);
        iVar5 = iVar5 + iVar3;
      } while (iVar5 < iVar2);
    }
    FUN_00405e40();
    FUN_00405ca0();
    if (extraout_ECX_00 != (undefined4 *)0x0) {
      extraout_ECX_00[2] = uVar4;
      extraout_ECX_00[1] = local_14;
      *extraout_ECX_00 = local_14;
    }
    FUN_0040c000();
    return local_14;
  }
  FUN_0040a580();
  FUN_0040a640(s_Unable_to_read_in_file__s_00546d88,extraout_ECX_01);
  return 0;
}



/* 00423b20 fr3_build_pcg_view */

/* Analyst-assigned name; not an original symbol. Object pointer in EAX; 16-byte entries and payload
   alignment mask 0xffffff80. Only selected signatures are corrected; unresolved callees retain the
   baseline Windows model. */

void __cdecl fr3_build_pcg_view(void *collection)

{
  undefined4 *puVar1;
  undefined4 uVar2;
  undefined4 *extraout_ECX;
  int extraout_ECX_00;
  undefined uVar3;
  undefined uVar4;
  undefined uVar5;
  undefined uVar6;
  
  puVar1 = *(undefined4 **)((int)collection + 0x20);
  *(undefined4 *)((int)collection + 4) = *puVar1;
  uVar4 = *(undefined *)(puVar1 + 2);
  uVar5 = *(undefined *)((int)puVar1 + 9);
  uVar6 = *(undefined *)((int)puVar1 + 10);
  uVar2 = puVar1[1];
  uVar3 = *(undefined *)((int)puVar1 + 0xb);
  FUN_0040a580(uVar3,uVar4,uVar5,uVar6);
  FUN_0040a4e0(s_Loaded_Graphic_Collection__s_cre_005489a0,*extraout_ECX,uVar6,uVar3,uVar5,uVar4,
               uVar2);
  *(int *)(extraout_ECX_00 + 0x24) = *(int *)(extraout_ECX_00 + 0x20) + 0x10;
  *(uint *)(extraout_ECX_00 + 0x28) =
       *(int *)(extraout_ECX_00 + 4) * 0x10 + *(int *)(extraout_ECX_00 + 0x20) + 0x8fU & 0xffffff80;
  return;
}



/* 0042e610 fr3_read_integer */

/* Analyst-assigned name; not an original symbol. Reader is supplied in EAX; return storage follows
   instruction usage (integer EAX or floating ST0). Only selected signatures are corrected;
   unresolved callees retain the baseline Windows model. */

int __cdecl fr3_read_integer(void *reader)

{
  uint uVar1;
  int iVar2;
  undefined4 *extraout_ECX;
  
                    /* WARNING: Load size is inaccurate */
  uVar1 = *reader;
  if (uVar1 != 0) {
    if (uVar1 < 2) {
      iVar2 = fr3_binary_read_integer(reader);
      return iVar2;
    }
    if (uVar1 != 2) {
      FUN_0040a580();
      FUN_0040a640(s_FILE_TAG__Invalid_Tag_File_Type___0054bb08,*extraout_ECX);
      return 0;
    }
  }
  iVar2 = fr3_ascii_read_integer(reader);
  return iVar2;
}



/* 0042e680 fr3_read_float */

/* Analyst-assigned name; not an original symbol. Reader is supplied in EAX; return storage follows
   instruction usage (integer EAX or floating ST0). Only selected signatures are corrected;
   unresolved callees retain the baseline Windows model. */

float __cdecl fr3_read_float(void *reader)

{
  uint uVar1;
  undefined4 *extraout_ECX;
  float fVar2;
  
                    /* WARNING: Load size is inaccurate */
  uVar1 = *reader;
  if (uVar1 != 0) {
    if (uVar1 < 2) {
      fVar2 = fr3_binary_read_float(reader);
      return fVar2;
    }
    if (uVar1 != 2) {
      FUN_0040a580();
      FUN_0040a640(s_FILE_TAG__Invalid_Tag_File_Type___0054bb08,*extraout_ECX);
      return 0.0;
    }
  }
  fVar2 = fr3_ascii_read_float(reader);
  return fVar2;
}



/* 0042d380 fr3_ascii_read_integer */

/* Analyst-assigned name; not an original symbol. Reader is supplied in EAX; return storage follows
   instruction usage (integer EAX or floating ST0). Only selected signatures are corrected;
   unresolved callees retain the baseline Windows model. */

int __cdecl fr3_ascii_read_integer(void *reader)

{
  int iVar1;
  int extraout_ECX;
  undefined local_118 [256];
  undefined local_18;
  
  FUN_0042cfc0();
  FUN_00534690();
  while( true ) {
    FUN_004019b0();
    iVar1 = FUN_0042d040();
    if (iVar1 != 0) break;
    local_118[extraout_ECX] = local_18;
    if (0x100 < extraout_ECX + 1U) {
      FUN_0040a580();
      FUN_0040a640(s_FILE_ASC__Get_Next_Int_Too_Long_0054b814);
    }
  }
  FUN_00401940();
  iVar1 = FUN_00535a80();
  return iVar1;
}



/* 0042d430 fr3_ascii_read_float */

/* WARNING: Removing unreachable block (ram,0x0042d52e) */
/* WARNING: Removing unreachable block (ram,0x0042d53c) */
/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */
/* Analyst-assigned name; not an original symbol. Reader is supplied in EAX; return storage follows
   instruction usage (integer EAX or floating ST0). Only selected signatures are corrected;
   unresolved callees retain the baseline Windows model. */

float __cdecl fr3_ascii_read_float(void *reader)

{
  int iVar1;
  int iVar2;
  double local_2c;
  byte local_24;
  
  FUN_0042cfc0();
  iVar2 = 1;
  do {
    FUN_004019b0();
    if (((&DAT_00597a6d)[local_24] & 0x20) != 0) break;
  } while (local_24 != 0x2d);
  if (local_24 == 0x2d) {
    iVar2 = -1;
    FUN_004019b0();
  }
  local_2c = 0.0;
  while (iVar1 = FUN_0042d040(), iVar1 == 0) {
    local_2c = (double)(local_24 - 0x30) + local_2c * _DAT_0054b864;
    FUN_004019b0();
  }
  if (local_24 == 0x2e) {
    iVar1 = FUN_004019b0();
    if (iVar1 == 0) {
      FUN_0040a580();
      FUN_0040a640(s_FILE_ASC__Unfinished_String__Mis_0054b834);
    }
    iVar1 = FUN_0042d040();
    if (iVar1 == 0) goto LAB_0042d58b;
  }
  FUN_00401940();
LAB_0042d58b:
  return (float)iVar2 * (float)local_2c;
}



/* 0042db90 fr3_binary_read_integer */

/* Analyst-assigned name; not an original symbol. Reader is supplied in EAX; return storage follows
   instruction usage (integer EAX or floating ST0). Only selected signatures are corrected;
   unresolved callees retain the baseline Windows model. */

int __cdecl fr3_binary_read_integer(void *reader)

{
  int iVar1;
  
  iVar1 = FUN_0042dde0();
  if (iVar1 == 0) {
    return -1;
  }
  iVar1 = FUN_00535a80();
  return iVar1;
}



/* 0042dbd0 fr3_binary_read_float */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */
/* Analyst-assigned name; not an original symbol. Reader is supplied in EAX; return storage follows
   instruction usage (integer EAX or floating ST0). Only selected signatures are corrected;
   unresolved callees retain the baseline Windows model. */

float __cdecl fr3_binary_read_float(void *reader)

{
  byte bVar1;
  bool bVar2;
  bool bVar3;
  int iVar4;
  uint uVar5;
  uint uVar6;
  byte *pbVar7;
  byte local_134 [268];
  float local_28;
  float local_24;
  float local_20;
  int local_1c;
  
  iVar4 = FUN_0042dde0();
  if (iVar4 == 0) {
    return 0.0;
  }
  uVar5 = 0xffffffff;
  pbVar7 = local_134;
  do {
    if (uVar5 == 0) break;
    uVar5 = uVar5 - 1;
    bVar1 = *pbVar7;
    pbVar7 = pbVar7 + 1;
  } while (bVar1 != 0);
  bVar2 = false;
  local_24 = 1.0;
  bVar3 = false;
  uVar6 = 0;
  local_20 = 0.0;
  local_28 = 0.0;
  if (~uVar5 != 1) {
    do {
      bVar1 = local_134[uVar6];
      if (bVar1 == 0x2d) {
        bVar2 = true;
      }
      else if (bVar1 == 0x2e) {
        bVar3 = true;
      }
      else if (bVar3) {
        local_24 = local_24 * _DAT_0054b940;
        local_1c = bVar1 - 0x30;
        local_28 = local_28 + (float)(bVar1 - 0x30) / local_24;
      }
      else {
        local_1c = bVar1 - 0x30;
        local_20 = (float)(bVar1 - 0x30) + local_20 * _DAT_0054b940;
      }
      uVar6 = uVar6 + 1;
    } while (uVar6 < ~uVar5 - 1);
  }
  if (bVar2) {
    return -(local_20 + local_28);
  }
  return local_20 + local_28;
}



/* 0042e530 fr3_next_tag */

/* Analyst-assigned name; not an original symbol. Reader dispatch, application tag table, parser
   mode in EDX. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

int __cdecl fr3_next_tag(void *reader,int mode)

{
  uint uVar1;
  int iVar2;
  undefined4 *extraout_ECX;
  
                    /* WARNING: Load size is inaccurate */
  uVar1 = *reader;
  if (uVar1 != 0) {
    if (uVar1 < 2) {
      iVar2 = FUN_0042da50();
      return iVar2;
    }
    if (uVar1 != 2) {
      FUN_0040a580();
      FUN_0040a640(s_FILE_TAG__Invalid_Tag_File_Type___0054bb08,*extraout_ECX);
      return -1;
    }
  }
  iVar2 = FUN_0042d0a0();
  return iVar2;
}



/* 0042e7c0 fr3_read_string */

/* Analyst-assigned name; not an original symbol. Caller supplies EAX reader, EDX destination, EBX
   byte limit. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

undefined4 __cdecl fr3_read_string(void *reader,void *destination,int limit)

{
  uint uVar1;
  undefined4 uVar2;
  undefined4 *extraout_ECX;
  
                    /* WARNING: Load size is inaccurate */
  uVar1 = *reader;
  if (uVar1 != 0) {
    if (uVar1 < 2) {
      uVar2 = FUN_0042dd50();
      return uVar2;
    }
    if (uVar1 != 2) {
      FUN_0040a580();
      FUN_0040a640(s_FILE_TAG__Invalid_Tag_File_Type___0054bb08,*extraout_ECX);
      return 0;
    }
  }
  uVar2 = FUN_0042d7b0();
  return uVar2;
}



/* 0042e820 fr3_read_enum */

/* Analyst-assigned name; not an original symbol. Caller supplies EAX reader, EDX enum table, EBX
   entry count. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

int __cdecl fr3_read_enum(void *reader,void *table,int count)

{
  uint uVar1;
  int iVar2;
  undefined4 *extraout_ECX;
  
                    /* WARNING: Load size is inaccurate */
  uVar1 = *reader;
  if (uVar1 != 0) {
    if (uVar1 < 2) {
      iVar2 = FUN_0042dd60();
      return iVar2;
    }
    if (uVar1 != 2) {
      FUN_0040a580();
      FUN_0040a640(s_FILE_TAG__Invalid_Tag_File_Type___0054bb08,*extraout_ECX);
      return 0;
    }
  }
  iVar2 = FUN_0042d950();
  return iVar2;
}



/* 005227f0 fr3_load_engine_database */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */
/* Analyst-assigned name; not an original symbol. Tag branches, 0xb0-byte payload, field stores and
   ENGDATA filename context. Only selected signatures are corrected; unresolved callees retain the
   baseline Windows model. */

void __cdecl fr3_load_engine_database(void)

{
  void *reader;
  int iVar1;
  void *source;
  undefined4 extraout_ECX;
  int extraout_ECX_00;
  undefined4 extraout_ECX_01;
  int extraout_EDX;
  void *destination;
  float10 fVar2;
  float10 extraout_ST1;
  float fVar3;
  undefined local_44 [20];
  float local_30;
  int local_2c;
  float local_28;
  float local_24;
  int local_20;
  float local_1c;
  
  DAT_00597418 = FUN_0042ed50(0,0,0);
  local_20 = 0;
  destination = (void *)0x0;
  reader = (void *)FUN_004f8fb0(0x16b);
  if (reader == (void *)0x0) {
    return;
  }
LAB_00522848:
  iVar1 = fr3_next_tag(reader,2);
  if (iVar1 < 0xab) {
    if (iVar1 < 0x7f) {
      if (iVar1 < 1) {
        if (-0xf < iVar1) {
          if (iVar1 < -0xd) {
            iVar1 = FUN_0042eed0();
            FUN_0042efd0();
            destination = (void *)(iVar1 + 0x20);
            fr3_read_string(reader,destination,0x14);
            local_20 = local_20 + 1;
            goto LAB_00522848;
          }
          if (iVar1 == -0xb) {
            FUN_004f8fd0();
            FUN_0042f0c0();
            return;
          }
        }
      }
      else {
        if (iVar1 < 2) {
          fVar3 = fr3_read_float(reader);
          *(float *)((int)destination + 0x90) = fVar3;
          goto LAB_00522848;
        }
        if (0xf < iVar1) {
          if (iVar1 < 0x11) {
            iVar1 = fr3_read_enum(reader,&PTR_s_NORMAL_005973f8,3);
            *(int *)((int)destination + 0x98) = iVar1;
            goto LAB_00522848;
          }
          if (iVar1 == 0x37) {
            fVar3 = fr3_read_float(reader);
            *(float *)((int)destination + 0x34) = fVar3;
            goto LAB_00522848;
          }
        }
      }
    }
    else {
      if (iVar1 < 0x80) {
        fVar3 = fr3_read_float(reader);
        *(float *)((int)destination + 0x20) = fVar3;
        goto LAB_00522848;
      }
      if (iVar1 < 0x8a) {
        if (0x86 < iVar1) {
          if (iVar1 < 0x88) {
            fVar3 = fr3_read_float(reader);
            *(float *)((int)destination + 0x88) = fVar3;
            goto LAB_00522848;
          }
          if (iVar1 == 0x88) {
            fVar3 = fr3_read_float(reader);
            *(float *)((int)destination + 0x8c) = fVar3;
            goto LAB_00522848;
          }
        }
      }
      else {
        if (iVar1 < 0x8b) {
          fVar3 = fr3_read_float(reader);
          *(float *)((int)destination + 0x1c) = fVar3;
          goto LAB_00522848;
        }
        if (0x9b < iVar1) {
          if (iVar1 < 0x9d) {
            fr3_read_string(reader,local_44,0x14);
            source = (void *)FUN_00522d70();
            fr3_copy_engine_record(destination,source);
            *(undefined4 *)((int)destination + 0x18) = extraout_ECX_01;
            goto LAB_00522848;
          }
          if (iVar1 == 0xa5) {
            iVar1 = fr3_read_enum(reader,&PTR_s_FRONT_00597408,3);
            *(char *)((int)destination + 0x14) = (char)iVar1;
            goto LAB_00522848;
          }
        }
      }
    }
  }
  else {
    if (iVar1 < 0xac) {
      fVar3 = fr3_read_float(reader);
      *(float *)((int)destination + 0x9c) = fVar3;
      goto LAB_00522848;
    }
    if (iVar1 < 200) {
      if (iVar1 < 0xb0) {
        if (0xac < iVar1) {
          if (iVar1 < 0xae) {
            fVar3 = fr3_read_float(reader);
            *(float *)((int)destination + 0xac) = fVar3;
          }
          else {
            if (iVar1 != 0xae) goto LAB_00522878;
            fVar3 = fr3_read_float(reader);
            *(float *)((int)destination + 0xa8) = fVar3;
          }
          goto LAB_00522848;
        }
      }
      else {
        if (iVar1 < 0xb1) {
          fVar3 = fr3_read_float(reader);
          *(float *)((int)destination + 0x30) = fVar3;
          goto LAB_00522848;
        }
        if (iVar1 < 0xb2) {
          fVar3 = fr3_read_float(reader);
          *(float *)((int)destination + 0x84) = fVar3;
          goto LAB_00522848;
        }
        if (iVar1 == 0xc6) {
          iVar1 = fr3_read_integer(reader);
          *(char *)((int)destination + 0x95) = (char)iVar1;
          goto LAB_00522848;
        }
      }
    }
    else {
      if (iVar1 < 0xc9) {
        iVar1 = fr3_read_integer(reader);
        *(char *)((int)destination + 0x94) = (char)iVar1;
        goto LAB_00522848;
      }
      if (iVar1 < 0x118) {
        if (0xe3 < iVar1) {
          if (iVar1 < 0xe5) {
            fVar3 = fr3_read_float(reader);
            *(float *)((int)destination + 0x28) = fVar3;
            goto LAB_00522848;
          }
          if (iVar1 == 0x112) {
            fVar3 = fr3_read_float(reader);
            *(float *)((int)destination + 0x38) = fVar3;
            goto LAB_00522848;
          }
        }
      }
      else {
        if (iVar1 < 0x119) {
          FUN_00534690();
          fVar2 = (float10)FUN_005352fa();
          iVar1 = (int)ROUND(fVar2) + 1;
          local_2c = iVar1;
          if (0 < iVar1) {
            do {
              local_30 = fr3_read_float(reader);
              fVar3 = fr3_read_float(reader);
              *(float *)(extraout_EDX + 0x38) = fVar3;
            } while (extraout_ECX_00 < iVar1);
          }
          local_28 = 0.0;
          local_1c = 0.0;
          if (0.0 < *(float *)((int)destination + 0x30)) {
            do {
              fVar2 = (float10)FUN_005352fa();
              local_30 = (float)(int)ROUND(fVar2);
              local_24 = (float)(extraout_ST1 *
                                 (float10)*(float *)((int)destination + (int)local_30 * 4 + 0x3c) *
                                (float10)_DAT_00581d14);
              if (local_28 < local_24) {
                *(float *)((int)destination + 0x2c) = local_1c;
                local_28 = local_24;
              }
              local_1c = local_1c + _DAT_00581d1c;
            } while (local_1c < *(float *)((int)destination + 0x30));
          }
          if (ABS(*(float *)((int)destination + 0x2c) - *(float *)((int)destination + 0x30)) <
              _DAT_00581d20) {
            *(float *)((int)destination + 0x2c) =
                 *(float *)((int)destination + 0x30) + _DAT_00581d24;
          }
          goto LAB_00522848;
        }
        if (iVar1 < 0x11a) {
          fVar3 = fr3_read_float(reader);
          *(float *)((int)destination + 0x24) = fVar3;
          goto LAB_00522848;
        }
        if (iVar1 == 0x15b) {
          fVar3 = fr3_read_float(reader);
          *(float *)((int)destination + 0xa0) = fVar3;
          if ((*(uint *)((int)destination + 0xa0) & 0x7fffffff) == 0) {
            *(undefined4 *)((int)destination + 0xa4) = 0x3f800000;
          }
          else {
            *(float *)((int)destination + 0xa4) = 1.0 / *(float *)((int)destination + 0xa0);
          }
          goto LAB_00522848;
        }
      }
    }
  }
LAB_00522878:
  FUN_0040a580();
  FUN_0040a640(s_DB_ENGINE__unknown_data_file_tag_00581cec,extraout_ECX);
  goto LAB_00522848;
}



/* 00523220 fr3_load_gearbox_database */

/* Analyst-assigned name; not an original symbol. Tag branches, 0x34-byte payload and GEARDATA
   filename context. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

void __cdecl fr3_load_gearbox_database(void)

{
  void *reader;
  int iVar1;
  void *source;
  undefined4 extraout_ECX;
  void *destination;
  float10 fVar2;
  float fVar3;
  undefined local_34 [20];
  int local_20;
  int local_1c;
  
  DAT_00597474 = FUN_0042ed50(0,0,0);
  local_20 = 0;
  destination = (void *)0x0;
  reader = (void *)FUN_004f8fb0(0x16b);
  if (*(int *)((int)reader + 4) == 0) {
    return;
  }
LAB_0052327b:
  iVar1 = fr3_next_tag(reader,2);
  if (iVar1 < 0x5f) {
    if (iVar1 < 0xe) {
      if (-0xf < iVar1) {
        if (iVar1 < -0xd) {
          iVar1 = FUN_0042eed0();
          FUN_0042efd0();
          destination = (void *)(iVar1 + 0x20);
          fr3_read_string(reader,destination,0x14);
          local_20 = local_20 + 1;
          goto LAB_0052327b;
        }
        if (iVar1 == -0xb) {
          FUN_004f8fd0();
          FUN_0042f0c0();
          return;
        }
      }
    }
    else {
      if (iVar1 < 0xf) {
        fr3_read_float(reader);
        fVar2 = (float10)FUN_005352fa();
        local_1c = (int)ROUND(fVar2);
        *(undefined *)((int)destination + 0x31) = (undefined)local_1c;
        goto LAB_0052327b;
      }
      if (iVar1 < 0x10) {
        fr3_read_float(reader);
        fVar2 = (float10)FUN_005352fa();
        local_1c = (int)ROUND(fVar2);
        *(undefined *)((int)destination + 0x30) = (undefined)local_1c;
        goto LAB_0052327b;
      }
      if (iVar1 == 0x5e) {
        fVar3 = fr3_read_float(reader);
        *(float *)((int)destination + 0x18) = fVar3;
        goto LAB_0052327b;
      }
    }
  }
  else {
    if (iVar1 < 0x60) {
      fVar3 = fr3_read_float(reader);
      *(float *)((int)destination + 0x14) = fVar3;
      goto LAB_0052327b;
    }
    if (iVar1 < 0x77) {
      if (iVar1 < 0x6d) goto LAB_005232a0;
      if (iVar1 < 0x6e) {
        iVar1 = fr3_read_enum(reader,&PTR_DAT_00597460,4);
        *(int *)((int)destination + 0x28) = iVar1;
        goto LAB_0052327b;
      }
      if (iVar1 == 0x76) {
        fVar3 = fr3_read_float(reader);
        *(float *)((int)destination + 0x20) = fVar3;
        goto LAB_0052327b;
      }
    }
    else {
      if (iVar1 < 0x78) {
        iVar1 = fr3_read_enum(reader,&PTR_DAT_0059744c,4);
        *(int *)((int)destination + 0x2c) = iVar1;
        goto LAB_0052327b;
      }
      if (iVar1 < 0x11a) {
        if (iVar1 == 0x9c) {
          fr3_read_string(reader,local_34,0x14);
          source = (void *)FUN_005234b0();
          fr3_copy_gearbox_record(destination,source);
          goto LAB_0052327b;
        }
      }
      else {
        if (iVar1 < 0x11b) {
          fVar3 = fr3_read_float(reader);
          *(float *)((int)destination + 0x1c) = fVar3;
          goto LAB_0052327b;
        }
        if (iVar1 == 0x159) {
          iVar1 = fr3_read_enum(reader,&PTR_DAT_0059743c,4);
          *(int *)((int)destination + 0x24) = iVar1;
          goto LAB_0052327b;
        }
      }
    }
  }
LAB_005232a0:
  FUN_0040a580();
  FUN_0040a640(s_DB_GEARBOX__unknown_data_file_ta_00581f30,extraout_ECX);
  goto LAB_0052327b;
}



/* 00523820 fr3_load_tyre_database */

/* WARNING: Globals starting with '_' overlap smaller symbols at the same address */
/* Analyst-assigned name; not an original symbol. Tag branches, 0x58-byte payload and TYREDATA
   filename context. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

void __cdecl fr3_load_tyre_database(void)

{
  int iVar1;
  void *source;
  int extraout_ECX;
  undefined4 extraout_ECX_00;
  undefined4 extraout_ECX_01;
  int extraout_ECX_02;
  int iVar2;
  undefined4 extraout_ECX_03;
  int extraout_ECX_04;
  int extraout_ECX_05;
  int extraout_ECX_06;
  int extraout_ECX_07;
  int extraout_ECX_08;
  int extraout_EDX;
  int extraout_EDX_00;
  int extraout_EDX_01;
  int extraout_EDX_02;
  int extraout_EDX_03;
  int iVar3;
  undefined4 *puVar4;
  undefined4 *puVar5;
  float fVar6;
  float fVar7;
  undefined4 uVar8;
  undefined local_40 [20];
  int local_2c;
  int local_28;
  int local_24;
  void *local_20;
  void *local_1c;
  
  DAT_0059747c = FUN_0042ed50(0,0,0);
  uVar8 = 0x16b;
  local_24 = 0;
  local_1c = (void *)0x0;
  FUN_004f8f80(0x16b);
  local_20 = (void *)FUN_0042e920(uVar8);
  if (*(int *)((int)local_20 + 4) == 0) {
    return;
  }
LAB_00523882:
  iVar1 = fr3_next_tag(local_20,2);
  iVar3 = local_24;
  if (iVar1 < 0xd5) {
    if (iVar1 < 0x9c) {
      if (iVar1 < -0xb) {
        if (iVar1 == -0xe) {
          FUN_0042eed0();
          FUN_0042efd0();
          local_1c = (void *)(extraout_ECX + 0x20);
          local_24 = iVar3 + 1;
          fr3_read_string(local_20,local_1c,0x14);
          goto LAB_00523882;
        }
      }
      else {
        if (iVar1 < -10) {
          FUN_004f8f80();
          FUN_0042ea40();
          FUN_0042f0c0();
          return;
        }
        if (iVar1 == 0x1e) {
          FUN_004f8f80();
          uVar8 = FUN_0040b6e0();
          *(undefined4 *)((int)local_1c + 0x50) = uVar8;
          FUN_00534690();
          local_24 = 0;
          do {
            fr3_read_integer(local_20);
            iVar3 = local_24;
            fVar7 = fr3_read_float(local_20);
            local_24 = iVar3 + 1;
            *(float *)(*(int *)((int)local_1c + 0x50) + extraout_EDX_02 * 4) = fVar7;
          } while (local_24 < 10);
          goto LAB_00523882;
        }
      }
    }
    else {
      if (iVar1 < 0x9d) {
        fr3_read_string(local_20,local_40,0x14);
        source = (void *)FUN_005240e0();
        fr3_copy_tyre_scalar_fields(local_1c,source);
        *(undefined4 *)((int)local_1c + 0x14) = extraout_ECX_03;
        goto LAB_00523882;
      }
      if (iVar1 < 0xa6) {
        if (iVar1 == 0xa3) {
          FUN_004f8f80();
          uVar8 = FUN_0040b6e0();
          *(undefined4 *)((int)local_1c + 0x48) = uVar8;
          FUN_00534690();
          local_24 = 0;
          do {
            do {
              fVar7 = fr3_read_float(local_20);
              *(float *)(extraout_EDX_00 + *(int *)((int)local_1c + 0x48)) = fVar7;
            } while (extraout_EDX_00 + 4 != extraout_ECX_04);
            local_24 = local_24 + 1;
          } while (local_24 < 10);
          goto LAB_00523882;
        }
      }
      else {
        if (iVar1 < 0xa7) {
          local_24 = 0;
          FUN_004f8f80();
          uVar8 = FUN_0040b6e0();
          *(undefined4 *)((int)local_1c + 0x44) = uVar8;
          FUN_00534690();
          iVar3 = extraout_ECX_05 * 0x2c;
          do {
            fVar7 = fr3_read_float(local_20);
            *(float *)(iVar3 + *(int *)((int)local_1c + 0x44)) = fVar7;
            do {
              DAT_00597488 = fr3_read_float(local_20);
              *(float *)(extraout_ECX_06 + *(int *)((int)local_1c + 0x44)) = DAT_00597488;
            } while (extraout_ECX_06 + 4 != extraout_EDX_01);
            iVar3 = iVar3 + 0x2c;
            local_24 = local_24 + 1;
          } while (iVar3 < 0x18c);
          goto LAB_00523882;
        }
        if (0xa7 < iVar1) {
          if (iVar1 < 0xa9) {
            fVar7 = fr3_read_float(local_20);
            *(float *)((int)local_1c + 0x34) = fVar7;
            *(float *)((int)local_1c + 0x38) = 1.0 / fVar7;
            goto LAB_00523882;
          }
          if (iVar1 == 0xcc) {
            fVar6 = fr3_read_float(local_20);
            fVar7 = _DAT_00597484;
            *(float *)((int)local_1c + 0x1c) = fVar6;
            *(float *)((int)local_1c + 0x1c) = fVar7 * *(float *)((int)local_1c + 0x1c);
            goto LAB_00523882;
          }
        }
      }
    }
  }
  else {
    if (iVar1 < 0xd6) {
      fVar7 = fr3_read_float(local_20);
      *(float *)((int)local_1c + 0x28) = fVar7;
      *(float *)((int)local_1c + 0x3c) = 1.0 / fVar7;
      goto LAB_00523882;
    }
    if (iVar1 < 0x15c) {
      if (iVar1 < 0xe3) {
        if (iVar1 != 0xde) goto LAB_005239ea;
        fVar6 = fr3_read_float(local_20);
        fVar7 = _DAT_00597484;
        *(float *)((int)local_1c + 0x18) = fVar6;
        *(float *)((int)local_1c + 0x18) = fVar7 * *(float *)((int)local_1c + 0x18);
        goto LAB_00523882;
      }
      if (iVar1 < 0xe4) {
        fVar7 = fr3_read_float(local_20);
        *(float *)((int)local_1c + 0x40) = fVar7;
        goto LAB_00523882;
      }
      if (iVar1 == 0xf0) {
        if (*(int *)((int)local_1c + 0x54) == 0) {
          FUN_004f8f80();
          FUN_0040b6e0();
          FUN_00534690();
          *(undefined4 *)((int)local_1c + 0x54) = extraout_ECX_01;
        }
        fr3_next_tag(local_20,2);
        iVar3 = fr3_read_enum(local_20,&PTR_s_TYRE_SAMPLE_TYPE_INVALID_00593af4,0xf);
        local_28 = iVar3;
        iVar1 = fr3_next_tag(local_20,2);
        if (iVar1 == -0x11) {
          local_2c = fr3_read_integer(local_20);
          if (0 < local_2c) {
            do {
              fr3_read_integer(local_20);
              fVar7 = fr3_read_float(local_20);
              *(float *)(*(int *)((int)local_1c + 0x54) + extraout_ECX_07 + 0x78 +
                        extraout_ECX_08 * 4) = fVar7;
            } while (extraout_EDX_03 + 1 < local_2c);
          }
          fr3_next_tag(local_20,2);
          fVar7 = fr3_read_float(local_20);
          *(float *)(*(int *)((int)local_1c + 0x54) + 0x3c + iVar3 * 4) = fVar7;
        }
        else {
          iVar3 = fr3_read_enum(local_20,&PTR_s_TYRE_SAMPLE_TYPE_INVALID_00593af4,0xf);
          iVar1 = *(int *)((int)local_1c + 0x54) + 0x78;
          puVar4 = (undefined4 *)(iVar3 * 0x28 + iVar1);
          puVar5 = (undefined4 *)(iVar1 + extraout_ECX_02);
          for (iVar2 = 10; iVar2 != 0; iVar2 = iVar2 + -1) {
            *puVar5 = *puVar4;
            puVar4 = puVar4 + 1;
            puVar5 = puVar5 + 1;
          }
          for (iVar1 = 0; iVar1 != 0; iVar1 = iVar1 + -1) {
            *(undefined *)puVar5 = *(undefined *)puVar4;
            puVar4 = (undefined4 *)((int)puVar4 + 1);
            puVar5 = (undefined4 *)((int)puVar5 + 1);
          }
          *(undefined4 *)(*(int *)((int)local_1c + 0x54) + 0x3c + local_28 * 4) =
               *(undefined4 *)(*(int *)((int)local_1c + 0x54) + 0x3c + iVar3 * 4);
        }
        goto LAB_00523882;
      }
    }
    else {
      if (iVar1 < 0x15d) {
        fVar7 = fr3_read_float(local_20);
        *(float *)((int)local_1c + 0x24) = fVar7;
        goto LAB_00523882;
      }
      if (iVar1 < 0x162) {
        if (iVar1 == 0x15d) {
          fVar7 = fr3_read_float(local_20);
          *(float *)((int)local_1c + 0x2c) = fVar7;
          goto LAB_00523882;
        }
      }
      else {
        if (iVar1 < 0x163) {
          FUN_004f8f80();
          uVar8 = FUN_0040b6e0();
          *(undefined4 *)((int)local_1c + 0x4c) = uVar8;
          local_24 = 0;
          FUN_00534690();
          do {
            fr3_read_integer(local_20);
            iVar3 = local_24;
            fVar7 = fr3_read_float(local_20);
            local_24 = iVar3 + 1;
            *(float *)(*(int *)((int)local_1c + 0x4c) + extraout_EDX * 4) = fVar7;
          } while (local_24 < 10);
          goto LAB_00523882;
        }
        if (0x163 < iVar1) {
          if (iVar1 < 0x165) {
            fVar7 = fr3_read_float(local_20);
            *(float *)((int)local_1c + 0x20) = fVar7;
            goto LAB_00523882;
          }
          if (iVar1 == 0x16a) {
            fVar7 = fr3_read_float(local_20);
            *(float *)((int)local_1c + 0x30) = fVar7;
            goto LAB_00523882;
          }
        }
      }
    }
  }
LAB_005239ea:
  FUN_0040a580();
  FUN_0040a640(s_DB_TYRE__unknown_data_file_tag___0058201c,extraout_ECX_00);
  goto LAB_00523882;
}



/* 00522c80 fr3_copy_engine_record */

/* Analyst-assigned name; not an original symbol. Field-wise stores from EDX source to EAX
   destination. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

void __cdecl fr3_copy_engine_record(void *destination,void *source)

{
  int iVar1;
  undefined4 *puVar2;
  undefined4 *puVar3;
  
  *(undefined *)((int)destination + 0x14) = *(undefined *)((int)source + 0x14);
  *(undefined4 *)((int)destination + 0x1c) = *(undefined4 *)((int)source + 0x1c);
  *(undefined4 *)((int)destination + 0x20) = *(undefined4 *)((int)source + 0x20);
  *(undefined4 *)((int)destination + 0x24) = *(undefined4 *)((int)source + 0x24);
  *(undefined4 *)((int)destination + 0x28) = *(undefined4 *)((int)source + 0x28);
  *(undefined4 *)((int)destination + 0x2c) = *(undefined4 *)((int)source + 0x2c);
  *(undefined4 *)((int)destination + 0x30) = *(undefined4 *)((int)source + 0x30);
  *(undefined4 *)((int)destination + 0x34) = *(undefined4 *)((int)source + 0x34);
  *(undefined4 *)((int)destination + 0x38) = *(undefined4 *)((int)source + 0x38);
  puVar2 = (undefined4 *)((int)source + 0x3c);
  puVar3 = (undefined4 *)((int)destination + 0x3c);
  for (iVar1 = 0x12; iVar1 != 0; iVar1 = iVar1 + -1) {
    *puVar3 = *puVar2;
    puVar2 = puVar2 + 1;
    puVar3 = puVar3 + 1;
  }
  for (iVar1 = 0; iVar1 != 0; iVar1 = iVar1 + -1) {
    *(undefined *)puVar3 = *(undefined *)puVar2;
    puVar2 = (undefined4 *)((int)puVar2 + 1);
    puVar3 = (undefined4 *)((int)puVar3 + 1);
  }
  *(undefined4 *)((int)destination + 0x84) = *(undefined4 *)((int)source + 0x84);
  *(undefined4 *)((int)destination + 0x88) = *(undefined4 *)((int)source + 0x88);
  *(undefined4 *)((int)destination + 0x8c) = *(undefined4 *)((int)source + 0x8c);
  *(undefined4 *)((int)destination + 0x90) = *(undefined4 *)((int)source + 0x90);
  *(undefined *)((int)destination + 0x94) = *(undefined *)((int)source + 0x94);
  *(undefined *)((int)destination + 0x95) = *(undefined *)((int)source + 0x95);
  *(undefined4 *)((int)destination + 0x98) = *(undefined4 *)((int)source + 0x98);
  *(undefined4 *)((int)destination + 0x9c) = *(undefined4 *)((int)source + 0x9c);
  *(undefined4 *)((int)destination + 0xa0) = *(undefined4 *)((int)source + 0xa0);
  *(undefined4 *)((int)destination + 0xa4) = *(undefined4 *)((int)source + 0xa4);
  *(undefined4 *)((int)destination + 0xa8) = *(undefined4 *)((int)source + 0xa8);
  *(undefined4 *)((int)destination + 0xac) = *(undefined4 *)((int)source + 0xac);
  return;
}



/* 00523470 fr3_copy_gearbox_record */

/* Analyst-assigned name; not an original symbol. Field-wise stores from EDX source to EAX
   destination. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

void __cdecl fr3_copy_gearbox_record(void *destination,void *source)

{
  *(undefined4 *)((int)destination + 0x1c) = *(undefined4 *)((int)source + 0x1c);
  *(undefined4 *)((int)destination + 0x14) = *(undefined4 *)((int)source + 0x14);
  *(undefined4 *)((int)destination + 0x18) = *(undefined4 *)((int)source + 0x18);
  *(undefined4 *)((int)destination + 0x20) = *(undefined4 *)((int)source + 0x20);
  *(undefined4 *)((int)destination + 0x24) = *(undefined4 *)((int)source + 0x24);
  *(undefined4 *)((int)destination + 0x28) = *(undefined4 *)((int)source + 0x28);
  *(undefined4 *)((int)destination + 0x2c) = *(undefined4 *)((int)source + 0x2c);
  *(undefined *)((int)destination + 0x30) = *(undefined *)((int)source + 0x30);
  *(undefined *)((int)destination + 0x31) = *(undefined *)((int)source + 0x31);
  return;
}



/* 00524090 fr3_copy_tyre_scalar_fields */

/* Analyst-assigned name; not an original symbol. Field-wise stores from EDX source to EAX
   destination. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

void __cdecl fr3_copy_tyre_scalar_fields(void *destination,void *source)

{
  *(undefined4 *)((int)destination + 0x24) = *(undefined4 *)((int)source + 0x24);
  *(undefined4 *)((int)destination + 0x2c) = *(undefined4 *)((int)source + 0x2c);
  *(undefined4 *)((int)destination + 0x28) = *(undefined4 *)((int)source + 0x28);
  *(undefined4 *)((int)destination + 0x30) = *(undefined4 *)((int)source + 0x30);
  *(undefined4 *)((int)destination + 0x34) = *(undefined4 *)((int)source + 0x34);
  *(undefined4 *)((int)destination + 0x18) = *(undefined4 *)((int)source + 0x18);
  *(undefined4 *)((int)destination + 0x20) = *(undefined4 *)((int)source + 0x20);
  *(undefined4 *)((int)destination + 0x1c) = *(undefined4 *)((int)source + 0x1c);
  *(undefined4 *)((int)destination + 0x40) = *(undefined4 *)((int)source + 0x40);
  *(undefined4 *)((int)destination + 0x3c) = *(undefined4 *)((int)source + 0x3c);
  *(undefined4 *)((int)destination + 0x38) = *(undefined4 *)((int)source + 0x38);
  return;
}



/* 00523dc0 fr3_free_tyre_tables */

/* Analyst-assigned name; not an original symbol. Checks/frees the five table pointers at +0x44
   through +0x54; record in EAX. Only selected signatures are corrected; unresolved callees retain
   the baseline Windows model. */

void __cdecl fr3_free_tyre_tables(void *record)

{
  void *extraout_ECX;
  void *extraout_ECX_00;
  void *extraout_ECX_01;
  void *extraout_ECX_02;
  
  if (*(int *)((int)record + 0x44) != 0) {
    FUN_004f8f80();
    FUN_0040b7a0();
    record = extraout_ECX_02;
  }
  if (*(int *)((int)record + 0x48) != 0) {
    FUN_004f8f80();
    FUN_0040b7a0();
    record = extraout_ECX;
  }
  if (*(int *)((int)record + 0x4c) != 0) {
    FUN_004f8f80();
    FUN_0040b7a0();
    record = extraout_ECX_00;
  }
  if (*(int *)((int)record + 0x50) != 0) {
    FUN_004f8f80();
    FUN_0040b7a0();
    record = extraout_ECX_01;
  }
  if (*(int *)((int)record + 0x54) == 0) {
    return;
  }
  FUN_004f8f80();
  FUN_0040b7a0();
  return;
}



/* 00523e50 fr3_get_tyre_vertical_load */

/* Analyst-assigned name; not an original symbol. Returns local table or follows inherited address
   at +0x14; EAX input and result. Only selected signatures are corrected; unresolved callees retain
   the baseline Windows model. */

void * __cdecl fr3_get_tyre_vertical_load(void *record)

{
  if (*(void **)((int)record + 0x4c) == (void *)0x0) {
    for (; *(void **)((int)record + 0x4c) == (void *)0x0; record = *(void **)((int)record + 0x14)) {
    }
    return *(void **)((int)record + 0x4c);
  }
  return *(void **)((int)record + 0x4c);
}



/* 00523e70 fr3_get_tyre_camber_thrust */

/* Analyst-assigned name; not an original symbol. Returns local table or follows inherited address
   at +0x14; EAX input and result. Only selected signatures are corrected; unresolved callees retain
   the baseline Windows model. */

void * __cdecl fr3_get_tyre_camber_thrust(void *record)

{
  if (*(void **)((int)record + 0x50) == (void *)0x0) {
    for (; *(void **)((int)record + 0x50) == (void *)0x0; record = *(void **)((int)record + 0x14)) {
    }
    return *(void **)((int)record + 0x50);
  }
  return *(void **)((int)record + 0x50);
}



/* 00523e90 fr3_get_tyre_longitudinal_table */

/* Analyst-assigned name; not an original symbol. Returns local table or follows inherited address
   at +0x14; EAX input and result. Only selected signatures are corrected; unresolved callees retain
   the baseline Windows model. */

void * __cdecl fr3_get_tyre_longitudinal_table(void *record)

{
  if (*(void **)((int)record + 0x44) == (void *)0x0) {
    for (; *(void **)((int)record + 0x44) == (void *)0x0; record = *(void **)((int)record + 0x14)) {
    }
    return *(void **)((int)record + 0x44);
  }
  return *(void **)((int)record + 0x44);
}



/* 00523eb0 fr3_get_tyre_lateral_table */

/* Analyst-assigned name; not an original symbol. Returns local table or follows inherited address
   at +0x14; EAX input and result. Only selected signatures are corrected; unresolved callees retain
   the baseline Windows model. */

void * __cdecl fr3_get_tyre_lateral_table(void *record)

{
  if (*(void **)((int)record + 0x48) == (void *)0x0) {
    for (; *(void **)((int)record + 0x48) == (void *)0x0; record = *(void **)((int)record + 0x14)) {
    }
    return *(void **)((int)record + 0x48);
  }
  return *(void **)((int)record + 0x48);
}



/* 00523f10 fr3_get_tyre_sound_info */

/* Analyst-assigned name; not an original symbol. Returns local table or follows inherited address
   at +0x14; EAX input and result. Only selected signatures are corrected; unresolved callees retain
   the baseline Windows model. */

void * __cdecl fr3_get_tyre_sound_info(void *record)

{
  int iVar1;
  
  iVar1 = *(int *)((int)record + 0x54);
  while (iVar1 == 0) {
    for (; *(int *)((int)record + 0x54) == 0; record = *(void **)((int)record + 0x14)) {
    }
    iVar1 = *(int *)((int)record + 0x54);
  }
  return *(void **)((int)record + 0x54);
}



/* 00523ed0 fr3_get_tyre_sound_values */

/* Analyst-assigned name; not an original symbol. Selects row at sound_info + 0x78 + index*0x28; EAX
   record, EDX index. Only selected signatures are corrected; unresolved callees retain the baseline
   Windows model. */

void * __cdecl fr3_get_tyre_sound_values(void *record,int index)

{
  int iVar1;
  
  iVar1 = *(int *)((int)record + 0x54);
  while (iVar1 == 0) {
    for (; *(int *)((int)record + 0x54) == 0; record = *(void **)((int)record + 0x14)) {
    }
    iVar1 = *(int *)((int)record + 0x54);
  }
  return (void *)(*(int *)((int)record + 0x54) + 0x78 + index * 0x28);
}


