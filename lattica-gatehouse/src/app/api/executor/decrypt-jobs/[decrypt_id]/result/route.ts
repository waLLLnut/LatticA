/**
 * Executor Decrypt Result Submission API
 * Executor submits decryption result
 */
import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'
import { decryptQueue } from '@/services/queue/decrypt-queue'

const log = createLogger('API:DecryptResult')

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ decrypt_id: string }> }
) {
  try {
    const { decrypt_id } = await params
    const body = await request.json()

    const { executor, success, decrypted_value, error } = body

    if (!executor) {
      return NextResponse.json(
        { error: 'Missing executor ID' },
        { status: 400 }
      )
    }

    // Get job
    const job = decryptQueue.get(decrypt_id)
    if (!job) {
      return NextResponse.json(
        { error: 'Decrypt job not found' },
        { status: 404 }
      )
    }

    // Assign if not already assigned
    if (job.status === 'pending') {
      decryptQueue.assign(decrypt_id, executor)
    }

    // Update with result
    if (success && decrypted_value !== undefined) {
      decryptQueue.complete(decrypt_id, decrypted_value)
      
      log.info('Decrypt result received', {
        decrypt_id,
        executor: executor.slice(0, 8) + '...',
        decrypted_value,
        cid: job.cid.slice(0, 8) + '...'
      })

      return NextResponse.json({
        success: true,
        decrypt_id,
        decrypted_value
      })
    } else {
      decryptQueue.fail(decrypt_id, error || 'Unknown error')
      
      log.error('Decrypt failed', {
        decrypt_id,
        error
      })

      return NextResponse.json({
        success: false,
        decrypt_id,
        error
      })
    }

  } catch (err) {
    log.error('Decrypt result submission failed', {
      error: err instanceof Error ? err.message : String(err)
    })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

