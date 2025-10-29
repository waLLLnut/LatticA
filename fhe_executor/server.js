/* eslint-disable no-console */
const http = require('http');
const path = require('path');
const { FHE16 } = require('./FHE16/index.js');

const EXECUTOR_PORT = 3001;
const GATEHOUSE_URL = 'http://localhost:3000';
const EXECUTOR_ID = `FHE_Executor_${Date.now()}`;
const POLL_INTERVAL = 5000; // 5 seconds

let isProcessing = false;

// Logger utility with colors
class Logger {
  constructor() {
    this.colors = {
      reset: '\x1b[0m',
      bright: '\x1b[1m',
      dim: '\x1b[2m',
      
      // Level colors
      debug: '\x1b[36m',    // Cyan
      info: '\x1b[32m',     // Green
      warn: '\x1b[33m',     // Yellow
      error: '\x1b[31m',    // Red
      
      // Component color
      component: '\x1b[35m', // Magenta
      
      // Context color
      context: '\x1b[90m',   // Gray
    };
  }

  format(level, component, message, context = {}) {
    const levelTag = level.toUpperCase().padEnd(5);
    const componentTag = component.padEnd(20);
    const levelColor = this.colors[level] || this.colors.reset;
    
    let contextStr = '';
    if (Object.keys(context).length > 0) {
      const pairs = Object.entries(context)
        .map(([key, val]) => `${key}=${val}`)
        .join(', ');
      contextStr = ` ${this.colors.context}(${pairs})${this.colors.reset}`;
    }
    
    return `${levelColor}${this.colors.bright}${levelTag}${this.colors.reset} | ${this.colors.component}${componentTag}${this.colors.reset} | ${levelColor}${message}${this.colors.reset}${contextStr}`;
  }

  debug(component, message, context) {
    console.debug(this.format('debug', component, message, context));
  }

  info(component, message, context) {
    console.log(this.format('info', component, message, context));
  }

  warn(component, message, context) {
    console.warn(this.format('warn', component, message, context));
  }

  error(component, message, context) {
    console.error(this.format('error', component, message, context));
  }
}

const logger = new Logger();

// Initialize FHE16
async function initFHE16() {
  try {
    logger.info('FHE:Init', 'Initializing FHE16...');
    
    const skInitPtr = FHE16.FHE16_GenEval();
    if (!skInitPtr) {
      throw new Error('GenEval returned null');
    }

    const bootPath = path.join(__dirname, 'FHE16', 'store', 'boot', 'bootparam.bin');
    try {
      FHE16.bootparamLoadFileGlobal(bootPath);
    } catch (e) {
      logger.warn('FHE:Init', 'Could not load bootparam', { error: e.message });
    }

    await loadSecretKey();
    
    logger.info('FHE:Init', 'Initialization complete');
    return true;
  } catch (e) {
    logger.error('FHE:Init', 'Initialization failed', { error: e.message || e });
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
    }
    return true;
  } catch (error) {
    return false;
  }
}

// FHE Operation Registry
const FHE_OPERATION_REGISTRY = {
  // Built-in operations
  '0xadd0000000000000000000000000000000000000000000000000000000000000': {
    name: 'binary_add',
    description: 'Basic addition: output = input[0] + input[1]',
    input_slots: 2,
    operations: ['add'],
    execution_plan: [
      { op: 'add', inputs: [0, 1], output: 'result' }
    ]
  },
  
  // Main DeFi operation
  '0x8fae5df19cb6bc3db4ea7dfc14a9696be683910c9fee64d839a6eef9981129a1': {
    name: 'defi_operation',
    description: 'DeFi operation: borrow/withdraw with collateral checks',
    input_slots: 3,
    operations: ['smull_constant', 'ge', 'add', 'sub', 'select'],
    execution_plan: [
      // Dynamic execution based on input count
      { op: 'dynamic', inputs: 'auto', output: 'result' }
    ]
  },
  
  '0xwithdrw000000000000000000000000000000000000000000000000000000000': {
    name: 'withdraw_with_check',
    description: 'Withdraw: Check balance >= amount, then subtract',
    input_slots: 2,
    operations: ['ge', 'sub', 'select'],
    execution_plan: [
      // Inputs: [0]=USDC_balance, [1]=withdraw_amount
      { op: 'ge', inputs: [0, 1], output: 'temp_a' },
      { op: 'sub', inputs: [0, 1], output: 'temp_b' },
      { op: 'select', inputs: ['temp_a', 'temp_b', 0], output: 'result' }
    ]
  },
  
  '0xmul0000000000000000000000000000000000000000000000000000000000000': {
    name: 'complex_borrow_check',
    description: 'Multi-step: collateral check with balance update',
    input_slots: 3,
    operations: ['smull_constant', 'ge', 'add', 'select'],
    execution_plan: [
      // Inputs: [0]=SOL_balance, [1]=borrow_amount, [2]=USDC_balance
      { op: 'smull_constant', inputs: [1], constant: 2, output: 'temp_a' },
      { op: 'ge', inputs: [0, 'temp_a'], output: 'temp_b' },
      { op: 'add', inputs: [2, 1], output: 'temp_d' },
      { op: 'select', inputs: ['temp_b', 'temp_d', 2], output: 'result' }
    ]
  },
  
  '0xhealthcheck00000000000000000000000000000000000000000000000000000': {
    name: 'liquidation_health_check',
    description: 'Health factor: (collateral * price) vs (debt * threshold)',
    input_slots: 3,
    operations: ['smull', 'smull_constant', 'gt'],
    execution_plan: [
      { op: 'smull', inputs: [0, 2], output: 'collateral_value' },
      { op: 'smull_constant', inputs: [1], constant: 2, output: 'debt_threshold' },
      { op: 'gt', inputs: ['collateral_value', 'debt_threshold'], output: 'result' }
    ]
  }
};

// Execute FHE computation based on IR digest
async function executeFHEComputation(job) {
  const startTime = Date.now();

  const inputCiphertexts = job.ciphertexts || [];
  const jobId = job.job_pda.slice(0, 8);
  logger.info('Job:Processing', 'Starting computation', { job_id: jobId, inputs: inputCiphertexts.length });

  try {
    const irDigest = job.ir_digest;
    if (!irDigest) {
      throw new Error('IR digest is required for computation');
    }

    // Look up operation definition from IR registry
    const operation = FHE_OPERATION_REGISTRY[irDigest];
    if (!operation) {
      throw new Error(`Unknown IR digest: ${irDigest}. Operation not registered.`);
    }

    logger.info('FHE:Operation', operation.description, { 
      operation: operation.name, 
      input_slots: operation.input_slots, 
      steps: operation.execution_plan.length 
    });

    // Validate input count (allow flexibility for dynamic operations)
    if (operation.name !== 'defi_operation' && inputCiphertexts.length !== operation.input_slots) {
      throw new Error(`Input mismatch: operation requires ${operation.input_slots} inputs, got ${inputCiphertexts.length}`);
    }
    
    // For dynamic operations, adjust based on actual input count
    if (operation.name === 'defi_operation') {
      if (inputCiphertexts.length < 2 || inputCiphertexts.length > 3) {
        throw new Error(`DeFi operation requires 2-3 inputs, got ${inputCiphertexts.length}`);
      }
    }

    // Extract ciphertext data from all inputs
    const inputData = [];
    for (let i = 0; i < inputCiphertexts.length; i++) {
      const ct = inputCiphertexts[i];
      
      let ctData;
      if (ct.ciphertext && typeof ct.ciphertext === 'object') {
        if (ct.ciphertext.encrypted_data && ct.ciphertext.encrypted_data.encrypted_data) {
          ctData = ct.ciphertext.encrypted_data.encrypted_data;
        } else if (ct.ciphertext.encrypted_data) {
          ctData = ct.ciphertext.encrypted_data;
        } else {
          throw new Error(`Invalid ciphertext format for input[${i}]`);
        }
      } else {
        throw new Error(`Missing ciphertext data for input[${i}]`);
      }
      
      inputData.push(ctData);
    }

    logger.debug('FHE:Computation', 'Inputs extracted, starting computation', { count: inputData.length });

    // Execute FHE computation
    const result = await executeUniversalFHEComputation(operation, inputData);

    // Generate deterministic result CID
    const resultCiphertext = generateDeterministicResult(result, job, operation, inputCiphertexts.length);

    const executionTime = Date.now() - startTime;
    
    // Final result summary
    if (resultCiphertext.debug_decrypted_result !== null && resultCiphertext.debug_decrypted_result !== undefined) {
      logger.info('FHE:Computation', 'Computation completed successfully', { 
        operation: operation.name, 
        result: resultCiphertext.debug_decrypted_result, 
        time_ms: executionTime 
      });
    }

    return {
      success: true,
      resultCiphertext,
      executionTime
    };

  } catch (error) {
    const executionTime = Date.now() - startTime;
    logger.error('FHE:Computation', 'Computation failed', { error: error.message, time_ms: executionTime });
    
    return {
      success: false,
      error: error.message,
      executionTime
    };
  }
}

// FHE computation executor
async function executeUniversalFHEComputation(operation, inputData) {
  try {
    // Convert all input data to FHE16 Int32Ptr format
    const inputPtrs = [];
    for (let i = 0; i < inputData.length; i++) {
        const ptr = convertJSONToInt32Ptr(inputData[i]);
      inputPtrs.push(ptr);
    }

    // Storage for intermediate values and results
    const computeStack = {};
    
    // Initialize input variables in compute stack
    for (let i = 0; i < inputPtrs.length; i++) {
      computeStack[i] = inputPtrs[i];
    }

    
    // Execute each step in the execution plan
    for (let stepIndex = 0; stepIndex < operation.execution_plan.length; stepIndex++) {
      const step = operation.execution_plan[stepIndex];

      let resultPtr;
      
      // Execute the FHE operation based on type
      switch (step.op) {
        case 'dynamic':
          // Handle dynamic DeFi operations based on input count
          if (inputPtrs.length === 2) {
            // 2 inputs: Simple withdraw check (balance >= amount, then subtract)
            logger.debug('FHE:Operation', 'Executing dynamic withdraw operation', { inputs: 2 });
            const checkPtr = FHE16.ge(computeStack[0], computeStack[1]); // balance >= amount
            
            // WORKAROUND: Use NEG + ADD instead of SUB to avoid FHE16 SUB bug
            const negAmountPtr = FHE16.neg(computeStack[1]);              // -amount
            const subPtr = FHE16.add(computeStack[0], negAmountPtr);      // balance + (-amount) = balance - amount
            
            resultPtr = FHE16.select(checkPtr, subPtr, computeStack[0]);  // if sufficient then subtract, else keep original
          } else if (inputPtrs.length === 3) {
            // 3 inputs: Complex borrow (collateral check + balance update)
            logger.debug('FHE:Operation', 'Executing dynamic borrow operation', { inputs: 3 });
            const collateralCheck = FHE16.smullConst_i32(computeStack[1], 2); // borrow_amount * 2
            const sufficientCollateral = FHE16.ge(computeStack[0], collateralCheck); // SOL >= (borrow * 2)
            const newBalance = FHE16.add(computeStack[2], computeStack[1]); // USDC + borrow_amount
            resultPtr = FHE16.select(sufficientCollateral, newBalance, computeStack[2]); // if sufficient then add, else keep original
          } else {
            throw new Error(`Dynamic operation supports 2-3 inputs, got ${inputPtrs.length}`);
          }
          break;
          
        case 'add':
          const [addInput1, addInput2] = step.inputs.map(input => 
            typeof input === 'number' ? computeStack[input] : computeStack[input]
          );
          resultPtr = FHE16.add(addInput1, addInput2);
          break;
        
        case 'sub':
          const [subInput1, subInput2] = step.inputs.map(input => 
            typeof input === 'number' ? computeStack[input] : computeStack[input]
          );
          resultPtr = FHE16.sub(subInput1, subInput2);
          break;
          
        case 'ge':
          const [geInput1, geInput2] = step.inputs.map(input => 
            typeof input === 'number' ? computeStack[input] : computeStack[input]
          );
          resultPtr = FHE16.ge(geInput1, geInput2);
          break;
          
        case 'smull':
          const [mulInput1, mulInput2] = step.inputs.map(input => 
            typeof input === 'number' ? computeStack[input] : computeStack[input]
          );
          resultPtr = FHE16.smull(mulInput1, mulInput2);
          break;
          
        case 'smull_constant':
          const mulConstInput = typeof step.inputs[0] === 'number' ? 
            computeStack[step.inputs[0]] : computeStack[step.inputs[0]];
          const constant = step.constant || 1;
          resultPtr = FHE16.smullConst_i32(mulConstInput, constant);
          break;
          
        case 'gt':
          const [gtInput1, gtInput2] = step.inputs.map(input => 
            typeof input === 'number' ? computeStack[input] : computeStack[input]
          );
          resultPtr = FHE16.gt(gtInput1, gtInput2);
          break;
          
        case 'select':
          const [condition, trueVal, falseVal] = step.inputs.map(input => 
            typeof input === 'number' ? computeStack[input] : computeStack[input]
          );
          resultPtr = FHE16.select(condition, trueVal, falseVal);
          break;
          
        default:
          throw new Error(`Unsupported FHE operation: ${step.op}`);
      }

      // Store result in compute stack
      computeStack[step.output] = resultPtr;
    }

    // Return the final result
    const finalResult = computeStack['result'];
    if (!finalResult) {
      throw new Error('Execution plan did not produce a result');
    }

    // Convert result Int32Ptr back to JSON array format
    const ref = require('ref-napi');
    const resultLength = 16 + 1040 * 32;
    const resultBuffer = ref.reinterpret(finalResult, resultLength * 4, 0);
    const resultArray = [];
    
    for (let i = 0; i < resultLength; i++) {
      resultArray.push(resultBuffer.readInt32LE(i * 4));
    }

    // DEMO ONLY: Decrypt result for debugging
    let decryptedResult = null;
    if (secretKey) {
      try {
        decryptedResult = FHE16.decInt(finalResult, secretKey);
        logger.debug('FHE:Debug', 'Result decrypted', { value: decryptedResult });
      } catch (decError) {
        logger.warn('FHE:Debug', 'Decryption failed', { error: decError.message });
      }
    }

    return {
      encrypted_data: resultArray,
      scheme: 'FHE16_0.0.1v',
      timestamp: Date.now(),
      operation: operation.name,
      debug_decrypted_result: decryptedResult
    };

  } catch (error) {
    logger.error('FHE:Computation', 'Universal computation failed', { error: error.message });
    throw error;
  }
}

// Extract ciphertext data from job objects
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
function convertJSONToInt32Ptr(ciphertextArray) {
  try {
    // Validate input
    const expectedLength = 16 + 1040 * 32;
    if (!ciphertextArray || ciphertextArray.length !== expectedLength) {
      throw new Error(`Invalid ciphertext length: expected ${expectedLength}, got ${ciphertextArray?.length || 0}`);
    }

    // Convert to Int32Ptr
    const dummyCiphertextPtr = FHE16.encInt(0, 32);
    if (!dummyCiphertextPtr) {
      throw new Error('Failed to create dummy ciphertext');
    }
    
    const ref = require('ref-napi');
    const ctBuffer = ref.reinterpret(dummyCiphertextPtr, expectedLength * 4, 0);
    for (let i = 0; i < ciphertextArray.length; i++) {
      ctBuffer.writeInt32LE(ciphertextArray[i], i * 4);
    }
    
    
    return dummyCiphertextPtr;
    
  } catch (error) {
    logger.error('FHE:Conversion', 'JSON to Int32Ptr conversion failed', { 
      error: error.message, 
      stack: error.stack 
    });
    throw error;
  }
}

// Perform FHE computation on encrypted data
async function performFHEComputation(program, ct1Data, ct2Data, ct3Data = null) {
  try {
    logger.info('FHE:Computation', 'Executing DeFi scenario', { 
      scenario: program.scenario, 
      computation: program.computation 
    });
    
    // Convert to FHE16 Int32Ptr
    const ct1Ptr = convertJSONToInt32Ptr(ct1Data);
    const ct2Ptr = convertJSONToInt32Ptr(ct2Data);
    
    let ct3Ptr = null;
    if (ct3Data) {
      ct3Ptr = convertJSONToInt32Ptr(ct3Data);
    }
    
    if (!ct1Ptr || !ct2Ptr) {
      throw new Error('Failed to convert JSON ciphertexts to Int32Ptr');
    }
    if (ct3Data && !ct3Ptr) {
      throw new Error('Failed to convert CT3 JSON ciphertext to Int32Ptr');
    }
    
    let resultPtr;
    
    switch (program.scenario) {
      case 'deposit_operation':
        logger.debug('FHE:Operation', 'Executing deposit operation');
        resultPtr = FHE16.add(ct1Ptr, ct2Ptr);
        break;
        
      case 'withdraw_operation':
        logger.debug('FHE:Operation', 'Executing withdraw operation');
        resultPtr = FHE16.ge(ct2Ptr, ct1Ptr); 
        break;
        
      case 'borrow_operation':
        logger.debug('FHE:Operation', 'Executing borrow operation');
        const aPtr = FHE16.smullConstant(ct2Ptr, 2);
        const bPtr = FHE16.ge(ct1Ptr, aPtr);
        const dPtr = FHE16.add(ct3Ptr, ct2Ptr);
        resultPtr = FHE16.select(bPtr, dPtr, ct3Ptr);
        break;
        
      case 'liquidation_check':
        logger.debug('FHE:Operation', 'Executing liquidation check operation');
        const debtPenaltyPtr = FHE16.add(ct1Ptr, ct2Ptr);
        const collateralThresholdPtr = FHE16.smull(ct2Ptr, ct1Ptr);
        resultPtr = FHE16.gt(debtPenaltyPtr, collateralThresholdPtr);
        break;
        
      default:
        throw new Error(`Unsupported DeFi scenario: ${program.scenario}`);
    }
    
    if (!resultPtr) {
      throw new Error(`DeFi computation ${program.scenario} returned null pointer`);
    }

    // Convert result Int32Ptr back to JSON array format
    const ref = require('ref-napi');
    const resultLength = 16 + 1040 * 32;
    const resultBuffer = ref.reinterpret(resultPtr, resultLength * 4, 0);
    const resultArray = [];
    
    for (let i = 0; i < resultLength; i++) {
      resultArray.push(resultBuffer.readInt32LE(i * 4));
    }

    // Decrypt for debugging
    let decryptedResult = null;
    if (secretKey) {
      try {
        decryptedResult = FHE16.decInt(resultPtr, secretKey);
        logger.debug('FHE:Debug', 'Result decrypted', { value: decryptedResult, operation: operation.name });
      } catch (decError) {
        logger.warn('FHE:Debug', 'Decryption failed', { error: decError.message });
      }
    }

    return {
      encrypted_data: resultArray,
      scheme: 'FHE16_0.0.1v',
      timestamp: Date.now(),
      operation: operation.name,
      debug_decrypted_result: decryptedResult
    };

  } catch (error) {
    logger.error('FHE:Computation', 'FHE computation failed', { error: error.message });
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
    debug_decrypted_result: result.debug_decrypted_result
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
      return;
    }

    const job = jobsData.jobs[0];
    const jobPda = job.job_pda;
    const jobId = jobPda.slice(0, 8);

    logger.info('Job:Polling', 'Job found, starting processing', { job_id: jobId });
    isProcessing = true;

    await claimJob(jobPda);
    const result = await executeFHEComputation(job);
    await submitResult(
      jobPda,
      result.success,
      result.resultCiphertext,
      result.error || null,
      result.executionTime
    );
    
    if (result.success && result.resultCiphertext?.debug_decrypted_result !== undefined) {
      logger.info('Job:Result', 'Job completed successfully', { 
        job_id: jobId, 
        result: result.resultCiphertext.debug_decrypted_result,
        time_ms: result.executionTime
      });
    }

  } catch (error) {
    logger.error('Job:Processing', 'Job processing failed', { error: error.message });
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
  logger.info('Server', 'Starting FHE Executor Server');
  logger.info('Server', 'Configuration', { 
    gatehouse: GATEHOUSE_URL, 
    port: EXECUTOR_PORT,
    executor_id: EXECUTOR_ID
  });

  const initialized = await initFHE16();
  if (!initialized) {
    logger.error('Server', 'Failed to initialize FHE16');
    process.exit(1);
  }

  server.listen(EXECUTOR_PORT, () => {
    logger.info('Server', 'Server ready', { port: EXECUTOR_PORT });
  });

  logger.info('Job:Polling', 'Starting job polling', { interval_sec: POLL_INTERVAL/1000 });
  setInterval(pollForJobs, POLL_INTERVAL);

  // Initial poll
  setTimeout(pollForJobs, 1000);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Server', 'Shutting down (SIGINT)');
  server.close(() => {
    logger.info('Server', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('Server', 'Shutting down (SIGTERM)');
  server.close(() => {
    logger.info('Server', 'Server closed');
    process.exit(0);
  });
});

// Start the executor
start().catch((error) => {
  logger.error('Server', 'Fatal error', { error: error.message });
  process.exit(1);
});
