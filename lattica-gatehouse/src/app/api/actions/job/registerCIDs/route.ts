// /app/api/actions/job/registerCIDs/route.ts
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

/* ===== CORS ===== */
function cors(res: NextResponse) {
  res.headers.set('Access-Control-Allow-Origin', '*')
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
  return res
}
export async function OPTIONS() { return cors(new NextResponse(null, { status: 200 })) }

/* ===== Domain/CPK bundle (reuse from submit) ===== */
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

function canonicalJson(o: unknown) {
  return JSON.stringify(o, Object.keys(o as Record<string, unknown>).sort())
}

function sha256Hex(b: Buffer | string) {
  const buf = typeof b === 'string' ? Buffer.from(b) : b
  return '0x' + crypto.createHash('sha256').update(buf).digest('hex')
}

/* ===== GET: Action metadata ===== */
export async function GET() {
  const fhe = getFHEcpkInfo()
  
  // Extract key FHE CPK info for client-side encryption
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
  
  const body = {
    type: 'action',
    icon: 'http://localhost:3000/logo.png',
    title: 'Gatekeeper · Register CIDs (fromExternal → in)',
    description: 'Register client-encrypted ciphertexts and store them as CIDs.',
    label: 'Register CIDs',
    fhe_cpk, // FHE CPK info for client-side encryption
    links: {
      actions: [
        {
          type: 'post',
          href: '/api/actions/job/registerCIDs',
          label: 'Register CIDs',
          parameters: [
            { name: 'ciphertexts', label: 'Ciphertexts (JSON)', required: true, type: 'textarea' },
            { name: 'enc_params', label: 'Encryption Params (JSON)', required: true, type: 'textarea' },
            { name: 'policy_ctx', label: 'Policy Context (JSON)', required: true, type: 'textarea' },
            { name: 'provenance', label: 'Provenance', required: false, type: 'text' },
          ]
        }
      ]
    },
    // Optional: policy notes for UX
    notes: {
      encryption: 'Use FHE CPK to encrypt plaintext off-chain → produce ciphertexts[]',
      storage: 'Ciphertexts are stored in offchain store (e.g., IPFS). Returns CIDs you can use in /job/submit.',
      receipt: 'A signed registration receipt is issued for auditability and replay-safe reproducibility.'
    }
  }
  return cors(NextResponse.json(body))
}

/* ===== POST: store client-encrypted ciphertexts + signed receipt ===== */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const ciphertexts = typeof body.ciphertexts === 'string' ? JSON.parse(body.ciphertexts) : body.ciphertexts
    const enc_params = typeof body.enc_params === 'string' ? JSON.parse(body.enc_params) : body.enc_params
    const policy_ctx = typeof body.policy_ctx === 'string' ? JSON.parse(body.policy_ctx) : body.policy_ctx
    const provenance = body.provenance || 'client'

    if (!ciphertexts || !enc_params || !policy_ctx) {
      return cors(NextResponse.json({ message: 'Missing fields: ciphertexts, enc_params, policy_ctx' }, { status: 400 }))
    }

    // 1) Validate client-encrypted ciphertexts
    //    (Client should have encrypted using FHE CPK from GET request)
    if (!Array.isArray(ciphertexts) || ciphertexts.length === 0) {
      return cors(NextResponse.json({ message: 'ciphertexts must be non-empty array' }, { status: 400 }))
    }

    // 2) Store ciphertexts off-chain -> CIDs
    //    (Demo rule: pretend a CID by hashing; prod: pin to IPFS and return real CID)
    const cids: Array<{ cid: string }> = ciphertexts.map((ct: unknown) => {
      // In production: store actual ciphertext to IPFS and get real CID
      // For demo: generate mock CID based on ciphertext content
      const ctString = canonicalJson(ct)
      const cid = 'Qm' + sha256Hex(Buffer.from(ctString, 'utf8')).slice(4, 4 + 44) // mock CID
      return { cid }
    })

    // 3) Build a signed registration receipt
    const fhe = getFHEcpkInfo()
    const created_at = Math.floor(Date.now() / 1000)
    const receipt_no_sig = {
      reg_id: 'RID-' + created_at + '-' + crypto.randomBytes(4).toString('hex'),
      cids,
      enc_params, // canonical JSON is recommended when hashing later
      policy_ctx,
      provenance, // Track where encryption was performed
      domain: {
        chain_id: fhe.domain.chain_id,
        gatekeeper_program: fhe.domain.gatekeeper_program,
        cpk_id: fhe.cpk_id,
        key_epoch: fhe.domain.key_epoch,
      },
      created_at
    }
    const canonical = canonicalJson(receipt_no_sig)
    // Demo signature (replace with real ed25519 key)
    const signature = Buffer.from(sha256Hex(canonical)).toString('base64') // placeholder
    const receipt = {
      ...receipt_no_sig,
      sig: {
        algo: 'ed25519',
        identity: 'ActionIdentity11111111111111111111111111111111',
        signature
      }
    }

    // 4) Next action: prefill submit with inputs
    const nextHref = `/api/actions/job/submit?inputs=${encodeURIComponent(JSON.stringify(cids))}`

    return cors(NextResponse.json({
      reg_id: receipt.reg_id,
      cids,
      receipt,
      links: { next: { type: 'post', href: '/api/actions/job/submit' } },
      hint: { use_in_submit: nextHref }
    }))
  } catch (e) {
    console.error(e)
    return cors(NextResponse.json({ message: 'Internal server error' }, { status: 500 }))
  }
}
