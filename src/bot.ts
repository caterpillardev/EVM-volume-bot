import { ethers, parseUnits, formatUnits } from "ethers";
import PancakeRouterABI from "./abis/PancakeRouter.json";
import * as dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;

const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E"; // PancakeSwap v2 Router
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"; // Wrapped BNB
const OZEAN = "0x12bdC0C297cF78F2215BC450c888EF27179B3B23";

const SWAP_USD_AMOUNT = 0.1; // $0.1 per swap

class TradingBot {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private router: ethers.Contract;
  private wbnb: ethers.Contract;
  private ozean: ethers.Contract;
  private isNextSwapOzeanToWbnb: boolean;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(RPC_URL);
    this.wallet = new ethers.Wallet(PRIVATE_KEY, this.provider);
    this.router = new ethers.Contract(PANCAKE_ROUTER, PancakeRouterABI, this.wallet);
    
    const tokenABI = [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function transfer(address,uint256) returns (bool)",
      "function deposit() payable", // WBNB: wrap BNB
      "function withdraw(uint256)" // WBNB: unwrap to BNB
    ];
    
    this.wbnb = new ethers.Contract(WBNB, tokenABI, this.wallet);
    this.ozean = new ethers.Contract(OZEAN, tokenABI, this.wallet);
    this.isNextSwapOzeanToWbnb = false;
  }

  // Fetch BNB/USD price from CoinGecko
  private async getBNBUSDPrice(): Promise<number> {
    try {
      const resp = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd"
      );
      return resp.data.binancecoin.usd;
    } catch (e) {
      throw new Error("Failed to fetch BNB/USD price from CoinGecko");
    }
  }

  // Estimate OZEANAI/WBNB price using PancakeSwap router
  private async getOzeanWBNBPrice(): Promise<number> {
    // getAmountsOut(1 OZEANAI, [OZEANAI, WBNB])
    const ozeanDecimals = await this.ozean.decimals();
    const amountIn = parseUnits("1", ozeanDecimals);
    try {
      const amounts = await this.router.getAmountsOut(amountIn, [OZEAN, WBNB]);
      // amounts[1] is WBNB received for 1 OZEANAI
      return Number(formatUnits(amounts[1], 18));
    } catch (e) {
      throw new Error("Failed to fetch OZEANAI/WBNB price from PancakeSwap");
    }
  }

  private async wrapBNB(amount: bigint) {
    if (amount > 0n) {
      console.log(`Wrapping ${formatUnits(amount, 18)} BNB to WBNB...`);
      const tx = await this.wbnb.deposit({ value: amount, gasLimit: 100_000 });
      await tx.wait();
      console.log("Wrap complete.");
    } else {
      console.log("No BNB to wrap.");
    }
  }

  private async unwrapWBNB(amount: bigint) {
    if (amount > 0n) {
      console.log(`Unwrapping ${formatUnits(amount, 18)} WBNB to BNB...`);
      const tx = await this.wbnb.withdraw(amount, { gasLimit: 100_000 });
      await tx.wait();
      console.log("Unwrap complete.");
    } else {
      console.log("No WBNB to unwrap.");
    }
  }

  private async approveIfNeeded(token: ethers.Contract, amount: bigint, spender: string) {
    const allowance = await token.allowance(this.wallet.address, spender);
    if (allowance < amount) {
      const symbol = token === this.wbnb ? "WBNB" : "OZEANAI";
      console.log(`Approving ${symbol} for router...`);
      const tx = await token.approve(spender, amount);
      await tx.wait();
      console.log("Approval complete.");
    }
  }

  private async swapExactTokensForTokens(amountIn: bigint, path: string[]) {
    const gasPrice = await this.provider.getFeeData();
    const tokenIn = path[0];
    const tokenContract = tokenIn.toLowerCase() === WBNB.toLowerCase() ? this.wbnb : this.ozean;
    await this.approveIfNeeded(tokenContract, amountIn, PANCAKE_ROUTER);
    const decimals = await tokenContract.decimals();
    console.log(`Swapping ${formatUnits(amountIn, decimals)} ${tokenIn === WBNB ? "WBNB" : "OZEANAI"}...`);
    const tx = await this.router.swapExactTokensForTokens(
      amountIn,
      0, // amountOutMin
      path,
      this.wallet.address,
      Math.floor(Date.now() / 1000) + 60 * 10,
      {
        gasLimit: 300_000n,
        gasPrice: gasPrice.gasPrice
      }
    );
    console.log("Swap transaction sent:", tx.hash);
    const receipt = await tx.wait();
    console.log("Swap complete! Transaction hash:", receipt.hash);
    console.log("Gas used:", receipt.gasUsed.toString());
    console.log("Gas cost:", formatUnits(receipt.gasUsed * gasPrice.gasPrice!, 18), "BNB");
  }

  public async start() {
    while (true) {
      try {
        if (!this.isNextSwapOzeanToWbnb) {
          // BUY: $0.1 BNB -> WBNB -> OZEANAI
          const bnbUsd = await this.getBNBUSDPrice();
          const bnbAmount = SWAP_USD_AMOUNT / bnbUsd;
          const bnbAmountWei = parseUnits(bnbAmount.toFixed(18), 18);
          const bnbBalance = await this.provider.getBalance(this.wallet.address);
          if (bnbBalance >= bnbAmountWei) {
            await this.wrapBNB(bnbAmountWei);
            const wbnbBalance = await this.wbnb.balanceOf(this.wallet.address);
            if (wbnbBalance >= bnbAmountWei) {
              await this.swapExactTokensForTokens(bnbAmountWei, [WBNB, OZEAN]);
            } else {
              console.log("Not enough WBNB to swap for OZEANAI.");
            }
          } else {
            console.log("Not enough BNB to wrap and swap.");
          }
        } else {
          // SELL: $0.1 OZEANAI -> WBNB -> BNB
          const ozeanWbnbPrice = await this.getOzeanWBNBPrice();
          const wbnbUsd = await this.getBNBUSDPrice();
          const ozeanUsd = ozeanWbnbPrice * wbnbUsd;
          const ozeanDecimals = await this.ozean.decimals();
          // $0.1 / ozeanUsd = amount of OZEANAI to swap
          const ozeanAmount = SWAP_USD_AMOUNT / ozeanUsd;
          const ozeanAmountWei = parseUnits(ozeanAmount.toFixed(ozeanDecimals), ozeanDecimals);
          const ozeanBalance = await this.ozean.balanceOf(this.wallet.address);
          if (ozeanBalance >= ozeanAmountWei) {
            await this.swapExactTokensForTokens(ozeanAmountWei, [OZEAN, WBNB]);
            // Unwrap only the WBNB received from this swap
            const wbnbBalance = await this.wbnb.balanceOf(this.wallet.address);
            if (wbnbBalance > 0n) {
              await this.unwrapWBNB(wbnbBalance);
            }
          } else {
            console.log("Not enough OZEANAI to sell.");
          }
        }
        this.isNextSwapOzeanToWbnb = !this.isNextSwapOzeanToWbnb;
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error) {
        console.error("Error in trading loop:", error);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }
}

const bot = new TradingBot();
bot.start().catch(console.error);
