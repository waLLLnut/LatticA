// cxx/fhe16_capi.cc
#include <cstdint>

// ✅ include 순서 주의: 이전 빌드 에러를 피하려고 권장 순서
#include "BinOperationCstyle.hpp"
#include "soAPI.hpp"
// (필요 시) 내부 타입/선언 선행 노출
#include "math/ntttable.hpp"
#include "lwe/FHE16Param.hpp"

extern "C" {

// ---------- Eval key ----------
void fhe16_load_eval() { FHE16_LoadEval(); }
int32_t* fhe16_gen_eval() { return FHE16_GenEval(); }
void fhe16_delete_eval() { FHE16_DeleteEval(); }

// ---------- ENC / ENCInt (오버로드 분리) ----------
int32_t* fhe16_enc_with_tmp(int msg, int bit, int32_t** tmp_SK, int32_t** tmp_E) {
    return FHE16_ENC(msg, bit, *tmp_SK, *tmp_E);
}
int32_t* fhe16_enc(int msg, int bit) {
    return FHE16_ENC(msg, bit);
}

int32_t* fhe16_enc_int_with_tmp(int msg, int bit, int32_t** tmp_SK, int32_t** tmp_E) {
    return FHE16_ENCInt(msg, bit, *tmp_SK, *tmp_E);
}
int32_t* fhe16_enc_int(int msg, int bit) {
    return FHE16_ENCInt(msg, bit);
}
int32_t* fhe16_enc_int_vec_with_tmp(int* msg, int bit, int32_t** tmp_SK, int32_t** tmp_E) {
    return FHE16_ENCInt(msg, bit, *tmp_SK, *tmp_E);
}
int32_t* fhe16_enc_int_vec(int* msg, int bit) {
    return FHE16_ENCInt(msg, bit);
}

// ---------- DEC ----------
int fhe16_dec(const int32_t* CT, const int32_t* sk, int bits, int* E_out) {
    int Etmp = 0;
    int ret = FHE16_DEC(const_cast<int32_t*>(CT), const_cast<int32_t*>(sk), bits, Etmp);
    if (E_out) *E_out = Etmp;
    return ret;
}
long long fhe16_dec_int(const int32_t* CT, const int32_t* sk) {
    return FHE16_DECInt(const_cast<int32_t*>(CT), const_cast<int32_t*>(sk));
}
int32_t* fhe16_dec_int_vec(const int32_t* CT, const int32_t* sk) {
    return FHE16_DECIntVec(const_cast<int32_t*>(CT), const_cast<int32_t*>(sk));
}

// ---------- Compare / Flag ----------
int32_t* fhe16_prefix_flag(const int32_t* a, const int32_t* b, bool flag) {
    return FHE16_PREFIX_FLAG(const_cast<int32_t*>(a), const_cast<int32_t*>(b), flag);
}
int32_t* fhe16_compare(const int32_t* a, const int32_t* b, bool flag) {
    return FHE16_COMPARE(const_cast<int32_t*>(a), const_cast<int32_t*>(b), flag);
}
int32_t* fhe16_max_or_min(const int32_t* a, const int32_t* b, bool flag) {
    return FHE16_MAXorMIN(const_cast<int32_t*>(a), const_cast<int32_t*>(b), flag);
}

// ---------- Arithmetic ----------
int32_t* fhe16_add(const int32_t* a, const int32_t* b) {
    return FHE16_ADD(const_cast<int32_t*>(a), const_cast<int32_t*>(b));
}
int32_t* fhe16_add3(const int32_t* a, const int32_t* b, const int32_t* c) {
    return FHE16_ADD3(const_cast<int32_t*>(a), const_cast<int32_t*>(b), const_cast<int32_t*>(c));
}
int32_t* fhe16_sub(const int32_t* a, const int32_t* b) {
    return FHE16_SUB(const_cast<int32_t*>(a), const_cast<int32_t*>(b));
}

// ---------- Relational ----------
int32_t* fhe16_le(const int32_t* a, const int32_t* b) { return FHE16_LE(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_lt(const int32_t* a, const int32_t* b) { return FHE16_LT(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_ge(const int32_t* a, const int32_t* b) { return FHE16_GE(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_gt(const int32_t* a, const int32_t* b) { return FHE16_GT(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_max(const int32_t* a, const int32_t* b) { return FHE16_MAX(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_min(const int32_t* a, const int32_t* b) { return FHE16_MIN(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }

// ---------- Logic / bitwise ----------
int32_t* fhe16_andvec(const int32_t* a, const int32_t* b) { return FHE16_ANDVEC(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_orvec (const int32_t* a, const int32_t* b) { return FHE16_ORVEC (const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_xorvec(const int32_t* a, const int32_t* b) { return FHE16_XORVEC(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_select(const int32_t* sel, const int32_t* a, const int32_t* b) {
    return FHE16_SELECT(const_cast<int32_t*>(sel), const_cast<int32_t*>(a), const_cast<int32_t*>(b));
}

// ---------- Mult / Div / Relu ----------
int32_t* fhe16_smull(const int32_t* a, const int32_t* b) {
    return FHE16_SMULL(const_cast<int32_t*>(a), const_cast<int32_t*>(b));
}
int32_t* fhe16_sdiv(const int32_t* a, const int32_t* b, const int32_t* ct_rem, const int32_t* is_zero) {
    return FHE16_SDIV(const_cast<int32_t*>(a), const_cast<int32_t*>(b),
                      const_cast<int32_t*>(ct_rem), const_cast<int32_t*>(is_zero));
}
int32_t* fhe16_relu(const int32_t* a) { return FHE16_RELU(const_cast<int32_t*>(a)); }

// ---------- CONSTANT (오버로드 분리) ----------
int32_t* fhe16_smull_constant_cvec(const int32_t* ct, const int32_t* constant_vec) {
    return FHE16_SMULL_CONSTANT(const_cast<int32_t*>(ct), const_cast<int32_t*>(constant_vec));
}
int32_t* fhe16_smull_constant_i64(const int32_t* ct, long long k) {
    return FHE16_SMULL_CONSTANT(const_cast<int32_t*>(ct), (int64_t)k);
}
int32_t* fhe16_smull_constant_i32(const int32_t* ct, int k) {
    return FHE16_SMULL_CONSTANT(const_cast<int32_t*>(ct), k);
}

int32_t* fhe16_add_constant_cvec(const int32_t* ct, const int32_t* constant_vec) {
    return FHE16_ADD_CONSTANT(const_cast<int32_t*>(ct), const_cast<int32_t*>(constant_vec));
}
int32_t* fhe16_add_constant_i64(const int32_t* ct, long long k) {
    return FHE16_ADD_CONSTANT(const_cast<int32_t*>(ct), (int64_t)k);
}
int32_t* fhe16_add_constant_i32(const int32_t* ct, int k) {
    return FHE16_ADD_CONSTANT(const_cast<int32_t*>(ct), k);
}

// ---------- Shifts / Rotations ----------
int32_t* fhe16_lshiftl(const int32_t* ct, int k) { return FHE16_LSHIFTL(const_cast<int32_t*>(ct), k); }
int32_t* fhe16_lshiftr(const int32_t* ct, int k) { return FHE16_LSHIFTR(const_cast<int32_t*>(ct), k); }
int32_t* fhe16_ashiftr(const int32_t* ct, int k) { return FHE16_ASHIFTR(const_cast<int32_t*>(ct), k); }
int32_t* fhe16_rotatel(const int32_t* ct, int k) { return FHE16_ROTATEL(const_cast<int32_t*>(ct), k); }
int32_t* fhe16_rotater(const int32_t* ct, int k) { return FHE16_ROTATER(const_cast<int32_t*>(ct), k); }

// ---------- Pow2 / Neg / Abs / Eq ----------
int32_t* fhe16_add_powtwo(const int32_t* ct, int pow) { return FHE16_ADD_POWTWO(const_cast<int32_t*>(ct), pow); }
int32_t* fhe16_sub_powtwo(const int32_t* ct, int pow) { return FHE16_SUB_POWTWO(const_cast<int32_t*>(ct), pow); }
int32_t* fhe16_neg(const int32_t* ct) { return FHE16_NEG(const_cast<int32_t*>(ct)); }
int32_t* fhe16_abs(const int32_t* ct) { return FHE16_ABS(const_cast<int32_t*>(ct)); }

int32_t* fhe16_eq (const int32_t* a, const int32_t* b) { return FHE16_EQ (const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }
int32_t* fhe16_neq(const int32_t* a, const int32_t* b) { return FHE16_NEQ(const_cast<int32_t*>(a), const_cast<int32_t*>(b)); }

// ---------- Plain ----------
int32_t fhe16_lzc_plain(int x) { return FHE16_LZC_Plain(x); }

} // extern "C"

