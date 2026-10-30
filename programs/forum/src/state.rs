//! On-chain layouts. Byte-for-byte the same as the previous Anchor accounts:
//! 8-byte `account:<Name>` discriminator, then Borsh for Forum/Treasury and
//! `repr(C)` zero-copy for the pages.

use bytemuck::{Pod, Zeroable};
use pinocchio::error::ProgramError;

pub const POSTS_PER_PAGE: u32 = 32;
pub const COMMENTS_PER_PAGE: u32 = 32;
pub const TITLE_MAX: usize = 96;
pub const ARWEAVE_ID_LEN: usize = 43;
pub const COMMIT_COOLDOWN_SECS: i64 = 6 * 60 * 60;
pub const COMMIT_FREQUENCY_MS: u32 = 86_400_000;

/// Anchor `#[error_code]` values. `NotAHolder` is 6000.
pub const NOT_A_HOLDER: u32 = 6000;
pub const WRONG_MINT: u32 = 6001;
pub const TITLE_REQUIRED: u32 = 6002;
pub const TITLE_TOO_LONG: u32 = 6003;
pub const BAD_ARWEAVE_ID: u32 = 6004;
pub const WRONG_PAGE: u32 = 6005;
pub const NEED_NEW_PAGE: u32 = 6006;
pub const UNKNOWN_POST: u32 = 6007;
pub const PAUSED: u32 = 6008;
pub const NOTHING_TO_COMMIT: u32 = 6009;
pub const COMMIT_TOO_SOON: u32 = 6010;
pub const OVERFLOW: u32 = 6011;
pub const BAD_FEE_VAULT: u32 = 6012;

pub const FORUM_DISC: [u8; 8] = [74, 10, 148, 158, 72, 60, 244, 226];
pub const TREASURY_DISC: [u8; 8] = [238, 239, 123, 238, 89, 1, 168, 253];
pub const POST_PAGE_DISC: [u8; 8] = [79, 120, 32, 34, 39, 224, 181, 95];
pub const COMMENT_PAGE_DISC: [u8; 8] = [236, 61, 116, 216, 235, 35, 229, 234];

/// Borsh body of `Forum` (no trailing padding). Discriminator sits in front.
pub mod forum_off {
    pub const MINT: usize = 0;
    pub const TOKEN_PROGRAM: usize = 32;
    pub const POST_COUNT: usize = 64;
    pub const COMMENT_COUNT: usize = 72;
    pub const POST_PAGE_COUNT: usize = 80;
    pub const COMMENT_PAGE_COUNT: usize = 84;
    pub const LAST_COMMIT_UNIX: usize = 88;
    pub const LAST_COMMITTED_POSTS: usize = 96;
    pub const LAST_COMMITTED_COMMENTS: usize = 104;
    pub const PAUSED: usize = 112;
    pub const BUMP: usize = 113;
    pub const LEN: usize = 114;
}

/// Borsh body of `Treasury`.
pub mod treasury_off {
    pub const FORUM: usize = 0;
    pub const BUMP: usize = 32;
    pub const LEN: usize = 33;
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PostSlot {
    pub occupied: u8,
    pub title_len: u8,
    pub _pad0: [u8; 6],
    pub id: u64,
    pub author: [u8; 32],
    pub created_unix: i64,
    pub comment_count: u64,
    pub title: [u8; TITLE_MAX],
    pub arweave_id: [u8; ARWEAVE_ID_LEN],
    pub _pad1: [u8; 5],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PostPage {
    pub forum: [u8; 32],
    pub page_index: u32,
    pub filled: u32,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub slots: [PostSlot; POSTS_PER_PAGE as usize],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CommentSlot {
    pub occupied: u8,
    pub _pad0: [u8; 7],
    pub id: u64,
    pub post_id: u64,
    pub parent_comment_id: u64,
    pub author: [u8; 32],
    pub created_unix: i64,
    pub arweave_id: [u8; ARWEAVE_ID_LEN],
    pub _pad1: [u8; 5],
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CommentPage {
    pub forum: [u8; 32],
    pub page_index: u32,
    pub filled: u32,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub slots: [CommentSlot; COMMENTS_PER_PAGE as usize],
}

pub const FORUM_SIZE: usize = 8 + forum_off::LEN;
pub const TREASURY_SIZE: usize = 8 + treasury_off::LEN;
/// `["validator", mint]`. Stays on Solana so later delegates can read it after
/// the forum account itself has moved to the rollup. 8-byte disc + validator.
pub const VALIDATOR_RECORD_SIZE: usize = 40;
pub const VALIDATOR_DISC: [u8; 8] = [240, 119, 197, 237, 249, 54, 71, 109];
pub const POST_PAGE_SIZE: usize = 8 + core::mem::size_of::<PostPage>();
pub const COMMENT_PAGE_SIZE: usize = 8 + core::mem::size_of::<CommentPage>();

const _: () = assert!(POST_PAGE_SIZE <= 10_240);
const _: () = assert!(COMMENT_PAGE_SIZE <= 10_240);

pub fn read_u64(buf: &[u8], at: usize) -> Result<u64, ProgramError> {
    let end = at.checked_add(8).ok_or(ProgramError::InvalidAccountData)?;
    let bytes: &[u8; 8] = buf
        .get(at..end)
        .ok_or(ProgramError::InvalidAccountData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(*bytes))
}

pub fn write_u64(buf: &mut [u8], at: usize, value: u64) -> Result<(), ProgramError> {
    let end = at.checked_add(8).ok_or(ProgramError::InvalidAccountData)?;
    buf.get_mut(at..end)
        .ok_or(ProgramError::InvalidAccountData)?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}

pub fn read_u32(buf: &[u8], at: usize) -> Result<u32, ProgramError> {
    let end = at.checked_add(4).ok_or(ProgramError::InvalidAccountData)?;
    let bytes: &[u8; 4] = buf
        .get(at..end)
        .ok_or(ProgramError::InvalidAccountData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(u32::from_le_bytes(*bytes))
}

pub fn write_u32(buf: &mut [u8], at: usize, value: u32) -> Result<(), ProgramError> {
    let end = at.checked_add(4).ok_or(ProgramError::InvalidAccountData)?;
    buf.get_mut(at..end)
        .ok_or(ProgramError::InvalidAccountData)?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}

pub fn read_i64(buf: &[u8], at: usize) -> Result<i64, ProgramError> {
    Ok(read_u64(buf, at)? as i64)
}

pub fn write_i64(buf: &mut [u8], at: usize, value: i64) -> Result<(), ProgramError> {
    write_u64(buf, at, value as u64)
}

pub fn read_pubkey(buf: &[u8], at: usize) -> Result<[u8; 32], ProgramError> {
    let end = at.checked_add(32).ok_or(ProgramError::InvalidAccountData)?;
    let bytes: &[u8; 32] = buf
        .get(at..end)
        .ok_or(ProgramError::InvalidAccountData)?
        .try_into()
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(*bytes)
}

pub fn write_pubkey(buf: &mut [u8], at: usize, key: &[u8; 32]) -> Result<(), ProgramError> {
    let end = at.checked_add(32).ok_or(ProgramError::InvalidAccountData)?;
    buf.get_mut(at..end)
        .ok_or(ProgramError::InvalidAccountData)?
        .copy_from_slice(key);
    Ok(())
}

pub fn fail(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

pub fn encode_title(src: &str) -> Result<([u8; TITLE_MAX], u8), ProgramError> {
    let bytes = src.as_bytes();
    if bytes.len() > TITLE_MAX {
        return Err(fail(TITLE_TOO_LONG));
    }
    let mut out = [0u8; TITLE_MAX];
    out[..bytes.len()].copy_from_slice(bytes);
    Ok((out, bytes.len() as u8))
}

pub fn parse_arweave_id(src: &str) -> Result<[u8; ARWEAVE_ID_LEN], ProgramError> {
    let t = src.trim();
    if t.len() != ARWEAVE_ID_LEN {
        return Err(fail(BAD_ARWEAVE_ID));
    }
    if !t
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(fail(BAD_ARWEAVE_ID));
    }
    let mut out = [0u8; ARWEAVE_ID_LEN];
    out.copy_from_slice(t.as_bytes());
    Ok(out)
}

/// First dirty page through the page that holds the newest item.
pub fn dirty_page_bounds(committed: u64, total: u64, per_page: u64) -> Option<(u32, u32)> {
    if total <= committed {
        return None;
    }
    let start = u32::try_from(committed / per_page).ok()?;
    let end = u32::try_from((total - 1) / per_page).ok()?;
    Some((start, end))
}

/// Move a commit cursor through included pages, never backwards.
pub fn cursor_after(
    next: u32,
    end: u32,
    total: u64,
    per_page: u64,
    previous: u64,
) -> Result<u64, ProgramError> {
    if next > end {
        return Ok(total);
    }
    let at_page = u64::from(next)
        .checked_mul(per_page)
        .ok_or(fail(OVERFLOW))?;
    Ok(at_page.max(previous))
}
