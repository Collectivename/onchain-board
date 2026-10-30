//! Holder forum, same wire format as the Anchor program.
//!
//! Instruction discriminators, account order, Borsh arguments, and the
//! zero-copy pages are unchanged. Delegate and commit CPIs match
//! ephemeral-rollups-sdk 0.16. Pinocchio keeps that behavior in a smaller ELF.

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use bytemuck::{Pod, Zeroable};
use pinocchio::{
    default_allocator, error::ProgramError, nostd_panic_handler, program_entrypoint,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::{Allocate, Assign, Transfer};

mod ids;
mod magic;
mod state;

use ids::{DELEGATION_ID, ID, MAGIC_CONTEXT_ID, SYSTEM_ID, TOKEN_2022_ID, TOKEN_ID};
use state::*;

const IX_INITIALIZE: [u8; 8] = [0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed];
const IX_DELEGATE_FORUM: [u8; 8] = [0xca, 0x98, 0x4d, 0xaf, 0xe2, 0xb6, 0xe4, 0x26];
const IX_DELEGATE_TREASURY: [u8; 8] = [0xdc, 0xe6, 0x2d, 0x38, 0x5c, 0xdf, 0xa2, 0xa9];
const IX_DELEGATE_POST_PAGE: [u8; 8] = [0x76, 0x36, 0x49, 0xc4, 0x7a, 0x23, 0x73, 0x58];
const IX_DELEGATE_COMMENT_PAGE: [u8; 8] = [0x99, 0xad, 0xc7, 0xb4, 0x1b, 0x9b, 0xd9, 0x33];
const IX_OPEN_POST_PAGE: [u8; 8] = [0x53, 0xa2, 0x66, 0x94, 0x1d, 0x6a, 0x87, 0xee];
const IX_OPEN_COMMENT_PAGE: [u8; 8] = [0xce, 0xc2, 0x02, 0x3e, 0xc3, 0x13, 0x9a, 0xe3];
const IX_CREATE_POST: [u8; 8] = [0x7b, 0x5c, 0xb8, 0x1d, 0xe7, 0x18, 0x0f, 0xca];
const IX_CREATE_COMMENT: [u8; 8] = [0xec, 0xe8, 0x0b, 0xb4, 0x46, 0xce, 0x49, 0x91];
const IX_MAYBE_COMMIT: [u8; 8] = [0xda, 0x47, 0x3b, 0x6c, 0x81, 0x6f, 0x4d, 0x2f];
const IX_PROCESS_UNDELEGATION: [u8; 8] = [0xc4, 0x1c, 0x29, 0xce, 0x30, 0x25, 0x33, 0xa7];

const TOKEN_ACCOUNT_LEN: usize = 165;
const TOKEN_STATE_OFFSET: usize = 108;

program_entrypoint!(process_instruction, 80);
default_allocator!();
nostd_panic_handler!();

pub fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if program_id != &ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&data[..8]);
    let rest = &data[8..];
    match disc {
        IX_INITIALIZE => initialize(accounts, rest),
        IX_DELEGATE_FORUM => delegate_one(accounts, rest, SeedKind::Forum),
        IX_DELEGATE_TREASURY => delegate_one(accounts, rest, SeedKind::Treasury),
        IX_DELEGATE_POST_PAGE => delegate_page(accounts, rest, true),
        IX_DELEGATE_COMMENT_PAGE => delegate_page(accounts, rest, false),
        IX_OPEN_POST_PAGE => open_page(accounts, rest, true),
        IX_OPEN_COMMENT_PAGE => open_page(accounts, rest, false),
        IX_CREATE_POST => create_post(accounts, rest),
        IX_CREATE_COMMENT => create_comment(accounts, rest),
        IX_MAYBE_COMMIT => maybe_commit(accounts, rest),
        IX_PROCESS_UNDELEGATION => {
            let seeds = magic::parse_seed_vecs(rest)?;
            let base = acc(accounts, 0)?;
            let buffer = acc(accounts, 1)?;
            let payer = acc(accounts, 2)?;
            let system = acc(accounts, 3)?;
            writable(base)?;
            writable(payer)?;
            magic::process_undelegation(base, buffer, payer, system, &seeds)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn initialize(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let author = acc(accounts, 0)?;
    let mint = acc(accounts, 1)?;
    let ata = acc(accounts, 2)?;
    let token_program = acc(accounts, 3)?;
    let forum = acc(accounts, 4)?;
    let treasury = acc(accounts, 5)?;
    let posts = acc(accounts, 6)?;
    let comments = acc(accounts, 7)?;
    let system = acc(accounts, 8)?;
    signer(author)?;
    writable(author)?;
    writable(forum)?;
    writable(treasury)?;
    writable(posts)?;
    writable(comments)?;
    if system.address() != &SYSTEM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    require_holder(author, mint, ata, token_program)?;

    let forum_seeds: [&[u8]; 2] = [b"forum", mint.address().as_ref()];
    let forum_bump = create_owned(author, forum, FORUM_SIZE, &forum_seeds)?;
    let treasury_seeds: [&[u8]; 2] = [b"treasury", mint.address().as_ref()];
    let treasury_bump = create_owned(author, treasury, TREASURY_SIZE, &treasury_seeds)?;
    let zero = 0u32.to_le_bytes();
    let post_seeds: [&[u8]; 3] = [b"posts", forum.address().as_ref(), &zero];
    let post_bump = create_owned(author, posts, POST_PAGE_SIZE, &post_seeds)?;
    let comment_seeds: [&[u8]; 3] = [b"comments", forum.address().as_ref(), &zero];
    let comment_bump = create_owned(author, comments, COMMENT_PAGE_SIZE, &comment_seeds)?;

    {
        let mut raw = forum.try_borrow_mut()?;
        raw[..8].copy_from_slice(&FORUM_DISC);
        let body = &mut raw[8..FORUM_SIZE];
        write_pubkey(body, forum_off::MINT, mint.address().as_array())?;
        write_pubkey(body, forum_off::TOKEN_PROGRAM, token_program.address().as_array())?;
        write_u32(body, forum_off::POST_PAGE_COUNT, 1)?;
        write_u32(body, forum_off::COMMENT_PAGE_COUNT, 1)?;
        body[forum_off::BUMP] = forum_bump;
    }
    {
        let mut raw = treasury.try_borrow_mut()?;
        raw[..8].copy_from_slice(&TREASURY_DISC);
        let body = &mut raw[8..TREASURY_SIZE];
        write_pubkey(body, treasury_off::FORUM, forum.address().as_array())?;
        body[treasury_off::BUMP] = treasury_bump;
    }
    init_page::<PostPage>(posts, &POST_PAGE_DISC, forum.address(), 0, post_bump)?;
    init_page::<CommentPage>(comments, &COMMENT_PAGE_DISC, forum.address(), 0, comment_bump)?;
    Ok(())
}

enum SeedKind {
    Forum,
    Treasury,
}

fn delegate_one(accounts: &[AccountView], data: &[u8], kind: SeedKind) -> ProgramResult {
    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let payer = acc(accounts, 0)?;
    let mint = acc(accounts, 1)?;
    let buffer = acc(accounts, 2)?;
    let record = acc(accounts, 3)?;
    let metadata = acc(accounts, 4)?;
    let pda = acc(accounts, 5)?;
    let owner = acc(accounts, 6)?;
    let delegation = acc(accounts, 7)?;
    let system = acc(accounts, 8)?;
    signer(payer)?;
    writable(payer)?;
    writable(buffer)?;
    writable(record)?;
    writable(metadata)?;
    writable(pda)?;
    let seed: &[u8] = match kind {
        SeedKind::Forum => b"forum",
        SeedKind::Treasury => b"treasury",
    };
    let seeds: [&[u8]; 2] = [seed, mint.address().as_ref()];
    require_pda(pda, &seeds, &ID)?;
    let ata = acc(accounts, 9)?;
    let token_program = acc(accounts, 10)?;
    let validator_record = acc(accounts, 11)?;
    let validator_account = acc(accounts, 12)?;
    writable(validator_record)?;
    require_holder(payer, mint, ata, token_program)?;
    bind_validator(payer, mint, validator_record, validator_account.address())?;
    let validator = Some(validator_account.address());
    magic::delegate_account(
        payer, pda, owner, buffer, record, metadata, delegation, system, &seeds, validator,
    )
}

fn delegate_page(accounts: &[AccountView], data: &[u8], posts: bool) -> ProgramResult {
    let page_index = read_u32_exact(data)?;
    let payer = acc(accounts, 0)?;
    let mint = acc(accounts, 1)?;
    let forum = acc(accounts, 2)?;
    let buffer = acc(accounts, 3)?;
    let record = acc(accounts, 4)?;
    let metadata = acc(accounts, 5)?;
    let page = acc(accounts, 6)?;
    let owner = acc(accounts, 7)?;
    let delegation = acc(accounts, 8)?;
    let system = acc(accounts, 9)?;
    signer(payer)?;
    writable(payer)?;
    writable(buffer)?;
    writable(record)?;
    writable(metadata)?;
    writable(page)?;
    let forum_seeds: [&[u8]; 2] = [b"forum", mint.address().as_ref()];
    require_pda(forum, &forum_seeds, &ID)?;
    let index = page_index.to_le_bytes();
    let tag: &[u8] = if posts { b"posts" } else { b"comments" };
    let seeds: [&[u8]; 3] = [tag, forum.address().as_ref(), &index];
    require_pda(page, &seeds, &ID)?;
    let ata = acc(accounts, 10)?;
    let token_program = acc(accounts, 11)?;
    let validator_record = acc(accounts, 12)?;
    let validator_account = acc(accounts, 13)?;
    writable(validator_record)?;
    require_holder(payer, mint, ata, token_program)?;
    bind_validator(payer, mint, validator_record, validator_account.address())?;
    let validator = Some(validator_account.address());
    magic::delegate_account(
        payer, page, owner, buffer, record, metadata, delegation, system, &seeds, validator,
    )
}

fn open_page(accounts: &[AccountView], data: &[u8], posts: bool) -> ProgramResult {
    let page_index = read_u32_exact(data)?;
    if page_index == 0 {
        return Err(fail(WRONG_PAGE));
    }
    let author = acc(accounts, 0)?;
    let mint = acc(accounts, 1)?;
    let ata = acc(accounts, 2)?;
    let token_program = acc(accounts, 3)?;
    let forum = acc(accounts, 4)?;
    let page = acc(accounts, 5)?;
    let system = acc(accounts, 6)?;
    signer(author)?;
    writable(author)?;
    writable(page)?;
    if system.address() != &SYSTEM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    require_holder(author, mint, ata, token_program)?;
    let forum_seeds: [&[u8]; 2] = [b"forum", mint.address().as_ref()];
    require_pda(forum, &forum_seeds, &ID)?;
    let index = page_index.to_le_bytes();
    let (tag, disc, space): (&[u8], &[u8; 8], usize) = if posts {
        (b"posts", &POST_PAGE_DISC, POST_PAGE_SIZE)
    } else {
        (b"comments", &COMMENT_PAGE_DISC, COMMENT_PAGE_SIZE)
    };
    let seeds: [&[u8]; 3] = [tag, forum.address().as_ref(), &index];
    let bump = create_owned(author, page, space, &seeds)?;
    if posts {
        init_page::<PostPage>(page, disc, forum.address(), page_index, bump)
    } else {
        init_page::<CommentPage>(page, disc, forum.address(), page_index, bump)
    }
}

fn create_post(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let (title, rest) = take_str(data)?;
    let (arweave, rest) = take_str(rest)?;
    if !rest.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let author = acc(accounts, 0)?;
    let mint = acc(accounts, 1)?;
    let ata = acc(accounts, 2)?;
    let token_program = acc(accounts, 3)?;
    let forum = acc(accounts, 4)?;
    let page = acc(accounts, 5)?;
    signer(author)?;
    writable(forum)?;
    writable(page)?;
    owned(forum)?;
    owned(page)?;
    {
        let raw = forum.try_borrow()?;
        let body = forum_body(&raw)?;
        if body[forum_off::PAUSED] != 0 {
            return Err(fail(PAUSED));
        }
    }
    require_holder(author, mint, ata, token_program)?;
    let post_count = {
        let raw = forum.try_borrow()?;
        let body = forum_body(&raw)?;
        if read_pubkey(body, forum_off::MINT)? != *mint.address().as_array() {
            return Err(fail(WRONG_MINT));
        }
        read_u64(body, forum_off::POST_COUNT)?
    };
    let title = title.trim();
    if title.is_empty() {
        return Err(fail(TITLE_REQUIRED));
    }
    let (title_bytes, title_len) = encode_title(title)?;
    let ar_id = parse_arweave_id(arweave)?;
    let now = Clock::get()?.unix_timestamp;
    let author_key = *author.address().as_array();
    let page_index = (post_count / POSTS_PER_PAGE as u64) as u32;
    let slot_i = (post_count % POSTS_PER_PAGE as u64) as usize;
    let index = page_index.to_le_bytes();
    let seeds: [&[u8]; 3] = [b"posts", forum.address().as_ref(), &index];
    require_pda(page, &seeds, &ID)?;

    with_pod::<PostPage>(page, &POST_PAGE_DISC, |posts| {
        if posts.page_index != page_index {
            return Err(fail(WRONG_PAGE));
        }
        if posts.slots[slot_i].occupied != 0 {
            return Err(fail(NEED_NEW_PAGE));
        }
        let slot = &mut posts.slots[slot_i];
        slot.occupied = 1;
        slot.id = post_count;
        slot.author = author_key;
        slot.created_unix = now;
        slot.comment_count = 0;
        slot.title = title_bytes;
        slot.title_len = title_len;
        slot.arweave_id = ar_id;
        posts.filled = posts.filled.checked_add(1).ok_or(fail(OVERFLOW))?;
        Ok(())
    })?;

    let mut raw = forum.try_borrow_mut()?;
    let body = forum_body_mut(&mut raw)?;
    let next = post_count.checked_add(1).ok_or(fail(OVERFLOW))?;
    write_u64(body, forum_off::POST_COUNT, next)?;
    let pages_needed = page_index.saturating_add(1);
    if pages_needed > read_u32(body, forum_off::POST_PAGE_COUNT)? {
        write_u32(body, forum_off::POST_PAGE_COUNT, pages_needed)?;
    }
    Ok(())
}

fn create_comment(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut id_buf = [0u8; 8];
    id_buf.copy_from_slice(&data[..8]);
    let post_id = u64::from_le_bytes(id_buf);
    id_buf.copy_from_slice(&data[8..16]);
    let parent_comment_id = u64::from_le_bytes(id_buf);
    let (arweave, rest) = take_str(&data[16..])?;
    if !rest.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let author = acc(accounts, 0)?;
    let mint = acc(accounts, 1)?;
    let ata = acc(accounts, 2)?;
    let token_program = acc(accounts, 3)?;
    let forum = acc(accounts, 4)?;
    let post_page = acc(accounts, 5)?;
    let comment_page = acc(accounts, 6)?;
    signer(author)?;
    writable(forum)?;
    writable(post_page)?;
    writable(comment_page)?;
    owned(forum)?;
    owned(post_page)?;
    owned(comment_page)?;
    {
        let raw = forum.try_borrow()?;
        let body = forum_body(&raw)?;
        if body[forum_off::PAUSED] != 0 {
            return Err(fail(PAUSED));
        }
    }
    require_holder(author, mint, ata, token_program)?;
    let (post_count, comment_count) = {
        let raw = forum.try_borrow()?;
        let body = forum_body(&raw)?;
        if read_pubkey(body, forum_off::MINT)? != *mint.address().as_array() {
            return Err(fail(WRONG_MINT));
        }
        (
            read_u64(body, forum_off::POST_COUNT)?,
            read_u64(body, forum_off::COMMENT_COUNT)?,
        )
    };
    let ar_id = parse_arweave_id(arweave)?;
    let now = Clock::get()?.unix_timestamp;
    let author_key = *author.address().as_array();
    if post_id >= post_count {
        return Err(fail(UNKNOWN_POST));
    }
    let comment_id = comment_count.checked_add(1).ok_or(fail(OVERFLOW))?;
    if parent_comment_id != 0 && parent_comment_id >= comment_id {
        return Err(fail(UNKNOWN_POST));
    }
    let post_page_index = (post_id / POSTS_PER_PAGE as u64) as u32;
    let post_slot = (post_id % POSTS_PER_PAGE as u64) as usize;
    let cpage_index = (comment_count / COMMENTS_PER_PAGE as u64) as u32;
    let slot_i = (comment_count % COMMENTS_PER_PAGE as u64) as usize;

    let post_index = post_page_index.to_le_bytes();
    let post_seeds: [&[u8]; 3] = [b"posts", forum.address().as_ref(), &post_index];
    require_pda(post_page, &post_seeds, &ID)?;
    let comment_index = cpage_index.to_le_bytes();
    let comment_seeds: [&[u8]; 3] = [b"comments", forum.address().as_ref(), &comment_index];
    require_pda(comment_page, &comment_seeds, &ID)?;
    if parent_comment_id != 0 {
        let (parent_page_index, parent_slot) = comment_parent_pos(parent_comment_id)?;
        let parent_post = if parent_page_index == cpage_index {
            let raw = comment_page.try_borrow()?;
            comment_slot_post(&raw, parent_page_index, parent_slot)?
        } else {
            let extra = acc(accounts, 7)?;
            let index = parent_page_index.to_le_bytes();
            let seeds: [&[u8]; 3] = [b"comments", forum.address().as_ref(), &index];
            require_pda(extra, &seeds, &ID)?;
            let raw = extra.try_borrow()?;
            comment_slot_post(&raw, parent_page_index, parent_slot)?
        };
        if parent_post != post_id {
            return Err(fail(UNKNOWN_POST));
        }
    }

    with_pod::<PostPage>(post_page, &POST_PAGE_DISC, |posts| {
        if posts.page_index != post_page_index {
            return Err(fail(WRONG_PAGE));
        }
        if posts.slots[post_slot].occupied == 0 {
            return Err(fail(UNKNOWN_POST));
        }
        posts.slots[post_slot].comment_count = posts.slots[post_slot]
            .comment_count
            .checked_add(1)
            .ok_or(fail(OVERFLOW))?;
        Ok(())
    })?;
    with_pod::<CommentPage>(comment_page, &COMMENT_PAGE_DISC, |comments| {
        if comments.page_index != cpage_index {
            return Err(fail(WRONG_PAGE));
        }
        if comments.slots[slot_i].occupied != 0 {
            return Err(fail(NEED_NEW_PAGE));
        }
        let slot = &mut comments.slots[slot_i];
        slot.occupied = 1;
        slot.id = comment_id;
        slot.post_id = post_id;
        slot.parent_comment_id = parent_comment_id;
        slot.author = author_key;
        slot.created_unix = now;
        slot.arweave_id = ar_id;
        comments.filled = comments.filled.checked_add(1).ok_or(fail(OVERFLOW))?;
        Ok(())
    })?;

    let mut raw = forum.try_borrow_mut()?;
    let body = forum_body_mut(&mut raw)?;
    write_u64(body, forum_off::COMMENT_COUNT, comment_id)?;
    let pages_needed = cpage_index.saturating_add(1);
    if pages_needed > read_u32(body, forum_off::COMMENT_PAGE_COUNT)? {
        write_u32(body, forum_off::COMMENT_PAGE_COUNT, pages_needed)?;
    }
    Ok(())
}

fn maybe_commit(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if data.len() != 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut validator_bytes = [0u8; 32];
    validator_bytes.copy_from_slice(data);
    let validator = Address::new_from_array(validator_bytes);
    let caller = acc(accounts, 0)?;
    let forum = acc(accounts, 1)?;
    let treasury = acc(accounts, 2)?;
    let vault = acc(accounts, 3)?;
    let magic_program = acc(accounts, 4)?;
    let magic_context = acc(accounts, 5)?;
    signer(caller)?;
    writable(forum)?;
    writable(treasury)?;
    writable(vault)?;
    writable(magic_context)?;
    owned(forum)?;
    owned(treasury)?;
    if magic_context.address() != &MAGIC_CONTEXT_ID {
        return Err(ProgramError::InvalidAccountData);
    }
    let pages = accounts.get(6..).unwrap_or(&[]);

    let (post_count, comment_count, last_posts, last_comments, last_unix, mint) = {
        let raw = forum.try_borrow()?;
        let body = forum_body(&raw)?;
        (
            read_u64(body, forum_off::POST_COUNT)?,
            read_u64(body, forum_off::COMMENT_COUNT)?,
            read_u64(body, forum_off::LAST_COMMITTED_POSTS)?,
            read_u64(body, forum_off::LAST_COMMITTED_COMMENTS)?,
            read_i64(body, forum_off::LAST_COMMIT_UNIX)?,
            read_pubkey(body, forum_off::MINT)?,
        )
    };
    if post_count <= last_posts && comment_count <= last_comments {
        return Err(fail(NOTHING_TO_COMMIT));
    }
    let now = Clock::get()?.unix_timestamp;
    if last_unix != 0 && now.saturating_sub(last_unix) < COMMIT_COOLDOWN_SECS {
        return Err(fail(COMMIT_TOO_SOON));
    }
    let mint_addr = Address::new_from_array(mint);
    let forum_seeds: [&[u8]; 2] = [b"forum", mint_addr.as_ref()];
    let forum_bump = require_pda(forum, &forum_seeds, &ID)?;
    {
        let raw = forum.try_borrow()?;
        let body = forum_body(&raw)?;
        if body[forum_off::BUMP] != forum_bump {
            return Err(ProgramError::InvalidSeeds);
        }
    }
    let treasury_seeds: [&[u8]; 2] = [b"treasury", mint_addr.as_ref()];
    let treasury_bump = require_pda(treasury, &treasury_seeds, &ID)?;
    {
        let raw = treasury.try_borrow()?;
        if raw.len() < TREASURY_SIZE || raw[..8] != TREASURY_DISC {
            return Err(ProgramError::InvalidAccountData);
        }
        if raw[8 + treasury_off::BUMP] != treasury_bump {
            return Err(ProgramError::InvalidSeeds);
        }
    }

    let vault_seeds: [&[u8]; 2] = [b"magic-fee-vault", validator.as_ref()];
    let (expected_vault, _) = Address::try_find_program_address(&vault_seeds, &DELEGATION_ID)
        .ok_or(ProgramError::InvalidSeeds)?;
    if vault.address() != &expected_vault {
        return Err(fail(BAD_FEE_VAULT));
    }

    let post_bounds = dirty_page_bounds(last_posts, post_count, POSTS_PER_PAGE as u64);
    let comment_bounds = dirty_page_bounds(last_comments, comment_count, COMMENTS_PER_PAGE as u64);
    let post_prefix = match post_bounds {
        Some((start, end)) => take_prefix(pages, forum.address(), b"posts", start, end)?,
        None => PagePrefix::empty(),
    };
    let comment_prefix = match comment_bounds {
        Some((start, end)) => take_prefix(pages, forum.address(), b"comments", start, end)?,
        None => PagePrefix::empty(),
    };
    require_exact_pages(pages, &post_prefix.pdas, &comment_prefix.pdas)?;

    let new_posts = match post_bounds {
        Some((_, end)) => cursor_after(
            post_prefix.next,
            end,
            post_count,
            POSTS_PER_PAGE as u64,
            last_posts,
        )?,
        None => last_posts,
    };
    let new_comments = match comment_bounds {
        Some((_, end)) => cursor_after(
            comment_prefix.next,
            end,
            comment_count,
            COMMENTS_PER_PAGE as u64,
            last_comments,
        )?,
        None => last_comments,
    };
    if new_posts <= last_posts && new_comments <= last_comments {
        return Err(fail(WRONG_PAGE));
    }
    {
        let mut raw = forum.try_borrow_mut()?;
        let body = forum_body_mut(&mut raw)?;
        write_i64(body, forum_off::LAST_COMMIT_UNIX, now)?;
        write_u64(body, forum_off::LAST_COMMITTED_POSTS, new_posts)?;
        write_u64(body, forum_off::LAST_COMMITTED_COMMENTS, new_comments)?;
    }

    let mut commit_accs = Vec::with_capacity(2 + pages.len());
    commit_accs.push(forum);
    commit_accs.push(treasury);
    for page in pages {
        commit_accs.push(page);
    }
    magic::commit_accounts(
        treasury,
        magic_context,
        magic_program,
        vault,
        &commit_accs,
        &treasury_seeds,
        treasury_bump,
    )
}

struct PagePrefix {
    next: u32,
    pdas: Vec<[u8; 32]>,
}

impl PagePrefix {
    fn empty() -> Self {
        Self {
            next: 0,
            pdas: Vec::new(),
        }
    }
}

fn take_prefix(
    remaining: &[AccountView],
    forum: &Address,
    seed: &[u8],
    start: u32,
    end: u32,
) -> Result<PagePrefix, ProgramError> {
    let mut pdas = Vec::new();
    let mut idx = start;
    loop {
        let index = idx.to_le_bytes();
        let seeds: [&[u8]; 3] = [seed, forum.as_ref(), &index];
        let (pda, _) =
            Address::try_find_program_address(&seeds, &ID).ok_or(ProgramError::InvalidSeeds)?;
        let key = *pda.as_array();
        if !remaining.iter().any(|a| a.address().as_array() == &key) {
            return Ok(PagePrefix { next: idx, pdas });
        }
        pdas.push(key);
        if idx == end {
            return Ok(PagePrefix {
                next: idx.checked_add(1).ok_or(fail(OVERFLOW))?,
                pdas,
            });
        }
        idx = idx.checked_add(1).ok_or(fail(OVERFLOW))?;
    }
}

fn require_exact_pages(
    remaining: &[AccountView],
    posts: &[[u8; 32]],
    comments: &[[u8; 32]],
) -> Result<(), ProgramError> {
    if remaining.len() != posts.len().saturating_add(comments.len()) {
        return Err(fail(WRONG_PAGE));
    }
    let mut seen_posts = Vec::new();
    seen_posts.resize(posts.len(), false);
    let mut seen_comments = Vec::new();
    seen_comments.resize(comments.len(), false);
    for acc in remaining {
        let key = acc.address().as_array();
        if let Some(i) = posts.iter().position(|k| k == key) {
            if seen_posts[i] {
                return Err(fail(WRONG_PAGE));
            }
            seen_posts[i] = true;
            continue;
        }
        if let Some(i) = comments.iter().position(|k| k == key) {
            if seen_comments[i] {
                return Err(fail(WRONG_PAGE));
            }
            seen_comments[i] = true;
            continue;
        }
        return Err(fail(WRONG_PAGE));
    }
    Ok(())
}

fn init_page<T>(
    account: &AccountView,
    disc: &[u8; 8],
    forum: &Address,
    page_index: u32,
    bump: u8,
) -> ProgramResult
where
    T: Pod + Zeroable + PageHeader,
{
    let mut raw = account.try_borrow_mut()?;
    if raw.len() < 8 + core::mem::size_of::<T>() {
        return Err(ProgramError::InvalidAccountData);
    }
    raw[..8].copy_from_slice(disc);
    let page = bytemuck::try_from_bytes_mut::<T>(&mut raw[8..8 + core::mem::size_of::<T>()])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    page.set_header(*forum.as_array(), page_index, bump);
    Ok(())
}

trait PageHeader {
    fn set_header(&mut self, forum: [u8; 32], page_index: u32, bump: u8);
}

impl PageHeader for PostPage {
    fn set_header(&mut self, forum: [u8; 32], page_index: u32, bump: u8) {
        self.forum = forum;
        self.page_index = page_index;
        self.filled = 0;
        self.bump = bump;
    }
}

impl PageHeader for CommentPage {
    fn set_header(&mut self, forum: [u8; 32], page_index: u32, bump: u8) {
        self.forum = forum;
        self.page_index = page_index;
        self.filled = 0;
        self.bump = bump;
    }
}

fn with_pod<T: Pod>(
    account: &AccountView,
    disc: &[u8; 8],
    f: impl FnOnce(&mut T) -> ProgramResult,
) -> ProgramResult {
    let mut raw = account.try_borrow_mut()?;
    let size = 8 + core::mem::size_of::<T>();
    if raw.len() < size || raw[..8] != *disc {
        return Err(ProgramError::InvalidAccountData);
    }
    let value = bytemuck::try_from_bytes_mut::<T>(&mut raw[8..size])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    f(value)
}

fn forum_body(raw: &[u8]) -> Result<&[u8], ProgramError> {
    if raw.len() < FORUM_SIZE || raw[..8] != FORUM_DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(&raw[8..FORUM_SIZE])
}

fn forum_body_mut(raw: &mut [u8]) -> Result<&mut [u8], ProgramError> {
    if raw.len() < FORUM_SIZE || raw[..8] != FORUM_DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(&mut raw[8..FORUM_SIZE])
}

fn create_owned(
    payer: &AccountView,
    account: &AccountView,
    space: usize,
    seeds: &[&[u8]],
) -> Result<u8, ProgramError> {
    let (addr, bump) =
        Address::try_find_program_address(seeds, &ID).ok_or(ProgramError::InvalidSeeds)?;
    if account.address() != &addr {
        return Err(ProgramError::InvalidSeeds);
    }
    let bump_arr = [bump];
    let mut seed_buf = Vec::with_capacity(seeds.len() + 1);
    for seed in seeds {
        seed_buf.push(pinocchio::cpi::Seed::from(*seed));
    }
    seed_buf.push(pinocchio::cpi::Seed::from(bump_arr.as_slice()));
    let signers = [pinocchio::cpi::Signer::from(seed_buf.as_slice())];
    if account.lamports() == 0 {
        pinocchio_system::create_account_with_minimum_balance_signed(
            account,
            space,
            &ID,
            payer,
            None,
            &signers,
        )?;
        return Ok(bump);
    }
    // A transfer to the PDA before it exists leaves a system-owned empty
    // account. Adopt that. Anything else is already a real account.
    if !account.owned_by(&SYSTEM_ID) || account.data_len() != 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let need = Rent::get()?
        .try_minimum_balance(space)?
        .saturating_sub(account.lamports());
    if need > 0 {
        Transfer {
            from: payer,
            to: account,
            lamports: need,
        }
        .invoke()?;
    }
    Allocate {
        account,
        space: space as u64,
    }
    .invoke_signed(&signers)?;
    Assign {
        account,
        owner: &ID,
    }
    .invoke_signed(&signers)?;
    Ok(bump)
}

/// First delegate writes the validator. Later delegates must pass the same one.
fn bind_validator(
    payer: &AccountView,
    mint: &AccountView,
    record: &AccountView,
    validator: &Address,
) -> Result<(), ProgramError> {
    let seeds: [&[u8]; 2] = [b"validator", mint.address().as_ref()];
    if record.data_len() < VALIDATOR_RECORD_SIZE || record.lamports() == 0 {
        create_owned(payer, record, VALIDATOR_RECORD_SIZE, &seeds)?;
        let mut raw = record.try_borrow_mut()?;
        raw[..8].copy_from_slice(&VALIDATOR_DISC);
        raw[8..VALIDATOR_RECORD_SIZE].copy_from_slice(validator.as_ref());
        return Ok(());
    }
    let (addr, _) =
        Address::try_find_program_address(&seeds, &ID).ok_or(ProgramError::InvalidSeeds)?;
    if record.address() != &addr || !record.owned_by(&ID) {
        return Err(ProgramError::InvalidSeeds);
    }
    let raw = record.try_borrow()?;
    if raw.len() < VALIDATOR_RECORD_SIZE || raw[..8] != VALIDATOR_DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    if &raw[8..VALIDATOR_RECORD_SIZE] != validator.as_ref() {
        return Err(ProgramError::InvalidArgument);
    }
    Ok(())
}

fn comment_parent_pos(parent_id: u64) -> Result<(u32, usize), ProgramError> {
    let index0 = parent_id.checked_sub(1).ok_or(fail(UNKNOWN_POST))?;
    Ok((
        (index0 / COMMENTS_PER_PAGE as u64) as u32,
        (index0 % COMMENTS_PER_PAGE as u64) as usize,
    ))
}

fn comment_slot_post(raw: &[u8], page_index: u32, slot_i: usize) -> Result<u64, ProgramError> {
    let size = 8 + core::mem::size_of::<CommentPage>();
    if raw.len() < size || raw[..8] != COMMENT_PAGE_DISC {
        return Err(ProgramError::InvalidAccountData);
    }
    let page = bytemuck::try_from_bytes::<CommentPage>(&raw[8..size])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    if page.page_index != page_index {
        return Err(fail(WRONG_PAGE));
    }
    let slot = page
        .slots
        .get(slot_i)
        .ok_or(ProgramError::InvalidAccountData)?;
    if slot.occupied == 0 {
        return Err(fail(UNKNOWN_POST));
    }
    Ok(slot.post_id)
}

fn require_pda(account: &AccountView, seeds: &[&[u8]], program: &Address) -> Result<u8, ProgramError> {
    let (addr, bump) =
        Address::try_find_program_address(seeds, program).ok_or(ProgramError::InvalidSeeds)?;
    if account.address() != &addr {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}

fn require_holder(
    author: &AccountView,
    mint: &AccountView,
    ata: &AccountView,
    token_program: &AccountView,
) -> ProgramResult {
    let program = token_program.address();
    if program != &TOKEN_ID && program != &TOKEN_2022_ID {
        return Err(fail(WRONG_MINT));
    }
    if !mint.owned_by(program) || !ata.owned_by(program) {
        return Err(fail(WRONG_MINT));
    }
    let data = ata.try_borrow()?;
    if data.len() < TOKEN_ACCOUNT_LEN {
        return Err(fail(NOT_A_HOLDER));
    }
    if data[..32] != *mint.address().as_ref() {
        return Err(fail(WRONG_MINT));
    }
    if data[32..64] != *author.address().as_ref() {
        return Err(fail(NOT_A_HOLDER));
    }
    let mut amount = [0u8; 8];
    amount.copy_from_slice(&data[64..72]);
    if u64::from_le_bytes(amount) == 0 || data[TOKEN_STATE_OFFSET] == 0 {
        return Err(fail(NOT_A_HOLDER));
    }
    Ok(())
}

fn acc(accounts: &[AccountView], i: usize) -> Result<&AccountView, ProgramError> {
    accounts.get(i).ok_or(ProgramError::NotEnoughAccountKeys)
}

fn signer(account: &AccountView) -> ProgramResult {
    if account.is_signer() {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
}

fn writable(account: &AccountView) -> ProgramResult {
    if account.is_writable() {
        Ok(())
    } else {
        Err(ProgramError::InvalidArgument)
    }
}

fn owned(account: &AccountView) -> ProgramResult {
    if account.owned_by(&ID) {
        Ok(())
    } else {
        Err(ProgramError::IncorrectProgramId)
    }
}

fn read_u32_exact(data: &[u8]) -> Result<u32, ProgramError> {
    if data.len() != 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut buf = [0u8; 4];
    buf.copy_from_slice(data);
    Ok(u32::from_le_bytes(buf))
}

fn take_str(data: &[u8]) -> Result<(&str, &[u8]), ProgramError> {
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut buf = [0u8; 4];
    buf.copy_from_slice(&data[..4]);
    let len = u32::from_le_bytes(buf) as usize;
    let rest = data.get(4..).ok_or(ProgramError::InvalidInstructionData)?;
    if rest.len() < len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let text = core::str::from_utf8(&rest[..len]).map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok((text, &rest[len..]))
}

#[cfg(test)]
mod layout_tests {
    use super::*;
    extern crate sha2;
    use sha2::{Digest, Sha256};

    fn disc(name: &str) -> [u8; 8] {
        let hash = Sha256::digest(name.as_bytes());
        let mut out = [0u8; 8];
        out.copy_from_slice(&hash[..8]);
        out
    }

    #[test]
    fn account_discriminators_match_anchor() {
        assert_eq!(disc("account:Forum"), FORUM_DISC);
        assert_eq!(disc("account:Treasury"), TREASURY_DISC);
        assert_eq!(disc("account:PostPage"), POST_PAGE_DISC);
        assert_eq!(disc("account:CommentPage"), COMMENT_PAGE_DISC);
        assert_eq!(disc("global:initialize"), IX_INITIALIZE);
        assert_eq!(disc("global:process_undelegation"), IX_PROCESS_UNDELEGATION);
        assert_eq!(disc("global:maybe_commit"), IX_MAYBE_COMMIT);
        assert_eq!(disc("account:ErValidator"), VALIDATOR_DISC);
    }

    #[test]
    fn comment_parent_sits_on_the_previous_index() {
        assert_eq!(comment_parent_pos(1).unwrap(), (0, 0));
        assert_eq!(comment_parent_pos(32).unwrap(), (0, 31));
        assert_eq!(comment_parent_pos(33).unwrap(), (1, 0));
    }

    #[test]
    fn cursor_does_not_move_backwards() {
        assert_eq!(dirty_page_bounds(0, 0, 32), None);
        assert_eq!(dirty_page_bounds(0, 33, 32), Some((0, 1)));
        assert_eq!(cursor_after(2, 1, 40, 32, 0).unwrap(), 40);
        assert_eq!(cursor_after(1, 1, 40, 32, 5).unwrap(), 32);
    }
}
