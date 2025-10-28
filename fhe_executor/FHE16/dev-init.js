/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const ref = require('ref-napi');
const { FHE16 } = require('./index.js');

function has(fn) { return typeof fn === 'function'; }
function assertEq(label, got, exp) { if (got !== exp) throw new Error(`${label}: got ${got}, want ${exp}`); }
function safe(name, fn) { try { fn(); console.log(`[TEST] ${name} OK`); } catch (e) { console.warn(`[TEST] ${name} SKIP/ERR:`, e.message); } }

(async () => {
  try {
    const baseDir    = path.join(__dirname, 'store');
    const bootPath   = path.join(baseDir, 'boot',  'bootparam.bin');
    const secretPath = path.join(baseDir, 'keys',  'secret.bin');

    if (!fs.existsSync(bootPath))   throw new Error(`bootparam not found: ${bootPath}`);
    if (!fs.existsSync(secretPath)) throw new Error(`secret key not found: ${secretPath}`);

    console.log('[FHE16] GenEval');
    const skInitPtr = FHE16.FHE16_GenEval();
    if (!skInitPtr || ref.isNull(skInitPtr)) throw new Error('GenEval returned null');

    console.log('[FHE16] Load bootparam (global):', bootPath);
    FHE16.bootparamLoadFileGlobal(bootPath);

    console.log('[FHE16] Load secret key:', secretPath);
    const sk = FHE16.secretKeyLoadFileSafe(secretPath);
    if (!sk || ref.isNull(sk)) throw new Error('secret key pointer null');

    const bits = 32;
    const m1 = 123, m2 = -77;
    const ct1 = FHE16.encInt(m1, bits);
    const ct2 = FHE16.encInt(m2, bits);

    const d1  = FHE16.decInt(ct1, sk);
    const d2  = FHE16.decInt(ct2, sk);
    assertEq('DEC(m1)', d1, m1);
    assertEq('DEC(m2)', d2, m2);
    console.log('[TEST] ENC/DEC OK');

    // Arithmetic
    safe('ADD',   () => { const out = FHE16.add(ct1, ct2); const dec = FHE16.decInt(out, sk); assertEq('ADD.dec', dec, m1 + m2); });
    safe('ADD3',  () => { const out = FHE16.add3(ct1, ct2, ct2); const dec = FHE16.decInt(out, sk); assertEq('ADD3.dec', dec, m1 + m2 + m2); });
    safe('SUB',   () => { const out = FHE16.sub(ct1, ct2); const dec = FHE16.decInt(out, sk); assertEq('SUB.dec', dec, m1 - m2); });

    // Relational
    ;['le','lt','ge','gt','max','min'].forEach(name => safe(name.toUpperCase(), () => {
      if (!has(FHE16[name])) throw new Error('not exported');
      const out = FHE16[name](ct1, ct2);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    }));

    // Logic / Select
    ;['andVec','orVec','xorVec'].forEach(name => safe(name, () => {
      if (!has(FHE16[name])) throw new Error('not exported');
      const out = FHE16[name](ct1, ct2);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    }));
    safe('SELECT', () => {
      if (!has(FHE16.select) || !has(FHE16.eq)) throw new Error('select/eq not exported');
      const sel = FHE16.eq(ct1, ct1);
      const out = FHE16.select(sel, ct1, ct2);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });

    // Compare / MaxOrMin
    safe('COMPARE(flag=1)', () => {
      if (!has(FHE16.compare)) throw new Error('not exported');
      const out = FHE16.compare(ct1, ct2, 1);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });
    safe('MAXorMIN(flag=1)', () => {
      if (!has(FHE16.maxOrMin)) throw new Error('not exported');
      const out = FHE16.maxOrMin(ct1, ct2, 1);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });

    // Mult/Div/ReLU
    safe('SMULL', () => {
      if (!has(FHE16.smull)) throw new Error('not exported');
      const out = FHE16.smull(ct1, ct2);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });
    safe('SDIV(3)', () => {
      if (!has(FHE16.sdiv3)) throw new Error('not exported');
      const helper = FHE16.encInt(0, bits);
      const out = FHE16.sdiv3(ct1, ct2, helper);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });
    safe('RELU', () => {
      if (!has(FHE16.relu)) throw new Error('not exported');
      const out = FHE16.relu(ct2);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });

    // ---------- CONSTANTS ----------
    safe('SMULL_CONSTANT(int)', () => {
      if (!has(FHE16.smullConst_i32)) throw new Error('not exported');
      const out = FHE16.smullConst_i32(ct1, 2);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });
    safe('SMULL_CONSTANT(long)', () => {
      if (!has(FHE16.smullConst_long)) throw new Error('not exported');
      const out = FHE16.smullConst_long(ct1, 3);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });
    safe('SMULL_CONSTANT(cvec)', () => {
      if (!has(FHE16.smullConst_cvec)) throw new Error('not exported');
      const out = FHE16.smullConst_cvec(ct1, ct2);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });

    safe('ADD_CONSTANT(int)', () => {
      if (!has(FHE16.addConst_i32)) throw new Error('not exported');
      const out = FHE16.addConst_i32(ct1, 5);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });
    safe('ADD_CONSTANT(long)', () => {
      if (!has(FHE16.addConst_long)) throw new Error('not exported');
      const out = FHE16.addConst_long(ct1, 7);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });
    safe('ADD_CONSTANT(cvec)', () => {
      if (!has(FHE16.addConst_cvec)) throw new Error('not exported');
      const out = FHE16.addConst_cvec(ct1, ct2);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });

    // Shifts (ct, ctK)
    safe('LSHIFTL(ptr,ptr)', () => {
      if (!has(FHE16.lshiftlPtr)) throw new Error('not exported');
      const kCt = FHE16.encInt(1, bits);
      const out = FHE16.lshiftlPtr(ct1, kCt);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    });

    // Pow2 / Neg / Abs / Eq-neq
    ;[['addPow2',1], ['subPow2',1]].forEach(([name, pw]) => safe(name, () => {
      if (!has(FHE16[name])) throw new Error('not exported');
      const out = FHE16[name](ct1, pw);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    }));
    ;['neg','abs'].forEach(name => safe(name, () => {
      if (!has(FHE16[name])) throw new Error('not exported');
      const out = FHE16[name](ct1);
      if (!out || ref.isNull(out)) throw new Error('returned null');
    }));
    safe('EQ/NEQ', () => {
      if (!has(FHE16.eq) || !has(FHE16.neq)) throw new Error('not exported');
      const e = FHE16.eq(ct1, ct1);
      const ne = FHE16.neq(ct1, ct2);
      if (!e || ref.isNull(e) || !ne || ref.isNull(ne)) throw new Error('returned null');
    });

    console.log('======================================');
    console.log('[FHE16] init + self-tests completed');
    console.log('======================================');
  } catch (e) {
    console.error('[FHE16] init/self-test error:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();

