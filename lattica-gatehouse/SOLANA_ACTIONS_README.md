# 게이트키퍼 Confidential Job Actions

이 프로젝트는 게이트키퍼 네트워크에 기밀 계산 작업을 제출하는 Solana Actions를 구현한 것입니다. **fromExternal → in** 표준화 레이어를 통해 외부 입력을 등록하고, 등록된 CIDs로 작업을 제출하는 2단계 워크플로우를 제공합니다.

## 전체 워크플로우

게이트키퍼 네트워크의 완전한 워크플로우는 다음과 같습니다:

```
1. registerCIDs → 2. submit (with registered CIDs)
```

### 워크플로우 단계별 설명

1. **registerCIDs**: 외부 입력을 표준 암호문으로 변환하고 CIDs로 등록
2. **submit**: 등록된 CIDs를 사용하여 기밀 계산 작업 제출

## 구현된 엔드포인트

### 1. actions.json
- **위치**: `/public/actions.json`
- **기능**: Solana Actions 규칙 매핑
- **CORS**: 모든 요청에 대해 허용

### 2. Job Register CIDs 액션
- **GET** `/api/actions/job/registerCIDs`
  - 클라이언트 사이드 암호화를 위한 FHE CPK 정보 반환
  - 입력 필드: ciphertexts, enc_params, policy_ctx, provenance
  - FHE CPK: cpk_id, public_key, domain_hash, key_epoch, scheme
- **POST** `/api/actions/job/registerCIDs`
  - 클라이언트가 이미 암호화한 ciphertexts를 받아서 등록
  - Offchain Store에 저장하여 CIDs 생성
  - 서명된 등록 영수증 발급 (provenance 포함)
  - 다음 단계: submit으로 연결

### 3. Job Submit 액션 (수정됨)
- **GET** `/api/actions/job/submit?inputs=[...]`
  - 등록된 CIDs로 작업 제출 액션 메타데이터 반환
  - Preview 기능: CIDs 유효성 검사 및 상태 표시
- **POST** `/api/actions/job/submit`
  - 등록된 CIDs만 사용하여 작업 제출 트랜잭션 생성
  - CID 존재 여부 확인 (등록된 CIDs만 허용)
  - 커밋 계산 및 검증 정보 포함

## POST 요청 형식

### Register CIDs
```json
{
  "ciphertexts": [{"encrypted_data": "base64_ciphertext1"}, {"encrypted_data": "base64_ciphertext2"}],
  "enc_params": {"scheme": "TFHE", "params": {}},
  "policy_ctx": {"allow": ["read"], "deny": ["write"]},
  "provenance": "client"
}
```

### Submit Job
```json
{
  "account": "Base58User",
  "inputs": [{"cid":"QmXXX"}, {"cid":"QmYYY"}],
  "ir_digest": "0xIR...",
  "enc_params": {...},
  "policy_ctx": {...},
  "nonce": "0x..." // optional
}
```

## POST 응답 형식

### Register CIDs Response
```json
{
  "reg_id": "RID-1700000000-abc123",
  "cids": [{"cid":"QmXXX"}, {"cid":"QmYYY"}],
  "receipt": {
    "reg_id": "RID-1700000000-abc123",
    "cids": [...],
    "enc_params": {...},
    "policy_ctx": {...},
    "provenance": "client",
    "domain": {...},
    "created_at": 1700000000,
    "sig": {
      "algo": "ed25519",
      "identity": "ActionIdentity11111111111111111111111111111111",
      "signature": "base64_signature"
    }
  },
  "links": {
    "next": {"type": "post", "href": "/api/actions/job/submit"}
  },
  "hint": {
    "use_in_submit": "/api/actions/job/submit?inputs=[...]"
  }
}
```

### Submit Job Response
```json
{
  "transaction": "BASE64_TX(gatekeeper::submit_job(...))",
  "message": "Submit confidential compute",
  "verification": {
    "algo": "sha256",
    "domain_hash": "0x...",
    "preimage": {...},
    "hashes": {...},
    "accountsOrder": [...],
    "argsOrder": [...],
    "pda": {...},
    "programId": "..."
  }
}
```

## CORS 설정

모든 엔드포인트는 다음 CORS 헤더를 포함합니다:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET,POST,PUT,OPTIONS`
- `Access-Control-Allow-Headers: Content-Type, Authorization, Content-Encoding, Accept-Encoding`

## Action Identity

모든 POST 트랜잭션에는 Action Identity 메모가 포함됩니다:
```
solana-action:<identity>:<reference>:<signature>
```

## 사용 예시

### Blink URL 예시
```
# CID 등록
solana-action:https://aegis.run/actions/job/registerCIDs

# 작업 제출
solana-action:https://aegis.run/actions/job/submit
```

### 인터스티셜 URL 예시
```
https://dial.to/?action=solana-action%3Ahttps%3A%2F%2Faegis.run%2Factions%2Fjob%2FregisterCIDs
```

## 개발 서버 실행

```bash
npm run dev
```

## 테스트

### 시퀀스 순서대로 테스트

```bash
#!/bin/bash

echo "=== 1. GET Register CIDs Action Metadata ==="
curl -X GET http://localhost:3000/api/actions/job/registerCIDs \
  -H "Accept: application/json" \
  -w "\nStatus: %{http_code}\n\n"

echo "=== 2. POST Register CIDs ==="
curl -X POST http://localhost:3000/api/actions/job/registerCIDs \
  -H "Content-Type: application/json" \
  -d '{
    "ciphertexts": [{"encrypted_data": "base64_ciphertext1"}, {"encrypted_data": "base64_ciphertext2"}],
    "enc_params": {"scheme": "FHE16", "params": {}},
    "policy_ctx": {"allow": ["read"], "deny": ["write"]},
    "provenance": "client"
  }' \
  -w "\nStatus: %{http_code}\n\n"

echo "=== 3. GET Submit Job with Preview ==="
curl -X GET "http://localhost:3000/api/actions/job/submit?inputs=[{\"cid\":\"QmXXX\"},{\"cid\":\"QmYYY\"}]" \
  -H "Accept: application/json" \
  -w "\nStatus: %{http_code}\n\n"

echo "=== 4. POST Submit Job ==="
curl -X POST http://localhost:3000/api/actions/job/submit \
  -H "Content-Type: application/json" \
  -d '{
    "account": "11111111111111111111111111111111",
    "inputs": [{"cid":"QmXXX"}, {"cid":"QmYYY"}],
    "ir_digest": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "enc_params": {"scheme": "FHE16", "params": {}},
    "policy_ctx": {"allow": ["read"], "deny": ["write"]}
  }' \
  -w "\nStatus: %{http_code}\n\n"

echo "=== 5. GET actions.json ==="
curl -X GET http://localhost:3000/actions.json \
  -H "Accept: application/json" \
  -w "\nStatus: %{http_code}\n\n"
```