import { deployV2, TokenAddresses } from '../utils/deployV2';

async function main() {
  const tokens: TokenAddresses = {
    ETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    BTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  };

  const oracles: TokenAddresses = {
    ETH: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    DAI: '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9',
    BTC: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    LINK: '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c',
  };

  await deployV2(tokens.ETH, tokens, oracles, false);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
