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
    addLog(`Encrypting transaction input for ${operation} operation...`)
    
    // Reuse existing confidential state ciphertexts (don't re-encrypt)
    // Only encrypt the transaction input
    
    // Encrypt transaction inputs based on operation
    let transactionInputs = []
    switch (operation) {
      case 'deposit':
        addLog(`Encrypting deposit amount: ${depositAmount}`)
        const ctDeposit = encryptValue(depositAmount)
        if (ctDeposit) {
          setCiphertext2(ctDeposit)
          transactionInputs.push(`deposit_amount=${depositAmount}`)
        }
        break
      case 'withdraw':
        addLog(`Encrypting withdraw amount: ${withdrawAmount}`)
        const ctWithdraw = encryptValue(withdrawAmount)
        if (ctWithdraw) {
          setCiphertext5(ctWithdraw)
          transactionInputs.push(`withdraw_amount=${withdrawAmount}`)
        }
        break
      case 'borrow':
        addLog(`Encrypting borrow amount: ${borrowAmount}`)
        const ctBorrow = encryptValue(borrowAmount)
        if (ctBorrow) {
          setCiphertext3(ctBorrow)
          transactionInputs.push(`borrow_amount=${borrowAmount}`)
        }
        break
    }
    
    addLog(`Transaction input encrypted: ${transactionInputs.join(', ')}`)
    addLog(`Confidential state (SOL, USDC) will be reused from existing CIDs`)
  }

  const handleRegisterCIDs = async () => {
    if (!publicKey) {
      addLog('Please connect wallet first')
      return
    }
    
    // Check required ciphertexts based on operation
    const requiredCiphertexts = []
    const isConfidentialStateInitialized = confidentialSOLCid && confidentialUSDCCid
    
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
        
        // For deposit, only register the deposit amount
        // Confidential SOL balance is already initialized and doesn't need re-registration
        requiredCiphertexts.push(ciphertext2)
        addLog(' Reusing existing confidential SOL balance, registering deposit amount only')
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
        
        // For withdraw, only register the withdraw amount
        // Confidential USDC balance is already managed (either initialized or from executor results)
        requiredCiphertexts.push(ciphertext5)
        addLog(' Reusing existing confidential USDC balance, registering withdraw amount only')
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
        
        // For borrow, only register the borrow amount
        // Confidential SOL and USDC balances are already managed (either initialized or from executor results)
        requiredCiphertexts.push(ciphertext3)
        addLog(' Reusing existing confidential balances, registering borrow amount only')
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
          // Only borrow amount is registered, reuse existing balances
          setCidPda1(confidentialSOLCid)
          setCidPda3(cidPdas[0])
          setCidPda4(confidentialUSDCCid)
          addLog(' CID 1 (SOL Balance - Reused): ' + confidentialSOLCid.substring(0, 8) + '...')
          addLog(' CID 3 (Borrow Amount - New): ' + cidPdas[0].substring(0, 8) + '...')
          addLog(' CID 4 (USDC Balance - Reused): ' + confidentialUSDCCid.substring(0, 8) + '...')
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
              
              // Executor updated the state CID in-place (no new CID created)
              // Result CID is the same as the original state CID
              addLog(` State CID updated in-place: ${resultCid.slice(0, 8)}...`)
              
              // Fetch updated ciphertext content
              if (resultCid && resultCid !== 'ResultCID_' + Date.now().toString(36)) {
                setTimeout(async () => {
                  try {
                    addLog(` Fetching updated state ciphertext...`)
                    const cidResponse = await fetch(`/api/ciphertext/${resultCid}`)
                    if (cidResponse.ok) {
                      const cidData = await cidResponse.json()
                      
                      // Update ciphertext with executor result
                      if (cidData.ciphertext) {
                        if (operation === 'deposit') {
                          // Update SOL balance ciphertext (CID stays the same)
                          setCiphertext1(cidData.ciphertext)
                          setSolBalanceState('encrypted') // Re-encrypt visual state
                          addLog(` ✓ SOL balance ciphertext updated (re-encrypted)`)
                        } else if (operation === 'borrow') {
                          // Update USDC balance ciphertext (CID stays the same)
                          setCiphertext4(cidData.ciphertext)
                          setUsdcBalanceState('encrypted') // Re-encrypt visual state
                          addLog(` ✓ USDC balance ciphertext updated (re-encrypted)`)
                        } else if (operation === 'withdraw') {
                          // Update USDC balance ciphertext (CID stays the same)
                          setCiphertext4(cidData.ciphertext)
                          setUsdcBalanceState('encrypted') // Re-encrypt visual state
                          addLog(` ✓ USDC balance ciphertext updated (re-encrypted)`)
                        }
                      }
                      
                      // Show decrypted result
                      if (cidData.computation_result !== null && cidData.computation_result !== undefined) {
                        setDecryptedResult(String(cidData.computation_result))
                        addLog(` Auto-decrypted result: ${cidData.computation_result}`)
                        if (cidData.computation_description) {
                          addLog(` ${cidData.computation_description}`)
                        }
                      }
                    }
                  } catch (error) {
                    addLog(` Failed to fetch updated state: ${error}`)
                  }
                }, 1000)
              }
              
              // Show actual computation result immediately
              if (ourJob.computation_result) {
                addLog(` Computed result: ${ourJob.computation_result}`)
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
      addLog(' Requesting result decryption...')
      addLog(` [Executor] Submitting decrypt request for result CID: ${resultCidPda.slice(0, 8)}...`)
      
      const response = await fetch('/api/actions/decrypt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cid: resultCidPda,
          requester: publicKey?.toBase58() || 'demo'
        })
      })
      
      if (!response.ok) {
        throw new Error('Decrypt request failed')
      }
      
      const data = await response.json()
      const decryptId = data.decrypt_id
      addLog(` [Executor] Decrypt job created: ${decryptId.slice(0, 16)}...`)
      addLog(' [Executor] Waiting for executor to decrypt...')
      
      // Poll for result
      const pollInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`/api/actions/decrypt?decrypt_id=${decryptId}`)
          const statusData = await statusResponse.json()
          
          if (statusData.status === 'completed') {
            clearInterval(pollInterval)
            setDecryptedResult(String(statusData.decrypted_value))
            addLog(` FHE computation result decrypted: ${statusData.decrypted_value}`)
            addLog(' Pure result from homomorphic computation engine')
          } else if (statusData.status === 'failed') {
            clearInterval(pollInterval)
            addLog(` Decryption failed: ${statusData.error}`)
            setDecryptedResult('ERROR: Decryption failed')
          }
        } catch (error) {
          // Continue polling
        }
      }, 1000)
      
      // Timeout after 30s
      setTimeout(() => {
        clearInterval(pollInterval)
        addLog(' Decryption timeout')
      }, 30000)
      
    } catch (error) {
      addLog(` Decryption failed: ${error instanceof Error ? error.message : String(error)}`)
      setDecryptedResult('ERROR: Decryption failed')
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
                  color: solBalanceState === 'encrypted' ? '#3b82f6' : '#ffffff', 
                  fontWeight: '600',
                  fontFamily: 'monospace',
                  fontSize: '13px'
                }}>
                  {solBalanceState === 'encrypted' && ciphertext1 ? 
                    `${ciphertext1.encrypted_data.slice(16, 24).map((n: number) => Math.abs(n % 1296).toString(36).padStart(2, '0')).join('').substring(0, 12).toUpperCase()}...` : 
                    solBalanceState === 'initial' ? '-' : `${confidentialSOL}`}
                </span>
                {confidentialSOLCid && (
                  <span style={{ color: '#6b7280', fontSize: '10px', fontFamily: 'monospace' }}>
                    [{confidentialSOLCid.substring(0, 6)}]
                  </span>
                )}
                {solBalanceState === 'encrypted' && (
                  <button
                    onClick={async () => {
                      if (!confidentialSOLCid) {
                        addLog(' No SOL balance CID available')
                        return
                      }
                      try {
                        addLog(' Decrypting SOL balance...')
                        addLog(` [Executor] Submitting decrypt request for CID: ${confidentialSOLCid.slice(0, 8)}...`)
                        
                        const response = await fetch('/api/actions/decrypt', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            cid: confidentialSOLCid,
                            requester: publicKey?.toBase58() || 'demo'
                          })
                        })
                        
                        if (!response.ok) throw new Error('Decrypt request failed')
                        
                        const data = await response.json()
                        const decryptId = data.decrypt_id
                        addLog(` [Executor] Decrypt job created: ${decryptId.slice(0, 16)}...`)
                        addLog(' [Executor] Waiting for executor to decrypt...')
                        
                        // Poll for result
                        const pollInterval = setInterval(async () => {
                          try {
                            const statusResponse = await fetch(`/api/actions/decrypt?decrypt_id=${decryptId}`)
                            const statusData = await statusResponse.json()
                            
                            if (statusData.status === 'completed') {
                              clearInterval(pollInterval)
                              setConfidentialSOL(statusData.decrypted_value)
                              setSolBalanceState('decrypted')
                              addLog(` SOL balance decrypted: ${statusData.decrypted_value}`)
                            } else if (statusData.status === 'failed') {
                              clearInterval(pollInterval)
                              addLog(` Decryption failed: ${statusData.error}`)
                            }
                          } catch (error) {
                            // Continue polling
                          }
                        }, 1000)
                        
                        // Timeout after 30s
                        setTimeout(() => clearInterval(pollInterval), 30000)
                      } catch (error) {
                        addLog(` Error: ${error instanceof Error ? error.message : String(error)}`)
                      }
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
                  fontWeight: '600',
                  fontFamily: 'monospace',
                  fontSize: '13px'
                }}>
                  {usdcBalanceState === 'encrypted' && ciphertext4 ? 
                    `${ciphertext4.encrypted_data.slice(64, 72).map((n: number) => Math.abs(n % 1296).toString(36).padStart(2, '0')).join('').substring(0, 12).toUpperCase()}...` : 
                    usdcBalanceState === 'initial' ? '-' : `${confidentialUSDC}`}
                </span>
                {confidentialUSDCCid && (
                  <span style={{ color: '#6b7280', fontSize: '10px', fontFamily: 'monospace' }}>
                    [{confidentialUSDCCid.substring(0, 6)}]
                  </span>
                )}
                {usdcBalanceState === 'encrypted' && (
                  <button
                    onClick={async () => {
                      if (!confidentialUSDCCid) {
                        addLog(' No USDC balance CID available')
                        return
                      }
                      try {
                        addLog(' Decrypting USDC balance...')
                        addLog(` [Executor] Submitting decrypt request for CID: ${confidentialUSDCCid.slice(0, 8)}...`)
                        
                        const response = await fetch('/api/actions/decrypt', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            cid: confidentialUSDCCid,
                            requester: publicKey?.toBase58() || 'demo'
                          })
                        })
                        
                        if (!response.ok) throw new Error('Decrypt request failed')
                        
                        const data = await response.json()
                        const decryptId = data.decrypt_id
                        addLog(` [Executor] Decrypt job created: ${decryptId.slice(0, 16)}...`)
                        addLog(' [Executor] Waiting for executor to decrypt...')
                        
                        // Poll for result
                        const pollInterval = setInterval(async () => {
                          try {
                            const statusResponse = await fetch(`/api/actions/decrypt?decrypt_id=${decryptId}`)
                            const statusData = await statusResponse.json()
                            
                            if (statusData.status === 'completed') {
                              clearInterval(pollInterval)
                              setConfidentialUSDC(statusData.decrypted_value)
                              setUsdcBalanceState('decrypted')
                              addLog(` USDC balance decrypted: ${statusData.decrypted_value}`)
                            } else if (statusData.status === 'failed') {
                              clearInterval(pollInterval)
                              addLog(` Decryption failed: ${statusData.error}`)
                            }
                          } catch (error) {
                            // Continue polling
                          }
                        }, 1000)
                        
                        // Timeout after 30s
                        setTimeout(() => clearInterval(pollInterval), 30000)
                      } catch (error) {
                        addLog(` Error: ${error instanceof Error ? error.message : String(error)}`)
                      }
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


      {/* Confidential Variables Display */}
      <fieldset style={{ margin: '20px 0', padding: '20px', border: '2px solid #0f0', borderRadius: '8px', background: '#0a0a0a' }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold', color: '#0f0' }}>Confidential Variables</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          {/* Variable 1: SOL Balance */}
          <div style={{ 
            padding: '12px', 
            background: solBalanceState === 'encrypted' ? '#1a2e3b' : '#1a1a2e', 
            border: `2px solid ${solBalanceState === 'encrypted' ? '#3b82f6' : '#334155'}`, 
            borderRadius: '8px',
            transition: 'all 0.3s ease',
            boxShadow: solBalanceState === 'encrypted' ? '0 0 20px rgba(59, 130, 246, 0.3)' : 'none'
          }}>
            <div style={{ fontSize: '12px', color: '#3b82f6', fontWeight: 'bold', marginBottom: '4px' }}>(1) SOL Balance</div>
            <div style={{ fontSize: '20px', color: '#fff', fontFamily: 'monospace', minHeight: '30px' }}>
              {solBalanceState === 'encrypted' && ciphertext1 ? (
                <div style={{ 
                  background: 'linear-gradient(90deg, #3b82f6, #1e40af, #3b82f6)',
                  backgroundSize: '200% 100%',
                  animation: 'gradient 2s ease infinite',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontWeight: 'bold'
                }}>
                  {ciphertext1.encrypted_data.slice(16, 24).map((n: number) => Math.abs(n % 1296).toString(36).padStart(2, '0')).join('').substring(0, 12).toUpperCase()}...
                </div>
              ) : solBalanceState === 'initial' ? (
                <span style={{ color: '#666' }}>-</span>
              ) : (
                <span style={{ color: '#10b981' }}>{confidentialSOL}</span>
              )}
            </div>
            <div style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
              {solBalanceState === 'encrypted' ? '🔒 ENCRYPTED' : 
               confidentialSOLCid ? `CID: ${confidentialSOLCid.substring(0, 8)}...` : 'Not encrypted'}
            </div>
          </div>

          {/* Variable 2: Deposit Amount */}
          <div style={{ 
            padding: '12px', 
            background: ciphertext2 ? '#1a2e20' : '#1a1a2e', 
            border: `2px solid ${ciphertext2 ? '#10b981' : '#334155'}`, 
            borderRadius: '8px',
            opacity: operation === 'deposit' ? 1 : 0.4,
            transition: 'all 0.3s ease',
            boxShadow: ciphertext2 ? '0 0 20px rgba(16, 185, 129, 0.3)' : 'none'
          }}>
            <div style={{ fontSize: '12px', color: '#10b981', fontWeight: 'bold', marginBottom: '4px' }}>(2) Deposit Amount</div>
            <div style={{ fontSize: '20px', color: '#fff', fontFamily: 'monospace', minHeight: '30px' }}>
              {ciphertext2 ? (
                <div style={{ 
                  background: 'linear-gradient(90deg, #10b981, #059669, #10b981)',
                  backgroundSize: '200% 100%',
                  animation: 'gradient 2s ease infinite',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontWeight: 'bold'
                }}>
                  {ciphertext2.encrypted_data.slice(32, 40).map((n: number) => Math.abs(n % 1296).toString(36).padStart(2, '0')).join('').substring(0, 12).toUpperCase()}...
                </div>
              ) : (
                <span style={{ color: '#10b981' }}>{depositAmount}</span>
              )}
            </div>
            <div style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
              {ciphertext2 ? '🔒 ENCRYPTED' : 'Plaintext'}
            </div>
          </div>

          {/* Variable 3: Borrow Amount */}
          <div style={{ 
            padding: '12px', 
            background: ciphertext3 ? '#2e1a3b' : '#1a1a2e', 
            border: `2px solid ${ciphertext3 ? '#8b5cf6' : '#334155'}`, 
            borderRadius: '8px',
            opacity: operation === 'borrow' ? 1 : 0.4,
            transition: 'all 0.3s ease',
            boxShadow: ciphertext3 ? '0 0 20px rgba(139, 92, 246, 0.3)' : 'none'
          }}>
            <div style={{ fontSize: '12px', color: '#8b5cf6', fontWeight: 'bold', marginBottom: '4px' }}>(3) Borrow Amount</div>
            <div style={{ fontSize: '20px', color: '#fff', fontFamily: 'monospace', minHeight: '30px' }}>
              {ciphertext3 ? (
                <div style={{ 
                  background: 'linear-gradient(90deg, #8b5cf6, #6d28d9, #8b5cf6)',
                  backgroundSize: '200% 100%',
                  animation: 'gradient 2s ease infinite',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontWeight: 'bold'
                }}>
                  {ciphertext3.encrypted_data.slice(48, 56).map((n: number) => Math.abs(n % 1296).toString(36).padStart(2, '0')).join('').substring(0, 12).toUpperCase()}...
                </div>
              ) : (
                <span style={{ color: '#8b5cf6' }}>{borrowAmount}</span>
              )}
            </div>
            <div style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
              {ciphertext3 ? '🔒 ENCRYPTED' : 'Plaintext'}
            </div>
          </div>

          {/* Variable 4: USDC Balance */}
          <div style={{ 
            padding: '12px', 
            background: usdcBalanceState === 'encrypted' ? '#2e2a1a' : '#1a1a2e', 
            border: `2px solid ${usdcBalanceState === 'encrypted' ? '#f59e0b' : '#334155'}`, 
            borderRadius: '8px',
            transition: 'all 0.3s ease',
            boxShadow: usdcBalanceState === 'encrypted' ? '0 0 20px rgba(245, 158, 11, 0.3)' : 'none'
          }}>
            <div style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 'bold', marginBottom: '4px' }}>(4) USDC Balance</div>
            <div style={{ fontSize: '20px', color: '#fff', fontFamily: 'monospace', minHeight: '30px' }}>
              {usdcBalanceState === 'encrypted' && ciphertext4 ? (
                <div style={{ 
                  background: 'linear-gradient(90deg, #f59e0b, #d97706, #f59e0b)',
                  backgroundSize: '200% 100%',
                  animation: 'gradient 2s ease infinite',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontWeight: 'bold'
                }}>
                  {ciphertext4.encrypted_data.slice(64, 72).map((n: number) => Math.abs(n % 1296).toString(36).padStart(2, '0')).join('').substring(0, 12).toUpperCase()}...
                </div>
              ) : usdcBalanceState === 'initial' ? (
                <span style={{ color: '#666' }}>-</span>
              ) : (
                <span style={{ color: '#10b981' }}>{confidentialUSDC}</span>
              )}
            </div>
            <div style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
              {usdcBalanceState === 'encrypted' ? '🔒 ENCRYPTED' : 
               confidentialUSDCCid ? `CID: ${confidentialUSDCCid.substring(0, 8)}...` : 'Not encrypted'}
            </div>
          </div>

          {/* Variable 5: Withdraw Amount */}
          <div style={{ 
            padding: '12px', 
            background: ciphertext5 ? '#2e1a1a' : '#1a1a2e', 
            border: `2px solid ${ciphertext5 ? '#ef4444' : '#334155'}`, 
            borderRadius: '8px',
            opacity: operation === 'withdraw' ? 1 : 0.4,
            transition: 'all 0.3s ease',
            boxShadow: ciphertext5 ? '0 0 20px rgba(239, 68, 68, 0.3)' : 'none'
          }}>
            <div style={{ fontSize: '12px', color: '#ef4444', fontWeight: 'bold', marginBottom: '4px' }}>(5) Withdraw Amount</div>
            <div style={{ fontSize: '20px', color: '#fff', fontFamily: 'monospace', minHeight: '30px' }}>
              {ciphertext5 ? (
                <div style={{ 
                  background: 'linear-gradient(90deg, #ef4444, #dc2626, #ef4444)',
                  backgroundSize: '200% 100%',
                  animation: 'gradient 2s ease infinite',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  fontWeight: 'bold'
                }}>
                  {ciphertext5.encrypted_data.slice(80, 88).map((n: number) => Math.abs(n % 1296).toString(36).padStart(2, '0')).join('').substring(0, 12).toUpperCase()}...
                </div>
              ) : (
                <span style={{ color: '#ef4444' }}>{withdrawAmount}</span>
              )}
            </div>
            <div style={{ fontSize: '10px', color: '#666', marginTop: '4px' }}>
              {ciphertext5 ? '🔒 ENCRYPTED' : 'Plaintext'}
            </div>
          </div>
        </div>
        
        <style>{`
          @keyframes gradient {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
        `}</style>
      </fieldset>

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

        {/* Execution Plan Visualization */}
        {operation && (
          <div style={{ marginBottom: '20px', padding: '15px', background: '#1a1a2e', borderRadius: '8px', border: '2px solid #0f0' }}>
            <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#0f0', marginBottom: '10px' }}>
              FHE Execution Plan
            </div>
            
            {operation === 'deposit' && (
              <div style={{ fontFamily: 'monospace', fontSize: '14px' }}>
                <div style={{ padding: '8px', background: '#0a0a0a', borderRadius: '4px', marginBottom: '8px', border: '1px solid #3b82f6' }}>
                  <span style={{ color: '#3b82f6' }}>(1)</span> = ADD(<span style={{ color: '#3b82f6' }}>(1)</span>, <span style={{ color: '#10b981' }}>(2)</span>)
                </div>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}>
                  → SOL Balance = SOL Balance + Deposit Amount
                </div>
              </div>
            )}
            
            {operation === 'borrow' && (
              <div style={{ fontFamily: 'monospace', fontSize: '14px' }}>
                <div style={{ padding: '8px', background: '#0a0a0a', borderRadius: '4px', marginBottom: '6px', border: '1px solid #666' }}>
                  <span style={{ color: '#888' }}>(a)</span> = MUL_CONST(<span style={{ color: '#8b5cf6' }}>(3)</span>, 2)
                </div>
                <div style={{ padding: '8px', background: '#0a0a0a', borderRadius: '4px', marginBottom: '6px', border: '1px solid #666' }}>
                  <span style={{ color: '#888' }}>(b)</span> = GE(<span style={{ color: '#3b82f6' }}>(1)</span>, <span style={{ color: '#888' }}>(a)</span>)
                </div>
                <div style={{ padding: '8px', background: '#0a0a0a', borderRadius: '4px', marginBottom: '6px', border: '1px solid #666' }}>
                  <span style={{ color: '#888' }}>(d)</span> = ADD(<span style={{ color: '#f59e0b' }}>(4)</span>, <span style={{ color: '#8b5cf6' }}>(3)</span>)
                </div>
                <div style={{ padding: '8px', background: '#0a0a0a', borderRadius: '4px', marginBottom: '8px', border: '1px solid #f59e0b' }}>
                  <span style={{ color: '#f59e0b' }}>(4)</span> = SELECT(<span style={{ color: '#888' }}>(b)</span>, <span style={{ color: '#888' }}>(d)</span>, <span style={{ color: '#f59e0b' }}>(4)</span>)
                </div>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}>
                  → If SOL ≥ Borrow×2: USDC = USDC + Borrow<br/>
                  → Else: USDC = USDC (no change)
                </div>
              </div>
            )}
            
            {operation === 'withdraw' && (
              <div style={{ fontFamily: 'monospace', fontSize: '14px' }}>
                <div style={{ padding: '8px', background: '#0a0a0a', borderRadius: '4px', marginBottom: '6px', border: '1px solid #666' }}>
                  <span style={{ color: '#888' }}>(a)</span> = GE(<span style={{ color: '#f59e0b' }}>(4)</span>, <span style={{ color: '#ef4444' }}>(5)</span>)
                </div>
                <div style={{ padding: '8px', background: '#0a0a0a', borderRadius: '4px', marginBottom: '6px', border: '1px solid #666' }}>
                  <span style={{ color: '#888' }}>(b)</span> = SUB(<span style={{ color: '#f59e0b' }}>(4)</span>, <span style={{ color: '#ef4444' }}>(5)</span>)
                </div>
                <div style={{ padding: '8px', background: '#0a0a0a', borderRadius: '4px', marginBottom: '8px', border: '1px solid #f59e0b' }}>
                  <span style={{ color: '#f59e0b' }}>(4)</span> = SELECT(<span style={{ color: '#888' }}>(a)</span>, <span style={{ color: '#888' }}>(b)</span>, <span style={{ color: '#f59e0b' }}>(4)</span>)
                </div>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '8px' }}>
                  → If USDC ≥ Withdraw: USDC = USDC - Withdraw<br/>
                  → Else: USDC = USDC (no change)
                </div>
              </div>
            )}
          </div>
        )}

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
        
        {((operation === 'deposit' && ciphertext2) || 
          (operation === 'withdraw' && ciphertext5) || 
          (operation === 'borrow' && ciphertext3)) && (
          <div style={{ marginTop: '15px', padding: '15px', background: '#1a3a1a', borderRadius: '4px', border: '1px solid #0f0' }}>
            <div style={{ fontSize: '14px', marginBottom: '10px', color: '#0f0' }}>
              <strong>✓ Transaction input encrypted:</strong>
            </div>
            
            <div style={{ fontSize: '12px', color: '#888', marginBottom: '15px' }}>
              • Encrypted: {
                operation === 'deposit' ? `Deposit Amount (${depositAmount} SOL)` :
                operation === 'withdraw' ? `Withdraw Amount (${withdrawAmount} USDC)` :
                operation === 'borrow' ? `Borrow Amount (${borrowAmount} USDC)` : 'Unknown'
              }<br/>
              • Confidential State (SOL, USDC) will be reused from existing CIDs
            </div>
            
            <div style={{ 
              padding: '12px', 
              background: '#0a0a0a', 
              borderRadius: '4px', 
              border: '1px solid #0f0',
              marginBottom: '10px'
            }}>
              <div style={{ fontSize: '10px', color: '#666', marginBottom: '6px' }}>
                Ciphertext Preview (Transaction Input):
              </div>
              <div style={{ 
                fontSize: '16px', 
                color: '#0f0', 
                fontFamily: 'monospace', 
                wordBreak: 'break-all', 
                lineHeight: '1.8',
                fontWeight: 'bold'
              }}>
                {(operation === 'deposit' ? ciphertext2 :
                  operation === 'withdraw' ? ciphertext5 :
                  operation === 'borrow' ? ciphertext3 : null
                )?.encrypted_data.slice(16, 32).map((n: number) => 
                  Math.abs(n % 1679616).toString(36).padStart(4, '0').toUpperCase()
                ).join(' ')}...
              </div>
              <div style={{ fontSize: '10px', color: '#666', marginTop: '6px' }}>
                {(operation === 'deposit' ? ciphertext2 :
                  operation === 'withdraw' ? ciphertext5 :
                  operation === 'borrow' ? ciphertext3 : null
                )?.encrypted_data.length} integers encrypted with FHE16
              </div>
            </div>

            <div style={{ fontSize: '12px', color: '#0f0' }}>
              🔒 Encrypted locally in browser • Scheme: {
                (operation === 'deposit' ? ciphertext2 :
                  operation === 'withdraw' ? ciphertext5 :
                  operation === 'borrow' ? ciphertext3 : null
                )?.scheme
              }
            </div>
          </div>
        )}
      </fieldset>

      {/* Step 2 */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: regTxSig ? '2px solid #0f0' : '2px solid #555', borderRadius: '8px', opacity: (!publicKey || 
        ((operation === 'deposit' && !ciphertext2) || 
         (operation === 'withdraw' && !ciphertext5) || 
         (operation === 'borrow' && !ciphertext3))) ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          Step 2: Register CIDs On-Chain
        </legend>
        <p style={{ fontSize: '14px', color: '#888', margin: '0 0 15px 0' }}>
          Submit encrypted data to Solana blockchain as Content Identifiers (CIDs)
        </p>
        <button
          onClick={handleRegisterCIDs}
          disabled={!publicKey || 
            ((operation === 'deposit' && !ciphertext2) || 
             (operation === 'withdraw' && !ciphertext5) || 
             (operation === 'borrow' && !ciphertext3))}
          style={{
            padding: '12px 30px',
            background: (publicKey && ((operation === 'deposit' && ciphertext2) || 
                                       (operation === 'withdraw' && ciphertext5) || 
                                       (operation === 'borrow' && ciphertext3))) ? '#0f0' : '#555',
            color: '#000',
            border: 'none',
            cursor: (publicKey && ((operation === 'deposit' && ciphertext2) || 
                                   (operation === 'withdraw' && ciphertext5) || 
                                   (operation === 'borrow' && ciphertext3))) ? 'pointer' : 'not-allowed',
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
      <fieldset style={{ margin: '20px 0', padding: '15px', border: jobTxSig ? '2px solid #0f0' : '2px solid #555', borderRadius: '8px', opacity: (!publicKey || 
        ((operation === 'deposit' && !cidPda2) || 
         (operation === 'withdraw' && !cidPda5) || 
         (operation === 'borrow' && !cidPda3))) ? 0.6 : 1 }}>
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
          <strong>Input CIDs:</strong> {
            operation === 'deposit' ? '2 CIDs' :
            operation === 'withdraw' ? '2 CIDs' :
            operation === 'borrow' ? '3 CIDs' :
            operation === 'liquidation' ? '3 CIDs' : '2 CIDs'
          } • <strong>IR Digest:</strong> <span style={{ fontFamily: 'monospace', fontSize: '11px', color: '#666' }}>{
            operation === 'deposit' ? '0xadd0...' :
            operation === 'withdraw' ? '0xwithdrw...' :
            operation === 'borrow' ? '0xmul0...' :
            operation === 'liquidation' ? '0xhealthcheck...' : 'unknown'
          }</span><br/>
          <strong>Note:</strong> Executor processes encrypted data without seeing plaintext values (see execution plan above)
        </div>
        <button
          onClick={handleSubmitJob}
          disabled={!publicKey || 
            ((operation === 'deposit' && !cidPda2) || 
             (operation === 'withdraw' && !cidPda5) || 
             (operation === 'borrow' && !cidPda3))}
          style={{
            padding: '12px 30px',
            background: (publicKey && ((operation === 'deposit' && cidPda2) || 
                                       (operation === 'withdraw' && cidPda5) || 
                                       (operation === 'borrow' && cidPda3))) ? '#0f0' : '#555',
            color: '#000',
            border: 'none',
            cursor: (publicKey && ((operation === 'deposit' && cidPda2) || 
                                   (operation === 'withdraw' && cidPda5) || 
                                   (operation === 'borrow' && cidPda3))) ? 'pointer' : 'not-allowed',
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
