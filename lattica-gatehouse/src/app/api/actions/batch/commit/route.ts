/**
 * Solana Actions API: Batch Commit
 * Commits batch execution results with merkle root (optimistic execution)
 * Phase 3: Batch Execution & Commit
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
import BN from 'bn.js'

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
      challenge_window_slots: 50, // Challenge window duration
    },
  }
}

function hex32(h0x: string): Buffer {
  const h = h0x.startsWith('0x') ? h0x.slice(2) : h0x
  if (h.length !== 64) throw new Error('Expected 32-byte hex string')
  return Buffer.from(h, 'hex')
}

// Anchor discriminator for commit_batch instruction
const COMMIT_BATCH_DISCRIMINATOR = crypto
  .createHash('sha256')
  .update('global:commit_batch')
  .digest()
  .subarray(0, 8)

function deriveBatchPda(programId: PublicKey, windowStartSlot: number): PublicKey {
  const slotBytes = Buffer.alloc(8)
  new BN(windowStartSlot).toArrayLike(Buffer, 'le', 8).copy(slotBytes)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('batch'), slotBytes],
    programId
  )[0]
}

function deriveConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0]
}

function buildCommitBatchInstruction(args: {
  gatekeeperProgram: PublicKey
  payer: PublicKey
  configPda: PublicKey
  batchPda: PublicKey
  window_start_slot: number
  commit_root: string
  result_commitment: string
  processed_until_slot: number
}): TransactionInstruction {
  const data = Buffer.concat([
    COMMIT_BATCH_DISCRIMINATOR,
    Buffer.from(new BN(args.window_start_slot).toArrayLike(Buffer, 'le', 8)),
    hex32(args.commit_root),
    hex32(args.result_commitment),
    Buffer.from(new BN(args.processed_until_slot).toArrayLike(Buffer, 'le', 8)),
  ])

  const keys = [
    { pubkey: args.configPda, isSigner: false, isWritable: false },
    { pubkey: args.batchPda, isSigner: false, isWritable: true },
    { pubkey: args.payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  return new TransactionInstruction({
    programId: args.gatekeeperProgram,
    keys,
    data,
  })
}

export async function GET() {
  const fhe = getFHEcpkInfo()

  return setCors(NextResponse.json({
    type: 'action',
    icon: 'http://localhost:3000/logo.png',
    title: 'Gatekeeper · Commit Batch',
    description: 'Commit batch execution results with merkle root (optimistic)',
    label: 'Commit Batch',
    challenge_window_slots: fhe.domain.challenge_window_slots,
    links: {
      actions: [{
        type: 'post',
        href: '/api/actions/batch/commit',
        label: 'Commit Batch',
        parameters: [
          { name: 'window_start_slot', label: 'Window Start Slot', required: true, type: 'number' },
          { name: 'commit_root', label: 'Commit Root (0x...64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
          { name: 'result_commitment', label: 'Result Commitment (0x...64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
          { name: 'processed_until_slot', label: 'Processed Until Slot', required: true, type: 'number' },
        ],
      }],
    },
    notes: {
      optimistic: 'Results are committed immediately, challenge window opens',
      challenge_window: `${fhe.domain.challenge_window_slots} slots for dispute`,
      finalization: 'Auto-finalizes if no challenge raised',
    },
  }))
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { account, window_start_slot, commit_root, result_commitment, processed_until_slot } = body

    // Validation
    if (!account || window_start_slot === undefined || !commit_root || !result_commitment || processed_until_slot === undefined) {
      return setCors(NextResponse.json({
        message: 'Missing required fields: account, window_start_slot, commit_root, result_commitment, processed_until_slot'
      }, { status: 400 }))
    }

    if (!/^0x[0-9a-fA-F]{64}$/.test(commit_root) || !/^0x[0-9a-fA-F]{64}$/.test(result_commitment)) {
      return setCors(NextResponse.json({
        message: 'commit_root and result_commitment must be 32-byte hex (0x...)'
      }, { status: 400 }))
    }

    const fhe = getFHEcpkInfo()
    const gatekeeperProgram = new PublicKey(fhe.domain.gatekeeper_program)
    const payer = new PublicKey(account)

    // Derive PDAs
    const configPda = deriveConfigPda(gatekeeperProgram)
    const batchPda = deriveBatchPda(gatekeeperProgram, window_start_slot)

    // Build commit_batch instruction
    const commitIx = buildCommitBatchInstruction({
      gatekeeperProgram,
      payer,
      configPda,
      batchPda,
      window_start_slot,
      commit_root,
      result_commitment,
      processed_until_slot,
    })

    // Build transaction
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction()
    tx.feePayer = payer
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight
    tx.add(commitIx)

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    // Calculate window_end
    const currentSlot = await connection.getSlot('confirmed')
    const window_end = currentSlot + fhe.domain.challenge_window_slots

    return setCors(NextResponse.json({
      transaction: Buffer.from(serializedTx).toString('base64'),
      message: `Commit batch for window ${window_start_slot}`,
      commit_id: batchPda.toBase58(),
      status: 'Pending',
      committed_slot: currentSlot,
      window_end,
      verification: {
        batch_pda: batchPda.toBase58(),
        config_pda: configPda.toBase58(),
        window_start_slot,
        commit_root,
        result_commitment,
        processed_until_slot,
        challenge_window_slots: fhe.domain.challenge_window_slots,
      },
      links: {
        next: {
          type: 'get',
          href: `/api/actions/batch/challenge_leaf?commit_id=${batchPda.toBase58()}`,
        },
      },
    }))
  } catch (e: unknown) {
    console.error('Batch commit error:', e)
    return setCors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
