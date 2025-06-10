import { ethers, parseUnits, formatUnits } from "ethers";
import PharaohRouterABI from "./abis/PharaohRouter.json";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const PHARAOH_ROUTER = "0x062c62cA66E50Cfe277A95564Fe5bB504db1Fab8";
const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"; // USDC.e on Avalanche
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const FEE = 50; // 0.05%

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

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Get current gas price
  const gasPrice = await provider.getFeeData();
  console.log(`Current gas price: ${formatUnits(gasPrice.gasPrice!, 'gwei')} gwei`);

  // Create USDC contract instance
  const usdcContract = new ethers.Contract(USDC, [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function decimals() view returns (uint8)"
  ], wallet);

  // Check USDC balance
  const usdcBalance = await usdcContract.balanceOf(wallet.address);
  const usdcDecimals = await usdcContract.decimals();
  console.log(`Current USDC balance: ${formatUnits(usdcBalance, usdcDecimals)} USDC`);
  
  const amountIn = parseUnits("0.1", usdcDecimals); // Swap 10 USDC
  const amountOutMin = 0n; // No minimum output for testing

  // Check if we have enough USDC
  if (usdcBalance < amountIn) {
    throw new Error(`Insufficient USDC balance. Need ${formatUnits(amountIn, usdcDecimals)} USDC`);
  }

  const router = new ethers.Contract(PHARAOH_ROUTER, PharaohRouterABI, wallet);

  // Approve router to spend USDC
  const allowance = await usdcContract.allowance(wallet.address, PHARAOH_ROUTER);
  if (allowance < amountIn) {
    console.log("Approving router to spend USDC...");
    const approveTx = await usdcContract.approve(PHARAOH_ROUTER, amountIn);
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
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 10, // 10 minutes from now
    amountIn: amountIn,
    amountOutMinimum: amountOutMin
  };

  // Swap!
  console.log(`Swapping ${formatUnits(amountIn, usdcDecimals)} USDC for AUSD...`);
  const tx = await router.exactInput(params, { 
    gasLimit: 200_000n,
    gasPrice: gasPrice.gasPrice
  });
  console.log("Swap transaction sent:", tx.hash);
  
  const receipt = await tx.wait();
  console.log("Swap complete! Transaction hash:", receipt.hash);
  console.log("Gas used:", receipt.gasUsed.toString());
  console.log("Gas cost:", formatUnits(receipt.gasUsed * gasPrice.gasPrice!, 18), "AVAX");
}

main().catch((err) => {
  console.error("ERROR:", err);
});
