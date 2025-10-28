/**
 * Executor API - Submit Result
 * POST /api/executor/jobs/{job_pda}/result
 *
 * External executor submits FHE execution result.
 * Marks job as 'completed' or 'failed' based on result.
 */

import { NextRequest, NextResponse } from 'next/server'
import { jobQueue } from '@/services/queue/job-queue'
import { ciphertextStore } from '@/services/storage/ciphertext-store'
import { createLogger } from '@/lib/logger'

const log = createLogger('API:SubmitResult')

export const dynamic = 'force-dynamic'

interface SubmitResultRequest {
  executor: string               // Executor pubkey (must match claimed executor)
  success: boolean               // Whether execution succeeded
  result_ciphertext?: unknown    // Output ciphertext (if success=true)
  error?: string                 // Error message (if success=false)
  execution_time_ms: number      // Execution duration
}

/**
 * POST /api/executor/jobs/{job_pda}/result
 *
 * Request body:
 * {
 *   "executor": "ExecutorPubkey...",
 *   "success": true,
 *   "result_ciphertext": {...},
 *   "execution_time_ms": 1234
 * }
 *
 * Returns:
 * - success: boolean
 * - job_status: Updated job status
 * - result_handle: CID of registered result (if success)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ job_pda: string }> }
) {
  try {
    const { job_pda } = await params
    const body: SubmitResultRequest = await request.json()

    // Validate request
    if (!body.executor) {
      return NextResponse.json(
        { error: 'executor field is required' },
        { status: 400 }
      )
    }

    if (typeof body.success !== 'boolean') {
      return NextResponse.json(
        { error: 'success field is required and must be boolean' },
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

    // Verify executor matches
    if (job.executor !== body.executor) {
      log.warn('Executor mismatch', {
        job_pda: job_pda.slice(0, 8) + '...',
        job_executor: job.executor,
        request_executor: body.executor,
      })
      return NextResponse.json(
        { error: 'Executor does not match assigned executor' },
        { status: 403 }
      )
    }

    // Check job status
    if (job.status !== 'assigned' && job.status !== 'executing') {
      log.warn('Job not in executable state', {
        job_pda: job_pda.slice(0, 8) + '...',
        current_status: job.status,
      })
      return NextResponse.json(
        {
          error: 'Job not in executable state',
          current_status: job.status,
        },
        { status: 409 }
      )
    }

    // Update job status based on result
    let updateSuccess: boolean
    let resultHandle: string | undefined
    
    if (body.success) {
      if (!body.result_ciphertext) {
        return NextResponse.json(
          { error: 'result_ciphertext is required for successful execution' },
          { status: 400 }
        )
      }
      
      // Store result ciphertext in ciphertextStore
      resultHandle = `ResultCID_${job_pda.slice(0, 8)}_${Date.now()}`
      
      try {
        // Store result ciphertext with proper metadata
        ciphertextStore.store_ciphertext(
          resultHandle,
          body.result_ciphertext,
          'hash_' + Date.now(), // Simple hash for demo
          {
            scheme: body.result_ciphertext.scheme || 'FHE16_0.0.1v',
            operation: body.result_ciphertext.operation || 'unknown'
          },
          {
            allow: ['decrypt'],
            version: '1.0',
            decrypt_by: 'public'
          },
          'policy_hash_' + Date.now(),
          'system', // System-generated result
          resultHandle,
          'executor'
        )
        
        // Mark as confirmed since it's executor-generated
        ciphertextStore.update_verification(resultHandle, 'confirmed', 'executor_result', Date.now())
        
        log.info('Result ciphertext stored', {
          job: job_pda.slice(0, 8) + '...',
          result_handle: resultHandle,
          ciphertext_size: JSON.stringify(body.result_ciphertext).length,
        })
      } catch (storeError) {
        log.error('Failed to store result ciphertext', storeError)
        // Continue anyway - return the handle for tracking
      }
      
      updateSuccess = jobQueue.complete_job(job_pda, resultHandle)

      log.info('Job completed successfully', {
        job: job_pda.slice(0, 8) + '...',
        executor: body.executor.slice(0, 8) + '...',
        execution_time_ms: body.execution_time_ms,
        result_handle: resultHandle,
      })
    } else {
      updateSuccess = jobQueue.fail_job(job_pda)

      log.warn('Job execution failed', {
        job: job_pda.slice(0, 8) + '...',
        executor: body.executor.slice(0, 8) + '...',
        error: body.error,
      })
    }

    if (!updateSuccess) {
      return NextResponse.json(
        { error: 'Failed to update job status' },
        { status: 500 }
      )
    }

    // Return updated job
    const updatedJob = jobQueue.get_job(job_pda)

    return NextResponse.json({
      success: true,
      job_status: updatedJob?.status,
      result_handle: resultHandle, // CID handle generated by Gatehouse
      message: body.success ? 'Job completed' : 'Job failed',
    })
  } catch (error) {
    log.error('Failed to submit result', error)
    return NextResponse.json(
      { error: 'Failed to submit result' },
      { status: 500 }
    )
  }
}
