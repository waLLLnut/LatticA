/**
 * Registration Log
 * Tracks registration events for on-chain verification
 */

import { createLogger } from '@/lib/logger'
import { RegistrationRecord, RegistrationLogEntry, DomainInfo } from '@/types/registration'
import { DEFAULT_STORAGE_CONFIG } from './types'

const log = createLogger('RegistrationLog')

class RegistrationLog {
  private static instance: RegistrationLog
  private records: Map<string, RegistrationRecord>          // reg_id -> RegistrationRecord
  private entries: Map<string, RegistrationLogEntry>        // cid_pda -> RegistrationLogEntry
  private ownerIndex: Map<string, Set<string>>              // owner -> Set<reg_id>

  private constructor() {
    this.records = new Map()
    this.entries = new Map()
    this.ownerIndex = new Map()
  }

  static getInstance(): RegistrationLog {
    if (!RegistrationLog.instance) {
      RegistrationLog.instance = new RegistrationLog()
    }
    return RegistrationLog.instance
  }

  /**
   * Generate unique registration ID
   */
  private generateRegId(): string {
    const timestamp = Math.floor(Date.now() / 1000)
    const random = Math.random().toString(36).substring(2, 8)
    return `RID-${timestamp}-${random}`
  }

  /**
   * Create a new registration record
   */
  create_registration(
    cid_pdas: string[],
    cid_hashes: string[],
    policy_hashes: string[],
    owner: string,
    domain: DomainInfo,
  ): RegistrationRecord {
    if (cid_pdas.length === 0) {
      throw new Error('Cannot create registration with zero CIDs')
    }

    if (cid_pdas.length !== cid_hashes.length || cid_pdas.length !== policy_hashes.length) {
      throw new Error('CID, hash, and policy arrays must have same length')
    }

    const reg_id = this.generateRegId()
    const now = Math.floor(Date.now() / 1000)

    const record: RegistrationRecord = {
      reg_id,
      cid_pdas,
      owner,
      domain,
      status: 'pending',
      created_at: now,
    }

    this.records.set(reg_id, record)

    // Create log entries for each CID
    for (let i = 0; i < cid_pdas.length; i++) {
      const entry: RegistrationLogEntry = {
        cid_pda: cid_pdas[i],
        owner,
        ciphertext_hash: cid_hashes[i],
        policy_hash: policy_hashes[i],
        reg_id,
        timestamp: now,
        status: 'pending',
      }
      this.entries.set(cid_pdas[i], entry)
    }

    // Update owner index
    if (!this.ownerIndex.has(owner)) {
      this.ownerIndex.set(owner, new Set())
    }
    this.ownerIndex.get(owner)!.add(reg_id)

    log.info('Created registration', { reg_id: reg_id.slice(0, 8) + '...', cids: cid_pdas.length })
    return record
  }

  /**
   * Get registration record by ID
   */
  get_registration(reg_id: string): RegistrationRecord | undefined {
    return this.records.get(reg_id)
  }

  /**
   * Get log entry for a CID
   */
  get_entry(cid_pda: string): RegistrationLogEntry | undefined {
    return this.entries.get(cid_pda)
  }

  /**
   * Check if CID is registered
   */
  is_registered(cid_pda: string): boolean {
    return this.entries.has(cid_pda)
  }

  /**
   * Check if CID is confirmed on-chain
   */
  is_confirmed(cid_pda: string): boolean {
    const entry = this.entries.get(cid_pda)
    return entry?.status === 'confirmed'
  }

  /**
   * Get CID status
   */
  get_status(cid_pda: string): 'pending' | 'confirmed' | 'expired' | 'failed' | 'not_found' {
    const entry = this.entries.get(cid_pda)
    if (!entry) return 'not_found'
    return entry.status
  }

  /**
   * Update registration status (on-chain confirmation)
   */
  update_registration_status(
    reg_id: string,
    status: 'confirmed' | 'failed',
    tx_signature?: string,
    block_height?: number,
  ): boolean {
    const record = this.records.get(reg_id)
    if (!record) return false

    record.status = status
    if (tx_signature) record.tx_signature = tx_signature
    if (block_height) record.block_height = block_height
    if (status === 'confirmed') {
      record.confirmed_at = Math.floor(Date.now() / 1000)
    }

    // Update all associated entries
    for (const cid_pda of record.cid_pdas) {
      const entry = this.entries.get(cid_pda)
      if (entry) {
        entry.status = status
        if (tx_signature) entry.tx_signature = tx_signature
      }
    }

    log.info('Updated registration status', { reg_id: reg_id.slice(0, 8) + '...', status })
    return true
  }

  /**
   * Update single CID entry status
   */
  update_entry_status(
    cid_pda: string,
    status: 'pending' | 'confirmed' | 'expired' | 'failed',
    tx_signature?: string,
  ): boolean {
    const entry = this.entries.get(cid_pda)
    if (!entry) return false

    entry.status = status
    if (tx_signature) entry.tx_signature = tx_signature

    log.info('Updated CID status', { cid: cid_pda.slice(0, 8) + '...', status })
    return true
  }

  /**
   * Get all registrations by owner
   */
  get_by_owner(owner: string): RegistrationRecord[] {
    const reg_ids = this.ownerIndex.get(owner)
    if (!reg_ids) return []

    return Array.from(reg_ids)
      .map(reg_id => this.records.get(reg_id))
      .filter((r): r is RegistrationRecord => r !== undefined)
  }

  /**
   * Get registrations by status
   */
  get_by_status(status: 'pending' | 'confirmed' | 'failed' | 'expired'): RegistrationRecord[] {
    return Array.from(this.records.values()).filter(r => r.status === status)
  }

  /**
   * Expire old pending entries
   */
  expire_old_pending(): number {
    const now = Math.floor(Date.now() / 1000)
    const expiryThreshold = now - DEFAULT_STORAGE_CONFIG.PENDING_EXPIRY_SECONDS
    let expired = 0

    for (const record of this.records.values()) {
      if (record.status === 'pending' && record.created_at < expiryThreshold) {
        record.status = 'expired'
        
        // Update entries
        for (const cid_pda of record.cid_pdas) {
          const entry = this.entries.get(cid_pda)
          if (entry) {
            entry.status = 'expired'
          }
        }
        expired++
      }
    }

    if (expired > 0) {
      log.info('Expired old pending registrations', { expired })
    }
    return expired
  }

  /**
   * Get statistics
   */
  get_stats(): {
    total_registrations: number
    total_cids: number
    pending_registrations: number
    confirmed_registrations: number
    failed_registrations: number
    expired_registrations: number
  } {
    const records_arr = Array.from(this.records.values())
    return {
      total_registrations: this.records.size,
      total_cids: this.entries.size,
      pending_registrations: records_arr.filter(r => r.status === 'pending').length,
      confirmed_registrations: records_arr.filter(r => r.status === 'confirmed').length,
      failed_registrations: records_arr.filter(r => r.status === 'failed').length,
      expired_registrations: records_arr.filter(r => r.status === 'expired').length,
    }
  }

  /**
   * Clear all data (use only in tests)
   */
  clear(): void {
    this.records.clear()
    this.entries.clear()
    this.ownerIndex.clear()
    log.warn('Cleared all data')
  }
}

// Export singleton instance
export const registrationLog = RegistrationLog.getInstance()

