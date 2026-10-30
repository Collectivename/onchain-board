use pinocchio::Address;

/// Compiled into the program. A new deploy address requires rebuilding with
/// that keypair's bytes. This binary rejects every other program id.
pub const ID: Address = Address::new_from_array([
    181, 37, 228, 46, 255, 215, 86, 252, 195, 246, 24, 176, 79, 121, 110, 17, 12, 7, 89, 218, 179,
    137, 245, 148, 252, 30, 162, 155, 214, 85, 236, 17,
]);
pub const TOKEN_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
pub const TOKEN_2022_ID: Address = Address::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);
pub const DELEGATION_ID: Address = Address::new_from_array([
    181, 183, 0, 225, 242, 87, 58, 192, 204, 6, 34, 1, 52, 74, 207, 151, 184, 53, 6, 235, 140, 229,
    25, 152, 204, 98, 126, 24, 147, 128, 167, 62,
]);
pub const MAGIC_ID: Address = Address::new_from_array([
    5, 69, 180, 36, 176, 218, 112, 149, 236, 185, 214, 222, 195, 119, 215, 40, 145, 182, 231, 142,
    146, 234, 18, 214, 223, 187, 58, 64, 0, 0, 0, 0,
]);
pub const MAGIC_CONTEXT_ID: Address = Address::new_from_array([
    5, 69, 180, 36, 196, 165, 40, 191, 95, 180, 3, 47, 68, 82, 130, 142, 187, 56, 171, 193, 210,
    220, 151, 247, 63, 139, 148, 84, 128, 0, 0, 0,
]);
pub const SYSTEM_ID: Address = Address::new_from_array([0; 32]);
