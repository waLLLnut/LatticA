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
import { ciphertextStore } from '@/services/storage/ciphertext-store'
import {
  hex32,
  calcCidSetId,
  calcPolicyHash,
  calcDomainHash,
  calcCommitment,
  canonicalJson,         // for stable policy_ctx stringification (display/debug)
} from '@/lib/crypto-utils'
import { getInstructionDiscriminator } from '@/lib/anchor-utils'
import type { PolicyContext } from '@/types/ciphertext'

const log = createLogger('API:SubmitJob')
const connection = new Connection('https://api.devnet.solana.com', 'confirmed')
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const MAX_CIDS = 16

// Demo: Fixed batch window for simplified workflow
const DEMO_BATCH_WINDOW = new PublicKey('11111111111111111111111111111111')

const UNIVERSAL_IR_REGISTRY: Record<string, { name: string; description: string; input_slots: number }> = {
  '0xadd0000000000000000000000000000000000000000000000000000000000000': {
    name: 'binary_add',
    description: 'Basic addition: output = input[0] + input[1]',
    input_slots: 2
  },
  '0xwithdrw000000000000000000000000000000000000000000000000000000000': {
    name: 'withdraw_with_check',
    description: 'Withdraw: Check balance >= amount, then subtract',
    input_slots: 2
  },
  '0xmul0000000000000000000000000000000000000000000000000000000000000': {
    name: 'complex_borrow_check',
    description: 'Multi-step: collateral check with balance update',
    input_slots: 3
  },
  '0xhealthcheck00000000000000000000000000000000000000000000000000000': {
    name: 'liquidation_health_check',
    description: 'Health factor: (collateral * price) vs (debt * threshold)',
    input_slots: 3
  }
}

const LEGACY_OPERATION_MAP: Record<string, string> = {
  'deposit': '0xadd0000000000000000000000000000000000000000000000000000000000000',
  'withdraw': '0xwithdrw000000000000000000000000000000000000000000000000000000000',
  'borrow': '0xmul0000000000000000000000000000000000000000000000000000000000000',
  'liquidation': '0xhealthcheck00000000000000000000000000000000000000000000000000000'
}

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
      fhe_scheme: 'FHE16_0.0.1v',
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
  const operationParam = searchParams.get('operation') || 'deposit'

  let preview: any = null
  if (cidsParam) {
    try {
      // Accept array or nested {cids:[...]}
      let parsed = JSON.parse(cidsParam)
      if (!Array.isArray(parsed) && parsed && Array.isArray(parsed.cids)) parsed = parsed.cids
      const cid_count = Array.isArray(parsed) ? parsed.length : 0

      // Get IR digest and check requirements
      const irDigest = LEGACY_OPERATION_MAP[operationParam] || operationParam
      const irDef = UNIVERSAL_IR_REGISTRY[irDigest]
      const requirement = irDef ? 
        { min: irDef.input_slots, max: irDef.input_slots, description: `${irDef.input_slots} CIDs: ${irDef.description}` } :
        { min: 1, max: MAX_CIDS, description: `1-${MAX_CIDS} CIDs for custom operation` }
      const isValidCount = cid_count >= requirement.min && cid_count <= requirement.max

      preview = {
        operation: operationParam,
        status: isValidCount ? 'ready' : 'invalid',
        cid_count,
        required: requirement.description,
        message: isValidCount
          ? `Ready to submit ${operationParam} job with ${cid_count} CID(s)`
          : cid_count === 0
          ? 'No CIDs provided. Use /api/actions/job/registerCIDs first.'
          : `Invalid CID count for ${operationParam}: expected ${requirement.min}${requirement.min !== requirement.max ? `-${requirement.max}` : ''}, got ${cid_count}`,
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
      inputRequirement: 'cids = JSON array of CID PDA addresses from /registerCIDs',
      supportedOperations: Object.entries(UNIVERSAL_IR_REGISTRY).map(([digest, def]) => ({
        ir_digest: digest,
        name: def.name,
        description: def.description,
        input_slots: def.input_slots
      })),
      decryption: 'Owner-Controlled (private) or Protocol-Managed (shared access)',
      canonicalization: 'policy_ctx is canonical-JSON stringified (sorted keys).',
      remaining_accounts: 'CID handles are passed as remaining_accounts in transaction',
      batch_window: 'Fixed to demo batch window (simplified for demo)',
    },
    hashSpec: {
      cid_set_id: 'sha256(concat(cid_handle_1 || cid_handle_2 || ... )) -> 32B hex',
      policy_hash: 'sha256(canonical_json(policy_ctx)) -> 32B hex',
      domain_hash: 'sha256(chain_id || program || cpk_id || epoch) -> 32B hex',
      commitment: 'sha256(cid_set_id || ir_digest || policy_hash || domain_hash) -> 32B hex',
      argOrder: ['batch', 'cid_set_id', 'commitment', 'ir_digest', 'policy_hash', 'provenance'],
      accountsOrder: ['config', 'job', 'batch', 'submitter', 'system_program', '...cid_handles (remaining)'],
    },
    ...(preview && { preview }),
    links: {
      actions: [
        {
          href: `${baseURL}/api/actions/job/submit?cids={cids}&operation={operation}&policy_type={policy_type}&provenance={provenance}`,
          label: 'Submit Job',
          parameters: [
            { name: 'cids', label: 'Registered CID PDAs (JSON array or comma-separated)', required: true },
            {
              name: 'operation',
              label: 'FHE Operation',
              type: 'select',
              required: true,
              options: [
                { label: 'Deposit (2 CIDs: SOL_balance + deposit_amount)', value: 'deposit', selected: true },
                { label: 'Withdraw (2 CIDs: USDC_balance + withdraw_amount)', value: 'withdraw' },
                { label: 'Borrow (3 CIDs: SOL_balance + borrow_amount + USDC_balance)', value: 'borrow' },
                { label: 'Liquidation (3 CIDs: Health Check)', value: 'liquidation' },
                { label: 'Custom (1-16 CIDs)', value: 'custom' },
              ],
            },
            {
              name: 'policy_type',
              label: 'Decryption Policy',
              type: 'select',
              required: false,
              options: [
                { label: 'Owner-Controlled (Private)', value: 'owner-controlled', selected: true },
                { label: 'Protocol-Managed (Shared)', value: 'protocol-managed' },
              ],
            },
            {
              name: 'provenance',
              label: 'Call Type',
              type: 'select',
              required: false,
              options: [
                { label: 'Direct Owner Call', value: '1', selected: true },
                { label: 'CPI Call', value: '0' },
              ],
            },
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

    // Simplified parameters (registerCIDs style)
    const cids_raw = url.searchParams.get('cids') ?? bodyData.cids
    const operation = url.searchParams.get('operation') ?? bodyData.operation ?? 'deposit'
    const policy_type_raw = url.searchParams.get('policy_type') ?? bodyData.policy_type ?? 'owner-controlled'
    const policy_ctx_raw = url.searchParams.get('policy_ctx') ?? bodyData.policy_ctx
    const provenance_raw = url.searchParams.get('provenance') ?? bodyData.provenance ?? '1'

    // Backward compatibility: support old parameter names
    const batch_raw = url.searchParams.get('batch') ?? bodyData.batch
    const ir_digest_raw = url.searchParams.get('ir_digest') ?? bodyData.ir_digest

    if (!account || !cids_raw) {
      return cors(
        NextResponse.json(
          { message: 'Missing required fields: account, cids' },
          { status: 400 },
        ),
      )
    }

    // Parse CIDs: support multiple formats for flexibility
    let parsedCids: string[]
    try {
      if (typeof cids_raw === 'string') {
        // Try JSON parse first
        try {
          const tmp = JSON.parse(cids_raw)
          parsedCids = Array.isArray(tmp) ? tmp : Array.isArray(tmp?.cids) ? tmp.cids : []
        } catch {
          // Fallback: comma-separated, space-separated, or single value
          // Remove brackets if present: [addr1,addr2] → addr1,addr2
          const cleaned = cids_raw.replace(/^\[|\]$/g, '').trim()
          if (cleaned.includes(',')) {
            parsedCids = cleaned.split(',').map(s => s.trim()).filter(s => s.length > 0)
          } else if (cleaned.includes(' ')) {
            parsedCids = cleaned.split(/\s+/).filter(s => s.length > 0)
          } else if (cleaned.length > 0) {
            parsedCids = [cleaned]
          } else {
            parsedCids = []
          }
        }
      } else if (Array.isArray(cids_raw)) {
        parsedCids = cids_raw
      } else if (cids_raw && Array.isArray(cids_raw.cids)) {
        parsedCids = cids_raw.cids
      } else {
        parsedCids = []
      }
    } catch (e) {
      log.error('CID parsing error', e)
      return cors(NextResponse.json({
        message: 'Invalid cids format. Use JSON array ["addr1","addr2"] or comma-separated addr1,addr2',
        examples: [
          'JSON: ["GDyT4XD7CTLVdYyVAbr6JT4L1J28WDJquReFiK1v9ims"]',
          'Comma: GDyT4XD7CTLVdYyVAbr6JT4L1J28WDJquReFiK1v9ims,AnotherAddress...',
          'Brackets: [GDyT4XD7CTLVdYyVAbr6JT4L1J28WDJquReFiK1v9ims]'
        ]
      }, { status: 400 }))
    }

    if (!Array.isArray(parsedCids) || parsedCids.length === 0) {
      return cors(NextResponse.json({ message: 'cids must be non-empty array' }, { status: 400 }))
    }
    if (parsedCids.length > MAX_CIDS) {
      return cors(NextResponse.json({ message: `Too many CIDs (max ${MAX_CIDS})` }, { status: 400 }))
    }

    // Log parsed CIDs for debugging
    log.info('Parsed CIDs', {
      raw_input: cids_raw,
      parsed: parsedCids,
      count: parsedCids.length,
      operation
    })

    // Validate CID count based on IR digest/operation type
    const irDigest = LEGACY_OPERATION_MAP[operation] || operation
    const irDef = UNIVERSAL_IR_REGISTRY[irDigest]
    const cidRequirement = irDef ? 
      { min: irDef.input_slots, max: irDef.input_slots, description: `${irDef.input_slots} CIDs: ${irDef.description}` } :
      { min: 1, max: MAX_CIDS, description: `1-${MAX_CIDS} CIDs for custom operation` }
    if (parsedCids.length < cidRequirement.min || parsedCids.length > cidRequirement.max) {
      return cors(NextResponse.json({
        message: `Invalid CID count for operation '${operation}'`,
        required: cidRequirement.description,
        provided: parsedCids.length,
        hint: cidRequirement.min === cidRequirement.max
          ? `This operation requires exactly ${cidRequirement.min} CID(s)`
          : `This operation requires ${cidRequirement.min}-${cidRequirement.max} CID(s)`
      }, { status: 400 }))
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

    // Batch window: Use fixed demo batch or backward compatibility
    const batchPubkey = batch_raw ? new PublicKey(batch_raw) : DEMO_BATCH_WINDOW

    // IR Digest: Support both legacy operations and direct IR digests
    let ir_digest: string
    if (ir_digest_raw) {
      // Direct IR digest provided
      ir_digest = String(ir_digest_raw)
      if (!/^0x[0-9a-fA-F]{64}$/.test(ir_digest)) {
        return cors(NextResponse.json({ message: 'ir_digest must be 0x + 64 hex chars' }, { status: 400 }))
      }
    } else if (LEGACY_OPERATION_MAP[operation]) {
      // Legacy operation mapping
      ir_digest = LEGACY_OPERATION_MAP[operation]
      log.debug('Using legacy operation mapping', { operation, ir_digest })
    } else {
      // Assume operation is an IR digest
      ir_digest = operation
      if (!/^0x[0-9a-fA-F]{64}$/.test(ir_digest)) {
        return cors(NextResponse.json({ 
          message: 'Invalid operation or IR digest',
          supported_operations: Object.keys(LEGACY_OPERATION_MAP),
          note: 'For custom operations, provide a valid 64-char hex IR digest'
        }, { status: 400 }))
      }
    }

    // Build policy_ctx:
    // - If policy_type provided: map → policy_ctx with decryption permissions
    // - Else: require policy_ctx JSON
    let policy_ctx: PolicyContext
    if (policy_type_raw) {
      const policyMap: Record<string, { allow: string[]; decrypt_by: string }> = {
        'owner-controlled': { allow: ['compute'], decrypt_by: 'owner' },  // Private: owner only
        'protocol-managed': { allow: ['compute', 'store'], decrypt_by: 'protocol' }, // Shared: protocol access
        // Backward compatibility
        'compute': { allow: ['compute'], decrypt_by: 'owner' },
        'compute-decrypt-owner': { allow: ['compute'], decrypt_by: 'owner' },
        'compute-store': { allow: ['compute', 'store'], decrypt_by: 'protocol' },
        'full': { allow: ['compute', 'store', 'transfer'], decrypt_by: 'protocol' },
      }
      const policyConfig = policyMap[String(policy_type_raw)] || policyMap['owner-controlled']
      policy_ctx = {
        allow: policyConfig.allow,
        version: '1.0',
        decrypt_by: policyConfig.decrypt_by
      }
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

    // Provenance: Simplified to u8 (0=CPI call, 1=direct owner call)
    let provenanceValue: number
    const provStr = String(provenance_raw)
    if (/^[0-1]$/.test(provStr)) {
      provenanceValue = parseInt(provStr, 10)
    } else {
      return cors(NextResponse.json({
        message: 'Invalid provenance value',
        valid_values: ['0 (CPI call)', '1 (direct owner call)']
      }, { status: 400 }))
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

    // CID validation: all CIDs must be confirmed on-chain or in pending store
    // State CIDs may have provenance='executor' if updated by executor, but they're still registered CIDs
    const validation = cidValidator.validate_cids(parsedCids, {
      require_confirmed: true,
      allow_pending: false,
      check_expiry: true,
      check_owner: false,
    })
    
    if (!validation.all_valid) {
      const failedDetails = validation.results
        .filter((r: any) => !r.valid)
        .map((r: any) => ({ cid: r.cid_pda, reason: r.reason, status: r.status }))

      log.error('CID validation failed', {
        invalid_count: validation.invalid_count,
        parsed_cids: parsedCids,
        failed_details: failedDetails,
        all_results: validation.results
      })

      return cors(
        NextResponse.json(
          {
            message: 'CID validation failed: All CIDs must be confirmed on-chain',
            provided_cids: parsedCids,
            validation: {
              all_valid: false,
              invalid_count: validation.invalid_count,
              invalid_cids: validation.invalid_cids,
              details: failedDetails,
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
      log.error('Policy hash mismatch', {
        expected_policy_hash: policy_hash,
        policy_ctx,
        policy_type: policy_type_raw,
        cid_policy_hashes: validation.results.map((r: any) => ({
          cid: r.cid_pda,
          policy_hash: r.policy_hash
        }))
      })

      return cors(NextResponse.json({
        message: 'CIDs have incompatible policies (different policy_hash values)',
        expected_policy: {
          policy_type: policy_type_raw,
          policy_ctx,
          policy_hash
        },
        cid_policies: validation.results.map((r: any) => ({
          cid: r.cid_pda,
          policy_hash: r.policy_hash,
          matches: r.policy_hash === policy_hash
        })),
        hint: 'CIDs must be registered with the same policy as the job submission. Check the policy_type used during CID registration.'
      }, { status: 400 }))
    }

    // Hashes (nonce removed for simplified demo)
    const cid_set_id = calcCidSetId(parsedCids)
    const commitment = calcCommitment(cid_set_id, ir_digest, policy_hash, domain_hash)

    log.info('Job submission', {
      operation,
      ir_digest: ir_digest.slice(0, 10) + '...',
      commitment: commitment.slice(0, 10) + '...',
      cid_count: parsedCids.length
    })

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
    const reference = Date.now().toString(36)
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
      log.warn('Simulation attempt failed (continuing)', { error: e instanceof Error ? e.message : String(e) })
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
            operation,
            ir_digest,
            policy_ctx: JSON.parse(canonicalJson(policy_ctx)),
            provenance: provenanceValue,
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
