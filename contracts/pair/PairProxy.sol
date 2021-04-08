// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.0;

import '@solidstate/contracts/access/OwnableStorage.sol';
import '@solidstate/contracts/proxy/managed/ManagedProxyOwnable.sol';

import '../core/IProxyManager.sol';
import '../pool/PoolProxy.sol';
import './PairStorage.sol';

/**
 * @title Upgradeable proxy with centrally controlled Pair implementation
 */
contract PairProxy is ManagedProxyOwnable {
  using PairStorage for PairStorage.Layout;

  constructor (
    address asset0,
    address asset1
  ) ManagedProxy(IProxyManager.getPairImplementation.selector) {
    OwnableStorage.layout().owner = msg.sender;

    PoolProxy pool0 = new PoolProxy(msg.sender, asset0, asset1);
    PoolProxy pool1 = new PoolProxy(msg.sender, asset1, asset0);

    {
      PairStorage.Layout storage l = PairStorage.layout();
      l.setPools(address(pool0), address(pool1));
      l.period = 1 days;
      l.window = 28;
    }
  }
}
