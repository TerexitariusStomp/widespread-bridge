// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IArbitrable { function rule(uint256, uint256) external; }
contract MockArbitrator {
    uint256 public cost = 0.01 ether;
    uint256 public next = 1;
    function arbitrationCost(bytes calldata) external view returns (uint256) { return cost; }
    function createDispute(uint256, bytes calldata) external payable returns (uint256 d) {
        d = next++;
    }
    // court simulation: anyone calls the arbitrable's rule() callback —
    // stands in for KlerosLiquid's juror-driven ruling path.
    function giveRuling(address arb, uint256 d, uint256 r) external {
        IArbitrable(arb).rule(d, r);
    }
}
