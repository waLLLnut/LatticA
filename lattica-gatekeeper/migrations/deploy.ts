// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LatticaGatekeeper } from "../target/types/lattica_gatekeeper";

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);

  // Load the program
  const program = anchor.workspace.LatticaGatekeeper as Program<LatticaGatekeeper>;
  const authority = provider.wallet.publicKey;

  console.log("Deploying Lattica Gatekeeper...");
  console.log("Program ID:", program.programId.toBase58());
  console.log("Authority:", authority.toBase58());

  // Derive config PDA
  const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  console.log("Config PDA:", configPda.toBase58());

  // Check if config is already initialized
  try {
    const configAccount = await program.account.config.fetch(configPda);
    console.log("✅ Config already initialized!");
    console.log("  Challenge window slots:", configAccount.challengeWindowSlots.toString());
    console.log("  Authority:", configAccount.authority.toBase58());
    return;
  } catch (err) {
    console.log("Config not initialized. Initializing now...");
  }

  // Initialize config
  const challengeWindowSlots = new anchor.BN(50); // 50 slots challenge window (~20 seconds)

  try {
    const tx = await program.methods
      .initConfig(challengeWindowSlots)
      .accountsStrict({
        config: configPda,
        authority: authority,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("✅ Config initialized successfully!");
    console.log("  Transaction signature:", tx);
    console.log("  Challenge window slots:", challengeWindowSlots.toString());
    console.log("  Config PDA:", configPda.toBase58());

    // Wait for confirmation
    await provider.connection.confirmTransaction(tx, "confirmed");
    console.log("✅ Transaction confirmed!");

    // Verify initialization
    const configAccount = await program.account.config.fetch(configPda);
    console.log("\n📋 Config Account:");
    console.log("  Authority:", configAccount.authority.toBase58());
    console.log("  Challenge window slots:", configAccount.challengeWindowSlots.toString());
  } catch (err) {
    console.error("❌ Failed to initialize config:");
    console.error(err);
    throw err;
  }
};
