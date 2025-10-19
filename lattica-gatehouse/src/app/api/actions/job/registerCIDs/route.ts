/**
 * Solana Actions API: Register CID Handles
 * Creates transactions for registering encrypted data as Content Identifiers (CIDs)
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Connection,
} from '@solana/web3.js'
import { createLogger } from '@/lib/logger'
import { pendingCiphertextStore } from '@/services/storage/pending-store'
import { ciphertextStore } from '@/services/storage/ciphertext-store'
import { registrationLog } from '@/services/storage/registration-log'
import { sha256Hex, hex32, canonicalJson, calcDomainHash } from '@/lib/crypto-utils'
import { getInstructionDiscriminator } from '@/lib/anchor-utils'
import type { EncryptionParams, PolicyContext } from '@/types/ciphertext'

const log = createLogger('API:RegisterCIDs')
const connection = new Connection('https://api.devnet.solana.com', 'confirmed')
const MAX_CIDS = 16

function cors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
  return res
}

export async function OPTIONS() { 
  return cors(new NextResponse(null, { status: 200 })) 
}

function getFHEcpkInfo() {
  return {
    cpk_id: 'v1-2025',
    cpk_pub: 'base64_public_key_here',
    domain: {
      chain_id: 'devnet',
      gatekeeper_program: 'GateF9qDULEJRgt6m1prkmUWrEXGVhDzYCgCJtGtnwu9',
      key_epoch: 7,
      key_expiry_slot: 234567890,
      fhe_scheme: 'FHE16',
      ir_schema_hash: '0x'.padEnd(66, 'A'),
      enc_params_schema_hash: '0x'.padEnd(66, 'B'),
      policy_schema_hash: '0x'.padEnd(66, 'C'),
      kms_threshold: { t: 3, n: 5 },
      dkg_transcript_hash: '0x'.padEnd(66, 'D'),
    },
    attestation: { committee_roothash: '0x'.padEnd(66, 'E'), issued_at: 1700000000, expires_at: 1731535999 },
    sig: { algo: 'ed25519', by: 'ConfigAuthority11111111111111111111111111111111', signature: 'base64_sig_here' },
  }
}

export async function GET() {
  const fhe = getFHEcpkInfo()
  const domain_hash = calcDomainHash({
    chain_id: fhe.domain.chain_id,
    gatekeeper_program: fhe.domain.gatekeeper_program,
    cpk_id: fhe.cpk_id,
    key_epoch: fhe.domain.key_epoch,
  })
  
  const fhe_cpk = {
    cpk_id: fhe.cpk_id,
    public_key: fhe.cpk_pub,
    domain_hash,
    key_epoch: fhe.domain.key_epoch,
    scheme: fhe.domain.fhe_scheme,
  }

  // Get storage stats for monitoring
  const confirmedStats = ciphertextStore.get_stats()
  const pendingStats = pendingCiphertextStore.get_stats()
  
  return cors(NextResponse.json({
    type: 'action',
    icon: 'http://localhost:3000/logo.png',
    title: 'Gatekeeper · Register CID Handles',
    description: 'Register client-encrypted ciphertexts as on-chain Content Identifiers.',
    label: 'Register CIDs',
    fhe_cpk,
    storage_stats: {
      confirmed_cids: confirmedStats.confirmed_count,
      pending_cids: pendingStats.total_pending,
      total_cids: confirmedStats.total_cids,
      capacity: `${confirmedStats.total_cids}/10000`,
    },
    links: {
      actions: [{
        type: 'post',
        href: '/api/actions/job/registerCIDs',
        label: 'Register CIDs',
        parameters: [
          { name: 'ciphertexts', label: 'Ciphertexts (JSON)', required: true, type: 'textarea' },
          { name: 'enc_params', label: 'Encryption Params (JSON)', required: true, type: 'textarea' },
          { name: 'policy_ctx', label: 'Policy Context (JSON)', required: true, type: 'textarea' },
          { name: 'provenance', label: 'Provenance', required: false, type: 'text' },
        ]
      }]
    },
    notes: {
      encryption: 'Use FHE CPK to encrypt plaintext off-chain',
      storage: 'Ciphertexts stored temporarily (5min TTL). Only confirmed after on-chain event.',
      receipt: 'Registration receipt issued. Monitor on-chain events for confirmation.',
      workflow: 'POST returns tx → sign & send → on-chain event → confirmed storage'
    }
  }))
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { account } = body
    const ciphertexts = typeof body.ciphertexts === 'string' ? JSON.parse(body.ciphertexts) : body.ciphertexts
    const enc_params: EncryptionParams = typeof body.enc_params === 'string' ? JSON.parse(body.enc_params) : body.enc_params
    const policy_ctx: PolicyContext = typeof body.policy_ctx === 'string' ? JSON.parse(body.policy_ctx) : body.policy_ctx
    const provenance = body.provenance || 'client'

    // Validation
    if (!account || !ciphertexts || !enc_params || !policy_ctx) {
      return cors(NextResponse.json({
        message: 'Missing required fields: account, ciphertexts, enc_params, policy_ctx'
      }, { status: 400 }))
    }

    if (!Array.isArray(ciphertexts) || ciphertexts.length === 0) {
      return cors(NextResponse.json({ message: 'ciphertexts must be non-empty array' }, { status: 400 }))
    }

    if (ciphertexts.length > MAX_CIDS) {
      return cors(NextResponse.json({ message: `Too many ciphertexts (max ${MAX_CIDS})` }, { status: 400 }))
    }

    const owner = new PublicKey(account)
    const fhe = getFHEcpkInfo()
    const gatekeeperProgram = new PublicKey(fhe.domain.gatekeeper_program)
    const policy_hash = sha256Hex(canonicalJson(policy_ctx))

    // Hash ciphertexts and derive CID PDAs
    const cids = ciphertexts.map((ct: unknown) => {
      const ciphertext_hash = sha256Hex(canonicalJson(ct))
      const storage_ref = 'ipfs://Qm' + ciphertext_hash.slice(4, 50)

      const [cidPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('cid'), hex32(ciphertext_hash), hex32(policy_hash), owner.toBuffer()],
        gatekeeperProgram
      )

      return {
        cid_pda: cidPda.toBase58(),
        ciphertext_hash,
        policy_hash,
        storage_ref,
        ciphertext: ct,
      }
    })

    // Store ciphertexts in PendingStore (not confirmed yet!)
    try {
      for (const cid of cids) {
        pendingCiphertextStore.store_temporary(
          cid.cid_pda,
          cid.ciphertext,
          cid.ciphertext_hash,
          enc_params,
          policy_ctx,
          policy_hash,
          owner.toBase58(),
          cid.storage_ref,
          provenance,
        )
      }
    } catch (storageError) {
      log.error('Pending storage error', storageError)
      return cors(NextResponse.json({
        message: storageError instanceof Error ? storageError.message : 'Storage error',
      }, { status: 500 }))
    }

    // Create registration log entry
    const registration = registrationLog.create_registration(
      cids.map(c => c.cid_pda),
      cids.map(c => c.ciphertext_hash),
      cids.map(() => policy_hash),
      owner.toBase58(),
      {
        chain_id: fhe.domain.chain_id,
        gatekeeper_program: fhe.domain.gatekeeper_program,
        cpk_id: fhe.cpk_id,
        key_epoch: fhe.domain.key_epoch,
      }
    )

    // Build register_cid_handle instructions
    // Use IDL discriminator (never calculate manually!)
    const registerDiscriminator = getInstructionDiscriminator('register_cid_handle')

    const instructions = cids.map(({ cid_pda, ciphertext_hash }) => {
      const data = Buffer.concat([
        registerDiscriminator,
        hex32(ciphertext_hash),
        hex32(policy_hash),
      ])

      const keys = [
        { pubkey: new PublicKey(cid_pda), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ]

      return new TransactionInstruction({ programId: gatekeeperProgram, keys, data })
    })

    // Build transaction with recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction()
    tx.feePayer = owner
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight
    tx.add(...instructions)

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    const nextHref = `/api/actions/job/submit?cids=${encodeURIComponent(JSON.stringify(cids.map(c => c.cid_pda)))}`

    log.info('Created pending registration', { 
      reg_id: registration.reg_id.slice(0, 8) + '...', 
      cids: cids.length 
    })

    return cors(NextResponse.json({
      transaction: Buffer.from(serializedTx).toString('base64'),
      message: `Register ${cids.length} CID handle(s) on-chain`,
      registration: {
        reg_id: registration.reg_id,
        status: 'pending',  // Will be 'confirmed' after on-chain event
        created_at: registration.created_at,
      },
      cids: cids.map(c => ({
        cid_pda: c.cid_pda,
        ciphertext_hash: c.ciphertext_hash,
        policy_hash: c.policy_hash,
        storage_ref: c.storage_ref,
      })),
      links: { next: { type: 'post', href: nextHref } },
      workflow: {
        current: 'Transaction created',
        next_steps: [
          '1. Sign and send this transaction',
          '2. Wait for on-chain confirmation',
          '3. EventListener will move CIDs from pending → confirmed',
          '4. Use confirmed CID PDAs in /api/actions/job/submit'
        ]
      },
      note: 'CIDs are pending (5min TTL). Only usable after on-chain confirmation event.'
    }))
  } catch (e: unknown) {
    log.error('Register CIDs error', e)
    return cors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
