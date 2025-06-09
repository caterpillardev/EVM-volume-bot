import { config as loadEnv } from 'dotenv';
import { JsonRpcProvider, Wallet, Contract, parseEther, ethers, parseUnits } from 'ethers';
import axios from 'axios';

loadEnv();

// ----- Config -----
const PHARAOH_ROUTER = "0x062c62cA66E50Cfe277A95564Fe5bB504db1Fab8";
const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const TARGET_TOKEN = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const GAS_LIMIT = 500_000;

// ----- ABIs -----
const WAVAX_ABI = [
    "function deposit() payable",
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
    "function withdraw(uint256) external",
];
const TOKEN_ABI = [
    "function approve(address,uint256) returns (bool)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
];
const ROUTER_ABI = [
    "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)) external payable returns (uint256)",
    "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256)",
];

// ----- Types -----
interface SwapConfig {
    firstSwapUSD: string;
    secondSwapUSD: string;
    thirdSwapUSD: string;
    waitTimeBeforeSwaps: number;
    waitTimeBetweenSwaps: number;
    waitTimeAfterCycle: number;
}

// ----- Logger -----
function log(level: 'info'|'warn'|'error', ...args: any[]) {
    const prefix = `[${new Date().toISOString()}][${level.toUpperCase()}]`;
    // Color coding (optional)
    let color: string;
    if (level === 'info') color = '\x1b[36m';      // Cyan
    else if (level === 'warn') color = '\x1b[33m'; // Yellow
    else color = '\x1b[31m';                       // Red
    console.log(color, prefix, ...args, '\x1b[0m');
}

function logTable(title: string, data: { [key: string]: any }) {
    log('info', `\n=== ${title} ===`);
    Object.entries(data).forEach(([key, value]) => {
        if (typeof value === 'object') {
            log('info', `${key}:`);
            Object.entries(value).forEach(([subKey, subValue]) => {
                log('info', `  ${subKey}: ${subValue}`);
            });
        } else {
            log('info', `${key}: ${value}`);
        }
    });
    log('info', '==================\n');
}

// ----- Utils -----
function wait(seconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

const provider = new JsonRpcProvider(process.env.AVAX_RPC_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

// ----- Price fetch -----
async function getAVAXPrice(): Promise<number> {
    try {
        const response = await axios.get<{ 'avalanche-2': { usd: number } }>(
            'https://pro-api.coingecko.com/api/v3/simple/price?ids=avalanche-2&vs_currencies=usd',
            {
                headers: {
                    'x-cg-pro-api-key': 'CG-DH8Qcf8qLbyFVPi5zQhoAPTo'
                }
            }
        );
        const price = response.data['avalanche-2']?.usd;
        if (price) return price;
        log('warn', "AVAX price not found, using fallback.");
        return 18.50;
    } catch {
        log('warn', "Failed to fetch AVAX price, using fallback.");
        return 18.50;
    }
}

async function getTokenPrice(): Promise<number> {
    try {
        const response = await axios.get<{ [key: string]: { usd: number } }>(
            `https://pro-api.coingecko.com/api/v3/simple/token_price/avalanche?contract_addresses=${TARGET_TOKEN}&vs_currencies=usd`,
            {
                headers: {
                    'x-cg-pro-api-key': 'CG-DH8Qcf8qLbyFVPi5zQhoAPTo'
                }
            }
        );
        const price = response.data[TARGET_TOKEN.toLowerCase()]?.usd;
        if (price) return price;
        log('warn', "Token price not found, using fallback.");
        return 0.9992;
    } catch {
        log('warn', "Failed to fetch token price, using fallback.");
        return 0.9992;
    }
}

async function checkGasFeeBalance(amountUSD: string): Promise<boolean> {
    const balance = await provider.getBalance(wallet.address);
    const avaxPrice = await getAVAXPrice();
    const swapAmountAVAX = Number(amountUSD) / avaxPrice;
    const gasFee = Math.max(swapAmountAVAX * 0.01, 0.001);

    logTable('Gas Fee Check', {
        'Swap Amount (USD)': `$${amountUSD}`,
        'Swap Amount (AVAX)': `${swapAmountAVAX.toFixed(6)} AVAX`,
        'Current Balance': `${ethers.formatEther(balance)} AVAX`,
        'Required Gas Fee': `${gasFee.toFixed(6)} AVAX`
    });

    if (balance < parseEther(gasFee.toFixed(6))) {
        log('warn', `INSUFFICIENT GAS FEE BALANCE: Required ${gasFee.toFixed(6)} AVAX, Have ${ethers.formatEther(balance)} AVAX`);
        return false;
    }
    return true;
}

// ----- Swaps -----
async function swapAVAXForToken(amountUSD: string) {
    const hasEnoughGas = await checkGasFeeBalance(amountUSD);
    if (!hasEnoughGas) {
        return null;
    }

    const avaxPrice = await getAVAXPrice();
    const amountAVAX = (Number(amountUSD) / avaxPrice).toFixed(6);

    const balance = await provider.getBalance(wallet.address);
    const requiredAVAX = parseEther(amountAVAX);
    if (balance < requiredAVAX) {
        throw new Error(`INSUFFICIENT AVAX BALANCE: Required ${ethers.formatEther(requiredAVAX)} AVAX, Have ${ethers.formatEther(balance)} AVAX`);
    }

    const router = new Contract(PHARAOH_ROUTER, ROUTER_ABI, wallet);
    const wavax = new Contract(WAVAX, WAVAX_ABI, wallet);
    const token = new Contract(TARGET_TOKEN, TOKEN_ABI, wallet);
    const initialTokenBalance = await token.balanceOf(wallet.address);

    logTable('Initial State', {
        'Swap Amount (USD)': `$${amountUSD}`,
        'AVAX Price': `$${avaxPrice}`,
        'AVAX Amount': `${amountAVAX} AVAX`,
        'Current AVAX Balance': `${ethers.formatEther(balance)} AVAX`,
        'Current Token Balance': `${ethers.formatUnits(initialTokenBalance, await token.decimals())} Tokens`
    });

    // Step 1: Wrap AVAX
    log('info', "Wrapping AVAX to WAVAX...");
    const wrapTx = await wavax.deposit({ value: requiredAVAX, gasLimit: GAS_LIMIT });
    await wrapTx.wait();
    log('info', "AVAX wrapped.");

    // Step 2: Approve router
    const wavaxBalance = await wavax.balanceOf(wallet.address);
    log('info', "Approving router to spend WAVAX...");
    const approveTx = await wavax.approve(PHARAOH_ROUTER, wavaxBalance);
    await approveTx.wait();
    log('info', "Router approved.");

    // Step 3: Swap
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const path = ethers.solidityPacked(
        ['address', 'uint24', 'address'],
        [WAVAX, 3000, TARGET_TOKEN]
    );
    const params = { path, recipient: wallet.address, deadline, amountIn: wavaxBalance, amountOutMinimum: 0 };

    log('info', "Swapping WAVAX for Token...");
    const swapTx = await router.exactInput(params, { gasLimit: GAS_LIMIT });
    const receipt = await swapTx.wait();

    // Final balances
    const finalTokenBalance = await token.balanceOf(wallet.address);
    const tokenReceived = finalTokenBalance - initialTokenBalance;
    const tokenPrice = await getTokenPrice();
    const tokenValueUSD = Number(ethers.formatUnits(tokenReceived, await token.decimals())) * tokenPrice;

    logTable('Swap Summary', {
        'Token In': `$${amountUSD} AVAX`,
        'Token Out': `${ethers.formatUnits(tokenReceived, await token.decimals())} Tokens`,
        'Token Out Value': `$${tokenValueUSD.toFixed(6)}`,
        'Transaction Hash': receipt.hash
    });

    return receipt.hash;
}

async function swapTokenToAVAX(amountUSD: string) {
    const hasEnoughGas = await checkGasFeeBalance(amountUSD);
    if (!hasEnoughGas) {
        return null;
    }

    const tokenPrice = await getTokenPrice();
    const requiredTokenAmount = (Number(amountUSD) / tokenPrice).toFixed(6);

    const router = new Contract(PHARAOH_ROUTER, ROUTER_ABI, wallet);
    const wavax = new Contract(WAVAX, WAVAX_ABI, wallet);
    const token = new Contract(TARGET_TOKEN, TOKEN_ABI, wallet);

    const initialTokenBalance = await token.balanceOf(wallet.address);
    const requiredTokens = parseUnits(requiredTokenAmount, await token.decimals());
    if (initialTokenBalance < requiredTokens) {
        throw new Error(`INSUFFICIENT TOKEN BALANCE: Required ${ethers.formatUnits(requiredTokens, await token.decimals())} Tokens`);
    }

    // Approve
    log('info', "Approving router to spend Tokens...");
    const approveTx = await token.approve(PHARAOH_ROUTER, requiredTokens, { gasLimit: GAS_LIMIT });
    await approveTx.wait();

    // Swap
    const block = await provider.getBlock('latest');
    const deadline = (block?.timestamp || Math.floor(Date.now() / 1000)) + 300;
    const params = {
        tokenIn: TARGET_TOKEN,
        tokenOut: WAVAX,
        fee: 3000,
        recipient: wallet.address,
        deadline,
        amountIn: requiredTokens,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
    };

    log('info', "Swapping Token for WAVAX...");
    const swapTx = await router.exactInputSingle(params, { gasLimit: GAS_LIMIT });
    const receipt = await swapTx.wait();

    // Optionally: Unwrap WAVAX to AVAX if needed (add code here)

    logTable('Swap Summary', {
        'Token In': `$${amountUSD} worth of Tokens`,
        'Transaction Hash': receipt.hash
    });

    return receipt.hash;
}

// ----- Cycle -----
async function calculateSwapRequirements(config: SwapConfig): Promise<number> {
    const avaxPrice = await getAVAXPrice();
    const tokenPrice = await getTokenPrice();
    const firstSwapAVAX = Number(config.firstSwapUSD) / avaxPrice;
    const thirdSwapAVAX = Number(config.thirdSwapUSD) / avaxPrice;
    const secondSwapTokens = Number(config.secondSwapUSD) / tokenPrice;
    const gasFees = 0.003;
    const totalAVAX = firstSwapAVAX + thirdSwapAVAX + gasFees;
    const totalUSD = Number(config.firstSwapUSD) + Number(config.secondSwapUSD) + Number(config.thirdSwapUSD);

    logTable('Swap Requirements', {
        'First Swap (AVAX to Token)': { 'USD Amount': `$${config.firstSwapUSD}`, 'AVAX Needed': `${firstSwapAVAX.toFixed(6)} AVAX`, 'Gas Fee': '0.001 AVAX' },
        'Second Swap (Token to AVAX)': { 'USD Amount': `$${config.secondSwapUSD}`, 'Token Amount': `${secondSwapTokens.toFixed(6)} Tokens`, 'Gas Fee': '0.001 AVAX' },
        'Third Swap (AVAX to Token)': { 'USD Amount': `$${config.thirdSwapUSD}`, 'AVAX Needed': `${thirdSwapAVAX.toFixed(6)} AVAX`, 'Gas Fee': '0.001 AVAX' },
        'Total Requirements': { 'Total AVAX Needed': `${totalAVAX.toFixed(6)} AVAX`, 'Total Gas Fees': `${gasFees.toFixed(6)} AVAX`, 'Total USD Value': `$${totalUSD.toFixed(2)}` },
        'Timing': {
            'Wait Before Swaps': `${config.waitTimeBeforeSwaps} seconds`,
            'Wait Between Swaps': `${config.waitTimeBetweenSwaps} seconds`,
            'Wait After Cycle': `${config.waitTimeAfterCycle} seconds`
        }
    });
    return totalAVAX;
}

async function runSwapCycle(config: SwapConfig): Promise<void> {
    const requiredAVAX = await calculateSwapRequirements(config);
    const balance = await provider.getBalance(wallet.address);
    if (balance < ethers.parseEther(requiredAVAX.toFixed(6))) {
        log('warn', `INSUFFICIENT AVAX BALANCE FOR CYCLE: Required ${requiredAVAX.toFixed(6)} AVAX, Have ${ethers.formatEther(balance)} AVAX`);
        return;
    }

    log('info', "=== Starting First Swap: AVAX to Token ===");
    const firstSwapResult = await swapAVAXForToken(config.firstSwapUSD);
    if (!firstSwapResult) {
        log('warn', "Skipping remaining swaps due to insufficient gas fee balance");
        return;
    }
    log('info', `Waiting ${config.waitTimeBeforeSwaps}s before next swap...`);
    await wait(config.waitTimeBeforeSwaps);

    log('info', "=== Starting Second Swap: Token to AVAX ===");
    const secondSwapResult = await swapTokenToAVAX(config.secondSwapUSD);
    if (!secondSwapResult) {
        log('warn', "Skipping remaining swaps due to insufficient gas fee balance");
        return;
    }
    log('info', `Waiting ${config.waitTimeBetweenSwaps}s before next swap...`);
    await wait(config.waitTimeBetweenSwaps);

    log('info', "=== Starting Third Swap: AVAX to Token ===");
    const thirdSwapResult = await swapAVAXForToken(config.thirdSwapUSD);
    if (!thirdSwapResult) {
        log('warn', "Skipping remaining swaps due to insufficient gas fee balance");
        return;
    }
    log('info', `Waiting ${config.waitTimeAfterCycle}s before next cycle...`);
    await wait(config.waitTimeAfterCycle);

    log('info', "=== Swap Cycle Completed ===");
}

// ----- Main Entrypoint -----
async function main() {
    const swapConfig: SwapConfig = {
        firstSwapUSD: "0.02",
        secondSwapUSD: "0.0086",
        thirdSwapUSD: "0.01",
        waitTimeBeforeSwaps: 5,
        waitTimeBetweenSwaps: 8,
        waitTimeAfterCycle: 12
    };

    log('info', "=== Bot Configuration ===");
    logTable('Bot Configuration', swapConfig);

    const requiredAVAX = await calculateSwapRequirements(swapConfig);
    const balance = await provider.getBalance(wallet.address);
    logTable('Funds Status', {
        'Minimum Required': `${requiredAVAX.toFixed(6)} AVAX`,
        'Current Balance': `${ethers.formatEther(balance)} AVAX`,
        'Status': balance >= ethers.parseEther(requiredAVAX.toFixed(6)) ? '✅ Sufficient' : '❌ Insufficient'
    });

    if (balance < ethers.parseEther(requiredAVAX.toFixed(6))) {
        log('warn', `INSUFFICIENT FUNDS: Required ${requiredAVAX.toFixed(6)} AVAX, Have ${ethers.formatEther(balance)} AVAX`);
        log('info', "Bot stopped due to insufficient funds. Please fund your wallet to continue.");
        process.exit(0);
    }

    log('info', "Bot starting with sufficient funds...");
    while (true) {
        try {
            await runSwapCycle(swapConfig);
        } catch (err) {
            log('warn', "An issue occurred during the swap cycle. Bot will continue after waiting...");
            await wait(3); // wait before retrying
        }
    }
}

main().catch(() => {
    log('warn', "Bot stopped due to an unexpected issue.");
    process.exit(0);
});
