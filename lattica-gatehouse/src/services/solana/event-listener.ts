/**
 * Gatekeeper Event Listener
 * 
 * Subscribes to on-chain events from the Gatekeeper program via WebSocket
 * and processes them to update internal state and job queue.
 * 
 * Key responsibilities:
 * - Listen to program logs in real-time
 * - Parse and validate Anchor events
 * - Move CIDs from pending → confirmed storage
 * - Enqueue jobs for execution (only after on-chain confirmation)
 * 
 * @see lattica-gatekeeper/programs/lattica-gatekeeper/src/lib.rs
 */

import { Connection, PublicKey, Logs } from '@solana/web3.js'
import { getConnectionManager } from './connection-manager'
import { logParser } from './log-parser'
import { ciphertextStore } from '../storage/ciphertext-store'
import { pendingCiphertextStore } from '../storage/pending-store'
import { registrationLog } from '../storage/registration-log'
import { jobQueue } from '../queue/job-queue'
import { createLogger } from '@/lib/logger'
import type { 
  SolanaEvent, 
  CidHandleRegisteredEvent, 
  JobSubmittedEvent, 
  BatchPostedEvent,
  BatchFinalizedEvent,
  RevealRequestedEvent,
  EventListenerState,
  EventProcessingResult 
} from '@/types/events'

const log = createLogger('EventListener')

// Declare global type for TypeScript
declare global {
  var __eventListener: GatekeeperEventListener | undefined
}

/**
 * Gatekeeper Event Listener
 * Singleton service that manages WebSocket subscription to Solana program events
 *
 * Uses globalThis to ensure singleton persistence across Next.js hot reloads
 */
export class GatekeeperEventListener {
  private connection: Connection
  private programId: PublicKey
  private subscriptionId: number | null = null
  private state: EventListenerState
  private processedTxSignatures: Set<string>
  private processedJobPDAs: Set<string>  // Deduplicate by job PDA

  private constructor() {
    const manager = getConnectionManager()
    this.connection = manager.getConnection()
    this.programId = manager.getProgramId()
    this.processedTxSignatures = new Set()
    this.processedJobPDAs = new Set()
    this.state = {
      is_running: false,
      last_processed_slot: 0,
      total_events_processed: 0,
      errors_count: 0,
    }
    log.debug('GatekeeperEventListener instance created')
  }

  static getInstance(): GatekeeperEventListener {
    // Use globalThis to persist across hot reloads
    if (!globalThis.__eventListener) {
      globalThis.__eventListener = new GatekeeperEventListener()
    }
    return globalThis.__eventListener
  }

  /**
   * Start listening to on-chain events
   * 
   * Subscribes to program logs and processes them in real-time.
   * Safe to call multiple times (idempotent).
   */
  async start(): Promise<void> {
    if (this.state.is_running) {
      log.warn('Already running')
      return
    }

    log.info('Starting event listener', {
      program: this.programId.toBase58(),
    })

    try {
      this.subscriptionId = this.connection.onLogs(
        this.programId,
        (logs: Logs, ctx) => {
          this.handleLogs(logs, ctx.slot).catch(error => {
            log.error('Error handling logs', error, {
              tx: logs.signature,
              slot: ctx.slot,
            })
            this.state.errors_count++
          })
        },
        'confirmed'
      )

      this.state.is_running = true
      this.state.connected_at = Math.floor(Date.now() / 1000)
      
      log.info('Event listener started successfully', {
        subscription_id: this.subscriptionId,
      })
    } catch (error) {
      log.error('Failed to start event listener', error)
      throw error
    }
  }

  /**
   * Stop listening to events
   * 
   * Unsubscribes from program logs and cleans up resources.
   */
  async stop(): Promise<void> {
    if (!this.state.is_running) {
      log.warn('Not running')
      return
    }

    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId)
      this.subscriptionId = null
    }

    this.state.is_running = false
    log.info('Event listener stopped')
  }

  /**
   * Get current listener state
   */
  getState(): EventListenerState {
    return { ...this.state }
  }

  /**
   * Handle logs from a transaction
   * 
   * @param logs - Transaction logs from Solana
   * @param slot - Slot number when tx was processed
   */
  private async handleLogs(logs: Logs, slot: number): Promise<void> {
    // Prevent duplicate processing
    if (this.processedTxSignatures.has(logs.signature)) {
      return
    }
    this.processedTxSignatures.add(logs.signature)

    // Cleanup old signatures (keep last 1000)
    if (this.processedTxSignatures.size > 1000) {
      const toDelete = Array.from(this.processedTxSignatures).slice(0, 100)
      toDelete.forEach(sig => this.processedTxSignatures.delete(sig))
    }

    // Get block time
    let blockTime: number
    try {
      const blockTimeResult = await this.connection.getBlockTime(slot)
      blockTime = blockTimeResult || Math.floor(Date.now() / 1000)
    } catch (error) {
      log.warn('Failed to get block time, using current time', {
        slot,
        error: error instanceof Error ? error.message : String(error),
      })
      blockTime = Math.floor(Date.now() / 1000)
    }

    // Parse events from logs
    const events = logParser.parseEvents({
      program: this.programId.toBase58(),
      logs: logs.logs,
      slot,
      signature: logs.signature,
      blockTime,
    })

    if (events.length === 0) return

    log.info(`Received ${events.length} event(s)`, {
      tx: logs.signature.slice(0, 8) + '...',
      slot,
    })

    // Process each event
    for (const event of events) {
      const result = await this.processEvent(event)
      if (result.success) {
        this.state.total_events_processed++
        this.state.last_processed_slot = Math.max(this.state.last_processed_slot, slot)
        this.state.last_event_at = Math.floor(Date.now() / 1000)
      } else {
        this.state.errors_count++
        log.error('Event processing failed', new Error(result.error), {
          event_type: result.event_type,
          tx: result.tx_signature,
        })
      }
    }
  }

  /**
   * Process a single event
   * 
   * Routes the event to the appropriate handler based on event type.
   * 
   * @param event - Parsed Solana event
   * @returns Processing result with success status
   */
  private async processEvent(event: SolanaEvent): Promise<EventProcessingResult> {
    const result: EventProcessingResult = {
      success: false,
      event_type: event.event_type,
      tx_signature: event.tx_signature,
      processed_at: Math.floor(Date.now() / 1000),
    }

    try {
      switch (event.event_type) {
        case 'CidHandleRegistered':
          await this.handleCidHandleRegistered(event)
          result.success = true
          break

        case 'JobSubmitted':
          await this.handleJobSubmitted(event)
          result.success = true
          break

        case 'BatchPosted':
          await this.handleBatchPosted(event)
          result.success = true
          break

        case 'BatchFinalized':
          await this.handleBatchFinalized(event)
          result.success = true
          break

        case 'RevealRequested':
          await this.handleRevealRequested(event)
          result.success = true
          break

        default:
          result.error = `Unknown event type`
          const _exhaustiveCheck: never = event
          return _exhaustiveCheck
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error)
    }

    return result
  }

  /**
   * Handle CidHandleRegistered event
   *
   * Workflow:
   * 1. Verify CID account exists on-chain (with retry)
   * 2. Retrieve pending ciphertext data
   * 3. Move from PendingStore → CiphertextStore (confirmed)
   * 4. Update RegistrationLog status
   *
   * @param event - CidHandleRegistered event data
   */
  private async handleCidHandleRegistered(event: CidHandleRegisteredEvent): Promise<void> {
    log.info('Processing CidHandleRegistered', {
      cid: event.cid.slice(0, 8) + '...',
      owner: event.owner.slice(0, 8) + '...',
    })

    // 1. Verify account exists on-chain with retry
    try {
      await this.verifyCidAccountWithRetry(event.cid)
    } catch (error) {
      log.error('CID account verification failed after retries', error, { cid: event.cid })
      throw error
    }

    // 2. Get pending data (if available)
    const pending = pendingCiphertextStore.get(event.cid)

    // 3. Store CID in confirmed storage
    // If pending data is available, use it. Otherwise, create minimal record from event.
    try {
      if (pending) {
        // Full data available from pending store
        ciphertextStore.store_ciphertext(
          pending.cid_pda,
          pending.ciphertext,
          pending.ciphertext_hash,
          pending.enc_params,
          pending.policy_ctx,
          pending.policy_hash,
          pending.owner,
          pending.storage_ref,
          pending.provenance,
        )

        // Remove from pending
        pendingCiphertextStore.remove(event.cid)

        log.info('CID confirmed with full data from pending store', {
          cid: event.cid.slice(0, 8) + '...',
          slot: event.slot,
        })
      } else {
        // No pending data (server restart or late registration)
        // Create minimal record from event data
        log.warn('No pending data found, creating minimal record from event', {
          cid: event.cid,
        })

        ciphertextStore.store_ciphertext(
          event.cid,
          { note: 'Ciphertext data not available - registered before server start' },
          event.ciphertext_hash,
          { scheme: 'unknown' },  // Minimal enc_params
          { note: 'Policy context not available' },  // Minimal policy_ctx
          event.policy_hash,
          event.owner,
          `ipfs://Qm${event.ciphertext_hash.slice(4, 50)}`,  // Reconstructed storage_ref
          'on-chain-event',  // Mark as recovered from event
        )

        log.info('CID confirmed with minimal data from event', {
          cid: event.cid.slice(0, 8) + '...',
          slot: event.slot,
          note: 'Ciphertext and policy details not available',
        })
      }

      // Update verification status (common for both paths)
      ciphertextStore.update_verification(
        event.cid,
        'confirmed',
        event.tx_signature,
        event.slot
      )

      // Update registration log (if exists)
      try {
        registrationLog.update_entry_status(
          event.cid,
          'confirmed',
          event.tx_signature
        )
      } catch {
        // Registration log entry might not exist if server was restarted
        log.debug('Registration log entry not found (expected if server was restarted)', {
          cid: event.cid,
        })
      }
    } catch (error) {
      log.error('Failed to confirm CID', error, { cid: event.cid })
      throw error
    }
  }

  /**
   * Handle JobSubmitted event
   * 
   * Workflow:
   * 1. Verify job account exists on-chain
   * 2. Validate all CID handles are confirmed
   * 3. Enqueue job for execution
   * 
   * @param event - JobSubmitted event data
   */
  private async handleJobSubmitted(event: JobSubmittedEvent): Promise<void> {
    log.info('Processing JobSubmitted', {
      job: event.job.slice(0, 8) + '...',
      batch: event.batch.slice(0, 8) + '...',
      cid_count: event.cid_handles.length,
      slot: event.slot,
      tx: event.tx_signature.slice(0, 8) + '...',
    })

    // Deduplicate by job PDA (prevent duplicate processing of same job)
    if (this.processedJobPDAs.has(event.job)) {
      log.debug('Job already processed, skipping', { job: event.job })
      return
    }
    this.processedJobPDAs.add(event.job)

    // Cleanup old job PDAs (keep last 1000)
    if (this.processedJobPDAs.size > 1000) {
      const toDelete = Array.from(this.processedJobPDAs).slice(0, 100)
      toDelete.forEach(pda => this.processedJobPDAs.delete(pda))
    }

    // 1. Verify job account exists on-chain with retry
    try {
      await this.verifyJobAccountWithRetry(event.job)
    } catch (error) {
      log.error('Job account verification failed after retries', error, { job: event.job })
      throw error
    }

    // 2. TODO: Validate CID handles are confirmed
    // Currently skipped as it requires fetching and parsing multiple accounts
    // Will implement after adding batch account data fetching

    // 3. Enqueue job for execution
    try {
      jobQueue.enqueue(event)
      log.info('Job enqueued for execution', {
        job: event.job.slice(0, 8) + '...',
        cid_count: event.cid_handles.length,
        slot: event.slot,
      })
    } catch (error) {
      log.error('Failed to enqueue job', error, { job: event.job })
      throw error
    }
  }

  /**
   * Verify CID account exists on-chain with retry logic
   * Retries up to 3 times with exponential backoff
   */
  private async verifyCidAccountWithRetry(cidPda: string, maxRetries = 3): Promise<void> {
    const delays = [500, 1000, 2000] // ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const accountInfo = await this.connection.getAccountInfo(
          new PublicKey(cidPda),
          'confirmed' // Use confirmed commitment for consistency with event subscription
        )

        if (accountInfo) {
          log.debug('CID account verified on-chain', {
            cid: cidPda.slice(0, 8) + '...',
            attempt: attempt + 1
          })
          return
        }

        // Account not found, retry
        if (attempt < maxRetries - 1) {
          log.warn('CID account not found, retrying...', {
            cid: cidPda.slice(0, 8) + '...',
            attempt: attempt + 1,
            next_retry_ms: delays[attempt]
          })
          await new Promise(resolve => setTimeout(resolve, delays[attempt]))
        }
      } catch (error) {
        if (attempt < maxRetries - 1) {
          log.warn('CID account fetch error, retrying...', {
            error,
            cid: cidPda.slice(0, 8) + '...',
            attempt: attempt + 1,
            next_retry_ms: delays[attempt]
          })
          await new Promise(resolve => setTimeout(resolve, delays[attempt]))
        } else {
          throw error
        }
      }
    }

    throw new Error(`CID account not found on-chain after ${maxRetries} attempts: ${cidPda}`)
  }

  /**
   * Verify job account exists on-chain with retry logic
   * Retries up to 3 times with exponential backoff
   */
  private async verifyJobAccountWithRetry(jobPda: string, maxRetries = 3): Promise<void> {
    const delays = [500, 1000, 2000] // ms

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const accountInfo = await this.connection.getAccountInfo(
          new PublicKey(jobPda),
          'confirmed' // Use confirmed commitment for faster response
        )

        if (accountInfo) {
          log.debug('Job account verified on-chain', {
            job: jobPda.slice(0, 8) + '...',
            attempt: attempt + 1
          })
          return
        }

        // Account not found, retry
        if (attempt < maxRetries - 1) {
          log.warn('Job account not found, retrying...', {
            job: jobPda.slice(0, 8) + '...',
            attempt: attempt + 1,
            next_retry_ms: delays[attempt]
          })
          await new Promise(resolve => setTimeout(resolve, delays[attempt]))
        }
      } catch (error) {
        if (attempt < maxRetries - 1) {
          log.warn('Job account fetch error, retrying...', {
            error,
            job: jobPda.slice(0, 8) + '...',
            attempt: attempt + 1,
            next_retry_ms: delays[attempt]
          })
          await new Promise(resolve => setTimeout(resolve, delays[attempt]))
        } else {
          throw error
        }
      }
    }

    throw new Error(`Job account not found on-chain after ${maxRetries} attempts: ${jobPda}`)
  }

  /**
   * Handle BatchPosted event
   * 
   * Logs the event for monitoring. Batch execution tracking will be
   * implemented when challenge/verification logic is added.
   * 
   * @param event - BatchPosted event data
   */
  private async handleBatchPosted(event: BatchPostedEvent): Promise<void> {
    log.info('BatchPosted event received', {
      batch: event.batch.slice(0, 8) + '...',
      window_start: event.window_start_slot,
      window_end: event.window_end_slot,
      processed_until: event.processed_until_slot,
    })
    
    // TODO: Track batch results for challenge/verification
  }

  /**
   * Handle BatchFinalized event
   * 
   * Logs the event for monitoring. Will be used to trigger job result
   * publication and cleanup once finalization logic is implemented.
   * 
   * @param event - BatchFinalized event data
   */
  private async handleBatchFinalized(event: BatchFinalizedEvent): Promise<void> {
    log.info('BatchFinalized event received', {
      batch: event.batch.slice(0, 8) + '...',
      window_start: event.window_start_slot,
      finalized_slot: event.finalized_slot,
    })
    
    // TODO: Publish finalized results and cleanup
  }

  /**
   * Handle RevealRequested event
   * 
   * Logs the event for monitoring. Decrypt workflow (KMS coordination)
   * will be implemented separately.
   * 
   * @param event - RevealRequested event data
   */
  private async handleRevealRequested(event: RevealRequestedEvent): Promise<void> {
    log.info('RevealRequested event received', {
      handle: event.handle.slice(0, 16) + '...',
      requester: event.requester.slice(0, 8) + '...',
      is_public: event.is_public,
    })
    
    // TODO: Coordinate with KMS for threshold decryption
  }
}

// Export singleton getter
export const getEventListener = () => GatekeeperEventListener.getInstance()
