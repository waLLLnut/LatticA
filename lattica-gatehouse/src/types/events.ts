/**
 * Solana on-chain event types
 * Events emitted by the Gatekeeper program (lattica-gatekeeper/src/lib.rs)
 * 
 * @see lattica-gatekeeper/programs/lattica-gatekeeper/src/lib.rs
 */

export type SolanaEventType = 
  | 'CidHandleRegistered' 
  | 'JobSubmitted' 
  | 'BatchPosted' 
  | 'BatchFinalized' 
  | 'RevealRequested'

export interface BaseSolanaEvent {
  event_type: SolanaEventType
  slot: number
  tx_signature: string
  block_time: number
  log_index: number
}

/**
 * Emitted when a CID handle is registered on-chain
 * @see lib.rs:408-414 (CidHandleRegistered event)
 */
export interface CidHandleRegisteredEvent extends BaseSolanaEvent {
  event_type: 'CidHandleRegistered'
  cid: string                     // CID PDA pubkey
  owner: string                   // Owner pubkey
  ciphertext_hash: string         // 32-byte hash (0x + 64 hex)
  policy_hash: string             // 32-byte hash (0x + 64 hex)
}

/**
 * Emitted when a confidential job is submitted
 * @see lib.rs:417-426 (JobSubmitted event)
 */
export interface JobSubmittedEvent extends BaseSolanaEvent {
  event_type: 'JobSubmitted'
  job: string                     // Job PDA pubkey
  batch: string                   // Batch pubkey
  cid_set_id: string              // sha256(cid1 || cid2 || ...)
  cid_handles: string[]           // CID PDA pubkeys used
  commitment: string              // Job commitment hash
  ir_digest: string               // IR digest
  provenance: number              // 0=CPI, 1=direct
}

/**
 * Emitted when a batch result is posted (optimistic)
 * @see lib.rs:429-437 (BatchPosted event)
 */
export interface BatchPostedEvent extends BaseSolanaEvent {
  event_type: 'BatchPosted'
  batch: string                   // Batch PDA pubkey
  window_start_slot: number       // Batch window start
  commit_root: string             // Merkle root of commits
  result_commitment: string       // Batch result commitment
  processed_until_slot: number    // Last processed slot
  posted_slot: number             // When posted
  window_end_slot: number         // Challenge window end
}

/**
 * Emitted when a batch is finalized (after challenge window)
 * @see lib.rs:440-445 (BatchFinalized event)
 */
export interface BatchFinalizedEvent extends BaseSolanaEvent {
  event_type: 'BatchFinalized'
  batch: string                   // Batch PDA pubkey
  window_start_slot: number       // Batch window start
  result_commitment: string       // Finalized result
  finalized_slot: number          // When finalized
}

/**
 * Emitted when a reveal (decrypt) is requested
 * @see lib.rs:448-455 (RevealRequested event)
 */
export interface RevealRequestedEvent extends BaseSolanaEvent {
  event_type: 'RevealRequested'
  handle: string                  // Ciphertext handle (32 bytes)
  requester: string               // Requester pubkey
  is_public: boolean              // Public vs private reveal
  user_session_pubkey?: string    // For private reveals (32 bytes)
  domain_signature?: string       // For public reveals (64 bytes)
}

export type SolanaEvent = 
  | CidHandleRegisteredEvent 
  | JobSubmittedEvent 
  | BatchPostedEvent 
  | BatchFinalizedEvent
  | RevealRequestedEvent

/**
 * Event processing result
 */
export interface EventProcessingResult {
  success: boolean
  event_type: SolanaEventType
  tx_signature: string
  error?: string
  processed_at: number
}

/**
 * Event listener state
 */
export interface EventListenerState {
  is_running: boolean
  last_processed_slot: number
  total_events_processed: number
  errors_count: number
  connected_at?: number
  last_event_at?: number
}

