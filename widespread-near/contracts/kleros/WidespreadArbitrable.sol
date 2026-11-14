// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Kleros arbitrator interface — the court's contract.
interface IArbitrator {
    function arbitrationCost(bytes calldata extraData) external view returns (uint256);
    function createDispute(uint256 choices, bytes calldata extraData)
        external payable returns (uint256 disputeID);
    function currentRuling(uint256 disputeID) external view returns (uint256);
}

/// @title WidespreadArbitrable — Kleros appeal rail for NEAR escrow markets
/// @notice A bonded dispute on the NEAR market contract gets a second,
///         human-court option: open a Kleros dispute here bound to the same
///         marketId/claimId, pin evidence to IPFS, and let jurors rule.
///         A relayer reads `rulings` and posts `resolveDispute` on NEAR from
///         the market's configured `arbitrator` account (kleros-proxy).
/// @dev Rulings are uints matching the NEAR contract's ruling set:
///      0 = dismiss, 1 = pay_claim, 2 = reject_claim, 3 = refund
contract WidespreadArbitrable {
    event DisputeCreation(uint256 indexed arbitratorDisputeID, uint256 indexed metaEvidenceID);
    event Evidence(
        uint256 indexed disputeID,
        uint256 indexed evidenceGroupID,
        address indexed submitter,
        string evidence
    );
    event Ruling(uint256 indexed disputeID, uint256 indexed ruling);
    event Bound(uint256 indexed disputeID, string marketId, string claimId);

    IArbitrator public arbitrator;
    address public governor;
    uint256 public metaEvidenceID;
    string public metaEvidenceURI;
    uint256 public evidenceGroupID;

    struct Case {
        string marketId;
        string claimId;        // "" = market-wide dispute
        uint256 ruling;        // 0 unset…ruling enum above
        bool ruled;
        bool exists;
    }
    mapping(uint256 => Case) public cases;   // arbitrator disputeID -> case

    modifier onlyArbitrator() {
        require(msg.sender == address(arbitrator), "not arbitrator");
        _;
    }
    modifier onlyGovernor() {
        require(msg.sender == governor, "not governor");
        _;
    }

    constructor(address _arbitrator, string memory _metaEvidenceURI) {
        arbitrator = IArbitrator(_arbitrator);
        governor = msg.sender;
        metaEvidenceURI = _metaEvidenceURI;
        evidenceGroupID = uint256(keccak256(abi.encodePacked(address(this), "evidence")));
    }

    /// @notice Open a Kleros dispute bound to a NEAR market claim.
    ///         Caller pays arbitration cost (juror fees). 4 choices.
    function openDispute(string calldata marketId, string calldata claimId)
        external payable returns (uint256 disputeID)
    {
        uint256 cost = arbitrator.arbitrationCost("");
        require(msg.value >= cost, "below arbitration cost");
        disputeID = arbitrator.createDispute{value: cost}(4, "");
        cases[disputeID] = Case(marketId, claimId, 0, false, true);
        emit DisputeCreation(disputeID, metaEvidenceID);
        emit Bound(disputeID, marketId, claimId);
        if (msg.value > cost) {
            (bool ok, ) = payable(msg.sender).call{value: msg.value - cost}("");
            require(ok, "refund failed");
        }
    }

    /// @notice Submit an evidence URI (IPFS) — the Kleros Evidence standard
    ///         bundle the bridge emits at /api/disputes/bundle.
    function submitEvidence(uint256 disputeID, string calldata evidenceURI) external {
        require(cases[disputeID].exists, "no case");
        emit Evidence(disputeID, evidenceGroupID, msg.sender, evidenceURI);
    }

    /// @notice Court callback — records the winning choice.
    function rule(uint256 disputeID, uint256 ruling) external onlyArbitrator {
        require(cases[disputeID].exists, "no case");
        cases[disputeID].ruling = ruling;
        cases[disputeID].ruled = true;
        emit Ruling(disputeID, ruling);
    }

    /// @notice The relayer's read: map a Kleros ruling to the NEAR ruling name.
    /// @return rulingName NEAR-side resolveDispute arg or "" if unruled/invalid.
    function nearRuling(uint256 disputeID) external view returns (string memory rulingName) {
        Case storage c = cases[disputeID];
        if (!c.ruled) return "";
        if (c.ruling == 1) return "pay_claim";
        if (c.ruling == 2) return "reject_claim";
        if (c.ruling == 3) return "refund";
        return "dismiss";        // 0 or any out-of-range ruling
    }

    function setArbitrator(address _a) external onlyGovernor { arbitrator = IArbitrator(_a); }
    function setGovernor(address _g) external onlyGovernor { governor = _g; }
}
