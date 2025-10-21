use std::os::raw::c_int;
use std::process::exit;
//use std::ffi::c_int;


pub type Ct = *mut i32;
pub type Sk = *mut i32;




pub fn check_system_env() {
    // 1) AVX512 체크 (그대로 유지)
    let avx512_ok = is_x86_feature_detected!("avx512f");
    if !avx512_ok {
        eprintln!("[ERROR] AVX512 not supported on this CPU.");
        eprintln!("        Please run on an AVX512-capable CPU.");
        std::process::exit(1);
    }

    // 2) NUMA 사용 여부: env가 우선, 없으면 기본 false
    let use_numa = std::env::var("FHE_NUMA")
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1"|"on"|"true"|"yes"))
        .unwrap_or(false);

    if use_numa {
        // 동적 로딩으로 libnuma 체크 (링크 불필요)
        use libloading::{Library, Symbol};
        unsafe {
            match Library::new("libnuma.so.1") {
                Ok(lib) => {
                    let sym: std::result::Result<
                        Symbol<unsafe extern "C" fn() -> c_int>,
                        libloading::Error
                    > = lib.get(b"numa_available\0");

                    match sym {
                        Ok(numa_avail) => {
                            let code = numa_avail();
                            if code < 0 {
                                eprintln!("[ERROR] NUMA library loaded but numa_available() returned {}.", code);
                                std::process::exit(1);
                            } else {
                                println!("[INFO] NUMA available (code={})", code);
                            }
                        }
                        Err(_) => {
                            eprintln!("[ERROR] libnuma loaded but symbol `numa_available` missing.");
                            eprintln!("        Try: sudo apt install libnuma-dev");
                            std::process::exit(1);
                        }
                    }
                }
                Err(_) => {
                    eprintln!("[ERROR] FHE_NUMA=on but libnuma.so.1 not found.");
                    eprintln!("        Install: sudo apt install libnuma-dev");
                    std::process::exit(1);
                }
            }
        }
    } else {
        println!("[INFO] NUMA disabled (FHE_NUMA off/unset).");
    }

    println!("[INFO] System check passed.");
}

/*
pub fn check_system_env() {
    use std::os::raw::c_int;
    use std::process::exit;

    // 1️⃣ AVX512 확인
    let avx512_ok = is_x86_feature_detected!("avx512f");
    if !avx512_ok {
        eprintln!("[ERROR] AVX512 not supported on this CPU.");
        eprintln!("        Please run on AVX512-capable CPU (Skylake-X, Ice Lake, etc.)");
        unsafe { exit(1); }
    }

    // 2️⃣ NUMA 확인
    use libloading::{Library, Symbol};

    let lib = unsafe { Library::new("libnuma.so.1") };
    match lib {
        Ok(libnuma) => unsafe {
            let sym: std::result::Result<Symbol<unsafe extern "C" fn() -> c_int>, libloading::Error> =
                libnuma.get(b"numa_available\0");
            match sym {
                Ok(numa_avail) => {
                    let res = numa_avail();
                    if res >= 0 {
                        println!("[INFO] NUMA available (code={})", res);
                    } else {
                        eprintln!("[WARN] NUMA library loaded, but numa_available() returned {}.", res);
                    }
                }
                Err(_) => {
                    eprintln!("[WARN] AVX512 OK but cannot find numa_available() symbol.");
                    eprintln!("       Try installing: sudo apt install libnuma-dev");
                    unsafe { exit(1); }
                }
            }
        },
        Err(_) => unsafe {
            eprintln!("[WARN] AVX512 is available but libnuma not found.");
            eprintln!("       Please install NUMA library:\n         sudo apt install libnuma-dev\n");
            exit(1);
        },
    }

    println!("[INFO] System check passed: AVX512 + NUMA ready.");
}
*/




extern "C" {
    // Eval key
    pub fn fhe16_load_eval();
    pub fn fhe16_gen_eval() -> Sk;
    pub fn fhe16_delete_eval();

    // ENC / ENCInt (overload 분리)
    pub fn fhe16_enc_with_tmp(msg: c_int, bit: c_int, tmp_sk: *mut *mut i32, tmp_e: *mut *mut i32) -> Ct;
    pub fn fhe16_enc(msg: c_int, bit: c_int) -> Ct;

    pub fn fhe16_enc_int_with_tmp(msg: c_int, bit: c_int, tmp_sk: *mut *mut i32, tmp_e: *mut *mut i32) -> Ct;
    pub fn fhe16_enc_int(msg: c_int, bit: c_int) -> Ct;

    pub fn fhe16_enc_int_vec_with_tmp(msg: *mut c_int, bit: c_int, tmp_sk: *mut *mut i32, tmp_e: *mut *mut i32) -> Ct;
    pub fn fhe16_enc_int_vec(msg: *mut c_int, bit: c_int) -> Ct;

    // DEC
    pub fn fhe16_dec(ct: *const i32, sk: *const i32, bits: c_int, e_out: *mut c_int) -> c_int;
    pub fn fhe16_dec_int(ct: *const i32, sk: *const i32) -> i64;
    pub fn fhe16_dec_int_vec(ct: *const i32, sk: *const i32) -> Ct;

    // Compare / Flag
    pub fn fhe16_prefix_flag(a: *const i32, b: *const i32, flag: bool) -> Ct;
    pub fn fhe16_compare(a: *const i32, b: *const i32, flag: bool) -> Ct;
    pub fn fhe16_max_or_min(a: *const i32, b: *const i32, flag: bool) -> Ct;

    // Arithmetic
    pub fn fhe16_add(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_add3(a: *const i32, b: *const i32, c: *const i32) -> Ct;
    pub fn fhe16_sub(a: *const i32, b: *const i32) -> Ct;

    // Relational
    pub fn fhe16_le(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_lt(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_ge(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_gt(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_max(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_min(a: *const i32, b: *const i32) -> Ct;

    // Logic / bitwise
    pub fn fhe16_andvec(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_orvec (a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_xorvec(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_select(sel: *const i32, a: *const i32, b: *const i32) -> Ct;

    // Mult / Div / Relu
    pub fn fhe16_smull(a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_sdiv(a: *const i32, b: *const i32, ct_rem: *const i32, is_zero: *const i32) -> Ct;
    pub fn fhe16_relu(a: *const i32) -> Ct;

    // CONSTANT (overload 분리)
    pub fn fhe16_smull_constant_cvec(ct: *const i32, constant_vec: *const c_int) -> Ct;
    pub fn fhe16_smull_constant_i64(ct: *const i32, k: i64) -> Ct;
    pub fn fhe16_smull_constant_i32(ct: *const i32, k: c_int) -> Ct;

    pub fn fhe16_add_constant_cvec(ct: *const i32, constant_vec: *const c_int) -> Ct;
    pub fn fhe16_add_constant_i64(ct: *const i32, k: i64) -> Ct;
    pub fn fhe16_add_constant_i32(ct: *const i32, k: c_int) -> Ct;

    // Shifts / Rotations
    pub fn fhe16_lshiftl(ct: *const i32, k: c_int) -> Ct;
    pub fn fhe16_lshiftr(ct: *const i32, k: c_int) -> Ct;
    pub fn fhe16_ashiftr(ct: *const i32, k: c_int) -> Ct;
    pub fn fhe16_rotatel(ct: *const i32, k: c_int) -> Ct;
    pub fn fhe16_rotater(ct: *const i32, k: c_int) -> Ct;

    // Pow2 / Neg / Abs / Eq
    pub fn fhe16_add_powtwo(ct: *const i32, pow: c_int) -> Ct;
    pub fn fhe16_sub_powtwo(ct: *const i32, pow: c_int) -> Ct;
    pub fn fhe16_neg(ct: *const i32) -> Ct;
    pub fn fhe16_abs(ct: *const i32) -> Ct;

    pub fn fhe16_eq (a: *const i32, b: *const i32) -> Ct;
    pub fn fhe16_neq(a: *const i32, b: *const i32) -> Ct;

    // Plain
    pub fn fhe16_lzc_plain(x: c_int) -> c_int;

    // 해제 API가 있으면 아래에 extern "C" 선언 추가 (그리고 Drop 구현)
    // fn fhe16_free_ct(ct: *mut i32);
    // fn fhe16_free_sk(sk: *mut i32);
}

pub struct SecretKey(pub Sk);
pub struct Ciphertext(pub Ct);

impl SecretKey {
    pub fn gen() -> Self {
        let sk = unsafe { fhe16_gen_eval() };
        assert!(!sk.is_null(), "fhe16_gen_eval returned null");
        SecretKey(sk)
    }
}

/*
impl Ciphertext {
    pub fn encrypt_i32(m: i32, msg_bit: i32) -> Self {
        let ct = unsafe { fhe16_enc_int(m as c_int, msg_bit as c_int) };
        assert!(!ct.is_null(), "fhe16_enc_int returned null");
        Ciphertext(ct)
    }
    pub fn decrypt_i64(&self, sk: &SecretKey) -> i64 {
        unsafe { fhe16_dec_int(self.0 as *const i32, sk.0 as *const i32) }
    }

    pub fn add(a: &Ciphertext, b: &Ciphertext) -> Self {
        let ct = unsafe { fhe16_add(a.0 as *const i32, b.0 as *const i32) };
        assert!(!ct.is_null());
        Ciphertext(ct)
    }
    pub fn sub(a: &Ciphertext, b: &Ciphertext) -> Self {
        let ct = unsafe { fhe16_sub(a.0 as *const i32, b.0 as *const i32) };
        assert!(!ct.is_null());
        Ciphertext(ct)
    }
    pub fn add3(a: &Ciphertext, b: &Ciphertext, c: &Ciphertext) -> Self {
        let ct = unsafe { fhe16_add3(a.0 as *const i32, b.0 as *const i32, c.0 as *const i32) };
        assert!(!ct.is_null());
        Ciphertext(ct)
    }

    pub fn lt(a: &Ciphertext, b: &Ciphertext) -> Self { Ciphertext(unsafe { fhe16_lt(a.0, b.0) }) }
    pub fn le(a: &Ciphertext, b: &Ciphertext) -> Self { Ciphertext(unsafe { fhe16_le(a.0, b.0) }) }
    pub fn gt(a: &Ciphertext, b: &Ciphertext) -> Self { Ciphertext(unsafe { fhe16_gt(a.0, b.0) }) }
    pub fn ge(a: &Ciphertext, b: &Ciphertext) -> Self { Ciphertext(unsafe { fhe16_ge(a.0, b.0) }) }
    pub fn eq(a: &Ciphertext, b: &Ciphertext) -> Self { Ciphertext(unsafe { fhe16_eq(a.0, b.0) }) }

    pub fn max(a: &Ciphertext, b: &Ciphertext) -> Self { Ciphertext(unsafe { fhe16_max(a.0, b.0) }) }
    pub fn min(a: &Ciphertext, b: &Ciphertext) -> Self { Ciphertext(unsafe { fhe16_min(a.0, b.0) }) }

    pub fn smull_constant(a: &Ciphertext, k: i32) -> Self { Ciphertext(unsafe { fhe16_smull_constant(a.0, k) }) }
    pub fn add_constant  (a: &Ciphertext, k: i32) -> Self { Ciphertext(unsafe { fhe16_add_constant(a.0, k) }) }
    pub fn add_powtwo    (a: &Ciphertext, pow: i32) -> Self { Ciphertext(unsafe { fhe16_add_powtwo(a.0, pow) }) }
}
*/

pub struct LiqResult {
    pub cipher: Ciphertext,
    pub plain: i32,
}

impl LiqResult {
    pub fn new(cipher: Ciphertext) -> Self {
        LiqResult {
            cipher: cipher,
            plain: 1, // 초기값
        }
    }
}

impl Ciphertext {
    pub fn encrypt_i32(m: i32, msg_bit: i32) -> Self {
        let ct = unsafe { fhe16_enc_int(m as c_int, msg_bit as c_int) };
        assert!(!ct.is_null(), "fhe16_enc_int returned null");
        Ciphertext(ct)
    }

    pub fn decrypt_i64(&self, sk: &SecretKey) -> i64 {
        unsafe { fhe16_dec_int(self.0 as *const i32, sk.0 as *const i32) }
    }

    // ---------- 기본 산술 ----------
    pub fn add(a: &Ciphertext, b: &Ciphertext) -> Self {
        let ct = unsafe { fhe16_add(a.0 as *const i32, b.0 as *const i32) };
        assert!(!ct.is_null());
        Ciphertext(ct)
    }

    pub fn sub(a: &Ciphertext, b: &Ciphertext) -> Self {
        let ct = unsafe { fhe16_sub(a.0 as *const i32, b.0 as *const i32) };
        assert!(!ct.is_null());
        Ciphertext(ct)
    }

    pub fn add3(a: &Ciphertext, b: &Ciphertext, c: &Ciphertext) -> Self {
        let ct = unsafe { fhe16_add3(a.0 as *const i32, b.0 as *const i32, c.0 as *const i32) };
        assert!(!ct.is_null());
        Ciphertext(ct)
    }

    // ---------- 비교 ----------
    pub fn lt(a: &Ciphertext, b: &Ciphertext) -> Self {
        Ciphertext(unsafe { fhe16_lt(a.0, b.0) })
    }
    pub fn le(a: &Ciphertext, b: &Ciphertext) -> Self {
        Ciphertext(unsafe { fhe16_le(a.0, b.0) })
    }
    pub fn gt(a: &Ciphertext, b: &Ciphertext) -> Self {
        Ciphertext(unsafe { fhe16_gt(a.0, b.0) })
    }
    pub fn ge(a: &Ciphertext, b: &Ciphertext) -> Self {
        Ciphertext(unsafe { fhe16_ge(a.0, b.0) })
    }
    pub fn eq(a: &Ciphertext, b: &Ciphertext) -> Self {
        Ciphertext(unsafe { fhe16_eq(a.0, b.0) })
    }

    // ---------- 최대/최소 ----------
    pub fn max(a: &Ciphertext, b: &Ciphertext) -> Self {
        Ciphertext(unsafe { fhe16_max(a.0, b.0) })
    }
    pub fn min(a: &Ciphertext, b: &Ciphertext) -> Self {
        Ciphertext(unsafe { fhe16_min(a.0, b.0) })
    }

    // ---------- 상수 연산 ----------
    pub fn smull_constant(a: &Ciphertext, k: i32) -> Self {
        Ciphertext(unsafe { fhe16_smull_constant_i32(a.0, k as c_int) })
    }

    pub fn add_constant(a: &Ciphertext, k: i32) -> Self {
        Ciphertext(unsafe { fhe16_add_constant_i32(a.0, k as c_int) })
    }

    pub fn add_powtwo(a: &Ciphertext, pow: i32) -> Self {
        Ciphertext(unsafe { fhe16_add_powtwo(a.0, pow as c_int) })
    }

    pub fn borrow(asset_1: Ciphertext, asset_2: Ciphertext, loan: &Ciphertext, sk: &SecretKey) -> (Ciphertext, Ciphertext) { // asset_1 : user, asset_2 : bank
        let comp = Ciphertext::lt(loan, &asset_2);
        let flag = comp.decrypt_i64(&sk);

        if flag == 1 {
            let asset_1_result = Ciphertext::add(&asset_1, loan);
            let asset_2_result = Ciphertext::sub(&asset_2, loan);
            (asset_1_result, asset_2_result)
        } else {
            (asset_1, asset_2)
        }
    }

    pub fn decrypt_borrow(asset_1: Ciphertext, asset_2: Ciphertext, sk: &SecretKey) -> (i64, i64) {
        let asset_1_dec = asset_1.decrypt_i64(sk);
        let asset_2_dec = asset_2.decrypt_i64(sk);
        (asset_1_dec, asset_2_dec)
    }

    pub fn Withdraw(mut asset: Ciphertext, amount: &Ciphertext, sk: &SecretKey) -> Ciphertext {
        let comp = Ciphertext::lt(amount, &asset);
        let flag = comp.decrypt_i64(&sk);

        if flag == 1 {
            Ciphertext::sub(&asset, amount)
        } else {
            asset
        }
    }

    pub fn decrypt_withdraw(asset: Ciphertext, sk: &SecretKey) -> i64 {
        asset.decrypt_i64(sk)
    }

    pub fn Deposit(asset: &Ciphertext, amount: &Ciphertext) -> Ciphertext {
        Ciphertext::add(asset, amount)
    }

    pub fn decrypt_deposit(asset: Ciphertext, sk: &SecretKey) -> i64 {
        asset.decrypt_i64(sk)
    }

    pub fn Liquidation(curr_price: &Ciphertext, liq_price: &Ciphertext, collateral: &mut LiqResult, sk: &SecretKey){
        let comp = Ciphertext::lt(liq_price, curr_price);
        let flag = comp.decrypt_i64(&sk);

        if flag == 0 {
            collateral.plain = 0;
        }
    }

    pub fn decrypt_liquidation(collateral: LiqResult, sk: &SecretKey) -> i64 {
        collateral.cipher.decrypt_i64(sk)
    }
}



// ⚠️ 라이브러리에 해제 함수가 있으면 아래처럼 Drop 구현:
// impl Drop for Ciphertext { fn drop(&mut self) { unsafe { fhe16_free_ct(self.0) } } }
// impl Drop for SecretKey { fn drop(&mut self) { unsafe { fhe16_free_sk(self.0) } } }

