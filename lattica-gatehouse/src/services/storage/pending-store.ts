/**
 * Pending Ciphertext Store
 * Temporary storage for ciphertexts awaiting on-chain confirmation
 * TTL: 5 minutes (auto-cleanup)
 */

import { createLogger } from '@/lib/logger'
import type { EncryptionParams, PolicyContext } from '@/types/ciphertext'

const log = createLogger('PendingStore')

interface PendingCiphertext {
  cid_pda: string
  ciphertext: unknown
  ciphertext_hash: string
  enc_params: EncryptionParams
  policy_ctx: PolicyContext
  policy_hash: string
  owner: string
  storage_ref: string
  provenance: string
  created_at: number
  expires_at: number
}

const PENDING_TTL_MS = 5 * 60 * 1000  // 5 minutes
const CLEANUP_INTERVAL_MS = 30 * 1000  // 30 seconds

class PendingCiphertextStore {
  private static instance: PendingCiphertextStore
  private pending: Map<string, PendingCiphertext>
  private cleanupTimer?: NodeJS.Timeout

  private constructor() {
    this.pending = new Map()
    this.startCleanupJob()
  }

  static getInstance(): PendingCiphertextStore {
    if (!PendingCiphertextStore.instance) {
      PendingCiphertextStore.instance = new PendingCiphertextStore()
    }
    return PendingCiphertextStore.instance
  }

  /**
   * Store a ciphertext temporarily (awaiting on-chain confirmation)
   */
  store_temporary(
    cid_pda: string,
    ciphertext: unknown,
    ciphertext_hash: string,
    enc_params: EncryptionParams,
    policy_ctx: PolicyContext,
    policy_hash: string,
    owner: string,
    storage_ref: string,
    provenance: string = 'client',
  ): PendingCiphertext {
    const now = Date.now()
    const pending: PendingCiphertext = {
      cid_pda,
      ciphertext,
      ciphertext_hash,
      enc_params,
      policy_ctx,
      policy_hash,
      owner,
      storage_ref,
      provenance,
      created_at: now,
      expires_at: now + PENDING_TTL_MS,
    }

    this.pending.set(cid_pda, pending)
    log.info('Stored temporary CID', { cid: cid_pda.slice(0, 8) + '...', ttl: '5min' })
    return pending
  }

  /**
   * Get pending ciphertext
   */
  get(cid_pda: string): PendingCiphertext | undefined {
    const pending = this.pending.get(cid_pda)
    
    // Check if expired
    if (pending && Date.now() > pending.expires_at) {
      this.pending.delete(cid_pda)
      log.debug('Expired CID removed', { cid: cid_pda.slice(0, 8) + '...' })
      return undefined
    }
    
    return pending
  }

  /**
   * Check if CID exists in pending store
   */
  has(cid_pda: string): boolean {
    return this.get(cid_pda) !== undefined
  }

  /**
   * Remove from pending store (on confirmation or expiry)
   */
  remove(cid_pda: string): boolean {
    const deleted = this.pending.delete(cid_pda)
    if (deleted) {
      log.debug('Removed CID', { cid: cid_pda.slice(0, 8) + '...' })
    }
    return deleted
  }

  /**
   * Get all pending CIDs for an owner
   */
  get_by_owner(owner: string): PendingCiphertext[] {
    return Array.from(this.pending.values()).filter(p => p.owner === owner)
  }

  /**
   * Cleanup expired entries
   */
  cleanup_expired(): number {
    const now = Date.now()
    let removed = 0

    for (const [cid_pda, pending] of this.pending.entries()) {
      if (now > pending.expires_at) {
        this.pending.delete(cid_pda)
        removed++
      }
    }

    if (removed > 0) {
      log.info('Cleaned up expired CIDs', { removed })
    }
    return removed
  }

  /**
   * Get statistics
   */
  get_stats(): {
    total_pending: number
    oldest_timestamp: number
    newest_timestamp: number
  } {
    const entries = Array.from(this.pending.values())
    const timestamps = entries.map(e => e.created_at)
    
    return {
      total_pending: this.pending.size,
      oldest_timestamp: timestamps.length > 0 ? Math.min(...timestamps) : 0,
      newest_timestamp: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    }
  }

  /**
   * Clear all pending (use only in tests)
   */
  clear(): void {
    this.pending.clear()
    log.warn('Cleared all pending CIDs')
  }

  /**
   * Start periodic cleanup
   */
  private startCleanupJob(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup_expired()
    }, CLEANUP_INTERVAL_MS)
  }

  /**
   * Stop cleanup job
   */
  stopCleanupJob(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }
}

// Export singleton
export const pendingCiphertextStore = PendingCiphertextStore.getInstance()

