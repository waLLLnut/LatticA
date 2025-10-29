/**
 * Decrypt Queue
 * Simple queue for demo decryption requests
 */

import { createLogger } from '@/lib/logger'
import type { DecryptJob } from '@/types/queue'

const log = createLogger('DecryptQueue')

// Declare global type
declare global {
  var __decryptQueue: DecryptQueue | undefined
}

class DecryptQueue {
  private jobs: Map<string, DecryptJob>

  private constructor() {
    this.jobs = new Map()
    log.debug('DecryptQueue instance created')
  }

  static getInstance(): DecryptQueue {
    if (!globalThis.__decryptQueue) {
      globalThis.__decryptQueue = new DecryptQueue()
    }
    return globalThis.__decryptQueue
  }

  /**
   * Create a new decrypt job
   */
  create(cid: string, requester: string): DecryptJob {
    const decrypt_id = `decrypt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    
    const job: DecryptJob = {
      decrypt_id,
      cid,
      requester,
      requested_at: Math.floor(Date.now() / 1000),
      status: 'pending'
    }

    this.jobs.set(decrypt_id, job)
    log.info('Decrypt job created', { decrypt_id, cid: cid.slice(0, 8) + '...' })
    return job
  }

  /**
   * Get pending jobs for executor
   */
  get_pending(): DecryptJob[] {
    return Array.from(this.jobs.values())
      .filter(job => job.status === 'pending')
      .sort((a, b) => a.requested_at - b.requested_at)
  }

  /**
   * Get a specific job
   */
  get(decrypt_id: string): DecryptJob | undefined {
    return this.jobs.get(decrypt_id)
  }

  /**
   * Assign job to executor
   */
  assign(decrypt_id: string, executor: string): boolean {
    const job = this.jobs.get(decrypt_id)
    if (!job || job.status !== 'pending') return false

    job.status = 'processing'
    job.executor = executor
    log.info('Decrypt job assigned', { decrypt_id, executor: executor.slice(0, 8) + '...' })
    return true
  }

  /**
   * Complete job with result
   */
  complete(decrypt_id: string, decrypted_value: number): boolean {
    const job = this.jobs.get(decrypt_id)
    if (!job) return false

    job.status = 'completed'
    job.decrypted_value = decrypted_value
    job.completed_at = Math.floor(Date.now() / 1000)
    
    log.info('Decrypt job completed', { 
      decrypt_id, 
      decrypted_value,
      cid: job.cid.slice(0, 8) + '...'
    })
    return true
  }

  /**
   * Mark job as failed
   */
  fail(decrypt_id: string, error: string): boolean {
    const job = this.jobs.get(decrypt_id)
    if (!job) return false

    job.status = 'failed'
    job.error = error
    job.completed_at = Math.floor(Date.now() / 1000)
    
    log.error('Decrypt job failed', { decrypt_id, error })
    return true
  }

  /**
   * Get stats
   */
  get_stats() {
    const jobs = Array.from(this.jobs.values())
    return {
      total: jobs.length,
      pending: jobs.filter(j => j.status === 'pending').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
    }
  }

  /**
   * Clear old completed jobs (cleanup)
   */
  cleanup(max_age_seconds: number = 3600) {
    const now = Math.floor(Date.now() / 1000)
    let removed = 0

    for (const [id, job] of this.jobs) {
      if (job.status === 'completed' || job.status === 'failed') {
        if (job.completed_at && (now - job.completed_at) > max_age_seconds) {
          this.jobs.delete(id)
          removed++
        }
      }
    }

    if (removed > 0) {
      log.debug('Cleaned up old decrypt jobs', { removed })
    }
  }
}

// Export singleton
export const decryptQueue = DecryptQueue.getInstance()

