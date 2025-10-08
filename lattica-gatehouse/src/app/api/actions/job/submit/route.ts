import { NextRequest, NextResponse } from 'next/server'
import { Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js'

// Set CORS headers
function setCorsHeaders(response: NextResponse) {
  response.headers.set('Access-Control-Allow-Origin', '*')
  response.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding, Accept-Encoding')
  return response
}

// Handle OPTIONS requests
export async function OPTIONS() {
  const response = new NextResponse(null, { status: 200 })
  return setCorsHeaders(response)
}

// Verify CID existence in Offchain Store
async function verifyCIDsExist(inputs: Array<{ cid: string }>): Promise<boolean> {
  try {
    // In production, verify CIDs exist in Offchain Store (IPFS, etc.)
    // For now, assume all CIDs exist if they start with 'Qm'
    for (const input of inputs) {
      if (!input.cid || !input.cid.startsWith('Qm')) {
        return false
      }
    }
    return true
  } catch (error) {
    console.error('Error verifying CIDs:', error)
    return false
  }
}

// Commitment calculation functions
function calculateInputsCommit(inputs: Array<{ cid: string }>): string {
  // In production, calculate proper hash of inputs
  const inputsString = inputs.map(input => input.cid).join('')
  return `0x${Buffer.from(inputsString).toString('hex').padStart(64, '0')}`
}

function calculateEncParamsHash(encParams: unknown): string {
  // In production, calculate proper hash of enc_params
  const encParamsString = JSON.stringify(encParams)
  return `0x${Buffer.from(encParamsString).toString('hex').padStart(64, '0')}`
}

function calculatePolicyHash(policyCtx: unknown): string {
  // In production, calculate proper hash of policy_ctx
  const policyString = JSON.stringify(policyCtx)
  return `0x${Buffer.from(policyString).toString('hex').padStart(64, '0')}`
}

function calculateCommitment(inputsCommit: string, encParamsHash: string, policyHash: string): string {
  // In production, calculate final commitment combining all hashes
  const combined = inputsCommit + encParamsHash + policyHash
  return `0x${Buffer.from(combined).toString('hex').padStart(64, '0')}`
}

// GET /api/actions/job/submit - Return action metadata
export async function GET(_request: NextRequest) {
  try {
    // Return ActionGetResponse
    const actionResponse = {
      type: "action",
      icon: "https://aegis.run/icon.png",
      title: "Gatekeeper · Submit Confidential Job",
      description: "Submit a confidential computation job to the gatekeeper network.",
      label: "Submit Confidential Job",
      disabled: false,
      links: {
        actions: [
          {
            type: "post",
            href: "/api/actions/job/submit",
            label: "Submit Job",
            parameters: [
              {
                name: "inputs",
                label: "Input CIDs",
                required: true,
                type: "textarea",
                pattern: "^\\[\\s*\\{\\s*\"cid\"\\s*:\\s*\"[^\"]+\"\\s*\\}(\\s*,\\s*\\{\\s*\"cid\"\\s*:\\s*\"[^\"]+\"\\s*\\})*\\s*\\]$",
                patternDescription: "JSON array of objects with cid field, e.g., [{\"cid\":\"QmXXX\"}, {\"cid\":\"QmYYY\"}]"
              },
              {
                name: "ir_digest",
                label: "IR Digest",
                required: true,
                pattern: "^0x[0-9a-fA-F]{64}$",
                patternDescription: "64-character hex string starting with 0x"
              },
              {
                name: "enc_params",
                label: "Encryption Parameters",
                required: true,
                type: "textarea",
                pattern: "^\\{.*\\}$",
                patternDescription: "JSON object containing encryption parameters"
              },
              {
                name: "policy_ctx",
                label: "Policy Context",
                required: true,
                type: "textarea",
                pattern: "^\\{.*\\}$",
                patternDescription: "JSON object containing policy context"
              }
            ]
          }
        ]
      }
    }

    const response = NextResponse.json(actionResponse)
    return setCorsHeaders(response)
  } catch (error) {
    console.error('Error in GET /api/actions/job/submit:', error)
    const response = NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 }
    )
    return setCorsHeaders(response)
  }
}

// POST /api/actions/job/submit - Create and return transaction
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { account, inputs, ir_digest, enc_params, policy_ctx } = body

    if (!account || !inputs || !ir_digest || !enc_params || !policy_ctx) {
      const response = NextResponse.json(
        { message: 'Missing required fields: account, inputs, ir_digest, enc_params, policy_ctx' },
        { status: 400 }
      )
      return setCorsHeaders(response)
    }

    // Input validation
    let parsedInputs: Array<{ cid: string }>
    try {
      parsedInputs = typeof inputs === 'string' ? JSON.parse(inputs) : inputs
    } catch {
      const response = NextResponse.json(
        { message: 'Invalid inputs format. Must be JSON array of objects with cid field.' },
        { status: 400 }
      )
      return setCorsHeaders(response)
    }

    let parsedEncParams: unknown
    try {
      parsedEncParams = typeof enc_params === 'string' ? JSON.parse(enc_params) : enc_params
    } catch {
      const response = NextResponse.json(
        { message: 'Invalid enc_params format. Must be JSON object.' },
        { status: 400 }
      )
      return setCorsHeaders(response)
    }

    let parsedPolicyCtx: unknown
    try {
      parsedPolicyCtx = typeof policy_ctx === 'string' ? JSON.parse(policy_ctx) : policy_ctx
    } catch {
      const response = NextResponse.json(
        { message: 'Invalid policy_ctx format. Must be JSON object.' },
        { status: 400 }
      )
      return setCorsHeaders(response)
    }

    // Verify CID existence in Offchain Store
    const cidsExist = await verifyCIDsExist(parsedInputs)
    if (!cidsExist) {
      const response = NextResponse.json(
        { message: 'One or more CIDs do not exist in the offchain store' },
        { status: 400 }
      )
      return setCorsHeaders(response)
    }

    // Calculate commitments
    const inputsCommit = calculateInputsCommit(parsedInputs)
    const encParamsHash = calculateEncParamsHash(parsedEncParams)
    const policyHash = calculatePolicyHash(parsedPolicyCtx)
    const commitment = calculateCommitment(inputsCommit, encParamsHash, policyHash)

    // Setup Solana connection
    const connection = new Connection('https://api.mainnet-beta.solana.com')
    
    // Get latest blockhash
    const { blockhash } = await connection.getLatestBlockhash()

    // Create transaction
    const transaction = new Transaction()
    
    // Gatekeeper program ID (example)
    const gatekeeperProgramId = new PublicKey('GateKeep3r11111111111111111111111111111111')
    const submitterPubkey = new PublicKey(account)

    // Add gatekeeper submit_job instruction
    // In production, call actual gatekeeper program instruction
    // submit_job(account, inputs_commit, enc_params_hash, policy_hash, commitment)
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: submitterPubkey,
        toPubkey: gatekeeperProgramId,
        lamports: 0, // Should be actual gatekeeper instruction
      })
    )

    // Add Action Identity memo
    const actionIdentity = "solana-action:ActionIdentity11111111111111111111111111111111:Reference1234567890abcdef1234567890abcdef:Signature1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
    transaction.add({
      keys: [],
      programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysKcWfC85B2q2'),
      data: Buffer.from(actionIdentity, 'utf8')
    })

    // Set transaction properties
    transaction.recentBlockhash = blockhash
    transaction.feePayer = submitterPubkey

    // Serialize transaction to base64
    const serializedTransaction = transaction.serialize({ requireAllSignatures: false })
    const base64Transaction = serializedTransaction.toString('base64')

    // Return ActionPostResponse
    const postResponse = {
      transaction: base64Transaction,
      message: "Submit confidential compute",
      // Debug values for development (remove in production)
      debug: {
        inputs_commit: inputsCommit,
        enc_params_hash: encParamsHash,
        policy_hash: policyHash,
        commitment: commitment
      }
    }

    const response = NextResponse.json(postResponse)
    return setCorsHeaders(response)
  } catch (error) {
    console.error('Error in POST /api/actions/job/submit:', error)
    const response = NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 }
    )
    return setCorsHeaders(response)
  }
}
