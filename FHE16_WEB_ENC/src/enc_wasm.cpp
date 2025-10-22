// enc_wasm.cpp  — FHE16 WASM 래퍼 (메타 16 + 데이터 1040 = 총 1056개)
//
// 요구사항
// - 결과는 int32 배열 1056개로 구성
//   CT[0] = bit 개수 (HTML에서 32 고정으로 호출)
//   CT[1] = 1040
//   CT[2] = 4160
//   CT[3..15] = 0
//   CT[16..]  = 데이터부 1040개 (부족하면 0 패딩, 넘치면 잘라냄)
// - 문자열 버전: "32,1040,4160,0,...,<1040개>"  (size 프리픽스 없음)
// - 바이너리 버전: 1056*4 바이트 버퍼를 malloc으로 만들어 포인터/바이트수 반환
//
// CMake(예시)에서 반드시 export 하세요:
// -sMODULARIZE=1 -sEXPORT_NAME=createFHE16 -sFORCE_FILESYSTEM=1
// -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8
// -sEXPORTED_FUNCTIONS=['_malloc','_free','_FHE16_init_params','_FHE16_set_pk','_FHE16_load_pk_from_fs','_FHE16_ENC_WASM','_FHE16_ENC_BIN','_FHE16_free']
//

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <random>
#include <string>
#include <sstream>
#include <vector>

#ifdef __EMSCRIPTEN__
  #include <emscripten/emscripten.h>
#else
  #ifndef EMSCRIPTEN_KEEPALIVE
    #if defined(__GNUC__) || defined(__clang__)
      #define EMSCRIPTEN_KEEPALIVE __attribute__((used))
    #else
      #define EMSCRIPTEN_KEEPALIVE
    #endif
  #endif
#endif

// ===== 파라미터/PK 저장 영역 =====
struct FHE16PARAM {
    int _PK_row = 0;
    int _PK_col = 0;
    int _PK_Q   = 1;
    double _Q_TOT = 1.0;
    double _sigma_bs = 1.0;
};
static FHE16PARAM g_P;

static std::vector<int32_t> g_PK; // row-major, length = PK_row * PK_col

// ===== 유틸 =====
static std::mt19937_64 make_strong_engine() {
    std::random_device rd;
    std::vector<uint32_t> seeds(16);
    for (auto &s : seeds) s = rd();
    std::seed_seq seq(seeds.begin(), seeds.end());
    return std::mt19937_64(seq);
}
static inline int iround(double x) {
    return (int)llround(x);
}

// ===== 내부 암호화 코어 (원 알고리즘에 최대한 맞춤) =====
// 반환: 길이 PK_col 의 int32 벡터
static std::vector<int32_t> FHE16_ENC_core(int msg, int bit) {
    const int PK_row = g_P._PK_row;
    const int PK_col = g_P._PK_col;
    const int PK_Q   = g_P._PK_Q;
    const int BL_Q   = (int)g_P._Q_TOT;

    std::vector<int32_t> CT(1040*bit, 0);
    std::vector<int64_t> CT_LARGE(1040*bit, 0);
    std::vector<int> tmp_E(PK_col*bit, 0), tmp_SK(PK_row*bit, 0);

    auto eng = make_strong_engine();
    std::normal_distribution<double> dis_E_DG(0.0, g_P._sigma_bs);

    // 비밀/노이즈
    for (int jj = 0; jj < PK_row*bit; ++jj) tmp_SK[jj] = iround(dis_E_DG(eng));
    for (int jj = 0; jj < PK_col*bit; ++jj) tmp_E[jj]  = iround(dis_E_DG(eng));


    // PK 필요
    if ((int)g_PK.size() < PK_row * PK_col) {
        // PK 없음 → 0 벡터 반환
        return CT;
    }
    const int32_t* PK = g_PK.data();
	/*
    // CT_LARGE += PK(row, col) * sk[row]
    for (int bit_idx =0; jj < bit; bit_idx++) {
		for (int jjj = 0; jjj < 1025; jjj++) {
			CT_LARGE[col] = 0;
		}

		for (int row = 0; row < PK_row; ++row) {
			const int tmp_sk_val = tmp_SK[row + bit_idx*PK_row];
			const int row_base   = row * PK_col;
			for (int col = 0; col < PK_col; ++col) {
				CT_LARGE[col] += (int64_t)PK[row_base + col] * (int64_t)tmp_sk_val;
			}
		}

		// 잡음 더하기
		for (int col = 0; col < PK_col; ++col) {
			CT_LARGE[col] += (int64_t)tmp_E[col];
		}

    // 메시지 주입
    if (PK_col > 0) {
        CT_LARGE[PK_col - 1] += (int64_t)msg * (((int64_t)BL_Q) >> bit);
    }

    // 모듈러 및 보정
    for (int col = 0; col < PK_col; ++col) {
        int64_t t = CT_LARGE[col] % PK_Q;
        int32_t v = (int32_t)t;
        v += (v >> 31) & PK_Q;   // 음수 보정
        CT[col] = v;
    }
    // Reduce to BL_Q
    for (int col = 0; col < PK_col; ++col) {
        if (CT[col] > BL_Q) CT[col] -= BL_Q;
    }
	*/
	
	int tmp_msg = msg;
	int CT_length = 1040;

    for (int bit_idx = 0; bit_idx < bit; bit_idx++) {
        int bit_idx_prod_CT_length  = bit_idx * CT_length;
        int bit_idx_prod_PK_row     = bit_idx * PK_row;
        for (int row = 0; row < PK_row; row++) {
            int tmp_sk_val = tmp_SK[bit_idx_prod_PK_row + row];
            int row_prod_PK_col =   row*PK_col;
            for (int col = 0; col < PK_col; col++) {
                CT_LARGE[bit_idx_prod_CT_length + col] +=  (int64_t) (  (  (int64_t)PK[row_prod_PK_col + col]) * ((int64_t)tmp_sk_val));
            }
        }
		
		int bit_idx_prod_PK_col     = bit_idx*PK_col;
        for (int col = 0; col < PK_col; col++) {
            CT_LARGE[bit_idx_prod_CT_length + col]          += (int64_t)tmp_E[bit_idx_prod_PK_col + col];
        }

		CT_LARGE[bit_idx_prod_CT_length + PK_col-1] += ((int64_t)(tmp_msg & 1)) * (((int64_t)BL_Q) >> 2);
        // HAHA ... 
        for (int col = 0; col < PK_col; col++) {
            CT[16 + bit_idx_prod_CT_length + col] = (int32_t) (CT_LARGE[ bit_idx_prod_CT_length + col] % PK_Q);
            CT[16 + bit_idx_prod_CT_length + col] += (CT[16 + bit_idx_prod_CT_length + col] >> 31) & PK_Q;
        }
		
		tmp_msg >>= 1;

        // Reduce to BK_Q
        for (int col = 0; col < PK_col; col++) {
            if (CT[16 + bit_idx_prod_CT_length + col] > BL_Q) {
                CT[16 + bit_idx_prod_CT_length + col] -= BL_Q;
            }
        }
	}
	return CT; // 길이 = PK_col
}

// ===== 1056개(16 + 1040) 구성 =====
static void build_ct1056(const std::vector<int32_t>& ct_raw, int bit_fixed,
                         std::vector<int32_t>& out1056) {
    const int META_N = 16;
    const int DATA_N = 1040*32;

    // 데이터부 1040으로 패딩하거나 자르기
    std::vector<int32_t> data(DATA_N, 0);
    const int copyN = std::min<int>(DATA_N, (int)ct_raw.size());
    if (copyN > 0) std::memcpy(data.data(), ct_raw.data(), copyN * sizeof(int32_t));

    out1056.resize(META_N + DATA_N);

    // 메타 채우기
    out1056[0] = bit_fixed;   // 예: 32
    out1056[1] = DATA_N;      // 1040
    out1056[2] = 6;        // 요구값
    for (int i = 3; i < META_N; ++i) out1056[i] = 0;

    // 데이터부 붙이기
    std::memcpy(out1056.data() + META_N, data.data(), DATA_N * sizeof(int32_t));
}

// 문자열 CSV 직렬화 (size 프리픽스 없음)
static std::string serialize_ct_csv(const std::vector<int32_t>& v) {
    std::ostringstream oss;
    for (size_t i = 0; i < v.size(); ++i) {
        if (i) oss << ',';
        oss << v[i];
    }
    return oss.str();
}

// ===== 외부 API =====
extern "C" {

// 파라미터 설정
EMSCRIPTEN_KEEPALIVE
void FHE16_init_params(int pk_row, int pk_col, int pk_Q, double Q_TOT, double sigma) {
    g_P._PK_row   = pk_row;
    g_P._PK_col   = pk_col;
    g_P._PK_Q     = pk_Q;
    g_P._Q_TOT    = Q_TOT;
    g_P._sigma_bs = sigma;
}

// JS 힙 포인터로 PK 직접 설정 (length = int32 개수)
EMSCRIPTEN_KEEPALIVE
void FHE16_set_pk(const int32_t* pk_ptr, int length) {
    if (!pk_ptr || length <= 0) { g_PK.clear(); g_PK.shrink_to_fit(); return; }
    g_PK.assign(pk_ptr, pk_ptr + length);
}

// 패키징/프리로드된 파일에서 PK 로딩 (path 예: "/pk.bin")
EMSCRIPTEN_KEEPALIVE
int FHE16_load_pk_from_fs(const char* path) {
    if (!path) return 0;
    FILE* fp = std::fopen(path, "rb");
    if (!fp) return 0;

    std::fseek(fp, 0, SEEK_END);
    long fsz = std::ftell(fp);
    std::fseek(fp, 0, SEEK_SET);

    if (fsz <= 0 || (fsz % (long)sizeof(int32_t)) != 0) {
        std::fclose(fp); return 0;
    }
    size_t n = (size_t)fsz / sizeof(int32_t);

    // 파라미터가 설정된 경우, 기대 크기 검사
    if (g_P._PK_row > 0 && g_P._PK_col > 0) {
        const size_t expect = (size_t)g_P._PK_row * (size_t)g_P._PK_col;
        if (expect != n) {
            std::fclose(fp); return 0;
        }
    }

    g_PK.resize(n);
    size_t rd = std::fread(g_PK.data(), sizeof(int32_t), n, fp);
    std::fclose(fp);
    if (rd != n) { g_PK.clear(); g_PK.shrink_to_fit(); return 0; }

    return 1;
}

// 문자열 버전: "32,1040,4160,0,...,<1040개>"
EMSCRIPTEN_KEEPALIVE
char* FHE16_ENC_WASM(int32_t msg, int bit) {
    
	auto ct_raw = FHE16_ENC_core(msg, 32);
    std::vector<int32_t> ct1056;
    build_ct1056(ct_raw, bit, ct1056);

    const std::string s = serialize_ct_csv(ct1056);
    char* out = (char*)std::malloc(s.size() + 1);
    if (!out) return nullptr;
    std::memcpy(out, s.data(), s.size());
    out[s.size()] = '\0';
    return out;
}

// 바이너리 버전: 1056*4 바이트 버퍼 할당 → 포인터/바이트수 반환
// 반환값: 요소 개수(1056), 실패 시 0
EMSCRIPTEN_KEEPALIVE
int FHE16_ENC_BIN(int32_t msg, int bit, uint32_t* out_ptr, int32_t* out_nbytes) {
    if (!out_ptr || !out_nbytes) return 0;

    auto ct_raw = FHE16_ENC_core(msg, bit);
    std::vector<int32_t> ct1056;
    build_ct1056(ct_raw, bit, ct1056);

    const size_t nbytes = ct1056.size() * sizeof(int32_t); // 1056*4
    int32_t* buf = (int32_t*)std::malloc(nbytes);
    if (!buf) return 0;

    std::memcpy(buf, ct1056.data(), nbytes);
    *out_ptr   = (uint32_t)(uintptr_t)buf; // wasm32에서 포인터 32bit
    *out_nbytes = (int32_t)nbytes;
    return (int)ct1056.size(); // 1056
}

// free
EMSCRIPTEN_KEEPALIVE
void FHE16_free(void* p) { std::free(p); }

} // extern "C"

