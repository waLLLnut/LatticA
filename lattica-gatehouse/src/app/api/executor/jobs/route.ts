/**
 * Executor API - Job Discovery
 * GET /api/executor/jobs
 *
 * External FHE executors use this endpoint to discover available jobs.
 * Returns jobs in 'queued' status that are ready for execution.
 */

import { NextRequest, NextResponse } from 'next/server'
import { jobQueue } from '@/services/queue/job-queue'
import { ciphertextStore } from '@/services/storage/ciphertext-store'
import { createLogger } from '@/lib/logger'

const log = createLogger('API:ExecutorJobs')

export const dynamic = 'force-dynamic'

/**
 * GET /api/executor/jobs
 *
 * Query parameters:
 * - status: Filter by status (default: 'queued')
 * - limit: Max jobs to return (default: 10, max: 100)
 *
 * Returns:
 * - jobs: Array of available jobs with ciphertext data
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'queued'
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 100)

    log.debug('Fetching jobs', { status, limit })

    // Get queued jobs
    const queuedJobs = status === 'queued'
      ? jobQueue.get_queued_jobs()
      : jobQueue.get_executing_jobs()

    log.debug('Found jobs', { count: queuedJobs.length })

    // Limit results
    const jobs = queuedJobs.slice(0, limit)

    // Enrich jobs with ciphertext data
    const enrichedJobs = jobs.map(job => {
      try {
        const ciphertexts = job.cid_handles.map(cid => {
          const ct = ciphertextStore.get(cid)
          if (!ct) {
            log.warn('Ciphertext not found for CID', { cid })
          }
          return {
            cid_pda: cid,
            ciphertext: ct?.ciphertext || null,
            ciphertext_hash: ct?.ciphertext_hash || null,
            enc_params: ct?.enc_params || null,
            policy_ctx: ct?.policy_ctx || null,
            owner: ct?.metadata?.owner || null,
          }
        })

        log.info('Sending job to executor', {
          job_pda: job.job_pda.slice(0, 8) + '...',
          ir_digest: job.ir_digest?.slice(0, 10) + '...',
          commitment: job.commitment?.slice(0, 10) + '...',
          ciphertext_count: ciphertexts.length
        })
        
        return {
          job_pda: job.job_pda,
          batch: job.batch,
          commitment: job.commitment,
          cid_set_id: job.cid_set_id,
          ir_digest: job.ir_digest,
          provenance: job.provenance,
          submitted_at: job.submitted_at,
          slot: job.slot,
          status: job.status,
          ciphertexts,
        }
      } catch (jobError) {
        log.error('Error enriching job', jobError, { job_pda: job.job_pda })
        throw jobError
      }
    })

    log.info('Jobs fetched by executor', {
      status,
      count: enrichedJobs.length,
      requested_limit: limit,
    })

    return NextResponse.json({
      jobs: enrichedJobs,
      total: enrichedJobs.length,
      status,
    })
  } catch (error) {
    log.error('Failed to fetch jobs', error, {
      error_message: error instanceof Error ? error.message : String(error),
      error_stack: error instanceof Error ? error.stack : undefined,
    })
    return NextResponse.json(
      {
        error: 'Failed to fetch jobs',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
