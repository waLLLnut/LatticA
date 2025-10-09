use anchor_lang::prelude::*;

declare_id!("GateF9qDULEJRgt6m1prkmUWrEXGVhDzYCgCJtGtnwu9");

const MAX_CIDS: usize = 16; // Maximum CIDs per job

#[program]
pub mod lattica_gatekeeper {
    use super::*;

    /// Initialize global config (authority + challenge window)
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        challenge_window_slots: u64,
    ) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.challenge_window_slots = challenge_window_slots;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Register a new CID handle (Content Identifier for confidential data)
    /// CID is deterministically derived from: ciphertext_hash + policy_hash + user
    /// Same data + same policy + same user = same CID (trustless, reproducible)
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

    /// Submit a new confidential job with multiple CID references
    /// CID handles are passed via remaining_accounts and validated
    pub fn submit_job<'info>(
        ctx: Context<'_, '_, 'info, 'info, SubmitJob<'info>>,
        batch: Pubkey,
        cid_set_id: [u8; 32],      // Set identifier (e.g., Merkle root / hash)
        commitment: [u8; 32],      // H(cid_set_id || ir_digest || policy_hash || domain_hash || nonce)
        ir_digest: [u8; 32],
        policy_hash: [u8; 32],
        provenance: u8,
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;
        let slot = Clock::get()?.slot;

        // 1) Collect & validate all CidHandle accounts passed as remaining_accounts
        let mut cid_handles: Vec<Pubkey> = Vec::new();
        for (i, acc) in ctx.remaining_accounts.iter().enumerate() {
            require!(i < MAX_CIDS, ErrorCode::TooManyCids);
            // Must be owned by this program
            require_keys_eq!(*acc.owner, crate::ID, ErrorCode::BadCidOwner);
            // Verify it deserializes to CidHandle (shape check)
            let _cid: Account<CidHandle> = Account::try_from(acc)?;
            cid_handles.push(*acc.key);
        }
        require!(!cid_handles.is_empty(), ErrorCode::NoCidProvided);

        // 2) Pin minimal state on-chain (compact)
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

        // 3) Emit full list for indexers/auditors
        emit!(JobSubmitted {
            job: job.key(),
            batch,
            cid_set_id,
            cid_handles, // Full list visible on-chain via event
            commitment,
            submitter: job.submitter,
            slot,
        });
        Ok(())
    }
}

/* ===================== ACCOUNTS ===================== */

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
    /// The owner of this confidential data
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
    // NOTE: CidHandle accounts are supplied via remaining_accounts
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

/* ===================== STATE ===================== */

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
    pub ciphertext_hash: [u8; 32],  // Hash of encrypted data (computed off-chain)
    pub policy_hash: [u8; 32],      // Hash of FHE policy
    pub owner: Pubkey,              // Data owner (part of CID derivation)
    pub registered_at: u64,         // Slot when registered on-chain
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Job {
    pub batch: Pubkey,
    pub cid_set_id: [u8; 32],   // Compact set id (bound in commitment)
    pub cid_count: u16,         // How many CIDs in this job (max=MAX_CIDS)
    pub commitment: [u8; 32],   // H(cid_set_id || ir_digest || policy_hash || domain_hash || nonce)
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

/* ===================== EVENTS ===================== */

#[event]
pub struct JobSubmitted {
    pub job: Pubkey,
    pub batch: Pubkey,
    pub cid_set_id: [u8; 32],
    pub cid_handles: Vec<Pubkey>, // Emitted for transparency (<= MAX_CIDS)
    pub commitment: [u8; 32],
    pub submitter: Pubkey,
    pub slot: u64,
}

/* ===================== ERRORS ===================== */

#[error_code]
pub enum ErrorCode {
    #[msg("No CID handles provided")]
    NoCidProvided,
    #[msg("Too many CID handles (max 16)")]
    TooManyCids,
    #[msg("CID handle account not owned by this program")]
    BadCidOwner,
}