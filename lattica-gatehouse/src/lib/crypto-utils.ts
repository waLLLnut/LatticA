/**
 * Cryptographic utility functions
 * Hash computation, CID generation, commitment calculation
 */

import crypto from 'crypto'
import bs58 from 'bs58'

/**
 * Compute SHA256 hash and return as 0x-prefixed hex string
 */
export function sha256Hex(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return '0x' + crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Convert 0x-prefixed hex string to 32-byte Buffer
 * @throws Error if not exactly 64 hex characters (32 bytes)
 */
export function hex32(hexString: string): Buffer {
  const hex = hexString.startsWith('0x') ? hexString.slice(2) : hexString
  if (hex.length !== 64) {
    throw new Error(`Expected 32-byte hex string, got ${hex.length / 2} bytes`)
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Canonical JSON stringification (sorted keys)
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null'
  if (typeof obj !== 'object') return JSON.stringify(obj)
  
  const sorted = Object.keys(obj as Record<string, unknown>)
    .sort()
    .reduce((acc, key) => {
      acc[key] = (obj as Record<string, unknown>)[key]
      return acc
    }, {} as Record<string, unknown>)
  
  return JSON.stringify(sorted)
}

/**
 * Calculate CID set ID from array of CID handles
 * cid_set_id = sha256(cid_handle_1 || cid_handle_2 || ...)
 */
export function calcCidSetId(cidHandles: string[]): string {
  const buffers = cidHandles.map(b58str => Buffer.from(bs58.decode(b58str)))
  const concatenated = Buffer.concat(buffers)
  return sha256Hex(concatenated)
}

/**
 * Calculate policy hash from policy context
 */
export function calcPolicyHash(policyCtx: unknown): string {
  return sha256Hex(canonicalJson(policyCtx))
}

/**
 * Calculate domain hash
 * domain_hash = sha256(chain_id || program || cpk_id || epoch)
 */
export function calcDomainHash(domain: {
  chain_id: string
  gatekeeper_program: string
  cpk_id: string
  key_epoch: number
}): string {
  return sha256Hex(Buffer.concat([
    Buffer.from(domain.chain_id, 'utf8'),
    Buffer.from(domain.gatekeeper_program, 'utf8'),
    Buffer.from(domain.cpk_id, 'utf8'),
    Buffer.from(String(domain.key_epoch), 'utf8'),
  ]))
}

/**
 * Calculate commitment hash
 * commitment = sha256(cid_set_id || ir_digest || policy_hash || domain_hash || nonce)
 */
export function calcCommitment(
  cidSetId: string,
  irDigest: string,
  policyHash: string,
  domainHash: string,
  nonce: string,
): string {
  return sha256Hex(Buffer.concat([
    hex32(cidSetId),
    hex32(irDigest),
    hex32(policyHash),
    hex32(domainHash),
    hex32(nonce),
  ]))
}

/**
 * Generate random nonce (32 bytes)
 */
export function generateNonce(): string {
  return sha256Hex(crypto.randomBytes(32))
}

/**
 * Validate hex string format (0x + 64 hex chars = 32 bytes)
 */
export function isValidHex32(hexString: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(hexString)
}

