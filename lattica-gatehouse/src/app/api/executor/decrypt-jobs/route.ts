/**
 * Executor Decrypt Jobs API
 * Executor polls for pending decrypt jobs
 */
import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'
import { decryptQueue } from '@/services/queue/decrypt-queue'
import { ciphertextStore } from '@/services/storage/ciphertext-store'

const log = createLogger('API:ExecutorDecrypt')

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '1')

    const pendingJobs = decryptQueue.get_pending().slice(0, limit)

    if (pendingJobs.length === 0) {
      return NextResponse.json({
        jobs: [],
        count: 0
      })
    }

    // Enrich jobs with ciphertext data
    const enrichedJobs = pendingJobs.map(job => {
      const stored = ciphertextStore.get(job.cid)
      return {
        decrypt_id: job.decrypt_id,
        cid: job.cid,
        ciphertext: stored?.ciphertext,
        requested_at: job.requested_at,
        status: job.status
      }
    })

    log.debug('Sending decrypt jobs to executor', {
      count: enrichedJobs.length,
      requested_limit: limit
    })

    return NextResponse.json({
      jobs: enrichedJobs,
      count: enrichedJobs.length
    })

  } catch (error) {
    log.error('Failed to fetch decrypt jobs', {
      error: error instanceof Error ? error.message : String(error)
    })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

