/**
 * Initialization endpoint
 * Ensures Solana services are running
 */

import { NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'
import { initializeSolanaServices, isServicesInitialized } from '@/services/solana/init'
import { getEventListener } from '@/services/solana/event-listener'
import { jobQueue } from '@/services/queue/job-queue'
import { ciphertextStore } from '@/services/storage/ciphertext-store'

const log = createLogger('API:Init')
import { pendingCiphertextStore } from '@/services/storage/pending-store'

// IR Digest to operation type mapping (reverse lookup)
// These are the actual hex values stored on-chain
const IR_DIGEST_TO_OPERATION: Record<string, { name: string; description: string }> = {
  // Deposit: FHE16.ADD(amount1, amount2)
  '0xadd00000000000000000000000000000000000000000000000000000000000000000': {
    name: 'deposit',
    description: 'Balance += FHE16.ADD(amount1, amount2)'
  },
  // Withdraw: Balance deduction with validation
  '0x8fae5df19cb6bc3db4ea7dfc14a9696be683910c9fee64d839a6eef9981129a1': {
    name: 'withdraw',
    description: 'Balance -= amount (with validation)'
  },
  // Borrow: FHE16.MUL for health check
  '0xmul00000000000000000000000000000000000000000000000000000000000000000': {
    name: 'borrow',
    description: 'Health Check - FHE16.MUL(collateral, 0.5) >= loan_amount'
  },
  // Liquidation: Health factor check at 0.5 LTV
  '0xhealthcheck0000000000000000000000000000000000000000000000000000000': {
    name: 'liquidation',
    description: 'LTV Check - FHE16.DIV(debt, collateral) > 0.5 threshold'
  },
}

function getOperationInfo(irDigest: string): { name: string; description: string } {
  // Normalize ir_digest for lookup (lowercase)
  const normalized = irDigest.toLowerCase()
  const operation = IR_DIGEST_TO_OPERATION[normalized]

  if (operation) {
    return operation
  }

  // Fallback: Try pattern matching
  const upper = irDigest.toUpperCase().replace(/^0X/, '')
  if (upper.startsWith('ADD0')) {
    return { name: 'deposit', description: 'Balance += FHE16.ADD(amount1, amount2)' }
  } else if (upper.includes('WITHDRAW')) {
    return { name: 'withdraw', description: 'Balance -= amount (with validation)' }
  } else if (upper.startsWith('MUL0')) {
    return { name: 'borrow', description: 'Health Check - FHE16.MUL(collateral, 0.5) >= loan_amount' }
  } else if (upper.includes('HEALTHCHECK')) {
    return { name: 'liquidation', description: 'LTV Check - FHE16.DIV(debt, collateral) > 0.5 threshold' }
  }

  return { name: 'custom', description: 'Custom IR operation' }
}

export async function GET() {
  try {
    // Initialize if not already
    if (!isServicesInitialized()) {
      await initializeSolanaServices()
    }

    const listener = getEventListener()
    const listenerState = listener.getState()
    const queueStats = jobQueue.get_stats()
    const storageStats = ciphertextStore.get_stats()
    const pendingStats = pendingCiphertextStore.get_stats()

    // Get detailed lists
    // NOTE: For demo/development only! In production:
    // - Implement pagination (e.g., ?page=1&limit=20)
    // - Add filtering by status, owner, time range
    // - Use database queries instead of in-memory stores
    // - Consider caching for frequently accessed data
    const queuedJobs = jobQueue.get_queued_jobs()
    const executingJobs = jobQueue.get_executing_jobs()
    const completedJobs = jobQueue.get_completed_jobs()
    const failedJobs = jobQueue.get_failed_jobs()
    const allCids = ciphertextStore.get_all()

    // Format CID list (limit to recent 10 for demo)
    // Production: Should return paginated results with proper indexing
    const recentCids = allCids.slice(-10).map(cid => ({
      cid_pda: cid.cid_pda,
      owner: cid.metadata.owner,
      created_at: cid.metadata.created_at,
      status: cid.verification?.status || 'pending',
      ciphertext_hash: cid.ciphertext_hash.slice(0, 16) + '...',
    }))

    // Format Job list with detailed info for FHE executor interface
    const jobsList = queuedJobs.map(job => {
      const opInfo = getOperationInfo(job.ir_digest)
      return {
        job_pda: job.job_pda,
        submitter: job.submitter,
        batch: job.batch,
        cid_handles: job.cid_handles,
        cid_count: job.cid_handles.length,
        ir_digest: job.ir_digest,
        operation: opInfo.name,
        operation_desc: opInfo.description,
        policy_hash: job.policy_hash,
        commitment: job.commitment,
        provenance: job.provenance,
        slot: job.slot,
        queued_at: job.queued_at,
        submitted_at: job.submitted_at,
        status: 'queued',
      }
    }).concat(executingJobs.map(job => {
      const opInfo = getOperationInfo(job.ir_digest)
      return {
        job_pda: job.job_pda,
        submitter: job.submitter,
        batch: job.batch,
        cid_handles: job.cid_handles,
        cid_count: job.cid_handles.length,
        ir_digest: job.ir_digest,
        operation: opInfo.name,
        operation_desc: opInfo.description,
        policy_hash: job.policy_hash,
        commitment: job.commitment,
        provenance: job.provenance,
        slot: job.slot,
        queued_at: job.queued_at,
        submitted_at: job.submitted_at,
        execution_started_at: job.execution_started_at,
        executor: job.executor,
        status: job.status,  // Return actual status (assigned or executing)
      }
    })).concat(completedJobs.map(job => {
      const opInfo = getOperationInfo(job.ir_digest)
      return {
        job_pda: job.job_pda,
        submitter: job.submitter,
        batch: job.batch,
        cid_handles: job.cid_handles,
        cid_count: job.cid_handles.length,
        ir_digest: job.ir_digest,
        operation: opInfo.name,
        operation_desc: opInfo.description,
        policy_hash: job.policy_hash,
        commitment: job.commitment,
        provenance: job.provenance,
        slot: job.slot,
        queued_at: job.queued_at,
        submitted_at: job.submitted_at,
        execution_started_at: job.execution_started_at,
        execution_completed_at: job.execution_completed_at,
        executor: job.executor,
        result_handle: job.result_handle,
        status: 'completed',
      }
    })).concat(failedJobs.map(job => {
      const opInfo = getOperationInfo(job.ir_digest)
      return {
        job_pda: job.job_pda,
        submitter: job.submitter,
        batch: job.batch,
        cid_handles: job.cid_handles,
        cid_count: job.cid_handles.length,
        ir_digest: job.ir_digest,
        operation: opInfo.name,
        operation_desc: opInfo.description,
        policy_hash: job.policy_hash,
        commitment: job.commitment,
        provenance: job.provenance,
        slot: job.slot,
        queued_at: job.queued_at,
        submitted_at: job.submitted_at,
        execution_started_at: job.execution_started_at,
        execution_completed_at: job.execution_completed_at,
        executor: job.executor,
        status: 'failed',
      }
    }))

    return NextResponse.json({
      status: 'ok',
      services: {
        event_listener: {
          is_running: listenerState.is_running,
          last_processed_slot: listenerState.last_processed_slot,
          total_events_processed: listenerState.total_events_processed,
          errors_count: listenerState.errors_count,
          connected_at: listenerState.connected_at,
          last_event_at: listenerState.last_event_at,
        },
        job_queue: {
          total_jobs: queueStats.total_jobs,
          queued: queueStats.queued_count,
          executing: queueStats.executing_count,
          completed: queueStats.completed_count,
          failed: queueStats.failed_count,
          jobs: jobsList,
        },
        storage: {
          confirmed_cids: storageStats.confirmed_count,
          pending_cids: pendingStats.total_pending,
          total_cids: storageStats.total_cids,
          recent_cids: recentCids,
        },
      },
    })
  } catch (error) {
    log.error('Status check error', error)
    return NextResponse.json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}

export async function POST() {
  try {
    await initializeSolanaServices()
    
    return NextResponse.json({
      status: 'ok',
      message: 'Solana services initialized',
    })
  } catch (error) {
    log.error('Initialization error', error)
    return NextResponse.json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 })
  }
}

