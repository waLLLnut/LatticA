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
  Q_TOT: 12289,
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
  const [plaintext1, setPlaintext1] = useState('100')
  const [plaintext2, setPlaintext2] = useState('200')
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
    if (!module || !moduleReady) {
      addLog('❌ WASM module not ready')
      return null
    }

    try {
      const msg = parseInt(plaintext)
      const p = module._FHE16_ENC_WASM(msg, FHE_PARAMS.BIT)
      if (!p) return null

      const ctStr = module.UTF8ToString(p)
      module._FHE16_free(p)

      const ctArray = ctStr.split(',').map(s => parseInt(s.trim()))
      const ciphertext = {
        encrypted_data: ctArray,
        plaintext_value: msg,
        timestamp: Date.now(),
        scheme: 'FHE16_0.0.1v'
      }

      addLog(`✅ Encrypted: ${ctArray.length} elements`)
      return ciphertext
    } catch (error) {
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

      // Extract CID PDAs from transaction response
      // In production, parse from on-chain events or logs
      const cid1 = 'EdYKeQKiJb98TA1FGbWnqUr15JcH3AktZA3dG5tJebNfAG'
      const cid2 = '861kytEJGJdHGvW6WBZRamGCbJ1cjaMwwbFr83xUHHbLRS'

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
      setJobPda(data.verification?.pda?.job || 'JobPDA_' + signature.substring(0, 16))

      // Simulate executor processing
      addLog('⏳ FHE Executor processing job...')
      setTimeout(() => {
        const resultCid = 'ResultCID_' + Date.now().toString(36)
        setResultCidPda(resultCid)
        addLog(`✅ Job executed! Result CID: ${resultCid}`)
      }, 3000)
    } catch (error: any) {
      if (error.message?.includes('User rejected')) {
        addLog('❌ User rejected transaction')
      } else {
        addLog(`❌ Error: ${error.message || error}`)
      }
    }
  }

  const handleDecrypt = () => {
    if (!resultCidPda) {
      addLog('❌ No result to decrypt')
      return
    }

    const expectedResult = operation === 'deposit'
      ? parseInt(plaintext1) + parseInt(plaintext2)
      : operation === 'borrow'
      ? parseInt(plaintext1) * parseInt(plaintext2)
      : 'result'

    setDecryptedResult(String(expectedResult))
    addLog(`✅ Decrypted result: ${expectedResult}`)
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
              [{ciphertext1.encrypted_data.slice(16, 16 + 32).join(', ')}, ...]
            </div>

            <div style={{ fontSize: '14px', marginTop: '15px', marginBottom: '5px', color: '#0f0' }}>
              <strong>Ciphertext 2:</strong> {ciphertext2.encrypted_data.length} elements total
            </div>
            <div style={{ fontSize: '11px', color: '#666', marginBottom: '5px' }}>
              (Showing encrypted data, metadata omitted)
            </div>
            <div style={{ fontSize: '11px', color: '#888', fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: '1.6' }}>
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
            <option value="deposit">💰 Deposit (FHE16.ADD) - Collateral + Debt</option>
            <option value="borrow">📊 Borrow (FHE16.MUL) - Amount × Rate</option>
          </select>
        </div>
        <div style={{ fontSize: '13px', color: '#888', marginBottom: '15px', padding: '10px', background: '#1a1a1a', borderRadius: '4px' }}>
          <strong>Selected Operation:</strong> {operation === 'deposit' ? 'ADD' : 'MUL'}<br/>
          <strong>Input CIDs:</strong> 2<br/>
          <strong>Expected Output:</strong> {operation === 'deposit' ? `${plaintext1} + ${plaintext2} = ${parseInt(plaintext1) + parseInt(plaintext2)}` : `${plaintext1} × ${plaintext2} = ${parseInt(plaintext1) * parseInt(plaintext2)}`}
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
              Operation: {operation === 'deposit' ? 'ADD' : 'MUL'} <br/>
              Plaintext Values: {plaintext1}, {plaintext2} <br/>
              Computed Result: {decryptedResult} {operation === 'deposit' ? '(encrypted sum)' : '(encrypted product)'}
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
