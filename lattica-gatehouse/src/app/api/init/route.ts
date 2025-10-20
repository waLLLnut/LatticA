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

    // Format Job list
    const jobsList = queuedJobs.map(job => ({
      job_pda: job.job,
      batch: job.batch,
      cid_count: job.cid_handles.length,
      slot: job.slot,
      status: 'queued',
    })).concat(executingJobs.map(job => ({
      job_pda: job.job,
      batch: job.batch,
      cid_count: job.cid_handles.length,
      slot: job.slot,
      status: 'executing',
    })))

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

