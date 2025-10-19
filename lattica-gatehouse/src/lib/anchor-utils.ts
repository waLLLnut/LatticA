/**
 * Anchor Program Utilities
 * 
 * Provides instruction discriminators and account discriminators
 * extracted from the Gatekeeper program IDL.
 * 
 * @see src/idl/lattica_gatekeeper.json
 */

/**
 * Instruction discriminators
 * 
 * These are the 8-byte prefixes for instruction data.
 * Extracted from IDL to ensure compatibility with deployed program.
 * 
 * **Important**: Do not regenerate these values. Always use IDL values.
 */
export const INSTRUCTION_DISCRIMINATORS = {
  /**
   * init_config instruction
   * @see IDL line 170-183
   */
  init_config: Buffer.from([23, 235, 115, 232, 168, 96, 1, 231]),

  /**
   * register_cid_handle instruction
   * @see IDL line 222-236
   */
  register_cid_handle: Buffer.from([184, 27, 198, 16, 221, 15, 10, 70]),

  /**
   * request_reveal_public instruction
   * @see IDL line 376-389
   */
  request_reveal_public: Buffer.from([108, 113, 55, 103, 93, 20, 214, 155]),

  /**
   * request_reveal_private instruction
   * @see IDL line 302-315
   */
  request_reveal_private: Buffer.from([163, 171, 151, 48, 120, 103, 84, 83]),

  /**
   * submit_job instruction
   * @see IDL line 450-464
   */
  submit_job: Buffer.from([250, 129, 161, 132, 254, 161, 34, 107]),

  /**
   * commit_batch instruction
   * @see IDL line 11-24
   */
  commit_batch: Buffer.from([27, 234, 100, 224, 134, 31, 168, 142]),

  /**
   * finalize_batch instruction
   * @see IDL line 106-119
   */
  finalize_batch: Buffer.from([255, 211, 130, 81, 161, 239, 27, 11]),
} as const

/**
 * Account discriminators
 * 
 * These are the 8-byte prefixes for account data.
 * Used to identify account types when parsing on-chain data.
 * 
 * @see IDL line 560-626
 */
export const ACCOUNT_DISCRIMINATORS = {
  /**
   * Config account
   * @see IDL line 588-599
   */
  Config: Buffer.from([155, 12, 170, 224, 30, 250, 204, 130]),

  /**
   * CidHandle account
   * @see IDL line 575-586
   */
  CidHandle: Buffer.from([125, 74, 86, 150, 54, 134, 156, 175]),

  /**
   * Job account
   * @see IDL line 601-612
   */
  Job: Buffer.from([75, 124, 80, 203, 161, 180, 202, 80]),

  /**
   * BatchResult account
   * @see IDL line 562-573
   */
  BatchResult: Buffer.from([8, 213, 249, 51, 146, 73, 132, 225]),

  /**
   * RevealRequest account
   * @see IDL line 614-625
   */
  RevealRequest: Buffer.from([251, 104, 156, 107, 112, 171, 15, 160]),
} as const

/**
 * Program ID
 */
export const GATEKEEPER_PROGRAM_ID = 'GateF9qDULEJRgt6m1prkmUWrEXGVhDzYCgCJtGtnwu9'

/**
 * Get instruction discriminator by name
 */
export function getInstructionDiscriminator(name: keyof typeof INSTRUCTION_DISCRIMINATORS): Buffer {
  const discriminator = INSTRUCTION_DISCRIMINATORS[name]
  if (!discriminator) {
    throw new Error(`Unknown instruction: ${name}`)
  }
  return Buffer.from(discriminator)
}

/**
 * Get account discriminator by name
 */
export function getAccountDiscriminator(name: keyof typeof ACCOUNT_DISCRIMINATORS): Buffer {
  const discriminator = ACCOUNT_DISCRIMINATORS[name]
  if (!discriminator) {
    throw new Error(`Unknown account type: ${name}`)
  }
  return Buffer.from(discriminator)
}

