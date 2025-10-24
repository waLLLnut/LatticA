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

export async function GET(req: NextRequest) {
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
  
  // Generate dynamic base URL
  const baseURL = new URL(req.url).origin
  
  return cors(NextResponse.json({
    type: 'action',
    icon: new URL('/logo.png', baseURL).toString(),
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
        href: `${baseURL}/api/actions/job/registerCIDs?ciphertext={ciphertext}&policy_type={policy_type}&provenance={provenance}`,
        label: 'Register CIDs',
        parameters: [
          {
            name: 'ciphertext',
            label: 'Encrypted Data (JSON array or single value)',
            required: true,
          },
          {
            name: 'policy_type',
            label: 'Decryption Policy',
            type: 'select',
            required: true,
            options: [
              { label: 'Owner-Controlled (Private)', value: 'owner-controlled', selected: true },
              { label: 'Protocol-Managed (Shared)', value: 'protocol-managed' },
            ]
          },
          {
            name: 'provenance',
            label: 'Data Source',
            type: 'select',
            required: false,
            options: [
              { label: 'Direct Owner Call', value: '1', selected: true },
              { label: 'CPI Call', value: '0' },
            ]
          },
        ]
      }]
    },
    notes: {
      encryption: 'FHE16_0.0.1v - Use FHE CPK to encrypt plaintext off-chain',
      storage: 'Ciphertexts stored temporarily (5min TTL). Only confirmed after on-chain event.',
      receipt: 'Registration receipt issued. Monitor on-chain events for confirmation.',
      workflow: 'POST returns tx → sign & send → on-chain event → confirmed storage',
      decryption_policy: 'Owner-Controlled: Only data owner can decrypt (private). Protocol-Managed: Protocol has decryption access (shared).'
    }
  }))
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.json()
    const url = new URL(req.url)

    // Get parameters from either query params (Blinks Inspector) or body (Dial.to)
    const bodyData = rawBody.data || rawBody
    const account = rawBody.account

    // New simplified parameters
    const ciphertext_raw = url.searchParams.get('ciphertext') || bodyData.ciphertext
    const policy_type = url.searchParams.get('policy_type') || bodyData.policy_type || 'owner-controlled'
    const provenance_raw = url.searchParams.get('provenance') || bodyData.provenance || '1'

    // Backward compatibility: support old encryption_scheme parameter (ignored, always FHE16_0.0.1v)
    const encryption_scheme = 'FHE16_0.0.1v'

    // Backward compatibility: support old parameter names (ciphertexts, enc_params, policy_ctx)
    const ciphertexts_raw = url.searchParams.get('ciphertexts') || bodyData.ciphertexts
    const enc_params_raw = url.searchParams.get('enc_params') || bodyData.enc_params
    const policy_ctx_raw = url.searchParams.get('policy_ctx') || bodyData.policy_ctx

    // Debug logging
    log.info('POST request received', {
      body_keys: Object.keys(rawBody),
      query_params: Array.from(url.searchParams.keys()),
      account: account ? 'present' : 'missing',
      has_nested_data: !!rawBody.data,
      source: url.searchParams.has('ciphertext') ? 'query_params' : 'body',
    })

    // Convert simplified parameters to internal format
    let ciphertexts, enc_params: EncryptionParams, policy_ctx: PolicyContext

    if (ciphertext_raw) {
      // New format: handle both single value and array
      let ciphertextArray: string[]

      if (typeof ciphertext_raw === 'string') {
        // Try parsing as JSON array first
        try {
          const parsed = JSON.parse(ciphertext_raw)
          ciphertextArray = Array.isArray(parsed) ? parsed : [ciphertext_raw]
        } catch {
          // Not JSON, treat as single value
          ciphertextArray = [ciphertext_raw]
        }
      } else if (Array.isArray(ciphertext_raw)) {
        ciphertextArray = ciphertext_raw
      } else {
        ciphertextArray = [String(ciphertext_raw)]
      }

      // Convert each ciphertext to proper format
      ciphertexts = ciphertextArray.map(ct => ({ encrypted_data: ct }))

      // Fixed encryption scheme: FHE16_0.0.1v
      enc_params = { scheme: encryption_scheme }

      // Map policy_type to policy_ctx with decryption permissions
      const policyMap: Record<string, { allow: string[]; decrypt_by: string }> = {
        'owner-controlled': { allow: ['compute'], decrypt_by: 'owner' },  // Private: owner only
        'protocol-managed': { allow: ['compute', 'store'], decrypt_by: 'protocol' }, // Shared: protocol access
        // Backward compatibility
        'compute': { allow: ['compute'], decrypt_by: 'owner' },
        'compute-decrypt-owner': { allow: ['compute'], decrypt_by: 'owner' },
        'compute-store': { allow: ['compute', 'store'], decrypt_by: 'protocol' },
        'full': { allow: ['compute', 'store', 'transfer'], decrypt_by: 'protocol' }
      }
      const policyConfig = policyMap[policy_type] || policyMap['owner-controlled']
      policy_ctx = {
        allow: policyConfig.allow,
        version: '1.0',
        decrypt_by: policyConfig.decrypt_by
      }
    } else if (ciphertexts_raw) {
      // Backward compatibility: parse JSON parameters
      try {
        ciphertexts = typeof ciphertexts_raw === 'string' ? JSON.parse(ciphertexts_raw) : ciphertexts_raw
        enc_params = typeof enc_params_raw === 'string' ? JSON.parse(enc_params_raw) : enc_params_raw
        policy_ctx = typeof policy_ctx_raw === 'string' ? JSON.parse(policy_ctx_raw) : policy_ctx_raw
      } catch {
        return cors(NextResponse.json({
          message: 'Invalid JSON in parameters (ciphertexts, enc_params, or policy_ctx)'
        }, { status: 400 }))
      }
    } else {
      return cors(NextResponse.json({
        message: 'Missing ciphertext parameter'
      }, { status: 400 }))
    }

    const provenance = provenance_raw

    // Validation
    if (!account || !ciphertexts || !enc_params || !policy_ctx) {
      log.error('Validation failed', {
        account: !!account,
        ciphertexts: !!ciphertexts,
        enc_params: !!enc_params,
        policy_ctx: !!policy_ctx,
      })
      return cors(NextResponse.json({
        message: 'Missing required fields: account, ciphertexts, enc_params, policy_ctx',
        debug: {
          received_keys: Object.keys(rawBody),
          has_nested_data: !!rawBody.data,
          account_present: !!account,
          ciphertexts_present: !!ciphertexts,
          enc_params_present: !!enc_params,
          policy_ctx_present: !!policy_ctx,
        }
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
    // Use 'confirmed' instead of 'finalized' for fresher blockhash (Blinks best practice)
    // This prevents blockhash expiry during user signing on Dial.to
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction()
    tx.feePayer = owner
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight
    tx.add(...instructions)

    // Serialize transaction
    // IMPORTANT: Use verifySignatures: false since we don't have user's signature yet
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })

    // Log transaction details for debugging
    log.info('Transaction details', {
      feePayer: owner.toBase58(),
      blockhash: blockhash.slice(0, 8) + '...',
      instructions: instructions.length,
      accounts_per_ix: instructions[0]?.keys.length || 0,
      cid_pdas: cids.map(c => c.cid_pda.slice(0, 8) + '...'),
    })

    // Simulate transaction to catch errors early
    let simulationResult: { success: boolean; error?: any; logs?: string[] } = { success: false }
    try {
      const simulation = await connection.simulateTransaction(tx)
      if (simulation.value.err) {
        // Log with better error formatting
        console.error('=== SIMULATION ERROR DETAILS ===')
        console.error('Error object:', simulation.value.err)
        console.error('Error JSON:', JSON.stringify(simulation.value.err))
        console.error('Logs:', simulation.value.logs)
        console.error('================================')

        log.error('Transaction simulation failed', {
          error: JSON.stringify(simulation.value.err, null, 2),
          logs: simulation.value.logs,
        })
        simulationResult = {
          success: false,
          error: simulation.value.err,
          logs: simulation.value.logs || [],
        }

        // Return error immediately if simulation fails
        return cors(NextResponse.json({
          message: 'Transaction simulation failed. This transaction will likely fail on-chain.',
          error: simulation.value.err,
          logs: simulation.value.logs,
          hint: 'Common causes: Program not initialized (missing config PDA), insufficient SOL balance, or invalid instruction data',
          troubleshooting: {
            check_balance: `Ensure ${owner.toBase58()} has sufficient SOL (>0.01 SOL)`,
            check_program: `Program ${gatekeeperProgram.toBase58()} must be initialized`,
            cid_pdas: cids.map(c => c.cid_pda),
          }
        }, { status: 400 }))
      } else {
        log.info('Transaction simulation successful', {
          units_consumed: simulation.value.unitsConsumed,
        })
        simulationResult = { success: true }
      }
    } catch (simError) {
      log.warn('Simulation check failed (non-fatal)', simError)
      // Continue anyway - some valid txs fail simulation
    }

    log.info('Created pending registration', {
      reg_id: registration.reg_id.slice(0, 8) + '...',
      cids: cids.length
    })

    // Standard Solana Actions response format
    // Keep it minimal for better Dial.to compatibility
    return cors(NextResponse.json({
      transaction: Buffer.from(serializedTx).toString('base64'),
      message: `Successfully registered ${cids.length} CID handle(s)`,
      cid_pdas: cids.map(c => c.cid_pda), // Add CID PDAs for frontend use
      registration_id: registration.reg_id,
    }))
  } catch (e: unknown) {
    log.error('Register CIDs error', e)
    return cors(NextResponse.json({
      message: e instanceof Error ? e.message : 'Internal server error',
      details: e instanceof Error ? e.stack : String(e)
    }, { status: 500 }))
  }
}
