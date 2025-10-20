/**
 * Validation service types
 */

export interface ValidationResult {
  valid: boolean
  cid_pda: string
  reason?: string
  status?: 'pending' | 'confirmed' | 'expired' | 'not_found'
}

export interface BatchValidationResult {
  all_valid: boolean
  total_cids: number
  valid_count: number
  invalid_count: number
  results: ValidationResult[]
  invalid_cids: string[]
}

export interface ValidationPolicy {
  require_confirmed: boolean        // Require on-chain confirmation
  allow_pending: boolean            // Allow pending CIDs
  check_expiry: boolean             // Check timestamp expiry
  check_owner: boolean              // Verify owner matches
  owner?: string                    // Expected owner (if check_owner=true)
}

export const DEFAULT_VALIDATION_POLICY: ValidationPolicy = {
  require_confirmed: false,          // For now, allow pending
  allow_pending: true,
  check_expiry: true,
  check_owner: false,
}

