"""Disassemble explicitly bounded routines and preserve instruction evidence."""
import argparse
import json
from pathlib import Path
import capstone
import pefile
from fr3_common import verified_exe
from extract_tag_registry import read_va

# These names are analyst-assigned. Bounds delimit byte exports, not a claim
# that every byte in a range belongs to a single discovered function.
ROUTINES = [
    (0x00409B80, 0x00409D80, "load_directx_libraries"),
    (0x0040BA30, 0x0040BB60, "load_compressed_resource"),
    (0x0042ED50, 0x0042EDF5, "create_database"),
    (0x0042EED0, 0x0042EF62, "allocate_database_record"),
    (0x00423B20, 0x00423C10, "build_pcg_view"),
    (0x005227F0, 0x00522C80, "load_engine_database"),
    (0x00522C80, 0x00522EC0, "copy_engine_record"),
    (0x00523220, 0x00523470, "load_gearbox_database"),
    (0x00523470, 0x00523540, "copy_gearbox_record"),
    (0x00523820, 0x00523DC0, "load_tyre_database"),
    (0x00523DC0, 0x00523E50, "free_tyre_tables"),
    (0x00523E50, 0x00523F30, "tyre_table_accessors"),
    (0x00524090, 0x005240E0, "copy_tyre_scalar_fields"),
    (0x00534690, 0x005346A8, "fill_memory"),
    (0x00537240, 0x005372E3, "fill_memory_body"),
]

EVIDENCE = [
    (0x00522804, "bab0000000", "Engine payload allocation size: EDX = 0xb0"),
    (0x00522856, "3dab000000", "Engine tag dispatch compares the tag ID in EAX with 0xab (MAX_AIRFLOW)"),
    (0x0052285d, "83f87f", "Engine tag dispatch compares the tag ID in EAX with 0x7f (ENGINE_BRAKING)"),
    (0x00522866, "83f801", "Engine tag dispatch compares the tag ID in EAX with 0x1 (ACCELERATOR_SPEED)"),
    (0x005228a2, "d99f9c000000", "MAX_AIRFLOW float store (fstp) at record (EDI) + 0x9c"),
    (0x005228aa, "3dc8000000", "Engine tag dispatch compares the tag ID in EAX with 0xc8 (NUMBER_OF_TURBOS)"),
    (0x005228b1, "3db0000000", "Engine tag dispatch compares the tag ID in EAX with 0xb0 (MAX_RPM)"),
    (0x005228bc, "3dad000000", "Engine tag dispatch compares the tag ID in EAX with 0xad (MAX_DELTA_FUELFLOW)"),
    (0x005228d0, "d99fac000000", "MAX_DELTA_FUELFLOW float store (fstp) at record (EDI) + 0xac"),
    (0x005228e4, "888794000000", "NUMBER_OF_TURBOS stores the integer reader's low byte (AL) at record (EDI) + 0x94"),
    (0x005228ef, "3d18010000", "Engine tag dispatch compares the tag ID in EAX with 0x118 (TORQUE_ARRAY)"),
    (0x005228f6, "3de4000000", "Engine tag dispatch compares the tag ID in EAX with 0xe4 (ROUGHNESS)"),
    (0x0052290e, "d95f28", "ROUGHNESS float store (fstp) at record (EDI) + 0x28"),
    (0x0052291c, "bb48000000", "TORQUE_ARRAY fill size: EBX = 0x48 (18 dwords)"),
    (0x00522921, "8d473c", "TORQUE_ARRAY fill destination: EAX = record (EDI) + 0x3c"),
    (0x00522924, "31d2", "TORQUE_ARRAY fill value: EDX = 0"),
    (0x00522926, "e8651d0100", "TORQUE_ARRAY calls the fill routine at 0x00534690, zeroing + 0x3c..+0x83 before it reads any row"),
    (0x0052292b, "d94730", "TORQUE_ARRAY loads the current MAX_RPM value at + 0x30 to derive its row count"),
    (0x00522952, "89fa", "TORQUE_ARRAY row pointer starts at EDX = record (EDI)"),
    (0x0052295b, "83c204", "TORQUE_ARRAY advances the row pointer by 4 (EDX += 4) for each row"),
    (0x00522961, "d95dd4", "TORQUE_ARRAY stores each row's first column to the stack temporary [ebp - 0x2c], not to the record"),
    (0x00522969, "d95a38", "TORQUE_ARRAY stores each row's second column at EDX + 0x38, which is record + 0x3c + 4 * row"),
    (0x005229be, "8b45e8", "TORQUE_ARRAY loads the loop's current RPM value from [ebp - 0x18] into EAX"),
    (0x005229c1, "89472c", "TORQUE_ARRAY derived store of that value (EAX) at record (EDI) + 0x2c"),
    (0x005229ef, "d94730", "TORQUE_ARRAY loads MAX_RPM at + 0x30"),
    (0x005229f2, "d805241d5800", "TORQUE_ARRAY adds the float at 0x00581d24"),
    (0x005229f8, "d95f2c", "TORQUE_ARRAY derived store of that sum at record (EDI) + 0x2c"),
    (0x00522a00, "3d19010000", "Engine tag dispatch compares the tag ID in EAX with 0x119 (TORQUE_MODIFIER)"),
    (0x00522a0e, "d95f24", "TORQUE_MODIFIER float store (fstp) at record (EDI) + 0x24"),
    (0x00522a16, "3d5b010000", "Engine tag dispatch compares the tag ID in EAX with 0x15b (TURBO_MASS)"),
    (0x00522a28, "d99fa0000000", "TURBO_MASS float store (fstp) at record (EDI) + 0xa0"),
    (0x00522a2e, "f787a0000000ffffff7f", "TURBO_MASS tests + 0xa0 against 0x7fffffff (zero ignoring the sign bit)"),
    (0x00522a38, "0f8410020000", "TURBO_MASS jumps to 0x00522c4e when + 0xa0 is zero"),
    (0x00522a3e, "d987a0000000", "TURBO_MASS loads + 0xa0"),
    (0x00522a44, "d9e8", "TURBO_MASS loads 1.0"),
    (0x00522a46, "def1", "TURBO_MASS divides 1.0 by the + 0xa0 value (fdivrp)"),
    (0x00522a48, "d99fa4000000", "TURBO_MASS derived store of 1 / (+ 0xa0) at record (EDI) + 0xa4"),
    (0x00522a53, "3d12010000", "Engine tag dispatch compares the tag ID in EAX with 0x112 (TICKOVER_RPM)"),
    (0x00522a65, "d95f38", "TICKOVER_RPM float store (fstp) at record (EDI) + 0x38"),
    (0x00522a76, "d95f30", "MAX_RPM float store (fstp) at record (EDI) + 0x30"),
    (0x00522a7e, "3db1000000", "Engine tag dispatch compares the tag ID in EAX with 0xb1 (MAX_TURBO_PRESSURE)"),
    (0x00522a8c, "d99f84000000", "MAX_TURBO_PRESSURE float store (fstp) at record (EDI) + 0x84"),
    (0x00522a97, "3dc6000000", "Engine tag dispatch compares the tag ID in EAX with 0xc6 (NUMBER_OF_CYLINDERS)"),
    (0x00522aa9, "888795000000", "NUMBER_OF_CYLINDERS stores the integer reader's low byte (AL) at record (EDI) + 0x95"),
    (0x00522ab4, "3dae000000", "Engine tag dispatch compares the tag ID in EAX with 0xae (MAX_FUELFLOW)"),
    (0x00522ac6, "d99fa8000000", "MAX_FUELFLOW float store (fstp) at record (EDI) + 0xa8"),
    (0x00522ada, "d95f20", "ENGINE_BRAKING float store (fstp) at record (EDI) + 0x20"),
    (0x00522ae2, "3d8a000000", "Engine tag dispatch compares the tag ID in EAX with 0x8a (FUEL_CUTOFF)"),
    (0x00522ae9, "3d87000000", "Engine tag dispatch compares the tag ID in EAX with 0x87 (FLYWHEEL_MASS)"),
    (0x00522b01, "d99f88000000", "FLYWHEEL_MASS float store (fstp) at record (EDI) + 0x88"),
    (0x00522b15, "d95f1c", "FUEL_CUTOFF float store (fstp) at record (EDI) + 0x1c"),
    (0x00522b1d, "3d9c000000", "Engine tag dispatch compares the tag ID in EAX with 0x9c (INHERIT_TYPE)"),
    (0x00522b3c, "e82f020000", "INHERIT_TYPE calls 0x00522d70 to look up the parent record by the name just read"),
    (0x00522b41, "89c1", "INHERIT_TYPE keeps the parent record address in ECX"),
    (0x00522b43, "89c2", "INHERIT_TYPE passes the parent record address in EDX to the engine copy"),
    (0x00522b45, "89f8", "INHERIT_TYPE passes the current record address (EDI) in EAX to the engine copy"),
    (0x00522b47, "e834010000", "INHERIT_TYPE calls the engine copy at 0x00522c80"),
    (0x00522b4c, "894f18", "INHERIT_TYPE stores the parent record address (ECX) at + 0x18"),
    (0x00522b54, "3da5000000", "Engine tag dispatch compares the tag ID in EAX with 0xa5 (LOCATION_TYPE)"),
    (0x00522b64, "ba08745900", "LOCATION_TYPE passes the enum word table at 0x00597408 in EDX to the enum reader"),
    (0x00522b70, "884714", "LOCATION_TYPE stores the enum reader's low byte (AL) at record (EDI) + 0x14"),
    (0x00522b78, "3d88000000", "Engine tag dispatch compares the tag ID in EAX with 0x88 (FLYWHEEL_RADIUS)"),
    (0x00522b8a, "d99f8c000000", "FLYWHEEL_RADIUS float store (fstp) at record (EDI) + 0x8c"),
    (0x00522b9e, "d99f90000000", "ACCELERATOR_SPEED float store (fstp) at record (EDI) + 0x90"),
    (0x00522ba9, "83f810", "Engine tag dispatch compares the tag ID in EAX with 0x10 (ASPIRATION_TYPE)"),
    (0x00522bb9, "baf8735900", "ASPIRATION_TYPE passes the enum word table at 0x005973f8 in EDX to the enum reader"),
    (0x00522bc5, "898798000000", "ASPIRATION_TYPE stores the enum reader's result (EAX) at record (EDI) + 0x98"),
    (0x00522bd0, "83f837", "Engine tag dispatch compares the tag ID in EAX with 0x37 (CAPACITY)"),
    (0x00522be0, "d95f34", "CAPACITY float store (fstp) at record (EDI) + 0x34"),
    (0x00522c03, "89c7", "The record-creating branch keeps the record node returned by 0x0042eed0 in EDI"),
    (0x00522c0f, "83c720", "The record-creating branch advances EDI by 0x20 past the node header to the payload"),
    (0x00522c4e, "c787a40000000000803f", "TURBO_MASS derived store of 1.0 (0x3f800000) at record (EDI) + 0xa4 when + 0xa0 is zero"),
    (0x00522c84, "89c3", "Engine copy keeps the record address (EAX) in EBX"),
    (0x00522c86, "b948000000", "Engine copy block size: ECX = 0x48 bytes"),
    (0x00522c8b, "8a4214", "Engine copy loads the INHERIT_TYPE parent (EDX) byte + 0x14 into AL"),
    (0x00522c8e, "8d723c", "Engine copy block source: ESI = parent (EDX) + 0x3c"),
    (0x00522c91, "884314", "Engine copy stores that byte (AL) at record (EBX) + 0x14"),
    (0x00522c94, "8d7b3c", "Engine copy block destination: EDI = record (EBX) + 0x3c"),
    (0x00522c97, "8b421c", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x1c into EAX"),
    (0x00522c9a, "89431c", "Engine copy stores that dword (EAX) at record (EBX) + 0x1c"),
    (0x00522c9d, "8b4220", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x20 into EAX"),
    (0x00522ca0, "894320", "Engine copy stores that dword (EAX) at record (EBX) + 0x20"),
    (0x00522ca3, "8b4224", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x24 into EAX"),
    (0x00522ca6, "894324", "Engine copy stores that dword (EAX) at record (EBX) + 0x24"),
    (0x00522ca9, "8b4228", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x28 into EAX"),
    (0x00522cac, "894328", "Engine copy stores that dword (EAX) at record (EBX) + 0x28"),
    (0x00522caf, "8b422c", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x2c into EAX"),
    (0x00522cb2, "89432c", "Engine copy stores that dword (EAX) at record (EBX) + 0x2c"),
    (0x00522cb5, "8b4230", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x30 into EAX"),
    (0x00522cb8, "894330", "Engine copy stores that dword (EAX) at record (EBX) + 0x30"),
    (0x00522cbb, "8b4234", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x34 into EAX"),
    (0x00522cbe, "894334", "Engine copy stores that dword (EAX) at record (EBX) + 0x34"),
    (0x00522cc1, "8b4238", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x38 into EAX"),
    (0x00522cc4, "894338", "Engine copy stores that dword (EAX) at record (EBX) + 0x38"),
    (0x00522cc8, "89c8", "Engine copy keeps the block size (ECX) in EAX"),
    (0x00522cca, "c1e902", "Engine copy block dword count: ECX = 0x48 >> 2 = 0x12"),
    (0x00522ccd, "f2a5", "Engine copy repeats movsd ECX times (F2 prefix): 0x12 dwords from parent + 0x3c to record + 0x3c"),
    (0x00522ccf, "8ac8", "Engine copy block remainder: CL = AL, the low byte of 0x48"),
    (0x00522cd1, "80e103", "Engine copy block remainder: CL = CL & 3, which is 0 for 0x48"),
    (0x00522cd4, "f2a4", "Engine copy repeats movsb CL times (F2 prefix): no bytes for 0x48"),
    (0x00522cd7, "8b8284000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x84 into EAX"),
    (0x00522cdd, "898384000000", "Engine copy stores that dword (EAX) at record (EBX) + 0x84"),
    (0x00522ce3, "8b8288000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x88 into EAX"),
    (0x00522ce9, "898388000000", "Engine copy stores that dword (EAX) at record (EBX) + 0x88"),
    (0x00522cef, "8b828c000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x8c into EAX"),
    (0x00522cf5, "89838c000000", "Engine copy stores that dword (EAX) at record (EBX) + 0x8c"),
    (0x00522cfb, "8b8290000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x90 into EAX"),
    (0x00522d01, "898390000000", "Engine copy stores that dword (EAX) at record (EBX) + 0x90"),
    (0x00522d07, "8a8294000000", "Engine copy loads the INHERIT_TYPE parent (EDX) byte + 0x94 into AL"),
    (0x00522d0d, "888394000000", "Engine copy stores that byte (AL) at record (EBX) + 0x94"),
    (0x00522d13, "8a8295000000", "Engine copy loads the INHERIT_TYPE parent (EDX) byte + 0x95 into AL"),
    (0x00522d19, "888395000000", "Engine copy stores that byte (AL) at record (EBX) + 0x95"),
    (0x00522d1f, "8b8298000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x98 into EAX"),
    (0x00522d25, "898398000000", "Engine copy stores that dword (EAX) at record (EBX) + 0x98"),
    (0x00522d2b, "8b829c000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0x9c into EAX"),
    (0x00522d31, "89839c000000", "Engine copy stores that dword (EAX) at record (EBX) + 0x9c"),
    (0x00522d37, "8b82a0000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0xa0 into EAX"),
    (0x00522d3d, "8983a0000000", "Engine copy stores that dword (EAX) at record (EBX) + 0xa0"),
    (0x00522d43, "8b82a4000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0xa4 into EAX"),
    (0x00522d49, "8983a4000000", "Engine copy stores that dword (EAX) at record (EBX) + 0xa4"),
    (0x00522d4f, "8b82a8000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0xa8 into EAX"),
    (0x00522d55, "8983a8000000", "Engine copy stores that dword (EAX) at record (EBX) + 0xa8"),
    (0x00522d5b, "8b82ac000000", "Engine copy loads the INHERIT_TYPE parent (EDX) dword + 0xac into EAX"),
    (0x00522d61, "8983ac000000", "Engine copy stores that dword (EAX) at record (EBX) + 0xac"),
    (0x00522d6b, "c3", "Engine copy returns after its last store at + 0xac (EDI, ESI, ECX and EBX restored at 0x00522d67)"),
    (0x00523834, "ba58000000", "Tyre payload allocation size: EDX = 0x58"),
    (0x00523900, "d95028", "RADIUS store at payload + 0x28"),
    (0x00523907, "d9583c", "Reciprocal radius store at payload + 0x3c"),
    (0x00523937, "d90584745900", "ROAD_MAGIC_GRIP_NUMBER loads the grip scale global at 0x00597484"),
    (0x0052393f, "d95818", "ROAD_MAGIC_GRIP_NUMBER initial store at + 0x18"),
    (0x00523942, "d84818", "ROAD_MAGIC_GRIP_NUMBER multiplied by the global loaded from 0x00597484 at 0x00523937"),
    (0x00523945, "d95818", "ROAD_MAGIC_GRIP_NUMBER scaled value stored back at + 0x18"),
    (0x0052395a, "d95824", "TYRE_GRIP_DEPTH store at + 0x24"),
    (0x0052397f, "d9582c", "TYRE_PATCH_LENGTH store at + 0x2c"),
    (0x005239a9, "89424c", "VERTICAL_LOAD allocation address store at + 0x4c"),
    (0x00523a1b, "d95820", "WET_MAGIC_GRIP_PERCENTAGE store at + 0x20"),
    (0x00523a35, "d95830", "WIDTH store at + 0x30"),
    (0x00523a4a, "d95840", "ROLLING_RESISTANCE store at + 0x40"),
    (0x00523a67, "bad0020000", "SOUND_INFO allocation size: EDX = 0x2d0"),
    (0x00523a89, "894854", "SOUND_INFO allocation address store at + 0x54"),
    (0x00523b35, "89c2", "INHERIT_TYPE passes the parent record address in EDX to the scalar copy"),
    (0x00523b37, "8b45e8", "INHERIT_TYPE passes the current record address in EAX to the scalar copy"),
    (0x00523b3a, "e851050000", "INHERIT_TYPE calls the scalar copy at 0x00524090"),
    (0x00523b42, "894814", "INHERIT_TYPE stores record address at + 0x14"),
    (0x00523b60, "be48030000", "LATERAL_COMBINED_VALUES allocation size: ESI = 0x348"),
    (0x00523b7d, "894248", "Lateral allocation address store at + 0x48"),
    (0x00523be2, "b98c010000", "LONGITUDINAL_COMBINED_VALUES allocation size: ECX = 0x18c"),
    (0x00523bfb, "894244", "Longitudinal allocation address store at + 0x44"),
    (0x00523c83, "d95034", "MASS store at + 0x34"),
    (0x00523c8a, "d95838", "Reciprocal mass store at + 0x38"),
    (0x00523ca8, "d90584745900", "OFFROAD_MAGIC_GRIP_NUMBER loads the grip scale global at 0x00597484"),
    (0x00523cb0, "d9581c", "OFFROAD_MAGIC_GRIP_NUMBER initial store at + 0x1c"),
    (0x00523cb3, "d8481c", "OFFROAD_MAGIC_GRIP_NUMBER multiplied by the global loaded from 0x00597484 at 0x00523ca8"),
    (0x00523cb6, "d9581c", "OFFROAD_MAGIC_GRIP_NUMBER scaled value stored back at + 0x1c"),
    (0x00523ce6, "894250", "CAMBER_THRUST allocation address store at + 0x50"),
    (0x00523e52, "8b504c", "VERTICAL_LOAD accessor reads record + 0x4c"),
    (0x00523e60, "8b4014", "VERTICAL_LOAD accessor loads the inherited record from + 0x14"),
    (0x00523e72, "8b5050", "CAMBER_THRUST accessor reads record + 0x50"),
    (0x00523e80, "8b4014", "CAMBER_THRUST accessor loads the inherited record from + 0x14"),
    (0x00523e92, "8b5044", "LONGITUDINAL_COMBINED_VALUES accessor reads record + 0x44"),
    (0x00523ea0, "8b4014", "LONGITUDINAL_COMBINED_VALUES accessor loads the inherited record from + 0x14"),
    (0x00523eb2, "8b5048", "LATERAL_COMBINED_VALUES accessor reads record + 0x48"),
    (0x00523ec0, "8b4014", "LATERAL_COMBINED_VALUES accessor loads the inherited record from + 0x14"),
    (0x00523f10, "83785400", "SOUND_INFO accessor compares record + 0x54 with 0"),
    (0x00523f1c, "8b4014", "SOUND_INFO accessor loads the inherited record from + 0x14"),
    (0x00523f27, "8b4054", "SOUND_INFO accessor returns record + 0x54"),
    (0x00524091, "8b4a24", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x24 into ECX"),
    (0x00524094, "894824", "Scalar copy stores that dword (ECX) at record (EAX) + 0x24"),
    (0x00524097, "8b4a2c", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x2c into ECX"),
    (0x0052409a, "89482c", "Scalar copy stores that dword (ECX) at record (EAX) + 0x2c"),
    (0x0052409d, "8b4a28", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x28 into ECX"),
    (0x005240a0, "894828", "Scalar copy stores that dword (ECX) at record (EAX) + 0x28"),
    (0x005240a3, "8b4a30", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x30 into ECX"),
    (0x005240a6, "894830", "Scalar copy stores that dword (ECX) at record (EAX) + 0x30"),
    (0x005240a9, "8b4a34", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x34 into ECX"),
    (0x005240ac, "894834", "Scalar copy stores that dword (ECX) at record (EAX) + 0x34"),
    (0x005240af, "8b4a18", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x18 into ECX"),
    (0x005240b2, "894818", "Scalar copy stores that dword (ECX) at record (EAX) + 0x18"),
    (0x005240b5, "8b4a20", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x20 into ECX"),
    (0x005240b8, "894820", "Scalar copy stores that dword (ECX) at record (EAX) + 0x20"),
    (0x005240bb, "8b4a1c", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x1c into ECX"),
    (0x005240be, "89481c", "Scalar copy stores that dword (ECX) at record (EAX) + 0x1c"),
    (0x005240c1, "8b4a40", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x40 into ECX"),
    (0x005240c4, "894840", "Scalar copy stores that dword (ECX) at record (EAX) + 0x40"),
    (0x005240c7, "8b4a3c", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x3c into ECX"),
    (0x005240ca, "89483c", "Scalar copy stores that dword (ECX) at record (EAX) + 0x3c"),
    (0x005240cd, "8b4a38", "Scalar copy loads the INHERIT_TYPE parent (EDX) + 0x38 into ECX"),
    (0x005240d0, "894838", "Scalar copy stores that dword (ECX) at record (EAX) + 0x38"),
    (0x005240d4, "c3", "Scalar copy returns after its eleventh store (ECX restored at 0x005240d3)"),
]


def export_selected(data, output):
    """Write the bounded disassembly and field-evidence.json for the verified executable bytes into output.

    Returns the number of exported spans and the verified evidence list.
    """
    pe = pefile.PE(data=data)
    decoder = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    for start, end, name in ROUTINES:
        raw = read_va(pe, data, start, end - start)
        text = f"; Analyst label: {name}; export span 0x{start:08x}..0x{end:08x}\n"
        text += "; Linear decoding may include padding or neighboring code. Check branch targets and function-based Ghidra output.\n"
        text += "\n".join(f"{i.address:08x} {i.bytes.hex():<24} {i.mnemonic} {i.op_str}" for i in decoder.disasm(raw, start))
        (output / f"{name}.asm").write_text(text + "\n")
    evidence = []
    for va, expected, claim in EVIDENCE:
        raw = read_va(pe, data, va, len(bytes.fromhex(expected)))
        if raw.hex() != expected:
            raise ValueError(f"Instruction mismatch at 0x{va:08x}")
        evidence.append({"va": va, "bytes": expected, "claim": claim})
    (output / "field-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    return len(ROUTINES), evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    spans, evidence = export_selected(verified_exe(args.executable), args.output)
    print(f"Exported {spans} spans and verified {len(evidence)} instruction sites")

if __name__ == "__main__":
    main()
