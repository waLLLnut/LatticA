/// <reference types="node" />

export type Int32Ptr = Buffer;
export type Int32PtrPtr = Buffer;
export type VoidPtr = Buffer;

export const RAW: any;

export function makeInt32Buffer(values: number[]): Buffer;
export function readInt32Vector(ptr: Buffer, length: number): Int32Array;
export function allocInt32PtrPtr(): Buffer;

export function allocCharPtrPtr(): Buffer; // char**
export function allocSizeTPtr(): Buffer;   // size_t*
export function readSizeT(szPtr: Buffer): number | bigint;
export function readBytes(ptr: Buffer, len: number | bigint): Buffer;
export function freeCString(ptr: Buffer): void;

export const FHE16: {
  RAW: any;

  // helpers
  makeInt32Buffer(values: number[]): Buffer;
  readInt32Vector(ptr: Buffer, length: number): Int32Array;
  allocInt32PtrPtr(): Buffer;
  allocCharPtrPtr(): Buffer;
  allocSizeTPtr(): Buffer;
  readSizeT(szPtr: Buffer): number | bigint;
  readBytes(ptr: Buffer, len: number | bigint): Buffer;
  freeCString(ptr: Buffer): void;

  // CT 인덱스(4번째 int32) 유틸
  readCtIndex(ctPtr: Int32Ptr): number;
  writeCtIndex(ctPtr: Int32Ptr, idx: number): void;

  // ===== Eval key =====
  loadEval(): void;
  genEval(): Int32Ptr;
  genEvalKey(): Int32Ptr;       // alias
  FHE16_GenEval(): Int32Ptr;    // alias (C 스타일 이름)
  deleteEval(): void;

  // ===== ENC / ENCInt =====
  encWithTmp(msg: number, bit: number, tmpSK: Int32PtrPtr, tmpE: Int32PtrPtr): Int32Ptr;
  enc(msg: number, bit: number): Int32Ptr;

  encIntWithTmp(msg: number, bit: number, tmpSK: Int32PtrPtr, tmpE: Int32PtrPtr): Int32Ptr;
  encInt(msg: number, bit: number): Int32Ptr;

  encIntVecWithTmp(msgBuf: Int32Ptr, bit: number, tmpSK: Int32PtrPtr, tmpE: Int32PtrPtr): Int32Ptr;
  encIntVec(msgBuf: Int32Ptr, bit: number): Int32Ptr;

  // ===== DEC =====
  dec(CT: Int32Ptr, sk: Int32Ptr, bits: number, E_out?: Buffer): number;
  decInt(CT: Int32Ptr, sk: Int32Ptr): number; // 2^53-1 초과 정밀 주의
  decIntVec(CT: Int32Ptr, sk: Int32Ptr): Int32Ptr;

  // ===== Compare / Flag =====
  prefixFlag(a: Int32Ptr, b: Int32Ptr, flag: boolean): Int32Ptr;
  compare(a: Int32Ptr, b: Int32Ptr, flag: boolean): Int32Ptr;
  maxOrMin(a: Int32Ptr, b: Int32Ptr, flag: boolean): Int32Ptr;

  // ===== Arithmetic =====
  add(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  add3(a: Int32Ptr, b: Int32Ptr, c: Int32Ptr): Int32Ptr;
  sub(a: Int32Ptr, b: Int32Ptr): Int32Ptr;

  // ===== Relational =====
  le(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  lt(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  ge(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  gt(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  max(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  min(a: Int32Ptr, b: Int32Ptr): Int32Ptr;

  // ===== Logic / bitwise =====
  andvec(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  orvec(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  xorvec(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  select(sel: Int32Ptr, a: Int32Ptr, b: Int32Ptr): Int32Ptr;

  // ===== Mult / Div / Relu =====
  smull(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  sdiv(a: Int32Ptr, b: Int32Ptr, ct_rem: Int32Ptr, is_zero: Int32Ptr): Int32Ptr;
  relu(a: Int32Ptr): Int32Ptr;

  // ===== Constant =====
  smullConstCVec(ct: Int32Ptr, cvec: Int32Ptr): Int32Ptr;
  smullConstI64(ct: Int32Ptr, k: number | bigint): Int32Ptr;
  smullConstI32(ct: Int32Ptr, k: number): Int32Ptr;

  addConstCVec(ct: Int32Ptr, cvec: Int32Ptr): Int32Ptr;
  addConstI64(ct: Int32Ptr, k: number | bigint): Int32Ptr;
  addConstI32(ct: Int32Ptr, k: number): Int32Ptr;

  // ===== Shifts / Rotations =====
  lshiftl(ct: Int32Ptr, k: number): Int32Ptr;
  lshiftr(ct: Int32Ptr, k: number): Int32Ptr;
  ashiftr(ct: Int32Ptr, k: number): Int32Ptr;
  rotatel(ct: Int32Ptr, k: number): Int32Ptr;
  rotater(ct: Int32Ptr, k: number): Int32Ptr;

  // ===== Pow2 / Neg / Abs / Eq =====
  addPow2(ct: Int32Ptr, p: number): Int32Ptr;
  subPow2(ct: Int32Ptr, p: number): Int32Ptr;
  neg(ct: Int32Ptr): Int32Ptr;
  abs(ct: Int32Ptr): Int32Ptr;
  eq(a: Int32Ptr, b: Int32Ptr): Int32Ptr;
  neq(a: Int32Ptr, b: Int32Ptr): Int32Ptr;

  // ===== Plain =====
  lzcPlain(x: number): number;

  // ===== LWE Serialization (safe) =====
  lweToBytes(ctPtr: Int32Ptr): Buffer;
  lweFromBytes(bytesBuf: Buffer): Int32Ptr;
  lweSaveFile(path: string, bytesBuf: Buffer): number;
  lweLoadFile(path: string): Buffer;

  // (옵션) 레거시(널종단 가정)
  __legacy_lweToBytes(ctPtr: Int32Ptr): Buffer;
  __legacy_lweFromBytes(cStrPtrOrBuf: Buffer): Int32Ptr;
  __legacy_lweSaveFile(path: string, cStrPtrOrBuf: Buffer): number;
  __legacy_lweLoadFile(path: string): Buffer;

  // ===== BOOT Param =====
  bootparamToBytesSafe(bpPtr: VoidPtr): Buffer;
  bootparamFromBytesSafe(bytesBuf: Buffer, outBpPtr: VoidPtr): number;
  bootparamSaveFileSafe(path: string, bytesBuf: Buffer): number;
  bootparamLoadFileSafe(path: string): Buffer;
  bootparamFreeHeap(bpPtr: VoidPtr): void;

  // 전역(Global) 레거시
  bootparamToBytesGlobalLegacy(): Buffer;
  bootparamFromBytesGlobalLegacy(bytesPtrOrBuf: Buffer): number;
  bootparamSaveFileGlobalLegacy(path: string): number;
  bootparamLoadFileGlobalLegacy(path: string): number;
};

export const FHE16Storage: {
  setBaseDir(dir?: string): void; // 기본 ~/.fhe16, env FHE16_STORAGE_DIR 도 지원
  getPaths(): {
    baseDir: string;
    bootFile: string;
    ctDir: string;
    nextIndexFile: string;
    ctFileForIndex: (idx: number) => string;
  };
  saveGlobalBootKey(): string;        // 저장된 파일 경로 반환
  loadGlobalBootKey(): string;        // 로드한 파일 경로 반환
  saveCiphertext(ctPtr: Int32Ptr): { index: number; path: string };
  loadCiphertext(index: number): Int32Ptr;
  listCiphertextIndices(): number[];
};

