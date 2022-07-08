import WebSocket from "ws";
import { providers, Wallet } from "ethers";
import { BlockPolledMoneypStore, BitcoinsMoneyp, BitcoinsMoneypWithStore } from "@moneyprotocol/lib-ethers";
import { Batched, WebSocketAugmented } from "@moneyprotocol/providers";

import config from "../config.js";

const { StaticJsonRpcProvider } = providers;
const BatchedWebSocketAugmentedProvider = Batched(WebSocketAugmented(StaticJsonRpcProvider));

Object.assign(globalThis, { WebSocket });

export const connectToLiquity = async (): Promise<
  BitcoinsMoneypWithStore<BlockPolledMoneypStore>
> => {
  const provider = new BatchedWebSocketAugmentedProvider(config.httpRpcUrl);
  const network = await provider.getNetwork();

  if (network.chainId !== config.chainId) {
    throw new Error(`chainId mismatch (got ${network.chainId} instead of ${config.chainId})`);
  }

  provider.chainId = network.chainId;

  if (config.wsRpcUrl) {
    provider.openWebSocket(config.wsRpcUrl, network);
  }

  return BitcoinsMoneyp.connect(
    config.walletKey ? new Wallet(config.walletKey, provider) : provider,
    { useStore: "blockPolled" }
  );
};
