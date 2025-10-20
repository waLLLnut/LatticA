/**
 * Job queue types for FHE execution scheduling
 */

export interface QueuedJob {
  job_pda: string                        // Job account PDA
  submitter: string                      // Submitter pubkey
  batch: string                          // Batch window pubkey
  commitment: string                     // Job commitment hash
  cid_set_id: string                     // CID set identifier
  cid_handles: string[]                  // CID PDAs used
  ir_digest: string                      // IR digest
  policy_hash: string                    // Policy hash
  provenance: number                     // 0=server, 1=client
  
  // Queue metadata
  queued_at: number                      // Unix timestamp (when enqueued)
  submitted_at: number                   // Unix timestamp (on-chain)
  slot: number                           // Submission slot
  tx_signature: string                   // Submission tx
  
  // Execution state
  status: JobStatus
  executor?: string                      // Executor pubkey (when assigned)
  execution_started_at?: number
  execution_completed_at?: number
  result_handle?: string                 // Output ciphertext handle
}

export type JobStatus = 
  | 'queued'           // Waiting for execution
  | 'assigned'         // Assigned to executor
  | 'executing'        // Currently executing
  | 'completed'        // Execution done
  | 'failed'           // Execution failed
  | 'cancelled'        // Job cancelled

export interface JobQueueStats {
  total_jobs: number
  queued_count: number
  executing_count: number
  completed_count: number
  failed_count: number
  oldest_queued_timestamp: number
  newest_queued_timestamp: number
}

export interface BatchWindowJobs {
  batch_pda: string
  window_start_slot: number
  window_end_slot: number
  jobs: QueuedJob[]
  total_jobs: number
}

/**
 * Job execution result (from executor)
 */
export interface JobExecutionResult {
  job_pda: string
  executor: string
  success: boolean
  result_handle?: string                 // Output ciphertext CID
  error?: string
  execution_time_ms: number
  completed_at: number
}

