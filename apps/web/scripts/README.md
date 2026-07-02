# Scripts

## e2e-confidential-transfer.ts

End-to-end confidential transfer test against Solana **devnet**. It creates a fresh
Token-2022 mint with the `ConfidentialTransferMint` extension, then exercises the full
flow: create/configure confidential accounts for two owners, public mint, deposit,
apply pending balance, confidential transfer (context-state ZK proof flow, multiple
transactions), decrypt-and-assert the recipient balance, and withdraw back to the
public balance.

### Run

```sh
NODE_OPTIONS=--experimental-wasm-modules npx tsx apps/web/scripts/e2e-confidential-transfer.ts
```

Or from `apps/web/`:

```sh
bun run test:e2e
```

> **Must run under Node, not Bun.** `@solana-program/token-2022/confidential` and
> `@solana/zk-sdk/bundler` load WASM via ESM imports. Bun fails with
> `wasm.__wbindgen_start is not a function`; Node needs the
> `--experimental-wasm-modules` flag (works on Node v25).

### Funding

- If `FAUCET_PRIVATE_KEY` is set in `apps/web/.env` (base58 or JSON array secret key),
  it is used as the fee payer / owner A. The account needs ~0.1 devnet SOL.
- Otherwise an ephemeral keypair is generated and a 2 SOL devnet airdrop is requested.
  The public devnet faucet is heavily rate-limited; if the airdrop fails, fund a key
  manually at https://faucet.solana.com and set `FAUCET_PRIVATE_KEY`.

### Notes

- `SOLANA_RPC_URL` overrides the default `https://api.devnet.solana.com`.
- The full flow sends ~15 transactions and takes a couple of minutes; a small delay is
  inserted between transactions to stay under public RPC rate limits.
- Each transaction is printed with a Solana Explorer link (`?cluster=devnet`).
