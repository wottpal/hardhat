import { Common } from "@ethereumjs/common";
import { TxData, TypedTransaction } from "@ethereumjs/tx";
import { assert } from "chai";
import { Address, bufferToHex, toBuffer } from "@ethereumjs/util";
import { ethers } from "ethers";
import sinon from "sinon";

import { defaultHardhatNetworkParams } from "../../../../src/internal/core/config/default-config";
import { HardhatNode } from "../../../../src/internal/hardhat-network/provider/node";
import {
  ForkedNodeConfig,
  NodeConfig,
  RunCallResult,
} from "../../../../src/internal/hardhat-network/provider/node-types";
import { FakeSenderTransaction } from "../../../../src/internal/hardhat-network/provider/transactions/FakeSenderTransaction";
import { getCurrentTimestampBigInt } from "../../../../src/internal/hardhat-network/provider/utils/getCurrentTimestamp";
import { HardforkName } from "../../../../src/internal/util/hardforks";
import {
  HardhatNetworkChainConfig,
  HardhatNetworkChainsConfig,
} from "../../../../src/types";
import { ALCHEMY_URL } from "../../../setup";
import { assertQuantity } from "../helpers/assertions";
import {
  EMPTY_ACCOUNT_ADDRESS,
  FORK_TESTS_CACHE_PATH,
} from "../helpers/constants";
import { expectErrorAsync } from "../../../helpers/errors";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_ACCOUNTS_ADDRESSES,
  DEFAULT_BLOCK_GAS_LIMIT,
  DEFAULT_CHAIN_ID,
  DEFAULT_HARDFORK,
  DEFAULT_NETWORK_ID,
  DEFAULT_NETWORK_NAME,
} from "../helpers/providers";
import { runFullBlock } from "./utils/runFullBlock";

interface ForkedBlock {
  networkName: string;
  url: string;
  blockToRun: bigint;
  chainId: number;
}

export function cloneChainsConfig(
  source: HardhatNetworkChainsConfig
): HardhatNetworkChainsConfig {
  const clone: HardhatNetworkChainsConfig = new Map();
  source.forEach(
    (sourceChainConfig: HardhatNetworkChainConfig, chainId: number) => {
      const clonedChainConfig = { ...sourceChainConfig };
      clonedChainConfig.hardforkHistory = new Map(
        sourceChainConfig.hardforkHistory
      );
      clone.set(chainId, clonedChainConfig);
    }
  );
  return clone;
}

describe("HardhatNode", () => {
  const config: NodeConfig = {
    automine: false,
    hardfork: DEFAULT_HARDFORK,
    networkName: DEFAULT_NETWORK_NAME,
    chainId: DEFAULT_CHAIN_ID,
    networkId: DEFAULT_NETWORK_ID,
    blockGasLimit: DEFAULT_BLOCK_GAS_LIMIT,
    minGasPrice: 0n,
    genesisAccounts: DEFAULT_ACCOUNTS,
    initialBaseFeePerGas: 10n,
    mempoolOrder: "priority",
    coinbase: "0x0000000000000000000000000000000000000000",
    chains: defaultHardhatNetworkParams.chains,
  };
  const gasPrice = 20;
  let node: HardhatNode;
  let createTestTransaction: (
    txData: TxData & { from: string }
  ) => FakeSenderTransaction;

  beforeEach(async () => {
    [, node] = await HardhatNode.create(config);
    createTestTransaction = (txData) => {
      const tx = new FakeSenderTransaction(Address.fromString(txData.from), {
        gasPrice,
        ...txData,
      });
      tx.hash();
      return tx;
    };
  });

  describe("getPendingTransactions", () => {
    it("returns both pending and queued transactions from TxPool", async () => {
      const tx1 = createTestTransaction({
        nonce: 0,
        from: DEFAULT_ACCOUNTS_ADDRESSES[0],
        to: EMPTY_ACCOUNT_ADDRESS,
        gasLimit: 21_000,
      });
      const tx2 = createTestTransaction({
        nonce: 2,
        from: DEFAULT_ACCOUNTS_ADDRESSES[0],
        to: EMPTY_ACCOUNT_ADDRESS,
        gasLimit: 21_000,
      });
      const tx3 = createTestTransaction({
        nonce: 3,
        from: DEFAULT_ACCOUNTS_ADDRESSES[0],
        to: EMPTY_ACCOUNT_ADDRESS,
        gasLimit: 21_000,
      });

      await node.sendTransaction(tx1);
      await node.sendTransaction(tx2);
      await node.sendTransaction(tx3);

      const nodePendingTxs = await node.getPendingTransactions();

      assert.sameDeepMembers(
        nodePendingTxs.map((tx) => tx.raw),
        [tx1, tx2, tx3].map((tx) => tx.raw)
      );
    });
  });

  describe("mineBlock", () => {
    async function assertTransactionsWereMined(txs: TypedTransaction[]) {
      for (const tx of txs) {
        const txReceipt = await node.getTransactionReceipt(tx.hash());
        assert.isDefined(txReceipt);
      }

      const block = await node.getLatestBlock();
      assert.lengthOf(block.transactions, txs.length);
      assert.deepEqual(
        block.transactions.map((tx) => bufferToHex(tx.hash())),
        txs.map((tx) => bufferToHex(tx.hash()))
      );
    }

    describe("basic tests", () => {
      it("can mine an empty block", async () => {
        const beforeBlock = node.getLatestBlockNumber();
        await node.mineBlock();
        const currentBlock = node.getLatestBlockNumber();
        assert.equal(currentBlock.toString(), (beforeBlock + 1n).toString());
      });

      it("can mine a block with one transaction", async () => {
        const tx = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx);
        await node.mineBlock();

        await assertTransactionsWereMined([tx]);
        const balance = await node.getAccountBalance(EMPTY_ACCOUNT_ADDRESS);
        assert.equal(balance.toString(), "1234");
      });

      it("can mine a block with two transactions from different senders", async () => {
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        const tx2 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1, tx2]);
        const balance = await node.getAccountBalance(EMPTY_ACCOUNT_ADDRESS);
        assert.equal(balance.toString(), "2468");
      });

      it("can keep the transaction ordering when mining a block", async () => {
        [, node] = await HardhatNode.create({
          ...config,
          mempoolOrder: "fifo",
        });

        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
          gasPrice: 42,
        });
        const tx2 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
          gasPrice: 84,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        const txReceipt1 = await node.getTransactionReceipt(tx1.hash());
        const txReceipt2 = await node.getTransactionReceipt(tx2.hash());

        assert.equal(txReceipt1?.transactionIndex, "0x0");
        assert.equal(txReceipt2?.transactionIndex, "0x1");
      });

      it("can mine a block with two transactions from the same sender", async () => {
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1, tx2]);
        const balance = await node.getAccountBalance(EMPTY_ACCOUNT_ADDRESS);
        assert.equal(balance.toString(), "2468");
      });

      it("removes the mined transaction from the tx pool", async () => {
        const tx = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx);

        const pendingTransactionsBefore = await node.getPendingTransactions();
        assert.lengthOf(pendingTransactionsBefore, 1);

        await node.mineBlock();

        const pendingTransactionsAfter = await node.getPendingTransactions();
        assert.lengthOf(pendingTransactionsAfter, 0);
      });

      it("leaves the transactions in the tx pool that did not fit in a block", async () => {
        await node.setBlockGasLimit(55_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        const expensiveTx2 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 40_000,
        });
        const tx3 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(expensiveTx2);
        await node.sendTransaction(tx3);

        const pendingTransactionsBefore = await node.getPendingTransactions();
        assert.sameDeepMembers(
          pendingTransactionsBefore.map((tx) => tx.raw),
          [tx1, expensiveTx2, tx3].map((tx) => tx.raw)
        );

        await node.mineBlock();
        await assertTransactionsWereMined([tx1, tx3]);

        const pendingTransactionsAfter = await node.getPendingTransactions();
        assert.sameDeepMembers(
          pendingTransactionsAfter.map((tx) => tx.raw),
          [expensiveTx2.raw]
        );
      });

      it("sets correct gasUsed values", async () => {
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 100_000,
          value: 1234,
        });
        const tx2 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 100_000,
          value: 1234,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        const tx1Receipt = await node.getTransactionReceipt(tx1.hash());
        const tx2Receipt = await node.getTransactionReceipt(tx2.hash());
        assertQuantity(tx1Receipt?.gasUsed, 21_000);
        assertQuantity(tx2Receipt?.gasUsed, 21_000);

        const block = await node.getLatestBlock();
        assert.equal(block.header.gasUsed, 42_000n);
      });

      it("assigns miner rewards", async () => {
        const gasPriceBN = 1n;

        let baseFeePerGas = 0n;
        const pendingBlock = await node.getBlockByNumber("pending");
        if (pendingBlock.header.baseFeePerGas !== undefined) {
          baseFeePerGas = pendingBlock.header.baseFeePerGas;
        }

        const miner = node.getCoinbaseAddress();
        const initialMinerBalance = await node.getAccountBalance(miner);

        const oneEther = 10n ** 18n;
        const txFee = (gasPriceBN + baseFeePerGas) * 21_000n;
        const burnedTxFee = baseFeePerGas * 21_000n;

        // the miner reward is 2 ETH plus the tx fee, minus the part
        // of the fee that is burned
        const minerReward = 2n * oneEther + txFee - burnedTxFee;

        const tx = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasPrice: gasPriceBN + baseFeePerGas,
          gasLimit: 21_000,
          value: 1234,
        });
        await node.sendTransaction(tx);
        await node.mineBlock();

        const minerBalance = await node.getAccountBalance(miner);
        assert.equal(minerBalance, initialMinerBalance + minerReward);
      });
    });

    describe("gas limit tests", () => {
      it("mines only as many transactions as would fit in a block", async () => {
        await node.setBlockGasLimit(30_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1]);
        assert.isUndefined(await node.getTransactionReceipt(tx2.hash()));
      });

      it("uses gasLimit value for determining if a new transaction will fit in a block (1 fits)", async () => {
        await node.setBlockGasLimit(50_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1]);
        assert.isUndefined(await node.getTransactionReceipt(tx2.hash()));
      });

      it("uses gasLimit value for determining if a new transaction will fit in a block (2 fit)", async () => {
        // here the first tx is added, and it uses 21_000 gas
        // this leaves 31_000 of gas in the block, so the second one is also included
        await node.setBlockGasLimit(52_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1, tx2]);
      });

      it("uses the rest of the txs when one is dropped because of its gas limit", async () => {
        await node.setBlockGasLimit(50_000);
        const tx1 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
          gasPrice: 40,
        });
        const tx2 = createTestTransaction({
          nonce: 1,
          from: DEFAULT_ACCOUNTS_ADDRESSES[0],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 30_000, // actual gas used is 21_000
          gasPrice: 40,
        });
        const tx3 = createTestTransaction({
          nonce: 0,
          from: DEFAULT_ACCOUNTS_ADDRESSES[1],
          to: EMPTY_ACCOUNT_ADDRESS,
          gasLimit: 21_000,
          gasPrice: 20,
        });
        await node.sendTransaction(tx1);
        await node.sendTransaction(tx2);
        await node.sendTransaction(tx3);
        await node.mineBlock();

        await assertTransactionsWereMined([tx1, tx3]);
        assert.isUndefined(await node.getTransactionReceipt(tx2.hash()));
      });
    });

    describe("timestamp tests", () => {
      let clock: sinon.SinonFakeTimers;

      const assertIncreaseTime = async (expectedTime: bigint) => {
        const block = await node.getLatestBlock();
        const blockTimestamp = block.header.timestamp;

        // We check that the time increased at least what we had expected
        // but allow a little bit of POSITIVE difference(i.e. that the
        // actual timestamp is a little bit bigger) because time may have ellapsed
        // We assume that the test CAN NOT have taken more than a second
        assert.isTrue(blockTimestamp >= expectedTime);
        assert.isTrue(blockTimestamp <= expectedTime + 1n);
      };

      beforeEach(() => {
        clock = sinon.useFakeTimers(Date.now());
      });

      afterEach(() => {
        clock.restore();
      });

      it("mines a block with the current timestamp", async () => {
        clock.tick(15_000);
        const now = getCurrentTimestampBigInt();

        await node.mineBlock();
        const block = await node.getLatestBlock();

        assert.equal(block.header.timestamp, now);
      });

      it("mines a block with an incremented timestamp if it clashes with the previous block", async () => {
        const firstBlock = await node.getLatestBlock();
        const firstBlockTimestamp = firstBlock.header.timestamp;

        await node.mineBlock();
        const latestBlock = await node.getLatestBlock();
        const latestBlockTimestamp = latestBlock.header.timestamp;

        assert.equal(latestBlockTimestamp, firstBlockTimestamp + 1n);
      });

      it("assigns an incremented timestamp to each new block mined within the same second", async () => {
        const firstBlock = await node.getLatestBlock();
        const firstBlockTimestamp = firstBlock.header.timestamp;

        await node.mineBlock();
        const secondBlock = await node.getLatestBlock();
        const secondBlockTimestamp = secondBlock.header.timestamp;

        await node.mineBlock();
        const thirdBlock = await node.getLatestBlock();
        const thirdBlockTimestamp = thirdBlock.header.timestamp;

        assert.equal(secondBlockTimestamp, firstBlockTimestamp + 1n);
        assert.equal(thirdBlockTimestamp, secondBlockTimestamp + 1n);
      });

      it("mines a block with a preset timestamp", async () => {
        const now = getCurrentTimestampBigInt();
        const timestamp = BigInt(now) + 30n;
        node.setNextBlockTimestamp(timestamp);
        await node.mineBlock();

        const block = await node.getLatestBlock();
        const blockTimestamp = block.header.timestamp;
        assert.equal(blockTimestamp, timestamp);
      });

      it("mines the next block normally after a block with preset timestamp", async () => {
        const now = getCurrentTimestampBigInt();
        const timestamp = BigInt(now) + 30n;
        node.setNextBlockTimestamp(timestamp);
        await node.mineBlock();

        clock.tick(3_000);
        await node.mineBlock();

        const block = await node.getLatestBlock();
        const blockTimestamp = block.header.timestamp;
        assert.equal(blockTimestamp, timestamp + 3n);
      });

      it("mines a block with the timestamp passed as a parameter irrespective of the preset timestamp", async () => {
        const now = getCurrentTimestampBigInt();
        const presetTimestamp = BigInt(now) + 30n;
        node.setNextBlockTimestamp(presetTimestamp);
        const timestamp = BigInt(now) + 60n;
        await node.mineBlock(timestamp);

        const block = await node.getLatestBlock();
        const blockTimestamp = block.header.timestamp;
        assert.equal(blockTimestamp, timestamp);
      });

      it("mines a block with correct timestamp after time increase", async () => {
        const now = getCurrentTimestampBigInt();
        const delta = 30n;
        node.increaseTime(delta);
        await node.mineBlock();

        await assertIncreaseTime(now + delta);
      });

      it("mining a block having increaseTime called twice counts both calls", async () => {
        const now = getCurrentTimestampBigInt();
        const delta = 30n;
        node.increaseTime(delta);
        node.increaseTime(delta);
        await node.mineBlock();
        await assertIncreaseTime(now + 2n * delta);
      });

      it("mining a block having called increaseTime takes into account 'real' passing time", async () => {
        const now = getCurrentTimestampBigInt();
        const delta = 30n;
        const elapsedTimeInSeconds = 3n;
        node.increaseTime(delta);
        clock.tick(Number(elapsedTimeInSeconds * 1_000n));
        await node.mineBlock();

        await assertIncreaseTime(now + delta + elapsedTimeInSeconds);
      });

      describe("when time is increased by 30s", () => {
        function testPresetTimestamp(offset: bigint) {
          it("mines a block with the preset timestamp", async () => {
            const now = getCurrentTimestampBigInt();
            const timestamp = BigInt(now + offset);
            node.increaseTime(30n);
            node.setNextBlockTimestamp(timestamp);
            await node.mineBlock();

            const block = await node.getLatestBlock();
            const blockTimestamp = block.header.timestamp;
            assert.equal(blockTimestamp, timestamp);
          });

          it("mining a block with a preset timestamp changes the time offset", async () => {
            const now = getCurrentTimestampBigInt();
            const timestamp = BigInt(now + offset);
            node.increaseTime(30n);
            node.setNextBlockTimestamp(timestamp);
            await node.mineBlock();

            clock.tick(3_000);
            await node.mineBlock();

            const block = await node.getLatestBlock();
            const blockTimestamp = block.header.timestamp;
            assert.equal(blockTimestamp, timestamp + 3n);
          });
        }

        describe("when preset timestamp is 20s into the future", () => {
          testPresetTimestamp(20n);
        });

        describe("when preset timestamp is 40s into the future", () => {
          testPresetTimestamp(40n);
        });
      });
    });
  });

  describe("full block", function () {
    if (ALCHEMY_URL === undefined) {
      return;
    }

    const forkedBlocks: ForkedBlock[] = [
      // We don't run this test against spurious dragon because
      // its receipts contain the state root, and we can't compute it
      {
        networkName: "mainnet",
        url: ALCHEMY_URL,
        blockToRun: 4370001n,
        chainId: 1,
      },
      {
        networkName: "mainnet",
        url: ALCHEMY_URL,
        blockToRun: 7280001n,
        chainId: 1,
      },
      {
        networkName: "mainnet",
        url: ALCHEMY_URL,
        blockToRun: 9069001n,
        chainId: 1,
      },
      {
        networkName: "mainnet",
        url: ALCHEMY_URL,
        blockToRun: 9300077n,
        chainId: 1,
      },
      {
        networkName: "kovan",
        url: ALCHEMY_URL.replace("mainnet", "kovan"),
        blockToRun: 23115227n,
        chainId: 42,
      },
      {
        networkName: "rinkeby",
        url: ALCHEMY_URL.replace("mainnet", "rinkeby"),
        blockToRun: 8004365n,
        chainId: 4,
      },
      {
        networkName: "ropsten",
        url: ALCHEMY_URL.replace("mainnet", "ropsten"),
        blockToRun: 9812365n, // this block has a EIP-2930 tx
        chainId: 3,
      },
      {
        networkName: "ropsten",
        url: ALCHEMY_URL.replace("mainnet", "ropsten"),
        blockToRun: 10499406n, // this block has a EIP-1559 tx
        chainId: 3,
      },
    ];

    for (const { url, blockToRun, networkName, chainId } of forkedBlocks) {
      const remoteCommon = new Common({ chain: chainId });
      const hardfork = remoteCommon.getHardforkByBlockNumber(blockToRun);

      it(`should run a ${networkName} block from ${hardfork} and produce the same results`, async function () {
        this.timeout(240000);

        await runFullBlock(url, blockToRun, chainId, hardfork);
      });
    }
  });

  describe("mineBlocks", function () {
    it("shouldn't break getLatestBlock()", async function () {
      const previousLatestBlockNumber = node.getLatestBlockNumber();
      await node.mineBlocks(10n);
      const latestBlock = await node.getLatestBlock();
      assert.equal(latestBlock.header.number, previousLatestBlockNumber + 10n);
    });

    it("shouldn't break getLatestBlockNumber()", async function () {
      const previousLatestBlockNumber = node.getLatestBlockNumber();
      await node.mineBlocks(10n);
      const latestBlockNumber = node.getLatestBlockNumber();
      assert.equal(latestBlockNumber, previousLatestBlockNumber + 10n);
    });

    describe("shouldn't break snapshotting", async function () {
      it("when doing mineBlocks() before a snapshot", async function () {
        await node.mineBlocks(10n);

        const latestBlockNumberBeforeSnapshot = node.getLatestBlockNumber();

        const snapshotId = await node.takeSnapshot();
        await node.sendTransaction(
          createTestTransaction({
            from: DEFAULT_ACCOUNTS_ADDRESSES[1],
            to: Address.fromString(
              "0x1111111111111111111111111111111111111111"
            ),
            gasLimit: 21000,
          })
        );
        await node.mineBlocks(1n);

        await node.revertToSnapshot(snapshotId);

        assert.equal(
          node.getLatestBlockNumber().toString(),
          latestBlockNumberBeforeSnapshot.toString()
        );
      });

      it("when doing mineBlocks() after a snapshot", async function () {
        const originalLatestBlockNumber = node.getLatestBlockNumber();
        await node.sendTransaction(
          createTestTransaction({
            from: DEFAULT_ACCOUNTS_ADDRESSES[1],
            to: Address.fromString(
              "0x1111111111111111111111111111111111111111"
            ),
            gasLimit: 21000,
          })
        );

        const latestBlockNumberBeforeSnapshot = node.getLatestBlockNumber();
        assert.equal(
          latestBlockNumberBeforeSnapshot.toString(),
          originalLatestBlockNumber.toString()
        );

        const snapshotId = await node.takeSnapshot();
        assert.equal(
          node.getLatestBlockNumber().toString(),
          originalLatestBlockNumber.toString()
        );

        await node.mineBlocks(10n);
        assert.equal(
          node.getLatestBlockNumber(),
          latestBlockNumberBeforeSnapshot + 10n
        );

        await node.revertToSnapshot(snapshotId);

        assert.equal(
          node.getLatestBlockNumber().toString(),
          latestBlockNumberBeforeSnapshot.toString()
        );
      });
    });
  });

  /** execute a call to method Hello() on contract HelloWorld, deployed to
   * mainnet years ago, which should return a string, "Hello World". */
  async function runCall(
    gasParams: { gasPrice?: bigint; maxFeePerGas?: bigint },
    block: bigint,
    targetNode: HardhatNode
  ): Promise<string> {
    const contractInterface = new ethers.utils.Interface([
      "function Hello() public pure returns (string)",
    ]);

    const callOpts = {
      to: toBuffer("0xe36613A299bA695aBA8D0c0011FCe95e681f6dD3"),
      from: toBuffer(DEFAULT_ACCOUNTS_ADDRESSES[0]),
      value: 0n,
      data: toBuffer(contractInterface.encodeFunctionData("Hello", [])),
      gasLimit: 1_000_000n,
    };

    function decodeResult(runCallResult: RunCallResult) {
      return contractInterface.decodeFunctionResult(
        "Hello",
        bufferToHex(runCallResult.result.value)
      )[0];
    }

    return decodeResult(
      await targetNode.runCall({ ...callOpts, ...gasParams }, BigInt(block))
    );
  }

  describe("should run calls in the right hardfork context", async function () {
    this.timeout(10000);
    before(function () {
      if (ALCHEMY_URL === undefined) {
        this.skip();
        return;
      }
    });

    const eip1559ActivationBlock = 12965000n;
    // some shorthand for code below:
    const post1559Block = eip1559ActivationBlock;
    const blockBefore1559 = eip1559ActivationBlock - 1n;
    const pre1559GasOpts = { gasPrice: 0n };
    const post1559GasOpts = { maxFeePerGas: 0n };

    const baseNodeConfig: ForkedNodeConfig = {
      automine: true,
      networkName: "mainnet",
      chainId: 1,
      networkId: 1,
      hardfork: "london",
      forkConfig: {
        jsonRpcUrl: ALCHEMY_URL!,
        blockNumber: eip1559ActivationBlock,
      },
      forkCachePath: FORK_TESTS_CACHE_PATH,
      blockGasLimit: 1_000_000n,
      minGasPrice: 0n,
      genesisAccounts: [],
      chains: defaultHardhatNetworkParams.chains,
      mempoolOrder: "priority",
      coinbase: "0x0000000000000000000000000000000000000000",
    };

    describe("when forking with a default hardfork activation history", function () {
      let hardhatNode: HardhatNode;

      before(async function () {
        [, hardhatNode] = await HardhatNode.create(baseNodeConfig);
      });

      it("should accept post-EIP-1559 gas semantics when running in the context of a post-EIP-1559 block", async function () {
        assert.equal(
          "Hello World",
          await runCall(post1559GasOpts, post1559Block, hardhatNode)
        );
      });

      it("should accept pre-EIP-1559 gas semantics when running in the context of a pre-EIP-1559 block", async function () {
        assert.equal(
          "Hello World",
          await runCall(pre1559GasOpts, blockBefore1559, hardhatNode)
        );
      });

      it("should throw when given post-EIP-1559 gas semantics and when running in the context of a pre-EIP-1559 block", async function () {
        await expectErrorAsync(async () => {
          assert.equal(
            "Hello World",
            await runCall(post1559GasOpts, blockBefore1559, hardhatNode)
          );
        }, /Cannot run transaction: EIP 1559 is not activated./);
      });

      it("should accept pre-EIP-1559 gas semantics when running in the context of a post-EIP-1559 block", async function () {
        assert.equal(
          "Hello World",
          await runCall(pre1559GasOpts, post1559Block, hardhatNode)
        );
      });
    });

    describe("when forking with a hardfork activation history that indicates London happened one block early", function () {
      let nodeWithEarlyLondon: HardhatNode;

      before(async function () {
        const nodeConfig = {
          ...baseNodeConfig,
          chains: cloneChainsConfig(baseNodeConfig.chains),
        };

        const chainConfig = nodeConfig.chains.get(1) ?? {
          hardforkHistory: new Map(),
        };
        chainConfig.hardforkHistory.set(
          HardforkName.LONDON,
          eip1559ActivationBlock - 1n
        );

        nodeConfig.chains.set(1, chainConfig);

        [, nodeWithEarlyLondon] = await HardhatNode.create(nodeConfig);
      });

      it("should accept post-EIP-1559 gas semantics when running in the context of the block of the EIP-1559 activation", async function () {
        assert.equal(
          "Hello World",
          await runCall(post1559GasOpts, blockBefore1559, nodeWithEarlyLondon)
        );
      });

      it("should throw when given post-EIP-1559 gas semantics and when running in the context of the block before EIP-1559 activation", async function () {
        await expectErrorAsync(async () => {
          await runCall(
            post1559GasOpts,
            blockBefore1559 - 1n,
            nodeWithEarlyLondon
          );
        }, /Cannot run transaction: EIP 1559 is not activated./);
      });

      it("should accept post-EIP-1559 gas semantics when running in the context of a block after EIP-1559 activation", async function () {
        assert.equal(
          "Hello World",
          await runCall(post1559GasOpts, post1559Block, nodeWithEarlyLondon)
        );
      });

      it("should accept pre-EIP-1559 gas semantics when running in the context of the block of the EIP-1559 activation", async function () {
        assert.equal(
          "Hello World",
          await runCall(pre1559GasOpts, blockBefore1559, nodeWithEarlyLondon)
        );
      });
    });

    describe("when forking with a weird hardfork activation history", function () {
      let hardhatNode: HardhatNode;
      before(async function () {
        const nodeConfig = {
          ...baseNodeConfig,
          chains: new Map([
            [
              1,
              {
                hardforkHistory: new Map([["london", 100n]]),
              },
            ],
          ]),
        };

        [, hardhatNode] = await HardhatNode.create(nodeConfig);
      });
      it("should throw when making a call with a block below the only hardfork activation", async function () {
        await expectErrorAsync(async () => {
          await runCall(pre1559GasOpts, 99n, hardhatNode);
        }, /Could not find a hardfork to run for block 99, after having looked for one in the HardhatNode's hardfork activation history/);
      });
    });

    describe("when forking WITHOUT a hardfork activation history", function () {
      let nodeWithoutHardforkHistory: HardhatNode;

      before(async function () {
        const nodeCfgWithoutHFHist = {
          ...baseNodeConfig,
          chains: cloneChainsConfig(baseNodeConfig.chains),
        };
        nodeCfgWithoutHFHist.chains.set(1, { hardforkHistory: new Map() });
        [, nodeWithoutHardforkHistory] = await HardhatNode.create(
          nodeCfgWithoutHFHist
        );
      });

      it("should throw when running in the context of a historical block", async function () {
        await expectErrorAsync(async () => {
          await runCall(
            pre1559GasOpts,
            blockBefore1559,
            nodeWithoutHardforkHistory
          );
        }, /node was not configured with a hardfork activation history/);
      });
    });
  });

  it("should support a historical call in the context of a block added via mineBlocks()", async function () {
    if (ALCHEMY_URL === undefined) {
      this.skip();
      return;
    }
    const nodeConfig: ForkedNodeConfig = {
      automine: true,
      networkName: "mainnet",
      chainId: 1,
      networkId: 1,
      hardfork: "london",
      forkConfig: {
        jsonRpcUrl: ALCHEMY_URL,
        blockNumber: 12965000n, // eip1559ActivationBlock
      },
      forkCachePath: FORK_TESTS_CACHE_PATH,
      blockGasLimit: 1_000_000n,
      minGasPrice: 0n,
      genesisAccounts: [],
      chains: defaultHardhatNetworkParams.chains,
      mempoolOrder: "priority",
      coinbase: "0x0000000000000000000000000000000000000000",
    };
    const [, hardhatNode] = await HardhatNode.create(nodeConfig);

    const oldLatestBlockNumber = hardhatNode.getLatestBlockNumber();

    await hardhatNode.mineBlocks(100n);

    assert.equal(
      "Hello World",
      await runCall(
        { maxFeePerGas: 0n },
        oldLatestBlockNumber + 50n,
        hardhatNode
      )
    );
  });
});
