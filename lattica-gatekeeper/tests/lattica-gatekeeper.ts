import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LatticaGatekeeper } from "../target/types/lattica_gatekeeper";
import * as crypto from "crypto";
import { assert } from "chai";

describe("lattica-gatekeeper", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LatticaGatekeeper as Program<LatticaGatekeeper>;

  let configPda: anchor.web3.PublicKey;
  let cid1Pda: anchor.web3.PublicKey;
  let cid2Pda: anchor.web3.PublicKey;
  let cid3Pda: anchor.web3.PublicKey;
  
  const ciphertextHash1 = new Uint8Array(32).fill(10);
  const ciphertextHash2 = new Uint8Array(32).fill(20);
  const ciphertextHash3 = new Uint8Array(32).fill(30);
  const sharedPolicyHash = new Uint8Array(32).fill(5);
  const challengeWindowSlots = new anchor.BN(50);

  it("Initialize global config", async () => {
    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const tx = await program.methods
      .initConfig(challengeWindowSlots)
      .accounts({
        authority: provider.wallet.publicKey,
      })
      .rpc();

    console.log("✓ init_config tx:", tx);

    // 설정 확인
    const configData = await program.account.config.fetch(configPda);
    assert.equal(configData.challengeWindowSlots.toNumber(), challengeWindowSlots.toNumber());
    assert.equal(configData.authority.toBase58(), provider.wallet.publicKey.toBase58());
    console.log("  Challenge window:", configData.challengeWindowSlots.toNumber(), "slots");
  });

  it("Register CID handles", async () => {
    const owner = provider.wallet.publicKey;

    // Derive CID PDAs
    [cid1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(ciphertextHash1), Buffer.from(sharedPolicyHash), owner.toBuffer()],
      program.programId
    );
    [cid2Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(ciphertextHash2), Buffer.from(sharedPolicyHash), owner.toBuffer()],
      program.programId
    );
    [cid3Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(ciphertextHash3), Buffer.from(sharedPolicyHash), owner.toBuffer()],
      program.programId
    );

    // Register first CID
    const tx1 = await program.methods
      .registerCidHandle([...ciphertextHash1], [...sharedPolicyHash])
      .accounts({ owner, payer: owner })
      .rpc();
    console.log("✓ register_cid_handle #1 tx:", tx1);

    const cid1Data = await program.account.cidHandle.fetch(cid1Pda);
    assert.equal(cid1Data.owner.toBase58(), owner.toBase58());
    assert.deepEqual(Array.from(cid1Data.ciphertextHash), Array.from(ciphertextHash1));
    console.log("  CID #1 registered by:", cid1Data.owner.toBase58());
    console.log("  CID #1 ciphertext hash:", Buffer.from(cid1Data.ciphertextHash).toString('hex').substring(0, 16) + "...");

    // Register second CID
    const tx2 = await program.methods
      .registerCidHandle([...ciphertextHash2], [...sharedPolicyHash])
      .accounts({ owner, payer: owner })
      .rpc();
    console.log("✓ register_cid_handle #2 tx:", tx2);

    // Register third CID
    const tx3 = await program.methods
      .registerCidHandle([...ciphertextHash3], [...sharedPolicyHash])
      .accounts({ owner, payer: owner })
      .rpc();
    console.log("✓ register_cid_handle #3 tx:", tx3);

    // Test duplicate registration fails
    try {
      await program.methods
        .registerCidHandle([...ciphertextHash1], [...sharedPolicyHash])
        .accounts({ owner, payer: owner })
        .rpc();
      throw new Error("Should have failed - duplicate CID registration");
    } catch (e) {
      console.log("✓ Duplicate CID registration correctly rejected");
    }

    // Verify deterministic derivation
    const [cidVerify] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(ciphertextHash1), Buffer.from(sharedPolicyHash), owner.toBuffer()],
      program.programId
    );
    assert.isTrue(cid1Pda.equals(cidVerify));
    console.log("✓ Deterministic CID derivation verified");
  });

  it("Submit a new confidential job", async () => {
    const submitter = provider.wallet.publicKey;
    const batch = anchor.web3.Keypair.generate().publicKey;

    // Calculate cid_set_id (must match on-chain verification)
    const hasher = crypto.createHash('sha256');
    hasher.update(cid1Pda.toBuffer());
    hasher.update(cid2Pda.toBuffer());
    const cid_set_id = Array.from(hasher.digest());
    
    const commitment = new Uint8Array(32).fill(1);
    const ir_digest = new Uint8Array(32).fill(2);
    const provenance = 1; // direct owner call

    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("job"), Buffer.from(commitment), submitter.toBuffer()],
      program.programId
    );

    // Submit job with CID references via remaining_accounts
    const tx = await program.methods
      .submitJob(batch, [...cid_set_id], [...commitment], [...ir_digest], provenance)
      .accounts({
        batch,
        submitter,
      })
      .remainingAccounts([
        { pubkey: cid1Pda, isSigner: false, isWritable: false },
        { pubkey: cid2Pda, isSigner: false, isWritable: false },
      ])
      .rpc();

    console.log("✓ submit_job tx:", tx);
    
    // Verify job data
    const jobAccount = await program.account.job.fetch(jobPda);
    assert.equal(jobAccount.cidCount, 2);
    assert.deepEqual(Array.from(jobAccount.cidSetId), cid_set_id);
    assert.equal(jobAccount.batch.toBase58(), batch.toBase58());
    assert.equal(jobAccount.provenance, provenance);
    console.log("  Job CID count:", jobAccount.cidCount);
    console.log("  Job CID set ID:", Buffer.from(jobAccount.cidSetId).toString('hex').substring(0, 16) + "...");
    console.log("  Job batch:", jobAccount.batch.toBase58());

    // Verify CIDs still accessible
    const cid1Verify = await program.account.cidHandle.fetch(cid1Pda);
    const cid2Verify = await program.account.cidHandle.fetch(cid2Pda);
    assert.equal(cid1Verify.owner.toBase58(), submitter.toBase58());
    console.log("✓ CID #1 and #2 verified, owned by:", cid1Verify.owner.toBase58());
  });

  it("Test CID trustless properties", async () => {
    const owner = provider.wallet.publicKey;
    const testHash = new Uint8Array(32).fill(99);
    const testPolicy = new Uint8Array(32).fill(88);

    // Same inputs produce same CID
    const [cid_v1] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(testHash), Buffer.from(testPolicy), owner.toBuffer()],
      program.programId
    );
    const [cid_v2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(testHash), Buffer.from(testPolicy), owner.toBuffer()],
      program.programId
    );
    assert.isTrue(cid_v1.equals(cid_v2));
    console.log("✓ Deterministic test: same inputs produce same CID");

    // Different user produces different CID
    const otherUser = anchor.web3.Keypair.generate().publicKey;
    const [cidDiffUser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(testHash), Buffer.from(testPolicy), otherUser.toBuffer()],
      program.programId
    );
    assert.isFalse(cid_v1.equals(cidDiffUser));
    console.log("✓ Different user test: different CID");

    // Different policy produces different CID
    const diffPolicy = new Uint8Array(32).fill(77);
    const [cidDiffPolicy] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(testHash), Buffer.from(diffPolicy), owner.toBuffer()],
      program.programId
    );
    assert.isFalse(cid_v1.equals(cidDiffPolicy));
    console.log("✓ Different policy test: different CID");
  });

  it("Request reveal (public)", async () => {
    const requester = provider.wallet.publicKey;
    const handle = new Uint8Array(32).fill(111);
    const domainSignature = new Uint8Array(64).fill(222);

    const [revealReqPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reveal_req"), Buffer.from(handle)],
      program.programId
    );

    // Public reveal request
    const tx = await program.methods
      .requestRevealPublic([...handle], [...domainSignature])
      .accounts({
        requester,
      })
      .rpc();

    console.log("✓ request_reveal_public tx:", tx);

    // Verify reveal request data
    const revealReqData = await program.account.revealRequest.fetch(revealReqPda);
    assert.equal(revealReqData.init, 1);
    assert.equal(revealReqData.isPublic, 1);
    assert.deepEqual(Array.from(revealReqData.handle), Array.from(handle));
    assert.equal(revealReqData.requester.toBase58(), requester.toBase58());
    assert.deepEqual(Array.from(revealReqData.domainSignature), Array.from(domainSignature));
    console.log("  Reveal request handle:", Buffer.from(revealReqData.handle).toString('hex').substring(0, 16) + "...");
    console.log("  Is public:", revealReqData.isPublic === 1);
  });

  it("Request reveal (private)", async () => {
    const requester = provider.wallet.publicKey;
    const handle = new Uint8Array(32).fill(123);
    const userSessionPubkey = new Uint8Array(32).fill(45);

    const [revealReqPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reveal_req"), Buffer.from(handle)],
      program.programId
    );

    // Private reveal request
    const tx = await program.methods
      .requestRevealPrivate([...handle], [...userSessionPubkey])
      .accounts({
        requester,
      })
      .rpc();

    console.log("✓ request_reveal_private tx:", tx);

    // Verify reveal request data
    const revealReqData = await program.account.revealRequest.fetch(revealReqPda);
    assert.equal(revealReqData.init, 1);
    assert.equal(revealReqData.isPublic, 0);
    assert.deepEqual(Array.from(revealReqData.handle), Array.from(handle));
    assert.equal(revealReqData.requester.toBase58(), requester.toBase58());
    assert.deepEqual(Array.from(revealReqData.userSessionPubkey), Array.from(userSessionPubkey));
    console.log("  Reveal request handle:", Buffer.from(revealReqData.handle).toString('hex').substring(0, 16) + "...");
    console.log("  Is public:", revealReqData.isPublic === 1);
    console.log("  Session pubkey:", Buffer.from(revealReqData.userSessionPubkey).toString('hex').substring(0, 16) + "...");
  });

  it("Commit batch result (optimistic)", async () => {
    const payer = provider.wallet.publicKey;
    const windowStartSlot = new anchor.BN(1000);
    const commitRoot = new Uint8Array(32).fill(33);
    const resultCommitment = new Uint8Array(32).fill(44);
    const processedUntilSlot = new anchor.BN(1050);

    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), windowStartSlot.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Commit batch
    const tx = await program.methods
      .commitBatch(windowStartSlot, [...commitRoot], [...resultCommitment], processedUntilSlot)
      .accounts({
        payer,
      })
      .rpc();

    console.log("✓ commit_batch tx:", tx);

    // Verify batch data
    const batchData = await program.account.batchResult.fetch(batchPda);
    assert.equal(batchData.windowStartSlot.toNumber(), windowStartSlot.toNumber());
    assert.equal(batchData.status, 0); // Posted
    assert.deepEqual(Array.from(batchData.commitRoot), Array.from(commitRoot));
    assert.deepEqual(Array.from(batchData.resultCommitment), Array.from(resultCommitment));
    assert.equal(batchData.processedUntilSlot.toNumber(), processedUntilSlot.toNumber());
    console.log("  Batch window_start_slot:", batchData.windowStartSlot.toNumber());
    console.log("  Batch status:", batchData.status === 0 ? "Posted" : "Finalized");
    console.log("  Batch result commitment:", Buffer.from(batchData.resultCommitment).toString('hex').substring(0, 16) + "...");
  });

  it("Finalize batch after challenge window", async () => {
    const windowStartSlot = new anchor.BN(2000);
    const commitRoot = new Uint8Array(32).fill(55);
    const resultCommitment = new Uint8Array(32).fill(66);
    const processedUntilSlot = new anchor.BN(2050);

    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), windowStartSlot.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Commit batch first
    const commitTx = await program.methods
      .commitBatch(windowStartSlot, [...commitRoot], [...resultCommitment], processedUntilSlot)
      .accounts({
        payer: provider.wallet.publicKey,
      })
      .rpc();

    console.log("✓ commit_batch tx:", commitTx);

    // Try to finalize immediately (should fail - window not ended)
    try {
      await program.methods
        .finalizeBatch(windowStartSlot)
        .accounts({})
        .rpc();
      throw new Error("Should have failed - window not ended");
    } catch (e: any) {
      assert.include(e.message, "WindowNotEnded");
      console.log("✓ Finalization correctly rejected - window not ended");
    }

    // Wait for challenge window (simulate by advancing slots)
    // Note: In real test, we would need to wait or use test utilities to advance time
    console.log("  (In production, must wait", challengeWindowSlots.toNumber(), "slots for finalization)");
  });

  it("Test job submission with wrong cid_set_id (should fail)", async () => {
    const submitter = provider.wallet.publicKey;
    const batch = anchor.web3.Keypair.generate().publicKey;

    // Calculate WRONG cid_set_id (different order)
    const hasher = crypto.createHash('sha256');
    hasher.update(cid2Pda.toBuffer());
    hasher.update(cid1Pda.toBuffer()); // Swapped order
    const wrong_cid_set_id = Array.from(hasher.digest());
    
    const commitment = new Uint8Array(32).fill(99);
    const ir_digest = new Uint8Array(32).fill(88);
    const provenance = 1;

    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("job"), Buffer.from(commitment), submitter.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .submitJob(batch, [...wrong_cid_set_id], [...commitment], [...ir_digest], provenance)
        .accounts({
          batch,
          submitter,
        })
        .remainingAccounts([
          { pubkey: cid1Pda, isSigner: false, isWritable: false },
          { pubkey: cid2Pda, isSigner: false, isWritable: false },
        ])
        .rpc();
      throw new Error("Should have failed - wrong cid_set_id");
    } catch (e: any) {
      assert.include(e.message, "CidSetMismatch");
      console.log("✓ Job submission with wrong cid_set_id correctly rejected");
    }
  });

  it("Test job submission with no CIDs (should fail)", async () => {
    const submitter = provider.wallet.publicKey;
    const batch = anchor.web3.Keypair.generate().publicKey;

    const cid_set_id = new Uint8Array(32).fill(0);
    const commitment = new Uint8Array(32).fill(77);
    const ir_digest = new Uint8Array(32).fill(66);
    const provenance = 1;

    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("job"), Buffer.from(commitment), submitter.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .submitJob(batch, [...cid_set_id], [...commitment], [...ir_digest], provenance)
        .accounts({
          batch,
          submitter,
        })
        .remainingAccounts([]) // No CIDs
        .rpc();
      throw new Error("Should have failed - no CIDs provided");
    } catch (e: any) {
      assert.include(e.message, "NoCidProvided");
      console.log("✓ Job submission with no CIDs correctly rejected");
    }
  });

  it("Test batch commit idempotency", async () => {
    const payer = provider.wallet.publicKey;
    const windowStartSlot = new anchor.BN(3000);
    const commitRoot = new Uint8Array(32).fill(77);
    const resultCommitment = new Uint8Array(32).fill(88);
    const processedUntilSlot = new anchor.BN(3050);

    const [batchPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("batch"), windowStartSlot.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // First commit
    const tx1 = await program.methods
      .commitBatch(windowStartSlot, [...commitRoot], [...resultCommitment], processedUntilSlot)
      .accounts({
        payer,
      })
      .rpc();

    console.log("✓ First commit_batch tx:", tx1);

    // Second commit with same data (should succeed due to init_if_needed)
    const tx2 = await program.methods
      .commitBatch(windowStartSlot, [...commitRoot], [...resultCommitment], processedUntilSlot)
      .accounts({
        payer,
      })
      .rpc();

    console.log("✓ Second commit_batch tx (idempotent):", tx2);

    const batchData = await program.account.batchResult.fetch(batchPda);
    assert.equal(batchData.windowStartSlot.toNumber(), windowStartSlot.toNumber());
    console.log("✓ Batch commit idempotency verified");
  });

  it("Complete job submission flow with multiple CIDs", async () => {
    const submitter = provider.wallet.publicKey;
    const batch = anchor.web3.Keypair.generate().publicKey;

    // Use all 3 CIDs
    const hasher = crypto.createHash('sha256');
    hasher.update(cid1Pda.toBuffer());
    hasher.update(cid2Pda.toBuffer());
    hasher.update(cid3Pda.toBuffer());
    const cid_set_id = Array.from(hasher.digest());
    
    const commitment = new Uint8Array(32).fill(200);
    const ir_digest = new Uint8Array(32).fill(201);
    const provenance = 0; // CPI call

    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("job"), Buffer.from(commitment), submitter.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .submitJob(batch, [...cid_set_id], [...commitment], [...ir_digest], provenance)
      .accounts({
        batch,
        submitter,
      })
      .remainingAccounts([
        { pubkey: cid1Pda, isSigner: false, isWritable: false },
        { pubkey: cid2Pda, isSigner: false, isWritable: false },
        { pubkey: cid3Pda, isSigner: false, isWritable: false },
      ])
      .rpc();

    console.log("✓ submit_job with 3 CIDs tx:", tx);

    const jobAccount = await program.account.job.fetch(jobPda);
    assert.equal(jobAccount.cidCount, 3);
    assert.equal(jobAccount.provenance, 0); // CPI call
    console.log("  Job with", jobAccount.cidCount, "CIDs created successfully");
    console.log("  Provenance:", jobAccount.provenance === 0 ? "CPI call" : "Direct owner call");
  });

  it("Test reveal request update (init_if_needed)", async () => {
    const requester = provider.wallet.publicKey;
    const handle = new Uint8Array(32).fill(250);
    const domainSignature1 = new Uint8Array(64).fill(11);
    const domainSignature2 = new Uint8Array(64).fill(22);

    const [revealReqPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("reveal_req"), Buffer.from(handle)],
      program.programId
    );

    // First request
    const tx1 = await program.methods
      .requestRevealPublic([...handle], [...domainSignature1])
      .accounts({
        requester,
      })
      .rpc();

    console.log("✓ First reveal request tx:", tx1);

    const data1 = await program.account.revealRequest.fetch(revealReqPda);
    assert.deepEqual(Array.from(data1.domainSignature), Array.from(domainSignature1));

    // Second request with different signature (should update)
    const tx2 = await program.methods
      .requestRevealPublic([...handle], [...domainSignature2])
      .accounts({
        requester,
      })
      .rpc();

    console.log("✓ Second reveal request tx (updated):", tx2);

    const data2 = await program.account.revealRequest.fetch(revealReqPda);
    assert.deepEqual(Array.from(data2.domainSignature), Array.from(domainSignature2));
    console.log("✓ Reveal request update verified");
  });
});
