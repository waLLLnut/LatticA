/**
 * Decrypt Request API
 * UI submits decrypt request for a CID
 */
import { NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logger'
import { decryptQueue } from '@/services/queue/decrypt-queue'
import { ciphertextStore } from '@/services/storage/ciphertext-store'

const log = createLogger('API:Decrypt')

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { cid, requester } = body

    if (!cid || !requester) {
      return NextResponse.json(
        { error: 'Missing required fields: cid, requester' },
        { status: 400 }
      )
    }

    // Check if CID exists
    const stored = ciphertextStore.get(cid)
    if (!stored) {
      return NextResponse.json(
        { error: 'CID not found' },
        { status: 404 }
      )
    }

    // Create decrypt job
    const job = decryptQueue.create(cid, requester)

    log.info('Decrypt request created', {
      decrypt_id: job.decrypt_id,
      cid: cid.slice(0, 8) + '...',
      requester: requester.slice(0, 8) + '...'
    })

    return NextResponse.json({
      success: true,
      decrypt_id: job.decrypt_id,
      cid,
      status: job.status,
      message: 'Decrypt job created. Waiting for executor...'
    })

  } catch (error) {
    log.error('Decrypt request failed', { 
      error: error instanceof Error ? error.message : String(error) 
    })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const decrypt_id = searchParams.get('decrypt_id')

    if (!decrypt_id) {
      return NextResponse.json(
        { error: 'Missing decrypt_id parameter' },
        { status: 400 }
      )
    }

    const job = decryptQueue.get(decrypt_id)
    if (!job) {
      return NextResponse.json(
        { error: 'Decrypt job not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({
      decrypt_id: job.decrypt_id,
      cid: job.cid,
      status: job.status,
      decrypted_value: job.decrypted_value,
      error: job.error,
      completed_at: job.completed_at
    })

  } catch (error) {
    log.error('Decrypt status check failed', { 
      error: error instanceof Error ? error.message : String(error) 
    })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

