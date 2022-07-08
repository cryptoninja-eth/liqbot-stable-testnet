import { Decimal, MoneypStoreState, Vault, UserVault } from "@moneyprotocol/lib-base";

const liquidatableInNormalMode = (state: LiquidationState) => (trove: Vault) =>
  trove.collateralRatioIsBelowMinimum(state.price);

const liquidatableInRecoveryMode = (state: LiquidationState) => (trove: Vault) =>
  trove.collateralRatioIsBelowMinimum(state.price) ||
  (trove.collateralRatio(state.price).lt(state.total.collateralRatio(state.price)) &&
    trove.debt.lte(state.bpdInStabilityPool));

const liquidatable = (state: LiquidationState) =>
  state.total.collateralRatioIsBelowCritical(state.price)
    ? liquidatableInRecoveryMode(state)
    : liquidatableInNormalMode(state);

const byDescendingCollateral = ({ collateral: a }: Vault, { collateral: b }: Vault) =>
  b.gt(a) ? 1 : b.lt(a) ? -1 : 0;

export type LiquidationState = Readonly<
  Pick<MoneypStoreState, "total" | "price" | "bpdInStabilityPool">
>;

function tryToOffset(state: LiquidationState, offset: Vault): LiquidationState {
  if (offset.debt.lte(state.bpdInStabilityPool)) {
    // Completely offset
    return {
      ...state,
      bpdInStabilityPool: state.bpdInStabilityPool.sub(offset.debt),
      total: state.total.subtract(offset)
    };
  } else if (state.bpdInStabilityPool.gt(Decimal.ZERO)) {
    // Partially offset, emptying the pool
    return {
      ...state,
      bpdInStabilityPool: Decimal.ZERO,
      total: state.total
        .subtractDebt(state.bpdInStabilityPool)
        .subtractCollateral(offset.collateral.mulDiv(state.bpdInStabilityPool, offset.debt))
    };
  } else {
    // Empty pool, no offset
    return state;
  }
}

const simulateLiquidation = (state: LiquidationState, liquidatedTrove: Vault): LiquidationState => {
  const recoveryMode = state.total.collateralRatioIsBelowCritical(state.price);
  const collateralGasCompensation = liquidatedTrove.collateral.div(200); // 0.5%

  if (!recoveryMode || liquidatedTrove.collateralRatio(state.price) > Decimal.ONE) {
    state = tryToOffset(state, liquidatedTrove.subtractCollateral(collateralGasCompensation));
  }

  return {
    ...state,
    total: state.total.subtractCollateral(collateralGasCompensation)
  };
};

export const selectForLiquidation = (
  candidates: UserVault[],
  state: LiquidationState,
  limit: number
): UserVault[] => {
  candidates = candidates.slice().sort(byDescendingCollateral); // bigger Troves first

  const selected: UserVault[] = [];

  for (let i = 0; i < limit; ++i) {
    const biggestLiquidatableIdx = candidates.findIndex(liquidatable(state));

    if (biggestLiquidatableIdx < 0) {
      break;
    }

    const [trove] = candidates.splice(biggestLiquidatableIdx, 1);
    selected.push(trove);
    state = simulateLiquidation(state, trove);
  }

  return selected;
};
