/**
 * Ciphertext storage types
 */

export interface EncryptionParams {
  scheme: string              // "FHE16"
  cpk_id: string              // "v1-2025"
  [key: string]: unknown      // Additional encryption parameters
}

export interface PolicyContext {
  version?: string
  [key: string]: unknown      // Policy-specific fields
}

export interface CiphertextMetadata {
  owner: string               // Owner pubkey (base58)
  storage_ref: string         // IPFS/Arweave URI
  provenance: string          // "client" | "server"
  created_at: number          // Unix timestamp
}

export interface CiphertextVerification {
  status: 'pending' | 'confirmed' | 'expired'
  tx_signature?: string       // Solana tx signature (once confirmed)
  confirmed_at?: number       // Unix timestamp
  block_height?: number       // Confirmation block height
}

export interface StoredCiphertext {
  cid_pda: string                    // CID PDA (base58)
  ciphertext: unknown                // Raw ciphertext data
  ciphertext_hash: string            // sha256 hash (0x + 64 hex)
  enc_params: EncryptionParams
  policy_ctx: PolicyContext
  policy_hash: string                // sha256 hash (0x + 64 hex)
  metadata: CiphertextMetadata
  verification: CiphertextVerification
}

export interface CIDInfo {
  cid_pda: string
  ciphertext_hash: string
  policy_hash: string
  storage_ref: string
}

