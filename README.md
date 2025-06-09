# Avalanche Trading Bot

A professional trading bot for the Avalanche network that performs automated token swaps with configurable parameters.

## Features

- Automated token swapping on Avalanche
- Real-time price monitoring and caching
- Configurable swap amounts and timing
- Transaction tracking and logging
- Error handling and recovery
- Gas price optimization
- Slippage protection

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Avalanche wallet with funds

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/avax-bot.git
cd avax-bot
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:
```env
PRIVATE_KEY=your_private_key
RPC_URL=your_avalanche_rpc_url
TOKEN_ADDRESS=your_token_address
CONTRACT_ADDRESS=your_dex_contract_address
WETH_ADDRESS=your_weth_address
```

## Usage

1. Configure your swap parameters in `src/config/swap.config.ts`
2. Run the bot:
```bash
npm start
```

## Project Structure

```
src/
├── config/         # Configuration files
├── services/       # Core services
├── types/          # TypeScript types
├── utils/          # Utility functions
├── constants/      # Constants and enums
└── bot.ts          # Main entry point
```

## Development

- `npm run build` - Build the project
- `npm run lint` - Run linter
- `npm run test` - Run tests
- `npm run dev` - Run in development mode

## License

MIT

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request 