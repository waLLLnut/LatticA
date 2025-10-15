/**
 * Solana Actions API: Public Decryption
 * Request public decryption with domain signature verification
 * Phase 5a: Public Decryption
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

function hex64(h0x: string): Buffer {
  const h = h0x.startsWith('0x') ? h0x.slice(2) : h0x
  if (h.length !== 128) throw new Error('Expected 64-byte hex string')
  return Buffer.from(h, 'hex')
}

// Anchor discriminator for request_reveal_public instruction
const REQUEST_REVEAL_PUBLIC_DISCRIMINATOR = crypto
  .createHash('sha256')
  .update('global:request_reveal_public')
  .digest()
  .subarray(0, 8)

function deriveRevealReqPda(programId: PublicKey, handle: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('reveal_req'), hex32(handle)],
    programId
  )[0]
}

function buildRequestRevealPublicInstruction(args: {
  gatekeeperProgram: PublicKey
  requester: PublicKey
  revealReqPda: PublicKey
  handle: string
  domain_signature: string
}): TransactionInstruction {
  const data = Buffer.concat([
    REQUEST_REVEAL_PUBLIC_DISCRIMINATOR,
    hex32(args.handle),
    hex64(args.domain_signature),
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
    title: 'Gatekeeper · Public Decrypt',
    description: 'Request public decryption with domain signature',
    label: 'Public Decrypt',
    ...(handle && {
      preview: {
        handle,
        type: 'public',
      },
    }),
    links: {
      actions: [{
        type: 'post',
        href: '/api/actions/decrypt/public',
        label: 'Request Public Decrypt',
        parameters: [
          { name: 'handle', label: 'Handle (0x...64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
          { name: 'domain_signature', label: 'Domain Signature (0x...128hex)', required: true, pattern: '^0x[0-9a-fA-F]{128}$' },
          { name: 'purpose_ctx', label: 'Purpose Context (optional)', required: false, type: 'textarea' },
        ],
      }],
    },
    notes: {
      kms_threshold: 'KMS parties perform threshold decryption (t-of-n)',
      domain_signature: 'Domain signature required for public decrypt',
      result: 'Plaintext exposed on-chain (no session key encryption)',
    },
  }))
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { account, handle, domain_signature, purpose_ctx } = body

    // Validation
    if (!account || !handle || !domain_signature) {
      return setCors(NextResponse.json({
        message: 'Missing required fields: account, handle, domain_signature'
      }, { status: 400 }))
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(handle)) {
      return setCors(NextResponse.json({
        message: 'handle must be 32-byte hex (0x...)'
      }, { status: 400 }))
    }

    if (!/^0x[0-9a-fA-F]{128}$/.test(domain_signature)) {
      return setCors(NextResponse.json({
        message: 'domain_signature must be 64-byte hex (0x...)'
      }, { status: 400 }))
    }

    const fhe = getFHEcpkInfo()
    const gatekeeperProgram = new PublicKey(fhe.domain.gatekeeper_program)
    const requester = new PublicKey(account)

    // Derive reveal request PDA
    const revealReqPda = deriveRevealReqPda(gatekeeperProgram, handle)

    // Build request_reveal_public instruction
    const requestIx = buildRequestRevealPublicInstruction({
      gatekeeperProgram,
      requester,
      revealReqPda,
      handle,
      domain_signature,
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
      message: 'Public decrypt request ready for submission',
      verification: {
        reveal_req_pda: revealReqPda.toBase58(),
        handle,
        domain_signature,
        purpose_ctx: purpose_ctx || null,
        is_public: true,
      },
      kms_info: {
        parties: kms_parties,
        quorum,
        note: 'After transaction confirms, KMS parties will perform threshold decryption and expose plaintext on-chain',
      },
      links: {
        next: {
          type: 'get',
          href: `/api/actions/decrypt/result?handle=${handle}`,
        },
      },
    }))
  } catch (e: unknown) {
    console.error('Public decrypt error:', e)
    return setCors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
