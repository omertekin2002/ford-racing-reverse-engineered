/* In-memory layouts for the SHA-256-pinned Windows demo.
 * Every Fr3GearboxRecord field from +0x14 on is byte-checked: the gearbox
 * loader 0x00523220 stores each one when it parses its tag, and the copy
 * 0x00523470 that INHERIT_TYPE calls copies all nine; no parent address is
 * stored (GEARBOX_FIELD_STORES and GEARBOX_COPY in scripts/text_database.py).
 * Every Fr3EngineRecord field from +0x14 on is byte-checked: the engine loader
 * 0x005227f0 stores each one when it parses its tag, INHERIT_TYPE stores the
 * parent at +0x18, and the copy 0x00522c80 copies all of them but +0x18
 * (ENGINE_FIELD_STORES and ENGINE_COPY in scripts/text_database.py, sites in
 * analysis/selected/field-evidence.json). The field names are analyst labels;
 * derived_rpm (+0x2c, stored only under conditions) and inverse_turbo_mass
 * (+0xa4) are computed by the loader. Padding is not byte-checked.
 * Tyre layout was reconstructed here from loader 0x00523820 and accessors.
 * All address fields represent 32-bit game addresses, never native pointers.
 */
#ifndef FR3_DATABASE_LAYOUTS_H
#define FR3_DATABASE_LAYOUTS_H
#include <stddef.h>
#include <stdint.h>

typedef struct {
    char name[20];
    uint8_t location_type;
    uint8_t padding_15[3];
    uint32_t inherited_address;
    float fuel_cutoff;
    float engine_braking;
    float torque_modifier;
    float roughness;
    float derived_rpm;
    float max_rpm;
    float capacity;
    float tickover_rpm;
    float torque[18];
    float max_turbo_pressure;
    float flywheel_mass;
    float flywheel_radius;
    float accelerator_speed;
    uint8_t turbo_count;
    uint8_t cylinder_count;
    uint8_t padding_96[2];
    uint32_t aspiration_type;
    float max_airflow;
    float turbo_mass;
    float inverse_turbo_mass;
    float max_fuel_flow;
    float max_delta_fuel_flow;
} Fr3EngineRecord;

typedef struct {
    char name[20];
    float clutch_speed;
    float clutch_max_power;
    float torque_shift;
    float drive_split;
    uint32_t transmission_type;
    uint32_t differential_type;
    uint32_t drive_type;
    uint8_t anti_wheelspin;
    uint8_t anti_wheelskid;
    uint8_t padding_32[2];
} Fr3GearboxRecord;

typedef struct {
    char name[20];
    uint32_t inherited_address;
    float road_grip_scaled;
    float offroad_grip_scaled;
    float wet_grip_percentage;
    float grip_depth;
    float radius;
    float patch_length;
    float width;
    float mass;
    float inverse_mass;
    float inverse_radius;
    float rolling_resistance;
    uint32_t longitudinal_table_address; /* 9 rows of 11 floats */
    uint32_t lateral_table_address;      /* 10 rows of 21 floats */
    uint32_t vertical_load_address;      /* 10 indexed floats */
    uint32_t camber_thrust_address;      /* 10 indexed floats */
    uint32_t sound_info_address;         /* 0x2d0-byte allocation */
} Fr3TyreRecord;

typedef struct {
    uint32_t unknown_first_words[15];
    float start_rpm[15];
    float values[15][10];
} Fr3TyreSoundInfo;

_Static_assert(sizeof(float) == 4, "Requires 32-bit floats");
_Static_assert(sizeof(Fr3EngineRecord) == 0xb0, "Engine record size");
_Static_assert(offsetof(Fr3EngineRecord, location_type) == 0x14, "LOCATION_TYPE byte");
_Static_assert(offsetof(Fr3EngineRecord, inherited_address) == 0x18, "Inherited address offset");
_Static_assert(offsetof(Fr3EngineRecord, fuel_cutoff) == 0x1c, "FUEL_CUTOFF");
_Static_assert(offsetof(Fr3EngineRecord, engine_braking) == 0x20, "ENGINE_BRAKING");
_Static_assert(offsetof(Fr3EngineRecord, torque_modifier) == 0x24, "TORQUE_MODIFIER");
_Static_assert(offsetof(Fr3EngineRecord, roughness) == 0x28, "ROUGHNESS");
_Static_assert(offsetof(Fr3EngineRecord, derived_rpm) == 0x2c, "TORQUE_ARRAY derived value");
_Static_assert(offsetof(Fr3EngineRecord, max_rpm) == 0x30, "MAX_RPM");
_Static_assert(offsetof(Fr3EngineRecord, capacity) == 0x34, "CAPACITY");
_Static_assert(offsetof(Fr3EngineRecord, tickover_rpm) == 0x38, "TICKOVER_RPM");
_Static_assert(offsetof(Fr3EngineRecord, torque) == 0x3c, "Torque array offset");
_Static_assert(sizeof(((Fr3EngineRecord *)0)->torque) == 0x48, "Torque array zero-fill and copy size");
_Static_assert(offsetof(Fr3EngineRecord, max_turbo_pressure) == 0x84, "Torque array end");
_Static_assert(offsetof(Fr3EngineRecord, flywheel_mass) == 0x88, "FLYWHEEL_MASS");
_Static_assert(offsetof(Fr3EngineRecord, flywheel_radius) == 0x8c, "FLYWHEEL_RADIUS");
_Static_assert(offsetof(Fr3EngineRecord, accelerator_speed) == 0x90, "ACCELERATOR_SPEED");
_Static_assert(offsetof(Fr3EngineRecord, turbo_count) == 0x94, "NUMBER_OF_TURBOS byte");
_Static_assert(offsetof(Fr3EngineRecord, cylinder_count) == 0x95, "NUMBER_OF_CYLINDERS byte");
_Static_assert(offsetof(Fr3EngineRecord, aspiration_type) == 0x98, "Aspiration offset");
_Static_assert(offsetof(Fr3EngineRecord, max_airflow) == 0x9c, "MAX_AIRFLOW");
_Static_assert(offsetof(Fr3EngineRecord, turbo_mass) == 0xa0, "TURBO_MASS");
_Static_assert(offsetof(Fr3EngineRecord, inverse_turbo_mass) == 0xa4, "TURBO_MASS derived reciprocal");
_Static_assert(offsetof(Fr3EngineRecord, max_fuel_flow) == 0xa8, "MAX_FUELFLOW");
_Static_assert(offsetof(Fr3EngineRecord, max_delta_fuel_flow) == 0xac, "MAX_DELTA_FUELFLOW, final engine field");
_Static_assert(sizeof(Fr3GearboxRecord) == 0x34, "Gearbox record size");
_Static_assert(offsetof(Fr3GearboxRecord, clutch_speed) == 0x14, "CLUTCH_SPEED");
_Static_assert(offsetof(Fr3GearboxRecord, clutch_max_power) == 0x18, "CLUTCH_MAX_POWER");
_Static_assert(offsetof(Fr3GearboxRecord, torque_shift) == 0x1c, "TORQUE_SHIFT");
_Static_assert(offsetof(Fr3GearboxRecord, drive_split) == 0x20, "DRIVE_SPLIT");
_Static_assert(offsetof(Fr3GearboxRecord, transmission_type) == 0x24, "TRANSMISSION_TYPE");
_Static_assert(offsetof(Fr3GearboxRecord, differential_type) == 0x28, "DIFF_TYPE");
_Static_assert(offsetof(Fr3GearboxRecord, drive_type) == 0x2c, "DRIVE_TYPE");
_Static_assert(offsetof(Fr3GearboxRecord, anti_wheelspin) == 0x30, "ANTI_WHEELSPIN byte");
_Static_assert(offsetof(Fr3GearboxRecord, anti_wheelskid) == 0x31, "ANTI_WHEELSKID byte, final gearbox field");
_Static_assert(sizeof(Fr3TyreRecord) == 0x58, "Tyre record size");
_Static_assert(offsetof(Fr3TyreRecord, inherited_address) == 0x14, "Tyre inherited address");
_Static_assert(offsetof(Fr3TyreRecord, radius) == 0x28, "Tyre radius offset");
_Static_assert(offsetof(Fr3TyreRecord, inverse_mass) == 0x38, "Tyre inverse mass");
_Static_assert(offsetof(Fr3TyreRecord, longitudinal_table_address) == 0x44, "Longitudinal table address");
_Static_assert(offsetof(Fr3TyreRecord, sound_info_address) == 0x54, "Sound table address");
_Static_assert(sizeof(Fr3TyreSoundInfo) == 0x2d0, "Tyre sound allocation");
_Static_assert(offsetof(Fr3TyreSoundInfo, start_rpm) == 0x3c, "Sound START_RPM table");
_Static_assert(offsetof(Fr3TyreSoundInfo, values) == 0x78, "Sound value table");
#endif
