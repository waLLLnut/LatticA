# Executor 통합 가이드

Lattica Gatehouse와 HTTP API로 통신하여 FHE Job을 실행하는 방법

---

## Ciphertext 자료형

```typescript
interface Ciphertext {
  cid_pda: string           // CID 온체인 주소
  ciphertext: any           // 암호문 데이터 (JSON 직렬화 가능한 모든 타입)
  ciphertext_hash: string   // SHA256 해시 (0x...)
  enc_params: {
    scheme: string          // 예: "FHE16_0.0.1v"
    [key: string]: any
  }
  policy_ctx: {
    allow?: string[]        // 예: ["compute"]
    version?: string        // 예: "1.0"
    decrypt_by?: string     // 예: "owner"
    [key: string]: any
  }
  owner: string             // 소유자 Solana 주소
}
```

**ciphertext 필드 예시**:
```json
// String
"ciphertext": "encrypted_base64_data..."

// Number  
"ciphertext": 123241242342

// Object
"ciphertext": {
  "encrypted_data": 123241242342,
  "nonce": "abc123"
}

// Array
"ciphertext": [1, 2, 3, 4, 5]
```

---

## 워크플로우

```
1. Job 조회    → GET  /api/executor/jobs (암호문 입력 받음)
2. Job 할당    → POST /api/executor/jobs/{job_pda}/claim  
3. FHE 연산    → (로컬) 암호문 간 연산 수행
4. 결과 제출   → POST /api/executor/jobs/{job_pda}/result (결과 암호문)
5. CID 등록    → (자동) Gatehouse가 결과를 온체인 CID로 등록
```

---

## curl 명령어

### 1. Job 조회

```bash
curl -s "http://localhost:3000/api/executor/jobs?limit=10" | jq
```

### 2. Job 할당

```bash
# Job PDA 설정 (1단계에서 얻은 값)
export JOB_PDA="GuNFVsXsDBDfbLELNqL1xZH1ehWh35v4bH9C9JWwm7sU"

# Claim
curl -X POST http://localhost:3000/api/executor/jobs/$JOB_PDA/claim \
  -H "Content-Type: application/json" \
  -d '{"executor": "MyExecutor_v1.0"}' | jq
```

### 3. 결과 제출 (성공)

**중요**: `result_ciphertext`에 **결과 암호문 자체**를 제출합니다.

**Executor 작업**:
- FHE 연산 수행 → 결과 암호문 생성 → Gatehouse에 제출

**Gatehouse 작업** (자동):
- 결과 암호문을 받아서 **온체인 CID로 등록**
- 다음 Job의 입력으로 사용 가능

```bash
curl -X POST http://localhost:3000/api/executor/jobs/$JOB_PDA/result \
  -H "Content-Type: application/json" \
  -d '{
    "executor": "MyExecutor_v1.0",
    "success": true,
    "result_ciphertext": {"encrypted_result": 999888777},
    "execution_time_ms": 5000
  }' | jq
```

### 4. 결과 제출 (실패)

```bash
curl -X POST http://localhost:3000/api/executor/jobs/$JOB_PDA/result \
  -H "Content-Type: application/json" \
  -d '{
    "executor": "MyExecutor_v1.0",
    "success": false,
    "error": "FHE operation failed",
    "execution_time_ms": 100
  }' | jq
```

---

## 전체 테스트 스크립트

```bash
#!/bin/bash
# 복사 후 바로 실행 가능

GATEHOUSE="http://localhost:3000/api/executor"
EXECUTOR_ID="TestExecutor_$(date +%s)"

# 1. Job 조회
JOBS=$(curl -s "${GATEHOUSE}/jobs?limit=1")
JOB_COUNT=$(echo "$JOBS" | jq '.total')

if [ "$JOB_COUNT" -eq 0 ]; then
  echo "❌ Job 없음"
  exit 1
fi

JOB_PDA=$(echo "$JOBS" | jq -r '.jobs[0].job_pda')
echo "✅ Job: $JOB_PDA"

# 2. Claim
curl -s -X POST "$GATEHOUSE/jobs/$JOB_PDA/claim" \
  -H "Content-Type: application/json" \
  -d "{\"executor\": \"$EXECUTOR_ID\"}" | jq

# 3. FHE 연산 수행
sleep 2
RESULT_CIPHERTEXT='{"encrypted_result": 999888777}'

# 4. 결과 제출 (Gatehouse가 자동으로 온체인 CID 등록)
curl -s -X POST "$GATEHOUSE/jobs/$JOB_PDA/result" \
  -H "Content-Type: application/json" \
  -d "{
    \"executor\": \"$EXECUTOR_ID\",
    \"success\": true,
    \"result_ciphertext\": $RESULT_CIPHERTEXT,
    \"execution_time_ms\": 2000
  }" | jq

echo "✅ 완료"
```

**저장 후 실행**:
```bash
chmod +x test-executor.sh
./test-executor.sh
```

---

## 상태 확인

```bash
# 서비스 상태
curl -s "http://localhost:3000/api/init" | jq '.services'

# Job 큐 상태
curl -s "http://localhost:3000/api/init" | jq '.services.job_queue'

# 대시보드
./dashboard.sh
```

---

## Job 제출 (Blinks)

```
# 1. CID 등록
https://www.blinks.xyz/inspector?url=http://localhost:3000/api/actions/job/registerCIDs

# 2. Job 제출
https://www.blinks.xyz/inspector?url=http://localhost:3000/api/actions/job/submit
```

---

**실행 가능한 스크립트**: `test-executor.sh` (저장소에 포함)
