# FHE Executor Server

Lattica Gatehouse와 통신하여 FHE Job을 실행하는 Executor 서버입니다.

## 개요

- **포트**: 3001
- **Gatehouse 연결**: http://localhost:3000
- **동작 방식**: 3000 포트의 Gatehouse에 폴링하며 Job 요청을 처리

## 구조

```
fhe_executor/
├── FHE16/                  # FHE16 라이브러리 (lattica-gatehouse에서 복사)
│   ├── index.js            # FFI 바인딩
│   ├── dev-init.js         # 초기화 스크립트
│   ├── lib/                # 네이티브 라이브러리
│   └── store/              # 키 및 부트스트랩 파라미터
├── server.js               # Executor 서버 메인 파일
├── package.json
└── README.md
```

## 워크플로우

1. **Job 조회**: GET /api/executor/jobs (5초마다 폴링)
2. **Job 할당**: POST /api/executor/jobs/{job_pda}/claim
3. **FHE 연산**: 로컬에서 암호문 간 연산 수행
4. **결과 제출**: POST /api/executor/jobs/{job_pda}/result

## 설치

```bash
cd fhe_executor
npm install
```

## 실행

### 개발 모드 (FHE16 초기화 포함)

```bash
npm run dev
```

### 일반 실행

```bash
npm start
```

## 엔드포인트

### Health Check
```bash
curl http://localhost:3001/health
```

### Status
```bash
curl http://localhost:3001/status
```

응답 예시:
```json
{
  "executor_id": "FHE_Executor_1234567890",
  "port": 3001,
  "gatehouse_url": "http://localhost:3000",
  "is_processing": false,
  "uptime": 123.456
}
```

## 환경 요구사항

- **OS**: Linux x86_64
- **Node.js**: v18+ (권장 LTS)
- **jemalloc**: 설치 권장 (TLS 에러 방지)

```bash
sudo apt-get install -y libjemalloc2
```

jemalloc을 사용하는 경우:
```bash
LD_PRELOAD=/lib/x86_64-linux-gnu/libjemalloc.so.2 npm run dev
```

## FHE 연산 구현

현재 `executeFHEComputation()` 함수는 플레이스홀더입니다. 실제 FHE 연산을 구현하려면:

```javascript
async function executeFHEComputation(job) {
  const startTime = Date.now();

  // FHE16 라이브러리 사용 예시
  // const ct1 = FHE16.lweFromBytes(job.input_cids[0].ciphertext);
  // const ct2 = FHE16.lweFromBytes(job.input_cids[1].ciphertext);
  // const result = FHE16.add(ct1, ct2);
  // const resultBytes = FHE16.lweToBytes(result);

  const executionTime = Date.now() - startTime;

  return {
    success: true,
    resultCiphertext: resultBytes, // 실제 암호문 결과
    executionTime
  };
}
```

## 복호화 기능 추가 (예정)

추후 복호화 기능을 추가할 예정입니다:

- 시크릿 키를 사용한 복호화
- 결과 검증
- 부분 복호화 지원

## 로그 예시

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

## 참고

- Gatehouse EXECUTOR_GUIDE: `lattica-gatehouse/EXECUTOR_GUIDE.md`
- FHE16 README: `FHE16/README.md`

## 라이선스

UNLICENSED (Private)
