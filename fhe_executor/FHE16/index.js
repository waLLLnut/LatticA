// FHE16/index.js — dynamic C++ symbol binding with explicit mangled names
const path = require('path');
const ffi = require('ffi-napi');
const ref = require('ref-napi');

const int = ref.types.int;
const int32 = ref.types.int32;
const int32Ptr = ref.refType(int32);
const long = ref.types.long;        // Linux x64: 8 bytes
const longlong = ref.types.longlong;
const voidPtr = ref.refType(ref.types.void);
const charPtr = ref.refType(ref.types.char);
const sizeT = ref.types.size_t || (process.arch === 'x64' ? ref.types.uint64 : ref.types.uint32);
const sizeTPtr = ref.refType(sizeT);

const soPath = path.join(__dirname, 'lib', 'linux-x64', 'libFHE16.so');
if (!process.env.QUIET_FHE16) console.log('[FHE16] dlopen:', soPath);

const lib = new ffi.DynamicLibrary(
  soPath,
  ffi.DynamicLibrary.FLAGS.RTLD_NOW | ffi.DynamicLibrary.FLAGS.RTLD_GLOBAL
);

function tryGet(name, ret, args) {
  try {
    const p = lib.get(name);
    if (p && !ref.isNull(p)) {
      if (!process.env.QUIET_FHE16) console.log('[FHE16] dlsym OK:', name);
      return ffi.ForeignFunction(p, ret, args);
    }
  } catch (e) {
    if (!process.env.QUIET_FHE16) console.log('[FHE16] dlsym miss:', name, `(${e.message})`);
  }
  return null;
}
function first(cands, ret, args) {
  for (const n of cands) {
    const fn = tryGet(n, ret, args);
    if (fn) return fn;
  }
  return null;
}
function must(names, ret, args) {
  const arr = Array.isArray(names) ? names : [names];
  const fn = first(arr, ret, args);
  if (!fn) throw new Error(`Missing symbol among [${arr.join(', ')}] in ${soPath}`);
  return fn;
}
function bufFromCharPtr(ptr, len) {
  if (!ptr || ref.isNull(ptr) || !len) return Buffer.alloc(0);
  return Buffer.from(ref.reinterpret(ptr, Number(len), 0));
}

/* ---------------- core / serialization ---------------- */

const fnGenEval = must(['_Z13FHE16_GenEvalv', 'FHE16_GenEval'], int32Ptr, []);

const fnBpLoadGlobal      = must(['_Z31fhe16bootparam_load_file_globalPKc', 'fhe16bootparam_load_file_global'], int, ['string']);
const fnBpSaveGlobal      = first(['_Z31fhe16bootparam_save_file_globalPKc', 'fhe16bootparam_save_file_global'], int, ['string']);
const fnBpToBytesGlobal   = first(['_Z30fhe16bootparam_to_bytes_globalv',  'fhe16bootparam_to_bytes_global'], charPtr, []);
const fnBpFromBytesGlobal = first(['_Z32fhe16bootparam_from_bytes_globalPKc', 'fhe16bootparam_from_bytes_global'], int, [charPtr]);
const fnBpFreeHeap        = first(['_Z24fhe16bootparam_free_heapP14FHE16BOOTParam', 'fhe16bootparam_free_heap'], 'void', [voidPtr]);

const fnSkToBytes = first(['_Z24secret_key_to_bytes_safePKiPPcPm', 'secret_key_to_bytes_safe'], int, [int32Ptr, ref.refType(voidPtr), sizeTPtr]);
const fnSkFromBytes = first(['_Z26secret_key_from_bytes_safePKcPPi', 'secret_key_from_bytes_safe'], int, [charPtr, ref.refType(int32Ptr)]);
const fnSkSave = must(['_Z25secret_key_save_file_safePKcPKi', 'secret_key_save_file_safe'], int, ['string', int32Ptr]);
const fnSkLoad = must(['_Z25secret_key_load_file_safePKcPPi', 'secret_key_load_file_safe'], int, ['string', ref.refType(int32Ptr)]);

const fnLweToBytesStrict   = must(['_Z22lwe_to_bytes_meta_safePKiPPcPm', 'lwe_to_bytes_meta_safe'], int, [int32Ptr, ref.refType(voidPtr), sizeTPtr]);
const fnLweFromBytesStrict = must(['_Z24lwe_from_bytes_meta_safePKcmPPi', 'lwe_from_bytes_meta_safe'], int, [charPtr, sizeT, ref.refType(int32Ptr)]);
const fnLweSaveStrict      = must(['_Z18lwe_save_file_safePKcS0_m', 'lwe_save_file_safe'], int, ['string', charPtr, sizeT]);
const fnLweLoadStrict      = must(['_Z18lwe_load_file_safePKcPPcPm', 'lwe_load_file_safe'], int, ['string', ref.refType(voidPtr), sizeTPtr]);

/* ---------------- enc/dec ---------------- */

const fnEnc              = must(['_Z9FHE16_ENCii', 'FHE16_ENC'], int32Ptr, [int, int]);
const fnEncWithTmp       = first(['_Z9FHE16_ENCiiRPiS0_', 'FHE16_ENC'], int32Ptr, [int, int, ref.refType(int32Ptr), ref.refType(int32Ptr)]);
const fnEncInt           = must(['_Z12FHE16_ENCIntii', 'FHE16_ENCInt'], int32Ptr, [int, int]);
const fnEncIntWithTmp    = first(['_Z12FHE16_ENCIntiiRPiS0_', 'FHE16_ENCInt'], int32Ptr, [int, int, ref.refType(int32Ptr), ref.refType(int32Ptr)]);
const fnEncIntVec        = first(['_Z12FHE16_ENCIntPii', 'FHE16_ENCInt'], int32Ptr, [ref.refType(int), int]);
const fnEncIntVecWithTmp = first(['_Z12FHE16_ENCIntPiiRS_S0_', 'FHE16_ENCInt'], int32Ptr, [ref.refType(int), int, ref.refType(int32Ptr), ref.refType(int32Ptr)]);

const fnDec           = must(['_Z9FHE16_DECPiS_iRi', 'FHE16_DEC'], int, [int32Ptr, int32Ptr, int, ref.refType(int)]);
const fnDecInt        = first(['_Z12FHE16_DECIntPiS_', 'FHE16_DECInt'], longlong, [int32Ptr, int32Ptr]);
const fnDecIntVec     = first(['_Z15FHE16_DECIntVecPiS_', 'FHE16_DECIntVec'], int32Ptr, [int32Ptr, int32Ptr]);

/* ---------------- ops: compare/arithmetic/logic/relational ---------------- */

// compare / flag
const fnCompare   = first(['_Z13FHE16_COMPAREPiS_b', 'FHE16_COMPARE'], int32Ptr, [int32Ptr, int32Ptr, int]);
const fnMaxOrMin  = first(['_Z14FHE16_MAXorMINPiS_b','FHE16_MAXorMIN'], int32Ptr, [int32Ptr, int32Ptr, int]);

// arithmetic
const fnAdd  = first(['_Z9FHE16_ADDPiS_', 'FHE16_ADD'], int32Ptr, [int32Ptr, int32Ptr]);
const fnAdd3 = first(['_Z10FHE16_ADD3PiS_S_', 'FHE16_ADD3'], int32Ptr, [int32Ptr, int32Ptr, int32Ptr]);
const fnSub  = first(['_Z9FHE16_SUBPiS_', 'FHE16_SUB'], int32Ptr, [int32Ptr, int32Ptr]);

// relational
const fnLE  = first(['_Z8FHE16_LEPiS_', 'FHE16_LE'], int32Ptr, [int32Ptr, int32Ptr]);
const fnLT  = first(['_Z8FHE16_LTPiS_', 'FHE16_LT'], int32Ptr, [int32Ptr, int32Ptr]);
const fnGE  = first(['_Z8FHE16_GEPiS_', 'FHE16_GE'], int32Ptr, [int32Ptr, int32Ptr]);
const fnGT  = first(['_Z8FHE16_GTPiS_', 'FHE16_GT'], int32Ptr, [int32Ptr, int32Ptr]);
const fnMAX = first(['_Z9FHE16_MAXPiS_', 'FHE16_MAX'], int32Ptr, [int32Ptr, int32Ptr]);
const fnMIN = first(['_Z9FHE16_MINPiS_', 'FHE16_MIN'], int32Ptr, [int32Ptr, int32Ptr]);

// logic / select
const fnANDVEC = first(['_Z12FHE16_ANDVECPiS_', 'FHE16_ANDVEC'], int32Ptr, [int32Ptr, int32Ptr]);
const fnORVEC  = first(['_Z11FHE16_ORVECPiS_',  'FHE16_ORVEC'],  int32Ptr, [int32Ptr, int32Ptr]);
const fnXORVEC = first(['_Z12FHE16_XORVECPiS_', 'FHE16_XORVEC'], int32Ptr, [int32Ptr, int32Ptr]);
const fnSELECT = first(['_Z12FHE16_SELECTPiS_S_', 'FHE16_SELECT'], int32Ptr, [int32Ptr, int32Ptr, int32Ptr]);

// mult/div/relu
const fnSMULL = first(['_Z11FHE16_SMULLPiS_', 'FHE16_SMULL'], int32Ptr, [int32Ptr, int32Ptr]);
const fnSDIV3 = first(['_Z10FHE16_SDIVPiS_S_', 'FHE16_SDIV'], int32Ptr, [int32Ptr, int32Ptr, int32Ptr]);
const fnRELU  = first(['_Z10FHE16_RELUPi', 'FHE16_RELU'], int32Ptr, [int32Ptr]);

/* ---------------- CONSTANTS: 정확한 망글링 길이(20/18) ---------------- */

// SMULL_CONSTANT(ct, cvec=int32_t*)
const fnSMULL_CONST_CVEC = first([
  '_Z20FHE16_SMULL_CONSTANTPiS_',   // FHE16_SMULL_CONSTANT(int*, int*)
], int32Ptr, [int32Ptr, int32Ptr]);

// SMULL_CONSTANT(ct, int)
const fnSMULL_CONST_I32 = first([
  '_Z20FHE16_SMULL_CONSTANTPii',    // FHE16_SMULL_CONSTANT(int*, int)
], int32Ptr, [int32Ptr, int]);

// SMULL_CONSTANT(ct, long)
const fnSMULL_CONST_LONG = first([
  '_Z20FHE16_SMULL_CONSTANTPil',    // FHE16_SMULL_CONSTANT(int*, long)
], int32Ptr, [int32Ptr, long]);

// ADD_CONSTANT(ct, cvec=int32_t*)
const fnADD_CONST_CVEC = first([
  '_Z18FHE16_ADD_CONSTANTPiS_',     // FHE16_ADD_CONSTANT(int*, int*)
], int32Ptr, [int32Ptr, int32Ptr]);

// ADD_CONSTANT(ct, int)
const fnADD_CONST_I32 = first([
  '_Z18FHE16_ADD_CONSTANTPii',      // FHE16_ADD_CONSTANT(int*, int)
], int32Ptr, [int32Ptr, int]);

// ADD_CONSTANT(ct, long)
const fnADD_CONST_LONG = first([
  '_Z18FHE16_ADD_CONSTANTPil',      // FHE16_ADD_CONSTANT(int*, long)
], int32Ptr, [int32Ptr, long]);

/* ---------------- shifts/rot/pow2/neg/abs/eq ---------------- */

const fnLSHIFTL_PTR = first(['_Z13FHE16_LSHIFTLPiS_', 'FHE16_LSHIFTL'], int32Ptr, [int32Ptr, int32Ptr]);

const fnADD_POWTWO = first(['_Z16FHE16_ADD_POWTWOPii', 'FHE16_ADD_POWTWO'], int32Ptr, [int32Ptr, int]);
const fnSUB_POWTWO = first(['_Z16FHE16_SUB_POWTWOPii', 'FHE16_SUB_POWTWO'], int32Ptr, [int32Ptr, int]);
const fnNEG        = first(['_Z9FHE16_NEGPi',          'FHE16_NEG'],        int32Ptr, [int32Ptr]);
const fnABS        = first(['_Z9FHE16_ABSPi',          'FHE16_ABS'],        int32Ptr, [int32Ptr]);
const fnEQ         = first(['_Z8FHE16_EQPiS_',         'FHE16_EQ'],         int32Ptr, [int32Ptr, int32Ptr]);
const fnNEQ        = first(['_Z9FHE16_NEQPiS_',        'FHE16_NEQ'],        int32Ptr, [int32Ptr, int32Ptr]);

/* ----------------------------------- API ----------------------------------- */

const FHE16 = {
  // core
  FHE16_GenEval() { return fnGenEval(); },

  bootparamLoadFileGlobal(p) {
    const rc = fnBpLoadGlobal(p);
    if (rc !== 0) throw new Error(`fhe16bootparam_load_file_global failed: rc=${rc}`);
    return rc;
  },
  bootparamSaveFileGlobal(p) {
    if (!fnBpSaveGlobal) throw new Error('fhe16bootparam_save_file_global not exported');
    const rc = fnBpSaveGlobal(p);
    if (rc !== 0) throw new Error(`fhe16bootparam_save_file_global failed: rc=${rc}`);
    return rc;
  },
  bootparamToBytesGlobal() {
    if (!fnBpToBytesGlobal) throw new Error('fhe16bootparam_to_bytes_global not exported');
    return fnBpToBytesGlobal();
  },
  bootparamFromBytesGlobal(bytesCharPtr) {
    if (!fnBpFromBytesGlobal) throw new Error('fhe16bootparam_from_bytes_global not exported');
    const rc = fnBpFromBytesGlobal(bytesCharPtr);
    if (rc !== 0) throw new Error(`fhe16bootparam_from_bytes_global failed: rc=${rc}`);
    return rc;
  },
  bootparamFreeHeap(bpPtr) { if (fnBpFreeHeap) fnBpFreeHeap(bpPtr); },

  // secret key IO
  secretKeyToBytesSafe(skPtr) {
    if (!fnSkToBytes) throw new Error('secret_key_to_bytes_safe not exported');
    const outPtrPtr = ref.alloc(voidPtr);
    const outLenPtr = ref.alloc(sizeT);
    const rc = fnSkToBytes(skPtr, outPtrPtr, outLenPtr);
    if (rc !== 0) throw new Error(`secret_key_to_bytes_safe failed: rc=${rc}`);
    const len = outLenPtr.deref();
    return bufFromCharPtr(outPtrPtr.deref(), len);
  },
  secretKeyFromBytesSafe(buf) {
    if (!fnSkFromBytes) throw new Error('secret_key_from_bytes_safe not exported');
    const outPtrPtr = ref.alloc(int32Ptr);
    const rc = fnSkFromBytes(buf, outPtrPtr);
    if (rc !== 0) throw new Error(`secret_key_from_bytes_safe failed: rc=${rc}`);
    return outPtrPtr.deref();
  },
  secretKeySaveFileSafe(pathStr, skPtr) {
    const rc = fnSkSave(pathStr, skPtr);
    if (rc !== 0) throw new Error(`secret_key_save_file_safe failed: rc=${rc}`);
    return rc;
  },
  secretKeyLoadFileSafe(pathStr) {
    const out = ref.alloc(int32Ptr);
    const rc = fnSkLoad(pathStr, out);
    if (rc !== 0) throw new Error(`secret_key_load_file_safe failed: rc=${rc}`);
    return out.deref();
  },

  // LWE serialization strict
  lweToBytesStrict(ctPtr) {
    const outPtrPtr = ref.alloc(voidPtr);
    const outLenPtr = ref.alloc(sizeT);
    const rc = fnLweToBytesStrict(ctPtr, outPtrPtr, outLenPtr);
    if (rc !== 0) throw new Error(`lwe_to_bytes_meta_safe(strict) failed: rc=${rc}`);
    const len = outLenPtr.deref();
    return bufFromCharPtr(outPtrPtr.deref(), len);
  },
  lweFromBytesStrict(buf) {
    const outCtPtrPtr = ref.alloc(int32Ptr);
    const rc = fnLweFromBytesStrict(buf, buf.length, outCtPtrPtr);
    if (rc !== 0) throw new Error(`lwe_from_bytes_meta_safe(strict) failed: rc=${rc}`);
    return outCtPtrPtr.deref();
  },
  lweSaveStrict(pathStr, buf) {
    const rc = fnLweSaveStrict(pathStr, buf, buf.length);
    if (rc !== 0) throw new Error(`lwe_save_file_safe(strict) failed: rc=${rc}`);
    return rc;
  },
  lweLoadStrict(pathStr) {
    const outPtrPtr = ref.alloc(voidPtr);
    const outLenPtr = ref.alloc(sizeT);
    const rc = fnLweLoadStrict(pathStr, outPtrPtr, outLenPtr);
    if (rc !== 0) throw new Error(`lwe_load_file_safe(strict) failed: rc=${rc}`);
    const len = outLenPtr.deref();
    return bufFromCharPtr(outPtrPtr.deref(), len);
  },

  // ENC/DEC helpers
  enc(msg, bit) { return fnEnc(msg|0, bit|0); },
  encWithTmp(msg, bit, tmpSkPtrPtr, tmpEPtrPtr) {
    if (!fnEncWithTmp) throw new Error('FHE16_ENC(int,int,int*&,int*&) not exported');
    return fnEncWithTmp(msg|0, bit|0, tmpSkPtrPtr, tmpEPtrPtr);
  },
  encInt(msg, bit) { return fnEncInt(msg|0, bit|0); },
  encIntWithTmp(msg, bit, tmpSkPtrPtr, tmpEPtrPtr) {
    if (!fnEncIntWithTmp) throw new Error('FHE16_ENCInt(int,int,int*&,int*&) not exported');
    return fnEncIntWithTmp(msg|0, bit|0, tmpSkPtrPtr, tmpEPtrPtr);
  },
  encIntVec(vecPtr, bit) {
    if (!fnEncIntVec) throw new Error('FHE16_ENCInt(int*,int) not exported');
    return fnEncIntVec(vecPtr, bit|0);
  },
  encIntVecWithTmp(vecPtr, bit, tmpSkPtrPtr, tmpEPtrPtr) {
    if (!fnEncIntVecWithTmp) throw new Error('FHE16_ENCInt(int*,int,int*&,int*&) not exported');
    return fnEncIntVecWithTmp(vecPtr, bit|0, tmpSkPtrPtr, tmpEPtrPtr);
  },

  dec(ctPtr, skPtr, bits) {
    const E_out = ref.alloc(int);
    const ret = fnDec(ctPtr, skPtr, bits|0, E_out);
    return { value: ret|0, E: E_out.deref()|0 };
  },
  decInt(ctPtr, skPtr) { return Number(fnDecInt ? fnDecInt(ctPtr, skPtr) : this.dec(ctPtr, skPtr, 32).value); },
  decIntVec(ctPtr, skPtr) {
    if (!fnDecIntVec) throw new Error('FHE16_DECIntVec not exported');
    return fnDecIntVec(ctPtr, skPtr);
  },

  // compare / maxOrMin
  compare(a,b,flag){ if (!fnCompare) throw new Error('FHE16_COMPARE not exported'); return fnCompare(a,b,flag?1:0); },
  maxOrMin(a,b,flag){ if (!fnMaxOrMin) throw new Error('FHE16_MAXorMIN not exported'); return fnMaxOrMin(a,b,flag?1:0); },

  // arithmetic
  add(a,b){ if (!fnAdd) throw new Error('FHE16_ADD not exported'); return fnAdd(a,b); },
  add3(a,b,c){ if (!fnAdd3) throw new Error('FHE16_ADD3 not exported'); return fnAdd3(a,b,c); },
  sub(a,b){ if (!fnSub) throw new Error('FHE16_SUB not exported'); return fnSub(a,b); },

  // relational
  le(a,b){ if (!fnLE) throw new Error('FHE16_LE not exported'); return fnLE(a,b); },
  lt(a,b){ if (!fnLT) throw new Error('FHE16_LT not exported'); return fnLT(a,b); },
  ge(a,b){ if (!fnGE) throw new Error('FHE16_GE not exported'); return fnGE(a,b); },
  gt(a,b){ if (!fnGT) throw new Error('FHE16_GT not exported'); return fnGT(a,b); },
  max(a,b){ if (!fnMAX) throw new Error('FHE16_MAX not exported'); return fnMAX(a,b); },
  min(a,b){ if (!fnMIN) throw new Error('FHE16_MIN not exported'); return fnMIN(a,b); },

  // logic
  andVec(a,b){ if (!fnANDVEC) throw new Error('FHE16_ANDVEC not exported'); return fnANDVEC(a,b); },
  orVec(a,b){ if (!fnORVEC) throw new Error('FHE16_ORVEC not exported'); return fnORVEC(a,b); },
  xorVec(a,b){ if (!fnXORVEC) throw new Error('FHE16_XORVEC not exported'); return fnXORVEC(a,b); },
  select(sel,a,b){ if (!fnSELECT) throw new Error('FHE16_SELECT not exported'); return fnSELECT(sel,a,b); },

  // mult/div/relu
  smull(a,b){ if (!fnSMULL) throw new Error('FHE16_SMULL not exported'); return fnSMULL(a,b); },
  sdiv3(a,b,helper){ if (!fnSDIV3) throw new Error('FHE16_SDIV(3-arg) not exported'); return fnSDIV3(a,b,helper); },
  relu(a){ if (!fnRELU) throw new Error('FHE16_RELU not exported'); return fnRELU(a); },

  // constants
  smullConst_cvec(ct, cvec){ if (!fnSMULL_CONST_CVEC) throw new Error('FHE16_SMULL_CONSTANT(ct,cvec) not exported'); return fnSMULL_CONST_CVEC(ct, cvec); },
  smullConst_i32(ct, k){ if (!fnSMULL_CONST_I32) throw new Error('FHE16_SMULL_CONSTANT(ct,int) not exported'); return fnSMULL_CONST_I32(ct, k|0); },
  smullConst_long(ct, k){ if (!fnSMULL_CONST_LONG) throw new Error('FHE16_SMULL_CONSTANT(ct,long) not exported'); return fnSMULL_CONST_LONG(ct, k); },

  addConst_cvec(ct, cvec){ if (!fnADD_CONST_CVEC) throw new Error('FHE16_ADD_CONSTANT(ct,cvec) not exported'); return fnADD_CONST_CVEC(ct, cvec); },
  addConst_i32(ct, k){ if (!fnADD_CONST_I32) throw new Error('FHE16_ADD_CONSTANT(ct,int) not exported'); return fnADD_CONST_I32(ct, k|0); },
  addConst_long(ct, k){ if (!fnADD_CONST_LONG) throw new Error('FHE16_ADD_CONSTANT(ct,long) not exported'); return fnADD_CONST_LONG(ct, k); },

  // shifts (ct, ctK)
  lshiftlPtr(ct, ctK){ if (!fnLSHIFTL_PTR) throw new Error('FHE16_LSHIFTL(int*,int*) not exported'); return fnLSHIFTL_PTR(ct, ctK); },

  // pow2 / neg / abs / eq
  addPow2(ct, p){ if (!fnADD_POWTWO) throw new Error('FHE16_ADD_POWTWO not exported'); return fnADD_POWTWO(ct, p|0); },
  subPow2(ct, p){ if (!fnSUB_POWTWO) throw new Error('FHE16_SUB_POWTWO not exported'); return fnSUB_POWTWO(ct, p|0); },
  neg(ct){ if (!fnNEG) throw new Error('FHE16_NEG not exported'); return fnNEG(ct); },
  abs(ct){ if (!fnABS) throw new Error('FHE16_ABS not exported'); return fnABS(ct); },
  eq(a,b){ if (!fnEQ) throw new Error('FHE16_EQ not exported'); return fnEQ(a,b); },
  neq(a,b){ if (!fnNEQ) throw new Error('FHE16_NEQ not exported'); return fnNEQ(a,b); },
};

module.exports = { FHE16 };

