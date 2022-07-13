// SPDX-License-Identifier: LGPL-3.0-or-later

pragma solidity ^0.8.0;

import {VePremiaStorage} from "./VePremiaStorage.sol";
import {IPremiaStaking} from "./IPremiaStaking.sol";

interface IVePremia is IPremiaStaking {
    event AddVote(
        address indexed voter,
        address indexed pool,
        bool indexed isCall,
        uint256 amount
    );
    event RemoveVote(
        address indexed voter,
        address indexed pool,
        bool indexed isCall,
        uint256 amount
    );

    /**
     * @notice get total voting power across all users
     * @return total voting power across all users
     */
    function getTotalVotingPower() external view returns (uint256);

    /**
     * @notice get total votes for specific pools
     * @param pool address of the pool
     * @param isCallPool whether the pool is call or put
     * @return total votes for specific pool
     */
    function getPoolVotes(address pool, bool isCallPool)
        external
        view
        returns (uint256);

    /**
     * @notice get voting power of a user
     * @param user user for which to get voting power
     * @return voting power of the user
     */
    function getUserVotingPower(address user) external view returns (uint256);

    /**
     * @notice get votes of user
     * @param user user from which to get votes
     * @return votes of user
     */
    function getUserVotes(address user)
        external
        view
        returns (VePremiaStorage.Vote[] memory);

    /**
     * @notice add or remove votes, in the limit of the user voting power
     * @param votes votes to cast
     */
    function castVotes(VePremiaStorage.Vote[] memory votes) external;
}
