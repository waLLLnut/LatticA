// /app/api/actions/job/submit/route.ts
import { NextRequest, NextResponse } from 'next/server'
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js'
import crypto from 'crypto'

/* ============================== CORS ============================== */
function setCors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
  return res
}
export async function OPTIONS() { return setCors(new NextResponse(null, { status: 200 })) }

/* ========================== FHE-CPK BUNDLE ======================== */
// Demo bundle (production: on-chain/off-chain signature verification required)
function getFHEcpkInfo() {
  return {
    cpk_id: 'v1-2025',
    cpk_pub: 'base64_public_key_here',
    domain: {
      chain_id: 'mainnet-beta',
      gatekeeper_program: 'GateKeep3r11111111111111111111111111111111',
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

/* ============================ HASH UTILS ========================== */
// sha256(hex) helper (production: keccak256 etc. can be adopted)
function sha256Hex(buf: Buffer | string) {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf
  return '0x' + crypto.createHash('sha256').update(b).digest('hex')
}
const hex32 = (h0x: string) => {
  const h = h0x.startsWith('0x') ? h0x.slice(2) : h0x
  if (h.length !== 64) throw new Error('expected 32-byte hex')
  return Buffer.from(h, 'hex')
}
function canonicalJson(obj: unknown) {
  // Simple normalization: key sorting (JSON Canonicalization Scheme recommended)
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort())
}

/* ======================= COMMITMENT FORMULA ======================= */
/**
 * inputs_commit    = sha256( concat(CID_1 || CID_2 || ... || CID_n) )
 * enc_params_hash  = sha256( canonical_json(enc_params) )
 * policy_hash      = sha256( canonical_json(policy_ctx) )
 * domain_hash      = sha256( chain_id || gatekeeper_program || cpk_id || key_epoch )
 * commitment       = sha256( inputs_commit || ir_digest || enc_params_hash || policy_hash || domain_hash || nonce )
 *
 * All bytes are assumed to be unified as 32-byte hex (0x + 64) and then concatenated.
 */
function calcInputsCommit(inputs: Array<{ cid: string }>) {
  const concat = inputs.map(i => i.cid).join('')
  return sha256Hex(Buffer.from(concat, 'utf8'))
}
function calcEncParamsHash(encParams: unknown) {
  return sha256Hex(Buffer.from(canonicalJson(encParams), 'utf8'))
}
function calcPolicyHash(policyCtx: unknown) {
  return sha256Hex(Buffer.from(canonicalJson(policyCtx), 'utf8'))
}
function calcDomainHash(fhe: ReturnType<typeof getFHEcpkInfo>) {
  const parts = Buffer.concat([
    Buffer.from(fhe.domain.chain_id, 'utf8'),
    Buffer.from(fhe.domain.gatekeeper_program, 'utf8'),
    Buffer.from(fhe.cpk_id, 'utf8'),
    Buffer.from(String(fhe.domain.key_epoch), 'utf8'),
  ])
  return sha256Hex(parts)
}
function calcCommitment(
  inputsCommit: string,
  irDigest: string,
  encParamsHash: string,
  policyHash: string,
  domainHash: string,
  nonceHex32: string,
) {
  const concat = Buffer.concat([
    hex32(inputsCommit),
    hex32(irDigest),
    hex32(encParamsHash),
    hex32(policyHash),
    hex32(domainHash),
    hex32(nonceHex32),
  ])
  return sha256Hex(concat)
}

/* ========================== PDA & INSTRUCTION ===================== */
// Anchor global discriminator
const submitDiscriminator = crypto.createHash('sha256').update('global:submit_job').digest().subarray(0, 8)

function buildSubmitJobIx(args: {
  gatekeeperProgram: PublicKey
  submitter: PublicKey
  commitmentHex: string
  irDigestHex: string
  encParamsHashHex: string
  policyHashHex: string
  configPda: PublicKey
  jobPda: PublicKey
}) {
  const data = Buffer.concat([
    submitDiscriminator,
    hex32(args.commitmentHex),
    hex32(args.irDigestHex),
    hex32(args.encParamsHashHex),
    hex32(args.policyHashHex),
  ])
  const keys = [
    { pubkey: args.configPda, isSigner: false, isWritable: false },
    { pubkey: args.jobPda,     isSigner: false, isWritable: true  },
    { pubkey: args.submitter,  isSigner: true,  isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]
  return new TransactionInstruction({ programId: args.gatekeeperProgram, keys, data })
}
function deriveConfigPda(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], programId)[0]
}
function deriveJobPda(programId: PublicKey, commitmentHex: string, submitter: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('job'), hex32(commitmentHex), submitter.toBuffer()], programId)[0]
}

/* =============================== GET ============================== */
export async function GET(request: NextRequest) {
  const fhe = getFHEcpkInfo()
  const domain_hash = calcDomainHash(fhe)
  
  // Check for preview parameters
  const { searchParams } = new URL(request.url)
  const inputsParam = searchParams.get('inputs')
  const regIdParam = searchParams.get('reg_id')
  
  let preview = null
  if (inputsParam || regIdParam) {
    // Preview mode: validate inputs and show status
    try {
      const inputs = inputsParam ? JSON.parse(inputsParam) : []
      const cidsOk = Array.isArray(inputs) && inputs.every((i: unknown) => 
        typeof i === 'object' && i !== null && 'cid' in i && 
        typeof (i as { cid: unknown }).cid === 'string' && 
        (i as { cid: string }).cid.startsWith('Qm')
      )
      
      preview = {
        status: cidsOk ? 'ready' : 'invalid',
        inputs_count: inputs.length,
        message: cidsOk 
          ? 'CIDs are valid and ready for job submission'
          : 'Invalid CIDs format. Use /api/actions/job/registerCIDs first.'
      }
    } catch {
      preview = {
        status: 'error',
        message: 'Invalid inputs parameter format'
      }
    }
  }

  // Include policy/domain/hash specs in GET so users can pre-validate
  const body = {
    type: 'action',
    icon: 'http://localhost:3000/logo.png',
    title: 'Gatekeeper · Submit Confidential Job',
    description:
      'Submit a confidential computation job using registered CIDs. This endpoint returns a signable transaction (no partial signature).',
    label: 'Submit Confidential Job',
    disabled: false,

     // 👇 User verification info (policy/domain/hash specs)
    policy: {
      hashAlgorithm: 'sha256',
      inputRequirement: 'inputs = JSON array of {cid} from registered CIDs (use /registerCIDs first).',
      canonicalization: 'enc_params/policy_ctx are canonical-JSON stringified (sorted keys).',
      nonce: '32-byte hex (0x + 64). If omitted on POST, server generates and returns it.',
    },
    domain: {
      ...fhe,
      domain_hash, // sha256(chain_id || gatekeeper_program || cpk_id || key_epoch)
    },
    hashSpec: {
      inputs_commit: 'sha256(concat(CID_1 || ... || CID_n)) -> 32B hex',
      enc_params_hash: 'sha256(canonical_json(enc_params)) -> 32B hex',
      policy_hash: 'sha256(canonical_json(policy_ctx)) -> 32B hex',
      domain_hash: 'sha256(chain_id || gatekeeper_program || cpk_id || key_epoch) -> 32B hex',
      commitment:
        'sha256(inputs_commit || ir_digest || enc_params_hash || policy_hash || domain_hash || nonce) -> 32B hex',
      argOrder: ['commitment', 'ir_digest', 'enc_params_hash', 'policy_hash'],
      accountsOrder: ['config (PDA["config"])', 'job (PDA["job", commitment, submitter])', 'submitter', 'system'],
    },

    // Preview information if inputs provided
    ...(preview && { preview }),

     // Actions spec: user input guide
    links: {
      actions: [
        {
          type: 'post',
          href: '/api/actions/job/submit',
          label: 'Submit Job',
          parameters: [
            { name: 'inputs', label: 'Registered CIDs (JSON)', required: true, type: 'textarea' },
            { name: 'ir_digest', label: 'IR Digest (0x…64hex)', required: true, pattern: '^0x[0-9a-fA-F]{64}$' },
            { name: 'enc_params', label: 'Encryption Params (JSON)', required: true, type: 'textarea' },
            { name: 'policy_ctx', label: 'Policy Context (JSON)', required: true, type: 'textarea' },
            { name: 'nonce', label: 'Optional Nonce (0x…64hex)', required: false, pattern: '^0x[0-9a-fA-F]{64}$' },
          ],
        },
      ],
    },
  }
  return setCors(NextResponse.json(body))
}

/* =============================== POST ============================= */
export async function POST(req: NextRequest) {
  try {
    const { account, inputs, ir_digest, enc_params, policy_ctx, nonce } = await req.json()

    if (!account || !inputs || !ir_digest || !enc_params || !policy_ctx) {
      return setCors(NextResponse.json({ message: 'Missing fields' }, { status: 400 }))
    }

     // Parse & normalize
    const parsedInputs: Array<{ cid: string }> = typeof inputs === 'string' ? JSON.parse(inputs) : inputs
    const parsedEncParams = typeof enc_params === 'string' ? JSON.parse(enc_params) : enc_params
    const parsedPolicyCtx = typeof policy_ctx === 'string' ? JSON.parse(policy_ctx) : policy_ctx
    if (!Array.isArray(parsedInputs) || parsedInputs.length === 0) {
      return setCors(NextResponse.json({ message: 'inputs must be non-empty array' }, { status: 400 }))
    }
     // Offchain Store existence check (demo rule - only registered CIDs)
    const cidsOk = parsedInputs.every(i => typeof i.cid === 'string' && i.cid.startsWith('Qm'))
    if (!cidsOk) return setCors(NextResponse.json({ message: 'CID(s) not found or invalid. Use /api/actions/job/registerCIDs first to register external inputs.' }, { status: 400 }))

     // Domain
    const fhe = getFHEcpkInfo()
    const domain_hash = calcDomainHash(fhe)

     // Hash calculation
    const inputs_commit = calcInputsCommit(parsedInputs)
    const enc_params_hash = calcEncParamsHash(parsedEncParams)
    const policy_hash = calcPolicyHash(parsedPolicyCtx)
     // nonce: use user-provided or generate server-side
    const nonce_hex = nonce && /^0x[0-9a-fA-F]{64}$/.test(nonce) ? nonce : sha256Hex(crypto.randomBytes(32)).slice(0, 66)
     // Final commitment
    const commitment = calcCommitment(inputs_commit, ir_digest, enc_params_hash, policy_hash, domain_hash, nonce_hex)

    // PDA & ix
    const gatekeeperProgram = new PublicKey(fhe.domain.gatekeeper_program)
    const submitter = new PublicKey(account)
    const configPda = deriveConfigPda(gatekeeperProgram)
    const jobPda = deriveJobPda(gatekeeperProgram, commitment, submitter)

    const ix = buildSubmitJobIx({
      gatekeeperProgram,
      submitter,
      commitmentHex: commitment,
      irDigestHex: ir_digest,
      encParamsHashHex: enc_params_hash,
      policyHashHex: policy_hash,
      configPda,
      jobPda,
    })

     // Action Identity memo (for verification; optional)
    const memoProg = new PublicKey('MemoSq4gqABAXKb96qnH8TysKcWfC85B2q2')
    const identity = 'ActionIdentity11111111111111111111111111111111'
    const reference = crypto.randomBytes(32).toString('base64url')
    const memoStr = `solana-action:${identity}:${reference}:<signature>`
    const memoIx = new TransactionInstruction({ programId: memoProg, keys: [], data: Buffer.from(memoStr, 'utf8') })

     // Transaction (feePayer/recentBlockhash set by wallet — Actions spec)
    const tx = new Transaction().add(ix, memoIx)
    tx.feePayer = submitter
    const base64Tx = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64')

     // Include all preimages/hashes for user verification
    return setCors(
      NextResponse.json({
        transaction: base64Tx,
        message: 'Submit confidential compute',
        verification: {
          algo: 'sha256',
          domain_hash,
          preimage: {
            inputs: parsedInputs,        // [{cid}]
            ir_digest,
            enc_params: parsedEncParams, // canonical-JSON 기준
            policy_ctx: parsedPolicyCtx, // canonical-JSON 기준
            nonce: nonce_hex,
          },
          hashes: {
            inputs_commit,
            enc_params_hash,
            policy_hash,
            commitment,
          },
           // Account/argument order specified (client can re-verify serialization)
          accountsOrder: ['config', 'job', 'submitter', 'system_program'],
          argsOrder: ['commitment', 'ir_digest', 'enc_params_hash', 'policy_hash'],
          pda: { config: configPda.toBase58(), job: jobPda.toBase58() },
          programId: gatekeeperProgram.toBase58(),
        },
      })
    )
  } catch (e: unknown) {
    console.error(e)
    return setCors(NextResponse.json({ message: 'Internal server error' }, { status: 500 }))
  }
}
