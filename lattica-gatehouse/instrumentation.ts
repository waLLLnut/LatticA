/**
 * Next.js Instrumentation
 * Runs once when the server starts
 * Used to initialize Solana event listener
 */
import { createLogger } from '@/lib/logger'

const log = createLogger('Instrumentation')

export async function register() {
  // Only run on server side
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    log.info('Server starting, initializing Solana services...')

    try {
      const { initializeSolanaServices } = await import('@/services/solana/init')
      await initializeSolanaServices()
      log.info('Solana services ready')
    } catch (error) {
      log.error('Failed to initialize Solana services', error)
      log.warn('Services can be manually started via POST /api/init')
    }
  }
}

