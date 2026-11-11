#!/usr/bin/env bash
# Deploy the upstream ERC-8183 job-escrow contract (MIT, erc-8183/base-contracts)
# behind an ERC1967 proxy, then print the address to register as our
# settlement rail + the oracle address to name as `evaluator`.
#
# Usage:
#   RPC=https://sepolia.base.org ./scripts/deploy-8183.sh          # testnet
#   RPC=https://mainnet.base.org ./scripts/deploy-8183.sh          # mainnet (~$3 gas)
# Key: ~/.widespread/8183-deployer.key (generated; fund 0x5BE8aF8dc6d74E863da8a5C39Fb38ACd0e13eA8d)
#   Base Sepolia faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
#   Celo Sepolia faucet: https://faucet.celo.org (captcha-gated — browser required)
set -euo pipefail

RPC="${RPC:-https://sepolia.base.org}"
KEY="$(cat ~/.widespread/8183-deployer.key)"
TREASURY="${TREASURY:-$(cast wallet address --private-key "0x$KEY")}"   # fees to deployer until DAO treasury exists
ADMIN="${ADMIN:-$TREASURY}"

WORK="$(mktemp -d)/e8183"
git clone --depth 1 https://github.com/erc-8183/base-contracts "$WORK"
(cd "$WORK" && git submodule update --init --depth 1 && forge build --quiet)

IMPL=$(cd "$WORK" && forge create contracts/ERC8183.sol:ERC8183 \
  --rpc-url "$RPC" --private-key "0x$KEY" --json | python3 -c "import json,sys;print(json.load(sys.stdin)['deployedTo'])")
echo "impl:   $IMPL"

INIT=$(cast calldata "initialize(address,address)" "$TREASURY" "$ADMIN")
PROXY=$(cd "$WORK" && forge create lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy \
  --rpc-url "$RPC" --private-key "0x$KEY" --json \
  --constructor-args "$IMPL" "$INIT" | python3 -c "import json,sys;print(json.load(sys.stdin)['deployedTo'])")
echo "proxy:  $PROXY  <- the ERC-8183 job contract; register this address"
echo "evaluator seat: set to widespread-oracle (verdicts at POST /api/evaluate)"
