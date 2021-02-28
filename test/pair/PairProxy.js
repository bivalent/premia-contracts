const describeBehaviorOfPair = require('./Pair.behavior.js');

const factory = require('../../lib/factory.js');

const SYMBOL_BASE = 'SYMBOL_BASE';
const SYMBOL_UNDERLYING = 'SYMBOL_UNDERLYING';

describe('PairProxy', function () {
  let owner;

  let openhedge;
  let instance;

  before(async function () {
    [owner] = await ethers.getSigners();

    const pair = await factory.Pair({ deployer: owner });
    const pool = await factory.Pool({ deployer: owner });

    const facets = [
      await factory.DiamondCuttable({ deployer: owner }),
      await factory.DiamondLoupe({ deployer: owner }),
      await factory.ProxyManager({ deployer: owner }),
      await factory.SafeOwnable({ deployer: owner }),
    ];

    const facetCuts = [];

    facets.forEach(function (f) {
      Object.keys(f.interface.functions).forEach(function (fn) {
        facetCuts.push([
          f.address,
          f.interface.getSighash(fn),
        ]);
      });
    });

    openhedge = await factory.Openhedge({
      deployer: owner,
      facetCuts,
      pairImplementation: pair.address,
      poolImplementation: pool.address,
    });
  });

  beforeEach(async function () {
    const manager = await ethers.getContractAt('ProxyManager', openhedge.address);

    const erc20Factory = await ethers.getContractFactory('ERC20Mock', owner);

    const token0 = await erc20Factory.deploy(SYMBOL_BASE);
    await token0.deployed();
    const token1 = await erc20Factory.deploy(SYMBOL_UNDERLYING);
    await token1.deployed();

    const tx = await manager.deployPair(token0.address, token1.address);
    instance = await ethers.getContractAt('Pair', (await tx.wait()).events[0].args.pair);
  });

  // eslint-disable-next-line mocha/no-setup-in-describe
  describeBehaviorOfPair({
    deploy: () => instance,
  }, []);
});
