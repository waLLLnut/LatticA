/**
 * Solana Actions API: Submit Confidential Job
 * Creates transactions for submitting FHE jobs with registered CID references
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
import { cidValidator } from '@/services/validation/cid-validator'
import { 
  hex32, 
  calcCidSetId, 
  calcPolicyHash, 
  calcDomainHash, 
  calcCommitment,
  generateNonce,
  isValidHex32 
} from '@/lib/crypto-utils'
import { getInstructionDiscriminator } from '@/lib/anchor-utils'
import type { PolicyContext } from '@/types/ciphertext'

const log = createLogger('API:SubmitJob')
const connection = new Connection('https://api.devnet.solana.com', 'confirmed')
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const MAX_CIDS = 16

function setCors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
  return res
}

export async function OPTIONS() { 
  return setCors(new NextResponse(null, { status: 200 })) 
}

// FHE Collective Public Key configuration (demo values)
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

// Use crypto-utils instead of local implementations

// Anchor discriminator for submit_job instruction
// Extracted from IDL (never calculate manually!)
// @see src/idl/lattica_gatekeeper.json line 455-463
const SUBMIT_DISCRIMINATOR = getInstructionDiscriminator('submit_job')

function buildSubmitJobInstruction(args: {
  gatekeeperProgram: PublicKey
  submitter: PublicKey
  batch: PublicKey
  cidSetIdHex: string
  commitmentHex: string
  irDigestHex: string
  policyHashHex: string
  configPda: PublicKey
  jobPda: PublicKey
  cidHandles: PublicKey[]
  provenance: number
}): TransactionInstruction {
  const data = Buffer.concat([
    SUBMIT_DISCRIMINATOR,
    args.batch.toBuffer(),
    hex32(args.cidSetIdHex),
    hex32(args.commitmentHex),
    hex32(args.irDigestHex),
    hex32(args.policyHashHex),
    Buffer.from([args.provenance]),
  ])
  
  const keys = [
    { pubkey: args.configPda, isSigner: false, isWritable: false },
    { pubkey: args.jobPda, isSigner: false, isWritable: true },
    { pubkey: args.batch, isSigner: false, isWritable: false },
    { pubkey: args.submitter, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...args.cidHandles.map(cid => ({ 
      pubkey: cid, 
      isSigner: false, 
      isWritable: false 
    }))
  ]
  
  return new TransactionInstruction({ 
    programId: args.gatekeeperProgram, 
    keys, 
    data 
  })
}

function deriveConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0]
}

function deriveJobPda(programId: PublicKey, commitmentHex: string, submitter: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('job'), hex32(commitmentHex), submitter.toBuffer()], 
    programId
  )[0]
}

export async function GET(request: NextRequest) {
  const fhe = getFHEcpkInfo()
  const domain_hash = calcDomainHash({
    chain_id: fhe.domain.chain_id,
    gatekeeper_program: fhe.domain.gatekeeper_program,
    cpk_id: fhe.cpk_id,
    key_epoch: fhe.domain.key_epoch,
  })
  
  const { searchParams } = new URL(request.url)
  const cidsParam = searchParams.get('cids')
  
  let preview = null
  if (cidsParam) {
    try {
      const cids = JSON.parse(cidsParam)
      const cid_count = Array.isArray(cids) ? cids.length : 0
      
      preview = {
        status: cid_count > 0 && cid_count <= MAX_CIDS ? 'ready' : 'invalid',
        cid_count,
        message: cid_count > 0 && cid_count <= MAX_CIDS
          ? `Ready to submit job with ${cid_count} CID reference(s)`
          : cid_count > MAX_CIDS
          ? `Too many CIDs (max ${MAX_CIDS})`
          : 'No CIDs provided. Use /api/actions/job/registerCIDs first.'
      }
    } catch {
      preview = { status: 'error', message: 'Invalid cids parameter format' }
    }
  }

  // Generate dynamic base URL
  const baseURL = new URL(request.url).origin

  const body = {
    type: 'action',
    icon: new URL('/logo.png', baseURL).toString(),
    title: 'Gatekeeper · Submit Confidential Job',
    description: 'Submit a confidential computation job using registered CIDs.',
    label: 'Submit Confidential Job',
    disabled: false,
    policy: {
      hashAlgorithm: 'sha256',
      inputRequirement: `cids = JSON array of CID PDA addresses from /registerCIDs (max ${MAX_CIDS}).`,
      canonicalization: 'policy_ctx is canonical-JSON stringified (sorted keys).',
      nonce: '32-byte hex (0x + 64). If omitted on POST, server generates and returns it.',
      remaining_accounts: 'CID handles are passed as remaining_accounts in transaction',
    },
    domain: { ...fhe, domain_hash },
    hashSpec: {
      cid_set_id: 'sha256(concat(cid_handle_1 || cid_handle_2 || ... )) -> 32B hex',
      policy_hash: 'sha256(canonical_json(policy_ctx)) -> 32B hex',
      domain_hash: 'sha256(chain_id || program || cpk_id || epoch) -> 32B hex',
      commitment: 'sha256(cid_set_id || ir_digest || policy_hash || domain_hash || nonce) -> 32B hex',
      argOrder: ['batch', 'cid_set_id', 'commitment', 'ir_digest', 'policy_hash', 'provenance'],
      accountsOrder: ['config', 'job', 'batch', 'submitter', 'system_program', '...cid_handles (remaining)'],
    },
    ...(preview && { preview }),
    links: {
      actions: [{
        href: `${baseURL}/api/actions/job/submit?cids={cids}&batch={batch}&ir_digest={ir_digest}&policy_ctx={policy_ctx}&provenance={provenance}&nonce={nonce}`,
        label: 'Submit Job',
        parameters: [
          { name: 'cids', label: 'Registered CID PDAs (JSON array)', required: true },
          { name: 'batch', label: 'Batch Window Pubkey', required: true },
          { name: 'ir_digest', label: 'IR Digest (0x…64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
          { name: 'policy_ctx', label: 'Policy Context (JSON)', required: true },
          { name: 'provenance', label: 'Provenance (0=server, 1=client)', required: false, type: 'number' },
          { name: 'nonce', label: 'Optional Nonce (0x…64hex)', required: false, pattern: '^0x[0-9a-fA-F]{64}$' },
        ],
      }],
    },
  }
  return setCors(NextResponse.json(body))
}

/* =============================== POST ============================= */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json()
    const url = new URL(req.url)

    // Get parameters from either query params (Blinks Inspector) or body (Dial.to)
    const bodyData = rawBody.data || rawBody
    const account = rawBody.account

    // Try query params first, then fall back to body
    const cids_raw = url.searchParams.get('cids') || bodyData.cids
    const batch_raw = url.searchParams.get('batch') || bodyData.batch
    const ir_digest_raw = url.searchParams.get('ir_digest') || bodyData.ir_digest
    const policy_ctx_raw = url.searchParams.get('policy_ctx') || bodyData.policy_ctx
    const provenance_raw = url.searchParams.get('provenance') || bodyData.provenance || '1'
    const nonce_raw = url.searchParams.get('nonce') || bodyData.nonce

    // Validation
    if (!account || !cids_raw || !batch_raw || !ir_digest_raw || !policy_ctx_raw) {
      return setCors(NextResponse.json({
        message: 'Missing required fields: account, cids, batch, ir_digest, policy_ctx'
      }, { status: 400 }))
    }

    // Parse JSON parameters with error handling
    let parsedCids: string[], parsedPolicyCtx: PolicyContext
    try {
      parsedCids = typeof cids_raw === 'string' ? JSON.parse(cids_raw) : cids_raw
      parsedPolicyCtx = typeof policy_ctx_raw === 'string' ? JSON.parse(policy_ctx_raw) : policy_ctx_raw
    } catch {
      return setCors(NextResponse.json({
        message: 'Invalid JSON in parameters (cids or policy_ctx)'
      }, { status: 400 }))
    }

    const provenanceValue = typeof provenance_raw === 'string' ? parseInt(provenance_raw) : provenance_raw
    const batch = batch_raw
    const ir_digest = ir_digest_raw
    const nonce = nonce_raw

    if (!Array.isArray(parsedCids) || parsedCids.length === 0) {
      return setCors(NextResponse.json({ message: 'cids must be non-empty array' }, { status: 400 }))
    }
    if (parsedCids.length > MAX_CIDS) {
      return setCors(NextResponse.json({ message: `Too many CIDs (max ${MAX_CIDS})` }, { status: 400 }))
    }

    // STRICT VALIDATION: Only accept CONFIRMED CIDs
    const policy_hash = calcPolicyHash(parsedPolicyCtx)
    
    // First check: CIDs must exist and be confirmed
    const validation = cidValidator.validate_cids(parsedCids, {
      require_confirmed: true,    // Must be confirmed on-chain
      allow_pending: false,        // No pending allowed
      check_expiry: true,
      check_owner: false,
    })

    if (!validation.all_valid) {
      log.error('CID validation failed', { 
        invalid_count: validation.invalid_count 
      })
      return setCors(NextResponse.json({
        message: 'CID validation failed: All CIDs must be confirmed on-chain',
        validation: {
          all_valid: false,
          invalid_count: validation.invalid_count,
          invalid_cids: validation.invalid_cids,
          details: validation.results.filter(r => !r.valid).map(r => ({
            cid: r.cid_pda,
            reason: r.reason,
            status: r.status,
          })),
        },
        hint: 'Wait for CIDRegistered events before submitting jobs. Check pending CIDs with GET /api/actions/job/registerCIDs'
      }, { status: 400 }))
    }

    // Second check: Policy compatibility
    const jobValidation = cidValidator.validate_for_job_submission(parsedCids, policy_hash)
    if (!jobValidation.policy_compatible) {
      log.error('Policy incompatibility detected')
      return setCors(NextResponse.json({
        message: 'CIDs have incompatible policies (different policy_hash values)',
      }, { status: 400 }))
    }

    log.info('All CIDs confirmed and valid', { cids: parsedCids.length })

    // Initialize PublicKeys
    const fhe = getFHEcpkInfo()
    const domain_hash = calcDomainHash({
      chain_id: fhe.domain.chain_id,
      gatekeeper_program: fhe.domain.gatekeeper_program,
      cpk_id: fhe.cpk_id,
      key_epoch: fhe.domain.key_epoch,
    })
    const gatekeeperProgram = new PublicKey(fhe.domain.gatekeeper_program)
    const submitter = new PublicKey(account)
    const batchPubkey = new PublicKey(batch)
    const cidHandles = parsedCids.map(cid => new PublicKey(cid))

    // Calculate hashes
    const cid_set_id = calcCidSetId(parsedCids)
    const nonce_hex = nonce && isValidHex32(nonce) 
      ? nonce 
      : generateNonce()
    const commitment = calcCommitment(cid_set_id, ir_digest, policy_hash, domain_hash, nonce_hex)

    // Derive PDAs
    const configPda = deriveConfigPda(gatekeeperProgram)
    const jobPda = deriveJobPda(gatekeeperProgram, commitment, submitter)

    // Build submit_job instruction
    const submitIx = buildSubmitJobInstruction({
      gatekeeperProgram,
      submitter,
      batch: batchPubkey,
      cidSetIdHex: cid_set_id,
      commitmentHex: commitment,
      irDigestHex: ir_digest,
      policyHashHex: policy_hash,
      configPda,
      jobPda,
      cidHandles,
      provenance: provenanceValue,
    })

    // Optional: Add action identity memo for tracking
    const reference = generateNonce()
    const memoStr = `solana-action:gatekeeper-submit:${reference}`
    const memoIx = new TransactionInstruction({ 
      programId: MEMO_PROGRAM_ID, 
      keys: [], 
      data: Buffer.from(memoStr, 'utf8') 
    })

    // Build transaction with recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction()
    tx.feePayer = submitter
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight
    tx.add(submitIx, memoIx)

    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    log.info('Transaction built successfully', { 
      job_pda: jobPda.toBase58().slice(0, 8) + '...' 
    })

    return setCors(NextResponse.json({
      transaction: Buffer.from(serializedTx).toString('base64'),
      message: `Submit confidential job with ${parsedCids.length} confirmed CID reference(s)`,
      validation: {
        all_cids_confirmed: true,
        cids_checked: parsedCids.length,
        policy_compatible: true,
      },
      workflow: {
        current: 'Transaction created (NOT queued yet)',
        next_steps: [
          '1. Sign and send this transaction',
          '2. Wait for on-chain confirmation',
          '3. EventListener will catch JobSubmitted event',
          '4. Job will be enqueued for execution ONLY after on-chain confirmation'
        ]
      },
      verification: {
        algo: 'sha256',
        domain_hash,
        preimage: {
          cids: parsedCids,
          batch,
          ir_digest,
          policy_ctx: parsedPolicyCtx,
          provenance: provenanceValue,
          nonce: nonce_hex,
        },
        hashes: { cid_set_id, policy_hash, commitment },
        accountsOrder: ['config', 'job', 'batch', 'submitter', 'system_program', '...cid_handles'],
        argsOrder: ['batch', 'cid_set_id', 'commitment', 'ir_digest', 'policy_hash', 'provenance'],
        pda: { 
          config: configPda.toBase58(), 
          job: jobPda.toBase58() 
        },
        programId: gatekeeperProgram.toBase58(),
        remaining_accounts: cidHandles.map(c => c.toBase58()),
      },
    }))
  } catch (e: unknown) {
    log.error('Submit job error', e)
    return setCors(NextResponse.json({ 
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
