import assert from "assert";

import chalk from "chalk";
import { BigNumber } from "ethers";
import { Decimal } from "@moneyprotocol/lib-base";
import { BlockPolledMoneypStore, BitcoinsMoneypWithStore } from "@moneyprotocol/lib-ethers";

import config from "../config.js";
import { error, info, success, warn } from "./logging.js";
import { Executor } from "./execution.js";
import { selectForLiquidation } from "./strategy.js";

// About 2M gas required to liquidate 10 Troves (much of it is refunded though).
const defaultMaxTrovesToLiquidate = 10;

export enum LiquidationOutcome {
  NOTHING_TO_LIQUIDATE,
  SKIPPED_IN_READ_ONLY_MODE,
  SKIPPED_DUE_TO_HIGH_COST,
  FAILURE,
  SUCCESS
}

export const tryToLiquidate = async (
  liquity: BitcoinsMoneypWithStore<BlockPolledMoneypStore>,
  executor?: Executor
): Promise<LiquidationOutcome> => {
  const { store } = liquity;

  const riskiestTroves = await liquity.getVaults({
    first: 1000,
    sortedBy: "ascendingCollateralRatio"
  })

  const troves = selectForLiquidation(
    riskiestTroves,
    store.state,
    config.maxTrovesToLiquidate ?? defaultMaxTrovesToLiquidate
  );

  if (troves.length === 0) {
    // Nothing to liquidate
    return LiquidationOutcome.NOTHING_TO_LIQUIDATE;
  }

  const addresses = troves.map(trove => trove.ownerAddress);

  if (!executor) {
    info(`Skipping liquidation of ${troves.length} Trove(s) in read-only mode.`);
    return LiquidationOutcome.SKIPPED_IN_READ_ONLY_MODE;
  }

  try {
    // Rough gas requirements:
    //  * In normal mode:
    //     - using Stability Pool: 400K + n * 176K
    //     - using redistribution: 377K + n * 174K
    //  * In recovery mode:
    //     - using Stability Pool: 415K + n * 178K
    //     - using redistribution: 391K + n * 178K
    //
    // `500K + n * 200K` should cover all cases (including starting in recovery mode and ending in
    // normal mode) with some margin for safety.
    const gasLimit = BigNumber.from(200e3).mul(troves.length).add(500e3);

    const liquidation = await liquity.populate.liquidate(addresses, { gasLimit });
    assert(liquidation.rawPopulatedTransaction.gasLimit);

    // liquidation.rawPopulatedTransaction.gas = 
    // liquidation.rawPopulatedTransaction.gasPrice = 

    const expectedCompensation = executor.estimateCompensation(troves, store.state.price);

    info(
      `Attempting to liquidate ${troves.length} Trove(s) ` +
        `(expecting $${expectedCompensation.toString(2)} compensation) ...`
    );

    const receipt = await executor.execute(liquidation);

    info(">>>>> Receipt:");
    info(JSON.stringify(receipt));

    if (receipt.status === "failed") {
      if (receipt.rawReceipt) {
        error(`TX ${receipt.rawReceipt.transactionHash} failed.`);
      } else {
        warn(`Liquidation TX wasn't included by miners.`);
      }

      return LiquidationOutcome.FAILURE;
    }

    const { collateralGasCompensation, bpdGasCompensation, liquidatedAddresses, minerCut } =
      receipt.details;

    const gasCost = Decimal.fromBigNumberString(
      receipt.rawReceipt.gasUsed.toHexString()
    ).mul(store.state.price);

    const totalCompensation = collateralGasCompensation
      .mul(store.state.price)
      .add(bpdGasCompensation)
      .sub(minerCut ?? Decimal.ZERO);

    success(
      `Received ${chalk.bold(`${collateralGasCompensation.toString(4)} RBTC`)} + ` +
        `${chalk.bold(`${bpdGasCompensation.toString(2)} BPD`)} compensation (` +
        (totalCompensation.gte(gasCost)
          ? `${chalk.green(`$${totalCompensation.sub(gasCost).toString(2)}`)} profit`
          : `${chalk.red(`$${gasCost.sub(totalCompensation).toString(2)}`)} loss`) +
        `) for liquidating ${liquidatedAddresses.length} Trove(s).`
    );

    return LiquidationOutcome.SUCCESS;
  } catch (err) {
    error("Unexpected error:");
    console.error(err);
    return LiquidationOutcome.FAILURE;
  }
};
