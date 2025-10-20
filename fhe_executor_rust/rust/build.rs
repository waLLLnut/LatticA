use std::{
    env,
    path::{Path, PathBuf},
};

fn is_dir(p: &Path) -> bool { p.is_dir() }

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    // ====== [1] 헤더 루트 후보 탐색 ======
    // 우선순위: FHE16_INCLUDE_ROOT -> ../include_FHE16 -> ../include -> ./include_FHE16 -> ./include
    let mut include_candidates = Vec::new();
    if let Ok(s) = env::var("FHE16_INCLUDE_ROOT") { include_candidates.push(PathBuf::from(s)); }
    include_candidates.push(manifest_dir.join("../include_FHE16"));
    include_candidates.push(manifest_dir.join("../include"));
    include_candidates.push(manifest_dir.join("include_FHE16"));
    include_candidates.push(manifest_dir.join("include"));
    // 추가 힌트를 콜론(:)으로 넘길 수 있게
    if let Ok(hints) = env::var("FHE16_INCLUDE_HINTS") {
        include_candidates.extend(hints.split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
    }

    let include_root = include_candidates.into_iter().find(|p| is_dir(p)).unwrap_or_else(|| {
        panic!(
            "FHE16 include root not found.\n\
             - Set FHE16_INCLUDE_ROOT to the directory that contains `FHE16/` and `FHE16_Module/`.\n\
             - Or create ../include or ../include_FHE16 with those folders."
        )
    });
    println!("cargo:warning=Using FHE16 include root: {}", include_root.display());


	let include_dirs = [
    include_root.clone(),                                  // 루트 자체
    include_root.join("FHE16/include"),
    include_root.join("FHE16/include/soAPI"),
    include_root.join("FHE16/include/math"),
    include_root.join("FHE16/include/lwe"),
    include_root.join("FHE16/include/thread"),

    // ⬇️ ⬇️ 여기 추가
    include_root.join("FHE16_Module/include"),             // 루트
    include_root.join("FHE16_Module/include/ntt"),
    include_root.join("FHE16_Module/include/bootstrapping"),
];

	/*
    // 실제 인클루드 경로들(존재하는 것만 추가)
    let include_dirs = [
        include_root.clone(),                                  // 루트 자체
        include_root.join("FHE16/include"),
        include_root.join("FHE16/include/soAPI"),
        include_root.join("FHE16/include/math"),
        include_root.join("FHE16/include/lwe"),
        include_root.join("FHE16/include/thread"),
        include_root.join("FHE16_Module/include/ntt"),
        include_root.join("FHE16_Module/include/bootstrapping"),
        include_root.join("include"),                          // 어떤 배포물은 루트가 FHE16/인 경우가 있음
    ];
	*/
    // ====== [2] C++ 브리지 컴파일 ======
    let mut build = cc::Build::new();
    build.cpp(true)
        .flag_if_supported("-std=gnu++17")
        .file("cxx/fhe16_capi.cc");

    for inc in &include_dirs {
        if is_dir(inc) {
            println!("cargo:warning=  -I {}", inc.display());
            build.include(inc);
        }
    }

    println!("cargo:rerun-if-changed=cxx/fhe16_capi.cc");
    println!("cargo:rerun-if-env-changed=FHE16_INCLUDE_ROOT");
    println!("cargo:rerun-if-env-changed=FHE16_INCLUDE_HINTS");
    println!("cargo:rerun-if-env-changed=FHE16_LIB_DIR");

    build.compile("fhe16_cwrapper");

    // ====== [3] .so 위치 ======
    let mut lib_candidates = Vec::new();
    if let Ok(s) = env::var("FHE16_LIB_DIR") { lib_candidates.push(PathBuf::from(s)); }
    lib_candidates.push(manifest_dir.join("../lib"));
    lib_candidates.push(manifest_dir.join("lib"));

    let lib_dir = lib_candidates.into_iter().find(|p| is_dir(p)).unwrap_or_else(|| {
        panic!(
            "FHE16 lib directory not found.\n\
             - Set FHE16_LIB_DIR to the folder that contains libFHE16.so and libFHE16_Module.so.\n\
             - Or place them under ../lib or ./lib."
        )
    });

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:warning=Linking against libs in {}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=FHE16");
    println!("cargo:rustc-link-lib=dylib=FHE16_Module");
    println!("cargo:rustc-link-lib=dylib=numa");

    // C++ 런타임
    let target = env::var("TARGET").unwrap_or_default();
    if target.contains("-apple-") {
        println!("cargo:rustc-link-lib=dylib=c++");
    } else {
        println!("cargo:rustc-link-lib=dylib=stdc++");
    }

    // ====== [4] RPATH 설정 (기본 레이아웃에서 LD_LIBRARY_PATH 없이 실행) ======
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../../../lib");
    if let Ok(extra_rpath) = env::var("FHE16_RPATH_DIR") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", extra_rpath);
    }
}

