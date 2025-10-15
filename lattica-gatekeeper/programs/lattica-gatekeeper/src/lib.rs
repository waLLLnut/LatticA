use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

declare_id!("GateF9qDULEJRgt6m1prkmUWrEXGVhDzYCgCJtGtnwu9");

const MAX_CIDS: usize = 16;

#[program]
pub mod lattica_gatekeeper {
    use super::*;

    /// Initialize global configuration
    pub fn init_config(
        ctx: Context<InitConfig>,
        challenge_window_slots: u64,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.challenge_window_slots = challenge_window_slots;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// Register CID handle (Content Identifier)
    /// Deterministically derived: sha256(ciphertext_hash || policy_hash || owner)
    pub fn register_cid_handle(
        ctx: Context<RegisterCidHandle>,
        ciphertext_hash: [u8; 32],
        policy_hash: [u8; 32],
    ) -> Result<()> {
        let cid = &mut ctx.accounts.cid;
        cid.ciphertext_hash = ciphertext_hash;
        cid.policy_hash = policy_hash;
        cid.owner = ctx.accounts.owner.key();
        cid.registered_at = Clock::get()?.slot;
        cid.bump = ctx.bumps.cid;

        emit!(CidHandleRegistered {
            cid: cid.key(),
            owner: cid.owner,
            ciphertext_hash,
            policy_hash,
            slot: cid.registered_at,
        });
        Ok(())
    }

    /// Request reveal public
    pub fn request_reveal_public(
        ctx: Context<RequestRevealPublic>,
        handle: [u8; 32],
        domain_signature: [u8; 64], // Domain typing (optional)
    ) -> Result<()> {
        let req = &mut ctx.accounts.reveal_req;
        if req.init == 0 {
            req.init = 1;
            req.handle = handle;
            req.is_public = 1;
            req.bump = ctx.bumps.reveal_req;
        }
        req.requester = ctx.accounts.requester.key();
        req.domain_signature = domain_signature;
        req.user_session_pubkey = [0u8; 32]; // Public reveal does not need session key
        req.requested_slot = Clock::get()?.slot;

        emit!(RevealRequested {
            handle,
            requester: req.requester,
            is_public: true,
            user_session_pubkey: None,
            domain_signature: Some(domain_signature),
            slot: req.requested_slot,
        });
        Ok(())
    }

    /// Request reveal private
    pub fn request_reveal_private(
        ctx: Context<RequestRevealPrivate>,
        handle: [u8; 32],
        user_session_pubkey: [u8; 32], // Private: session key required
    ) -> Result<()> {
        let req = &mut ctx.accounts.reveal_req;
        if req.init == 0 {
            req.init = 1;
            req.handle = handle;
            req.is_public = 0;
            req.bump = ctx.bumps.reveal_req;
        }
        req.requester = ctx.accounts.requester.key();
        req.user_session_pubkey = user_session_pubkey;
        req.domain_signature = [0u8; 64];
        req.requested_slot = Clock::get()?.slot;

        emit!(RevealRequested {
            handle,
            requester: req.requester,
            is_public: false,
            user_session_pubkey: Some(user_session_pubkey),
            domain_signature: None,
            slot: req.requested_slot,
        });
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
        provenance: u8,                 // 0=CPI call, 1=direct owner call
    ) -> Result<()> {
        let job = &mut ctx.accounts.job;

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
        job.provenance = provenance;
        job.submitted_slot = Clock::get()?.slot;
        job.bump = ctx.bumps.job;

        // Emit event for indexers
        emit!(JobSubmitted {
            job: job.key(),
            batch,
            cid_set_id,
            cid_handles,
            commitment,
            ir_digest,
            provenance,
            slot: job.submitted_slot,
        });
        Ok(())
    }

    /// Commit batch result
    pub fn commit_batch(
        ctx: Context<CommitBatch>,
        window_start_slot: u64,
        commit_root: [u8; 32],        // Root of commits
        result_commitment: [u8; 32],  // Batch result commitment
        processed_until_slot: u64,    // "Up to which slot was processed"
    ) -> Result<()> {
        let now = Clock::get()?.slot;
        let cfg = &ctx.accounts.config;
        let b = &mut ctx.accounts.batch;

        if b.window_start_slot == 0 {
            b.window_start_slot = window_start_slot;
            b.bump = ctx.bumps.batch;
        } else {
            require_eq!(b.window_start_slot, window_start_slot, ErrorCode::BatchKeyMismatch);
        }

        b.status = BatchStatus::Posted as u8; // 0=posted, 1=finalized
        b.commit_root = commit_root;
        b.result_commitment = result_commitment;
        b.processed_until_slot = processed_until_slot;
        b.posted_slot = Some(now);

        emit!(BatchPosted {
            batch: b.key(),
            window_start_slot,
            commit_root,
            result_commitment,
            processed_until_slot,
            posted_slot: now,
            window_end_slot: now
                .checked_add(cfg.challenge_window_slots)
                .unwrap_or(now),
        });
        Ok(())
    }

    /// Finalize batch
    pub fn finalize_batch(
        ctx: Context<FinalizeBatch>,
        window_start_slot: u64,
    ) -> Result<()> {
        let now = Clock::get()?.slot;
        let cfg = &ctx.accounts.config;
        let b = &mut ctx.accounts.batch;

        require_eq!(b.window_start_slot, window_start_slot, ErrorCode::BatchKeyMismatch);
        require_eq!(b.status, BatchStatus::Posted as u8, ErrorCode::BadStatus);
        let posted = b.posted_slot.ok_or(ErrorCode::PostedSlotMissing)?;
        require!(now >= posted.checked_add(cfg.challenge_window_slots).ok_or(ErrorCode::MathOverflow)?, ErrorCode::WindowNotEnded);

        b.status = BatchStatus::Finalized as u8;

        emit!(BatchFinalized {
            batch: b.key(),
            window_start_slot,
            result_commitment: b.result_commitment,
            finalized_slot: now,
        });
        Ok(())
    }
}

// Account validation contexts
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ciphertext_hash: [u8; 32], policy_hash: [u8; 32])]
pub struct RegisterCidHandle<'info> {
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
pub struct CommitBatch<'info> {
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BatchResult::INIT_SPACE,
        seeds=[b"batch", window_start_slot.to_le_bytes().as_ref()],
        bump
    )]
    pub batch: Account<'info, BatchResult>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(window_start_slot: u64)]
pub struct FinalizeBatch<'info> {
    #[account(seeds=[b"config"], bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds=[b"batch", window_start_slot.to_le_bytes().as_ref()],
        bump=batch.bump
    )]
    pub batch: Account<'info, BatchResult>,
}

#[derive(Accounts)]
#[instruction(handle: [u8;32])]
pub struct RequestRevealPublic<'info> {
    #[account(
        init_if_needed,
        payer = requester,
        space = 8 + RevealRequest::INIT_SPACE,
        seeds=[b"reveal_req", handle.as_ref()],
        bump
    )]
    pub reveal_req: Account<'info, RevealRequest>,
    #[account(mut)]
    pub requester: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(handle: [u8;32])]
pub struct RequestRevealPrivate<'info> {
    #[account(
        init_if_needed,
        payer = requester,
        space = 8 + RevealRequest::INIT_SPACE,
        seeds=[b"reveal_req", handle.as_ref()],
        bump
    )]
    pub reveal_req: Account<'info, RevealRequest>,
    #[account(mut)]
    pub requester: Signer<'info>,
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
    pub commitment: [u8; 32],     // H(cid_set_id || ir_digest || domain_hash || nonce)
    pub ir_digest: [u8; 32],
    pub provenance: u8,           // 0=CPI call, 1=direct owner call
    pub submitted_slot: u64,
    pub bump: u8,
}

#[repr(u8)]
pub enum BatchStatus {
    Posted    = 0,
    Finalized = 1,
}

#[account]
#[derive(InitSpace)]
pub struct BatchResult {
    // identity
    pub window_start_slot: u64,     // seed identity
    pub bump: u8,
    // status + meta
    pub status: u8,                 // BatchStatus
    pub commit_root: [u8; 32],      // Root of commits
    pub result_commitment: [u8; 32],// Batch result commitment
    pub processed_until_slot: u64,  // "Up to which slot was processed"
    pub posted_slot: Option<u64>,   // Posting timestamp
}

#[account]
#[derive(InitSpace)]
pub struct RevealRequest {
    pub init: u8,                   // 0/1
    pub is_public: u8,              // 1=public, 0=private
    pub handle: [u8; 32],
    pub requester: Pubkey,
    pub user_session_pubkey: [u8; 32], // Used for private reveals
    pub domain_signature: [u8; 64],    // Used for public reveals (optional)
    pub requested_slot: u64,
    pub bump: u8,
}

// Events
#[event]
pub struct CidHandleRegistered {
    pub cid: Pubkey,
    pub owner: Pubkey,
    pub ciphertext_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct JobSubmitted {
    pub job: Pubkey,
    pub batch: Pubkey,
    pub cid_set_id: [u8; 32],
    pub cid_handles: Vec<Pubkey>,
    pub commitment: [u8; 32],
    pub ir_digest: [u8; 32],
    pub provenance: u8,
    pub slot: u64,
}

#[event]
pub struct BatchPosted {
    pub batch: Pubkey,
    pub window_start_slot: u64,
    pub commit_root: [u8; 32],
    pub result_commitment: [u8; 32],
    pub processed_until_slot: u64,
    pub posted_slot: u64,
    pub window_end_slot: u64, // Provided only in event for UI convenience
}

#[event]
pub struct BatchFinalized {
    pub batch: Pubkey,
    pub window_start_slot: u64,
    pub result_commitment: [u8; 32],
    pub finalized_slot: u64,
}

#[event]
pub struct RevealRequested {
    pub handle: [u8; 32],
    pub requester: Pubkey,
    pub is_public: bool,
    pub user_session_pubkey: Option<[u8; 32]>,
    pub domain_signature: Option<[u8; 64]>,
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

    #[msg("Batch PDA key mismatch")]
    BatchKeyMismatch,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Window not ended")]
    WindowNotEnded,
    #[msg("Bad status for operation")]
    BadStatus,
    #[msg("Posted slot missing")]
    PostedSlotMissing,
}