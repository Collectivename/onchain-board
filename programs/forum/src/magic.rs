//! Delegation and commit CPIs. The bytes match ephemeral-rollups-sdk 0.16:
//! delegate is Delegation Program discriminator `0` plus Borsh
//! `DelegateAccountArgs`; commit is Magic Program `ScheduleIntentBundle`
//! (bincode variant 11) with a standalone commit and no callbacks.

use alloc::vec::Vec;
use pinocchio::{
    cpi::{invoke_signed, invoke_signed_with_slice, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address,
};
use pinocchio_system::instructions::{Allocate, Assign, CreateAccount, Transfer};

use crate::ids::{DELEGATION_ID, MAGIC_ID, SYSTEM_ID};
use crate::state::{fail, COMMIT_FREQUENCY_MS, OVERFLOW};

const MAX_COMMIT_ACCOUNTS: usize = 64;

/// `ScheduleIntentBundle` as bincode encodes it for a standalone commit.
pub fn encode_schedule_commit(indices: &[u8], out: &mut [u8]) -> Result<usize, ProgramError> {
    let need = 4 + 1 + 4 + 8 + indices.len() + 3 + 8;
    if out.len() < need {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut o = 0;
    out[o..o + 4].copy_from_slice(&11u32.to_le_bytes());
    o += 4;
    out[o] = 1;
    o += 1;
    out[o..o + 4].copy_from_slice(&0u32.to_le_bytes());
    o += 4;
    out[o..o + 8].copy_from_slice(&(indices.len() as u64).to_le_bytes());
    o += 8;
    out[o..o + indices.len()].copy_from_slice(indices);
    o += indices.len();
    out[o] = 0;
    o += 1;
    out[o] = 0;
    o += 1;
    out[o] = 0;
    o += 1;
    out[o..o + 8].copy_from_slice(&0u64.to_le_bytes());
    o += 8;
    Ok(o)
}

fn encode_delegate_data(
    seeds: &[&[u8]],
    validator: Option<&Address>,
    out: &mut [u8],
) -> Result<usize, ProgramError> {
    let mut body = 8 + 4 + 4;
    for seed in seeds {
        body += 4 + seed.len();
    }
    body += 1;
    if validator.is_some() {
        body += 32;
    }
    if out.len() < body {
        return Err(ProgramError::InvalidInstructionData);
    }
    out[..8].fill(0);
    let mut o = 8;
    out[o..o + 4].copy_from_slice(&COMMIT_FREQUENCY_MS.to_le_bytes());
    o += 4;
    out[o..o + 4].copy_from_slice(&(seeds.len() as u32).to_le_bytes());
    o += 4;
    for seed in seeds {
        out[o..o + 4].copy_from_slice(&(seed.len() as u32).to_le_bytes());
        o += 4;
        out[o..o + seed.len()].copy_from_slice(seed);
        o += seed.len();
    }
    if let Some(validator) = validator {
        out[o] = 1;
        o += 1;
        out[o..o + 32].copy_from_slice(validator.as_ref());
        o += 32;
    } else {
        out[o] = 0;
        o += 1;
    }
    Ok(o)
}

fn signer_seeds<'a>(seeds: &'a [&'a [u8]], bump: &'a [u8; 1]) -> Vec<Seed<'a>> {
    let mut out = Vec::with_capacity(seeds.len() + 1);
    for seed in seeds {
        out.push(Seed::from(*seed));
    }
    out.push(Seed::from(bump.as_slice()));
    out
}

/// Same as the SDK `create_pda`: rent-exempt only when asked, otherwise a
/// zero-lamport account. Existing accounts are allocated and assigned.
fn create_pda(
    target: &AccountView,
    owner: &Address,
    space: usize,
    seeds: &[&[u8]],
    bump: u8,
    system_program: &AccountView,
    payer: &AccountView,
    rent_exempt: bool,
) -> Result<(), ProgramError> {
    let _ = system_program;
    let bump_arr = [bump];
    let seed_buf = signer_seeds(seeds, &bump_arr);
    let signers = [Signer::from(seed_buf.as_slice())];
    if target.lamports() == 0 {
        let lamports = if rent_exempt {
            Rent::get()?.try_minimum_balance(space)?
        } else {
            0
        };
        CreateAccount {
            from: payer,
            to: target,
            lamports,
            space: space as u64,
            owner,
        }
        .invoke_signed(&signers)
    } else {
        if rent_exempt {
            let need = Rent::get()?
                .try_minimum_balance(space)?
                .saturating_sub(target.lamports());
            if need > 0 {
                Transfer {
                    from: payer,
                    to: target,
                    lamports: need,
                }
                .invoke()?;
            }
        }
        Allocate {
            account: target,
            space: space as u64,
        }
        .invoke_signed(&signers)?;
        Assign {
            account: target,
            owner,
        }
        .invoke_signed(&signers)
    }
}

fn close_buffer(
    buffer: &AccountView,
    seeds: &[&[u8]],
    bump: u8,
    destination: &AccountView,
    system_program: &AccountView,
) -> Result<(), ProgramError> {
    let _ = system_program;
    buffer.resize(0)?;
    unsafe { buffer.assign(&SYSTEM_ID) };
    if buffer.lamports() > 0 {
        let bump_arr = [bump];
        let seed_buf = signer_seeds(seeds, &bump_arr);
        let signers = [Signer::from(seed_buf.as_slice())];
        Transfer {
            from: buffer,
            to: destination,
            lamports: buffer.lamports(),
        }
        .invoke_signed(&signers)?;
    }
    Ok(())
}

#[inline(never)]
fn cpi_delegate(
    payer: &AccountView,
    pda: &AccountView,
    owner_program: &AccountView,
    buffer: &AccountView,
    record: &AccountView,
    metadata: &AccountView,
    system_program: &AccountView,
    pda_seeds: &[&[u8]],
    bump: u8,
    validator: Option<&Address>,
) -> Result<(), ProgramError> {
    let mut data = [0u8; 192];
    let len = encode_delegate_data(pda_seeds, validator, &mut data)?;
    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable_signer(pda.address()),
        InstructionAccount::readonly(owner_program.address()),
        InstructionAccount::writable(buffer.address()),
        InstructionAccount::writable(record.address()),
        InstructionAccount::writable(metadata.address()),
        InstructionAccount::readonly(system_program.address()),
    ];
    let ix = InstructionView {
        program_id: &DELEGATION_ID,
        accounts: &metas,
        data: &data[..len],
    };
    let bump_arr = [bump];
    let seed_buf = signer_seeds(pda_seeds, &bump_arr);
    let signers = [Signer::from(seed_buf.as_slice())];
    invoke_signed(
        &ix,
        &[
            payer,
            pda,
            owner_program,
            buffer,
            record,
            metadata,
            system_program,
        ],
        &signers,
    )
}

/// Hand the PDA to the Delegation Program. Buffer, record, and metadata are
/// the accounts `#[delegate]` inserts around the delegated account.
pub fn delegate_account(
    payer: &AccountView,
    pda: &AccountView,
    owner_program: &AccountView,
    buffer: &AccountView,
    record: &AccountView,
    metadata: &AccountView,
    delegation_program: &AccountView,
    system_program: &AccountView,
    pda_seeds: &[&[u8]],
    validator: Option<&Address>,
) -> Result<(), ProgramError> {
    if owner_program.address() != &crate::ids::ID
        || delegation_program.address() != &DELEGATION_ID
        || system_program.address() != &SYSTEM_ID
    {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (pda_addr, pda_bump) =
        Address::try_find_program_address(pda_seeds, owner_program.address())
            .ok_or(ProgramError::InvalidSeeds)?;
    if pda.address() != &pda_addr {
        return Err(ProgramError::InvalidSeeds);
    }
    let buffer_seeds: [&[u8]; 2] = [b"buffer", pda.address().as_ref()];
    let (buffer_addr, buffer_bump) =
        Address::try_find_program_address(&buffer_seeds, owner_program.address())
            .ok_or(ProgramError::InvalidSeeds)?;
    if buffer.address() != &buffer_addr {
        return Err(ProgramError::InvalidSeeds);
    }
    let record_seeds: [&[u8]; 2] = [b"delegation", pda.address().as_ref()];
    let (record_addr, _) =
        Address::try_find_program_address(&record_seeds, &DELEGATION_ID)
            .ok_or(ProgramError::InvalidSeeds)?;
    if record.address() != &record_addr {
        return Err(ProgramError::InvalidSeeds);
    }
    let meta_seeds: [&[u8]; 2] = [b"delegation-metadata", pda.address().as_ref()];
    let (meta_addr, _) = Address::try_find_program_address(&meta_seeds, &DELEGATION_ID)
        .ok_or(ProgramError::InvalidSeeds)?;
    if metadata.address() != &meta_addr {
        return Err(ProgramError::InvalidSeeds);
    }

    let data_len = pda.data_len();
    create_pda(
        buffer,
        owner_program.address(),
        data_len,
        &buffer_seeds,
        buffer_bump,
        system_program,
        payer,
        false,
    )?;
    {
        let src = pda.try_borrow()?;
        let mut dst = buffer.try_borrow_mut()?;
        if src.len() < data_len || dst.len() < data_len {
            return Err(ProgramError::InvalidAccountData);
        }
        dst[..data_len].copy_from_slice(&src[..data_len]);
    }
    {
        let mut body = pda.try_borrow_mut()?;
        body[..data_len].fill(0);
    }
    if !pda.owned_by(&SYSTEM_ID) {
        unsafe { pda.assign(&SYSTEM_ID) };
    }
    if !pda.owned_by(&DELEGATION_ID) {
        let bump_arr = [pda_bump];
        let seed_buf = signer_seeds(pda_seeds, &bump_arr);
        let signers = [Signer::from(seed_buf.as_slice())];
        Assign {
            account: pda,
            owner: &DELEGATION_ID,
        }
        .invoke_signed(&signers)?;
    }
    cpi_delegate(
        payer,
        pda,
        owner_program,
        buffer,
        record,
        metadata,
        system_program,
        pda_seeds,
        pda_bump,
        validator,
    )?;
    close_buffer(buffer, &buffer_seeds, buffer_bump, payer, system_program)
}

/// `process_undelegation`: copy the canonical undelegate buffer back onto the PDA.
pub fn process_undelegation(
    delegated: &AccountView,
    buffer: &AccountView,
    payer: &AccountView,
    system_program: &AccountView,
    account_seeds: &[Vec<u8>],
) -> Result<(), ProgramError> {
    if !buffer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !buffer.owned_by(&DELEGATION_ID) || system_program.address() != &SYSTEM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let buf_seeds: [&[u8]; 2] = [b"undelegate-buffer", delegated.address().as_ref()];
    let (buf_addr, _) = Address::try_find_program_address(&buf_seeds, &DELEGATION_ID)
        .ok_or(ProgramError::InvalidSeeds)?;
    if buffer.address() != &buf_addr {
        return Err(ProgramError::InvalidSeeds);
    }
    let seed_refs: Vec<&[u8]> = account_seeds.iter().map(|s| s.as_slice()).collect();
    let (addr, bump) = Address::try_find_program_address(&seed_refs, &crate::ids::ID)
        .ok_or(ProgramError::InvalidSeeds)?;
    if delegated.address() != &addr {
        return Err(ProgramError::InvalidSeeds);
    }
    let space = buffer.data_len();
    {
        let src = buffer.try_borrow()?;
        undelegate_buffer_ok(&src, account_seeds)?;
    }
    create_pda(
        delegated,
        &crate::ids::ID,
        space,
        &seed_refs,
        bump,
        system_program,
        payer,
        true,
    )?;
    let src = buffer.try_borrow()?;
    let mut dst = delegated.try_borrow_mut()?;
    if dst.len() < src.len() {
        return Err(ProgramError::InvalidAccountData);
    }
    dst[..src.len()].copy_from_slice(&src);
    Ok(())
}

/// Commit `accounts` through the Magic Program. `payer` is the treasury.
/// Account order matches `MagicIntentBundleBuilder` with a fee vault:
/// payer, magic context, vault, then commit accounts that are not already there.
#[inline(never)]
pub fn commit_accounts(
    payer: &AccountView,
    magic_context: &AccountView,
    magic_program: &AccountView,
    vault: &AccountView,
    commit: &[&AccountView],
    payer_seeds: &[&[u8]],
    payer_bump: u8,
) -> Result<(), ProgramError> {
    if magic_program.address() != &MAGIC_ID || !magic_program.executable() {
        return Err(ProgramError::IncorrectProgramId);
    }
    if commit.len() + 3 > MAX_COMMIT_ACCOUNTS {
        return Err(fail(OVERFLOW));
    }
    let mut order: Vec<&AccountView> = Vec::with_capacity(commit.len() + 3);
    let mut seen: Vec<[u8; 32]> = Vec::with_capacity(commit.len() + 3);
    for acc in [payer, magic_context, vault]
        .into_iter()
        .chain(commit.iter().copied())
    {
        let key = *acc.address().as_array();
        if !seen.contains(&key) {
            seen.push(key);
            order.push(acc);
        }
    }
    let mut indices = Vec::with_capacity(commit.len());
    for acc in commit {
        let key = acc.address().as_array();
        let idx = seen
            .iter()
            .position(|k| k == key)
            .ok_or(ProgramError::InvalidAccountData)?;
        indices.push(u8::try_from(idx).map_err(|_| fail(OVERFLOW))?);
    }
    let mut data = [0u8; 128];
    let len = encode_schedule_commit(&indices, &mut data)?;

    let mut metas = Vec::with_capacity(order.len());
    for (i, acc) in order.iter().enumerate() {
        let (writable, signer) = if i == 0 {
            (true, true)
        } else if acc.address() == magic_context.address() || acc.address() == vault.address() {
            (true, false)
        } else {
            (acc.is_writable(), acc.is_signer())
        };
        metas.push(InstructionAccount::new(acc.address(), writable, signer));
    }
    let ix = InstructionView {
        program_id: &MAGIC_ID,
        accounts: &metas,
        data: &data[..len],
    };
    // The treasury is the Magic Program payer. It is a PDA, so the CPI has to
    // carry its seeds or the runtime rejects the signer bit.
    let bump_arr = [payer_bump];
    let seed_buf = signer_seeds(payer_seeds, &bump_arr);
    let signers = [Signer::from(seed_buf.as_slice())];
    invoke_signed_with_slice(&ix, &order, &signers)
}

/// The delegation program is the only signer of this buffer. Still refuse a
/// buffer whose size or discriminator is not one of our accounts, and refuse
/// a page whose stored index does not match its seeds.
pub fn undelegate_buffer_ok(bytes: &[u8], seeds: &[Vec<u8>]) -> Result<(), ProgramError> {
    use crate::state::{
        COMMENT_PAGE_DISC, COMMENT_PAGE_SIZE, FORUM_DISC, FORUM_SIZE, POST_PAGE_DISC,
        POST_PAGE_SIZE, TREASURY_DISC, TREASURY_SIZE,
    };
    if bytes.len() < 8 {
        return Err(ProgramError::InvalidAccountData);
    }
    let disc = &bytes[..8];
    let page = if bytes.len() == FORUM_SIZE && disc == FORUM_DISC {
        None
    } else if bytes.len() == TREASURY_SIZE && disc == TREASURY_DISC {
        None
    } else if bytes.len() == POST_PAGE_SIZE && disc == POST_PAGE_DISC {
        Some(b"posts".as_slice())
    } else if bytes.len() == COMMENT_PAGE_SIZE && disc == COMMENT_PAGE_DISC {
        Some(b"comments".as_slice())
    } else {
        return Err(ProgramError::InvalidAccountData);
    };
    let Some(tag) = page else {
        return Ok(());
    };
    if seeds.len() != 3 || seeds[0].as_slice() != tag || seeds[2].len() != 4 {
        return Err(ProgramError::InvalidSeeds);
    }
    // Page header: disc, forum pubkey (32), page_index u32.
    if bytes.len() < 44 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut index = [0u8; 4];
    index.copy_from_slice(&bytes[40..44]);
    if seeds[2].as_slice() != index {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

/// Borsh `Vec<Vec<u8>>` as Anchor passes it to `process_undelegation`.
pub fn parse_seed_vecs(mut data: &[u8]) -> Result<Vec<Vec<u8>>, ProgramError> {
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut len_buf = [0u8; 4];
    len_buf.copy_from_slice(&data[..4]);
    let n = u32::from_le_bytes(len_buf) as usize;
    data = &data[4..];
    if n > 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        if data.len() < 4 {
            return Err(ProgramError::InvalidInstructionData);
        }
        len_buf.copy_from_slice(&data[..4]);
        let len = u32::from_le_bytes(len_buf) as usize;
        data = &data[4..];
        if len > 32 || data.len() < len {
            return Err(ProgramError::InvalidInstructionData);
        }
        out.push(data[..len].to_vec());
        data = &data[len..];
    }
    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;
    use borsh::BorshSerialize;
    use magicblock_magic_program_api::args::{CommitTypeArgs, MagicIntentBundleArgs};
    use magicblock_magic_program_api::instruction::MagicBlockInstruction;

    #[derive(BorshSerialize)]
    struct DelegateAccountArgs {
        commit_frequency_ms: u32,
        seeds: Vec<Vec<u8>>,
        validator: Option<[u8; 32]>,
    }

    #[test]
    fn commit_bytes_match_magicblock_sdk() {
        let indices = alloc::vec![3u8, 0, 4, 5];
        let args = MagicIntentBundleArgs {
            commit: Some(CommitTypeArgs::Standalone(indices.clone())),
            ..Default::default()
        };
        let expected = bincode::serialize(&MagicBlockInstruction::ScheduleIntentBundle(args))
            .expect("bincode");
        let mut out = [0u8; 128];
        let n = encode_schedule_commit(&indices, &mut out).unwrap();
        assert_eq!(&out[..n], expected.as_slice());
    }

    #[test]
    fn delegate_bytes_match_borsh() {
        let seeds = alloc::vec![b"forum".to_vec(), alloc::vec![7u8; 32]];
        let validator = [9u8; 32];
        let args = DelegateAccountArgs {
            commit_frequency_ms: COMMIT_FREQUENCY_MS,
            seeds: seeds.clone(),
            validator: Some(validator),
        };
        let mut expected = alloc::vec![0u8; 8];
        expected.extend(borsh::to_vec(&args).unwrap());
        let refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();
        let mut out = [0u8; 192];
        let n = encode_delegate_data(
            &refs,
            Some(&Address::new_from_array(validator)),
            &mut out,
        )
        .unwrap();
        assert_eq!(&out[..n], expected.as_slice());
    }

    #[test]
    fn undelegate_rejects_a_short_or_mismatched_buffer() {
        use crate::state::{COMMENT_PAGE_DISC, COMMENT_PAGE_SIZE, FORUM_DISC, FORUM_SIZE};
        let mut forum = alloc::vec![0u8; FORUM_SIZE];
        forum[..8].copy_from_slice(&FORUM_DISC);
        assert!(undelegate_buffer_ok(&forum, &[]).is_ok());
        assert!(undelegate_buffer_ok(&forum[..10], &[]).is_err());
        forum[0] ^= 1;
        assert!(undelegate_buffer_ok(&forum, &[]).is_err());

        let mut page = alloc::vec![0u8; COMMENT_PAGE_SIZE];
        page[..8].copy_from_slice(&COMMENT_PAGE_DISC);
        page[40..44].copy_from_slice(&7u32.to_le_bytes());
        let seeds = alloc::vec![b"comments".to_vec(), alloc::vec![1u8; 32], 7u32.to_le_bytes().to_vec()];
        assert!(undelegate_buffer_ok(&page, &seeds).is_ok());
        let wrong = alloc::vec![b"comments".to_vec(), alloc::vec![1u8; 32], 8u32.to_le_bytes().to_vec()];
        assert!(undelegate_buffer_ok(&page, &wrong).is_err());
        let posts = alloc::vec![b"posts".to_vec(), alloc::vec![1u8; 32], 7u32.to_le_bytes().to_vec()];
        assert!(undelegate_buffer_ok(&page, &posts).is_err());
    }
}
