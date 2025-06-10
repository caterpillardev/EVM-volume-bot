import { ethers, parseUnits, formatUnits } from "ethers";
import PharaohRouterABI from "./abis/PharaohRouter.json";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEYS = [
  process.env.WALLET1_PRIVATE_KEY!,
  process.env.WALLET2_PRIVATE_KEY!,
  process.env.WALLET3_PRIVATE_KEY!,
  process.env.WALLET4_PRIVATE_KEY!,
  process.env.WALLET5_PRIVATE_KEY!,
  process.env.WALLET6_PRIVATE_KEY!,
  
];

const PHARAOH_ROUTER = "0x062c62cA66E50Cfe277A95564Fe5bB504db1Fab8";
const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const FEE = 50;

// Initial swap amounts in USD
const INITIAL_SWAP_AMOUNTS = [0.1, 0.09, 0.07, 0.065, 0.056, 0.037];
const INCREASE_FACTOR = 1.28; // 28% increase for Wallet 1's next swap

// Path encoder for UniswapV3/Pharaoh style
function encodePath(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) throw new Error("tokens.length must be fees.length + 1");
  let path = "0x";
  for (let i = 0; i < fees.length; i++) {
    path += tokens[i].slice(2).padStart(40, "0");
    path += fees[i].toString(16).padStart(6, "0");
  }
  path += tokens[tokens.length - 1].slice(2).padStart(40, "0");
  return path;
}

// interface IERC20 {
//   balanceOf(address: string): Promise<bigint>;
//   approve(spender: string, amount: bigint): Promise<ethers.ContractTransactionResponse>;
//   allowance(owner: string, spender: string): Promise<bigint>;
//   decimals(): Promise<number>;
//   transfer(to: string, amount: bigint): Promise<ethers.ContractTransactionResponse>;
//   connect(signer: ethers.Signer): IERC20;
// }

class TradingBot {
  private provider: ethers.JsonRpcProvider;
  private wallets: ethers.Wallet[];
  private router: ethers.Contract;
  private usdc: ethers.Contract;
  private ausd: ethers.Contract;
  private currentWalletIndex: number;
  private currentSwapAmounts: number[];

  constructor() {
    this.provider = new ethers.JsonRpcProvider(RPC_URL);
    this.wallets = PRIVATE_KEYS.map(key => new ethers.Wallet(key, this.provider));
    this.router = new ethers.Contract(PHARAOH_ROUTER, PharaohRouterABI, this.wallets[0]);
    
    const tokenABI = [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function transfer(address,uint256) returns (bool)"
    ];
    
    this.usdc = new ethers.Contract(USDC, tokenABI, this.wallets[0]);
    this.ausd = new ethers.Contract(AUSD, tokenABI, this.wallets[0]);
    this.currentWalletIndex = 0;
    this.currentSwapAmounts = [...INITIAL_SWAP_AMOUNTS];
  }

  private async getSwapAmount(): Promise<bigint> {
    const amount = this.currentSwapAmounts[this.currentWalletIndex];
    const decimals = await this.usdc.decimals();
    return parseUnits(amount.toString(), decimals);
  }

  private async updateSwapAmounts() {
    if (this.currentWalletIndex === 0) {
      // Increase Wallet 1's next swap amount
      this.currentSwapAmounts[0] = Math.floor(this.currentSwapAmounts[0] * INCREASE_FACTOR);
    }
  }

  private async checkAndTransferBalances() {
    const usdcDecimals = await this.usdc.decimals();
    const ausdDecimals = await this.ausd.decimals();
    
    // Check Wallet 1's balance
    const wallet1UsdcBalance = await this.usdc.balanceOf(this.wallets[0].address);
    const wallet1AusdBalance = await this.ausd.balanceOf(this.wallets[0].address);
    
    if (wallet1UsdcBalance < await this.getSwapAmount()) {
      console.log("Wallet 1 balance low, gathering remaining balances...");
      
      // Gather balances from other wallets
      for (let i = 1; i < this.wallets.length; i++) {
        const usdcBalance = await this.usdc.balanceOf(this.wallets[i].address);
        const ausdBalance = await this.ausd.balanceOf(this.wallets[i].address);
        
        if (usdcBalance > 0n) {
          const usdcWithSigner = this.usdc.connect(this.wallets[i]);
          const tx = await (usdcWithSigner as any).transfer(this.wallets[0].address, usdcBalance);
          const receipt = await tx.wait();
          console.log(`Transferred ${formatUnits(usdcBalance, usdcDecimals)} USDC from Wallet ${i + 1} to Wallet 1`);
        }
        
        if (ausdBalance > 0n) {
          const ausdWithSigner = this.ausd.connect(this.wallets[i]);
          const tx = await (ausdWithSigner as any).transfer(this.wallets[0].address, ausdBalance);
          console.log(`Transferred ${formatUnits(ausdBalance, ausdDecimals)} AUSD from Wallet ${i + 1} to Wallet 1`);
        }
      }
      
      // Reset swap amounts to initial values
      this.currentSwapAmounts = [...INITIAL_SWAP_AMOUNTS];
    }
  }

  private async executeSwap(amountIn: bigint, isAUSDToUSDC: boolean) {
    const gasPrice = await this.provider.getFeeData();
    console.log(`Current gas price: ${formatUnits(gasPrice.gasPrice!, 'gwei')} gwei`);

    // Approve router to spend USDC
    const allowance = await this.usdc.allowance(this.wallets[this.currentWalletIndex].address, PHARAOH_ROUTER);
    if (allowance < amountIn) {
      console.log(`Approving router to spend ${formatUnits(amountIn, await this.usdc.decimals())} USDC...`);
      const approveTx = await this.usdc.approve(PHARAOH_ROUTER, amountIn);
      await approveTx.wait();
      console.log("Approval complete");
    }

    // Encode path for USDC -> AUSD swap
    const path = encodePath(
      [USDC, AUSD],
      [FEE]
    );

    // Build params for exactInput
    const params = {
      path: path,
      recipient: this.wallets[this.currentWalletIndex].address,
      deadline: Math.floor(Date.now() / 1000) + 60 * 10, // 10 minutes from now
      amountIn: amountIn,
      amountOutMinimum: 0n
    };

    // Swap!
    console.log(`Swapping ${formatUnits(amountIn, await this.usdc.decimals())} ${isAUSDToUSDC ? 'AUSD' : 'USDC'}...`);
    const tx = await this.router.exactInput(params, { 
      gasLimit: 200_000n,
      gasPrice: gasPrice.gasPrice
    });
    console.log("Swap transaction sent:", tx.hash);
    
    const receipt = await tx.wait();
    console.log("Swap complete! Transaction hash:", receipt.hash);
    console.log("Gas used:", receipt.gasUsed.toString());
    console.log("Gas cost:", formatUnits(receipt.gasUsed * gasPrice.gasPrice!, 18), "AVAX");
  }

  public async start() {
    while (true) {
      try {
        await this.checkAndTransferBalances();
        
        const isAUSDToUSDC = this.currentWalletIndex % 2 === 1;
        const amountIn = await this.getSwapAmount();
        
        console.log(`\nWallet ${this.currentWalletIndex + 1} executing swap...`);
        console.log(`Amount: ${formatUnits(amountIn, await this.usdc.decimals())} ${isAUSDToUSDC ? 'AUSD' : 'USDC'}`);
        
        await this.executeSwap(amountIn, isAUSDToUSDC);
        
        // Update wallet index and swap amounts
        this.currentWalletIndex = (this.currentWalletIndex + 1) % this.wallets.length;
        await this.updateSwapAmounts();
        
        // Wait for 5 seconds before next swap
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (error) {
        console.error("Error in trading loop:", error);
        // Wait for 30 seconds before retrying
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }
}

// Start the bot
const bot = new TradingBot();
bot.start().catch(console.error);
