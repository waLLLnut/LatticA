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
  isValidHex32,
  canonicalJson,         // for stable policy_ctx stringification (display/debug)
} from '@/lib/crypto-utils'
import { getInstructionDiscriminator } from '@/lib/anchor-utils'
import type { PolicyContext } from '@/types/ciphertext'

const log = createLogger('API:SubmitJob')
const connection = new Connection('https://api.devnet.solana.com', 'confirmed')
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
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

// Demo FHE-CPK config (same as registerCIDs)
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

// Instruction discriminator (from IDL)
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
    ...args.cidHandles.map((cid) => ({
      pubkey: cid,
      isSigner: false,
      isWritable: false,
    })),
  ]

  return new TransactionInstruction({
    programId: args.gatekeeperProgram,
    keys,
    data,
  })
}

function deriveConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0]
}
function deriveJobPda(programId: PublicKey, commitmentHex: string, submitter: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('job'), hex32(commitmentHex), submitter.toBuffer()], programId)[0]
}

/* =============================== GET ============================= */
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

  let preview: any = null
  if (cidsParam) {
    try {
      // Accept array or nested {cids:[...]}
      let parsed = JSON.parse(cidsParam)
      if (!Array.isArray(parsed) && parsed && Array.isArray(parsed.cids)) parsed = parsed.cids
      const cid_count = Array.isArray(parsed) ? parsed.length : 0
      preview = {
        status: cid_count > 0 && cid_count <= MAX_CIDS ? 'ready' : 'invalid',
        cid_count,
        message:
          cid_count > 0 && cid_count <= MAX_CIDS
            ? `Ready to submit job with ${cid_count} CID reference(s)`
            : cid_count > MAX_CIDS
            ? `Too many CIDs (max ${MAX_CIDS})`
            : 'No CIDs provided. Use /api/actions/job/registerCIDs first.',
      }
    } catch {
      preview = { status: 'error', message: 'Invalid cids parameter format (use JSON array)' }
    }
  }

  const baseURL = new URL(request.url).origin
  const body = {
    type: 'action',
    icon: new URL('/logo.png', baseURL).toString(),
    title: 'Gatekeeper · Submit Confidential Job',
    description: 'Submit a confidential computation job using registered CIDs.',
    label: 'Submit Confidential Job',
    disabled: false,
    domain: { ...fhe, domain_hash },
    policy: {
      inputRequirement: `cids = JSON array of CID PDA addresses from /registerCIDs (max ${MAX_CIDS}).`,
      canonicalization: 'policy_ctx is canonical-JSON stringified (sorted keys).',
      nonce: '32-byte hex (0x + 64). If omitted, server generates.',
      remaining_accounts: 'CID handles are passed as remaining_accounts in transaction',
    },
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
      actions: [
        {
          href: `${baseURL}/api/actions/job/submit?cids={cids}&batch={batch}&ir_digest={ir_digest}&policy_type={policy_type}&provenance={provenance}&nonce={nonce}`,
          label: 'Submit Job',
          parameters: [
            { name: 'cids', label: 'Registered CID PDAs (JSON array)', required: true },
            { name: 'batch', label: 'Batch Window Pubkey', required: true },
            { name: 'ir_digest', label: 'IR Digest (0x…64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
            {
              name: 'policy_type',
              label: 'Policy Type',
              type: 'select',
              required: false,
              options: [
                { label: 'Compute Only', value: 'compute', selected: true },
                { label: 'Compute & Store', value: 'compute-store' },
                { label: 'Full Access', value: 'full' },
              ],
            },
            { name: 'provenance', label: 'Provenance (server|client|oracle|dapp|0|1|2|3)', required: false },
            { name: 'nonce', label: 'Optional Nonce (0x…64hex)', required: false, pattern: '^0x[0-9a-fA-F]{64}$' },
          ],
        },
      ],
    },
  }
  return cors(NextResponse.json(body))
}

/* =============================== POST ============================= */
export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json().catch(() => ({} as any))
    const url = new URL(req.url)

    // Dial.to sends {account, data:{...}} ; Blinks Inspector can use query params
    const bodyData = (rawBody && (rawBody.data || rawBody)) || {}
    const account = rawBody?.account

    // Prefer simple params; fall back to legacy
    const cids_raw = url.searchParams.get('cids') ?? bodyData.cids
    const batch_raw = url.searchParams.get('batch') ?? bodyData.batch
    const ir_digest_raw = url.searchParams.get('ir_digest') ?? bodyData.ir_digest
    const policy_type_raw = url.searchParams.get('policy_type') ?? bodyData.policy_type
    const policy_ctx_raw = url.searchParams.get('policy_ctx') ?? bodyData.policy_ctx
    const provenance_raw = url.searchParams.get('provenance') ?? bodyData.provenance ?? 'client'
    const nonce_raw = url.searchParams.get('nonce') ?? bodyData.nonce

    if (!account || !cids_raw || !batch_raw || !ir_digest_raw) {
      return cors(
        NextResponse.json(
          { message: 'Missing required fields: account, cids, batch, ir_digest' },
          { status: 400 },
        ),
      )
    }

    // Parse CIDs: support array or nested {cids:[...]} or stringified JSON
    let parsedCids: string[]
    try {
      if (typeof cids_raw === 'string') {
        const tmp = JSON.parse(cids_raw)
        parsedCids = Array.isArray(tmp) ? tmp : Array.isArray(tmp?.cids) ? tmp.cids : []
      } else if (Array.isArray(cids_raw)) {
        parsedCids = cids_raw
      } else if (cids_raw && Array.isArray(cids_raw.cids)) {
        parsedCids = cids_raw.cids
      } else {
        parsedCids = []
      }
    } catch {
      return cors(NextResponse.json({ message: 'Invalid JSON in cids (use JSON array)' }, { status: 400 }))
    }

    if (!Array.isArray(parsedCids) || parsedCids.length === 0) {
      return cors(NextResponse.json({ message: 'cids must be non-empty array' }, { status: 400 }))
    }
    if (parsedCids.length > MAX_CIDS) {
      return cors(NextResponse.json({ message: `Too many CIDs (max ${MAX_CIDS})` }, { status: 400 }))
    }

    // Validate base58 Pubkeys
    const invalidCids: string[] = []
    const cidHandles = parsedCids.map((c) => {
      try {
        return new PublicKey(c)
      } catch {
        invalidCids.push(String(c))
        return null as any
      }
    })
    if (invalidCids.length > 0) {
      return cors(
        NextResponse.json(
          { message: 'Invalid CID public keys', invalid_cids: invalidCids },
          { status: 400 },
        ),
      )
    }

    // Validate batch & ir_digest
    let batchPubkey: PublicKey
    try {
      batchPubkey = new PublicKey(batch_raw)
    } catch {
      return cors(NextResponse.json({ message: 'Invalid batch public key' }, { status: 400 }))
    }
    const ir_digest = String(ir_digest_raw)
    if (!/^0x[0-9a-fA-F]{64}$/.test(ir_digest)) {
      return cors(NextResponse.json({ message: 'ir_digest must be 0x + 64 hex chars' }, { status: 400 }))
    }

    // Build policy_ctx:
    // - If policy_type provided: map → policy_ctx
    // - Else: require policy_ctx JSON
    let policy_ctx: PolicyContext
    if (policy_type_raw) {
      const policyMap: Record<string, string[]> = {
        'compute': ['compute'],
        'compute-store': ['compute', 'store'],
        'full': ['compute', 'store', 'transfer'],
      }
      const allow = policyMap[String(policy_type_raw)] || ['compute']
      policy_ctx = { allow, version: '1.0' }
    } else {
      try {
        policy_ctx =
          typeof policy_ctx_raw === 'string' ? JSON.parse(policy_ctx_raw) : (policy_ctx_raw as PolicyContext)
      } catch {
        return cors(NextResponse.json({ message: 'Invalid JSON in policy_ctx' }, { status: 400 }))
      }
      if (!policy_ctx || !Array.isArray((policy_ctx as any).allow)) {
        return cors(NextResponse.json({ message: 'policy_ctx.allow is required' }, { status: 400 }))
      }
    }

    // Provenance normalization → small enum number (demo: server=0, client=1, oracle=2, dapp=3)
    let provenanceValue: number
    const provStr = String(provenance_raw).toLowerCase()
    if (/^[0-3]$/.test(provStr)) {
      provenanceValue = parseInt(provStr, 10)
    } else {
      const map: Record<string, number> = { server: 0, client: 1, oracle: 2, dapp: 3 }
      provenanceValue = map[provStr] ?? 1
    }

    // Build submitter pubkey
    let submitter: PublicKey
    try {
      submitter = new PublicKey(account)
    } catch {
      return cors(NextResponse.json({ message: 'Invalid account public key' }, { status: 400 }))
    }

    // FHE / domain
    const fhe = getFHEcpkInfo()
    const domain_hash = calcDomainHash({
      chain_id: fhe.domain.chain_id,
      gatekeeper_program: fhe.domain.gatekeeper_program,
      cpk_id: fhe.cpk_id,
      key_epoch: fhe.domain.key_epoch,
    })
    const gatekeeperProgram = new PublicKey(fhe.domain.gatekeeper_program)

    // Policy hash & validation
    const policy_hash = calcPolicyHash(policy_ctx)

    // CID validation: must be confirmed on-chain
    const validation = cidValidator.validate_cids(parsedCids, {
      require_confirmed: true,
      allow_pending: false,
      check_expiry: true,
      check_owner: false,
    })
    if (!validation.all_valid) {
      log.error('CID validation failed', { invalid_count: validation.invalid_count })
      return cors(
        NextResponse.json(
          {
            message: 'CID validation failed: All CIDs must be confirmed on-chain',
            validation: {
              all_valid: false,
              invalid_count: validation.invalid_count,
              invalid_cids: validation.invalid_cids,
              details: validation.results
                .filter((r: any) => !r.valid)
                .map((r: any) => ({ cid: r.cid_pda, reason: r.reason, status: r.status })),
            },
            hint:
              'Wait for CIDRegistered events before submitting jobs. Check pending CIDs with GET /api/actions/job/registerCIDs',
          },
          { status: 400 },
        ),
      )
    }

    // All CIDs must share same policy_hash
    const jobValidation = cidValidator.validate_for_job_submission(parsedCids, policy_hash)
    if (!jobValidation.policy_compatible) {
      return cors(NextResponse.json({ message: 'CIDs have incompatible policies (different policy_hash values)' }, { status: 400 }))
    }

    // Hashes
    const cid_set_id = calcCidSetId(parsedCids)
    const nonce_hex = nonce_raw && isValidHex32(nonce_raw) ? String(nonce_raw) : generateNonce()
    const commitment = calcCommitment(cid_set_id, ir_digest, policy_hash, domain_hash, nonce_hex)

    // PDAs
    const configPda = deriveConfigPda(gatekeeperProgram)
    const jobPda = deriveJobPda(gatekeeperProgram, commitment, submitter)

    // Instruction
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

    // Optional memo for traceability
    const reference = generateNonce()
    const memoIx = new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(`solana-action:gatekeeper-submit:${reference}`, 'utf8'),
    })

    // Build tx
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction()
    tx.feePayer = submitter
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight
    tx.add(submitIx, memoIx)

    // (Best-effort) simulate to surface errors early
    try {
      const sim = await connection.simulateTransaction(tx)
      if (sim.value.err) {
        log.error('Simulation failed', { err: sim.value.err, logs: sim.value.logs })
        return cors(
          NextResponse.json(
            {
              message: 'Transaction simulation failed. This transaction will likely fail on-chain.',
              error: sim.value.err,
              logs: sim.value.logs,
              hint:
                'Common causes: Program not initialized (missing config PDA), insufficient SOL balance, or invalid accounts/args.',
              troubleshooting: {
                submitter: submitter.toBase58(),
                program: gatekeeperProgram.toBase58(),
                job_pda: jobPda.toBase58(),
                cid_handles: cidHandles.map((c) => c.toBase58()),
              },
            },
            { status: 400 },
          ),
        )
      }
    } catch (e) {
      // Non-fatal: some valid txs may fail simulation in certain environments
      log.warn('Simulation attempt failed (continuing)', e)
    }

    // Serialize (unsigned)
    const serializedTx = tx.serialize({ requireAllSignatures: false, verifySignatures: false })

    log.info('Submit job transaction built', { job_pda: jobPda.toBase58().slice(0, 8) + '...' })

    // Minimal Actions response (best Dial.to compatibility)
    return cors(
      NextResponse.json({
        transaction: Buffer.from(serializedTx).toString('base64'),
        message: `Submit confidential job with ${parsedCids.length} confirmed CID reference(s)`,
        // Optional extras for client-side verification/debug
        verification: {
          algo: 'sha256',
          domain_hash,
          preimage: {
            cids: parsedCids,
            batch: batchPubkey.toBase58(),
            ir_digest,
            policy_ctx: JSON.parse(canonicalJson(policy_ctx)),
            provenance: provenanceValue,
            nonce: nonce_hex,
          },
          hashes: { cid_set_id, policy_hash, commitment },
          pda: { config: configPda.toBase58(), job: jobPda.toBase58() },
          programId: gatekeeperProgram.toBase58(),
          remaining_accounts: cidHandles.map((c) => c.toBase58()),
          argOrder: ['batch', 'cid_set_id', 'commitment', 'ir_digest', 'policy_hash', 'provenance'],
          accountsOrder: ['config', 'job', 'batch', 'submitter', 'system_program', '...cid_handles'],
        },
        workflow: {
          current: 'Transaction created (NOT queued yet)',
          next_steps: [
            '1. Sign and send this transaction',
            '2. Wait for on-chain confirmation',
            '3. EventListener will detect JobSubmitted',
            '4. Job will be enqueued after confirmation',
          ],
        },
      }),
    )
  } catch (e: unknown) {
    log.error('Submit job error', e)
    return cors(
      NextResponse.json(
        {
          message: e instanceof Error ? e.message : 'Internal server error',
          details: e instanceof Error ? e.stack : String(e),
        },
        { status: 500 },
      ),
    )
  }
}
