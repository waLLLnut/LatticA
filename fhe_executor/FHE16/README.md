# FHE16 (Node FFI)

C++ FHE16 네이티브 라이브러리(`libFHE16.so`)를 **Node.js**에서 직접 호출하기 위한 얇은 바인딩과 초기화 절차입니다.  
이 폴더(`FHE16/`)만 복사하면 **다른 Node 기반 서버**에서도 그대로 재사용할 수 있습니다.

---

## 지원 환경
- **OS/CPU:** Linux x86_64  
- **Node:** v18+ (권장 LTS)  
- **런타임:** Node (예: Next.js API Route는 `export const runtime = 'nodejs'`)

---

## 디렉터리 구조

```
FHE16/
├─ index.js                  # ffi-napi 바인딩: 지연 바인딩, C++ 망글링 심볼 우선
├─ dev-init.js               # 서버 시작 전 1회 초기화 스크립트
├─ lib/linux-x64/libFHE16.so # C++ 공유 라이브러리
└─ store/
   ├─ boot/bootparam.bin     # 글로벌 부트스트랩 파라미터 파일
   └─ keys/secret.bin        # 시크릿 키 직렬화 파일
```

> 경로를 바꾸고 싶으면 `dev-init.js`에서 경로만 수정하세요.

---

## 설치

```bash
npm i ffi-napi ref-napi
# (권장) jemalloc 설치: TLS 에러 예방
sudo apt-get install -y libjemalloc2
```

---

## 서버 실행 (예: Next.js)

루트 `package.json` 예시:

```json
{
  "scripts": {
    "dev": "LD_PRELOAD=/lib/x86_64-linux-gnu/libjemalloc.so.2 node ./FHE16/dev-init.js && LD_PRELOAD=/lib/x86_64-linux-gnu/libjemalloc.so.2 next dev"
  }
}
```

- **LD_PRELOAD**로 **jemalloc**을 **Node 시작 전에** 선로딩하여 `static TLS block` 에러를 방지합니다.  
- 배포판에 따라 경로가 `/usr/lib/x86_64-linux-gnu/libjemalloc.so.2`일 수 있으니 실제 경로로 교체하세요.  
- 다른 Node 서버도 동일 패턴:
  ```bash
  LD_PRELOAD=/path/to/libjemalloc.so.2 node ./FHE16/dev-init.js && LD_PRELOAD=/path/to/libjemalloc.so.2 node server.js
  ```

---

## 초기화 순서 (핵심 플로우)

**`FHE16/dev-init.js`** 실행 시:

1. **GenEval 호출** → 내부적으로 `aligned_alloc` 경로를 타며 메모리 정렬 보장  
2. **글로벌 부트스트랩 파라미터 로드** → `FHE16/store/boot/bootparam.bin`  
3. **시크릿 키 로드** → `FHE16/store/keys/secret.bin` 을 메모리 포인터로 복원

경로 기본값:
```
bootparam: FHE16/store/boot/bootparam.bin
secretkey: FHE16/store/keys/secret.bin
```

---

## JS 바인딩 사용법 (요약)

```js
const { FHE16 } = require('./FHE16/index.js');

// 1) GenEval: 정렬된 메모리 초기 확보
const skInitPtr = FHE16.FHE16_GenEval(); // int32_t*

// 2) Bootparam 글로벌 로드
FHE16.bootparamLoadFileGlobal('/abs/path/to/FHE16/store/boot/bootparam.bin');

// 3) Secret key 로드 (파일 → int32_t*)
const skPtr = FHE16.secretKeyLoadFileSafe('/abs/path/to/FHE16/store/keys/secret.bin');
```

- 바인딩은 **지연 바인딩**이며, **C++ 망글링 심볼을 우선** 시도합니다.  
  - GenEval: `_Z13FHE16_GenEvalv` → `FHE16_GenEval` → `fhe16_gen_eval`  
  - Bootparam Global: `_Z31fhe16bootparam_load_file_globalPKc` → `fhe16bootparam_load_file_global`  
  - Secret Key Load: `_Z25secret_key_load_file_safePKcPPi` → `secret_key_load_file_safe`  
- 반환 포인터는 **네이티브 메모리**입니다. Node에서 해제하지 말고 C++ 라이브러리에 맡기세요.

---

## dev-init.js (예시)

```js
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const ref = require('ref-napi');
const { FHE16 } = require('./index.js');

(async () => {
  try {
    const baseDir    = path.join(__dirname, 'store');
    const bootPath   = path.join(baseDir, 'boot',  'bootparam.bin');
    const secretPath = path.join(baseDir, 'keys',  'secret.bin');

    if (!fs.existsSync(bootPath))   throw new Error(`bootparam not found: ${bootPath}`);
    if (!fs.existsSync(secretPath)) throw new Error(`secret key not found: ${secretPath}`);

    const skInitPtr = FHE16.FHE16_GenEval();
    if (!skInitPtr || ref.isNull(skInitPtr)) throw new Error('GenEval returned null');
    console.log('[FHE16] GenEval OK');

    console.log('[FHE16] Load bootparam:', bootPath);
    FHE16.bootparamLoadFileGlobal(bootPath);

    console.log('[FHE16] Load secret key:', secretPath);
    const skPtr = FHE16.secretKeyLoadFileSafe(secretPath);
    if (!skPtr || ref.isNull(skPtr)) throw new Error('secret key ptr null');

    console.log('[FHE16] init OK ✅');
  } catch (e) {
    console.error('[FHE16] init error:', e.message || e);
  }
})();
```

---

## 심볼 점검 치트시트

```bash
# 핵심 심볼 검색(동적 심볼 테이블)
nm -D FHE16/lib/linux-x64/libFHE16.so | egrep '_Z13FHE16_GenEvalv|FHE16_GenEval|fhe16_gen_eval'
nm -D FHE16/lib/linux-x64/libFHE16.so | egrep '_Z31fhe16bootparam_load_file_globalPKc|fhe16bootparam_load_file_global'
nm -D FHE16/lib/linux-x64/libFHE16.so | egrep '_Z25secret_key_load_file_safePKcPPi|secret_key_load_file_safe'

# 디맨글
nm -D --demangle FHE16/lib/linux-x64/libFHE16.so | egrep 'FHE16_GenEval|fhe16bootparam_load_file_global|secret_key_load_file_safe'

# 바인딩/가시성(더 정확)
objdump -T FHE16/lib/linux-x64/libFHE16.so | egrep 'GenEval|bootparam_load_file_global|secret_key_load_file_safe'
```

---

## 트러블슈팅

### A) `cannot allocate memory in static TLS block`
- 원인: jemalloc을 늦게 로드  
- 해결: **LD_PRELOAD**로 jemalloc **선로딩**
  ```bash
  LD_PRELOAD=/lib/x86_64-linux-gnu/libjemalloc.so.2 npm run dev
  ```

### B) `undefined symbol: <name>`
1) 심볼 존재 확인 후(위 치트시트),  
2) 망글링 심볼만 있다면 **index.js**가 망글링 우선으로 dlsym하도록 유지(기본값),  
3) 특정 심볼이 다른 `.so`에 있을 수 있으니, 필요하면 같은 폴더의 `.so`를 **RTLD_GLOBAL**로 선로딩하도록 확장.

### C) `fhe16bootparam_load_file_global failed: rc=-2`
- 의미: 파일은 열렸지만 포맷/버전/길이 검증 실패  
- 조치: 해당 파일을 **같은 API(글로벌 저장)**로 만든 게 맞는지 확인  
  - 필요 시 `*_load_file_safe + from_bytes_global` 조합으로 폴백 구현 가능(바인딩 확장)

### D) 실제 여는 .so/파일 확인
```bash
realpath FHE16/lib/linux-x64/libFHE16.so
stat -c '%n %s bytes' FHE16/lib/linux-x64/libFHE16.so
md5sum FHE16/lib/linux-x64/libFHE16.so
```

---

## 보안/권한 권고
- `FHE16/store/keys/secret.bin`은 **민감 정보**  
  - 권장 퍼미션: 디렉터리 `700`, 파일 `600`  
  - VCS 제외: `.gitignore` 등록  
  - 서버 배포 시 외부 마운트/비밀 저장소 사용 고려

---

## 커스터마이즈 포인트
- 경로 외부화:
  ```js
  const baseDir = process.env.FHE16_STORAGE_DIR || path.join(__dirname, 'store');
  ```
- 폴백 로더 추가: 환경에 따라 `*_load_file_safe + from_bytes_global` 조합을 `index.js`에 추가  
- 추가 네이티브 API 바인딩: `nm -D`로 망글링 문자열 확인 후 `index.js`에 후보 배열로 등록

---

## 요약
- **jemalloc 선로딩** → **지연 바인딩(망글링 우선)** → **초기화(GenEval → Bootparam → Secret)**  
- `FHE16/` 디렉터리(`index.js`, `dev-init.js`, `lib/`, `store/`)만 복사하면 **다른 Node 서버에서도 즉시 사용**할 수 있습니다.
