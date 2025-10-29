/**
 * In-memory Ciphertext Storage
 * Thread-safe singleton for storing registered ciphertexts
 *
 * ⚠️  WARNING: DEMO/DEVELOPMENT IMPLEMENTATION ONLY!
 *
 * This implementation uses in-memory Map storage which is:
 * - NOT persistent (data lost on server restart)
 * - NOT scalable (limited by RAM)
 * - NOT suitable for production use
 *
 * Production requirements:
 * - Persistent database (PostgreSQL, MongoDB, Cassandra, etc.)
 * - Proper indexing on frequently queried fields (owner, status, created_at)
 * - Pagination for all list operations (limit + offset or cursor-based)
 * - Caching layer for hot data (Redis, Memcached)
 * - Backup and recovery mechanisms
 * - Data encryption at rest
 * - Horizontal scaling with sharding/partitioning
 */

import { createLogger } from '@/lib/logger'
import { StoredCiphertext, EncryptionParams, PolicyContext } from '@/types/ciphertext'
import { DEFAULT_STORAGE_CONFIG, StoreStats } from './types'

const log = createLogger('CiphertextStore')

declare global {
  var __ciphertextStore: CiphertextStore | undefined
}

class CiphertextStore {
  private store: Map<string, StoredCiphertext>
  private cleanupTimer?: NodeJS.Timeout

  private constructor() {
    this.store = new Map()
    this.startCleanupJob()
  }

  static getInstance(): CiphertextStore {
    if (!globalThis.__ciphertextStore) {
      globalThis.__ciphertextStore = new CiphertextStore()
    }
    return globalThis.__ciphertextStore
  }
  /**
   * Store a new ciphertext
   * @throws Error if store is full or CID already exists
   */
  store_ciphertext(
    cid_pda: string,
    ciphertext: unknown,
    ciphertext_hash: string,
    enc_params: EncryptionParams,
    policy_ctx: PolicyContext,
    policy_hash: string,
    owner: string,
    storage_ref: string,
    provenance: string = 'client',
  ): StoredCiphertext {
    // Check capacity
    if (this.store.size >= DEFAULT_STORAGE_CONFIG.MAX_STORE_SIZE) {
      throw new Error(`Storage full (max ${DEFAULT_STORAGE_CONFIG.MAX_STORE_SIZE} CIDs)`)
    }

    // Check duplicate
    if (this.store.has(cid_pda)) {
      throw new Error(`CID already exists: ${cid_pda}`)
    }

    // Check ciphertext size (rough estimate)
    const estimatedSize = JSON.stringify(ciphertext).length
    if (estimatedSize > DEFAULT_STORAGE_CONFIG.MAX_CIPHERTEXT_SIZE) {
      throw new Error(`Ciphertext too large: ${estimatedSize} bytes (max ${DEFAULT_STORAGE_CONFIG.MAX_CIPHERTEXT_SIZE})`)
    }

    const now = Math.floor(Date.now() / 1000)
    const stored: StoredCiphertext = {
      cid_pda,
      ciphertext,
      ciphertext_hash,
      enc_params,
      policy_ctx,
      policy_hash,
      metadata: {
        owner,
        storage_ref,
        provenance,
        created_at: now,
      },
      verification: {
        status: 'pending',
      },
    }

    this.store.set(cid_pda, stored)
    log.info('Stored CID', { cid: cid_pda.slice(0, 8) + '...', owner: owner.slice(0, 8) + '...' })
    return stored
  }

  /**
   * Get ciphertext by CID PDA
   */
  get(cid_pda: string): StoredCiphertext | undefined {
    return this.store.get(cid_pda)
  }

  /**
   * Check if CID exists
   */
  exists(cid_pda: string): boolean {
    return this.store.has(cid_pda)
  }

  /**
   * Get multiple ciphertexts
   */
  get_many(cid_pdas: string[]): Map<string, StoredCiphertext | undefined> {
    const result = new Map<string, StoredCiphertext | undefined>()
    for (const cid of cid_pdas) {
      result.set(cid, this.store.get(cid))
    }
    return result
  }

  /**
   * Update ciphertext content (for executor results updating state)
   */
  update_ciphertext_content(
    cid_pda: string,
    new_ciphertext: unknown,
  ): boolean {
    const stored = this.store.get(cid_pda)
    if (!stored) return false

    // Update ciphertext content (keep original provenance)
    stored.ciphertext = new_ciphertext
    
    log.info('Updated CID ciphertext content', { 
      cid: cid_pda.slice(0, 8) + '...',
      original_provenance: stored.metadata.provenance
    })
    return true
  }

  /**
   * Update verification status (for on-chain confirmation)
   */
  update_verification(
    cid_pda: string,
    status: 'pending' | 'confirmed' | 'expired',
    tx_signature?: string,
    block_height?: number,
  ): boolean {
    const stored = this.store.get(cid_pda)
    if (!stored) return false

    stored.verification.status = status
    if (tx_signature) stored.verification.tx_signature = tx_signature
    if (block_height) stored.verification.block_height = block_height
    if (status === 'confirmed') {
      stored.verification.confirmed_at = Math.floor(Date.now() / 1000)
    }

    log.info('Updated CID verification', { cid: cid_pda.slice(0, 8) + '...', status })
    return true
  }

  /**
   * Get all CIDs owned by a specific address
   */
  get_by_owner(owner: string): StoredCiphertext[] {
    return Array.from(this.store.values()).filter(
      stored => stored.metadata.owner === owner
    )
  }

  /**
   * Get all stored ciphertexts
   *
   * WARNING: For demo/development only!
   * This method loads ALL ciphertexts into memory which is inefficient for large datasets.
   *
   * Production recommendations:
   * - Replace in-memory Map with a proper database (PostgreSQL, MongoDB, etc.)
   * - Implement pagination with offset/limit or cursor-based pagination
   * - Add indexes on frequently queried fields (owner, created_at, status)
   * - Consider using a search engine (Elasticsearch) for complex queries
   * - Implement caching layer (Redis) for hot data
   */
  get_all(): StoredCiphertext[] {
    return Array.from(this.store.values())
  }

  /**
   * Get CIDs by status
   */
  get_by_status(status: 'pending' | 'confirmed' | 'expired'): StoredCiphertext[] {
    return Array.from(this.store.values()).filter(
      stored => stored.verification.status === status
    )
  }

  /**
   * Remove expired pending entries
   */
  cleanup_expired(): number {
    const now = Math.floor(Date.now() / 1000)
    const expiryThreshold = now - DEFAULT_STORAGE_CONFIG.PENDING_EXPIRY_SECONDS
    let removed = 0

    for (const [cid_pda, stored] of this.store.entries()) {
      if (
        stored.verification.status === 'pending' &&
        stored.metadata.created_at < expiryThreshold
      ) {
        stored.verification.status = 'expired'
        log.debug('Expired CID', { cid: cid_pda.slice(0, 8) + '...' })
        removed++
      }
    }

    return removed
  }

  /**
   * Get storage statistics
   */
  get_stats(): StoreStats {
    const entries = Array.from(this.store.values())
    const pending = entries.filter(e => e.verification.status === 'pending')
    const confirmed = entries.filter(e => e.verification.status === 'confirmed')
    const expired = entries.filter(e => e.verification.status === 'expired')

    const timestamps = entries.map(e => e.metadata.created_at)
    const oldest = timestamps.length > 0 ? Math.min(...timestamps) : 0
    const newest = timestamps.length > 0 ? Math.max(...timestamps) : 0

    return {
      total_cids: this.store.size,
      pending_count: pending.length,
      confirmed_count: confirmed.length,
      expired_count: expired.length,
      oldest_entry_timestamp: oldest,
      newest_entry_timestamp: newest,
    }
  }

  /**
   * Delete a CID (use with caution)
   */
  delete(cid_pda: string): boolean {
    return this.store.delete(cid_pda)
  }

  /**
   * Clear all data (use only in tests)
   */
  clear(): void {
    this.store.clear()
    log.warn('Cleared all data')
  }

  /**
   * Start periodic cleanup job
   */
  private startCleanupJob(): void {
    this.cleanupTimer = setInterval(() => {
      const removed = this.cleanup_expired()
      if (removed > 0) {
        log.info('Cleanup expired pending CIDs', { removed })
      }
    }, DEFAULT_STORAGE_CONFIG.CLEANUP_INTERVAL_MS)
  }

  /**
   * Stop cleanup job (for graceful shutdown)
   */
  stopCleanupJob(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }
}

// Export singleton instance
export const ciphertextStore = CiphertextStore.getInstance()

