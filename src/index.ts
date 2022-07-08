import { MoneypStoreState } from "@moneyprotocol/lib-base";
import { BlockPolledMoneypStore, BitcoinsMoneypWithStore } from "@moneyprotocol/lib-ethers";

import { connectToLiquity } from "./connection.js";
import { Executor, getExecutor } from "./execution.js";
import { tryToLiquidate } from "./liquidation.js";
import { error, info, warn } from "./logging.js";

const createLiquidationTask = (
  liquity: BitcoinsMoneypWithStore<BlockPolledMoneypStore>,
  executor?: Executor
): (() => void) => {
  let running = false;
  let deferred = false;

  const runLiquidationTask = async () => {
    if (running) {
      deferred = true;
      return;
    }

    running = true;
    await tryToLiquidate(liquity, executor);
    running = false;

    if (deferred) {
      deferred = false;
      runLiquidationTask();
    }
  };

  return runLiquidationTask;
};

const haveUndercollateralizedTroves = (s: MoneypStoreState) => {
  info("===== haveUndercollateralizedTroves =====");

  info("MoneypStoreState:");
  info(`Total: ${s.total.toString()}`);
  info(`Price: ${s.price.toString()}`);

  const recoveryMode = s.total.collateralRatioIsBelowCritical(s.price);
  info(`recoveryMode: ${recoveryMode}`);
  
  const riskiestTrove = s._riskiestVaultBeforeRedistribution.applyRedistribution(
    s.totalRedistributed
  );
  info("riskiestTrove:");
  info(riskiestTrove.toString());

  const result = recoveryMode
    ? riskiestTrove._nominalCollateralRatio.lt(s.total._nominalCollateralRatio)
    : riskiestTrove.collateralRatioIsBelowMinimum(s.price);

  info(`result: ${result}`);
  return result;
};

const main = async () => {
  const liquity = await connectToLiquity();
  const executor = liquity.connection.signer && (await getExecutor(liquity.store));
  const runLiquidationTask = createLiquidationTask(liquity, executor);

  if (!liquity.connection.signer) {
    warn("No 'walletKey' configured; running in read-only mode.");
  }

  liquity.store.onLoaded = () => {
    info("Waiting for price drops...");

    if (haveUndercollateralizedTroves(liquity.store.state)) {
      runLiquidationTask();
    }
  };

  liquity.store.subscribe(({ newState }) => {
    if (haveUndercollateralizedTroves(newState)) {
      runLiquidationTask();
    }
  });

  liquity.store.start();
};

main().catch(err => {
  error("Fatal error:");
  console.error(err);
  process.exit(1);
});
