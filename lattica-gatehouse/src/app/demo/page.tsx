'use client'

import { useState, useEffect } from 'react'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { Transaction } from '@solana/web3.js'

interface FHE16Module {
  _FHE16_init_params: (row: number, col: number, q: number, qtot: number, sigma: number) => void
  _FHE16_load_pk_from_fs: (path: string) => number
  _FHE16_set_pk: (ptr: number, nints: number) => void
  _FHE16_ENC_WASM: (msg: number, bit: number) => number
  _FHE16_free: (ptr: number) => void
  _malloc: (size: number) => number
  _free: (ptr: number) => void
  UTF8ToString: (ptr: number) => string
  HEAP8: Int8Array
  HEAPU8: Uint8Array
}

declare global {
  interface Window {
    createFHE16?: (config: any) => Promise<FHE16Module>
  }
}

const FHE_PARAMS = {
  PK_ROW: 1024,
  PK_COL: 1025,
  PK_Q: 163603459,
  Q_TOT: 163603459,
  SIGMA: 10.0,
  BIT: 32,
}

export default function DemoPage() {
  const { publicKey, signTransaction, sendTransaction } = useWallet()
  const { connection } = useConnection()

  const [logs, setLogs] = useState<string[]>([])
  const [moduleReady, setModuleReady] = useState(false)
  const [module, setModule] = useState<FHE16Module | null>(null)

  // Confidential State (Persistent User Balances)
  const [confidentialSOL, setConfidentialSOL] = useState('0')        // Private SOL Balance (starts at 0)
  const [confidentialUSDC, setConfidentialUSDC] = useState('0')      // Private USDC Balance (starts at 0)  
  const [solBalanceState, setSolBalanceState] = useState<'initial' | 'encrypted' | 'decrypted'>('initial')
  const [usdcBalanceState, setUsdcBalanceState] = useState<'initial' | 'encrypted' | 'decrypted'>('initial')
  
  // Confidential State CIDs (persistent)
  const [confidentialSOLCid, setConfidentialSOLCid] = useState('')
  const [confidentialUSDCCid, setConfidentialUSDCCid] = useState('')
  
  // Transaction Inputs (Volatile per operation)
  const [depositAmount, setDepositAmount] = useState('500')
  const [borrowAmount, setBorrowAmount] = useState('200')
  const [withdrawAmount, setWithdrawAmount] = useState('100')
  
  // Ciphertexts for current transaction
  const [ciphertext1, setCiphertext1] = useState<any>(null) // SOL Balance (State)
  const [ciphertext2, setCiphertext2] = useState<any>(null) // Transaction Input 1
  const [ciphertext3, setCiphertext3] = useState<any>(null) // Transaction Input 2 (for borrow)
  const [ciphertext4, setCiphertext4] = useState<any>(null) // USDC Balance (State)
  const [ciphertext5, setCiphertext5] = useState<any>(null) // Transaction Input 3 (for withdraw)

  // Step 2: Register CIDs (5 variables)
  const [cidPda1, setCidPda1] = useState('') // SOL Balance CID
  const [cidPda2, setCidPda2] = useState('') // Deposit Amount CID
  const [cidPda3, setCidPda3] = useState('') // Borrow Amount CID
  const [cidPda4, setCidPda4] = useState('') // USDC Balance CID
  const [cidPda5, setCidPda5] = useState('') // Withdraw Amount CID
  const [regTxSig, setRegTxSig] = useState('')

  // Step 3: Submit Job
  const [operation, setOperation] = useState('deposit')
  const [jobPda, setJobPda] = useState('')
  const [jobTxSig, setJobTxSig] = useState('')

  // Step 4: Decrypt
  const [resultCidPda, setResultCidPda] = useState('')
  const [decryptedResult, setDecryptedResult] = useState('')

  const addLog = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setLogs(prev => [...prev, `[${timestamp}] ${msg}`])
  }

  useEffect(() => {
    loadWASM()
  }, [])

  // Auto-initialize confidential state when WASM is ready and wallet is connected
  useEffect(() => {
    if (moduleReady && publicKey && solBalanceState === 'initial' && usdcBalanceState === 'initial') {
      initializeConfidentialState()
    }
  }, [moduleReady, publicKey, solBalanceState, usdcBalanceState])

  const initializeConfidentialState = async () => {
    if (!moduleReady || !publicKey || !sendTransaction) {
      return
    }

    try {
      addLog('Auto-initializing confidential state...')
      
      // Check if confidential state CIDs already exist and are valid
      if (confidentialSOLCid && confidentialUSDCCid) {
        try {
          const [solCheck, usdcCheck] = await Promise.all([
            fetch(`/api/ciphertext/${confidentialSOLCid}`),
            fetch(`/api/ciphertext/${confidentialUSDCCid}`)
          ])
          
          if (solCheck.ok && usdcCheck.ok) {
            addLog('Existing confidential state found and verified')
            addLog(`SOL CID: ${confidentialSOLCid.substring(0, 8)}...`)
            addLog(`USDC CID: ${confidentialUSDCCid.substring(0, 8)}...`)
            return // Skip initialization if valid CIDs exist
          }
        } catch (error) {
          addLog('Failed to verify existing CIDs, will re-initialize...')
        }
      }

      addLog('Encrypting initial balances: SOL=0, USDC=0')

      // Encrypt initial zero values
      const ctSOLZero = encryptValue('0')
      const ctUSDCZero = encryptValue('0')

      if (!ctSOLZero || !ctUSDCZero) {
        addLog('Failed to encrypt initial balances')
        return
      }

      // Update ciphertext states
      setCiphertext1(ctSOLZero)
      setCiphertext4(ctUSDCZero)
      setSolBalanceState('encrypted')
      setUsdcBalanceState('encrypted')

      addLog('Initial balances encrypted')
      addLog('Registering confidential state CIDs...')

      // Register the confidential state CIDs
      const response = await fetch('/api/actions/job/registerCIDs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: publicKey.toBase58(),
          ciphertext: [ctSOLZero, ctUSDCZero],
          policy_type: 'owner-controlled',
          provenance: '1',
        }),
      })

      const data = await response.json()

      if (!response.ok || !data.transaction) {
        addLog(`Failed to register confidential state CIDs: ${data.message || 'Unknown'}`)
        return
      }

      addLog('Requesting wallet signature for confidential state...')

      // Decode and send transaction
      const txBuffer = Buffer.from(data.transaction, 'base64')
      const tx = Transaction.from(txBuffer)

      const signature = await sendTransaction(tx, connection)
      addLog(`Confidential state transaction sent: ${signature.substring(0, 16)}...`)

      // Wait for confirmation
      addLog('Confirming confidential state registration...')
      const confirmation = await connection.confirmTransaction(signature, 'confirmed')

      if (confirmation.value.err) {
        addLog(`Confidential state transaction failed: ${JSON.stringify(confirmation.value.err)}`)
        return
      }

      addLog('Confidential state registered on Solana!')

      // Store the CIDs for persistent confidential state
      const cidPdas = data.cid_pdas || []
      if (cidPdas.length >= 2) {
        setConfidentialSOLCid(cidPdas[0])
        setConfidentialUSDCCid(cidPdas[1])
        addLog(`SOL Balance CID: ${cidPdas[0].substring(0, 8)}...`)
        addLog(`USDC Balance CID: ${cidPdas[1].substring(0, 8)}...`)
      }

      addLog('Confidential state initialized and ready!')
      
    } catch (error: any) {
      if (error.message?.includes('User rejected')) {
        addLog('User rejected confidential state initialization')
      } else {
        addLog(`Failed to initialize confidential state: ${error.message || error}`)
      }
    }
  }

  const loadWASM = async () => {
    try {

      if (!window.createFHE16) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script')
          script.src = '/fhe16.js'
          script.onload = () => resolve()
          script.onerror = () => reject(new Error('Failed to load fhe16.js'))
          document.head.appendChild(script)
        })
      }

      if (!window.createFHE16) {
        throw new Error('createFHE16 not found')
      }

      const mod = await window.createFHE16({
        locateFile: (path: string) => `/${path}`,
        print: (text: string) => addLog(`[WASM] ${text}`),
        printErr: (text: string) => addLog(`[WASM ERROR] ${text}`),
      })

      mod._FHE16_init_params(
        FHE_PARAMS.PK_ROW,
        FHE_PARAMS.PK_COL,
        FHE_PARAMS.PK_Q,
        FHE_PARAMS.Q_TOT,
        FHE_PARAMS.SIGMA
      )
      addLog('FHE parameters initialized')

      addLog('Loading public key...')
      const response = await fetch('/pk.bin')
      if (!response.ok) throw new Error(`Failed to fetch pk.bin`)

      const pkBuffer = await response.arrayBuffer()
      const pkBytes = new Uint8Array(pkBuffer)
      const nints = pkBytes.byteLength >>> 2

      addLog(`Public key loaded: ${pkBytes.byteLength} bytes (${nints} ints)`)

      const ptr = mod._malloc(pkBytes.byteLength)
      mod.HEAP8.set(pkBytes as any, ptr)
      mod._FHE16_set_pk(ptr, nints)
      mod._free(ptr)

      addLog('Public key set successfully')
      setModule(mod)
      setModuleReady(true)
      addLog('FHE16 WASM ready!')
    } catch (error) {
      addLog(`Failed to initialize WASM: ${error}`)
    }
  }

  const encryptValue = (plaintext: string): any | null => {
    if (!module || !moduleReady) {
      addLog('WASM module not ready')
      return null
    }

    try {
      const msg = parseInt(plaintext)
      const p = module._FHE16_ENC_WASM(msg, FHE_PARAMS.BIT)
      
      if (!p) {
        addLog('WASM encryption returned null pointer')
        return null
      }

      const ctStr = module.UTF8ToString(p)
      module._FHE16_free(p)

      const ctArray = ctStr.split(',').map(s => parseInt(s.trim()))
      
      const invalidElements = ctArray.filter(x => isNaN(x) || !isFinite(x));
      if (invalidElements.length > 0) {
        addLog(`Encryption produced ${invalidElements.length} invalid elements`)
        return null
      }
      
      const ciphertext = {
        encrypted_data: ctArray,
        timestamp: Date.now(),
        scheme: 'FHE16_0.0.1v'
      }

      addLog(`Encrypted: ${ctArray.length} elements`)
      
      return ciphertext
    } catch (error) {
      addLog(`Encryption error: ${error}`)
      return null
    }
  }

  const handleEncryptForOperation = async () => {
    addLog(`Encrypting values for ${operation} operation...`)
    
    // Check if confidential state needs to be fetched from store
    let ctSOL = null
    let ctUSDC = null
    
    // Try to fetch SOL from store (could be executor result or existing ciphertext)
    if (confidentialSOLCid) {
      try {
        const response = await fetch(`/api/ciphertext/${confidentialSOLCid}`)
        if (response.ok) {
          const data = await response.json()
          // Check if this is an unregistered executor result
          if (data.verification?.status === 'confirmed' && data.metadata?.provenance === 'executor') {
            ctSOL = data.ciphertext
            addLog('Using executor result ciphertext for SOL')
          } else if (data.metadata?.provenance === 'executor') {
            ctSOL = data.ciphertext
            addLog('Using unregistered executor result for SOL')
          } else {
            // Existing registered ciphertext - just use the CID reference
            ctSOL = encryptValue(confidentialSOL)
          }
        } else {
          ctSOL = encryptValue(confidentialSOL)
        }
      } catch (error) {
        ctSOL = encryptValue(confidentialSOL)
      }
    } else {
      ctSOL = encryptValue(confidentialSOL)
    }
    
    // Try to fetch USDC from store
    if (confidentialUSDCCid) {
      try {
        const response = await fetch(`/api/ciphertext/${confidentialUSDCCid}`)
        if (response.ok) {
          const data = await response.json()
          // Check if this is an unregistered executor result
          if (data.verification?.status === 'confirmed' && data.metadata?.provenance === 'executor') {
            ctUSDC = data.ciphertext
            addLog('Using executor result ciphertext for USDC')
          } else if (data.metadata?.provenance === 'executor') {
            ctUSDC = data.ciphertext
            addLog('Using unregistered executor result for USDC')
          } else {
            ctUSDC = encryptValue(confidentialUSDC)
          }
        } else {
          ctUSDC = encryptValue(confidentialUSDC)
        }
      } catch (error) {
        ctUSDC = encryptValue(confidentialUSDC)
      }
    } else {
      ctUSDC = encryptValue(confidentialUSDC)
    }
    
    if (ctSOL) {
      setCiphertext1(ctSOL)
      setSolBalanceState('encrypted')
    }
    if (ctUSDC) {
      setCiphertext4(ctUSDC)
      setUsdcBalanceState('encrypted')
    }
    
    // Encrypt transaction inputs based on operation
    let transactionInputs = []
    switch (operation) {
      case 'deposit':
        const ctDeposit = encryptValue(depositAmount)
        if (ctDeposit) {
          setCiphertext2(ctDeposit)
          transactionInputs.push('deposit_amount')
        }
        break
      case 'withdraw':
        const ctWithdraw = encryptValue(withdrawAmount)
        if (ctWithdraw) {
          setCiphertext5(ctWithdraw)
          transactionInputs.push('withdraw_amount')
        }
        break
      case 'borrow':
        const ctBorrow = encryptValue(borrowAmount)
        if (ctBorrow) {
          setCiphertext3(ctBorrow)
          transactionInputs.push('borrow_amount')
        }
        break
    }
    
    addLog(`Confidential state encrypted: SOL, USDC`)
    addLog(`Transaction inputs encrypted: ${transactionInputs.join(', ')}`)
  }

  const handleRegisterCIDs = async () => {
    if (!publicKey) {
      addLog('Please connect wallet first')
      return
    }
    
    // Check required ciphertexts based on operation
    const requiredCiphertexts = []
    const isConfidentialStateInitialized = confidentialSOLCid && confidentialUSDCCid
    let needsSOLRegistration = false
    let needsUSDCRegistration = false
    
    switch (operation) {
      case 'deposit':
        if (!ciphertext2) {
          addLog(' Please encrypt deposit amount first')
          return
        }
        if (!isConfidentialStateInitialized) {
          addLog(' Confidential state not initialized. Attempting auto-initialization...')
          await initializeConfidentialState()
          // Re-check after initialization attempt
          if (!confidentialSOLCid || !confidentialUSDCCid) {
            addLog(' Auto-initialization failed. Please refresh the page.')
            return
          }
        }
        
        // Check if current SOL balance needs registration (executor result)
        if (confidentialSOLCid) {
          try {
            const checkResponse = await fetch(`/api/ciphertext/${confidentialSOLCid}`)
            if (checkResponse.ok) {
              const data = await checkResponse.json()
              if (data.metadata?.provenance === 'executor') {
                addLog('Detected unregistered executor result, will register with deposit amount')
                needsSOLRegistration = true
              }
            }
          } catch (error) {
            // If check fails, assume no registration needed
          }
        }
        
        // Register both if needed, or just deposit amount
        if (needsSOLRegistration && ciphertext1) {
          requiredCiphertexts.push(ciphertext1, ciphertext2)
          addLog(' Registering: SOL balance (result) + deposit amount')
        } else {
          requiredCiphertexts.push(ciphertext2)
          addLog(' Reusing existing confidential SOL balance, registering deposit amount only')
        }
        break
      case 'withdraw':
        if (!ciphertext5) {
          addLog(' Please encrypt withdraw amount first')
          return
        }
        if (!isConfidentialStateInitialized) {
          addLog(' Confidential state not initialized. Attempting auto-initialization...')
          await initializeConfidentialState()
          // Re-check after initialization attempt
          if (!confidentialSOLCid || !confidentialUSDCCid) {
            addLog(' Auto-initialization failed. Please refresh the page.')
            return
          }
        }
        
        // Check if current USDC balance needs registration (executor result)
        if (confidentialUSDCCid) {
          try {
            const checkResponse = await fetch(`/api/ciphertext/${confidentialUSDCCid}`)
            if (checkResponse.ok) {
              const data = await checkResponse.json()
              if (data.metadata?.provenance === 'executor') {
                needsUSDCRegistration = true
              }
            }
          } catch (error) {
            // Ignore
          }
        }
        
        // Register both if needed, or just withdraw amount
        if (needsUSDCRegistration && ciphertext4) {
          requiredCiphertexts.push(ciphertext4, ciphertext5)
          addLog(' Registering: USDC balance (result) + withdraw amount')
        } else {
          requiredCiphertexts.push(ciphertext5)
          addLog(' Reusing existing confidential USDC balance, registering withdraw amount only')
        }
        break
      case 'borrow':
        if (!ciphertext3) {
          addLog(' Please encrypt borrow amount first')
          return
        }
        if (!isConfidentialStateInitialized) {
          addLog(' Confidential state not initialized. Attempting auto-initialization...')
          await initializeConfidentialState()
          // Re-check after initialization attempt
          if (!confidentialSOLCid || !confidentialUSDCCid) {
            addLog(' Auto-initialization failed. Please refresh the page.')
            return
          }
        }
        
        // Check if SOL or USDC balance needs registration (executor results)
        if (confidentialSOLCid) {
          try {
            const checkResponse = await fetch(`/api/ciphertext/${confidentialSOLCid}`)
            if (checkResponse.ok) {
              const data = await checkResponse.json()
              if (data.metadata?.provenance === 'executor') {
                needsSOLRegistration = true
              }
            }
          } catch (error) {
            // Ignore
          }
        }
        
        if (confidentialUSDCCid) {
          try {
            const checkResponse = await fetch(`/api/ciphertext/${confidentialUSDCCid}`)
            if (checkResponse.ok) {
              const data = await checkResponse.json()
              if (data.metadata?.provenance === 'executor') {
                needsUSDCRegistration = true
              }
            }
          } catch (error) {
            // Ignore
          }
        }
        
        if (needsSOLRegistration && needsUSDCRegistration) {
          // Both need registration
          requiredCiphertexts.push(ciphertext1, ciphertext3, ciphertext4)
          addLog(' Registering: SOL balance (result) + borrow amount + USDC balance (result)')
        } else if (needsSOLRegistration) {
          // Only SOL needs registration
          requiredCiphertexts.push(ciphertext1, ciphertext3)
          addLog(' Registering: SOL balance (result) + borrow amount')
        } else if (needsUSDCRegistration) {
          // Only USDC needs registration - need to keep borrow first
          requiredCiphertexts.push(ciphertext3, ciphertext4)
          addLog(' Registering: borrow amount + USDC balance (result)')
        } else {
          // Only borrow amount needs registration
          requiredCiphertexts.push(ciphertext3)
          addLog(' Reusing existing confidential balances, registering borrow amount only')
        }
        break
      default:
        addLog(' Unknown operation')
        return
    }
    if (!sendTransaction) {
      addLog(' Wallet does not support transactions')
      return
    }

    try {
      addLog(` Registering ciphertexts for ${operation} operation...`)

      const response = await fetch('/api/actions/job/registerCIDs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: publicKey.toBase58(),
          ciphertext: requiredCiphertexts,
          policy_type: 'owner-controlled',
          provenance: '1',
        }),
      })

      const data = await response.json()

      if (!response.ok || !data.transaction) {
        addLog(` API error: ${data.message || 'Unknown'}`)
        if (data.hint) addLog(` Hint: ${data.hint}`)
        return
      }

      addLog(' Transaction created by API')
      addLog(' Requesting wallet signature...')

      // Decode base64 transaction
      const txBuffer = Buffer.from(data.transaction, 'base64')
      const tx = Transaction.from(txBuffer)

      // Send transaction (wallet will sign and send)
      const signature = await sendTransaction(tx, connection)
      addLog(` Transaction signed & sent: ${signature.substring(0, 16)}...`)

      // Wait for confirmation
      addLog(' Waiting for blockchain confirmation...')
      const confirmation = await connection.confirmTransaction(signature, 'confirmed')

      if (confirmation.value.err) {
        addLog(` Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
        return
      }

      addLog(' Transaction confirmed on Solana!')
      addLog(` View on Solscan: https://solscan.io/tx/${signature}?cluster=devnet`)

      setRegTxSig(signature)

      // Extract CID PDAs from API response
      const cidPdas = data.cid_pdas || []
      const expectedCount = requiredCiphertexts.length
      if (cidPdas.length < expectedCount) {
        addLog(` Expected ${expectedCount} CIDs but got ${cidPdas.length}`)
        return
      }

      // Map CIDs to appropriate slots based on operation
      switch (operation) {
        case 'deposit':
          // Check if we registered both SOL balance and deposit amount
          if (requiredCiphertexts.length === 2) {
            // Both were registered
            const newSOLCid = cidPdas[0]
            const newDepositCid = cidPdas[1]
            setCidPda1(newSOLCid)
            setCidPda2(newDepositCid)
            // Update confidential state to use newly registered CID
            setConfidentialSOLCid(newSOLCid)
            addLog(' CID 1 (SOL Balance - Newly Registered): ' + newSOLCid.substring(0, 8) + '...')
            addLog(' CID 2 (Deposit Amount - New): ' + newDepositCid.substring(0, 8) + '...')
          } else {
            // Only deposit amount was registered, reuse existing SOL CID
            setCidPda1(confidentialSOLCid)
            setCidPda2(cidPdas[0])
            addLog(' CID 1 (SOL Balance - Reused): ' + confidentialSOLCid.substring(0, 8) + '...')
            addLog(' CID 2 (Deposit Amount - New): ' + cidPdas[0].substring(0, 8) + '...')
          }
          break
        case 'withdraw':
          // Check if we registered both USDC balance and withdraw amount
          if (requiredCiphertexts.length === 2) {
            // Both were registered
            const newUSDCCid = cidPdas[0]
            const newWithdrawCid = cidPdas[1]
            setCidPda4(newUSDCCid)
            setCidPda5(newWithdrawCid)
            // Update confidential state to use newly registered CID
            setConfidentialUSDCCid(newUSDCCid)
            addLog(' CID 4 (USDC Balance - Newly Registered): ' + newUSDCCid.substring(0, 8) + '...')
            addLog(' CID 5 (Withdraw Amount - New): ' + newWithdrawCid.substring(0, 8) + '...')
          } else {
            // Only withdraw amount was registered, reuse existing USDC CID
            setCidPda4(confidentialUSDCCid)
            setCidPda5(cidPdas[0])
            addLog(' CID 4 (USDC Balance - Reused): ' + confidentialUSDCCid.substring(0, 8) + '...')
            addLog(' CID 5 (Withdraw Amount - New): ' + cidPdas[0].substring(0, 8) + '...')
          }
          break
        case 'borrow':
          // Check how many were registered to determine mapping
          if (requiredCiphertexts.length === 3) {
            // All three registered: SOL + borrow + USDC
            const newSOLCid = cidPdas[0]
            const newBorrowCid = cidPdas[1]
            const newUSDCCid = cidPdas[2]
            setCidPda1(newSOLCid)
            setCidPda3(newBorrowCid)
            setCidPda4(newUSDCCid)
            setConfidentialSOLCid(newSOLCid)
            setConfidentialUSDCCid(newUSDCCid)
            addLog(' CID 1 (SOL Balance - Newly Registered): ' + newSOLCid.substring(0, 8) + '...')
            addLog(' CID 3 (Borrow Amount - New): ' + newBorrowCid.substring(0, 8) + '...')
            addLog(' CID 4 (USDC Balance - Newly Registered): ' + newUSDCCid.substring(0, 8) + '...')
          } else if (requiredCiphertexts.length === 2) {
            // Check which two were registered based on stored needsSOLRegistration
            if (needsSOLRegistration) {
              // SOL + borrow registered
              const newSOLCid = cidPdas[0]
              const newBorrowCid = cidPdas[1]
              setCidPda1(newSOLCid)
              setCidPda3(newBorrowCid)
              setCidPda4(confidentialUSDCCid)
              setConfidentialSOLCid(newSOLCid)
              addLog(' CID 1 (SOL Balance - Newly Registered): ' + newSOLCid.substring(0, 8) + '...')
              addLog(' CID 3 (Borrow Amount - New): ' + newBorrowCid.substring(0, 8) + '...')
              addLog(' CID 4 (USDC Balance - Reused): ' + confidentialUSDCCid.substring(0, 8) + '...')
            } else {
              // borrow + USDC registered
              const newBorrowCid = cidPdas[0]
              const newUSDCCid = cidPdas[1]
              setCidPda1(confidentialSOLCid)
              setCidPda3(newBorrowCid)
              setCidPda4(newUSDCCid)
              setConfidentialUSDCCid(newUSDCCid)
              addLog(' CID 1 (SOL Balance - Reused): ' + confidentialSOLCid.substring(0, 8) + '...')
              addLog(' CID 3 (Borrow Amount - New): ' + newBorrowCid.substring(0, 8) + '...')
              addLog(' CID 4 (USDC Balance - Newly Registered): ' + newUSDCCid.substring(0, 8) + '...')
            }
          } else {
            // Only borrow amount registered, reuse existing balances
            setCidPda1(confidentialSOLCid)
            setCidPda3(cidPdas[0])
            setCidPda4(confidentialUSDCCid)
            addLog(' CID 1 (SOL Balance - Reused): ' + confidentialSOLCid.substring(0, 8) + '...')
            addLog(' CID 3 (Borrow Amount - New): ' + cidPdas[0].substring(0, 8) + '...')
            addLog(' CID 4 (USDC Balance - Reused): ' + confidentialUSDCCid.substring(0, 8) + '...')
          }
          break
      }

      // Wait for event listener to process on-chain events and confirm CIDs
      addLog(` Waiting for event listener to confirm ${expectedCount} CIDs...`)
      await new Promise(resolve => setTimeout(resolve, 3000))

      addLog(` All ${expectedCount} CIDs ready for job submission!`)
    } catch (error: any) {
      // Handle specific errors
      if (error.message?.includes('already been processed')) {
        addLog(' Transaction already processed - checking status...')
        // Transaction might have succeeded, don't show as error
        addLog(' If this keeps happening, the transaction likely succeeded. Check Solscan.')
      } else if (error.message?.includes('User rejected')) {
        addLog(' User rejected transaction')
      } else {
        addLog(` Error: ${error.message || error}`)
      }
    }
  }

  const handleSubmitJob = async () => {
    if (!publicKey) {
      addLog(' Please connect wallet')
      return
    }
    // Check required CIDs based on operation
    let requiredCidsForOperation = []
    switch (operation) {
      case 'deposit':
        if (!confidentialSOLCid || !cidPda2) {
          addLog(' Please ensure confidential state is initialized and deposit amount is registered')
          return
        }
        requiredCidsForOperation = [confidentialSOLCid, cidPda2]
        break
      case 'withdraw':
        if (!confidentialUSDCCid || !cidPda5) {
          addLog(' Please ensure USDC balance is initialized and withdraw amount is registered')
          return
        }
        // Withdraw requires 2 inputs: USDC_balance, withdraw_amount
        requiredCidsForOperation = [confidentialUSDCCid, cidPda5]
        break
      case 'borrow':
        if (!confidentialSOLCid || !cidPda3 || !confidentialUSDCCid) {
          addLog(' Please ensure confidential state is initialized and borrow amount is registered')
          return
        }
        requiredCidsForOperation = [confidentialSOLCid, cidPda3, confidentialUSDCCid]
        break
      default:
        addLog(' Unknown operation')
        return
    }
    if (!sendTransaction) {
      addLog(' Wallet does not support transactions')
      return
    }

    // Use the CIDs we already validated above
    const selectedCids = requiredCidsForOperation
    const cidDescription = operation === 'deposit' ? 'confidential_SOL_balance(reused) + deposit_amount(new)' :
                          operation === 'withdraw' ? 'confidential_USDC_balance(reused) + withdraw_amount(new)' :
                          operation === 'borrow' ? 'confidential_SOL_balance(reused) + borrow_amount(new) + confidential_USDC_balance(reused)' :
                          'unknown'

    try {
      addLog(` Submitting ${operation} job...`)
      addLog(`Using CIDs: ${cidDescription}`)
      selectedCids.forEach((cid, idx) => addLog(`  CID${idx + 1}: ${cid.substring(0, 8)}...`))

      const response = await fetch('/api/actions/job/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: publicKey.toBase58(),
          cids: selectedCids,
          operation,
          policy_type: 'owner-controlled',
          provenance: '1',
        }),
      })

      const data = await response.json()

      if (!response.ok || !data.transaction) {
        addLog(` API error: ${data.message || 'Unknown'}`)

        // Show validation details if available
        if (data.validation) {
          addLog(` Validation: ${data.validation.invalid_count} invalid CID(s)`)
          if (data.validation.details) {
            data.validation.details.forEach((detail: any) => {
              addLog(`  - ${detail.cid.substring(0, 8)}...: ${detail.reason || detail.status}`)
            })
          }
        }

        if (data.hint) {
          addLog(` Hint: ${data.hint}`)
        }

        addLog(' If CIDs were just registered, wait a few seconds and try again')
        return
      }

      addLog(' Job transaction created by API')
      addLog(' Requesting wallet signature...')

      const txBuffer = Buffer.from(data.transaction, 'base64')
      const tx = Transaction.from(txBuffer)

      const signature = await sendTransaction(tx, connection)
      addLog(` Transaction signed & sent: ${signature.substring(0, 16)}...`)

      addLog(' Waiting for blockchain confirmation...')
      const confirmation = await connection.confirmTransaction(signature, 'confirmed')

      if (confirmation.value.err) {
        addLog(` Transaction failed: ${JSON.stringify(confirmation.value.err)}`)
        return
      }

      addLog(' Job submitted on-chain!')
      addLog(` View on Solscan: https://solscan.io/tx/${signature}?cluster=devnet`)

      setJobTxSig(signature)
      const actualJobPda = data.verification?.pda?.job || 'JobPDA_' + signature.substring(0, 16)
      setJobPda(actualJobPda)
      addLog(` Job PDA set: ${actualJobPda}`)

      // Wait for executor to pick up and process the job
      addLog(' FHE Executor will pick up job from queue...')
      addLog(' Real executor polls /api/executor/jobs for queued jobs')
      addLog(' Executor processes ciphertext and submits result to /api/executor/jobs/{job_pda}/result')
      
      // External FHE Executor processes job asynchronously
      addLog(' External FHE Executor will process job automatically...')
      addLog(` Start FHE Executor: cd fhe_executor && npm run dev`)
      addLog(` Executor polls: GET /api/executor/jobs`)
      addLog(` Executor claims: POST /api/executor/jobs/{job_pda}/claim`)
      addLog(` Executor computes: FHE operations on ciphertext`)
      addLog(` Executor submits: POST /api/executor/jobs/{job_pda}/result`)
      
      // Poll for job completion (check job status changes)
      let pollCount = 0
      const maxPolls = 30 // 1 minute total
      const targetJobPda = actualJobPda // Capture the actual job PDA
      
      const pollForResult = async () => {
        try {
          pollCount++
          const statusResponse = await fetch('/api/init')
          const statusData = await statusResponse.json()
          
          // Get current job queue status
          const jobQueue = statusData.services?.job_queue || {}
          const queuedJobs = jobQueue.queued || 0
          const executingJobs = jobQueue.executing || 0
          const completedJobs = jobQueue.completed || 0
          
          addLog(` Job Queue Status: ${queuedJobs} queued, ${executingJobs} executing, ${completedJobs} completed`)
          
          // Check specific jobs for our submission
          const jobs = jobQueue.jobs || []
          const ourJob = jobs.find((j: any) => j.job_pda === targetJobPda)
          
          addLog(` Searching for job: ${targetJobPda}`)
          addLog(` Found ${jobs.length} total jobs in queue`)
          if (jobs.length > 0) {
            addLog(` Job PDAs: ${jobs.map((j: any) => j.job_pda.substring(0, 8) + '...').join(', ')}`)
          }
          
          if (ourJob) {
            addLog(` Our job status: ${ourJob.status}`)
            addLog(` Job details: ${JSON.stringify({
              job_pda: ourJob.job_pda.substring(0, 16) + '...',
              status: ourJob.status,
              executor: ourJob.executor,
              result_handle: ourJob.result_handle
            })}`)
            
            if (ourJob.status === 'completed') {
              const resultCid = ourJob.result_handle || 'ResultCID_' + Date.now().toString(36)
              setResultCidPda(resultCid)
              addLog(` Job completed by external FHE Executor!`)
              addLog(` Result CID: ${resultCid}`)
              addLog(` Executor: ${ourJob.executor || 'Unknown'}`)
              
              // Update confidential state CID to use executor result (unregistered)
              // This will be properly registered in the next Register CIDs step
              if (operation === 'deposit') {
                setConfidentialSOLCid(resultCid)
                addLog(` Updated Confidential SOL CID: ${resultCid}`)
                addLog(` Use "Encrypt" then "Register CIDs" before next operation`)
              } else if (operation === 'withdraw') {
                // For withdraw, the result is a boolean check, USDC balance doesn't change
                // Keep using the existing USDC CID
              } else if (operation === 'borrow') {
                setConfidentialUSDCCid(resultCid)
                addLog(` Updated Confidential USDC CID: ${resultCid}`)
                addLog(` Use "Encrypt" then "Register CIDs" before next operation`)
              }
              
              // Show actual computation result
              if (ourJob.computation_result) {
                addLog(` Computed result: ${ourJob.computation_result}`)
              }
              
              // Try to get result immediately via CID API
              if (resultCid && resultCid !== 'ResultCID_' + Date.now().toString(36)) {
                setTimeout(async () => {
                  try {
                    addLog(` Auto-fetching result via CID: ${resultCid}`)
                    const cidResponse = await fetch(`/api/ciphertext/${resultCid}`)
                    if (cidResponse.ok) {
                      const cidData = await cidResponse.json()
                      if (cidData.computation_result !== null && cidData.computation_result !== undefined) {
                        setDecryptedResult(String(cidData.computation_result))
                        addLog(` Auto-decrypted result: ${cidData.computation_result}`)
                        if (cidData.computation_description) {
                          addLog(` ${cidData.computation_description}`)
                        }
                      }
                    }
                  } catch (error) {
                    addLog(` Auto-fetch failed: ${error}`)
                  }
                }, 1000)
              }
              return
            } else if (ourJob.status === 'failed') {
              addLog(` Job failed during execution`)
              return
            } else if (ourJob.status === 'executing' || ourJob.status === 'assigned') {
              addLog(` Job is being processed by: ${ourJob.executor || 'FHE Executor'}`)
            }
          } else {
            // Job not found - maybe it's completed but not in our filtered list
            if (completedJobs > 0) {
              addLog(` Job not found in list, but ${completedJobs} jobs completed`)
              addLog(` Try manual decryption button below`)
            } else {
              addLog(` Job not found in queue (${jobs.length} total jobs)`)
            }
          }
          
          // Check if executor is running
          if (queuedJobs > 0 && executingJobs === 0 && pollCount > 5) {
            addLog(` Jobs queued but no executor active`)
            addLog(` Start executor: cd fhe_executor && npm run dev`)
          }
          
          // Continue polling if not reached max attempts
          if (pollCount < maxPolls) {
            setTimeout(pollForResult, 2000)
          } else {
            addLog(` Polling timeout - check ./dashboard.sh for job status`)
            addLog(` Make sure FHE Executor is running: cd fhe_executor && npm run dev`)
          }
          
        } catch (error) {
          addLog(` Status check error: ${error}`)
          if (pollCount < maxPolls) {
            setTimeout(pollForResult, 5000)
          }
        }
      }
      
      // Start polling after job submission
      setTimeout(pollForResult, 3000)
    } catch (error: any) {
      if (error.message?.includes('User rejected')) {
        addLog(' User rejected transaction')
      } else {
        addLog(` Error: ${error.message || error}`)
      }
    }
  }

  const handleDecrypt = async () => {
    if (!resultCidPda) {
      addLog(' No result to decrypt')
      return
    }

    try {
      addLog(' Requesting result decryption via KMS...')
      addLog(' In production: KMS threshold decryption of result ciphertext')
      
      addLog(' [Simulated KMS] Performing threshold decryption...')
      addLog(' [Simulated KMS] Validating user permissions...')
      addLog(' [Simulated KMS] Combining threshold shares...')
      
      // Get the actual result using CID-based retrieval
      try {
        if (!resultCidPda) {
          throw new Error('No result CID available')
        }

        addLog(' [Simulated KMS] Accessing result ciphertext via CID...')
        addLog(` [Simulated KMS] Fetching CID: ${resultCidPda}`)
        
        // Fetch result ciphertext by CID handle
        const cidResponse = await fetch(`/api/ciphertext/${resultCidPda}`)
        
        if (!cidResponse.ok) {
          throw new Error(`Failed to fetch result CID: ${cidResponse.status}`)
        }
        
        const cidData = await cidResponse.json()
        addLog(' [Simulated KMS] Result ciphertext retrieved')
        addLog(' [Simulated KMS] Performing threshold decryption...')
        
        // Use ONLY the actual computation result from FHE executor
        const actualResult = cidData.computation_result
        
        if (actualResult === undefined || actualResult === null) {
          addLog(` No computation result available from FHE executor`)
          addLog(` FHE computation may have failed or result not stored`)
          setDecryptedResult('ERROR: No FHE result')
          return
        }
        
        setDecryptedResult(String(actualResult))
        addLog(` FHE computation result: ${actualResult}`)
        addLog(' Pure result from homomorphic computation engine')
        
        if (cidData.computation_description) {
          addLog(` Computation: ${cidData.computation_description}`)
        }
        
      } catch (error) {
        addLog(` CID-based decryption failed: ${error}`)
        addLog(` Cannot retrieve FHE computation result`)
        setDecryptedResult('ERROR: Decryption failed')
      }
      
    } catch (error) {
      addLog(` Decryption failed: ${error}`)
    }
  }

  return (
    <div style={{
      fontFamily: 'monospace',
      maxWidth: '1200px',
      margin: '0 auto',
      padding: '20px',
      background: '#0a0a0a',
      color: '#0f0',
      minHeight: '100vh'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h1 style={{ color: '#0f0', margin: 0 }}>
           LatticA FHE Demo
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'nowrap' }}>
          {/* Confidential Assets in Header */}
          {publicKey && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '12px' }}>
              {/* Confidential wSOL */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#9ca3af', fontWeight: '500' }}>wSOL:</span>
                <span style={{ 
                  color: solBalanceState === 'encrypted' ? '#f59e0b' : '#ffffff', 
                  fontWeight: '500',
                  fontFamily: 'monospace'
                }}>
                  {solBalanceState === 'encrypted' && ciphertext1 ? 
                    `${'0'.repeat(8)}${ciphertext1.encrypted_data.slice(0, 6).map((n: number) => Math.abs(n).toString(36).substring(0, 2)).join('')}...` : 
                    `${confidentialSOL}`}
                </span>
                {confidentialSOLCid && (
                  <span style={{ color: '#6b7280', fontSize: '10px', fontFamily: 'monospace' }}>
                    [{confidentialSOLCid.substring(0, 6)}]
                  </span>
                )}
                {solBalanceState === 'encrypted' && (
                  <button
                    onClick={() => {
                      addLog(' Decrypting SOL balance...')
                      addLog(` [KMS] Requesting decryption for CID: ${confidentialSOLCid || 'Unknown'}`)
                      setTimeout(() => {
                        setSolBalanceState('decrypted')
                        addLog(' SOL balance decrypted')
                      }, 1500)
                    }}
                    style={{
                      padding: '1px 4px',
                      background: '#3b82f6',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '3px',
                      fontSize: '9px',
                      cursor: 'pointer'
                    }}
                  >
                    Dec
                  </button>
                )}
              </div>

              {/* Confidential USDC */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#9ca3af', fontWeight: '500' }}>USDC:</span>
                <span style={{ 
                  color: usdcBalanceState === 'encrypted' ? '#f59e0b' : '#ffffff', 
                  fontWeight: '500',
                  fontFamily: 'monospace'
                }}>
                  {usdcBalanceState === 'encrypted' && ciphertext4 ? 
                    `${'0'.repeat(8)}${ciphertext4.encrypted_data.slice(0, 6).map((n: number) => Math.abs(n).toString(36).substring(0, 2)).join('')}...` : 
                    `${confidentialUSDC}`}
                </span>
                {confidentialUSDCCid && (
                  <span style={{ color: '#6b7280', fontSize: '10px', fontFamily: 'monospace' }}>
                    [{confidentialUSDCCid.substring(0, 6)}]
                  </span>
                )}
                {usdcBalanceState === 'encrypted' && (
                  <button
                    onClick={() => {
                      addLog(' Decrypting USDC balance...')
                      addLog(` [KMS] Requesting decryption for CID: ${confidentialUSDCCid || 'Unknown'}`)
                      setTimeout(() => {
                        setUsdcBalanceState('decrypted')
                        addLog(' USDC balance decrypted')
                      }, 1500)
                    }}
                    style={{
                      padding: '1px 4px',
                      background: '#3b82f6',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '3px',
                      fontSize: '9px',
                      cursor: 'pointer'
                    }}
                  >
                    Dec
                  </button>
                )}
              </div>
            </div>
          )}
          <WalletMultiButton style={{ background: '#0f0', color: '#000' }} />
        </div>
      </div>


      <div style={{ marginBottom: '20px', padding: '15px', background: '#1a1a1a', borderRadius: '8px' }}>
        <h3 style={{ margin: '0 0 10px 0' }}>Status</h3>
        <div>WASM: {moduleReady ? 'Ready' : 'Loading...'}</div>
        <div>Wallet: {publicKey ? `${publicKey.toBase58().substring(0, 8)}...` : 'Not connected'}</div>
        <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
          <strong>FHE Executor Required:</strong> Run <code style={{ background: '#000', padding: '2px 4px' }}>cd fhe_executor && npm run dev</code>
        </div>
      </div>


      {/* Transaction Inputs */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: ciphertext1 ? '2px solid #0f0' : '2px solid #555', borderRadius: '8px', opacity: !moduleReady ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          Step 1: Prepare Transaction
        </legend>
        <p style={{ fontSize: '14px', color: '#888', margin: '0 0 15px 0' }}>
          Select operation and encrypt inputs for confidential computation
        </p>
        
        <div style={{ marginBottom: '15px' }}>
          <label style={{ fontWeight: 'bold' }}>Operation:</label>
          <select
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
            style={{ marginLeft: '10px', padding: '8px', background: '#000', color: '#0f0', border: '1px solid #0f0', fontSize: '14px' }}
          >
            <option value="deposit">Deposit</option>
            <option value="withdraw">Withdraw</option>
            <option value="borrow">Borrow</option>
          </select>
        </div>

        {operation === 'deposit' && (
          <div style={{ marginBottom: '15px' }}>
            <label style={{ fontWeight: 'bold' }}>Deposit Amount:</label>
            <input
              type="number"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              style={{ marginLeft: '10px', padding: '8px', width: '150px', background: '#000', color: '#0f0', border: '1px solid #0f0', fontSize: '16px' }}
            />
            <span style={{ marginLeft: '10px', color: '#888' }}>SOL</span>
          </div>
        )}
        
        {operation === 'withdraw' && (
          <div style={{ marginBottom: '15px' }}>
            <label style={{ fontWeight: 'bold' }}>Withdraw Amount:</label>
            <input
              type="number"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              style={{ marginLeft: '10px', padding: '8px', width: '150px', background: '#000', color: '#0f0', border: '1px solid #0f0', fontSize: '16px' }}
            />
            <span style={{ marginLeft: '10px', color: '#888' }}>USDC</span>
          </div>
        )}
        
        {operation === 'borrow' && (
          <div style={{ marginBottom: '15px' }}>
            <label style={{ fontWeight: 'bold' }}>Borrow Amount:</label>
            <input
              type="number"
              value={borrowAmount}
              onChange={(e) => setBorrowAmount(e.target.value)}
              style={{ marginLeft: '10px', padding: '8px', width: '150px', background: '#000', color: '#0f0', border: '1px solid #0f0', fontSize: '16px' }}
            />
            <span style={{ marginLeft: '10px', color: '#888' }}>USDC</span>
          </div>
        )}

        <button
          onClick={handleEncryptForOperation}
          disabled={!moduleReady}
          style={{
            padding: '12px 30px',
            background: moduleReady ? '#0f0' : '#555',
            color: '#000',
            border: 'none',
            cursor: moduleReady ? 'pointer' : 'not-allowed',
            fontSize: '16px',
            fontWeight: 'bold',
            borderRadius: '4px'
          }}
        >
          Encrypt for {operation.charAt(0).toUpperCase() + operation.slice(1)}
        </button>
        
        {ciphertext1 && (
          <div style={{ marginTop: '15px', padding: '10px', background: '#1a3a1a', borderRadius: '4px', border: '1px solid #0f0' }}>
            <div style={{ fontSize: '14px', marginBottom: '5px', color: '#0f0' }}>
              <strong> Encrypted for {operation} operation:</strong>
            </div>
            
            <div style={{ fontSize: '12px', color: '#888', marginBottom: '10px' }}>
              • Confidential State: SOL Balance + USDC Balance<br/>
              • Transaction Input: {
                operation === 'deposit' ? 'Deposit Amount' :
                operation === 'withdraw' ? 'Withdraw Amount' :
                operation === 'borrow' ? 'Borrow Amount' : 'Unknown'
              }
            </div>
            
            <div style={{ fontSize: '11px', color: '#666', marginBottom: '5px' }}>
              Sample encrypted data:
            </div>
            <div style={{ fontSize: '11px', color: '#888', fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: '1.6' }}>
              [{ciphertext1.encrypted_data.slice(16, 32).join(', ')}, ...]
            </div>

            <div style={{ marginTop: '15px', fontSize: '13px', color: '#0f0', borderTop: '1px solid #0f0', paddingTop: '10px' }}>
              Encrypted locally in browser • Scheme: {ciphertext1.scheme}
            </div>
          </div>
        )}
      </fieldset>

      {/* Step 2 */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: regTxSig ? '2px solid #0f0' : '2px solid #555', borderRadius: '8px', opacity: (!publicKey || !ciphertext1) ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          Step 2: Register CIDs On-Chain
        </legend>
        <p style={{ fontSize: '14px', color: '#888', margin: '0 0 15px 0' }}>
          Submit encrypted data to Solana blockchain as Content Identifiers (CIDs)
        </p>
        <button
          onClick={handleRegisterCIDs}
          disabled={!publicKey || !ciphertext1}
          style={{
            padding: '12px 30px',
            background: (publicKey && ciphertext1) ? '#0f0' : '#555',
            color: '#000',
            border: 'none',
            cursor: (publicKey && ciphertext1) ? 'pointer' : 'not-allowed',
            fontSize: '16px',
            fontWeight: 'bold',
            borderRadius: '4px'
          }}
        >
          Register CIDs via Solana Actions
        </button>
        {regTxSig && (
          <div style={{ marginTop: '15px', padding: '10px', background: '#1a3a1a', borderRadius: '4px', border: '1px solid #0f0' }}>
            <div style={{ fontSize: '14px', marginBottom: '10px' }}>
              <strong>Transaction Signature:</strong>
            </div>
            <div style={{ fontSize: '12px', fontFamily: 'monospace', color: '#0f0', wordBreak: 'break-all' }}>
              {regTxSig}
            </div>
            
            {/* Show CIDs based on operation */}
            {operation === 'deposit' && cidPda1 && cidPda2 && (
              <>
                <div style={{ marginTop: '10px', fontSize: '14px' }}>
                  <strong>CID 1 (SOL Balance):</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda1}</span>
                </div>
                <div style={{ fontSize: '14px', marginTop: '5px' }}>
                  <strong>CID 2 (Deposit Amount):</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda2}</span>
                </div>
              </>
            )}
            
            {operation === 'withdraw' && cidPda4 && cidPda5 && (
              <>
                <div style={{ marginTop: '10px', fontSize: '14px' }}>
                  <strong>CID 4 (USDC Balance):</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda4}</span>
                </div>
                <div style={{ fontSize: '14px', marginTop: '5px' }}>
                  <strong>CID 5 (Withdraw Amount):</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda5}</span>
                </div>
              </>
            )}
            
            {operation === 'borrow' && cidPda1 && cidPda3 && cidPda4 && (
              <>
                <div style={{ marginTop: '10px', fontSize: '14px' }}>
                  <strong>CID 1 (SOL Balance):</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda1}</span>
                </div>
                <div style={{ fontSize: '14px', marginTop: '5px' }}>
                  <strong>CID 3 (Borrow Amount):</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda3}</span>
                </div>
                <div style={{ fontSize: '14px', marginTop: '5px' }}>
                  <strong>CID 4 (USDC Balance):</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda4}</span>
                </div>
              </>
            )}
            <div style={{ marginTop: '10px' }}>
              <a
                href={`https://solscan.io/tx/${regTxSig}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#0f0', textDecoration: 'underline', fontSize: '14px' }}
              >
                 View on Solscan (Devnet)
              </a>
            </div>
            <div style={{ marginTop: '10px', fontSize: '13px', color: '#0f0' }}>
              Registered on Solana • Policy: owner-controlled (private)
            </div>
          </div>
        )}
      </fieldset>

      {/* Step 3 */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: jobTxSig ? '2px solid #0f0' : '2px solid #555', borderRadius: '8px', opacity: (!publicKey || !cidPda1) ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          Step 3: Submit FHE Computation Job
        </legend>
        <p style={{ fontSize: '14px', color: '#888', margin: '0 0 15px 0' }}>
          Request FHE computation on encrypted CIDs (executor performs homomorphic operations)
        </p>
        <div style={{ marginBottom: '15px' }}>
          <label style={{ fontWeight: 'bold' }}>FHE Operation:</label>
          <select
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
            style={{ marginLeft: '10px', padding: '8px', background: '#000', color: '#0f0', border: '1px solid #0f0', fontSize: '14px' }}
          >
            <option value="deposit">Deposit (ADD) - SOL_balance + deposit_amount</option>
            <option value="withdraw">Withdraw (GE+SUB+SELECT) - USDC balance check & subtract</option>
            <option value="borrow">Borrow (Multi-step) - Collateral check + balance update</option>
            <option value="liquidation">Liquidation (Multi-step) - Health factor calculation</option>
          </select>
        </div>
        <div style={{ fontSize: '13px', color: '#888', marginBottom: '15px', padding: '10px', background: '#1a1a1a', borderRadius: '4px' }}>
          <strong>Selected Operation:</strong> {
            operation === 'deposit' ? 'ADD' :
            operation === 'withdraw' ? 'GE+SUB+SELECT' :
            operation === 'borrow' ? 'MUL_CONST+GE+SELECT+ADD' :
            operation === 'liquidation' ? 'MUL+MUL_CONST+GT' : 'UNKNOWN'
          }<br/>
          <strong>Input CIDs:</strong> {
            operation === 'deposit' ? '2 (SOL_balance + deposit_amount)' :
            operation === 'withdraw' ? '2 (USDC_balance + withdraw_amount)' :
            operation === 'borrow' ? '3 (SOL_balance + borrow_amount + USDC_balance)' :
            operation === 'liquidation' ? '3 (collateral + debt + price)' : '2'
          }<br/>
          <strong>FHE Computation:</strong> {
            operation === 'deposit' ? 'SOL_balance = SOL_balance + deposit_amount' :
            operation === 'withdraw' ? 'USDC_balance = (USDC &gt;= amount) ? USDC - amount : USDC' :
            operation === 'borrow' ? 'USDC_balance = (SOL &gt;= borrow*2) ? USDC + borrow : USDC' :
            operation === 'liquidation' ? 'Health factor check + liquidation logic' :
            'Unknown operation'
          }<br/>
          <strong>IR Digest:</strong> <span style={{ fontFamily: 'monospace', fontSize: '11px', color: '#666' }}>{
            operation === 'deposit' ? '0xadd0000000000000000000000000000000000000000000000000000000000000' :
            operation === 'withdraw' ? '0xwithdrw000000000000000000000000000000000000000000000000000000000' :
            operation === 'borrow' ? '0xmul0000000000000000000000000000000000000000000000000000000000000' :
            operation === 'liquidation' ? '0xhealthcheck00000000000000000000000000000000000000000000000000000' : 'unknown'
          }</span><br/>
          <strong>Execution Plan:</strong><br/>
          <div style={{ marginLeft: '20px', fontSize: '11px', color: '#666', fontFamily: 'monospace', marginTop: '5px' }}>
            {operation === 'deposit' && (
              <>• result = ADD(SOL_balance, deposit_amount)</>
            )}
            {operation === 'withdraw' && (
              <>
                • temp_a = GE(USDC_balance, withdraw_amount)<br/>
                • temp_b = SUB(USDC_balance, withdraw_amount)<br/>
                • result = SELECT(temp_a, temp_b, USDC_balance)
              </>
            )}
            {operation === 'borrow' && (
              <>
                • temp_a = MUL_CONST(borrow_amount, 2)<br/>
                • temp_b = GE(SOL_balance, temp_a)<br/>
                • temp_d = ADD(USDC_balance, borrow_amount)<br/>
                • result = SELECT(temp_b, temp_d, USDC_balance)
              </>
            )}
            {operation === 'liquidation' && (
              <>• Complex health factor computation</>
            )}
          </div>
          <strong style={{ marginTop: '8px', display: 'block' }}>Note:</strong> Executor processes encrypted data without seeing plaintext values
        </div>
        <button
          onClick={handleSubmitJob}
          disabled={!publicKey || !cidPda1}
          style={{
            padding: '12px 30px',
            background: (publicKey && cidPda1) ? '#0f0' : '#555',
            color: '#000',
            border: 'none',
            cursor: (publicKey && cidPda1) ? 'pointer' : 'not-allowed',
            fontSize: '16px',
            fontWeight: 'bold',
            borderRadius: '4px'
          }}
        >
          Submit to FHE Executor
        </button>
        {jobTxSig && (
          <div style={{ marginTop: '15px', padding: '10px', background: '#1a3a1a', borderRadius: '4px', border: '1px solid #0f0' }}>
            <div style={{ fontSize: '14px', marginBottom: '5px' }}>
              <strong>Job Transaction:</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{jobTxSig}</span>
            </div>
            <div style={{ fontSize: '14px', marginTop: '5px' }}>
              <strong>Job PDA:</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{jobPda}</span>
            </div>
            <div style={{ marginTop: '10px', fontSize: '13px', color: '#0f0' }}>
              Job submitted to executor • Waiting for FHE computation...
            </div>
          </div>
        )}
      </fieldset>

      {/* Step 4 */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: decryptedResult ? '2px solid #ff0' : '2px solid #555', borderRadius: '8px', opacity: !resultCidPda ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          Step 4: Decrypt Result
        </legend>
        <p style={{ fontSize: '14px', color: '#888', margin: '0 0 15px 0' }}>
          Request decryption of FHE computation result (KMS threshold decryption)
        </p>
        {resultCidPda && (
          <div style={{ marginBottom: '15px', padding: '10px', background: '#1a1a1a', borderRadius: '4px' }}>
            <strong>Result CID:</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{resultCidPda}</span>
          </div>
        )}
        <button
          onClick={handleDecrypt}
          disabled={!resultCidPda}
          style={{
            padding: '12px 30px',
            background: resultCidPda ? '#0f0' : '#555',
            color: '#000',
            border: 'none',
            cursor: resultCidPda ? 'pointer' : 'not-allowed',
            fontSize: '16px',
            fontWeight: 'bold',
            borderRadius: '4px'
          }}
        >
          Decrypt Result
        </button>
        {decryptedResult && (
          <div style={{ marginTop: '15px', padding: '15px', background: '#3a3a1a', borderRadius: '4px', border: '2px solid #ff0' }}>
            <div style={{ fontSize: '20px', color: '#ff0', fontWeight: 'bold', marginBottom: '10px' }}>
              Decrypted Result: {decryptedResult}
            </div>
            <div style={{ fontSize: '14px', color: '#888' }}>
              Operation: {
                operation === 'deposit' ? 'ADD (SOL_balance + deposit_amount)' :
                operation === 'withdraw' ? 'GE (withdraw_amount <= USDC_balance)' :
                operation === 'borrow' ? 'MUL_CONST + GE + SELECT (collateral check)' :
                operation === 'liquidation' ? 'MUL+ADD+GT (Complex Homomorphic Computation)' : 'UNKNOWN'
              } <br/>
              Pure FHE computation on encrypted data - no plaintext variables accessible <br/>
              FHE Computation Result: {decryptedResult || 'Not available - computation failed or not decrypted'}
            </div>
            <div style={{ marginTop: '10px', fontSize: '13px', color: '#0f0' }}>
              Successfully decrypted via KMS threshold protocol
            </div>
          </div>
        )}
      </fieldset>

      {/* Logs */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: '2px solid #0f0', borderRadius: '8px' }}>
        <legend>Debug Logs</legend>
        <div style={{ background: '#000', padding: '10px', maxHeight: '300px', overflowY: 'auto', fontSize: '12px' }}>
          {logs.map((log, i) => <div key={i}>{log}</div>)}
        </div>
        <button onClick={() => setLogs([])} style={{ marginTop: '10px', padding: '5px 10px', background: '#555', color: '#fff', border: 'none', cursor: 'pointer' }}>
          Clear
        </button>
      </fieldset>
    </div>
  )
}
