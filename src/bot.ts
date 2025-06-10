import { ethers, parseUnits } from "ethers";
import PharaohRouterABI from "./abis/PharaohRouter.json";
import * as dotenv from "dotenv";
dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const PHARAOH_ROUTER = "0x062c62cA66E50Cfe277A95564Fe5bB504db1Fab8";

const USDT = "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7";
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const FEE = 50; // 0.005%

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const usdt = new ethers.Contract(USDT, ERC20_ABI, wallet);
  const router = new ethers.Contract(PHARAOH_ROUTER, PharaohRouterABI, wallet);

  const decimals = await usdt.decimals();
  const amountIn = parseUnits("0.1", decimals); // Swap 1 USDT

  // Approve the router
  const allowance: bigint = await usdt.allowance(wallet.address, PHARAOH_ROUTER);
  if (allowance < amountIn) {
    console.log("Approving router to spend USDT...");
    const tx = await usdt.approve(PHARAOH_ROUTER, amountIn);
    await tx.wait();
    console.log("Approval confirmed.");
  }

  // Prepare swap params
  const params = {
    tokenIn: USDT,
    tokenOut: AUSD,
    fee: FEE,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 10,
    amountIn: amountIn,
    amountOutMinimum: 0, // In production, set a slippage-protected minimum
    sqrtPriceLimitX96: 0
  };

  console.log("Executing USDT → AUSD swap...");
  const tx = await router.exactInputSingle(params, { value: 0 });
  const receipt = await tx.wait();
  console.log("Swap complete! Tx hash:", receipt.hash);
}

main().catch(console.error);
