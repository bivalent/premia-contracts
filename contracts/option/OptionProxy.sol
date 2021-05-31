// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.0;

import '@solidstate/contracts/access/OwnableStorage.sol';

import '../core/IProxyManager.sol';
import "../interface/IERC20Extended.sol";
import '../manager/ManagedProxyWithManager.sol';

import "./OptionStorage.sol";

contract OptionProxy is ManagedProxyWithManager {
    constructor(address _owner, string memory _uri, address _denominator, address _feeCalculator, address _feeRecipient) ManagedProxy(IProxyManager.getOptionImplementation.selector) {
        OwnableStorage.layout().owner = _owner;
        ManagerStorage.layout().manager = msg.sender;

        OptionStorage.Layout storage l = OptionStorage.layout();
        l.uri = _uri;
        l.nextOptionId = 1;
        l.maxExpiration = 365 days;
        l.denominator = _denominator;
        l.denominatorDecimals = IERC20Extended(_denominator).decimals();
        l.feeCalculator = _feeCalculator;
        l.feeRecipient = _feeRecipient;
    }
}