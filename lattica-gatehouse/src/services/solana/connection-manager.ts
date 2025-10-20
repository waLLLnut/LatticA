/**
 * Solana Connection Manager
 * Manages WebSocket connections with auto-reconnect
 */

import { Connection, PublicKey } from '@solana/web3.js'
import { createLogger } from '@/lib/logger'

const log = createLogger('ConnectionManager')

interface ConnectionConfig {
  rpc_url: string
  ws_url?: string
  commitment?: 'processed' | 'confirmed' | 'finalized'
  max_reconnect_attempts?: number
  reconnect_delay_ms?: number
}

const DEFAULT_CONFIG: ConnectionConfig = {
  rpc_url: process.env.NEXT_PUBLIC_SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  commitment: 'confirmed',
  max_reconnect_attempts: 10,
  reconnect_delay_ms: 5000,
}

export class ConnectionManager {
  private static instance: ConnectionManager
  private connection: Connection
  private config: ConnectionConfig
  private reconnectAttempts: number = 0
  private isConnected: boolean = false

  private constructor(config: ConnectionConfig = DEFAULT_CONFIG) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.connection = new Connection(
      this.config.rpc_url,
      {
        commitment: this.config.commitment,
        wsEndpoint: this.config.ws_url,
      }
    )
    this.isConnected = true
    log.info('Connected to Solana', { rpc: this.config.rpc_url })
  }

  static getInstance(config?: ConnectionConfig): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager(config)
    }
    return ConnectionManager.instance
  }

  /**
   * Get the connection instance
   */
  getConnection(): Connection {
    return this.connection
  }

  /**
   * Check if connected
   */
  isConnectionHealthy(): boolean {
    return this.isConnected
  }

  /**
   * Reconnect to Solana
   */
  async reconnect(): Promise<void> {
    if (this.reconnectAttempts >= (this.config.max_reconnect_attempts || 10)) {
      log.error('Max reconnect attempts reached')
      throw new Error('Max reconnect attempts reached')
    }

    this.reconnectAttempts++
    log.info('Reconnecting...', { attempt: this.reconnectAttempts })

    await new Promise(resolve => setTimeout(resolve, this.config.reconnect_delay_ms || 5000))

    try {
      this.connection = new Connection(
        this.config.rpc_url,
        {
          commitment: this.config.commitment,
          wsEndpoint: this.config.ws_url,
        }
      )
      this.isConnected = true
      this.reconnectAttempts = 0
      log.info('Reconnected successfully')
    } catch (error) {
      log.error('Reconnect failed', error)
      this.isConnected = false
      throw error
    }
  }

  /**
   * Get program ID
   */
  getProgramId(): PublicKey {
    const programIdStr = process.env.NEXT_PUBLIC_GATEKEEPER_PROGRAM_ID || 'GateF9qDULEJRgt6m1prkmUWrEXGVhDzYCgCJtGtnwu9'
    return new PublicKey(programIdStr)
  }

  /**
   * Close connection (for graceful shutdown)
   */
  close(): void {
    this.isConnected = false
    log.info('Connection closed')
  }
}

// Export singleton getter
export const getConnectionManager = () => ConnectionManager.getInstance()

