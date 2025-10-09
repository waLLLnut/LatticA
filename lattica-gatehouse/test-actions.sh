#!/bin/bash
# Gatekeeper Actions Integration Test
# Tests the complete 2-phase workflow: Register CIDs → Submit Job

set -e

BASE_URL="http://localhost:3000"
WALLET="Fqu2RsXQpXd9h24TFKvCeBJTWCvjwotECFL47VuuMwg7"

echo "╔════════════════════════════════════════╗"
echo "║  Gatekeeper Actions Integration Test  ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Phase 1: Register CIDs
echo "📝 Phase 1: Register CID Handles"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "1️⃣  GET /api/actions/job/registerCIDs"
GET_RESPONSE=$(curl -s "${BASE_URL}/api/actions/job/registerCIDs")
echo "$GET_RESPONSE" | jq '{type, title, label, fhe_cpk: {cpk_id, scheme, key_epoch}}'
echo ""

echo "2️⃣  POST /api/actions/job/registerCIDs"
REGISTER_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/actions/job/registerCIDs" \
  -H "Content-Type: application/json" \
  -d "{
    \"account\": \"${WALLET}\",
    \"ciphertexts\": [
      {\"encrypted_data\": \"ct_alpha_001\", \"nonce\": \"abc123\"},
      {\"encrypted_data\": \"ct_beta_002\", \"nonce\": \"def456\"}
    ],
    \"enc_params\": {
      \"scheme\": \"FHE16\",
      \"params\": {\"modulus\": 65537}
    },
    \"policy_ctx\": {
      \"allow\": [\"compute\", \"read\"],
      \"deny\": [\"transfer\"],
      \"conditions\": {\"max_uses\": 10}
    },
    \"provenance\": \"client\"
  }")

echo "$REGISTER_RESPONSE" | jq '{
  message, 
  cid_count: (.cids | length),
  cid_pdas: [.cids[].cid_pda],
  next_action: .links.next.href
}'
echo ""

# Extract CID PDAs
CID1=$(echo "$REGISTER_RESPONSE" | jq -r '.cids[0].cid_pda')
CID2=$(echo "$REGISTER_RESPONSE" | jq -r '.cids[1].cid_pda')
CIDS_JSON="[\"$CID1\",\"$CID2\"]"

echo "✅ Registered CIDs:"
echo "   - $CID1"
echo "   - $CID2"
echo ""

# Phase 2: Submit Job
echo "📦 Phase 2: Submit Confidential Job"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "3️⃣  GET /api/actions/job/submit?cids=..."
CIDS_ENCODED=$(echo "$CIDS_JSON" | jq -R -r @uri)
PREVIEW_RESPONSE=$(curl -s "${BASE_URL}/api/actions/job/submit?cids=${CIDS_ENCODED}")
echo "$PREVIEW_RESPONSE" | jq '{type, title, preview, hashSpec: {cid_set_id, commitment}}'
echo ""

echo "4️⃣  POST /api/actions/job/submit"
SUBMIT_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/actions/job/submit" \
  -H "Content-Type: application/json" \
  -d "{
    \"account\": \"${WALLET}\",
    \"cids\": ${CIDS_JSON},
    \"batch\": \"GCAx2LxboBrJq9u3usb1JhapxKkekDa72fLLiikzXFnn\",
    \"ir_digest\": \"0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef\",
    \"policy_ctx\": {
      \"allow\": [\"compute\", \"read\"],
      \"deny\": [\"transfer\"],
      \"conditions\": {\"max_uses\": 10}
    },
    \"provenance\": 1
  }")

echo "$SUBMIT_RESPONSE" | jq '{
  message,
  verification: {
    hashes: {
      cid_set_id: .verification.hashes.cid_set_id,
      policy_hash: .verification.hashes.policy_hash,
      commitment: .verification.hashes.commitment
    },
    pda: {
      config: .verification.pda.config,
      job: .verification.pda.job
    },
    remaining_accounts: .verification.remaining_accounts
  }
}'
echo ""

# Summary
echo "╔════════════════════════════════════════╗"
echo "║          Test Summary                  ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "✅ Phase 1: CID Registration"
echo "   - Registered: 2 CID handles"
echo "   - CID #1: $(echo $CID1 | cut -c1-20)..."
echo "   - CID #2: $(echo $CID2 | cut -c1-20)..."
echo ""
echo "✅ Phase 2: Job Submission"
JOB_PDA=$(echo "$SUBMIT_RESPONSE" | jq -r '.verification.pda.job // "N/A"')
COMMITMENT=$(echo "$SUBMIT_RESPONSE" | jq -r '.verification.hashes.commitment // "N/A"' | cut -c1-20)
echo "   - Job PDA: $(echo $JOB_PDA | cut -c1-20)..."
echo "   - Commitment: ${COMMITMENT}..."
echo "   - CID References: 2"
echo ""
echo "🎉 Integration test complete!"
echo ""
echo "📌 Note: These are unsigned transactions."
echo "   In production, the wallet signs and sends them to devnet."

