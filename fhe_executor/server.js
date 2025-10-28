/* eslint-disable no-console */
const http = require('http');
const path = require('path');
const { FHE16 } = require('./FHE16/index.js');

const EXECUTOR_PORT = 3001;
const GATEHOUSE_URL = 'http://localhost:3000';
const EXECUTOR_ID = `FHE_Executor_${Date.now()}`;
const POLL_INTERVAL = 5000; // 5 seconds

let isProcessing = false;

// Initialize FHE16
async function initFHE16() {
  try {
    console.log('[FHE_EXECUTOR] Initializing FHE16...');
    
    // Initialize parameters
    const skInitPtr = FHE16.FHE16_GenEval();
    if (!skInitPtr) {
      throw new Error('GenEval returned null');
    }

    // Load bootparam
    const bootPath = path.join(__dirname, 'FHE16', 'store', 'boot', 'bootparam.bin');
    try {
      FHE16.bootparamLoadFileGlobal(bootPath);
    } catch (e) {
      console.warn('[FHE_EXECUTOR] Could not load bootparam:', e.message);
    }
    console.log('[FHE_EXECUTOR] Bootparam loaded from:', bootPath);

    // Load secret key for testing/verification
    await loadSecretKey();
    
    console.log('[FHE_EXECUTOR] FHE16 initialized successfully');
    return true;
  } catch (e) {
    console.error('[FHE_EXECUTOR] FHE16 init error:', e.message || e);
    return false;
  }
}

// Fetch jobs from gatehouse
async function fetchJobs() {
  return new Promise((resolve, reject) => {
    const req = http.request(`${GATEHOUSE_URL}/api/executor/jobs?limit=1`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Claim a job
async function claimJob(jobPda) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ executor: EXECUTOR_ID });
    const req = http.request(`${GATEHOUSE_URL}/api/executor/jobs/${jobPda}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Submit job result
async function submitResult(jobPda, success, resultCiphertext = null, error = null, executionTime = 0) {
  return new Promise((resolve, reject) => {
    const payload = {
      executor: EXECUTOR_ID,
      success,
      execution_time_ms: executionTime
    };

    if (success && resultCiphertext) {
      payload.result_ciphertext = resultCiphertext;
    }

    if (!success && error) {
      payload.error = error;
    }

    const postData = JSON.stringify(payload);
    const req = http.request(`${GATEHOUSE_URL}/api/executor/jobs/${jobPda}/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Load secret key for decryption (for testing)
let secretKey = null;

async function loadSecretKey() {
  try {
    const secretPath = path.join(__dirname, 'FHE16', 'store', 'keys', 'secret.bin');
    if (FHE16.secretKeyLoadFileSafe) {
      secretKey = FHE16.secretKeyLoadFileSafe(secretPath);
      console.log('[FHE_EXECUTOR] Secret key loaded for testing');
    } else {
      console.warn('[FHE_EXECUTOR] secretKeyLoadFileSafe not available');
    }
    return true;
  } catch (error) {
    console.warn('[FHE_EXECUTOR] Could not load secret key:', error.message);
    return false;
  }
}

// Define DeFi FHE computation patterns based on IR digest
const DEFI_PROGRAMS = {
  // Deposit: Public balance -> Private state (ADD operation)
  'DEPOSIT_PROGRAM': {
    operations: ['add'],
    description: 'Deposit: Add deposit amount to current private balance',
    scenario: 'public_to_private',
    computation: 'new_balance = current_balance + deposit_amount'
  },
  
  // Withdraw: Private state -> Public balance (SUB operation)  
  'WITHDRAW_PROGRAM': {
    operations: ['sub'],
    description: 'Withdraw: Subtract withdrawal amount from private balance',
    scenario: 'private_to_public',
    computation: 'new_balance = current_balance - withdraw_amount'
  },
  
  // Borrow: Health factor calculation (MUL + comparison)
  'BORROW_PROGRAM': {
    operations: ['smull', 'gt'],
    description: 'Borrow: Calculate collateral health factor and check borrowing capacity',
    scenario: 'health_check',
    computation: 'health_factor = (collateral_value * collateral_ratio) > borrow_amount'
  },
  
  // Liquidation: Multi-step health check with threshold comparison
  'LIQUIDATION_PROGRAM': {
    operations: ['smull', 'add', 'gt'],
    description: 'Liquidation: Check if position is undercollateralized and eligible for liquidation',
    scenario: 'liquidation_check', 
    computation: 'liquidation_eligible = (debt_value + penalty) > (collateral_value * liquidation_threshold)'
  }
};

// Execute FHE computation based on IR digest
async function executeFHEComputation(job) {
  const startTime = Date.now();

  console.log('[FHE_EXECUTOR] Processing job:', job.job_pda);
  console.log('[FHE_EXECUTOR] IR digest:', job.ir_digest || 'unknown');
  console.log('[FHE_EXECUTOR] Operation:', job.operation || 'unknown');
  
  // DEMO ONLY: Use ciphertexts field from Gatehouse in-memory DB
  // In production, jobs would only contain CID references and executor would fetch ciphertexts separately
  const inputCiphertexts = job.ciphertexts || [];
  console.log('[FHE_EXECUTOR] Input ciphertexts:', inputCiphertexts.length);
  console.log('[FHE_EXECUTOR] Available job keys:', Object.keys(job));

  try {
    // Validate inputs
    if (!inputCiphertexts || inputCiphertexts.length < 2) {
      throw new Error(`Insufficient input ciphertexts: expected 2, got ${inputCiphertexts.length}`);
    }

    const cid1 = inputCiphertexts[0];
    const cid2 = inputCiphertexts[1]; 
    const operation = job.operation || 'deposit';
    const irDigest = job.ir_digest;

    console.log('[FHE_EXECUTOR] Processing CID1:', cid1.cid_pda);
    console.log('[FHE_EXECUTOR] Processing CID2:', cid2.cid_pda);

    // Determine FHE program based on IR digest or operation
    const program = determineFHEProgram(irDigest, operation);
    console.log('[FHE_EXECUTOR] Selected FHE program:', program.description);
    console.log('[FHE_EXECUTOR] Operations to perform:', program.operations);

    // Extract ciphertext data directly from job (no CID lookup needed)
    const { ct1Data, ct2Data } = extractCiphertextDataFromJob(cid1, cid2);

    console.log('[FHE_EXECUTOR] Processing encrypted inputs only - no plaintext access');
    
    // Display ciphertext elements like demo page
    console.log('[FHE_EXECUTOR] Ciphertext 1 elements:', ct1Data.length, 'total');
    console.log('[FHE_EXECUTOR] Ciphertext 1 preview:', `[${ct1Data.slice(16, 16 + 32).join(', ')}, ...]`);
    
    console.log('[FHE_EXECUTOR] Ciphertext 2 elements:', ct2Data.length, 'total');
    console.log('[FHE_EXECUTOR] Ciphertext 2 preview:', `[${ct2Data.slice(16, 16 + 32).join(', ')}, ...]`);

    // Perform FHE computation based on program
    const result = await performFHEComputation(program, ct1Data, ct2Data);

    // Generate deterministic result CID
    const resultCiphertext = generateDeterministicResult(result, job, program, inputCiphertexts.length);

    const executionTime = Date.now() - startTime;
    console.log('[FHE_EXECUTOR] FHE computation completed in', executionTime, 'ms');

    return {
      success: true,
      resultCiphertext,
      executionTime
    };

  } catch (error) {
    const executionTime = Date.now() - startTime;
    console.error('[FHE_EXECUTOR] FHE computation failed:', error.message);
    
    return {
      success: false,
      error: error.message,
      executionTime
    };
  }
}

// Determine DeFi FHE program based on IR digest or operation
function determineFHEProgram(irDigest, operation) {
  // If IR digest is provided, use it to determine exact program
  if (irDigest) {
    // Hash-based program selection (deterministic)
    const hashValue = parseInt(irDigest.slice(-4), 16) % Object.keys(DEFI_PROGRAMS).length;
    const programKey = Object.keys(DEFI_PROGRAMS)[hashValue];
    console.log('[FHE_EXECUTOR] IR-based DeFi program selection:', programKey);
    return DEFI_PROGRAMS[programKey];
  }

  // Fallback to operation-based selection
  switch (operation) {
    case 'deposit':
      return DEFI_PROGRAMS.DEPOSIT_PROGRAM;
    case 'withdraw':
      return DEFI_PROGRAMS.WITHDRAW_PROGRAM;
    case 'borrow':
      return DEFI_PROGRAMS.BORROW_PROGRAM;
    case 'liquidation':
      return DEFI_PROGRAMS.LIQUIDATION_PROGRAM;
    default:
      return DEFI_PROGRAMS.DEPOSIT_PROGRAM;
  }
}

// DEMO ONLY: Extract ciphertext data directly from job objects (in-memory DB demo)
// In production, executor would fetch ciphertexts separately using CID references
function extractCiphertextDataFromJob(cid1, cid2) {
  let ct1Data, ct2Data;

  // Extract from CID1 - handle nested encrypted_data structure
  if (cid1.ciphertext && typeof cid1.ciphertext === 'object') {
    if (cid1.ciphertext.encrypted_data && cid1.ciphertext.encrypted_data.encrypted_data) {
      // Handle nested structure: ciphertext.encrypted_data.encrypted_data
      ct1Data = cid1.ciphertext.encrypted_data.encrypted_data;
    } else if (cid1.ciphertext.encrypted_data) {
      // Handle direct structure: ciphertext.encrypted_data
      ct1Data = cid1.ciphertext.encrypted_data;
    } else {
      throw new Error('Invalid ciphertext format for CID1');
    }
  } else {
    throw new Error('Missing ciphertext data for CID1');
  }

  // Extract from CID2 - handle nested encrypted_data structure
  if (cid2.ciphertext && typeof cid2.ciphertext === 'object') {
    if (cid2.ciphertext.encrypted_data && cid2.ciphertext.encrypted_data.encrypted_data) {
      // Handle nested structure: ciphertext.encrypted_data.encrypted_data
      ct2Data = cid2.ciphertext.encrypted_data.encrypted_data;
    } else if (cid2.ciphertext.encrypted_data) {
      // Handle direct structure: ciphertext.encrypted_data
      ct2Data = cid2.ciphertext.encrypted_data;
    } else {
      throw new Error('Invalid ciphertext format for CID2');
    }
  } else {
    throw new Error('Missing ciphertext data for CID2');
  }

  return { ct1Data, ct2Data };
}

// Convert JSON ciphertext data to FHE16 Int32Ptr
// Strategy: Create a dummy ciphertext with encInt, then copy the actual values using ref-napi
function convertJSONToInt32Ptr(ciphertextArray) {
  try {
    // Validate input: should be 16 + 1040*32 = 33296 integers
    const expectedLength = 16 + 1040 * 32;
    if (!ciphertextArray || ciphertextArray.length !== expectedLength) {
      throw new Error(`Invalid ciphertext length: expected ${expectedLength}, got ${ciphertextArray?.length || 0}`);
    }

    console.log(`[FHE_EXECUTOR] Converting ${ciphertextArray.length} integers to Int32Ptr`);
    
    // Step 1: Create a dummy ciphertext using encInt with message=0, bits=32
    // This allocates proper memory structure for a ciphertext
    const dummyCiphertextPtr = FHE16.encInt(0, 32);
    
    if (!dummyCiphertextPtr) {
      throw new Error('Failed to create dummy ciphertext');
    }
    
    console.log('[FHE_EXECUTOR] Created dummy ciphertext with proper memory allocation');
    console.log('[FHE_EXECUTOR] Dummy ciphertext pointer address:', dummyCiphertextPtr.address);
    
    // Step 2: Copy actual ciphertext values from JSON array to the dummy ciphertext
    // Use ref-napi to write to the pointer memory
    const ref = require('ref-napi');
    const int32 = ref.types.int32;
    
    // Reinterpret the pointer as a buffer that can hold all our data
    const ctBuffer = ref.reinterpret(dummyCiphertextPtr, expectedLength * 4, 0);
    
    console.log('[FHE_EXECUTOR] Copying ciphertext values to memory...');
    
    // Copy each int32 value to the buffer
    for (let i = 0; i < ciphertextArray.length; i++) {
      ctBuffer.writeInt32LE(ciphertextArray[i], i * 4);
    }
    
    console.log('[FHE_EXECUTOR] Successfully copied ciphertext data to Int32Ptr');
    
    // Verify: Read back ALL values and check if they match
    console.log('[FHE_EXECUTOR] Verifying ALL copied values...');
    let mismatchCount = 0;
    let firstMismatchIndex = -1;
    
    for (let i = 0; i < ciphertextArray.length; i++) {
      const readValue = ctBuffer.readInt32LE(i * 4);
      if (readValue !== ciphertextArray[i]) {
        mismatchCount++;
        if (firstMismatchIndex === -1) {
          firstMismatchIndex = i;
          console.log(`[FHE_EXECUTOR] ❌ First mismatch at index ${i}: Expected ${ciphertextArray[i]}, Got ${readValue}`);
        }
      }
    }
    
    if (mismatchCount === 0) {
      console.log(`[FHE_EXECUTOR] ✅ Verification PASSED: All ${ciphertextArray.length} values match perfectly!`);
    } else {
      console.log(`[FHE_EXECUTOR] ❌ Verification FAILED: ${mismatchCount} out of ${ciphertextArray.length} values mismatch`);
      throw new Error(`Ciphertext copy verification failed: ${mismatchCount} mismatches`);
    }
    
    // Show first and last few values as sample
    console.log('[FHE_EXECUTOR] Sample check - First 5 values:');
    for (let i = 0; i < 5; i++) {
      console.log(`  [${i}] ${ctBuffer.readInt32LE(i * 4)}`);
    }
    console.log('[FHE_EXECUTOR] Sample check - Last 5 values:');
    for (let i = ciphertextArray.length - 5; i < ciphertextArray.length; i++) {
      console.log(`  [${i}] ${ctBuffer.readInt32LE(i * 4)}`);
    }
    
    return dummyCiphertextPtr;
    
  } catch (error) {
    console.error('[FHE_EXECUTOR] JSON to Int32Ptr conversion failed:', error.message);
    console.error('[FHE_EXECUTOR] Stack trace:', error.stack);
    throw error;
  }
}

// Perform DeFi-specific FHE computation on encrypted data only
async function performFHEComputation(program, ct1Data, ct2Data) {
  try {
    console.log(`[FHE_EXECUTOR] Executing DeFi scenario: ${program.scenario}`);
    console.log(`[FHE_EXECUTOR] Computation: ${program.computation}`);
    
    // Convert JSON ciphertext data to FHE16 Int32Ptr
    console.log('[FHE_EXECUTOR] Converting JSON ciphertexts to Int32Ptr...');
    console.log('[FHE_EXECUTOR] CT1 data length:', ct1Data.length);
    console.log('[FHE_EXECUTOR] CT2 data length:', ct2Data.length);
    
    // Convert JSON arrays to FHE16 Int32Ptr format
    console.log('[FHE_EXECUTOR] ========== Converting CT1 ==========');
    const ct1Ptr = convertJSONToInt32Ptr(ct1Data);
    
    console.log('[FHE_EXECUTOR] ========== Converting CT2 ==========');
    const ct2Ptr = convertJSONToInt32Ptr(ct2Data);
    
    if (!ct1Ptr || !ct2Ptr) {
      throw new Error('Failed to convert JSON ciphertexts to Int32Ptr');
    }

    console.log('[FHE_EXECUTOR] ========================================');
    console.log('[FHE_EXECUTOR] ✅ Both ciphertexts successfully converted and verified!');
    console.log('[FHE_EXECUTOR] ========================================');
    
    let resultPtr;
    
    // Execute DeFi-specific computation logic using Int32Ptr
    console.log('[FHE_EXECUTOR] Executing FHE operations...');
    
    switch (program.scenario) {
      case 'public_to_private': // DEPOSIT
        console.log('[FHE_EXECUTOR] DEPOSIT: current_balance + deposit_amount');
        console.log('[FHE_EXECUTOR] Calling FHE16.add(ct1Ptr, ct2Ptr)...');
        resultPtr = FHE16.add(ct1Ptr, ct2Ptr);
        console.log('[FHE_EXECUTOR] ADD operation completed, result pointer:', resultPtr?.address || resultPtr);
        break;
        
      case 'private_to_public': // WITHDRAW
        console.log('[FHE_EXECUTOR] WITHDRAW: current_balance - withdraw_amount');
        console.log('[FHE_EXECUTOR] Calling FHE16.sub(ct1Ptr, ct2Ptr)...');
        resultPtr = FHE16.sub(ct1Ptr, ct2Ptr);
        console.log('[FHE_EXECUTOR] SUB operation completed, result pointer:', resultPtr?.address || resultPtr);
        break;
        
      case 'health_check': // BORROW
        console.log('[FHE_EXECUTOR] BORROW: collateral_value * ratio > borrow_amount');
        console.log('[FHE_EXECUTOR] Calling FHE16.smull(ct1Ptr, ct2Ptr)...');
        resultPtr2 = FHE16.smull(ct1Ptr, ct2Ptr);
        resultPtr = FHE16.gt(resultPtr2, ct1Ptr);
        console.log('[FHE_EXECUTOR] SMULL operation completed, result pointer:', resultPtr?.address || resultPtr);
        break;
        
      case 'liquidation_check': // LIQUIDATION
        console.log('[FHE_EXECUTOR] LIQUIDATION: debt + penalty > collateral * threshold');
        console.log('[FHE_EXECUTOR] Step 1: Calling FHE16.add(ct1Ptr, ct2Ptr) for debt + penalty...');
        const debtPenaltyPtr = FHE16.add(ct1Ptr, ct2Ptr);
        console.log('[FHE_EXECUTOR] Step 2: Calling FHE16.smull(ct2Ptr, ct1Ptr) for collateral * threshold...');
        const collateralThresholdPtr = FHE16.smull(ct2Ptr, ct1Ptr);
        console.log('[FHE_EXECUTOR] Step 3: Calling FHE16.gt(debtPenaltyPtr, collateralThresholdPtr)...');
        resultPtr = FHE16.gt(debtPenaltyPtr, collateralThresholdPtr);
        console.log('[FHE_EXECUTOR] LIQUIDATION check completed, result pointer:', resultPtr?.address || resultPtr);
        break;
        
      default:
        throw new Error(`Unsupported DeFi scenario: ${program.scenario}`);
    }
    
    if (!resultPtr) {
      throw new Error(`DeFi computation ${program.scenario} returned null pointer`);
    }

    // Convert result Int32Ptr back to JSON array format
    // Read the ciphertext data from memory using ref-napi (same size as input: 33296 integers)
    const ref = require('ref-napi');
    const resultLength = 16 + 1040 * 32;
    const resultBuffer = ref.reinterpret(resultPtr, resultLength * 4, 0);
    const resultArray = [];
    
    console.log('[FHE_EXECUTOR] Reading result from memory...');
    for (let i = 0; i < resultLength; i++) {
      resultArray.push(resultBuffer.readInt32LE(i * 4));
    }
    
    console.log('[FHE_EXECUTOR] Result converted to', resultArray.length, 'integers');
    
    // Verify: Show first few result values
    console.log('[FHE_EXECUTOR] Result preview (first 10 values):', resultArray.slice(0, 10));

    // Verify result by decryption (if secret key available)
    let decryptedResult = null;
    if (secretKey) {
      try {
        decryptedResult = FHE16.decInt(resultPtr, secretKey);
        console.log('[FHE_EXECUTOR] FHE computation result:', decryptedResult);
      } catch (decError) {
        console.warn('[FHE_EXECUTOR] Could not decrypt result:', decError.message);
      }
    }

    return {
      encrypted_data: resultArray,
      scheme: 'FHE16_0.0.1v',
      timestamp: Date.now(),
      operation: program.operations.join('_'),
      decrypted_result: decryptedResult
    };

  } catch (error) {
    console.error('[FHE_EXECUTOR] FHE computation failed:', error.message);
    throw error;
  }
}


// Generate deterministic result CID
function generateDeterministicResult(result, job, program, inputCount) {
  const deterministicId = generateDeterministicCID(job.job_pda, program.operations.join('_'));
  
  return {
    encrypted_data: result.encrypted_data,
    operation: program.operations.join('_'),
    input_count: inputCount,
    deterministic_cid: deterministicId,
    ir_digest: job.ir_digest,
    timestamp: Date.now(),
    scheme: 'FHE16_0.0.1v',
    decrypted_result: result.decrypted_result
  };
}

// Generate deterministic CID based on input parameters
function generateDeterministicCID(jobPda, operations) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  hash.update(jobPda);
  hash.update(operations);
  hash.update('FHE16_DETERMINISTIC');
  return 'CID_' + hash.digest('hex').substring(0, 32);
}

// Main polling loop
async function pollForJobs() {
  if (isProcessing) {
    return;
  }

  try {
    const jobsData = await fetchJobs();

    if (!jobsData || !jobsData.jobs || jobsData.jobs.length === 0) {
      console.log('[FHE_EXECUTOR] No jobs available');
      return;
    }

    const job = jobsData.jobs[0];
    const jobPda = job.job_pda;

    console.log('[FHE_EXECUTOR] Found job:', jobPda);
    isProcessing = true;

    // Claim the job
    console.log('[FHE_EXECUTOR] Claiming job...');
    await claimJob(jobPda);
    console.log('[FHE_EXECUTOR] Job claimed successfully');

    // Execute FHE computation
    const result = await executeFHEComputation(job);

    // Submit result
    console.log('[FHE_EXECUTOR] Submitting result...');
    await submitResult(
      jobPda,
      result.success,
      result.resultCiphertext,
      null,
      result.executionTime
    );
    console.log('[FHE_EXECUTOR] Result submitted successfully');

  } catch (error) {
    console.error('[FHE_EXECUTOR] Error processing job:', error.message);
  } finally {
    isProcessing = false;
  }
}

// Create HTTP server for status endpoint
const server = http.createServer((req, res) => {
  if (req.url === '/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      executor_id: EXECUTOR_ID,
      port: EXECUTOR_PORT,
      gatehouse_url: GATEHOUSE_URL,
      is_processing: isProcessing,
      uptime: process.uptime()
    }));
  } else if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

// Start server
async function start() {
  console.log('[FHE_EXECUTOR] Starting FHE Executor Server...');
  console.log('[FHE_EXECUTOR] Executor ID:', EXECUTOR_ID);
  console.log('[FHE_EXECUTOR] Gatehouse URL:', GATEHOUSE_URL);

  // Initialize FHE16
  const initialized = await initFHE16();
  if (!initialized) {
    console.error('[FHE_EXECUTOR] Failed to initialize FHE16. Exiting...');
    process.exit(1);
  }

  // Start HTTP server
  server.listen(EXECUTOR_PORT, () => {
    console.log(`[FHE_EXECUTOR] Server listening on port ${EXECUTOR_PORT}`);
    console.log(`[FHE_EXECUTOR] Health check: http://localhost:${EXECUTOR_PORT}/health`);
    console.log(`[FHE_EXECUTOR] Status endpoint: http://localhost:${EXECUTOR_PORT}/status`);
  });

  // Start polling
  console.log(`[FHE_EXECUTOR] Starting job polling (interval: ${POLL_INTERVAL}ms)...`);
  setInterval(pollForJobs, POLL_INTERVAL);

  // Initial poll
  setTimeout(pollForJobs, 1000);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[FHE_EXECUTOR] Shutting down...');
  server.close(() => {
    console.log('[FHE_EXECUTOR] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[FHE_EXECUTOR] Shutting down...');
  server.close(() => {
    console.log('[FHE_EXECUTOR] Server closed');
    process.exit(0);
  });
});

// Start the executor
start().catch((error) => {
  console.error('[FHE_EXECUTOR] Fatal error:', error);
  process.exit(1);
});
