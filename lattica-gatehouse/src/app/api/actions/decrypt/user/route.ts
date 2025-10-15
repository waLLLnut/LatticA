/**
 * Solana Actions API: User Decryption
 * Request user-specific decryption with session key
 * Phase 5b: User Decryption
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Connection,
} from '@solana/web3.js'
import crypto from 'crypto'

const connection = new Connection('https://api.devnet.solana.com', 'confirmed')

function setCors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
  return res
}

export async function OPTIONS() {
  return setCors(new NextResponse(null, { status: 200 }))
}

function getFHEcpkInfo() {
  return {
    cpk_id: 'v1-2025',
    domain: {
      chain_id: 'devnet',
      gatekeeper_program: 'GateF9qDULEJRgt6m1prkmUWrEXGVhDzYCgCJtGtnwu9',
      key_epoch: 7,
    },
  }
}

function hex32(h0x: string): Buffer {
  const h = h0x.startsWith('0x') ? h0x.slice(2) : h0x
  if (h.length !== 64) throw new Error('Expected 32-byte hex string')
  return Buffer.from(h, 'hex')
}

// Anchor discriminator for request_reveal_private instruction
const REQUEST_REVEAL_PRIVATE_DISCRIMINATOR = crypto
  .createHash('sha256')
  .update('global:request_reveal_private')
  .digest()
  .subarray(0, 8)

function deriveRevealReqPda(programId: PublicKey, handle: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reveal_req'), hex32(handle)],
    programId
  )[0]
}

function buildRequestRevealPrivateInstruction(args: {
  gatekeeperProgram: PublicKey
  requester: PublicKey
  revealReqPda: PublicKey
  handle: string
  user_session_pubkey: string
}): TransactionInstruction {
  const data = Buffer.concat([
    REQUEST_REVEAL_PRIVATE_DISCRIMINATOR,
    hex32(args.handle),
    hex32(args.user_session_pubkey),
  ])

  const keys = [
    { pubkey: args.revealReqPda, isSigner: false, isWritable: true },
    { pubkey: args.requester, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  return new TransactionInstruction({
    programId: args.gatekeeperProgram,
    keys,
    data,
  })
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const handle = searchParams.get('handle')

  return setCors(NextResponse.json({
    type: 'action',
    icon: 'http://localhost:3000/logo.png',
    title: 'Gatekeeper · User Decrypt',
    description: 'Request user-specific decryption with session key',
    label: 'User Decrypt',
    ...(handle && {
      preview: {
        handle,
        type: 'user',
      },
    }),
    links: {
      actions: [{
        type: 'post',
        href: '/api/actions/decrypt/user',
        label: 'Request User Decrypt',
        parameters: [
          { name: 'handle', label: 'Handle (0x...64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
          { name: 'user_session_pubkey', label: 'User Session Public Key (0x...64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
          { name: 'purpose_ctx', label: 'Purpose Context (optional)', required: false, type: 'textarea' },
        ],
      }],
    },
    notes: {
      kms_threshold: 'KMS parties perform threshold decryption (t-of-n)',
      session_key: 'Result sealed with user session key (no domain signature required)',
      acl: 'User-specific ACL verification by KMS',
    },
  }))
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { account, handle, user_session_pubkey, purpose_ctx } = body

    // Validation
    if (!account || !handle || !user_session_pubkey) {
      return setCors(NextResponse.json({
        message: 'Missing required fields: account, handle, user_session_pubkey'
      }, { status: 400 }))
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(handle) || !/^0x[0-9a-fA-F]{64}$/.test(user_session_pubkey)) {
      return setCors(NextResponse.json({
        message: 'handle and user_session_pubkey must be 32-byte hex (0x...)'
      }, { status: 400 }))
    }

    const fhe = getFHEcpkInfo()
    const gatekeeperProgram = new PublicKey(fhe.domain.gatekeeper_program)
    const requester = new PublicKey(account)

    // Derive reveal request PDA
    const revealReqPda = deriveRevealReqPda(gatekeeperProgram, handle)

    // Build request_reveal_private instruction
    const requestIx = buildRequestRevealPrivateInstruction({
      gatekeeperProgram,
      requester,
      revealReqPda,
      handle,
      user_session_pubkey,
    })

    // Build transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction()
    tx.feePayer = requester
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight
    tx.add(requestIx)

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    // Generate demo KMS response (in production, KMS parties would respond)
    const kms_parties = ['kms-party-1', 'kms-party-2', 'kms-party-3']
    const quorum = '2-of-3'

    return setCors(NextResponse.json({
      transaction: Buffer.from(serializedTx).toString('base64'),
      message: 'User decrypt request ready for submission',
      verification: {
        reveal_req_pda: revealReqPda.toBase58(),
        handle,
        user_session_pubkey,
        purpose_ctx: purpose_ctx || null,
        is_public: false,
      },
      kms_info: {
        parties: kms_parties,
        quorum,
        note: 'After transaction confirms, KMS parties will perform threshold decryption',
      },
      links: {
        next: {
          type: 'get',
          href: `/api/actions/decrypt/result?handle=${handle}`,
        },
      },
    }))
  } catch (e: unknown) {
    console.error('User decrypt error:', e)
    return setCors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
