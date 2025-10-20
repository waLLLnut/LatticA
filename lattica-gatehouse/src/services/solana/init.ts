/**
 * Solana services initialization
 * Automatically starts EventListener when server starts
 */

import { createLogger } from '@/lib/logger'
import { getEventListener } from './event-listener'

const log = createLogger('SolanaInit')
let isInitialized = false

/**
 * Initialize Solana event listener
 * Safe to call multiple times (idempotent)
 */
export async function initializeSolanaServices(): Promise<void> {
  if (isInitialized) {
    log.info('Services already initialized')
    return
  }

  try {
    log.info('Initializing Solana services...')
    
    // Start event listener
    const listener = getEventListener()
    await listener.start()
    
    isInitialized = true
    log.info('Solana services initialized successfully')
  } catch (error) {
    log.error('Failed to initialize Solana services', error)
    throw error
  }
}

/**
 * Shutdown Solana services (for graceful shutdown)
 */
export async function shutdownSolanaServices(): Promise<void> {
  if (!isInitialized) {
    return
  }

  try {
    log.info('Shutting down Solana services...')
    
    const listener = getEventListener()
    await listener.stop()
    
    isInitialized = false
    log.info('Services shut down')
  } catch (error) {
    log.error('Error during shutdown', error)
  }
}

/**
 * Check if services are initialized
 */
export function isServicesInitialized(): boolean {
  return isInitialized
}

