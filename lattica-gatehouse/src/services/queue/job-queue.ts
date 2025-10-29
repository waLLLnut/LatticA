/**
 * Job Queue
 * Event-driven job scheduling for FHE execution
 * Jobs are only enqueued after on-chain confirmation
 *
 * Uses globalThis to ensure singleton persistence across Next.js hot reloads
 */

import { createLogger } from '@/lib/logger'
import type { QueuedJob, JobStatus, JobQueueStats, BatchWindowJobs } from '@/types/queue'
import type { JobSubmittedEvent } from '@/types/events'

const log = createLogger('JobQueue')

// Declare global type for TypeScript
declare global {
  var __jobQueue: JobQueue | undefined
}

class JobQueue {
  private jobs: Map<string, QueuedJob>              // job_pda -> QueuedJob
  private batchIndex: Map<string, Set<string>>      // batch_pda -> Set<job_pda>
  private slotIndex: Map<number, Set<string>>       // slot -> Set<job_pda>

  private constructor() {
    this.jobs = new Map()
    this.batchIndex = new Map()
    this.slotIndex = new Map()
    log.debug('JobQueue instance created')
  }

  static getInstance(): JobQueue {
    // Use globalThis to persist across hot reloads
    if (!globalThis.__jobQueue) {
      globalThis.__jobQueue = new JobQueue()
    }
    return globalThis.__jobQueue
  }

  /**
   * Enqueue a job (only called after on-chain confirmation)
   */
  enqueue(event: JobSubmittedEvent): QueuedJob {
    if (this.jobs.has(event.job)) {
      log.warn('Job already enqueued', { job: event.job })
      return this.jobs.get(event.job)!
    }

    const job: QueuedJob = {
      job_pda: event.job,
      submitter: '', // TODO: Extract from job account or store in event
      batch: event.batch,
      commitment: event.commitment,
      cid_set_id: event.cid_set_id,
      cid_handles: event.cid_handles,
      ir_digest: event.ir_digest,
      policy_hash: '', // TODO: Extract from CID handles or infer
      provenance: event.provenance,
      queued_at: Math.floor(Date.now() / 1000),
      submitted_at: event.block_time,
      slot: event.slot,
      tx_signature: event.tx_signature,
      status: 'queued',
    }

    this.jobs.set(event.job, job)

    // Update batch index
    if (!this.batchIndex.has(event.batch)) {
      this.batchIndex.set(event.batch, new Set())
    }
    this.batchIndex.get(event.batch)!.add(event.job)

    // Update slot index
    if (!this.slotIndex.has(event.slot)) {
      this.slotIndex.set(event.slot, new Set())
    }
    this.slotIndex.get(event.slot)!.add(event.job)

    log.info('Enqueued job', { 
      job: event.job.slice(0, 8) + '...', 
      batch: event.batch.slice(0, 8) + '...', 
      slot: event.slot,
      ir_digest: event.ir_digest?.slice(0, 10) + '...',
      commitment: event.commitment?.slice(0, 10) + '...'
    })
    return job
  }

  /**
   * Get job by PDA
   */
  get_job(job_pda: string): QueuedJob | undefined {
    return this.jobs.get(job_pda)
  }

  /**
   * Get all jobs for a batch window
   */
  get_jobs_by_batch(batch_pda: string): QueuedJob[] {
    const job_pdas = this.batchIndex.get(batch_pda)
    if (!job_pdas) return []

    return Array.from(job_pdas)
      .map(pda => this.jobs.get(pda))
      .filter((job): job is QueuedJob => job !== undefined)
      .sort((a, b) => a.slot - b.slot) // Sort by submission slot
  }

  /**
   * Get jobs for a slot range (for batch execution planning)
   */
  get_jobs_by_slot_range(start_slot: number, end_slot: number): QueuedJob[] {
    const jobs: QueuedJob[] = []
    
    for (let slot = start_slot; slot <= end_slot; slot++) {
      const job_pdas = this.slotIndex.get(slot)
      if (job_pdas) {
        for (const pda of job_pdas) {
          const job = this.jobs.get(pda)
          if (job) jobs.push(job)
        }
      }
    }

    return jobs.sort((a, b) => a.slot - b.slot)
  }

  /**
   * Get queued jobs (ready for execution)
   */
  get_queued_jobs(): QueuedJob[] {
    return Array.from(this.jobs.values())
      .filter(job => job.status === 'queued')
      .sort((a, b) => a.slot - b.slot)
  }

  /**
   * Get executing jobs (currently being processed)
   * Includes both 'assigned' and 'executing' states
   */
  get_executing_jobs(): QueuedJob[] {
    return Array.from(this.jobs.values())
      .filter(job => job.status === 'assigned' || job.status === 'executing')
      .sort((a, b) => a.slot - b.slot)
  }

  /**
   * Get completed jobs
   */
  get_completed_jobs(): QueuedJob[] {
    return Array.from(this.jobs.values())
      .filter(job => job.status === 'completed')
      .sort((a, b) => (b.execution_completed_at || 0) - (a.execution_completed_at || 0))
  }

  /**
   * Get failed jobs
   */
  get_failed_jobs(): QueuedJob[] {
    return Array.from(this.jobs.values())
      .filter(job => job.status === 'failed')
      .sort((a, b) => (b.execution_completed_at || 0) - (a.execution_completed_at || 0))
  }

  /**
   * Update job status
   */
  update_job_status(
    job_pda: string, 
    status: JobStatus,
    executor?: string,
    result_handle?: string
  ): boolean {
    const job = this.jobs.get(job_pda)
    if (!job) return false

    job.status = status
    
    if (executor) job.executor = executor
    if (result_handle) job.result_handle = result_handle

    const now = Math.floor(Date.now() / 1000)
    if (status === 'executing' && !job.execution_started_at) {
      job.execution_started_at = now
    } else if ((status === 'completed' || status === 'failed') && !job.execution_completed_at) {
      job.execution_completed_at = now
    }

    log.info('Updated job status', { job: job_pda.slice(0, 8) + '...', status })
    return true
  }

  /**
   * Mark job as assigned to executor
   */
  assign_job(job_pda: string, executor: string): boolean {
    return this.update_job_status(job_pda, 'assigned', executor)
  }

  /**
   * Mark job as executing
   */
  start_execution(job_pda: string): boolean {
    return this.update_job_status(job_pda, 'executing')
  }

  /**
   * Complete job execution
   */
  complete_job(job_pda: string, result_handle?: string): boolean {
    return this.update_job_status(job_pda, 'completed', undefined, result_handle)
  }

  /**
   * Mark job as failed
   */
  fail_job(job_pda: string): boolean {
    return this.update_job_status(job_pda, 'failed')
  }

  /**
   * Get queue statistics
   */
  get_stats(): JobQueueStats {
    const jobs = Array.from(this.jobs.values())
    const queued = jobs.filter(j => j.status === 'queued')
    // Include both 'assigned' and 'executing' in executing_count
    // (assigned = claimed by executor, about to execute)
    const executing = jobs.filter(j => j.status === 'assigned' || j.status === 'executing')
    const completed = jobs.filter(j => j.status === 'completed')
    const failed = jobs.filter(j => j.status === 'failed')

    const queuedTimestamps = queued.map(j => j.queued_at)

    return {
      total_jobs: this.jobs.size,
      queued_count: queued.length,
      executing_count: executing.length,
      completed_count: completed.length,
      failed_count: failed.length,
      oldest_queued_timestamp: queuedTimestamps.length > 0 ? Math.min(...queuedTimestamps) : 0,
      newest_queued_timestamp: queuedTimestamps.length > 0 ? Math.max(...queuedTimestamps) : 0,
    }
  }

  /**
   * Get batch window summary
   */
  get_batch_window_summary(batch_pda: string, window_start_slot: number, window_end_slot: number): BatchWindowJobs {
    const jobs = this.get_jobs_by_batch(batch_pda)
    
    return {
      batch_pda,
      window_start_slot,
      window_end_slot,
      jobs,
      total_jobs: jobs.length,
    }
  }

  /**
   * Clear all jobs (use only in tests)
   */
  clear(): void {
    this.jobs.clear()
    this.batchIndex.clear()
    this.slotIndex.clear()
    log.warn('Cleared all jobs')
  }
}

// Export singleton
export const jobQueue = JobQueue.getInstance()

