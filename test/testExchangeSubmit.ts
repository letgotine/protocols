import * as pjs from "protocol2-js";
import { Artifacts } from "../util/Artifacts";
import { ringsInfoList } from "./rings_config";
import { ExchangeTestUtil } from "./testExchangeUtil";

const {
  DummyExchange,
  OrderBook,
  OrderRegistry,
} = new Artifacts(artifacts);

contract("Exchange_Submit", (accounts: string[]) => {

  let exchangeTestUtil: ExchangeTestUtil;

  let dummyExchange: any;
  let orderBook: any;
  let orderRegistry: any;

  const checkFilled = async (order: pjs.OrderInfo, expected: number) => {
    const filled = await exchangeTestUtil.context.tradeDelegate.filled("0x" + order.hash.toString("hex")).toNumber();
    assert.equal(filled, expected, "Order fill different than expected");
  };

  before( async () => {
    exchangeTestUtil = new ExchangeTestUtil();
    await exchangeTestUtil.initialize(accounts);
    orderBook = await OrderBook.deployed();
    orderRegistry = await OrderRegistry.deployed();

    // Create dummy exchange and authorize it
    dummyExchange = await DummyExchange.new(exchangeTestUtil.context.tradeDelegate.address,
                                            exchangeTestUtil.context.feeHolder.address,
                                            exchangeTestUtil.ringSubmitter.address);
    await exchangeTestUtil.context.tradeDelegate.authorizeAddress(dummyExchange.address,
                                                                  {from: exchangeTestUtil.testContext.deployer});
  });

  describe("submitRing", () => {

    for (const ringsInfo of ringsInfoList) {
      it(ringsInfo.description, async () => {
        await exchangeTestUtil.setupRings(ringsInfo);
        await exchangeTestUtil.submitRingsAndSimulate(ringsInfo, dummyExchange);
      });
    }

    it("order filled in multiple rings in different transactions", async () => {
      const order: pjs.OrderInfo = {
        index: 0,
        tokenS: "WETH",
        tokenB: "GTO",
        amountS: 100e18,
        amountB: 10e18,
      };

      // First transaction
      const ringsInfo1: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          order,
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 5.1e18,
            amountB: 50e18,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo1);
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo1);
      // First order buys 5.1 GTO and pays 50 WETH + 1 WETH margin
      await checkFilled(order, 51e18);
      // Second order is completely filled at the given rate
      await checkFilled(ringsInfo1.orders[1], 5.1e18);

      // Second transaction
      const ringsInfo2: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          order,
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 6e18,
            amountB: 60e18,
          },
        ],
      };
      // Reset the dual author signature so it is recalculated for the second ring
      order.dualAuthSig = undefined;
      await exchangeTestUtil.setupRings(ringsInfo2);
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo2);
      // First order buys 4.9 GTO at the given rate for 49 WETH
      await checkFilled(order, 100e18);
      // Second order buys 49 WETH at the given rate for 4.9 GTO
      await checkFilled(ringsInfo2.orders[1], 4.9e18);
    });

    it("order owner has not approved sufficient funds to the trade delegate contract", async () => {
      // First transaction
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 100e18,
            amountB: 10e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 100e18,
          },
        ],
      };
      ringsInfo.orders[0].owner = exchangeTestUtil.testContext.orderDualAuthAddrs[0];
      await exchangeTestUtil.setupRings(ringsInfo);

      // Nothing approved for tokenS or feeToken, orders should remain completely unfilled
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await checkFilled(ringsInfo.orders[0], 0e18);
      await checkFilled(ringsInfo.orders[1], 0e18);

      // Only approve a part of the tokenS amount, feeToken cannot be used
      const tokenS = exchangeTestUtil.testContext.tokenAddrInstanceMap.get(ringsInfo.orders[0].tokenS);
      await tokenS.approve(exchangeTestUtil.context.tradeDelegate.address,
                           ringsInfo.orders[0].amountS / 4,
                           {from: ringsInfo.orders[0].owner});

      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await checkFilled(ringsInfo.orders[0], ringsInfo.orders[0].amountS / 4);

      // Approve amountS and feeAmount, feeToken can be used
      await tokenS.approve(exchangeTestUtil.context.tradeDelegate.address,
                           ringsInfo.orders[0].amountS,
                           {from: ringsInfo.orders[0].owner});
      const tokenFee = exchangeTestUtil.testContext.tokenAddrInstanceMap.get(ringsInfo.orders[0].feeToken);
      await tokenFee.approve(exchangeTestUtil.context.tradeDelegate.address,
                           ringsInfo.orders[0].feeAmount,
                           {from: ringsInfo.orders[0].owner});
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await checkFilled(ringsInfo.orders[0], ringsInfo.orders[0].amountS);
    });

    it("transaction origin is the miner", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 100e18,
            amountB: 10e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 10e18,
            amountB: 100e18,
          },
        ],
        transactionOrigin: exchangeTestUtil.testContext.miner,
        feeRecipient: exchangeTestUtil.testContext.miner,
        miner: exchangeTestUtil.testContext.miner,
      };
      await exchangeTestUtil.setupRings(ringsInfo);
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("on-chain order should be able to dealed with off-chain order", async () => {
      const gtoAddr = exchangeTestUtil.testContext.tokenSymbolAddrMap.get("GTO");
      const wethAddr = exchangeTestUtil.testContext.tokenSymbolAddrMap.get("WETH");

      const onChainOrder: pjs.OrderInfo = {
        index: 0,
        tokenS: gtoAddr,
        tokenB: wethAddr,
        amountS: 10000e18,
        amountB: 3e18,
        onChain: true,
      };

      const offChainOrder: pjs.OrderInfo = {
        index: 1,
        tokenS: wethAddr,
        tokenB: gtoAddr,
        amountS: 3e18,
        amountB: 10000e18,
        feeAmount: 1e18,
      };

      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          onChainOrder,
          offChainOrder,
        ],
      };

      await exchangeTestUtil.setupRings(ringsInfo);

      const orderUtil = new pjs.OrderUtil(undefined);
      const bytes32Array = orderUtil.toOrderBookSubmitParams(onChainOrder);
      const fromBlock = web3.eth.blockNumber;
      await orderBook.submitOrder(bytes32Array, {from: onChainOrder.owner});
      const events: any = await exchangeTestUtil.getEventsFromContract(orderBook, "OrderSubmitted", fromBlock);
      const orderHashOnChain = events[0].args.orderHash;
      const orderHashBuffer = orderUtil.getOrderHash(onChainOrder);
      console.log("orderHash:", "0x" + orderHashBuffer.toString("hex"));
      console.log("orderHashOnChain:", orderHashOnChain);
      // assert.equal(onChainOrder.hash, orderHashOnChain, "order hash not equal");

      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("Should be able to use an order registered in the order registry", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 100e18,
            amountB: 10e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 1e18,
            amountB: 10e18,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);
      const order = ringsInfo.orders[1];
      // Don't send the signature for the order so it needs to be validated differently
      order.sig = null;

      // No signature and the hash is not registered
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await exchangeTestUtil.checkFilled(order.hash, 0);

      // Register the order hash
      await orderRegistry.registerOrderHash("0x" + order.hash.toString("hex"), {from: order.owner});

      // Retry again now the order hash is registered
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      await exchangeTestUtil.checkFilled(order.hash, order.amountS);
    });

    it("user should be able to get a rebate by locking LRC", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 35e17,
            amountB: 22e17,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 23e17,
            amountB: 31e17,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);
      // Give the owner of the first order a burn rate rebate of 50%
      await exchangeTestUtil.lockLRC(ringsInfo.orders[0].owner, 0.5);
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
    });

    it("should be able to submit an order without the broker signature when partially filled", async () => {
      const ringsInfo: pjs.RingsInfo = {
        rings: [[0, 1]],
        orders: [
          {
            tokenS: "WETH",
            tokenB: "GTO",
            amountS: 100e18,
            amountB: 100e18,
          },
          {
            tokenS: "GTO",
            tokenB: "WETH",
            amountS: 100e18,
            amountB: 100e18,
          },
        ],
      };
      await exchangeTestUtil.setupRings(ringsInfo);
      const order = ringsInfo.orders[0];
      order.balanceS = order.amountS / 2;
      await exchangeTestUtil.setOrderBalances(order);

      const sig = order.sig;

      // Don't send the signature
      order.sig = null;
      // Order should be invalid so nothing should get filled
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      // Check fills
      await checkFilled(ringsInfo.orders[0], 0);
      await checkFilled(ringsInfo.orders[1], 0);

      // Send the signature this time
      order.sig = sig;
      // Fill the orders 50%
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      // Check fills
      await checkFilled(ringsInfo.orders[0], ringsInfo.orders[0].amountS / 2);
      await checkFilled(ringsInfo.orders[1], ringsInfo.orders[1].amountS / 2);

      // Don't send the signature anymore
      order.sig = null;
      // Give the order enough balance to fill 100%
      await exchangeTestUtil.setOrderBalances(order);
      // Fill the orders 100%
      await exchangeTestUtil.submitRingsAndSimulate(ringsInfo);
      // Check fills
      await checkFilled(ringsInfo.orders[0], ringsInfo.orders[0].amountS);
      await checkFilled(ringsInfo.orders[1], ringsInfo.orders[1].amountS);
    });

  });

});
