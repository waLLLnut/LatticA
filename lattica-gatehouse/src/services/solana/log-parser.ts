/**
 * Solana Log Parser
 * Parses Anchor program events from transaction logs
 * 
 * Anchor events are emitted as "Program data: <base64>" where:
 * - First 8 bytes: discriminator (sha256("event:EventName")[0..8])
 * - Remaining bytes: Borsh-encoded event data
 * 
 * @see lattica-gatekeeper/programs/lattica-gatekeeper/src/lib.rs (Events section)
 */

import bs58 from 'bs58'
import type { 
  SolanaEvent, 
  CidHandleRegisteredEvent, 
  JobSubmittedEvent, 
  BatchPostedEvent, 
  BatchFinalizedEvent,
  RevealRequestedEvent 
} from '@/types/events'
import { createLogger } from '@/lib/logger'

const log = createLogger('LogParser')

/**
 * Anchor event discriminators
 * Extracted from IDL (lattica_gatekeeper.json)
 * 
 * These are the actual discriminators used by the deployed program.
 * Do not regenerate - always use values from IDL to ensure compatibility.
 * 
 * @see src/idl/lattica_gatekeeper.json (events section)
 */
const EVENT_DISCRIMINATORS = {
  // IDL line 655-665
  CidHandleRegistered: Buffer.from([140, 222, 163, 76, 56, 94, 99, 100]),
  // IDL line 667-679
  JobSubmitted: Buffer.from([129, 204, 35, 127, 38, 50, 131, 248]),
  // IDL line 641-653
  BatchPosted: Buffer.from([154, 80, 3, 154, 143, 131, 227, 239]),
  // IDL line 629-640
  BatchFinalized: Buffer.from([27, 17, 160, 189, 95, 165, 89, 191]),
  // IDL line 680-692
  RevealRequested: Buffer.from([177, 216, 27, 24, 210, 88, 74, 198]),
}

interface ParsedLog {
  program: string
  logs: string[]
  slot: number
  signature: string
  blockTime: number | null
}

export class LogParser {
  /**
   * Parse events from transaction logs
   */
  parseEvents(parsedLog: ParsedLog): SolanaEvent[] {
    const events: SolanaEvent[] = []
    let logIndex = 0

    for (const logLine of parsedLog.logs) {
      // Anchor emits events as: "Program data: <base64>"
      if (logLine.includes('Program data: ')) {
        const base64Data = logLine.split('Program data: ')[1]?.trim()
        if (!base64Data) continue

        try {
          const data = Buffer.from(base64Data, 'base64')
          const event = this.decodeEvent(
            data,
            parsedLog.slot,
            parsedLog.signature,
            parsedLog.blockTime || Math.floor(Date.now() / 1000),
            logIndex
          )
          if (event) {
            events.push(event)
            log.debug('Parsed event', {
              event_type: event.event_type,
              tx: parsedLog.signature.slice(0, 8),
            })
          }
        } catch (error) {
          log.error('Failed to decode event', error, {
            tx: parsedLog.signature,
            log_line: logLine.slice(0, 100),
          })
        }
      }
      logIndex++
    }

    return events
  }

  /**
   * Decode event from raw data
   */
  private decodeEvent(
    data: Buffer,
    slot: number,
    signature: string,
    blockTime: number,
    logIndex: number
  ): SolanaEvent | null {
    if (data.length < 8) {
      log.warn('Event data too short', { length: data.length })
      return null
    }

    const discriminator = data.slice(0, 8)
    const eventData = data.slice(8)

    // Check discriminator and decode accordingly
    if (discriminator.equals(EVENT_DISCRIMINATORS.CidHandleRegistered)) {
      return this.decodeCidHandleRegistered(eventData, slot, signature, blockTime, logIndex)
    } else if (discriminator.equals(EVENT_DISCRIMINATORS.JobSubmitted)) {
      return this.decodeJobSubmitted(eventData, slot, signature, blockTime, logIndex)
    } else if (discriminator.equals(EVENT_DISCRIMINATORS.BatchPosted)) {
      return this.decodeBatchPosted(eventData, slot, signature, blockTime, logIndex)
    } else if (discriminator.equals(EVENT_DISCRIMINATORS.BatchFinalized)) {
      return this.decodeBatchFinalized(eventData, slot, signature, blockTime, logIndex)
    } else if (discriminator.equals(EVENT_DISCRIMINATORS.RevealRequested)) {
      return this.decodeRevealRequested(eventData, slot, signature, blockTime, logIndex)
    }

    log.debug('Unknown event discriminator', {
      discriminator: discriminator.toString('hex'),
    })
    return null
  }

  /**
   * Decode CidHandleRegistered event
   * 
   * Rust struct (lib.rs:408-414):
   * ```rust
   * pub struct CidHandleRegistered {
   *     pub cid: Pubkey,                 // 32 bytes
   *     pub owner: Pubkey,               // 32 bytes
   *     pub ciphertext_hash: [u8; 32],   // 32 bytes
   *     pub policy_hash: [u8; 32],       // 32 bytes
   *     pub slot: u64,                   // 8 bytes
   * }
   * ```
   */
  private decodeCidHandleRegistered(
    data: Buffer,
    slot: number,
    signature: string,
    blockTime: number,
    logIndex: number
  ): CidHandleRegisteredEvent | null {
    try {
      if (data.length < 136) {
        log.warn('CidHandleRegistered data too short', { length: data.length })
        return null
      }

      const cid = this.bufferToPubkey(data.slice(0, 32))
      const owner = this.bufferToPubkey(data.slice(32, 64))
      const ciphertext_hash = this.bufferToHex(data.slice(64, 96))
      const policy_hash = this.bufferToHex(data.slice(96, 128))
      // slot from event data (8 bytes at offset 128) - not used, we use tx slot

      return {
        event_type: 'CidHandleRegistered',
        cid,
        owner,
        ciphertext_hash,
        policy_hash,
        slot,
        tx_signature: signature,
        block_time: blockTime,
        log_index: logIndex,
      }
    } catch (error) {
      log.error('Failed to decode CidHandleRegistered', error)
      return null
    }
  }

  /**
   * Decode JobSubmitted event
   * 
   * Rust struct (lib.rs:417-426):
   * ```rust
   * pub struct JobSubmitted {
   *     pub job: Pubkey,                 // 32 bytes
   *     pub batch: Pubkey,               // 32 bytes
   *     pub cid_set_id: [u8; 32],        // 32 bytes
   *     pub cid_handles: Vec<Pubkey>,    // Vec: u32 len + n*32 bytes
   *     pub commitment: [u8; 32],        // 32 bytes
   *     pub ir_digest: [u8; 32],         // 32 bytes
   *     pub provenance: u8,              // 1 byte
   *     pub slot: u64,                   // 8 bytes
   * }
   * ```
   */
  private decodeJobSubmitted(
    data: Buffer,
    slot: number,
    signature: string,
    blockTime: number,
    logIndex: number
  ): JobSubmittedEvent | null {
    try {
      let offset = 0

      const job = this.bufferToPubkey(data.slice(offset, offset + 32))
      offset += 32

      const batch = this.bufferToPubkey(data.slice(offset, offset + 32))
      offset += 32

      const cid_set_id = this.bufferToHex(data.slice(offset, offset + 32))
      offset += 32

      // Decode Vec<Pubkey> (Borsh format: u32 length + items)
      const cid_handles_len = data.readUInt32LE(offset)
      offset += 4
      const cid_handles: string[] = []
      for (let i = 0; i < cid_handles_len; i++) {
        cid_handles.push(this.bufferToPubkey(data.slice(offset, offset + 32)))
        offset += 32
      }

      const commitment = this.bufferToHex(data.slice(offset, offset + 32))
      offset += 32

      const ir_digest = this.bufferToHex(data.slice(offset, offset + 32))
      offset += 32

      const provenance = data.readUInt8(offset)
      // offset += 1
      // slot at offset (8 bytes) - not used

      return {
        event_type: 'JobSubmitted',
        job,
        batch,
        cid_set_id,
        cid_handles,
        commitment,
        ir_digest,
        provenance,
        slot,
        tx_signature: signature,
        block_time: blockTime,
        log_index: logIndex,
      }
    } catch (error) {
      log.error('Failed to decode JobSubmitted', error)
      return null
    }
  }

  /**
   * Decode BatchPosted event
   * 
   * Rust struct (lib.rs:429-437):
   * ```rust
   * pub struct BatchPosted {
   *     pub batch: Pubkey,                    // 32 bytes
   *     pub window_start_slot: u64,           // 8 bytes
   *     pub commit_root: [u8; 32],            // 32 bytes
   *     pub result_commitment: [u8; 32],      // 32 bytes
   *     pub processed_until_slot: u64,        // 8 bytes
   *     pub posted_slot: u64,                 // 8 bytes
   *     pub window_end_slot: u64,             // 8 bytes
   * }
   * ```
   */
  private decodeBatchPosted(
    data: Buffer,
    slot: number,
    signature: string,
    blockTime: number,
    logIndex: number
  ): BatchPostedEvent | null {
    try {
      if (data.length < 128) {
        log.warn('BatchPosted data too short', { length: data.length })
        return null
      }

      let offset = 0
      const batch = this.bufferToPubkey(data.slice(offset, offset + 32))
      offset += 32

      const window_start_slot = Number(data.readBigUInt64LE(offset))
      offset += 8

      const commit_root = this.bufferToHex(data.slice(offset, offset + 32))
      offset += 32

      const result_commitment = this.bufferToHex(data.slice(offset, offset + 32))
      offset += 32

      const processed_until_slot = Number(data.readBigUInt64LE(offset))
      offset += 8

      const posted_slot = Number(data.readBigUInt64LE(offset))
      offset += 8

      const window_end_slot = Number(data.readBigUInt64LE(offset))

      return {
        event_type: 'BatchPosted',
        batch,
        window_start_slot,
        commit_root,
        result_commitment,
        processed_until_slot,
        posted_slot,
        window_end_slot,
        slot,
        tx_signature: signature,
        block_time: blockTime,
        log_index: logIndex,
      }
    } catch (error) {
      log.error('Failed to decode BatchPosted', error)
      return null
    }
  }

  /**
   * Decode BatchFinalized event
   * 
   * Rust struct (lib.rs:440-445):
   * ```rust
   * pub struct BatchFinalized {
   *     pub batch: Pubkey,                 // 32 bytes
   *     pub window_start_slot: u64,        // 8 bytes
   *     pub result_commitment: [u8; 32],   // 32 bytes
   *     pub finalized_slot: u64,           // 8 bytes
   * }
   * ```
   */
  private decodeBatchFinalized(
    data: Buffer,
    slot: number,
    signature: string,
    blockTime: number,
    logIndex: number
  ): BatchFinalizedEvent | null {
    try {
      if (data.length < 80) {
        log.warn('BatchFinalized data too short', { length: data.length })
        return null
      }

      let offset = 0
      const batch = this.bufferToPubkey(data.slice(offset, offset + 32))
      offset += 32

      const window_start_slot = Number(data.readBigUInt64LE(offset))
      offset += 8

      const result_commitment = this.bufferToHex(data.slice(offset, offset + 32))
      offset += 32

      const finalized_slot = Number(data.readBigUInt64LE(offset))

      return {
        event_type: 'BatchFinalized',
        batch,
        window_start_slot,
        result_commitment,
        finalized_slot,
        slot,
        tx_signature: signature,
        block_time: blockTime,
        log_index: logIndex,
      }
    } catch (error) {
      log.error('Failed to decode BatchFinalized', error)
      return null
    }
  }

  /**
   * Decode RevealRequested event
   * 
   * Rust struct (lib.rs:448-455):
   * ```rust
   * pub struct RevealRequested {
   *     pub handle: [u8; 32],                     // 32 bytes
   *     pub requester: Pubkey,                    // 32 bytes
   *     pub is_public: bool,                      // 1 byte
   *     pub user_session_pubkey: Option<[u8; 32]>, // 1 + 32 bytes
   *     pub domain_signature: Option<[u8; 64]>,    // 1 + 64 bytes
   *     pub slot: u64,                            // 8 bytes
   * }
   * ```
   */
  private decodeRevealRequested(
    data: Buffer,
    slot: number,
    signature: string,
    blockTime: number,
    logIndex: number
  ): RevealRequestedEvent | null {
    try {
      let offset = 0

      const handle = this.bufferToHex(data.slice(offset, offset + 32))
      offset += 32

      const requester = this.bufferToPubkey(data.slice(offset, offset + 32))
      offset += 32

      const is_public = data.readUInt8(offset) === 1
      offset += 1

      // Decode Option<[u8; 32]> for user_session_pubkey
      const has_session_key = data.readUInt8(offset) === 1
      offset += 1
      let user_session_pubkey: string | undefined
      if (has_session_key) {
        user_session_pubkey = this.bufferToHex(data.slice(offset, offset + 32))
        offset += 32
      }

      // Decode Option<[u8; 64]> for domain_signature
      const has_domain_sig = data.readUInt8(offset) === 1
      offset += 1
      let domain_signature: string | undefined
      if (has_domain_sig) {
        domain_signature = this.bufferToHex(data.slice(offset, offset + 64))
        // offset += 64
      }

      return {
        event_type: 'RevealRequested',
        handle,
        requester,
        is_public,
        user_session_pubkey,
        domain_signature,
        slot,
        tx_signature: signature,
        block_time: blockTime,
        log_index: logIndex,
      }
    } catch (error) {
      log.error('Failed to decode RevealRequested', error)
      return null
    }
  }

  /**
   * Convert buffer to base58 pubkey string
   */
  private bufferToPubkey(buffer: Buffer): string {
    return bs58.encode(buffer)
  }

  /**
   * Convert buffer to 0x-prefixed hex string
   */
  private bufferToHex(buffer: Buffer): string {
    return '0x' + buffer.toString('hex')
  }
}

// Export singleton
export const logParser = new LogParser()
