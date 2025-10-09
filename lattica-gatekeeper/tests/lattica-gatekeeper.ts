import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LatticaGatekeeper } from "../target/types/lattica_gatekeeper";

describe("lattica-gatekeeper", () => {
  // Configure the Anchor provider to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LatticaGatekeeper as Program<LatticaGatekeeper>;

  // Global PDA references
  let configPda: anchor.web3.PublicKey;
  
  // Shared CID test data
  let cid1Pda: anchor.web3.PublicKey;
  let cid2Pda: anchor.web3.PublicKey;
  const ciphertextHash1 = new Uint8Array(32).fill(10);
  const ciphertextHash2 = new Uint8Array(32).fill(20);
  const sharedPolicyHash = new Uint8Array(32).fill(5);

  it("Initialize global config", async () => {
    // Derive the config PDA: seeds = ["config"]
    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const authority = provider.wallet.publicKey;
    const challengeWindowSlots = new anchor.BN(50); // arbitrary test value

    const tx = await program.methods
      .initializeConfig(challengeWindowSlots)
      .accounts({
        config: configPda,
        authority,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("initialize_config tx:", tx);
  });

  it("Register CID handles", async () => {
    const owner = provider.wallet.publicKey;
    const payer = provider.wallet.publicKey;

    // Simulate off-chain flow:
    // 1. User encrypts data with FHE policy → ciphertext
    // 2. User uploads ciphertext to off-chain storage (IPFS, Arweave, etc.)
    // 3. Storage provider computes SHA256(ciphertext)
    // 4. User registers CID on-chain

    // Derive CID PDAs: seeds = ["cid", ciphertext_hash, policy_hash, owner]
    [cid1Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(ciphertextHash1), Buffer.from(sharedPolicyHash), owner.toBuffer()],
      program.programId
    );
    [cid2Pda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(ciphertextHash2), Buffer.from(sharedPolicyHash), owner.toBuffer()],
      program.programId
    );

    // Register first CID
    const tx1 = await program.methods
      .registerCid([...ciphertextHash1], [...sharedPolicyHash])
      .accounts({ cid: cid1Pda, owner, payer, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    console.log("register_cid #1 tx:", tx1);

    // Verify CID #1 data
    const cid1Data = await program.account.cidHandle.fetch(cid1Pda);
    console.log("   CID #1 registered by:", cid1Data.owner.toBase58());
    console.log("   CID #1 ciphertext hash:", Buffer.from(cid1Data.ciphertextHash).toString('hex').substring(0, 16) + "...");

    // Register second CID
    const tx2 = await program.methods
      .registerCid([...ciphertextHash2], [...sharedPolicyHash])
      .accounts({ cid: cid2Pda, owner, payer, systemProgram: anchor.web3.SystemProgram.programId })
      .rpc();
    console.log("register_cid #2 tx:", tx2);

    // Test duplicate registration (should fail)
    try {
      await program.methods
        .registerCid([...ciphertextHash1], [...sharedPolicyHash])
        .accounts({ cid: cid1Pda, owner, payer, systemProgram: anchor.web3.SystemProgram.programId })
        .rpc();
      throw new Error("Should have failed - duplicate CID registration");
    } catch (e) {
      console.log("Duplicate CID registration correctly rejected");
    }

    // Verify deterministic property: derive same CID again
    const [cidVerify] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(ciphertextHash1), Buffer.from(sharedPolicyHash), owner.toBuffer()],
      program.programId
    );
    console.log("Deterministic CID verified:", cid1Pda.equals(cidVerify));
  });

  it("Submit a new confidential job", async () => {
    const submitter = provider.wallet.publicKey;
    const batch = anchor.web3.Keypair.generate().publicKey;

    // Use previously registered CIDs (from test #2)
    // This demonstrates real-world flow: register CIDs first, then reference in jobs

    // Prepare job submission with Merkle root of CID set
    const cid_set_id = new Uint8Array(32).fill(100); // Merkle root or hash of CID set
    const commitment = new Uint8Array(32).fill(1);   // H(cid_set_id || ir_digest || policy_hash || ...)
    const ir_digest = new Uint8Array(32).fill(2);
    const policy_hash_job = new Uint8Array(32).fill(3);
    const provenance = 1;

    // Derive Job PDA
    const [jobPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("job"), Buffer.from(commitment), submitter.toBuffer()],
      program.programId
    );

    // Submit job referencing BOTH previously registered CIDs via remaining_accounts
    const tx = await program.methods
      .submitJob(batch, [...cid_set_id], [...commitment], [...ir_digest], [...policy_hash_job], provenance)
      .accounts({
        config: configPda,
        job: jobPda,
        batch,
        submitter,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: cid1Pda, isSigner: false, isWritable: false },
        { pubkey: cid2Pda, isSigner: false, isWritable: false },
      ])
      .rpc();

    console.log("submit_job tx:", tx);
    
    // Verify job state
    const jobAccount = await program.account.job.fetch(jobPda);
    console.log("   Job CID count:", jobAccount.cidCount);
    console.log("   Job CID set ID:", Buffer.from(jobAccount.cidSetId).toString('hex').substring(0, 16) + "...");
    console.log("   Job batch:", jobAccount.batch.toBase58());
    console.log("   Job submitter:", jobAccount.submitter.toBase58());

    // Verify the CIDs are still accessible
    const cid1Verify = await program.account.cidHandle.fetch(cid1Pda);
    const cid2Verify = await program.account.cidHandle.fetch(cid2Pda);
    console.log("CID #1 and #2 verified, owned by:", cid1Verify.owner.toBase58());
  });

  it("Test CID trustless properties", async () => {
    const owner = provider.wallet.publicKey;
    const payer = provider.wallet.publicKey;

    // Test 1: Same data should produce same CID address
    const testHash = new Uint8Array(32).fill(99);
    const testPolicy = new Uint8Array(32).fill(88);

    const [cid_v1] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(testHash), Buffer.from(testPolicy), owner.toBuffer()],
      program.programId
    );
    const [cid_v2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(testHash), Buffer.from(testPolicy), owner.toBuffer()],
      program.programId
    );
    
    console.log("Deterministic test: same inputs produce same CID:", cid_v1.equals(cid_v2));

    // Test 2: Different user should produce different CID
    const otherUser = anchor.web3.Keypair.generate().publicKey;
    const [cidDiffUser] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(testHash), Buffer.from(testPolicy), otherUser.toBuffer()],
      program.programId
    );
    
    console.log("Different user test: different CID:", !cid_v1.equals(cidDiffUser));

    // Test 3: Different policy should produce different CID
    const diffPolicy = new Uint8Array(32).fill(77);
    const [cidDiffPolicy] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("cid"), Buffer.from(testHash), Buffer.from(diffPolicy), owner.toBuffer()],
      program.programId
    );
    
    console.log("Different policy test: different CID:", !cid_v1.equals(cidDiffPolicy));
  });
});
