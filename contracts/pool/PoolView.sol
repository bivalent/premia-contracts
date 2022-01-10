// SPDX-License-Identifier: BUSL-1.1
// For further clarification please see https://license.premia.legal

pragma solidity ^0.8.0;

import {EnumerableSet} from "@solidstate/contracts/utils/EnumerableSet.sol";
import {ERC1155BaseStorage} from "@solidstate/contracts/token/ERC1155/base/ERC1155BaseStorage.sol";
import {ERC1155EnumerableStorage} from "@solidstate/contracts/token/ERC1155/enumerable/ERC1155EnumerableStorage.sol";

import {IPremiaOptionNFTDisplay} from "../interface/IPremiaOptionNFTDisplay.sol";
import {IPoolView, IERC1155Metadata} from "./IPoolView.sol";
import {PoolInternal} from "./PoolInternal.sol";
import {PoolStorage} from "./PoolStorage.sol";

/**
 * @title Premia option pool
 * @dev deployed standalone and referenced by PoolProxy
 */
contract PoolView is IPoolView, PoolInternal {
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;
    using PoolStorage for PoolStorage.Layout;

    address internal immutable NFT_DISPLAY_ADDRESS;

    constructor(
        address nftDisplay,
        address ivolOracle,
        address weth,
        address premiaMining,
        address feeReceiver,
        address feeDiscountAddress,
        int128 fee64x64
    )
        PoolInternal(
            ivolOracle,
            weth,
            premiaMining,
            feeReceiver,
            feeDiscountAddress,
            fee64x64
        )
    {
        NFT_DISPLAY_ADDRESS = nftDisplay;
    }

    /**
     * @inheritdoc IPoolView
     */
    function getFeeReceiverAddress() external view returns (address) {
        return FEE_RECEIVER_ADDRESS;
    }

    /**
     * @inheritdoc IPoolView
     */
    function getPoolSettings()
        external
        view
        returns (PoolStorage.PoolSettings memory)
    {
        PoolStorage.Layout storage l = PoolStorage.layout();
        return
            PoolStorage.PoolSettings(
                l.underlying,
                l.base,
                l.underlyingOracle,
                l.baseOracle
            );
    }

    /**
     * @inheritdoc IPoolView
     */
    function getTokenIds() external view returns (uint256[] memory) {
        PoolStorage.Layout storage l = PoolStorage.layout();
        uint256 length = l.tokenIds.length();
        uint256[] memory result = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            result[i] = l.tokenIds.at(i);
        }

        return result;
    }

    /**
     * @inheritdoc IPoolView
     */
    function getCLevel64x64(bool isCall)
        external
        view
        returns (int128 cLevel64x64)
    {
        (cLevel64x64, ) = PoolStorage.layout().getRealPoolState(isCall);
    }

    /**
     * @inheritdoc IPoolView
     */
    function getSteepness64x64(bool isCallPool) external view returns (int128) {
        if (isCallPool) {
            return PoolStorage.layout().steepnessUnderlying64x64;
        } else {
            return PoolStorage.layout().steepnessBase64x64;
        }
    }

    /**
     * @inheritdoc IPoolView
     */
    function getPrice(uint256 timestamp) external view returns (int128) {
        return PoolStorage.layout().getPriceUpdate(timestamp);
    }

    /**
     * @inheritdoc IPoolView
     */
    function getParametersForTokenId(uint256 tokenId)
        external
        pure
        returns (
            PoolStorage.TokenType,
            uint64,
            int128
        )
    {
        return PoolStorage.parseTokenId(tokenId);
    }

    /**
     * @inheritdoc IPoolView
     */
    function getMinimumAmounts()
        external
        view
        returns (uint256 minCallTokenAmount, uint256 minPutTokenAmount)
    {
        PoolStorage.Layout storage l = PoolStorage.layout();
        return (_getMinimumAmount(l, true), _getMinimumAmount(l, false));
    }

    /**
     * @inheritdoc IPoolView
     */
    function getCapAmounts()
        external
        view
        returns (uint256 callTokenCapAmount, uint256 putTokenCapAmount)
    {
        PoolStorage.Layout storage l = PoolStorage.layout();
        return (_getPoolCapAmount(l, true), _getPoolCapAmount(l, false));
    }

    /**
     * @inheritdoc IPoolView
     */
    function getUserTVL(address user)
        external
        view
        returns (uint256 underlyingTVL, uint256 baseTVL)
    {
        PoolStorage.Layout storage l = PoolStorage.layout();
        return (l.userTVL[user][true], l.userTVL[user][false]);
    }

    /**
     * @inheritdoc IPoolView
     */
    function getTotalTVL()
        external
        view
        returns (uint256 underlyingTVL, uint256 baseTVL)
    {
        PoolStorage.Layout storage l = PoolStorage.layout();
        return (l.totalTVL[true], l.totalTVL[false]);
    }

    /**
     * @inheritdoc IPoolView
     */
    function getLiquidityQueuePosition(address account, bool isCallPool)
        external
        view
        returns (uint256 liquidityBeforePosition, uint256 positionSize)
    {
        PoolStorage.Layout storage l = PoolStorage.layout();

        uint256 tokenId = _getFreeLiquidityTokenId(isCallPool);

        if (!l.isInQueue(account, isCallPool)) {
            liquidityBeforePosition = _totalSupply(tokenId);
        } else {
            mapping(address => address) storage asc = l.liquidityQueueAscending[
                isCallPool
            ];

            address depositor = asc[address(0)];

            while (depositor != account) {
                liquidityBeforePosition += _balanceOf(depositor, tokenId);
                depositor = asc[depositor];
            }

            positionSize = _balanceOf(depositor, tokenId);
        }
    }

    /**
     * @inheritdoc IPoolView
     */
    function getPremiaMining() external view returns (address) {
        return PREMIA_MINING_ADDRESS;
    }

    /**
     * @inheritdoc IPoolView
     */
    function getDivestmentTimestamps(address account)
        external
        view
        returns (
            uint256 callDivestmentTimestamp,
            uint256 putDivestmentTimestamp
        )
    {
        PoolStorage.Layout storage l = PoolStorage.layout();
        callDivestmentTimestamp = l.divestmentTimestamps[account][true];
        putDivestmentTimestamp = l.divestmentTimestamps[account][false];
    }

    function isBuyBackEnabled(address account)
        external
        view
        override
        returns (bool)
    {
        return PoolStorage.layout().isBuyBackEnabled[account];
    }

    /**
     * @notice get list of underwriters with buyback enabled for a specific shortTokenId
     * @param shortTokenId the long token id
     * @return buyers list of underwriters with buyback enabled for this shortTokenId
     * @return amounts amounts of options underwritten by each LP with buyback enabled
     */
    function getBuyers(uint256 shortTokenId)
        external
        view
        override
        returns (address[] memory buyers, uint256[] memory amounts)
    {
        PoolStorage.Layout storage l = PoolStorage.layout();
        ERC1155EnumerableStorage.Layout
            storage erc1155EnumerableLayout = ERC1155EnumerableStorage.layout();

        uint256 length = erc1155EnumerableLayout
            .accountsByToken[shortTokenId]
            .length();
        uint256 i = 0;

        buyers = new address[](length);
        amounts = new uint256[](length);

        for (uint256 j = 0; j < length; j++) {
            address lp = erc1155EnumerableLayout
                .accountsByToken[shortTokenId]
                .at(j);
            if (l.isBuyBackEnabled[lp]) {
                buyers[i] = lp;
                amounts[i] = ERC1155BaseStorage.layout().balances[shortTokenId][
                    lp
                ];
                i++;
            }
        }

        // Reduce array size
        if (length > 0 && i < length - 1) {
            assembly {
                mstore(buyers, sub(mload(buyers), sub(length, i)))
                mstore(amounts, sub(mload(amounts), sub(length, i)))
            }
        }
    }

    /**
     * @inheritdoc IERC1155Metadata
     * @dev SVG generated via external PremiaOptionNFTDisplay contract
     */
    function uri(uint256 tokenId) external view returns (string memory) {
        return
            IPremiaOptionNFTDisplay(NFT_DISPLAY_ADDRESS).tokenURI(
                address(this),
                tokenId
            );
    }
}
