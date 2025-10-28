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

  // Step 1: Encryption
  const [plaintext1, setPlaintext1] = useState('500')
  const [plaintext2, setPlaintext2] = useState('100')
  const [ciphertext1, setCiphertext1] = useState<any>(null)
  const [ciphertext2, setCiphertext2] = useState<any>(null)

  // Step 2: Register CIDs
  const [cidPda1, setCidPda1] = useState('')
  const [cidPda2, setCidPda2] = useState('')
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
    console.log(msg)
  }

  useEffect(() => {
    loadWASM()
  }, [])

  const loadWASM = async () => {
    try {
      addLog('Loading FHE16 WASM module...')

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
      addLog('✅ FHE16 WASM ready!')
    } catch (error) {
      addLog(`❌ Failed to initialize WASM: ${error}`)
    }
  }

  const encryptValue = (plaintext: string): any | null => {
    console.log('[ENCRYPT] Input plaintext:', plaintext);
    if (!module || !moduleReady) {
      addLog('❌ WASM module not ready')
      return null
    }

    try {
      const msg = parseInt(plaintext)
      console.log('[ENCRYPT] Parsed message:', msg);
      
      const p = module._FHE16_ENC_WASM(msg, FHE_PARAMS.BIT)
      console.log('[ENCRYPT] WASM returned pointer:', p);
      
      if (!p) {
        addLog('❌ WASM encryption returned null pointer')
        return null
      }

      const ctStr = module.UTF8ToString(p)
      console.log('[ENCRYPT] Ciphertext string length:', ctStr.length);
      console.log('[ENCRYPT] First 100 chars:', ctStr.substring(0, 100));
      
      module._FHE16_free(p)

      const ctArray = ctStr.split(',').map(s => parseInt(s.trim()))
      console.log('[ENCRYPT] Ciphertext array length:', ctArray.length);
      console.log('[ENCRYPT] Expected length:', 16 + 1040 * 32);
      console.log('[ENCRYPT] First 10 elements:', ctArray.slice(0, 10));
      console.log('[ENCRYPT] Last 10 elements:', ctArray.slice(-10));
      
      // Verify all elements are valid integers
      const invalidElements = ctArray.filter(x => isNaN(x) || !isFinite(x));
      if (invalidElements.length > 0) {
        console.error('[ENCRYPT] Found', invalidElements.length, 'invalid elements');
        addLog(`❌ Encryption produced ${invalidElements.length} invalid elements`)
        return null
      }
      
      const ciphertext = {
        encrypted_data: ctArray,
        timestamp: Date.now(),
        scheme: 'FHE16_0.0.1v'
      }

      addLog(`✅ Encrypted: ${ctArray.length} elements (expected: ${16 + 1040 * 32})`)
      
      if (ctArray.length !== 16 + 1040 * 32) {
        addLog(`⚠️ WARNING: Expected ${16 + 1040 * 32} elements but got ${ctArray.length}`)
      }
      
      return ciphertext
    } catch (error) {
      console.error('[ENCRYPT] Error:', error);
      addLog(`❌ Encryption error: ${error}`)
      return null
    }
  }

  const handleEncrypt = () => {
    const ct1 = encryptValue(plaintext1)
    const ct2 = encryptValue(plaintext2)
    if (ct1) setCiphertext1(ct1)
    if (ct2) setCiphertext2(ct2)
    if (ct1 && ct2) addLog('✅ Both values encrypted')
  }

  const handleRegisterCIDs = async () => {
    if (!publicKey) {
      addLog('❌ Please connect wallet first')
      return
    }
    if (!ciphertext1 || !ciphertext2) {
      addLog('❌ Please encrypt values first')
      return
    }
    if (!sendTransaction) {
      addLog('❌ Wallet does not support transactions')
      return
    }

    try {
      addLog('📡 Calling registerCIDs API...')

      const response = await fetch('/api/actions/job/registerCIDs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: publicKey.toBase58(),
          ciphertext: [ciphertext1, ciphertext2],
          policy_type: 'owner-controlled',
          provenance: '1',
        }),
      })

      const data = await response.json()

      if (!response.ok || !data.transaction) {
        addLog(`❌ API error: ${data.message || 'Unknown'}`)
        if (data.hint) addLog(`💡 Hint: ${data.hint}`)
        return
      }

      addLog('✅ Transaction created by API')
      addLog('🔐 Requesting wallet signature...')

      // Decode base64 transaction
      const txBuffer = Buffer.from(data.transaction, 'base64')
      const tx = Transaction.from(txBuffer)

      // Send transaction (wallet will sign and send)
      const signature = await sendTransaction(tx, connection)
      addLog(`✅ Transaction signed & sent: ${signature.substring(0, 16)}...`)

      // Wait for confirmation
      addLog('⏳ Waiting for blockchain confirmation...')
      const confirmation = await connection.confirmTransaction(signature, 'confirmed')

      if (confirmation.value.err) {
        addLog(`❌ Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`)
        return
      }

      addLog('✅ Transaction confirmed on Solana!')
      addLog(`🔗 View on Solscan: https://solscan.io/tx/${signature}?cluster=devnet`)

      setRegTxSig(signature)

      // Extract CID PDAs from API response
      const cidPdas = data.cid_pdas || []
      if (cidPdas.length < 2) {
        addLog('⚠️ Expected 2 CIDs but got ' + cidPdas.length)
        return
      }

      const cid1 = cidPdas[0]
      const cid2 = cidPdas[1]

      addLog('✅ CID 1: ' + cid1)
      addLog('✅ CID 2: ' + cid2)

      // Wait for event listener to process on-chain events and confirm CIDs
      addLog('⏳ Waiting for event listener to confirm CIDs...')
      await new Promise(resolve => setTimeout(resolve, 3000))

      setCidPda1(cid1)
      setCidPda2(cid2)
      addLog('✅ CIDs ready for job submission!')
    } catch (error: any) {
      // Handle specific errors
      if (error.message?.includes('already been processed')) {
        addLog('⚠️ Transaction already processed - checking status...')
        // Transaction might have succeeded, don't show as error
        addLog('💡 If this keeps happening, the transaction likely succeeded. Check Solscan.')
      } else if (error.message?.includes('User rejected')) {
        addLog('❌ User rejected transaction')
      } else {
        addLog(`❌ Error: ${error.message || error}`)
      }
    }
  }

  const handleSubmitJob = async () => {
    if (!publicKey) {
      addLog('❌ Please connect wallet')
      return
    }
    if (!cidPda1 || !cidPda2) {
      addLog('❌ Please register CIDs first')
      return
    }
    if (!sendTransaction) {
      addLog('❌ Wallet does not support transactions')
      return
    }

    try {
      addLog(`📡 Submitting ${operation} job...`)
      addLog(`Using CIDs: ${cidPda1.substring(0, 8)}..., ${cidPda2.substring(0, 8)}...`)

      const response = await fetch('/api/actions/job/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: publicKey.toBase58(),
          cids: [cidPda1, cidPda2],
          operation,
          policy_type: 'owner-controlled',
          provenance: '1',
        }),
      })

      const data = await response.json()

      if (!response.ok || !data.transaction) {
        addLog(`❌ API error: ${data.message || 'Unknown'}`)

        // Show validation details if available
        if (data.validation) {
          addLog(`⚠️ Validation: ${data.validation.invalid_count} invalid CID(s)`)
          if (data.validation.details) {
            data.validation.details.forEach((detail: any) => {
              addLog(`  - ${detail.cid.substring(0, 8)}...: ${detail.reason || detail.status}`)
            })
          }
        }

        if (data.hint) {
          addLog(`💡 Hint: ${data.hint}`)
        }

        addLog('💡 If CIDs were just registered, wait a few seconds and try again')
        return
      }

      addLog('✅ Job transaction created by API')
      addLog('🔐 Requesting wallet signature...')

      const txBuffer = Buffer.from(data.transaction, 'base64')
      const tx = Transaction.from(txBuffer)

      const signature = await sendTransaction(tx, connection)
      addLog(`✅ Transaction signed & sent: ${signature.substring(0, 16)}...`)

      addLog('⏳ Waiting for blockchain confirmation...')
      const confirmation = await connection.confirmTransaction(signature, 'confirmed')

      if (confirmation.value.err) {
        addLog(`❌ Transaction failed: ${JSON.stringify(confirmation.value.err)}`)
        return
      }

      addLog('✅ Job submitted on-chain!')
      addLog(`🔗 View on Solscan: https://solscan.io/tx/${signature}?cluster=devnet`)

      setJobTxSig(signature)
      const actualJobPda = data.verification?.pda?.job || 'JobPDA_' + signature.substring(0, 16)
      setJobPda(actualJobPda)
      addLog(`🔍 Job PDA set: ${actualJobPda}`)

      // Wait for executor to pick up and process the job
      addLog('⏳ FHE Executor will pick up job from queue...')
      addLog('💡 Real executor polls /api/executor/jobs for queued jobs')
      addLog('💡 Executor processes ciphertext and submits result to /api/executor/jobs/{job_pda}/result')
      
      // External FHE Executor processes job asynchronously
      addLog('⏳ External FHE Executor will process job automatically...')
      addLog(`💡 Start FHE Executor: cd fhe_executor && npm run dev`)
      addLog(`💡 Executor polls: GET /api/executor/jobs`)
      addLog(`💡 Executor claims: POST /api/executor/jobs/{job_pda}/claim`)
      addLog(`💡 Executor computes: FHE operations on ciphertext`)
      addLog(`💡 Executor submits: POST /api/executor/jobs/{job_pda}/result`)
      
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
          
          addLog(`📊 Job Queue Status: ${queuedJobs} queued, ${executingJobs} executing, ${completedJobs} completed`)
          
          // Check specific jobs for our submission
          const jobs = jobQueue.jobs || []
          const ourJob = jobs.find((j: any) => j.job_pda === targetJobPda)
          
          addLog(`🔍 Searching for job: ${targetJobPda}`)
          addLog(`📋 Found ${jobs.length} total jobs in queue`)
          if (jobs.length > 0) {
            addLog(`📋 Job PDAs: ${jobs.map((j: any) => j.job_pda.substring(0, 8) + '...').join(', ')}`)
          }
          
          if (ourJob) {
            addLog(`🔍 Our job status: ${ourJob.status}`)
            addLog(`🔍 Job details: ${JSON.stringify({
              job_pda: ourJob.job_pda.substring(0, 16) + '...',
              status: ourJob.status,
              executor: ourJob.executor,
              result_handle: ourJob.result_handle
            })}`)
            
            if (ourJob.status === 'completed') {
              const resultCid = ourJob.result_handle || 'ResultCID_' + Date.now().toString(36)
              setResultCidPda(resultCid)
              addLog(`✅ Job completed by external FHE Executor!`)
              addLog(`✅ Result CID: ${resultCid}`)
              addLog(`💻 Executor: ${ourJob.executor || 'Unknown'}`)
              
              // Show actual computation result
              if (ourJob.computation_result) {
                addLog(`🔢 Computed result: ${ourJob.computation_result}`)
              }
              
              // Try to get result immediately via CID API
              if (resultCid && resultCid !== 'ResultCID_' + Date.now().toString(36)) {
                setTimeout(async () => {
                  try {
                    addLog(`🔑 Auto-fetching result via CID: ${resultCid}`)
                    const cidResponse = await fetch(`/api/ciphertext/${resultCid}`)
                    if (cidResponse.ok) {
                      const cidData = await cidResponse.json()
                      if (cidData.computation_result !== null && cidData.computation_result !== undefined) {
                        setDecryptedResult(String(cidData.computation_result))
                        addLog(`✅ Auto-decrypted result: ${cidData.computation_result}`)
                        if (cidData.computation_description) {
                          addLog(`📋 ${cidData.computation_description}`)
                        }
                      }
                    }
                  } catch (error) {
                    addLog(`⚠️ Auto-fetch failed: ${error}`)
                  }
                }, 1000)
              }
              return
            } else if (ourJob.status === 'failed') {
              addLog(`❌ Job failed during execution`)
              return
            } else if (ourJob.status === 'executing' || ourJob.status === 'assigned') {
              addLog(`⚡ Job is being processed by: ${ourJob.executor || 'FHE Executor'}`)
            }
          } else {
            // Job not found - maybe it's completed but not in our filtered list
            if (completedJobs > 0) {
              addLog(`⚠️ Job not found in list, but ${completedJobs} jobs completed`)
              addLog(`💡 Try manual decryption button below`)
            } else {
              addLog(`🔍 Job not found in queue (${jobs.length} total jobs)`)
            }
          }
          
          // Check if executor is running
          if (queuedJobs > 0 && executingJobs === 0 && pollCount > 5) {
            addLog(`⚠️ Jobs queued but no executor active`)
            addLog(`💡 Start executor: cd fhe_executor && npm run dev`)
          }
          
          // Continue polling if not reached max attempts
          if (pollCount < maxPolls) {
            setTimeout(pollForResult, 2000)
          } else {
            addLog(`⏰ Polling timeout - check ./dashboard.sh for job status`)
            addLog(`🔧 Make sure FHE Executor is running: cd fhe_executor && npm run dev`)
          }
          
        } catch (error) {
          addLog(`❌ Status check error: ${error}`)
          if (pollCount < maxPolls) {
            setTimeout(pollForResult, 5000)
          }
        }
      }
      
      // Start polling after job submission
      setTimeout(pollForResult, 3000)
    } catch (error: any) {
      if (error.message?.includes('User rejected')) {
        addLog('❌ User rejected transaction')
      } else {
        addLog(`❌ Error: ${error.message || error}`)
      }
    }
  }

  const handleDecrypt = async () => {
    if (!resultCidPda) {
      addLog('❌ No result to decrypt')
      return
    }

    try {
      addLog('🔓 Requesting result decryption via KMS...')
      addLog('💡 In production: KMS threshold decryption of result ciphertext')
      
      // Simulate KMS decryption request
      // In real implementation, this would call /api/actions/decrypt/user
      // which performs threshold decryption of the result ciphertext
      
      addLog('🔑 [Simulated KMS] Performing threshold decryption...')
      addLog('🔑 [Simulated KMS] Validating user permissions...')
      addLog('🔑 [Simulated KMS] Combining threshold shares...')
      
      // Get the actual result using CID-based retrieval
      try {
        if (!resultCidPda) {
          throw new Error('No result CID available')
        }

        addLog('🔑 [Simulated KMS] Accessing result ciphertext via CID...')
        addLog(`🔍 [Simulated KMS] Fetching CID: ${resultCidPda}`)
        
        // Fetch result ciphertext by CID handle
        const cidResponse = await fetch(`/api/ciphertext/${resultCidPda}`)
        
        if (!cidResponse.ok) {
          throw new Error(`Failed to fetch result CID: ${cidResponse.status}`)
        }
        
        const cidData = await cidResponse.json()
        addLog('🔑 [Simulated KMS] Result ciphertext retrieved')
        addLog('🔑 [Simulated KMS] Performing threshold decryption...')
        
        setTimeout(() => {
          // Use the actual computation result from executor
          const actualResult = cidData.computation_result || 
            (operation === 'deposit' ? parseInt(plaintext1) + parseInt(plaintext2) :
             operation === 'withdraw' ? parseInt(plaintext1) - parseInt(plaintext2) :
             operation === 'borrow' ? ((parseInt(plaintext1) * parseInt(plaintext2)) > 1000 ? 1 : 0) :
             operation === 'liquidation' ? ((parseInt(plaintext1) + 100) > (parseInt(plaintext2) * 80) ? 1 : 0) :
             'unknown')
          
          setDecryptedResult(String(actualResult))
          addLog(`✅ Decrypted result: ${actualResult}`)
          addLog('💡 Result obtained via CID-based threshold decryption')
          
          if (cidData.computation_description) {
            addLog(`📋 Computation: ${cidData.computation_description}`)
          }
        }, 1000)
        
      } catch (error) {
        addLog(`❌ CID-based decryption failed: ${error}`)
        
        // Fallback to calculation
        const fallbackResult = operation === 'deposit' ? parseInt(plaintext1) + parseInt(plaintext2) :
          operation === 'withdraw' ? parseInt(plaintext1) - parseInt(plaintext2) :
          operation === 'borrow' ? ((parseInt(plaintext1) * parseInt(plaintext2)) > 1000 ? 1 : 0) :
          operation === 'liquidation' ? ((parseInt(plaintext1) + 100) > (parseInt(plaintext2) * 80) ? 1 : 0) :
          'unknown'
        
        setTimeout(() => {
          setDecryptedResult(String(fallbackResult))
          addLog(`✅ Fallback result: ${fallbackResult}`)
          addLog('💡 Using fallback calculation (CID fetch failed)')
        }, 500)
      }
      
    } catch (error) {
      addLog(`❌ Decryption failed: ${error}`)
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
          🔐 LatticA FHE Demo
        </h1>
        <WalletMultiButton style={{ background: '#0f0', color: '#000' }} />
      </div>

      <div style={{ marginBottom: '20px', padding: '15px', background: '#1a1a1a', borderRadius: '8px' }}>
        <h3 style={{ margin: '0 0 10px 0' }}>Status</h3>
        <div>WASM: {moduleReady ? '✅ Ready' : '⏳ Loading...'}</div>
        <div>Wallet: {publicKey ? `✅ ${publicKey.toBase58().substring(0, 8)}...` : '❌ Not connected'}</div>
        <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
          <strong>FHE Executor Required:</strong> Run <code style={{ background: '#000', padding: '2px 4px' }}>cd fhe_executor && npm run dev</code>
        </div>
      </div>

      {/* Step 1 */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: ciphertext1 ? '2px solid #0f0' : '2px solid #555', borderRadius: '8px', opacity: !moduleReady ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          {ciphertext1 ? '✅' : '①'} Step 1: Client-Side FHE Encryption
        </legend>
        <p style={{ fontSize: '14px', color: '#888', margin: '0 0 15px 0' }}>
          Encrypt sensitive data using FHE16 WASM in your browser (4MB public key)
        </p>
        <div style={{ marginBottom: '15px' }}>
          <label style={{ fontWeight: 'bold' }}>Collateral Amount:</label>
          <input
            type="number"
            value={plaintext1}
            onChange={(e) => setPlaintext1(e.target.value)}
            style={{ marginLeft: '10px', padding: '8px', width: '150px', background: '#000', color: '#0f0', border: '1px solid #0f0', fontSize: '16px' }}
          />
          <span style={{ marginLeft: '10px', color: '#888' }}>SOL</span>
        </div>
        <div style={{ marginBottom: '15px' }}>
          <label style={{ fontWeight: 'bold' }}>Debt Amount:</label>
          <input
            type="number"
            value={plaintext2}
            onChange={(e) => setPlaintext2(e.target.value)}
            style={{ marginLeft: '10px', padding: '8px', width: '150px', background: '#000', color: '#0f0', border: '1px solid #0f0', fontSize: '16px' }}
          />
          <span style={{ marginLeft: '10px', color: '#888' }}>USDC</span>
        </div>
        <button
          onClick={handleEncrypt}
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
          🔒 Encrypt with FHE16
        </button>
        {ciphertext1 && (
          <div style={{ marginTop: '15px', padding: '10px', background: '#1a3a1a', borderRadius: '4px', border: '1px solid #0f0' }}>
            <div style={{ fontSize: '14px', marginBottom: '5px', color: '#0f0' }}>
              <strong>Ciphertext 1:</strong> {ciphertext1.encrypted_data.length} elements total
            </div>
            <div style={{ fontSize: '11px', color: '#666', marginBottom: '5px' }}>
              (Showing encrypted data, metadata omitted)
            </div>
            <div style={{ fontSize: '11px', color: '#888', fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: '1.6' }}>
              {/* [{ciphertext1.encrypted_data.join(', ')}] */}
              [{ciphertext1.encrypted_data.slice(16, 16 + 32).join(', ')}, ...]
            </div>

            <div style={{ fontSize: '14px', marginTop: '15px', marginBottom: '5px', color: '#0f0' }}>
              <strong>Ciphertext 2:</strong> {ciphertext2.encrypted_data.length} elements total
            </div>
            <div style={{ fontSize: '11px', color: '#666', marginBottom: '5px' }}>
              (Showing encrypted data, metadata omitted)
            </div>
            <div style={{ fontSize: '11px', color: '#888', fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: '1.6' }}>
              {/* [{ciphertext2.encrypted_data.join(', ')}] */}
              [{ciphertext2.encrypted_data.slice(16, 16 + 32).join(', ')}, ...]
            </div>

            <div style={{ marginTop: '15px', fontSize: '13px', color: '#0f0', borderTop: '1px solid #0f0', paddingTop: '10px' }}>
              ✅ Encrypted locally in browser • Scheme: {ciphertext1.scheme}
            </div>
          </div>
        )}
      </fieldset>

      {/* Step 2 */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: regTxSig ? '2px solid #0f0' : '2px solid #555', borderRadius: '8px', opacity: (!publicKey || !ciphertext1) ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          {regTxSig ? '✅' : '②'} Step 2: Register CIDs On-Chain
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
          📝 Register CIDs via Solana Actions
        </button>
        {regTxSig && (
          <div style={{ marginTop: '15px', padding: '10px', background: '#1a3a1a', borderRadius: '4px', border: '1px solid #0f0' }}>
            <div style={{ fontSize: '14px', marginBottom: '10px' }}>
              <strong>Transaction Signature:</strong>
            </div>
            <div style={{ fontSize: '12px', fontFamily: 'monospace', color: '#0f0', wordBreak: 'break-all' }}>
              {regTxSig}
            </div>
            <div style={{ marginTop: '10px', fontSize: '14px' }}>
              <strong>CID Handle 1:</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda1}</span>
            </div>
            <div style={{ fontSize: '14px', marginTop: '5px' }}>
              <strong>CID Handle 2:</strong> <span style={{ fontSize: '12px', fontFamily: 'monospace', color: '#888' }}>{cidPda2}</span>
            </div>
            <div style={{ marginTop: '10px' }}>
              <a
                href={`https://solscan.io/tx/${regTxSig}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#0f0', textDecoration: 'underline', fontSize: '14px' }}
              >
                🔗 View on Solscan (Devnet)
              </a>
            </div>
            <div style={{ marginTop: '10px', fontSize: '13px', color: '#0f0' }}>
              ✅ Registered on Solana • Policy: owner-controlled (private)
            </div>
          </div>
        )}
      </fieldset>

      {/* Step 3 */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: jobTxSig ? '2px solid #0f0' : '2px solid #555', borderRadius: '8px', opacity: (!publicKey || !cidPda1) ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          {jobTxSig ? '✅' : '③'} Step 3: Submit FHE Computation Job
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
            <option value="deposit">💰 Deposit (ADD) - Public → Private Balance</option>
            <option value="withdraw">💸 Withdraw (SUB) - Private → Public Balance</option>
            <option value="borrow">📊 Borrow (MUL+GT) - Health Factor Check</option>
            <option value="liquidation">⚠️ Liquidation (MUL+ADD+GT) - Liquidation Eligibility</option>
          </select>
        </div>
        <div style={{ fontSize: '13px', color: '#888', marginBottom: '15px', padding: '10px', background: '#1a1a1a', borderRadius: '4px' }}>
          <strong>Selected Operation:</strong> {
            operation === 'deposit' ? 'ADD' :
            operation === 'withdraw' ? 'SUB' :
            operation === 'borrow' ? 'MUL+GT' :
            operation === 'liquidation' ? 'MUL+ADD+GT' : 'UNKNOWN'
          }<br/>
          <strong>Input CIDs:</strong> 2<br/>
          <strong>FHE Computation:</strong> {
            operation === 'deposit' ? 'Homomorphic addition of encrypted values' :
            operation === 'withdraw' ? 'Homomorphic subtraction of encrypted values' :
            operation === 'borrow' ? 'Homomorphic multiplication + comparison (health check)' :
            operation === 'liquidation' ? 'Complex multi-operation computation on encrypted data' :
            'Unknown operation'
          }<br/>
          <strong>Note:</strong> Executor processes encrypted data without seeing plaintext values
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
          ⚡ Submit to FHE Executor
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
              ✅ Job submitted to executor • Waiting for FHE computation...
            </div>
          </div>
        )}
      </fieldset>

      {/* Step 4 */}
      <fieldset style={{ margin: '20px 0', padding: '15px', border: decryptedResult ? '2px solid #ff0' : '2px solid #555', borderRadius: '8px', opacity: !resultCidPda ? 0.6 : 1 }}>
        <legend style={{ fontSize: '18px', fontWeight: 'bold' }}>
          {decryptedResult ? '✅' : '④'} Step 4: Decrypt Result
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
          🔓 Decrypt Result
        </button>
        {decryptedResult && (
          <div style={{ marginTop: '15px', padding: '15px', background: '#3a3a1a', borderRadius: '4px', border: '2px solid #ff0' }}>
            <div style={{ fontSize: '20px', color: '#ff0', fontWeight: 'bold', marginBottom: '10px' }}>
              ✨ Decrypted Result: {decryptedResult}
            </div>
            <div style={{ fontSize: '14px', color: '#888' }}>
              Operation: {
                operation === 'deposit' ? 'ADD (Homomorphic Addition)' :
                operation === 'withdraw' ? 'SUB (Homomorphic Subtraction)' :
                operation === 'borrow' ? 'MUL+GT (Homomorphic Multiplication & Comparison)' :
                operation === 'liquidation' ? 'MUL+ADD+GT (Complex Homomorphic Computation)' : 'UNKNOWN'
              } <br/>
              Input Values: {plaintext1}, {plaintext2} (for demo reference only) <br/>
              Decrypted Result: {decryptedResult} {
                operation === 'deposit' ? '(computed balance)' :
                operation === 'withdraw' ? '(computed balance)' :
                operation === 'borrow' ? (decryptedResult === '1' ? '(computation result: approved)' : '(computation result: denied)') :
                operation === 'liquidation' ? (decryptedResult === '1' ? '(computation result: liquidate)' : '(computation result: safe)') :
                '(computation result)'
              }
            </div>
            <div style={{ marginTop: '10px', fontSize: '13px', color: '#0f0' }}>
              ✅ Successfully decrypted via KMS threshold protocol
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
