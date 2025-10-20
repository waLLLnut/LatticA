/**
 * Executor API - Claim Job
 * POST /api/executor/jobs/{job_pda}/claim
 *
 * External executor claims a job for execution.
 * Marks job as 'assigned' to prevent duplicate processing.
 */

import { NextRequest, NextResponse } from 'next/server'
import { jobQueue } from '@/services/queue/job-queue'
import { createLogger } from '@/lib/logger'

const log = createLogger('API:ClaimJob')

export const dynamic = 'force-dynamic'

interface ClaimJobRequest {
  executor: string  // Executor pubkey or identifier
}

/**
 * POST /api/executor/jobs/{job_pda}/claim
 *
 * Request body:
 * {
 *   "executor": "ExecutorPubkey..."
 * }
 *
 * Returns:
 * - success: boolean
 * - job: Job details if successful
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ job_pda: string }> }
) {
  try {
    const { job_pda } = await params
    const body: ClaimJobRequest = await request.json()

    if (!body.executor) {
      return NextResponse.json(
        { error: 'executor field is required' },
        { status: 400 }
      )
    }

    // Get job
    const job = jobQueue.get_job(job_pda)
    if (!job) {
      log.warn('Job not found', { job_pda })
      return NextResponse.json(
        { error: 'Job not found' },
        { status: 404 }
      )
    }

    // Check if job is claimable
    if (job.status !== 'queued') {
      log.warn('Job not in queued state', {
        job_pda: job_pda.slice(0, 8) + '...',
        current_status: job.status,
      })
      return NextResponse.json(
        {
          error: 'Job not available for claiming',
          current_status: job.status,
        },
        { status: 409 }
      )
    }

    // Assign job to executor
    const success = jobQueue.assign_job(job_pda, body.executor)
    if (!success) {
      return NextResponse.json(
        { error: 'Failed to assign job' },
        { status: 500 }
      )
    }

    log.info('Job claimed by executor', {
      job: job_pda.slice(0, 8) + '...',
      executor: body.executor.slice(0, 8) + '...',
    })

    // Return updated job
    const updatedJob = jobQueue.get_job(job_pda)

    return NextResponse.json({
      success: true,
      job: updatedJob,
    })
  } catch (error) {
    log.error('Failed to claim job', error)
    return NextResponse.json(
      { error: 'Failed to claim job' },
      { status: 500 }
    )
  }
}
