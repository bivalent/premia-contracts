// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.0;

import { ABDKMath64x64 } from 'abdk-libraries-solidity/ABDKMath64x64.sol';

library OptionMath {
  using ABDKMath64x64 for int128;

  // 64x64 integer constants
  int128 internal constant ONE_64x64 = 0x10000000000000000;
  int128 internal constant THREE_64x64 = 0x30000000000000000;

  // 64x64 fixed point constants used in Choudhury’s approximation of the Black-Scholes CDF
  int128 private constant CDF_CONST_0 = 0x09109f285df452394; // 2260 / 3989
  int128 private constant CDF_CONST_1 = 0x19abac0ea1da65036; // 6400 / 3989
  int128 private constant CDF_CONST_2 = 0x0d3c84b78b749bd6b; // 3300 / 3989

  /**
   * @notice calculate the rolling EMA of a time series
   * @param oldValue64x64 64x64 fixed point representation of previous value
   * @param newValue64x64 64x64 fixed point representation of current value
   * @param window number of periods to use in calculation
   * @return the new EMA value for today
   */
  function rollingEma (
    int128 oldValue64x64,
    int128 newValue64x64,
    uint256 window
  ) internal pure returns (int128) {
    return ABDKMath64x64.divu(2, window + 1).mul(
      newValue64x64.sub(oldValue64x64)
    ).add(oldValue64x64);
  }

  /**
   * @notice calculate the rolling EMA variance of a time series
   * @param oldVariance64x64 64x64 fixed point representation of previous variance
   * @param oldValue64x64 64x64 fixed point representation of previous value
   * @param newValue64x64 64x64 fixed point representation of current value
   * @param window number of periods to use in calculation
   * @return the new variance value for today
   */
  function rollingEmaVariance (
    int128 oldVariance64x64,
    int128 oldValue64x64,
    int128 newValue64x64,
    uint256 window
  ) internal pure returns (int128) {
    int128 alpha64x64 = ABDKMath64x64.divu(2, window + 1);

    return ONE_64x64.sub(alpha64x64).mul(
      oldVariance64x64
    ).add(
      alpha64x64.mul(
        newValue64x64.sub(oldValue64x64).pow(2)
      )
    );
  }

  /**
   * @notice calculate Choudhury’s approximation of the Black-Scholes CDF
   * @param input64x64 64x64 fixed point representation of random variable
   * @return the approximated CDF of x
   */
  function N (
    int128 input64x64
  ) internal pure returns (int128) {
    // squaring via mul is cheaper than via pow
    int128 inputSquared64x64 = input64x64.mul(input64x64);

    int128 value64x64 = (-inputSquared64x64 >> 1).exp().div(
      CDF_CONST_0.add(
        CDF_CONST_1.mul(input64x64.abs())
      ).add(
        CDF_CONST_2.mul(inputSquared64x64.add(THREE_64x64).sqrt())
      )
    );

    return input64x64 > 0 ? ONE_64x64.sub(value64x64) : value64x64;
  }

  /**
   * @notice calculate the price of an option using the Black-Scholes model
   * @param emaVarianceAnnualized64x64 64x64 fixed point representation of annualized EMA of variance
   * @param strike64x64 64x64 fixed point representation of strike price
   * @param spot64x64 64x64 fixed point representation of spot price
   * @param timeToMaturity64x64 64x64 fixed point representation of duration of option contract (in years)
   * @param isCall whether to price "call" or "put" option
   * @return 64x64 fixed point representation of Black-Scholes option price
   */
  function bsPrice (
    int128 emaVarianceAnnualized64x64,
    int128 strike64x64,
    int128 spot64x64,
    int128 timeToMaturity64x64,
    bool isCall
  ) internal pure returns (int128) {
    // TODO: add require to check variance, price, timeToMaturity64x64 > 0, strike => 0.5 * price,  strike <= 2 * price
    int128 cumulativeVariance64x64 = timeToMaturity64x64.mul(emaVarianceAnnualized64x64);
    int128 cumulativeVarianceSqrt64x64 = cumulativeVariance64x64.sqrt();

    int128 d1_64x64 = spot64x64.div(strike64x64).ln().add(cumulativeVariance64x64 >> 1).div(cumulativeVarianceSqrt64x64);
    int128 d2_64x64 = d1_64x64.sub(cumulativeVarianceSqrt64x64);

    if (isCall) {
      return spot64x64.mul(N(d1_64x64)).sub(strike64x64.mul(N(d2_64x64)));
    } else {
      return -spot64x64.mul(N(-d1_64x64)).sub(strike64x64.mul(N(-d2_64x64)));
    }
  }

  /**
   * @notice recalculate C-Level based on change in liquidity
   * @param initialCLevel64x64 64x64 fixed point representation of C-Level of Pool before update
   * @param oldPoolState64x64 64x64 fixed point representation of liquidity in pool before update
   * @param newPoolState64x64 64x64 fixed point representation of liquidity in pool after update
   * @param steepness64x64 64x64 fixed point representation of steepness coefficient
   * @return new C-Level
   */
  function calculateCLevel (
    int128 initialCLevel64x64,
    int128 oldPoolState64x64,
    int128 newPoolState64x64,
    int128 steepness64x64
  ) internal pure returns (int128) {
    return newPoolState64x64.sub(oldPoolState64x64).div(
      oldPoolState64x64 > newPoolState64x64 ? oldPoolState64x64 : newPoolState64x64
    ).mul(steepness64x64).neg().exp().mul(initialCLevel64x64);
  }

  /**
   * @notice calculate the price of an option using the Median Finance model
   * @param emaVarianceAnnualized64x64 64x64 fixed point representation of annualized EMA of variance
   * @param strike64x64 64x64 fixed point representation of strike price
   * @param spot64x64 64x64 fixed point representation of spot price
   * @param timeToMaturity64x64 64x64 fixed point representation of duration of option contract (in years)
   * @param cLevel64x64 64x64 fixed point representation of C-Level of Pool before purchase
   * @param oldPoolState 64x64 fixed point representation of current state of the pool
   * @param newPoolState 64x64 fixed point representation of state of the pool after trade
   * @param steepness64x64 64x64 fixed point representation of Pool state delta multiplier
   * @param isCall whether to price "call" or "put" option
   * @return 64x64 fixed point representation of Median option price
   */
  function quotePrice (
    int128 emaVarianceAnnualized64x64,
    int128 strike64x64,
    int128 spot64x64,
    int128 timeToMaturity64x64,
    int128 cLevel64x64,
    int128 oldPoolState,
    int128 newPoolState,
    int128 steepness64x64,
    bool isCall
  ) internal pure returns (int128) {
    // TODO: formalize newPoolState < oldPoolState
    int128 deltaPoolState64x64 = newPoolState.sub(oldPoolState).div(oldPoolState).mul(steepness64x64);
    int128 tradingDelta64x64 = deltaPoolState64x64.neg().exp();

    int128 bsPrice64x64 = bsPrice(emaVarianceAnnualized64x64, strike64x64, spot64x64, timeToMaturity64x64, isCall);

    return bsPrice64x64.mul(
      // C-Level
      tradingDelta64x64.mul(cLevel64x64)
    ).mul(
      // slippage coefficient
      ONE_64x64.sub(tradingDelta64x64).div(deltaPoolState64x64)
    );
  }
}
