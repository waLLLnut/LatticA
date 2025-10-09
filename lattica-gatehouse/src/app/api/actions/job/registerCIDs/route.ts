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
import crypto from 'crypto'

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

// Hash utilities
function sha256Hex(b: Buffer | string): string {
  const buf = typeof b === 'string' ? Buffer.from(b) : b
  return '0x' + crypto.createHash('sha256').update(buf).digest('hex')
}

function hex32(h0x: string): Buffer {
  const h = h0x.startsWith('0x') ? h0x.slice(2) : h0x
  if (h.length !== 64) throw new Error('Expected 32-byte hex string')
  return Buffer.from(h, 'hex')
}

function canonicalJson(o: unknown): string {
  return JSON.stringify(o, Object.keys(o as Record<string, unknown>).sort())
}

export async function GET() {
  const fhe = getFHEcpkInfo()
  const fhe_cpk = {
    cpk_id: fhe.cpk_id,
    public_key: fhe.cpk_pub,
    domain_hash: sha256Hex(Buffer.concat([
      Buffer.from(fhe.domain.chain_id, 'utf8'),
      Buffer.from(fhe.domain.gatekeeper_program, 'utf8'),
      Buffer.from(fhe.cpk_id, 'utf8'),
      Buffer.from(String(fhe.domain.key_epoch), 'utf8'),
    ])),
    key_epoch: fhe.domain.key_epoch,
    scheme: fhe.domain.fhe_scheme,
  }
  
  return cors(NextResponse.json({
    type: 'action',
    icon: 'http://localhost:3000/logo.png',
    title: 'Gatekeeper · Register CID Handles',
    description: 'Register client-encrypted ciphertexts as on-chain Content Identifiers.',
    label: 'Register CIDs',
    fhe_cpk,
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
      storage: 'Ciphertexts stored off-chain (IPFS/Arweave), CID handles on-chain',
      receipt: 'Signed registration receipt issued for auditability'
    }
  }))
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { account } = body
    const ciphertexts = typeof body.ciphertexts === 'string' ? JSON.parse(body.ciphertexts) : body.ciphertexts
    const enc_params = typeof body.enc_params === 'string' ? JSON.parse(body.enc_params) : body.enc_params
    const policy_ctx = typeof body.policy_ctx === 'string' ? JSON.parse(body.policy_ctx) : body.policy_ctx
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
    const policy_hash = sha256Hex(Buffer.from(canonicalJson(policy_ctx), 'utf8'))

    // Hash ciphertexts and derive CID PDAs
    const cids = ciphertexts.map((ct: unknown) => {
      const ciphertext_hash = sha256Hex(Buffer.from(canonicalJson(ct), 'utf8'))
      const storage_ref = 'ipfs://Qm' + ciphertext_hash.slice(4, 50)

      const [cidPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('cid'), hex32(ciphertext_hash), hex32(policy_hash), owner.toBuffer()],
        gatekeeperProgram
      )

      return {
        cid_pda: cidPda.toBase58(),
        ciphertext_hash,
        policy_hash,
        storage_ref
      }
    })

    // Build register_cid instructions
    const registerDiscriminator = crypto
      .createHash('sha256')
      .update('global:register_cid')
      .digest()
      .subarray(0, 8)

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

    // Build registration receipt
    const receipt = {
      reg_id: `RID-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(4).toString('hex')}`,
      cids,
      enc_params,
      policy_ctx,
      provenance,
      domain: {
        chain_id: fhe.domain.chain_id,
        gatekeeper_program: fhe.domain.gatekeeper_program,
        cpk_id: fhe.cpk_id,
        key_epoch: fhe.domain.key_epoch,
      },
      created_at: Math.floor(Date.now() / 1000)
    }

    const nextHref = `/api/actions/job/submit?cids=${encodeURIComponent(JSON.stringify(cids.map(c => c.cid_pda)))}`

    return cors(NextResponse.json({
      transaction: Buffer.from(serializedTx).toString('base64'),
      message: `Register ${cids.length} CID handle(s) on-chain`,
      receipt,
      cids,
      links: { next: { type: 'post', href: nextHref } },
      note: 'After signing and sending this transaction, use the CID PDAs in /api/actions/job/submit'
    }))
  } catch (e: unknown) {
    console.error('Register CIDs error:', e)
    return cors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
