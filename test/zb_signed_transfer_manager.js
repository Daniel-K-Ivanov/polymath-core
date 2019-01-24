import latestTime from "./helpers/latestTime";
import { duration, promisifyLogWatch, latestBlock } from "./helpers/utils";
import takeSnapshot, { increaseTime, revertToSnapshot } from "./helpers/time";
import { signDataVerifyTransfer } from "./helpers/signData";
import { pk } from "./helpers/testprivateKey";
import { encodeProxyCall, encodeModuleCall } from "./helpers/encodeCall";
import { catchRevert } from "./helpers/exceptions";
import { setUpPolymathNetwork, deployGPMAndVerifyed, deployDummySTOAndVerifyed, deploySignedTMAndVerifyed} from "./helpers/createInstances";

const DummySTO = artifacts.require("./DummySTO.sol");
const SecurityToken = artifacts.require("./SecurityToken.sol");
const GeneralTransferManager = artifacts.require("./GeneralTransferManager");
const GeneralPermissionManager = artifacts.require("./GeneralPermissionManager");
const SignedTransferManager = artifacts.require("./SignedTransferManager");

const Web3 = require("web3");
const BigNumber = require("bignumber.js");
let BN = Web3.utils.BN;
const web3 = new Web3(new Web3.providers.HttpProvider("http://localhost:8545")); // Hardcoded development port

contract("SignedTransferManager", accounts => {
    // Accounts Variable declaration
    let account_polymath;
    let account_issuer;
    let token_owner;
    let token_owner_pk;
    let account_investor1;
    let account_investor2;
    let account_investor3;
    let account_investor4;

    // investor Details
    let fromTime = latestTime();
    let toTime = latestTime();
    let expiryTime = toTime + duration.days(15);

    let message = "Transaction Should Fail!";

    // Contract Instance Declaration
    let I_GeneralPermissionManagerFactory;
    let I_GeneralTransferManagerFactory;
    let I_SecurityTokenRegistryProxy;
    let I_GeneralPermissionManager;
    let I_GeneralTransferManager;
    let I_ModuleRegistryProxy;
    let I_ModuleRegistry;
    let I_FeatureRegistry;
    let I_SecurityTokenRegistry;
    let I_DummySTOFactory;
    let I_STFactory;
    let I_SecurityToken;
    let I_STRProxied;
    let I_MRProxied;
    let I_DummySTO;
    let I_PolyToken;
    let I_PolymathRegistry;
    let I_SignedTransferManagerFactory;
    let P_SignedTransferManagerFactory;
    let I_SignedTransferManager;

    // SecurityToken Details
    const name = "Team";
    const symbol = "sap";
    const tokenDetails = "This is equity type of issuance";
    const decimals = 18;
    const contact = "team@polymath.network";

    // Module key
    const delegateManagerKey = 1;
    const transferManagerKey = 2;
    const stoKey = 3;

    // Initial fee for ticker registry and security token registry
    const initRegFee = web3.utils.toWei("250");

    // Dummy STO details
    const startTime = latestTime() + duration.seconds(5000); // Start time will be 5000 seconds more than the latest time
    const endTime = startTime + duration.days(80); // Add 80 days more
    const cap = web3.utils.toWei("10", "ether");
    const someString = "A string which is not used";
    const STOParameters = ["uint256", "uint256", "uint256", "string"];

    let currentTime;

    before(async () => {
        // Accounts setup
        currentTime = new BN(await latestTime());
        account_polymath = accounts[0];
        account_issuer = accounts[1];

        token_owner = account_issuer;
        token_owner_pk = pk.account_1;

        account_investor1 = accounts[8];
        account_investor2 = accounts[9];
        account_investor3 = accounts[6];
        account_investor4 = accounts[7];

        // Step 1: Deploy the genral PM ecosystem
        let instances = await setUpPolymathNetwork(account_polymath, token_owner);

        [
            I_PolymathRegistry,
            I_PolyToken,
            I_FeatureRegistry,
            I_ModuleRegistry,
            I_ModuleRegistryProxy,
            I_MRProxied,
            I_GeneralTransferManagerFactory,
            I_STFactory,
            I_SecurityTokenRegistry,
            I_SecurityTokenRegistryProxy,
            I_STRProxied
        ] = instances;

        // STEP 2: Deploy the GeneralPermissionManagerFactory
        [I_GeneralPermissionManagerFactory] = await deployGPMAndVerifyed(account_polymath, I_MRProxied, I_PolyToken.address, 0);
        // STEP 3: Deploy the SignedTransferManagerFactory
        [I_SignedTransferManagerFactory] = await deploySignedTMAndVerifyed(account_polymath, I_MRProxied, I_PolyToken.address, 0);
        // STEP 4: Deploy the Paid SignedTransferManagerFactory
        [P_SignedTransferManagerFactory] = await deploySignedTMAndVerifyed(account_polymath, I_MRProxied, I_PolyToken.address, web3.utils.toWei("500", "ether"));

        // Printing all the contract addresses
        console.log(`
        --------------------- Polymath Network Smart Contracts: ---------------------
        PolymathRegistry:                  ${I_PolymathRegistry.address}
        SecurityTokenRegistryProxy:        ${I_SecurityTokenRegistryProxy.address}
        SecurityTokenRegistry:             ${I_SecurityTokenRegistry.address}
        ModuleRegistryProxy:               ${I_ModuleRegistryProxy.address}
        ModuleRegistry:                    ${I_ModuleRegistry.address}
        FeatureRegistry:                   ${I_FeatureRegistry.address}

        ManualApprovalTransferManagerFactory: ${I_SignedTransferManagerFactory.address}
        

        -----------------------------------------------------------------------------
        `);
    });

 describe("Generate the SecurityToken", async () => {
        it("Should register the ticker before the generation of the security token", async () => {
            await I_PolyToken.approve(I_STRProxied.address, initRegFee, { from: token_owner });
            let tx = await I_STRProxied.registerTicker(token_owner, symbol, contact, { from: token_owner });
            assert.equal(tx.logs[0].args._owner, token_owner);
            assert.equal(tx.logs[0].args._ticker, symbol.toUpperCase());
        });

        it("Should generate the new security token with the same symbol as registered above", async () => {
            await I_PolyToken.approve(I_STRProxied.address, initRegFee, { from: token_owner });
            
            let tx = await I_STRProxied.generateSecurityToken(name, symbol, tokenDetails, false, { from: token_owner });

            // Verify the successful generation of the security token
            assert.equal(tx.logs[2].args._ticker, symbol.toUpperCase(), "SecurityToken doesn't get deployed");

            I_SecurityToken = await SecurityToken.at(tx.logs[2].args._securityTokenAddress);

            const log = (await I_SecurityToken.getPastEvents('ModuleAdded', {filter: {transactionHash: tx.transactionHash}}))[0];

            // Verify that GeneralTransferManager module get added successfully or not
            assert.equal(log.args._types[0].toNumber(), 2);
            assert.equal(web3.utils.toAscii(log.args._name).replace(/\u0000/g, ""), "GeneralTransferManager");
        });

        it("Should intialize the auto attached modules", async () => {
            let moduleData = (await I_SecurityToken.getModulesByType(2))[0];
            I_GeneralTransferManager = await GeneralTransferManager.at(moduleData);
        });
    });


    describe("signed transfer manager tests", async () => {

        it("Should Buy the tokens", async () => {
            // Add the Investor in to the whitelist

            let tx = await I_GeneralTransferManager.modifyWhitelist(
                account_investor1,
                currentTime,
                currentTime,
                currentTime.add(new BN(duration.days(10))),
                true,
                {
                    from: account_issuer
                }
            );

            assert.equal(
                tx.logs[0].args._investor.toLowerCase(),
                account_investor1.toLowerCase(),
                "Failed in adding the investor in whitelist"
            );

            // Jump time
            await increaseTime(5000);

            // Mint some tokens
            await I_SecurityToken.mint(account_investor1, new BN(web3.utils.toWei("2", "ether")), { from: token_owner });

            assert.equal((await I_SecurityToken.balanceOf(account_investor1)).toString(), new BN(web3.utils.toWei("2", "ether")).toString());
        });


        it("Should successfully attach the SignedTransferManager with the security token", async () => {
            const tx = await I_SecurityToken.addModule(I_SignedTransferManagerFactory.address, new BN(0),new BN(0),new BN(0), { from: token_owner });
            assert.equal(tx.logs[2].args._types[0].toNumber(), transferManagerKey, "SignedTransferManager doesn't get deployed");
            assert.equal(
                web3.utils.toUtf8(tx.logs[2].args._name),
                "SignedTransferManager",
                "SignedTransferManager module was not added"
            );
            console.log(tx.logs[2].args);
            I_SignedTransferManager = await SignedTransferManager.at(tx.logs[2].args._module);
        });

        it("should fail to transfer because transaction is not verified yet.", async () => {
            await catchRevert(I_SecurityToken.transfer(account_investor2, web3.utils.toWei("1", "ether"), { from: account_investor1 }));
        });

        it("should successfully add multiple signers to signersList", async () => {
            await I_SignedTransferManager.updateSigners([account_investor3, account_investor4, token_owner], [true, true, true], {from: token_owner});

            assert.equal(await I_SignedTransferManager.signers(account_investor3), true);
            assert.equal(await I_SignedTransferManager.signers(account_investor4), true);
            assert.equal(await I_SignedTransferManager.signers(token_owner), true);
        });

        it("should fail to change signers stats without permission", async () => {
            await catchRevert(I_SignedTransferManager.updateSigners([account_investor3], [false], {from: account_investor2}));
        });


        it("should be able to invalid siganture if sender is the signer and is in the signer list", async () => {
            
            console.log("1");

            const sig = await signDataVerifyTransfer(
                I_SignedTransferManager.address,
                account_investor1,
                account_investor2,
                web3.utils.toWei("2", "ether"),
                token_owner
            );

            console.log("token owner is "+ token_owner);
            console.log(sig);

            await I_SignedTransferManager.invalidSignature(account_investor1, account_investor2, web3.utils.toWei("2", "ether"), sig, {from: token_owner});
            console.log("sd");
            assert.equal(await I_SignedTransferManager.checkSignatureIsInvalid(sig), true);
        });

        it("should allow transfer with valid sig", async () => {

            console.log("owner is a signer status is " + await I_SignedTransferManager.signers(token_owner, {from: token_owner}));

            const sig = await signDataVerifyTransfer(
                I_SignedTransferManager.address,
                account_investor1,
                account_investor2,
                web3.utils.toWei("1", "ether"),
                token_owner
            );

            // let tx = await I_SignedTransferManager.verifyTransfer(account_investor1, account_investor2, web3.utils.toWei("1", "ether"), sig, false, {from: token_owner});
            console.log("owner token balance is " + (await I_SecurityToken.balanceOf(account_investor1)).toNumber());
            console.log("is this sig invalid?"+ await I_SignedTransferManager.checkSignatureIsInvalid(sig));
            
            // test call security token transfer function
            let tx = await I_SecurityToken.transferWithData(account_investor2, web3.utils.toWei("1", "ether"), sig, {from: account_investor1});
            console.log("3");
            assert.equal(await I_SignedTransferManager.checkSignatureIsInvalid(sig), true);
        });

        it("should not allow transfer if the sig is already used", async () => {
            const sig = await signDataVerifyTransfer(
                 I_SignedTransferManager.address,
                 account_investor1,
                 account_investor2,
                 web3.utils.toWei("1", "ether"),
                 token_owner
             );
 
             console.log("2");
 
             await catchRevert (I_SignedTransferManager.verifyTransfer(account_investor1, account_investor2, web3.utils.toWei("1", "ether"), sig, false, {from: token_owner}));
        });

        it("should not allow transfer if the signer is not on the signer list", async () => {
           const sig = await signDataVerifyTransfer(
                I_SignedTransferManager.address,
                account_investor1,
                account_investor2,
                web3.utils.toWei("1", "ether"),
                account_investor2
            );

            let tx = await I_SignedTransferManager.verifyTransfer.call(account_investor1, account_investor2, web3.utils.toWei("1", "ether"), sig, false, {from: token_owner});
            console.log("output is "+tx.toNumber());
           
        });

    });
});

