/**
 * Storage service configuration and types
 */

export interface StorageConfig {
  MAX_CIDS_PER_REQUEST: number
  MAX_CIPHERTEXT_SIZE: number      // bytes
  MAX_STORE_SIZE: number           // max number of CIDs
  PENDING_EXPIRY_SECONDS: number   // seconds before pending expires
  CLEANUP_INTERVAL_MS: number      // cleanup job interval
}

export const DEFAULT_STORAGE_CONFIG: StorageConfig = {
  MAX_CIDS_PER_REQUEST: 16,
  MAX_CIPHERTEXT_SIZE: 1024 * 1024,      // 1MB
  MAX_STORE_SIZE: 10000,                 // 10k CIDs
  PENDING_EXPIRY_SECONDS: 300,           // 5 minutes
  CLEANUP_INTERVAL_MS: 60000,            // 1 minute
}

export interface StoreStats {
  total_cids: number
  pending_count: number
  confirmed_count: number
  expired_count: number
  oldest_entry_timestamp: number
  newest_entry_timestamp: number
}

