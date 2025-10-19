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
        },
        storage: {
          confirmed_cids: storageStats.confirmed_count,
          pending_cids: pendingStats.total_pending,
          total_cids: storageStats.total_cids,
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

