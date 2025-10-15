/**
 * Solana Actions API: Challenge Leaf
 * Open challenge for specific batch result leaf (optimistic verification)
 * Phase 4: Challenge & Verification
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

function setCors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
  return res
}

export async function OPTIONS() {
  return setCors(new NextResponse(null, { status: 200 }))
}

// In-memory mock store for challenges (production would use database)
const challenges = new Map<string, any>()

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const commit_id = searchParams.get('commit_id')
  const leaf_idx = searchParams.get('leaf_idx')

  let challenge_status = null
  if (commit_id && leaf_idx !== null) {
    const challengeKey = `${commit_id}-leaf-${leaf_idx}`
    challenge_status = challenges.get(challengeKey) || { status: 'No challenge' }
  }

  return setCors(NextResponse.json({
    type: 'action',
    icon: 'http://localhost:3000/logo.png',
    title: 'Gatekeeper · Challenge Leaf',
    description: 'Open challenge for specific batch result leaf',
    label: 'Challenge Leaf',
    ...(challenge_status && {
      challenge_status,
    }),
    links: {
      actions: [{
        type: 'post',
        href: '/api/actions/batch/challenge_leaf',
        label: 'Open Challenge',
        parameters: [
          { name: 'commit_id', label: 'Commit ID (Batch PDA)', required: true, type: 'text' },
          { name: 'leaf_idx', label: 'Leaf Index', required: true, type: 'number' },
          { name: 'd_conflict', label: 'Conflicting Digest (0x...64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
          { name: 'merkle_proof', label: 'Merkle Proof (JSON array)', required: true, type: 'textarea' },
        ],
      }],
    },
    notes: {
      challenge_window: 'Challenges must be opened within challenge window',
      verification: 'Verifiers will re-execute and vote on correct digest',
      resolution: 'Majority vote determines accepted digest',
    },
  }))
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { commit_id, leaf_idx, d_conflict, merkle_proof } = body

    // Validation
    if (!commit_id || leaf_idx === undefined || !d_conflict || !merkle_proof) {
      return setCors(NextResponse.json({
        message: 'Missing required fields: commit_id, leaf_idx, d_conflict, merkle_proof'
      }, { status: 400 }))
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(d_conflict)) {
      return setCors(NextResponse.json({
        message: 'd_conflict must be 32-byte hex (0x...)'
      }, { status: 400 }))
    }

    const parsedMerkleProof = typeof merkle_proof === 'string'
      ? JSON.parse(merkle_proof)
      : merkle_proof

    if (!Array.isArray(parsedMerkleProof)) {
      return setCors(NextResponse.json({
        message: 'merkle_proof must be JSON array'
      }, { status: 400 }))
    }

    // Register challenge
    const challengeKey = `${commit_id}-leaf-${leaf_idx}`
    const challenge = {
      commit_id,
      leaf_idx,
      d_conflict,
      merkle_proof: parsedMerkleProof,
      status: 'ChallengeOpened',
      opened_at: new Date().toISOString(),
      verifiers: [],
    }

    challenges.set(challengeKey, challenge)

    // Simulate verifier re-execution (in production, this would be async)
    const verifier_count = 3
    const attestations = []

    for (let i = 0; i < verifier_count; i++) {
      const verifier_id = `verifier-${i + 1}`
      // Simulate deterministic re-execution
      const re_exec_digest = crypto.randomBytes(32).toString('hex')
      const attestation_sig = crypto.randomBytes(64).toString('hex')

      attestations.push({
        verifier_id,
        digest: `0x${re_exec_digest}`,
        signature: `0x${attestation_sig}`,
      })
    }

    // Majority vote (simplified)
    const digestCounts = new Map<string, number>()
    for (const att of attestations) {
      digestCounts.set(att.digest, (digestCounts.get(att.digest) || 0) + 1)
    }

    let accepted_digest = ''
    let maxCount = 0
    for (const [digest, count] of digestCounts.entries()) {
      if (count > maxCount) {
        maxCount = count
        accepted_digest = digest
      }
    }

    // Update leaf and recompute merkle root (simplified)
    const new_result_root = `0x${crypto.randomBytes(32).toString('hex')}`

    // Update challenge status
    challenge.status = 'Resolved'
    challenge.attestations = attestations
    challenge.accepted_digest = accepted_digest
    challenge.new_result_root = new_result_root
    challenge.resolved_at = new Date().toISOString()

    return setCors(NextResponse.json({
      message: 'Challenge opened and resolved',
      challenge: {
        commit_id,
        leaf_idx,
        status: 'Resolved',
      },
      verification: {
        verifiers: attestations.map(a => a.verifier_id),
        quorum: `${maxCount}/${verifier_count}`,
        accepted_digest,
        new_result_root,
      },
      attestations,
      note: 'This is a demo resolution. In production, verifiers would run asynchronously.',
    }))
  } catch (e: unknown) {
    console.error('Challenge leaf error:', e)
    return setCors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
