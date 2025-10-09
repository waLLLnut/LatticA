use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

declare_id!("GateF9qDULEJRgt6m1prkmUWrEXGVhDzYCgCJtGtnwu9");

const MAX_CIDS: usize = 16;

#[program]
pub mod lattica_gatekeeper {
    use super::*;

    /// Initialize global configuration
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        challenge_window_slots: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.challenge_window_slots = challenge_window_slots;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Register CID handle (Content Identifier)
    /// Deterministically derived: sha256(ciphertext_hash || policy_hash || owner)
    pub fn register_cid(
        ctx: Context<RegisterCid>,
        ciphertext_hash: [u8; 32],
        policy_hash: [u8; 32],
    ) -> Result<()> {
        let cid = &mut ctx.accounts.cid;
        cid.ciphertext_hash = ciphertext_hash;
        cid.policy_hash = policy_hash;
        cid.owner = ctx.accounts.owner.key();
        cid.registered_at = Clock::get()?.slot;
        cid.bump = ctx.bumps.cid;
        Ok(())
    }

    /// Submit confidential job with validated CID references
    /// CIDs passed via remaining_accounts, validated on-chain
    pub fn submit_job<'info>(
        ctx: Context<'_, '_, 'info, 'info, SubmitJob<'info>>,
        batch: Pubkey,
        cid_set_id: [u8; 32],
        commitment: [u8; 32],
        ir_digest: [u8; 32],
        policy_hash: [u8; 32],
        provenance: u8,
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;
        let slot = Clock::get()?.slot;

        // Validate CID handles from remaining_accounts
        let mut cid_handles: Vec<Pubkey> = Vec::new();
        for (i, acc) in ctx.remaining_accounts.iter().enumerate() {
            require!(i < MAX_CIDS, ErrorCode::TooManyCids);
            require_keys_eq!(*acc.owner, crate::ID, ErrorCode::BadCidOwner);
            let _cid: Account<CidHandle> = Account::try_from(acc)?;
            cid_handles.push(*acc.key);
        }
        require!(!cid_handles.is_empty(), ErrorCode::NoCidProvided);

        // Verify cid_set_id matches provided CID handles
        // Formula: sha256(cid_pubkey_1 || cid_pubkey_2 || ...)
        let mut hasher = Sha256::new();
        for k in cid_handles.iter() {
            hasher.update(k.as_ref());
        }
        let computed = hasher.finalize();
        require!(computed[..] == cid_set_id, ErrorCode::CidSetMismatch);

        // Store job data on-chain
        job.batch = batch;
        job.cid_set_id = cid_set_id;
        job.cid_count = cid_handles.len() as u16;
        job.commitment = commitment;
        job.ir_digest = ir_digest;
        job.policy_hash = policy_hash;
        job.provenance = provenance;
        job.submitter = ctx.accounts.submitter.key();
        job.submitted_slot = slot;
        job.bump = ctx.bumps.job;

        // Emit event for indexers
        emit!(JobSubmitted {
            job: job.key(),
            batch,
            cid_set_id,
            cid_handles,
            commitment,
            submitter: job.submitter,
            slot,
        });
        Ok(())
    }
}

// Account validation contexts
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ciphertext_hash: [u8; 32], policy_hash: [u8; 32])]
pub struct RegisterCid<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + CidHandle::INIT_SPACE,
        seeds = [
            b"cid",
            ciphertext_hash.as_ref(),
            policy_hash.as_ref(),
            owner.key().as_ref()
        ],
        bump
    )]
    pub cid: Account<'info, CidHandle>,
    pub owner: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(batch: Pubkey, cid_set_id: [u8; 32], commitment: [u8; 32])]
pub struct SubmitJob<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = submitter,
        space = 8 + Job::INIT_SPACE,
        seeds = [b"job", commitment.as_ref(), submitter.key().as_ref()],
        bump
    )]
    pub job: Account<'info, Job>,
    /// CHECK: Batch window reference
    pub batch: UncheckedAccount<'info>,
    #[account(mut)]
    pub submitter: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(window_start_slot: u64)]
pub struct PostBatchResult<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BatchResult::INIT_SPACE,
        seeds = [b"batch", window_start_slot.to_le_bytes().as_ref()],
        bump
    )]
    pub batch: Account<'info, BatchResult>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// Program state accounts
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub challenge_window_slots: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CidHandle {
    pub ciphertext_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub owner: Pubkey,
    pub registered_at: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Job {
    pub batch: Pubkey,
    pub cid_set_id: [u8; 32],
    pub cid_count: u16,
    pub commitment: [u8; 32],
    pub ir_digest: [u8; 32],
    pub policy_hash: [u8; 32],
    pub provenance: u8,
    pub submitter: Pubkey,
    pub submitted_slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BatchResult {
    pub window_start_slot: u64,
    pub status: u8,
    pub commit_root: [u8; 32],
    pub result_commitment: [u8; 32],
    #[max_len(0)]
    pub posted_slot: Option<u64>,
    pub bump: u8,
}

// Events
#[event]
pub struct JobSubmitted {
    pub job: Pubkey,
    pub batch: Pubkey,
    pub cid_set_id: [u8; 32],
    pub cid_handles: Vec<Pubkey>,
    pub commitment: [u8; 32],
    pub submitter: Pubkey,
    pub slot: u64,
}

// Error codes
#[error_code]
pub enum ErrorCode {
    #[msg("No CID handles provided")]
    NoCidProvided,
    #[msg("Too many CID handles (max 16)")]
    TooManyCids,
    #[msg("CID handle account not owned by this program")]
    BadCidOwner,
    #[msg("cid_set_id does not match remaining_accounts")]
    CidSetMismatch,
}