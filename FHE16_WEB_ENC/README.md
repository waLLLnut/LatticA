# LWE Encryption Prototype (`pk.bin` in Browser)

This repository provides a **prototype** for performing **LWE encryption** using a pre-generated `pk.bin` file within a browser environment.  
**This is purely for demonstration and experimentation purposes — not for production or security use.**

---

## Important Notes & Disclaimers

1. **Prototype — Not optimized**  
   This code is a *proof-of-concept*. It is **not optimized** for speed, transmission size (packing), or cryptographic/security efficiency. Use only for testing.

2. **Non-Gaussian error sampling**  
   The error values injected into LWE are **not sampled from a discrete Gaussian distribution**. The sampling method is a simple placeholder and not cryptographically secure.

3. **Large, insecure `pk.bin` (demo-only)**  
   The provided `pk.bin` file is **very large** and **not optimized**. Although it functions as a global public key, in this demo **LatticA knows the corresponding secret key**.  
   *Future plan:* Migrate to a **threshold FHE** setup where the global secret key is distributed among multiple parties.

4. **No liability**  
   If you reproduce, modify, or use this source code and encounter any problems (including but not limited to crashes, data loss, or vulnerabilities), the author bears **no responsibility**.

5. **Author / Contact**  
   Seunghwan Lee  
   shlee@walllnut.com

---

## Build & Run (Linux)

Prerequisites:
- Emscripten installed and on your `PATH` (so `emcmake` is available).
- Node.js and npm (for running the test server with `npx`).

```bash
# Build
mkdir build
emcmake cmake -S .. -B build-wasm
cmake --build build-wasm --config Release

# Run the demo page
cd test_page
npx http-server -p 8080 --cors

# Open the demo in your browser:
# http://localhost:8080/index.html
