// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {KeeperCompatibleInterface} from "@chainlink/contracts/src/v0.8/interfaces/KeeperCompatibleInterface.sol";
import {IProxyManager} from "../core/IProxyManager.sol";
import {IPool} from "../pool/IPool.sol";
import {PoolStorage} from "../pool/PoolStorage.sol";

contract ProcessExpiredKeeper is KeeperCompatibleInterface {
    address private immutable PREMIA_DIAMOND;

    constructor(address premiaDiamond) {
        PREMIA_DIAMOND = premiaDiamond;
    }

    function checkUpkeep(bytes calldata)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        address[] memory poolList = IProxyManager(PREMIA_DIAMOND).getPoolList();

        for (uint256 i = 0; i < poolList.length; i++) {
            IPool pool = IPool(poolList[i]);

            uint256[] memory tokenIds = pool.getTokenIds();

            for (uint256 j = 0; j < tokenIds.length; j++) {
                (
                    PoolStorage.TokenType tokenType,
                    uint64 maturity,

                ) = PoolStorage.parseTokenId(tokenIds[j]);

                if (
                    tokenType != PoolStorage.TokenType.LONG_CALL &&
                    tokenType != PoolStorage.TokenType.LONG_PUT
                ) continue;
                if (maturity > block.timestamp) continue;

                return (true, abi.encode(pool, tokenIds[j]));
            }
        }

        return (false, "");
    }

    function performUpkeep(bytes calldata performData) external override {
        (IPool pool, uint256 longTokenId) = abi.decode(
            performData,
            (IPool, uint256)
        );

        pool.processAllExpired(longTokenId);
    }
}
