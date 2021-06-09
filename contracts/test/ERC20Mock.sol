// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.0;

import {ERC20} from '@solidstate/contracts/token/ERC20/ERC20.sol';
import {ERC20MetadataStorage} from '@solidstate/contracts/token/ERC20/ERC20MetadataStorage.sol';

contract ERC20Mock is ERC20 {
  constructor (
    string memory symbol
  ) {
    ERC20MetadataStorage.layout().symbol = symbol;
    ERC20MetadataStorage.layout().decimals = 18;
  }

  function mint(address _account, uint256 _amount) public {
    _mint(_account, _amount);
  }
}