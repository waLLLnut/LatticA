# lattica-gatehouse

This is a Next.js app containing:

- Tailwind and Shadcn UI for styling
- [Gill](https://gill.site/) Solana SDK
- Shadcn [Wallet UI](https://registry.wallet-ui.dev) components

## Getting Started

### Installation

#### Create an app using this template

```shell
npx create-solana-dapp@latest -t gh:solana-foundation/templates/gill/lattica-gatehouse
```

#### Install Dependencies

```shell
npm install
```

#### Start the app

```shell
npm run dev
```

## SOLANA ACTIONS

### GET /api/actions/job/submit
```bash
curl -X GET http://localhost:3000/api/actions/job/submit \
  -H "Accept: application/json"
```

```bash
curl -X POST http://localhost:3000/api/actions/job/submit \
  -H "Content-Type: application/json" \
  -d '{
    "account": "11111111111111111111111111111111",
    "inputs": [{"cid":"QmXXX"}, {"cid":"QmYYY"}],
    "ir_digest": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "enc_params": {"scheme": "TFHE", "params": {}},
    "policy_ctx": {"allow": ["read"], "deny": ["write"]}
  }'
```

