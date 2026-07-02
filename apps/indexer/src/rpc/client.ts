import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import type { Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi } from '@solana/kit';
import type { IndexerConfig } from '../config.js';

export type SolanaClient = Rpc<SolanaRpcApi>;
export type SolanaSubscriptions = RpcSubscriptions<SolanaRpcSubscriptionsApi>;

let rpcClient: SolanaClient | null = null;
let subscriptionClient: SolanaSubscriptions | null = null;

export function getRpcClient(config: IndexerConfig): SolanaClient {
  if (!rpcClient) {
    rpcClient = createSolanaRpc(config.rpcUrl);
  }
  return rpcClient;
}

export function getSubscriptionClient(config: IndexerConfig): SolanaSubscriptions {
  if (!subscriptionClient) {
    subscriptionClient = createSolanaRpcSubscriptions(config.wsUrl);
  }
  return subscriptionClient;
}
