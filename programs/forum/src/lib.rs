//! Holder forum: on-chain ids + Arweave bodies, executed on MagicBlock ER
//! after a one-time L1 initialize + delegate.
//!
//! Large page accounts use Anchor zero-copy (`AccountLoader`) so they never
//! land on the 4 KiB SBF stack ([Solana FAQ](https://solana.com/docs/programs/faq)).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

mod state;
use state::*;

declare_id!("Eq1XL63knJE6UvdQJaWBTt2JrYzsgf3bdqafBkmb9XwG");

#[ephemeral]
#[program]
pub mod holder_forum {
    use super::*;

    /// First holder pays L1 rent once: Forum + Treasury + page 0s.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        require!(ctx.accounts.author_ata.amount > 0, ForumError::NotAHolder);
        require!(
            ctx.accounts.mint.key() == ctx.accounts.author_ata.mint,
            ForumError::WrongMint
        );

        let forum_key = ctx.accounts.forum.key();

        let forum = &mut ctx.accounts.forum;
        forum.mint = ctx.accounts.mint.key();
        forum.token_program = ctx.accounts.token_program.key();
        forum.post_count = 0;
        forum.comment_count = 0;
        forum.post_page_count = 1;
        forum.comment_page_count = 1;
        forum.last_commit_unix = 0;
        forum.last_committed_posts = 0;
        forum.last_committed_comments = 0;
        forum.paused = false;
        forum.bump = ctx.bumps.forum;

        let treasury = &mut ctx.accounts.treasury;
        treasury.forum = forum_key;
        treasury.bump = ctx.bumps.treasury;

        // load_init zeroes + sets discriminator. Slots stay unoccupied.
        let mut posts = ctx.accounts.post_page.load_init()?;
        posts.forum = forum_key;
        posts.page_index = 0;
        posts.filled = 0;
        posts.bump = ctx.bumps.post_page;

        let mut comments = ctx.accounts.comment_page.load_init()?;
        comments.forum = forum_key;
        comments.page_index = 0;
        comments.filled = 0;
        comments.bump = ctx.bumps.comment_page;
        Ok(())
    }

    pub fn delegate_forum(ctx: Context<DelegateForum>) -> Result<()> {
        ctx.accounts.delegate_forum(
            &ctx.accounts.payer,
            &[b"forum", ctx.accounts.mint.key().as_ref()],
            delegate_cfg(&ctx.remaining_accounts),
        )?;
        Ok(())
    }

    pub fn delegate_treasury(ctx: Context<DelegateTreasury>) -> Result<()> {
        ctx.accounts.delegate_treasury(
            &ctx.accounts.payer,
            &[b"treasury", ctx.accounts.mint.key().as_ref()],
            delegate_cfg(&ctx.remaining_accounts),
        )?;
        Ok(())
    }

    pub fn delegate_post_page(ctx: Context<DelegatePostPage>, page_index: u32) -> Result<()> {
        let idx = page_index.to_le_bytes();
        ctx.accounts.delegate_post_page(
            &ctx.accounts.payer,
            &[b"posts", ctx.accounts.forum.key().as_ref(), idx.as_ref()],
            delegate_cfg(&ctx.remaining_accounts),
        )?;
        Ok(())
    }

    pub fn delegate_comment_page(ctx: Context<DelegateCommentPage>, page_index: u32) -> Result<()> {
        let idx = page_index.to_le_bytes();
        ctx.accounts.delegate_comment_page(
            &ctx.accounts.payer,
            &[
                b"comments",
                ctx.accounts.forum.key().as_ref(),
                idx.as_ref(),
            ],
            delegate_cfg(&ctx.remaining_accounts),
        )?;
        Ok(())
    }

    /// L1: allocate a post page. Does **not** write Forum (Forum is delegated).
    pub fn open_post_page(ctx: Context<OpenPostPage>, page_index: u32) -> Result<()> {
        require!(ctx.accounts.author_ata.amount > 0, ForumError::NotAHolder);
        require!(page_index > 0, ForumError::WrongPage);
        let mut posts = ctx.accounts.post_page.load_init()?;
        posts.forum = ctx.accounts.forum.key();
        posts.page_index = page_index;
        posts.filled = 0;
        posts.bump = ctx.bumps.post_page;
        Ok(())
    }

    pub fn open_comment_page(ctx: Context<OpenCommentPage>, page_index: u32) -> Result<()> {
        require!(ctx.accounts.author_ata.amount > 0, ForumError::NotAHolder);
        require!(page_index > 0, ForumError::WrongPage);
        let mut comments = ctx.accounts.comment_page.load_init()?;
        comments.forum = ctx.accounts.forum.key();
        comments.page_index = page_index;
        comments.filled = 0;
        comments.bump = ctx.bumps.comment_page;
        Ok(())
    }

    /// ER: append a post slot. Body is already on Arweave.
    pub fn create_post(ctx: Context<CreatePost>, title: String, arweave_id: String) -> Result<()> {
        require!(!ctx.accounts.forum.paused, ForumError::Paused);
        require!(ctx.accounts.author_ata.amount > 0, ForumError::NotAHolder);
        require!(
            ctx.accounts.forum.mint == ctx.accounts.mint.key(),
            ForumError::WrongMint
        );
        require!(!title.trim().is_empty(), ForumError::TitleRequired);

        let page_index = (ctx.accounts.forum.post_count / POSTS_PER_PAGE as u64) as u32;
        let slot_i = (ctx.accounts.forum.post_count % POSTS_PER_PAGE as u64) as usize;
        let post_id = ctx.accounts.forum.post_count;
        let author = ctx.accounts.author.key();

        let (title_bytes, title_len) = encode_title(title.trim())?;
        let ar_id = parse_arweave_id(&arweave_id)?;
        let now = Clock::get()?.unix_timestamp;

        {
            let mut posts = ctx.accounts.post_page.load_mut()?;
            require!(posts.page_index == page_index, ForumError::WrongPage);
            require!(!posts.slots[slot_i].is_occupied(), ForumError::NeedNewPage);

            let slot = &mut posts.slots[slot_i];
            slot.occupied = 1;
            slot.id = post_id;
            slot.author = author;
            slot.created_unix = now;
            slot.comment_count = 0;
            slot.title = title_bytes;
            slot.title_len = title_len;
            slot.arweave_id = ar_id;
            posts.filled = posts.filled.checked_add(1).ok_or(ForumError::Overflow)?;
        }

        let forum = &mut ctx.accounts.forum;
        forum.post_count = forum
            .post_count
            .checked_add(1)
            .ok_or(ForumError::Overflow)?;
        let pages_needed = page_index.saturating_add(1);
        if pages_needed > forum.post_page_count {
            forum.post_page_count = pages_needed;
        }
        Ok(())
    }

    /// ER: append a comment. `parent_comment_id` 0 = reply to the post.
    /// Comment ids are 1-based so a reply to the first comment is unambiguous.
    pub fn create_comment(
        ctx: Context<CreateComment>,
        post_id: u64,
        parent_comment_id: u64,
        arweave_id: String,
    ) -> Result<()> {
        require!(!ctx.accounts.forum.paused, ForumError::Paused);
        require!(ctx.accounts.author_ata.amount > 0, ForumError::NotAHolder);
        require!(
            ctx.accounts.forum.mint == ctx.accounts.mint.key(),
            ForumError::WrongMint
        );
        require!(
            post_id < ctx.accounts.forum.post_count,
            ForumError::UnknownPost
        );

        let post_page_index = (post_id / POSTS_PER_PAGE as u64) as u32;
        let post_slot = (post_id % POSTS_PER_PAGE as u64) as usize;
        let cpage_index = (ctx.accounts.forum.comment_count / COMMENTS_PER_PAGE as u64) as u32;
        let slot_i = (ctx.accounts.forum.comment_count % COMMENTS_PER_PAGE as u64) as usize;
        // 1-based ids so parent_comment_id=0 stays unambiguous ("reply to post").
        let comment_id = ctx
            .accounts
            .forum
            .comment_count
            .checked_add(1)
            .ok_or(ForumError::Overflow)?;
        if parent_comment_id != 0 {
            require!(
                parent_comment_id < comment_id,
                ForumError::UnknownPost
            );
        }
        let author = ctx.accounts.author.key();

        let ar_id = parse_arweave_id(&arweave_id)?;
        let now = Clock::get()?.unix_timestamp;

        {
            let mut posts = ctx.accounts.post_page.load_mut()?;
            require!(posts.page_index == post_page_index, ForumError::WrongPage);
            require!(posts.slots[post_slot].is_occupied(), ForumError::UnknownPost);
            posts.slots[post_slot].comment_count = posts.slots[post_slot]
                .comment_count
                .checked_add(1)
                .ok_or(ForumError::Overflow)?;
        }

        {
            let mut comments = ctx.accounts.comment_page.load_mut()?;
            require!(comments.page_index == cpage_index, ForumError::WrongPage);
            require!(!comments.slots[slot_i].is_occupied(), ForumError::NeedNewPage);

            let slot = &mut comments.slots[slot_i];
            slot.occupied = 1;
            slot.id = comment_id;
            slot.post_id = post_id;
            slot.parent_comment_id = parent_comment_id;
            slot.author = author;
            slot.created_unix = now;
            slot.arweave_id = ar_id;
            comments.filled = comments.filled.checked_add(1).ok_or(ForumError::Overflow)?;
        }

        let forum = &mut ctx.accounts.forum;
        forum.comment_count = forum
            .comment_count
            .checked_add(1)
            .ok_or(ForumError::Overflow)?;
        let pages_needed = cpage_index.saturating_add(1);
        if pages_needed > forum.comment_page_count {
            forum.comment_page_count = pages_needed;
        }
        Ok(())
    }

    /// ER: dirty-only commit. Treasury PDA is the intent payer (no hot key).
    pub fn maybe_commit<'a>(ctx: Context<'a, MaybeCommit<'a>>) -> Result<()> {
        let forum = &mut ctx.accounts.forum;
        let dirty = forum.post_count > forum.last_committed_posts
            || forum.comment_count > forum.last_committed_comments;
        require!(dirty, ForumError::NothingToCommit);

        let now = Clock::get()?.unix_timestamp;
        if forum.last_commit_unix != 0 {
            require!(
                now.saturating_sub(forum.last_commit_unix) >= COMMIT_COOLDOWN_SECS,
                ForumError::CommitTooSoon
            );
        }

        forum.last_commit_unix = now;
        forum.last_committed_posts = forum.post_count;
        forum.last_committed_comments = forum.comment_count;
        forum.exit(&crate::ID)?;

        let treasury_info = ctx.accounts.treasury.to_account_info();
        let vault_info = ctx.accounts.magic_fee_vault.to_account_info();
        let magic_context = ctx.accounts.magic_context.to_account_info();
        let magic_program = ctx.accounts.magic_program.to_account_info();
        let mut accs = vec![
            ctx.accounts.forum.to_account_info(),
            treasury_info.clone(),
        ];
        for extra in ctx.remaining_accounts.iter() {
            accs.push(extra.clone());
        }

        MagicIntentBundleBuilder::new(treasury_info, magic_context, magic_program)
            .magic_fee_vault(vault_info)
            .commit(&accs)
            .build_and_invoke()?;
        Ok(())
    }
}

fn delegate_cfg(remaining: &[AccountInfo]) -> DelegateConfig {
    DelegateConfig {
        validator: remaining.first().map(|a| a.key()),
        commit_frequency_ms: COMMIT_FREQUENCY_MS,
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub author: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
        token::authority = author,
        token::token_program = token_program,
        constraint = author_ata.amount > 0 @ ForumError::NotAHolder,
    )]
    pub author_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(
        init,
        payer = author,
        space = Forum::SIZE,
        seeds = [b"forum", mint.key().as_ref()],
        bump,
    )]
    pub forum: Account<'info, Forum>,
    #[account(
        init,
        payer = author,
        space = Treasury::SIZE,
        seeds = [b"treasury", mint.key().as_ref()],
        bump,
    )]
    pub treasury: Account<'info, Treasury>,
    #[account(
        init,
        payer = author,
        space = PostPage::SIZE,
        seeds = [b"posts", forum.key().as_ref(), &[0, 0, 0, 0]],
        bump,
    )]
    pub post_page: AccountLoader<'info, PostPage>,
    #[account(
        init,
        payer = author,
        space = CommentPage::SIZE,
        seeds = [b"comments", forum.key().as_ref(), &[0, 0, 0, 0]],
        bump,
    )]
    pub comment_page: AccountLoader<'info, CommentPage>,
    pub system_program: Program<'info, System>,
}

/// Delegate contexts MUST type the `del` account as `UncheckedAccount` /
/// `AccountInfo`, not `Account<'info, T>`.
///
/// After the Delegation Program CPI succeeds, L1 owner is DLP. Anchor
/// `Account::exit` still serializes via `T::owner() == program_id` (it does
/// not check `info.owner`), which trips
/// `instruction modified data of an account it does not own`.
/// Official pattern: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/anchor
#[delegate]
#[derive(Accounts)]
pub struct DelegateForum<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: mint seed
    pub mint: UncheckedAccount<'info>,
    /// CHECK: PDA handed to DLP; do not deserialize/serialize on exit.
    #[account(mut, del, seeds = [b"forum", mint.key().as_ref()], bump)]
    pub forum: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateTreasury<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: mint seed
    pub mint: UncheckedAccount<'info>,
    /// CHECK: PDA handed to DLP; do not deserialize/serialize on exit.
    #[account(mut, del, seeds = [b"treasury", mint.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(page_index: u32)]
pub struct DelegatePostPage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: mint seed
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Forum is already delegated (L1 owner = Delegation Program).
    #[account(seeds = [b"forum", mint.key().as_ref()], bump)]
    pub forum: UncheckedAccount<'info>,
    /// CHECK: page PDA; address-only for delegate CPI (no zero-copy load on L1).
    #[account(
        mut,
        del,
        seeds = [b"posts", forum.key().as_ref(), &page_index.to_le_bytes()],
        bump,
    )]
    pub post_page: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(page_index: u32)]
pub struct DelegateCommentPage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: mint seed
    pub mint: UncheckedAccount<'info>,
    /// CHECK: Forum is already delegated (L1 owner = Delegation Program).
    #[account(seeds = [b"forum", mint.key().as_ref()], bump)]
    pub forum: UncheckedAccount<'info>,
    /// CHECK: page PDA; address-only for delegate CPI (no zero-copy load on L1).
    #[account(
        mut,
        del,
        seeds = [b"comments", forum.key().as_ref(), &page_index.to_le_bytes()],
        bump,
    )]
    pub comment_page: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(page_index: u32)]
pub struct OpenPostPage<'info> {
    #[account(mut)]
    pub author: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
        token::authority = author,
        token::token_program = token_program,
        constraint = author_ata.amount > 0 @ ForumError::NotAHolder,
    )]
    pub author_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: address-only. Forum is delegated so L1 owner is DLP, not us.
    #[account(seeds = [b"forum", mint.key().as_ref()], bump)]
    pub forum: UncheckedAccount<'info>,
    #[account(
        init,
        payer = author,
        space = PostPage::SIZE,
        seeds = [b"posts", forum.key().as_ref(), &page_index.to_le_bytes()],
        bump,
    )]
    pub post_page: AccountLoader<'info, PostPage>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(page_index: u32)]
pub struct OpenCommentPage<'info> {
    #[account(mut)]
    pub author: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
        token::authority = author,
        token::token_program = token_program,
        constraint = author_ata.amount > 0 @ ForumError::NotAHolder,
    )]
    pub author_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: address-only. Forum is delegated so L1 owner is DLP, not us.
    #[account(seeds = [b"forum", mint.key().as_ref()], bump)]
    pub forum: UncheckedAccount<'info>,
    #[account(
        init,
        payer = author,
        space = CommentPage::SIZE,
        seeds = [b"comments", forum.key().as_ref(), &page_index.to_le_bytes()],
        bump,
    )]
    pub comment_page: AccountLoader<'info, CommentPage>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreatePost<'info> {
    pub author: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
        token::authority = author,
        token::token_program = token_program,
        constraint = author_ata.amount > 0 @ ForumError::NotAHolder,
    )]
    pub author_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [b"forum", mint.key().as_ref()], bump = forum.bump)]
    pub forum: Account<'info, Forum>,
    #[account(
        mut,
        seeds = [
            b"posts",
            forum.key().as_ref(),
            &((forum.post_count / POSTS_PER_PAGE as u64) as u32).to_le_bytes()
        ],
        bump,
    )]
    pub post_page: AccountLoader<'info, PostPage>,
}

#[derive(Accounts)]
#[instruction(post_id: u64)]
pub struct CreateComment<'info> {
    pub author: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        token::mint = mint,
        token::authority = author,
        token::token_program = token_program,
        constraint = author_ata.amount > 0 @ ForumError::NotAHolder,
    )]
    pub author_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [b"forum", mint.key().as_ref()], bump = forum.bump)]
    pub forum: Account<'info, Forum>,
    #[account(
        mut,
        seeds = [
            b"posts",
            forum.key().as_ref(),
            &((post_id / POSTS_PER_PAGE as u64) as u32).to_le_bytes()
        ],
        bump,
    )]
    pub post_page: AccountLoader<'info, PostPage>,
    #[account(
        mut,
        seeds = [
            b"comments",
            forum.key().as_ref(),
            &((forum.comment_count / COMMENTS_PER_PAGE as u64) as u32).to_le_bytes()
        ],
        bump,
    )]
    pub comment_page: AccountLoader<'info, CommentPage>,
}

#[commit]
#[derive(Accounts)]
pub struct MaybeCommit<'info> {
    /// Permissionless — any wallet may crank a dirty forum.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"forum", forum.mint.as_ref()], bump = forum.bump)]
    pub forum: Account<'info, Forum>,
    /// Delegated SOL bag: MagicBlock intent payer. No private key.
    #[account(mut, seeds = [b"treasury", forum.mint.as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    /// CHECK: Delegation Program PDA `["magic-fee-vault", validator]`.
    #[account(mut)]
    pub magic_fee_vault: UncheckedAccount<'info>,
}

#[error_code]
pub enum ForumError {
    #[msg("Wallet does not hold this token")]
    NotAHolder,
    #[msg("Mint does not match this forum")]
    WrongMint,
    #[msg("Title is required")]
    TitleRequired,
    #[msg("Title is too long")]
    TitleTooLong,
    #[msg("Arweave id must be 43-char base64url")]
    BadArweaveId,
    #[msg("Wrong page account for this id")]
    WrongPage,
    #[msg("Current page is full — open a new page first")]
    NeedNewPage,
    #[msg("Unknown post")]
    UnknownPost,
    #[msg("Forum is paused")]
    Paused,
    #[msg("Nothing new to commit")]
    NothingToCommit,
    #[msg("Commit cooldown has not elapsed")]
    CommitTooSoon,
    #[msg("Overflow")]
    Overflow,
}
