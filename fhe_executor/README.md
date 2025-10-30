# FHE Executor Server

An executor server that communicates with **Lattica Gatehouse** and runs FHE jobs.

## Overview

- **Port**: 3001  
- **Gatehouse endpoint**: http://localhost:3000  
- **How it works**: Polls the Gatehouse on port 3000 and processes incoming job requests.

## Structure

```
fhe_executor/
├── FHE16/                  # FHE16 library (copied from lattica-gatehouse)
│   ├── index.js            # FFI bindings
│   ├── dev-init.js         # Initialization script
│   ├── lib/                # Native library
│   └── store/              # Keys and bootstrap parameters
├── server.js               # Executor server main file
├── package.json
└── README.md
```

## Workflow

1. **Fetch jobs**: `GET /api/executor/jobs` (polls every 5 seconds)  
2. **Claim job**: `POST /api/executor/jobs/{job_pda}/claim`  
3. **FHE compute**: Perform ciphertext-to-ciphertext operations locally  
4. **Submit result**: `POST /api/executor/jobs/{job_pda}/result`

## Installation

> **You must install and use Node 20.11.1 exactly**

```bash
cd fhe_executor
nvm install 20.11.1
nvm use 20.11.1
rm -rf node_modules package-lock.json
npm install
```

## Run

### Development mode (includes FHE16 initialization)

```bash
npm run dev
```

### Normal run

```bash
npm start
```

## Endpoints

### Health Check
```bash
curl http://localhost:3001/health
```

### Status
```bash
curl http://localhost:3001/status
```

Example response:
```json
{
  "executor_id": "FHE_Executor_1234567890",
  "port": 3001,
  "gatehouse_url": "http://localhost:3000",
  "is_processing": false,
  "uptime": 123.456
}
```

## Environment Requirements

- **OS**: Linux x86_64  
- **Node.js**: **v20.11.1 (required)**  
- **jemalloc**: recommended (to prevent TLS errors)

```bash
sudo apt-get install -y libjemalloc2
```

If using jemalloc:
```bash
LD_PRELOAD=/lib/x86_64-linux-gnu/libjemalloc.so.2 npm run dev
```

## FHE Compute Implementation

The current `executeFHEComputation()` is a placeholder. To implement real FHE operations:

```javascript
async function executeFHEComputation(job) {
  const startTime = Date.now();

  // Example with FHE16 library:
  // const ct1 = FHE16.lweFromBytes(job.input_cids[0].ciphertext);
  // const ct2 = FHE16.lweFromBytes(job.input_cids[1].ciphertext);
  // const result = FHE16.add(ct1, ct2);
  // const resultBytes = FHE16.lweToBytes(result);

  const executionTime = Date.now() - startTime;

  return {
    success: true,
    resultCiphertext: resultBytes, // actual ciphertext result
    executionTime
  };
}
```

## Decryption (Planned)

Planned additions:

- Decryption with the secret key  
- Result verification  
- Partial decryption support

## Manual asset download locations

If you download assets manually, place them in **both** locations:

```
fhe16_executer/FHE16/store/boot/bootkey.bin
fhe16_executer/FHE16/store/keys/secret.bin
```

## Log Example

```
[FHE_EXECUTOR] Starting FHE Executor Server...
[FHE_EXECUTOR] Executor ID: FHE_Executor_1234567890
[FHE_EXECUTOR] Gatehouse URL: http://localhost:3000
[FHE_EXECUTOR] Initializing FHE16...
[FHE_EXECUTOR] FHE16 initialized successfully
[FHE_EXECUTOR] Server listening on port 3001
[FHE_EXECUTOR] Health check: http://localhost:3001/health
[FHE_EXECUTOR] Status endpoint: http://localhost:3001/status
[FHE_EXECUTOR] Starting job polling (interval: 5000ms)...
[FHE_EXECUTOR] No jobs available
[FHE_EXECUTOR] Found job: GuNFVsXsDBDfbLELNqL1xZH1ehWh35v4bH9C9JWwm7sU
[FHE_EXECUTOR] Claiming job...
[FHE_EXECUTOR] Job claimed successfully
[FHE_EXECUTOR] Processing job: GuNFVsXsDBDfbLELNqL1xZH1ehWh35v4bH9C9JWwm7sU
[FHE_EXECUTOR] Job type: compute
[FHE_EXECUTOR] Input ciphertexts: 2
[FHE_EXECUTOR] Submitting result...
[FHE_EXECUTOR] Result submitted successfully
```

## References

- Gatehouse EXECUTOR_GUIDE: `lattica-gatehouse/EXECUTOR_GUIDE.md`  
- FHE16 README: `FHE16/README.md`

## License

UNLICENSED (Private)
