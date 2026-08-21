use anchor_lang::prelude::*;

/// Posts packed per page so we never `getProgramAccounts`.
/// Sized for zero-copy + Anchor `init` CPI max (10_240 bytes).
pub const POSTS_PER_PAGE: u32 = 32;
/// Comments packed per page.
pub const COMMENTS_PER_PAGE: u32 = 32;
/// UTF-8 title cap stored on-chain (list view needs no Arweave).
pub const TITLE_MAX: usize = 96;
/// Arweave tx ids are 43-char base64url (stored; trailing pad for Pod align).
pub const ARWEAVE_ID_LEN: usize = 43;
/// Dirty-only commits: at most one every 6 hours.
pub const COMMIT_COOLDOWN_SECS: i64 = 6 * 60 * 60;
/// Safety-net auto-commit interval passed to the delegation program (24h).
pub const COMMIT_FREQUENCY_MS: u32 = 86_400_000;

#[account]
#[derive(Default)]
pub struct Forum {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub post_count: u64,
    pub comment_count: u64,
    pub post_page_count: u32,
    pub comment_page_count: u32,
    pub last_commit_unix: i64,
    pub last_committed_posts: u64,
    pub last_committed_comments: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Forum {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 4 + 4 + 8 + 8 + 8 + 1 + 1;
}

#[account]
#[derive(Default)]
pub struct Treasury {
    pub forum: Pubkey,
    pub bump: u8,
}

impl Treasury {
    pub const SIZE: usize = 8 + 32 + 1;
}

/// One post slot. `#[repr(C)]` + padding so the type is `Pod` for zero-copy.
#[zero_copy]
#[repr(C)]
pub struct PostSlot {
    pub occupied: u8,
    pub title_len: u8,
    pub _pad0: [u8; 6],
    pub id: u64,
    pub author: Pubkey,
    pub created_unix: i64,
    pub comment_count: u64,
    pub title: [u8; TITLE_MAX],
    pub arweave_id: [u8; ARWEAVE_ID_LEN],
    pub _pad1: [u8; 5],
}

impl PostSlot {
    pub fn is_occupied(&self) -> bool {
        self.occupied != 0
    }
}

/// Packed post page. Zero-copy avoids the 4 KiB SBF stack limit.
#[account(zero_copy)]
#[repr(C)]
pub struct PostPage {
    pub forum: Pubkey,
    pub page_index: u32,
    pub filled: u32,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub slots: [PostSlot; POSTS_PER_PAGE as usize],
}

impl PostPage {
    pub const SIZE: usize = 8 + core::mem::size_of::<PostPage>();
}

/// One comment slot.
#[zero_copy]
#[repr(C)]
pub struct CommentSlot {
    pub occupied: u8,
    pub _pad0: [u8; 7],
    pub id: u64,
    pub post_id: u64,
    /// 0 = top-level reply to the post. Non-zero reserved for later nesting.
    pub parent_comment_id: u64,
    pub author: Pubkey,
    pub created_unix: i64,
    pub arweave_id: [u8; ARWEAVE_ID_LEN],
    pub _pad1: [u8; 5],
}

impl CommentSlot {
    pub fn is_occupied(&self) -> bool {
        self.occupied != 0
    }
}

#[account(zero_copy)]
#[repr(C)]
pub struct CommentPage {
    pub forum: Pubkey,
    pub page_index: u32,
    pub filled: u32,
    pub bump: u8,
    pub _pad: [u8; 7],
    pub slots: [CommentSlot; COMMENTS_PER_PAGE as usize],
}

impl CommentPage {
    pub const SIZE: usize = 8 + core::mem::size_of::<CommentPage>();
}

const _: () = assert!(PostPage::SIZE <= 10_240);
const _: () = assert!(CommentPage::SIZE <= 10_240);

pub fn encode_title(src: &str) -> Result<([u8; TITLE_MAX], u8)> {
    let bytes = src.as_bytes();
    require!(bytes.len() <= TITLE_MAX, crate::ForumError::TitleTooLong);
    let mut out = [0u8; TITLE_MAX];
    out[..bytes.len()].copy_from_slice(bytes);
    Ok((out, bytes.len() as u8))
}

pub fn parse_arweave_id(src: &str) -> Result<[u8; ARWEAVE_ID_LEN]> {
    let t = src.trim();
    require!(t.len() == ARWEAVE_ID_LEN, crate::ForumError::BadArweaveId);
    require!(
        t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        crate::ForumError::BadArweaveId
    );
    let mut out = [0u8; ARWEAVE_ID_LEN];
    out.copy_from_slice(t.as_bytes());
    Ok(out)
}

