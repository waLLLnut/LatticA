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
import bs58 from 'bs58'
import { createHash } from 'crypto'

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
      
      // Determine which state CID to update based on operation
      // deposit: update input[0] (SOL balance)
      // withdraw: update input[0] (USDC balance)  
      // borrow: update input[2] (USDC balance)
      // defi_operation: dynamic (2 inputs=withdraw, 3 inputs=borrow)
      const irDigest = job.ir_digest || ''
      const inputCount = job.cid_handles?.length || 0
      let stateCidToUpdate: string | undefined
      
      if (irDigest === '0xadd0000000000000000000000000000000000000000000000000000000000000') {
        // deposit operation: update SOL balance (input[0])
        stateCidToUpdate = job.cid_handles?.[0]
      } else if (irDigest === '0xwithdrw000000000000000000000000000000000000000000000000000000000') {
        // withdraw operation: update USDC balance (input[0])
        stateCidToUpdate = job.cid_handles?.[0]
      } else if (irDigest === '0xmul0000000000000000000000000000000000000000000000000000000000000') {
        // borrow operation: update USDC balance (input[2])
        stateCidToUpdate = job.cid_handles?.[2]
      } else if (irDigest === '0x8fae5df19cb6bc3db4ea7dfc14a9696be683910c9fee64d839a6eef9981129a1') {
        // defi_operation: dynamic based on input count
        if (inputCount === 2) {
          // withdraw: update USDC balance (input[0])
          stateCidToUpdate = job.cid_handles?.[0]
        } else if (inputCount === 3) {
          // borrow: update USDC balance (input[2])
          stateCidToUpdate = job.cid_handles?.[2]
        }
      }
      
      if (!stateCidToUpdate) {
        log.error('Cannot determine state CID to update', {
          job: job_pda.slice(0, 8) + '...',
          ir_digest: irDigest,
          cid_count: job.cid_handles?.length
        })
        return NextResponse.json(
          { error: 'Cannot determine state CID to update' },
          { status: 500 }
        )
      }
      
      try {
        // Update the state CID's ciphertext content
        const updateSuccess = ciphertextStore.update_ciphertext_content(
          stateCidToUpdate,
          body.result_ciphertext
        )
        
        if (!updateSuccess) {
          throw new Error('Failed to update state CID')
        }
        
        resultHandle = stateCidToUpdate  // Return the updated state CID
        
        log.info('State CID updated with executor result', {
          job: job_pda.slice(0, 8) + '...',
          state_cid: stateCidToUpdate.slice(0, 8) + '...',
          ir_digest: irDigest.slice(0, 10) + '...',
          ciphertext_size: JSON.stringify(body.result_ciphertext).length,
        })
      } catch (storeError) {
        log.error('Failed to update state CID', storeError)
        return NextResponse.json(
          { error: 'Failed to update state CID' },
          { status: 500 }
        )
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
