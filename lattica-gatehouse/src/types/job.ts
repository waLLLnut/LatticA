/**
 * Job submission types
 */

import { PolicyContext } from './ciphertext'

export interface JobSubmissionRecord {
  job_pda: string                    // Job PDA (base58)
  submitter: string                  // Submitter pubkey (base58)
  batch: string                      // Batch window pubkey (base58)
  cid_handles: string[]              // CID PDAs used in this job
  commitment: string                 // Commitment hash (0x + 64 hex)
  ir_digest: string                  // IR digest (0x + 64 hex)
  policy_hash: string                // Policy hash (0x + 64 hex)
  policy_ctx: PolicyContext          // Original policy context
  provenance: number                 // 0=server, 1=client
  nonce: string                      // Nonce (0x + 64 hex)
  status: 'pending' | 'submitted' | 'executed' | 'failed'
  created_at: number                 // Unix timestamp
  submitted_at?: number              // Unix timestamp (tx sent)
  executed_at?: number               // Unix timestamp (execution complete)
  tx_signature?: string              // Solana tx signature
  block_height?: number              // Submission block height
}

export interface JobVerification {
  cid_set_id: string                 // sha256(cid1 || cid2 || ...)
  policy_hash: string
  domain_hash: string
  commitment: string
  all_cids_valid: boolean
  invalid_cids?: string[]            // CIDs that failed validation
}

export interface BatchWindow {
  batch_pda: string
  window_start_slot: number
  window_end_slot: number
  job_count: number
  status: 'open' | 'closed' | 'executing' | 'finalized'
}

