/**
 * Registration event and log types
 */

export interface DomainInfo {
  chain_id: string                   // "devnet" | "mainnet-beta"
  gatekeeper_program: string         // Program pubkey (base58)
  cpk_id: string                     // CPK identifier
  key_epoch: number                  // Current key epoch
}

export interface RegistrationRecord {
  reg_id: string                     // RID-{timestamp}-{random}
  cid_pdas: string[]                 // Registered CID PDAs
  owner: string                      // Registrant pubkey (base58)
  domain: DomainInfo
  status: 'pending' | 'confirmed' | 'failed' | 'expired'
  created_at: number                 // Unix timestamp
  confirmed_at?: number              // Unix timestamp (once on-chain)
  tx_signature?: string              // Solana tx signature
  block_height?: number              // Confirmation block height
}

export interface RegistrationLogEntry {
  cid_pda: string
  owner: string
  ciphertext_hash: string
  policy_hash: string
  reg_id: string                     // Link to RegistrationRecord
  timestamp: number
  status: 'pending' | 'confirmed' | 'expired' | 'failed'
  tx_signature?: string
}

