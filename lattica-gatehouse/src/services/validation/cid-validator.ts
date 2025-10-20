/**
 * CID Validator
 * Validates CID existence, status, and eligibility for use in jobs
 */

import { ciphertextStore } from '../storage/ciphertext-store'
import { registrationLog } from '../storage/registration-log'
import { 
  ValidationResult, 
  BatchValidationResult, 
  ValidationPolicy,
  DEFAULT_VALIDATION_POLICY 
} from './types'

class CIDValidator {
  private static instance: CIDValidator

  private constructor() {}

  static getInstance(): CIDValidator {
    if (!CIDValidator.instance) {
      CIDValidator.instance = new CIDValidator()
    }
    return CIDValidator.instance
  }

  /**
   * Validate a single CID
   */
  validate_cid(cid_pda: string, policy: ValidationPolicy = DEFAULT_VALIDATION_POLICY): ValidationResult {
    // Check if CID exists in store
    const stored = ciphertextStore.get(cid_pda)
    if (!stored) {
      return {
        valid: false,
        cid_pda,
        reason: 'CID not found in storage',
        status: 'not_found',
      }
    }

    // Check registration log
    const entry = registrationLog.get_entry(cid_pda)
    if (!entry) {
      return {
        valid: false,
        cid_pda,
        reason: 'CID not found in registration log',
        status: 'not_found',
      }
    }

    const status = stored.verification.status

    // Check if confirmed required
    if (policy.require_confirmed && status !== 'confirmed') {
      return {
        valid: false,
        cid_pda,
        reason: 'CID not confirmed on-chain',
        status,
      }
    }

    // Check if pending allowed
    if (!policy.allow_pending && status === 'pending') {
      return {
        valid: false,
        cid_pda,
        reason: 'Pending CIDs not allowed',
        status,
      }
    }

    // Check expiry
    if (policy.check_expiry && status === 'expired') {
      return {
        valid: false,
        cid_pda,
        reason: 'CID has expired',
        status,
      }
    }

    // Check owner
    if (policy.check_owner && policy.owner) {
      if (stored.metadata.owner !== policy.owner) {
        return {
          valid: false,
          cid_pda,
          reason: `Owner mismatch (expected: ${policy.owner}, got: ${stored.metadata.owner})`,
          status,
        }
      }
    }

    // All checks passed
    return {
      valid: true,
      cid_pda,
      status,
    }
  }

  /**
   * Validate multiple CIDs
   */
  validate_cids(cid_pdas: string[], policy: ValidationPolicy = DEFAULT_VALIDATION_POLICY): BatchValidationResult {
    const results: ValidationResult[] = []
    const invalid_cids: string[] = []

    for (const cid of cid_pdas) {
      const result = this.validate_cid(cid, policy)
      results.push(result)
      if (!result.valid) {
        invalid_cids.push(cid)
      }
    }

    const valid_count = results.filter(r => r.valid).length
    const invalid_count = results.length - valid_count

    return {
      all_valid: invalid_count === 0,
      total_cids: cid_pdas.length,
      valid_count,
      invalid_count,
      results,
      invalid_cids,
    }
  }

  /**
   * Quick check if all CIDs exist (lighter than full validation)
   */
  check_existence(cid_pdas: string[]): { all_exist: boolean; missing: string[] } {
    const missing: string[] = []

    for (const cid of cid_pdas) {
      if (!ciphertextStore.exists(cid)) {
        missing.push(cid)
      }
    }

    return {
      all_exist: missing.length === 0,
      missing,
    }
  }

  /**
   * Check if CIDs have compatible policies (same policy_hash)
   */
  check_policy_compatibility(cid_pdas: string[]): {
    compatible: boolean
    policy_hashes: Map<string, number>
    reason?: string
  } {
    const policy_hashes = new Map<string, number>()

    for (const cid of cid_pdas) {
      const stored = ciphertextStore.get(cid)
      if (!stored) {
        return {
          compatible: false,
          policy_hashes,
          reason: `CID not found: ${cid}`,
        }
      }

      const hash = stored.policy_hash
      policy_hashes.set(hash, (policy_hashes.get(hash) || 0) + 1)
    }

    // All CIDs must have the same policy hash
    if (policy_hashes.size > 1) {
      return {
        compatible: false,
        policy_hashes,
        reason: `Multiple policy hashes found: ${Array.from(policy_hashes.keys()).join(', ')}`,
      }
    }

    return {
      compatible: true,
      policy_hashes,
    }
  }

  /**
   * Validate CIDs for job submission
   * Stricter checks: existence, status, policy compatibility
   */
  validate_for_job_submission(
    cid_pdas: string[],
    expected_policy_hash?: string,
  ): BatchValidationResult & { policy_compatible: boolean } {
    // Basic validation
    const policy: ValidationPolicy = {
      ...DEFAULT_VALIDATION_POLICY,
      check_owner: false, // Don't enforce owner for job submission
    }
    const basic_result = this.validate_cids(cid_pdas, policy)

    // Check policy compatibility
    const policy_check = this.check_policy_compatibility(cid_pdas)
    
    // If expected policy hash provided, verify it
    if (expected_policy_hash && policy_check.compatible) {
      const actual_hash = Array.from(policy_check.policy_hashes.keys())[0]
      if (actual_hash !== expected_policy_hash) {
        return {
          ...basic_result,
          all_valid: false,
          policy_compatible: false,
          invalid_cids: [...basic_result.invalid_cids, ...cid_pdas],
        }
      }
    }

    return {
      ...basic_result,
      all_valid: basic_result.all_valid && policy_check.compatible,
      policy_compatible: policy_check.compatible,
    }
  }
}

// Export singleton instance
export const cidValidator = CIDValidator.getInstance()

