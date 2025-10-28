/**
 * CID-based Ciphertext Retrieval API
 * Get ciphertext and metadata by CID handle
 */

import { NextRequest, NextResponse } from 'next/server'
import { ciphertextStore } from '@/services/storage/ciphertext-store'
import { createLogger } from '@/lib/logger'

const log = createLogger('API:Ciphertext')

export const dynamic = 'force-dynamic'

function setCors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  return res
}

export async function OPTIONS() {
  return setCors(new NextResponse(null, { status: 200 }))
}

/**
 * GET /api/ciphertext/{cid}
 * 
 * Returns ciphertext data and metadata for the given CID handle
 * Used for result retrieval and decryption requests
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cid: string }> }
) {
  try {
    const { cid } = await params

    if (!cid) {
      return setCors(NextResponse.json({
        error: 'CID parameter is required'
      }, { status: 400 }))
    }

    log.debug('Fetching ciphertext', { cid: cid.substring(0, 16) + '...' })

    // Get ciphertext from store
    const stored = ciphertextStore.get(cid)
    
    if (!stored) {
      log.warn('CID not found', { cid: cid.substring(0, 16) + '...' })
      return setCors(NextResponse.json({
        error: 'CID not found',
        cid
      }, { status: 404 }))
    }

    // Extract computation result if available (for executor-generated results)
    let computationResult = null
    let computationDescription = null
    
    if (stored.ciphertext && typeof stored.ciphertext === 'object') {
      computationResult = stored.ciphertext.decrypted_result
      computationDescription = stored.ciphertext.computation_description
    }

    const response = {
      cid_pda: stored.cid_pda,
      ciphertext: stored.ciphertext,
      ciphertext_hash: stored.ciphertext_hash,
      enc_params: stored.enc_params,
      policy_ctx: stored.policy_ctx,
      metadata: {
        owner: stored.metadata.owner,
        provenance: stored.metadata.provenance,
        created_at: stored.metadata.created_at,
      },
      verification: stored.verification,
      // Include computation result for demo purposes
      computation_result: computationResult,
      computation_description: computationDescription,
    }

    log.info('Ciphertext retrieved', {
      cid: cid.substring(0, 16) + '...',
      owner: stored.metadata.owner.substring(0, 8) + '...',
      has_computation_result: !!computationResult,
    })

    return setCors(NextResponse.json(response))

  } catch (error) {
    log.error('Failed to retrieve ciphertext', error, {
      error_message: error instanceof Error ? error.message : String(error),
    })
    
    return setCors(NextResponse.json({
      error: 'Failed to retrieve ciphertext',
      details: error instanceof Error ? error.message : String(error),
    }, { status: 500 }))
  }
}