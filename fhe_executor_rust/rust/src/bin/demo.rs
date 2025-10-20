use fhe16_wrapper::{check_system_env, Ciphertext, SecretKey};

//std::time::Instant;
use std::time::Instant;

fn main() {
    // ✅ 환경 검사
    check_system_env();

    let sk = SecretKey::gen();
    let msg_bit = 32;

    let m1: i32 = 126;
    let m2: i32 = -723;
    let m5: i32 = -423;

    let ct1 = Ciphertext::encrypt_i32(m1, msg_bit);
    let ct0 = Ciphertext::encrypt_i32(m1, msg_bit);
    let ct2 = Ciphertext::encrypt_i32(m2, msg_bit);

    let m3 = (m1 as i64 + m2 as i64) as i64;
    let m4 = (m1 as i64 - m2 as i64) as i64;
    let m6 = (m1 as i64 + m2 as i64 + m5 as i64) as i64;

    let t_add = Instant::now();
    let ct3 = Ciphertext::add(&ct1, &ct2);
    let add_ms = t_add.elapsed().as_millis();

    let t_sub = Instant::now();
    let ct4 = Ciphertext::sub(&ct1, &ct2);
    let sub_ms = t_sub.elapsed().as_millis();

    let ct5 = Ciphertext::encrypt_i32(m5, msg_bit);

    let t_add3 = Instant::now();
    let ct6 = Ciphertext::add3(&ct1, &ct2, &ct5);
    let add3_ms = t_add3.elapsed().as_millis();

    let m1_dec = ct1.decrypt_i64(&sk);
    let m2_dec = ct2.decrypt_i64(&sk);

    let ct7 = Ciphertext::lt(&ct1, &ct2);
    let ct8 = Ciphertext::ge(&ct1, &ct2);
    let ct9 = Ciphertext::gt(&ct1, &ct2);
    let ct10 = Ciphertext::le(&ct1, &ct2);

    let m7 = (m1 < m2) as i64;
    let m7_dec = ct7.decrypt_i64(&sk);
    assert_eq!(m7, m7_dec);
    println!("LT: m7 is {m7}, recons m7 is {m7_dec}");

    let m8 = (m1 >= m2) as i64;
    let m8_dec = ct8.decrypt_i64(&sk);
    assert_eq!(m8, m8_dec);
    println!("GE: m8 is {m8}, recons m8 is {m8_dec}");

    let m9 = (m1 > m2) as i64;
    let m9_dec = ct9.decrypt_i64(&sk);
    assert_eq!(m9, m9_dec);
    println!("GT: m9 is {m9}, recons m9 is {m9_dec}");

    let m10 = (m1 <= m2) as i64;
    let m10_dec = ct10.decrypt_i64(&sk);
    assert_eq!(m10, m10_dec);
    println!("LE: m10 is {m10}, recons m10 is {m10_dec}");

    let m3_dec = ct3.decrypt_i64(&sk);
    println!("m3 is {m3}, recons m3 is {m3_dec}");

    let m4_dec = ct4.decrypt_i64(&sk);
    println!("m4 is {m4}, recons m4 is {m4_dec}");

    let m6_dec = ct6.decrypt_i64(&sk);
    println!("m6 is {m6}, recons m6 is {m6_dec}");

    let ct11 = Ciphertext::max(&ct1, &ct2);
    let m11_dec = ct11.decrypt_i64(&sk);
    println!("MAX: m11 is {}, recons m11 is {}", (m1 as i64).max(m2 as i64), m11_dec);

    let ct12 = Ciphertext::min(&ct1, &ct2);
    let m12_dec = ct12.decrypt_i64(&sk);
    println!("MIN: m12 is {}, recons m12 is {}", (m1 as i64).min(m2 as i64), m12_dec);

    let ct21 = Ciphertext::smull_constant(&ct12, -312);
    let m21_dec = ct21.decrypt_i64(&sk);
    println!("-312 * val is {}, recons m21 is {}", (m1 as i64).min(m2 as i64) * (-312i64), m21_dec);

    let ct22 = Ciphertext::add_constant(&ct21, -312);
    let m22_dec = ct22.decrypt_i64(&sk);
    println!("CT + (-312) is {}, recons m22 is {}", (m1 as i64).min(m2 as i64) * (-312i64) + (-312i64), m22_dec);

    let ct13 = Ciphertext::eq(&ct1, &ct0);
    let m13_dec = ct13.decrypt_i64(&sk);
    println!("EQ: m13 is 1, recons m13 is {}", m13_dec);

    let ct14 = Ciphertext::add_powtwo(&ct1, 1);
    let m14_dec = ct14.decrypt_i64(&sk);
    println!("ADD1 m14 is {}, recons m14 is {}", (m1 as i64) + 1, m14_dec);

    println!("ADD  running on {}(ms)", add_ms);
    println!("SUB  running on {}(ms)", sub_ms);
    println!("ADD3 running on {}(ms)", add3_ms);

    println!("m1 is {m1}, recons m1 is {m1_dec}");
    println!("m2 is {m2}, recons m2 is {m2_dec}");
}

