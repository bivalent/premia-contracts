import { ethers } from 'hardhat';
import { BigNumber } from 'ethers';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import {
  PremiaOption,
  PremiaOption__factory,
  TestErc20,
  TestErc20__factory,
  TestFlashLoan__factory,
  TestPremiaFeeDiscount,
  TestPremiaFeeDiscount__factory,
  WETH9,
  WETH9__factory,
} from '../contractsTyped';
import { PremiaOptionTestUtil } from './utils/PremiaOptionTestUtil';
import { ONE_WEEK, ZERO_ADDRESS } from './utils/constants';
import { resetHardhat, setTimestampPostExpiration } from './utils/evm';
import { deployContracts, IPremiaContracts } from '../scripts/deployContracts';
import { parseEther } from 'ethers/lib/utils';
import { createUniswap, IUniswap } from './utils/uniswap';

let p: IPremiaContracts;
let uniswap: IUniswap;
let weth: WETH9;
let dai: TestErc20;
let premiaOption: PremiaOption;
let premiaFeeDiscount: TestPremiaFeeDiscount;
let admin: SignerWithAddress;
let writer1: SignerWithAddress;
let writer2: SignerWithAddress;
let user1: SignerWithAddress;
let feeRecipient: SignerWithAddress;
const tax = 100;

let optionTestUtil: PremiaOptionTestUtil;

describe('PremiaOption', () => {
  beforeEach(async () => {
    await resetHardhat();

    [admin, writer1, writer2, user1, feeRecipient] = await ethers.getSigners();
    weth = await new WETH9__factory(admin).deploy();
    dai = await new TestErc20__factory(admin).deploy();

    p = await deployContracts(admin, feeRecipient.address, true);

    const premiaOptionFactory = new PremiaOption__factory(admin);

    premiaOption = await premiaOptionFactory.deploy(
      'dummyURI',
      dai.address,
      p.uPremia.address,
      p.feeCalculator.address,
      p.premiaReferral.address,
      feeRecipient.address,
    );

    await p.uPremia.addMinter([premiaOption.address]);
    premiaFeeDiscount = await new TestPremiaFeeDiscount__factory(
      admin,
    ).deploy();
    await p.feeCalculator.setPremiaFeeDiscount(premiaFeeDiscount.address);

    await p.premiaReferral.addWhitelisted([premiaOption.address]);

    optionTestUtil = new PremiaOptionTestUtil({
      weth,
      dai,
      premiaOption,
      admin,
      writer1,
      writer2,
      user1,
      feeRecipient,
      tax,
    });
  });

  it('should add eth for trading', async () => {
    await optionTestUtil.addEth();
    const strikePriceIncrement = await premiaOption.tokenStrikeIncrement(
      weth.address,
    );
    expect(strikePriceIncrement.eq(parseEther('10'))).to.true;
  });

  it('should create a new optionId', async () => {
    await optionTestUtil.addEth();
    const defaultOption = optionTestUtil.getOptionDefaults();
    await premiaOption.getOptionIdOrCreate(
      weth.address,
      defaultOption.expiration,
      defaultOption.strikePrice,
      true,
    );

    const option = await premiaOption.optionData(1);
    expect(option.token).to.eq(weth.address);
    expect(option.expiration).to.eq(defaultOption.expiration);
    expect(option.strikePrice).to.eq(defaultOption.strikePrice);
    expect(option.isCall).to.be.true;
  });

  describe('writeOption', () => {
    it('should fail if token not added', async () => {
      await expect(optionTestUtil.writeOption(writer1)).to.be.revertedWith(
        'Token not supported',
      );
    });

    it('should disable eth for writing', async () => {
      await optionTestUtil.addEth();
      await premiaOption.setTokens([weth.address], [0]);
      await expect(optionTestUtil.writeOption(writer1)).to.be.revertedWith(
        'Token not supported',
      );
    });

    it('should revert if contract amount <= 0', async () => {
      await optionTestUtil.addEth();
      await expect(
        optionTestUtil.writeOption(writer1, { amount: BigNumber.from(0) }),
      ).to.be.revertedWith('Amount <= 0');
    });

    it('should revert if contract strike price <= 0', async () => {
      await optionTestUtil.addEth();
      await expect(
        optionTestUtil.writeOption(writer1, { strikePrice: 0 }),
      ).to.be.revertedWith('Strike <= 0');
    });

    it('should revert if strike price increment is wrong', async () => {
      await optionTestUtil.addEth();
      await expect(
        optionTestUtil.writeOption(writer1, {
          strikePrice: parseEther('1'),
        }),
      ).to.be.revertedWith('Wrong strike incr');
    });

    it('should revert if timestamp already passed', async () => {
      await optionTestUtil.addEth();
      await setTimestampPostExpiration();
      await expect(optionTestUtil.writeOption(writer1)).to.be.revertedWith(
        'Exp passed',
      );
    });

    it('should revert if timestamp increment is wrong', async () => {
      await optionTestUtil.addEth();
      await expect(
        optionTestUtil.writeOption(writer1, {
          expiration: optionTestUtil.getNextExpiration() + 200,
        }),
      ).to.be.revertedWith('Wrong exp incr');
    });

    it('should revert if timestamp is beyond max expiration', async () => {
      await optionTestUtil.addEth();
      await expect(
        optionTestUtil.writeOption(writer1, {
          expiration: Math.floor(new Date().getTime() / 1000 + 60 * ONE_WEEK),
        }),
      ).to.be.revertedWith('Exp > 1 yr');
    });

    it('should fail if address does not have enough ether for call', async () => {
      await optionTestUtil.addEth();
      await weth.connect(writer1).deposit({ value: parseEther('0.99') });
      await weth
        .connect(writer1)
        .approve(premiaOption.address, parseEther('1'));
      await expect(optionTestUtil.writeOption(writer1)).to.be.revertedWith(
        'SafeERC20: low-level call failed',
      );
    });

    it('should fail if address does not have enough dai for put', async () => {
      await optionTestUtil.addEth();
      await dai.mint(writer1.address, parseEther('9.99'));
      await dai
        .connect(writer1)
        .increaseAllowance(premiaOption.address, parseEther('10'));
      await expect(
        optionTestUtil.writeOption(writer1, { isCall: false }),
      ).to.be.revertedWith('ERC20: transfer amount exceeds balance');
    });

    it('should successfully mint options for 2 weth', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      const balance = await premiaOption.balanceOf(writer1.address, 1);
      expect(balance).to.eq(parseEther('2'));
    });

    it('should be optionId 1', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      const defaults = optionTestUtil.getOptionDefaults();
      const optionId = await premiaOption.getOptionId(
        weth.address,
        defaults.expiration,
        defaults.strikePrice,
        defaults.isCall,
      );
      expect(optionId).to.eq(1);
    });

    it('should successfully batchWriteOption', async () => {
      await optionTestUtil.addEth();

      const defaultOption = optionTestUtil.getOptionDefaults();

      const contractAmount1 = parseEther('2');
      const contractAmount2 = parseEther('3');

      let amount = contractAmount1.add(contractAmount1.mul(tax).div(1e4));
      await weth.connect(writer1).deposit({ value: amount });
      await weth
        .connect(writer1)
        .approve(premiaOption.address, parseEther(amount.toString()));

      const baseAmount = contractAmount2.mul(10).mul(3);
      amount = baseAmount.add(baseAmount.mul(tax).div(1e4));
      await dai.mint(writer1.address, parseEther(amount.toString()));
      await dai
        .connect(writer1)
        .increaseAllowance(premiaOption.address, parseEther(amount.toString()));

      await premiaOption
        .connect(writer1)
        .setApprovalForAll(p.premiaOptionBatch.address, true);
      await p.premiaOptionBatch.connect(writer1).batchWriteOption(
        premiaOption.address,
        [
          {
            ...defaultOption,
            token: weth.address,
            isCall: true,
            amount: contractAmount1,
          },
          {
            ...defaultOption,
            token: weth.address,
            isCall: false,
            amount: contractAmount2,
          },
        ],
        ZERO_ADDRESS,
      );

      const balance1 = await premiaOption.balanceOf(writer1.address, 1);
      const balance2 = await premiaOption.balanceOf(writer1.address, 2);
      expect(balance1).to.eq(contractAmount1);
      expect(balance2).to.eq(contractAmount2);
    });

    it('should fail writeOptionFrom if not approved', async () => {
      await optionTestUtil.addEth();
      const amount = parseEther('2');
      const amountWithFee = amount.add(amount.mul(tax).div(1e4));
      await weth.connect(writer1).deposit({ value: amountWithFee });
      await weth.connect(writer1).approve(premiaOption.address, amountWithFee);

      await expect(
        premiaOption
          .connect(writer2)
          .writeOptionFrom(
            writer1.address,
            { ...optionTestUtil.getOptionDefaults(), amount },
            ZERO_ADDRESS,
          ),
      ).to.be.revertedWith('Not approved');
    });

    it('should successfully writeOptionFrom', async () => {
      await optionTestUtil.addEth();
      const amount = parseEther('2');
      const amountWithFee = amount.add(amount.mul(tax).div(1e4));
      await weth.connect(writer1).deposit({ value: amountWithFee });
      await weth.connect(writer1).approve(premiaOption.address, amountWithFee);

      await premiaOption
        .connect(writer1)
        .setApprovalForAll(writer2.address, true);
      await premiaOption
        .connect(writer2)
        .writeOptionFrom(
          writer1.address,
          { ...optionTestUtil.getOptionDefaults(), amount },
          ZERO_ADDRESS,
        );

      expect(await premiaOption.balanceOf(writer1.address, 1)).to.eq(amount);
      expect(await premiaOption.nbWritten(writer1.address, 1)).to.eq(amount);
    });
  });

  describe('cancelOption', () => {
    it('should successfully cancel 1 call option', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));

      let optionBalance = await premiaOption.balanceOf(writer1.address, 1);
      let ethBalance = await weth.balanceOf(writer1.address);

      expect(optionBalance).to.eq(parseEther('2'));
      expect(ethBalance).to.eq(0);

      await premiaOption.connect(writer1).cancelOption(1, parseEther('1'));

      optionBalance = await premiaOption.balanceOf(writer1.address, 1);
      ethBalance = await weth.balanceOf(writer1.address);

      expect(optionBalance).to.eq(parseEther('1'));
      expect(ethBalance.toString()).to.eq(parseEther('1'));
    });

    it('should successfully cancel 1 put option', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), false);

      let optionBalance = await premiaOption.balanceOf(writer1.address, 1);
      let daiBalance = await dai.balanceOf(writer1.address);

      expect(optionBalance).to.eq(parseEther('2'));
      expect(daiBalance).to.eq(0);

      await premiaOption.connect(writer1).cancelOption(1, parseEther('1'));

      optionBalance = await premiaOption.balanceOf(writer1.address, 1);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(optionBalance).to.eq(parseEther('1'));
      expect(daiBalance.toString()).to.eq(parseEther('10'));
    });

    it('should fail cancelling option if not a writer', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1);
      await expect(
        premiaOption.connect(user1).cancelOption(1, parseEther('1')),
      ).to.revertedWith('Not enough written');
    });

    it('should subtract option written after cancelling', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await premiaOption.connect(writer1).cancelOption(1, parseEther('1'));
      const nbWritten = await premiaOption.nbWritten(writer1.address, 1);
      expect(nbWritten).to.eq(parseEther('1'));
    });

    it('should successfully batchCancelOption', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('3'));
      await optionTestUtil.addEthAndWriteOptions(parseEther('3'), false);

      let optionBalance1 = await premiaOption.balanceOf(writer1.address, 1);
      let optionBalance2 = await premiaOption.balanceOf(writer1.address, 2);
      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);

      expect(optionBalance1).to.eq(parseEther('3'));
      expect(ethBalance).to.eq(0);
      expect(optionBalance2).to.eq(parseEther('3'));
      expect(daiBalance).to.eq(0);

      await premiaOption
        .connect(writer1)
        .setApprovalForAll(p.premiaOptionBatch.address, true);
      await p.premiaOptionBatch
        .connect(writer1)
        .batchCancelOption(
          premiaOption.address,
          [1, 2],
          [parseEther('2'), parseEther('1')],
        );

      optionBalance1 = await premiaOption.balanceOf(writer1.address, 1);
      optionBalance2 = await premiaOption.balanceOf(writer1.address, 2);

      ethBalance = await weth.balanceOf(writer1.address);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(optionBalance1).to.eq(parseEther('1'));
      expect(optionBalance2).to.eq(parseEther('2'));
      expect(ethBalance.toString()).to.eq(parseEther('2'));
      expect(daiBalance.toString()).to.eq(parseEther('10'));
    });

    it('should fail cancelOptionFrom if not approved', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), false);

      await expect(
        premiaOption
          .connect(writer2)
          .cancelOptionFrom(writer1.address, 1, parseEther('2')),
      ).to.be.revertedWith('Not approved');
    });

    it('should successfully cancelOptionFrom', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), false);

      await premiaOption
        .connect(writer1)
        .setApprovalForAll(writer2.address, true);
      await premiaOption
        .connect(writer2)
        .cancelOptionFrom(writer1.address, 1, parseEther('2'));

      expect(await premiaOption.balanceOf(writer1.address, 1)).to.eq(0);
    });
  });

  describe('exerciseOption', () => {
    it('should fail exercising call option if not owned', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await expect(
        premiaOption
          .connect(user1)
          .exerciseOption(1, parseEther('1'), ZERO_ADDRESS),
      ).to.revertedWith('ERC1155: burn amount exceeds balance');
    });

    it('should fail exercising call option if not enough dai', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1);
      await expect(
        premiaOption
          .connect(user1)
          .exerciseOption(1, parseEther('1'), ZERO_ADDRESS),
      ).to.revertedWith('ERC20: transfer amount exceeds balance');
    });

    it('should successfully exercise 1 call option', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('1'),
      );

      const optionBalance = await premiaOption.balanceOf(user1.address, 1);
      const daiBalance = await dai.balanceOf(user1.address);
      const ethBalance = await weth.balanceOf(user1.address);

      expect(optionBalance).to.eq(parseEther('1'));
      expect(daiBalance).to.eq(0);
      expect(ethBalance).to.eq(parseEther('1'));
    });

    it('should successfully exercise 1 put option', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        false,
        parseEther('2'),
        parseEther('1'),
      );

      const optionBalance = await premiaOption.balanceOf(user1.address, 1);
      const daiBalance = await dai.balanceOf(user1.address);
      const ethBalance = await weth.balanceOf(user1.address);

      expect(optionBalance).to.eq(parseEther('1'));
      expect(daiBalance).to.eq(parseEther('10'));
      expect(ethBalance).to.eq(0);
    });

    it('should have 0.01 eth and 0.1 dai in feeRecipient after 1 option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('1'),
        parseEther('1'),
      );

      const daiBalance = await dai.balanceOf(feeRecipient.address);
      const ethBalance = await weth.balanceOf(feeRecipient.address);

      expect(daiBalance).to.eq(parseEther('0.1'));
      expect(ethBalance).to.eq(parseEther('0.01'));
    });

    it('should have 0 eth and 0.1 dai in feeRecipient after 1 option exercised if writer is whitelisted', async () => {
      await p.feeCalculator.addWhitelisted([writer1.address]);
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('1'),
        parseEther('1'),
      );

      const daiBalance = await dai.balanceOf(feeRecipient.address);
      const ethBalance = await weth.balanceOf(feeRecipient.address);

      expect(daiBalance).to.eq(parseEther('0.1'));
      expect(ethBalance).to.eq(parseEther('0'));
    });

    it('should have 0.1 eth and 0 dai in feeRecipient after 1 option exercised if exerciser is whitelisted', async () => {
      await p.feeCalculator.addWhitelisted([user1.address]);
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('1'),
        parseEther('1'),
      );

      const daiBalance = await dai.balanceOf(feeRecipient.address);
      const ethBalance = await weth.balanceOf(feeRecipient.address);

      expect(daiBalance).to.eq(parseEther('0'));
      expect(ethBalance).to.eq(parseEther('0.01'));
    });

    it('should successfully batchExerciseOption', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), true);
      await optionTestUtil.addEthAndWriteOptions(parseEther('3'), false);

      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'), 1);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('3'), 2);

      let baseAmount = parseEther('10');
      let amount = parseEther('10').add(baseAmount.mul(tax).div(1e4));
      await dai.mint(user1.address, amount);
      await dai.connect(user1).increaseAllowance(premiaOption.address, amount);

      baseAmount = parseEther('2');
      amount = baseAmount.add(baseAmount.mul(tax).div(1e4));

      await weth.connect(user1).deposit({ value: amount });
      await weth.connect(user1).approve(premiaOption.address, amount);

      await premiaOption
        .connect(user1)
        .setApprovalForAll(p.premiaOptionBatch.address, true);
      await p.premiaOptionBatch
        .connect(user1)
        .batchExerciseOption(
          premiaOption.address,
          [1, 2],
          [parseEther('1'), parseEther('2')],
          ZERO_ADDRESS,
        );

      const optionBalance1 = await premiaOption.balanceOf(user1.address, 1);
      const optionBalance2 = await premiaOption.balanceOf(user1.address, 2);
      const daiBalance = await dai.balanceOf(user1.address);
      const ethBalance = await weth.balanceOf(user1.address);

      expect(optionBalance1).to.eq(parseEther('1'));
      expect(optionBalance2).to.eq(parseEther('1'));
      expect(daiBalance).to.eq(parseEther('20'));
      expect(ethBalance).to.eq(parseEther('1'));
    });

    it('should fail exerciseOptionFrom if not approved', async () => {
      const amount = parseEther('2');
      await optionTestUtil.addEthAndWriteOptions(amount, false);
      await optionTestUtil.transferOptionToUser1(writer1, amount);

      const amountTotal = amount.add(amount.mul(tax).div(1e4));

      await weth.connect(user1).deposit({ value: amountTotal });
      await weth.connect(user1).approve(premiaOption.address, amountTotal);

      await expect(
        premiaOption
          .connect(writer2)
          .exerciseOptionFrom(user1.address, 1, amount, ZERO_ADDRESS),
      ).to.be.revertedWith('Not approved');
    });

    it('should successfully exerciseOptionFrom', async () => {
      const amount = parseEther('2');
      await optionTestUtil.addEthAndWriteOptions(amount, false);
      await optionTestUtil.transferOptionToUser1(writer1, amount);

      const amountTotal = amount.add(amount.mul(tax).div(1e4));

      await weth.connect(user1).deposit({ value: amountTotal });
      await weth.connect(user1).approve(premiaOption.address, amountTotal);

      await premiaOption
        .connect(user1)
        .setApprovalForAll(writer2.address, true);
      await premiaOption
        .connect(writer2)
        .exerciseOptionFrom(user1.address, 1, amount, ZERO_ADDRESS);

      expect(await premiaOption.balanceOf(user1.address, 1)).to.eq(0);
      expect(await dai.balanceOf(user1.address)).to.eq(parseEther('20'));
      expect(await weth.balanceOf(premiaOption.address)).to.eq(parseEther('2'));
    });
  });

  describe('withdraw', () => {
    it('should fail withdrawing if option not expired', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('1'),
      );
      await expect(premiaOption.connect(writer1).withdraw(1)).to.revertedWith(
        'Not expired',
      );
    });

    it('should fail withdrawing from non-writer if option is expired', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1);
      await setTimestampPostExpiration();
      await expect(premiaOption.connect(user1).withdraw(1)).to.revertedWith(
        'No option to claim',
      );
    });

    it('should successfully allow writer withdrawal of 2 eth if 0/2 call option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await setTimestampPostExpiration();

      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);
      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(0);

      await premiaOption.connect(writer1).withdraw(1);

      ethBalance = await weth.balanceOf(writer1.address);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(ethBalance).to.eq(parseEther('2'));
      expect(daiBalance).to.eq(0);
    });

    it('should successfully allow writer withdrawal of 1 eth and 10 dai if 1/2 call option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('1'),
      );
      await setTimestampPostExpiration();

      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);
      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(0);

      await premiaOption.connect(writer1).withdraw(1);

      ethBalance = await weth.balanceOf(writer1.address);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(ethBalance).to.eq(parseEther('1'));
      expect(daiBalance).to.eq(parseEther('10'));
    });

    it('should successfully allow writer withdrawal of 20 dai if 2/2 call option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('2'),
      );
      await setTimestampPostExpiration();

      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);
      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(0);

      await premiaOption.connect(writer1).withdraw(1);

      ethBalance = await weth.balanceOf(writer1.address);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(parseEther('20'));
    });

    it('should successfully allow writer withdrawal of 20 dai if 0/2 put option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), false);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await setTimestampPostExpiration();

      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);
      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(0);

      await premiaOption.connect(writer1).withdraw(1);

      ethBalance = await weth.balanceOf(writer1.address);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(parseEther('20'));
    });

    it('should successfully allow writer withdrawal of 1 eth and 10 dai if 1/2 put option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        false,
        parseEther('2'),
        parseEther('1'),
      );
      await setTimestampPostExpiration();

      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);
      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(0);

      await premiaOption.connect(writer1).withdraw(1);

      ethBalance = await weth.balanceOf(writer1.address);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(ethBalance).to.eq(parseEther('1'));
      expect(daiBalance).to.eq(parseEther('10'));
    });

    it('should successfully allow writer withdrawal of 2 eth if 2/2 put option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        false,
        parseEther('2'),
        parseEther('2'),
      );
      await setTimestampPostExpiration();

      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);
      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(0);

      await premiaOption.connect(writer1).withdraw(1);

      ethBalance = await weth.balanceOf(writer1.address);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(ethBalance).to.eq(parseEther('2'));
      expect(daiBalance).to.eq(0);
    });

    it('should withdraw 0.5 eth and 5 dai if 1/2 option exercised and 2 different writers', async () => {
      await optionTestUtil.addEth();

      await optionTestUtil.mintAndWriteOption(writer1, parseEther('1'));
      await optionTestUtil.mintAndWriteOption(writer2, parseEther('1'));

      await optionTestUtil.transferOptionToUser1(writer1);
      await optionTestUtil.transferOptionToUser1(writer2);

      await optionTestUtil.exerciseOption(true, parseEther('1'));
      await setTimestampPostExpiration();

      await premiaOption.connect(writer1).withdraw(1);
      await premiaOption.connect(writer2).withdraw(1);

      const writer1Eth = await weth.balanceOf(writer1.address);
      const writer1Dai = await dai.balanceOf(writer1.address);

      const writer2Eth = await weth.balanceOf(writer2.address);
      const writer2Dai = await dai.balanceOf(writer2.address);

      expect(writer1Eth).to.eq(parseEther('0.5'));
      expect(writer1Dai).to.eq(parseEther('5'));

      expect(writer2Eth).to.eq(parseEther('0.5'));
      expect(writer2Dai).to.eq(parseEther('5'));
    });

    it('should withdraw 1 eth, if 1/2 call exercised and 1 withdrawPreExpiration', async () => {
      await optionTestUtil.addEth();
      await optionTestUtil.mintAndWriteOption(writer1, parseEther('1'));
      await optionTestUtil.mintAndWriteOption(writer2, parseEther('1'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('1'));
      await optionTestUtil.transferOptionToUser1(writer2, parseEther('1'));
      await optionTestUtil.exerciseOption(true, parseEther('1'));

      await premiaOption
        .connect(writer2)
        .withdrawPreExpiration(1, parseEther('1'));

      await setTimestampPostExpiration();

      await premiaOption.connect(writer1).withdraw(1);

      const daiBalance = await dai.balanceOf(writer1.address);
      const ethBalance = await weth.balanceOf(writer1.address);

      const nbWritten = await premiaOption.nbWritten(writer1.address, 1);

      expect(daiBalance).to.eq(0);
      expect(ethBalance).to.eq(parseEther('1'));
      expect(nbWritten).to.eq(0);
    });

    it('should withdraw 10 dai, if 1/2 put exercised and 1 withdrawPreExpiration', async () => {
      await optionTestUtil.addEth();
      await optionTestUtil.mintAndWriteOption(writer1, parseEther('1'), false);
      await optionTestUtil.mintAndWriteOption(writer2, parseEther('1'), false);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('1'));
      await optionTestUtil.transferOptionToUser1(writer2, parseEther('1'));
      await optionTestUtil.exerciseOption(false, parseEther('1'));

      await premiaOption
        .connect(writer2)
        .withdrawPreExpiration(1, parseEther('1'));

      await setTimestampPostExpiration();

      await premiaOption.connect(writer1).withdraw(1);

      const daiBalance = await dai.balanceOf(writer1.address);
      const ethBalance = await weth.balanceOf(writer1.address);

      const nbWritten = await premiaOption.nbWritten(writer1.address, 1);

      expect(daiBalance).to.eq(parseEther('10'));
      expect(ethBalance).to.eq(0);
      expect(nbWritten).to.eq(0);
    });

    it('should successfully batchWithdraw', async () => {
      await optionTestUtil.addEth();
      await optionTestUtil.mintAndWriteOption(writer1, parseEther('1'));
      await optionTestUtil.mintAndWriteOption(writer2, parseEther('1'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('1'));
      await optionTestUtil.transferOptionToUser1(writer2, parseEther('1'));
      await optionTestUtil.exerciseOption(true, parseEther('1'));

      await premiaOption
        .connect(writer2)
        .withdrawPreExpiration(1, parseEther('1'));

      await optionTestUtil.mintAndWriteOption(writer1, parseEther('1'), false);
      await optionTestUtil.mintAndWriteOption(writer2, parseEther('1'), false);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('1'), 2);
      await optionTestUtil.transferOptionToUser1(writer2, parseEther('1'), 2);
      await optionTestUtil.exerciseOption(false, parseEther('1'), undefined, 2);

      await premiaOption
        .connect(writer2)
        .withdrawPreExpiration(2, parseEther('1'));

      await setTimestampPostExpiration();

      await premiaOption
        .connect(writer1)
        .setApprovalForAll(p.premiaOptionBatch.address, true);
      await p.premiaOptionBatch
        .connect(writer1)
        .batchWithdraw(premiaOption.address, [1, 2]);

      const daiBalance = await dai.balanceOf(writer1.address);
      const ethBalance = await weth.balanceOf(writer1.address);
      const nbWritten1 = await premiaOption.nbWritten(writer1.address, 1);
      const nbWritten2 = await premiaOption.nbWritten(writer1.address, 2);

      expect(daiBalance).to.eq(parseEther('10'));
      expect(ethBalance).to.eq(parseEther('1'));
      expect(nbWritten1).to.eq(0);
      expect(nbWritten2).to.eq(0);
    });

    it('should fail withdrawFrom if not approved', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await setTimestampPostExpiration();

      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);
      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(0);

      await expect(
        premiaOption.connect(writer2).withdrawFrom(writer1.address, 1),
      ).to.be.revertedWith('Not approved');
    });

    it('should successfully withdrawFrom', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await setTimestampPostExpiration();

      let ethBalance = await weth.balanceOf(writer1.address);
      let daiBalance = await dai.balanceOf(writer1.address);
      expect(ethBalance).to.eq(0);
      expect(daiBalance).to.eq(0);

      await premiaOption
        .connect(writer1)
        .setApprovalForAll(writer2.address, true);
      await premiaOption.connect(writer2).withdrawFrom(writer1.address, 1);

      ethBalance = await weth.balanceOf(writer1.address);
      daiBalance = await dai.balanceOf(writer1.address);

      expect(ethBalance).to.eq(parseEther('2'));
      expect(daiBalance).to.eq(0);
    });
  });

  describe('withdrawPreExpiration', () => {
    it('should fail withdrawing if option is expired', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('1'),
      );
      await setTimestampPostExpiration();
      await expect(
        premiaOption.withdrawPreExpiration(1, parseEther('1')),
      ).to.revertedWith('Expired');
    });

    it('should fail withdrawing from non-writer if option is not expired', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1);
      await expect(
        premiaOption.connect(user1).withdrawPreExpiration(1, parseEther('1')),
      ).to.revertedWith('Not enough claims');
    });

    it('should fail withdrawing if no unclaimed exercised options', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));

      await expect(
        premiaOption.connect(writer1).withdrawPreExpiration(1, parseEther('2')),
      ).to.revertedWith('Not enough claimable');
    });

    it('should fail withdrawing if not enough unclaimed exercised options', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await optionTestUtil.exerciseOption(true, parseEther('1'));

      await expect(
        premiaOption.connect(writer1).withdrawPreExpiration(1, parseEther('2')),
      ).to.revertedWith('Not enough claimable');
    });

    it('should successfully withdraw 10 dai for withdrawPreExpiration of call option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await optionTestUtil.exerciseOption(true, parseEther('1'));

      await premiaOption
        .connect(writer1)
        .withdrawPreExpiration(1, parseEther('1'));

      const daiBalance = await dai.balanceOf(writer1.address);
      const ethBalance = await weth.balanceOf(writer1.address);

      const nbWritten = await premiaOption.nbWritten(writer1.address, 1);

      expect(daiBalance).to.eq(parseEther('10'));
      expect(ethBalance).to.eq(0);
      expect(nbWritten).to.eq(parseEther('1'));
    });

    it('should successfully withdraw 1 eth for withdrawPreExpiration of put option exercised', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), false);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await optionTestUtil.exerciseOption(false, parseEther('1'));

      await premiaOption
        .connect(writer1)
        .withdrawPreExpiration(1, parseEther('1'));

      const daiBalance = await dai.balanceOf(writer1.address);
      const ethBalance = await weth.balanceOf(writer1.address);

      const nbWritten = await premiaOption.nbWritten(writer1.address, 1);

      expect(daiBalance).to.eq(0);
      expect(ethBalance).to.eq(parseEther('1'));
      expect(nbWritten).to.eq(parseEther('1'));
    });

    it('should successfully batchWithdrawPreExpiration', async () => {
      await optionTestUtil.addEth();
      await optionTestUtil.mintAndWriteOption(writer1, parseEther('3'), true);
      await optionTestUtil.mintAndWriteOption(writer1, parseEther('3'), false);

      await optionTestUtil.transferOptionToUser1(writer1, parseEther('3'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('3'), 2);
      await optionTestUtil.exerciseOption(true, parseEther('2'));
      await optionTestUtil.exerciseOption(false, parseEther('1'), undefined, 2);

      await premiaOption
        .connect(writer1)
        .setApprovalForAll(p.premiaOptionBatch.address, true);
      await p.premiaOptionBatch
        .connect(writer1)
        .batchWithdrawPreExpiration(
          premiaOption.address,
          [1, 2],
          [parseEther('2'), parseEther('1')],
        );

      const daiBalance = await dai.balanceOf(writer1.address);
      const ethBalance = await weth.balanceOf(writer1.address);

      const nbWritten1 = await premiaOption.nbWritten(writer1.address, 1);
      const nbWritten2 = await premiaOption.nbWritten(writer1.address, 2);

      expect(daiBalance).to.eq(parseEther('20'));
      expect(ethBalance).to.eq(parseEther('1'));
      expect(nbWritten1).to.eq(parseEther('1'));
      expect(nbWritten2).to.eq(parseEther('2'));
    });

    it('should fail withdrawPreExpirationFrom if not approved', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await optionTestUtil.exerciseOption(true, parseEther('1'));

      await expect(
        premiaOption
          .connect(writer2)
          .withdrawPreExpirationFrom(writer1.address, 1, parseEther('1')),
      ).to.be.revertedWith('Not approved');
    });

    it('should successfully withdrawPreExpirationFrom', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));
      await optionTestUtil.exerciseOption(true, parseEther('1'));

      await premiaOption
        .connect(writer1)
        .setApprovalForAll(writer2.address, true);
      await premiaOption
        .connect(writer2)
        .withdrawPreExpirationFrom(writer1.address, 1, parseEther('1'));

      const daiBalance = await dai.balanceOf(writer1.address);
      const ethBalance = await weth.balanceOf(writer1.address);

      const nbWritten = await premiaOption.nbWritten(writer1.address, 1);

      expect(daiBalance).to.eq(parseEther('10'));
      expect(ethBalance).to.eq(0);
      expect(nbWritten).to.eq(parseEther('1'));
    });
  });

  describe('referral', () => {
    it('should register user1 as referrer', async () => {
      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        user1.address,
      );
      const referrer = await p.premiaReferral.referrals(writer1.address);
      expect(referrer).to.eq(user1.address);
    });

    it('should keep user1 as referrer, if try to set another referrer', async () => {
      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        user1.address,
      );
      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        writer2.address,
      );
      const referrer = await p.premiaReferral.referrals(writer1.address);
      expect(referrer).to.eq(user1.address);
    });

    it('should give user with referrer, 10% discount on write fee + give referrer 10% of fee', async () => {
      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        user1.address,
      );

      const writer1Options = await premiaOption.balanceOf(writer1.address, 1);
      const writer1Eth = await weth.balanceOf(writer1.address);
      const referrerEth = await weth.balanceOf(user1.address);

      expect(writer1Options).to.eq(parseEther('2'));
      expect(writer1Eth).to.eq(
        parseEther('0.02').div(10), // Expect 10% of tax of 2 options writing
      );
      expect(referrerEth).to.eq(
        parseEther('0.02').mul(9).div(10).div(10), // Expect 10% of 90% of tax for 2 options
      );
    });

    it('should give user with referrer, 10% discount on exercise fee + give referrer 10% of fee', async () => {
      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('2'),
        writer2.address,
      );

      const user1Options = await premiaOption.balanceOf(writer1.address, 1);
      const user1Dai = await dai.balanceOf(user1.address);
      const referrerDai = await dai.balanceOf(writer2.address);

      expect(user1Options).to.eq(0);
      expect(user1Dai).to.eq(
        BigNumber.from(parseEther('0.2')).div(10), // Expect 10% of the 1% tax of 2 options exercised at strike price of 10 DAI
      );
      expect(referrerDai).to.eq(
        parseEther('0.2').mul(9).div(10).div(10), // Expect 10% of 90% of tax
      );
    });
  });

  describe('fees', () => {
    it('should calculate total fee correctly without discount', async () => {
      const fee = await p.feeCalculator.getFeeAmounts(
        writer1.address,
        false,
        parseEther('2'),
        0,
      );

      expect(fee[0].add(fee[1])).to.eq(parseEther('0.02'));
    });

    it('should calculate total fee correctly with a referral', async () => {
      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        user1.address,
      );
      const fee = await p.feeCalculator.getFeeAmounts(
        writer1.address,
        true,
        parseEther('2'),
        0,
      );

      expect(fee[0].add(fee[1])).to.eq(parseEther('0.018'));
    });

    it('should correctly calculate total fee with a referral + staking discount', async () => {
      await premiaFeeDiscount.setDiscount(2000);
      const fee = await p.feeCalculator.getFeeAmounts(
        writer1.address,
        true,
        parseEther('2'),
        0,
      );

      expect(fee[0].add(fee[1])).to.eq(parseEther('0.0144'));
    });

    it('should correctly give a 30% discount from premia staking', async () => {
      await premiaFeeDiscount.setDiscount(3000);

      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('2'),
      );

      const user1Options = await premiaOption.balanceOf(writer1.address, 1);
      const user1Dai = await dai.balanceOf(user1.address);

      expect(user1Options).to.eq(0);
      expect(user1Dai).to.eq(
        BigNumber.from(parseEther('0.06')), // Expect 30% of the 1% tax of 2 options exercised at strike price of 10 DAI
      );
    });

    it('should correctly give a 30% discount from premia staking + 10% discount from referral', async () => {
      await premiaFeeDiscount.setDiscount(3000);

      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('2'),
        writer2.address,
      );

      const user1Options = await premiaOption.balanceOf(writer1.address, 1);
      const user1Dai = await dai.balanceOf(user1.address);
      const referrerDai = await dai.balanceOf(writer2.address);

      expect(user1Options).to.eq(0);
      expect(user1Dai).to.eq(
        BigNumber.from(parseEther('0.074')), // Expect 30% of the 1% tax of 2 options exercised at strike price of 10 DAI + 10% discount from referral
      );
      expect(referrerDai).to.eq(
        parseEther('0.0126'), // Expect 10% of 90% of tax (After premia staking discount)
      );
    });
  });

  describe('flashLoan', () => {
    it('should revert if loan not paid back', async () => {
      const flashLoanFactory = new TestFlashLoan__factory(writer1);

      const flashLoan = await flashLoanFactory.deploy();
      await flashLoan.setMode(2);

      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        user1.address,
      );

      let ethBalance = await weth.balanceOf(premiaOption.address);

      expect(ethBalance).to.eq(parseEther('2'));

      await expect(
        premiaOption.flashLoan(
          weth.address,
          parseEther('2'),
          flashLoan.address,
        ),
      ).to.be.revertedWith('Failed to pay back');
    });

    it('should revert if loan paid back without fee', async () => {
      const flashLoanFactory = new TestFlashLoan__factory(writer1);

      const flashLoan = await flashLoanFactory.deploy();
      await flashLoan.setMode(1);

      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        user1.address,
      );

      let ethBalance = await weth.balanceOf(premiaOption.address);

      expect(ethBalance).to.eq(parseEther('2'));

      await expect(
        premiaOption.flashLoan(
          weth.address,
          parseEther('2'),
          flashLoan.address,
        ),
      ).to.be.revertedWith('Failed to pay back');
    });

    it('should successfully complete flashLoan if paid back with fee', async () => {
      await p.feeCalculator.setWriteFee(0);
      const flashLoanFactory = new TestFlashLoan__factory(writer1);

      const flashLoan = await flashLoanFactory.deploy();
      await flashLoan.setMode(0);

      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        user1.address,
      );

      await weth.connect(admin).deposit({ value: parseEther('0.004') });
      await weth.transfer(flashLoan.address, parseEther('0.004'));

      let ethBalance = await weth.balanceOf(premiaOption.address);
      expect(ethBalance).to.eq(parseEther('2'));

      await premiaOption.flashLoan(
        weth.address,
        parseEther('2'),
        flashLoan.address,
      );

      ethBalance = await weth.balanceOf(premiaOption.address);
      expect(ethBalance).to.eq(parseEther('2'));

      const ethBalanceFeeRecipient = await weth.balanceOf(feeRecipient.address);
      expect(ethBalanceFeeRecipient).to.eq(parseEther('0.004'));
    });

    it('should successfully complete flashLoan if paid back without fee and user on fee whitelist', async () => {
      await p.feeCalculator.setWriteFee(0);
      const flashLoanFactory = new TestFlashLoan__factory(writer1);

      const flashLoan = await flashLoanFactory.deploy();
      await flashLoan.setMode(1);
      await p.feeCalculator.addWhitelisted([writer1.address]);

      await optionTestUtil.addEthAndWriteOptions(
        parseEther('2'),
        true,
        user1.address,
      );

      let ethBalance = await weth.balanceOf(premiaOption.address);
      expect(ethBalance).to.eq(parseEther('2'));

      await premiaOption
        .connect(writer1)
        .flashLoan(weth.address, parseEther('2'), flashLoan.address);

      ethBalance = await weth.balanceOf(premiaOption.address);
      expect(ethBalance).to.eq(parseEther('2'));

      const ethBalanceFeeRecipient = await weth.balanceOf(feeRecipient.address);
      expect(ethBalanceFeeRecipient).to.eq(0);
    });
  });

  describe('premiaUncut', () => {
    it('should not reward any uPremia if price not set for token in priceProvider', async () => {
      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      expect(await p.uPremia.balanceOf(writer1.address)).to.eq(0);
    });

    it('should reward uPremia on writeOption', async () => {
      await p.priceProvider.setTokenPrices(
        [dai.address, weth.address],
        [parseEther('1'), parseEther('10')],
      );

      await optionTestUtil.addEthAndWriteOptions(parseEther('2'));
      expect(await p.uPremia.balanceOf(writer1.address)).to.eq(
        parseEther('0.2'),
      );
    });

    it('should reward uPremia on exerciseOption', async () => {
      await p.priceProvider.setTokenPrices(
        [dai.address, weth.address],
        [parseEther('1'), parseEther('10')],
      );

      await optionTestUtil.addEthAndWriteOptionsAndExercise(
        true,
        parseEther('2'),
        parseEther('1'),
      );
      expect(await p.uPremia.balanceOf(writer1.address)).to.eq(
        parseEther('0.2'),
      );
      expect(await p.uPremia.balanceOf(user1.address)).to.eq(parseEther('0.1'));
    });
  });

  describe('flashExercise', () => {
    beforeEach(async () => {
      uniswap = await createUniswap(admin, dai, weth);
      await premiaOption.setWhitelistedUniswapRouters([uniswap.router.address]);
    });

    it('should successfully flash exercise if option in the money', async () => {
      // 1 ETH = 12 DAI
      await uniswap.dai.mint(uniswap.daiWeth.address, parseEther('1200'));
      await uniswap.weth.deposit({ value: parseEther('100') });
      await uniswap.weth.transfer(uniswap.daiWeth.address, parseEther('100'));
      await uniswap.daiWeth.mint(admin.address);

      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), true);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));

      await premiaOption
        .connect(user1)
        .flashExerciseOption(
          1,
          parseEther('1'),
          ZERO_ADDRESS,
          uniswap.router.address,
          parseEther('100000'),
        );

      const user1Weth = await uniswap.weth.balanceOf(user1.address);
      expect(
        user1Weth.gt(parseEther('0.148')) && user1Weth.lt(parseEther('0.149')),
      ).to.be.true;
      expect(await uniswap.dai.balanceOf(premiaOption.address)).to.eq(
        parseEther('10'),
      );
      expect(await premiaOption.balanceOf(user1.address, 1)).to.eq(
        parseEther('1'),
      );
    });

    it('should fail flash exercise if option not in the money', async () => {
      // 1 ETH = 8 DAI
      await uniswap.dai.mint(uniswap.daiWeth.address, parseEther('800'));
      await uniswap.weth.deposit({ value: parseEther('100') });
      await uniswap.weth.transfer(uniswap.daiWeth.address, parseEther('100'));
      await uniswap.daiWeth.mint(admin.address);

      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), true);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));

      await expect(
        premiaOption
          .connect(user1)
          .flashExerciseOption(
            1,
            parseEther('1'),
            ZERO_ADDRESS,
            uniswap.router.address,
            parseEther('100000'),
          ),
      ).to.be.revertedWith('UniswapV2Router: EXCESSIVE_INPUT_AMOUNT');
    });

    it('should fail flashExerciseFrom if not approved', async () => {
      // 1 ETH = 12 DAI
      await uniswap.dai.mint(uniswap.daiWeth.address, parseEther('1200'));
      await uniswap.weth.deposit({ value: parseEther('100') });
      await uniswap.weth.transfer(uniswap.daiWeth.address, parseEther('100'));
      await uniswap.daiWeth.mint(admin.address);

      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), true);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));

      await expect(
        premiaOption
          .connect(writer2)
          .flashExerciseOptionFrom(
            user1.address,
            1,
            parseEther('1'),
            ZERO_ADDRESS,
            uniswap.router.address,
            parseEther('100000'),
          ),
      ).to.be.revertedWith('Not approved');
    });

    it('should successfully flashExerciseFrom', async () => {
      // 1 ETH = 12 DAI
      await uniswap.dai.mint(uniswap.daiWeth.address, parseEther('1200'));
      await uniswap.weth.deposit({ value: parseEther('100') });
      await uniswap.weth.transfer(uniswap.daiWeth.address, parseEther('100'));
      await uniswap.daiWeth.mint(admin.address);

      await optionTestUtil.addEthAndWriteOptions(parseEther('2'), true);
      await optionTestUtil.transferOptionToUser1(writer1, parseEther('2'));

      await premiaOption
        .connect(user1)
        .setApprovalForAll(writer2.address, true);
      await premiaOption
        .connect(writer2)
        .flashExerciseOptionFrom(
          user1.address,
          1,
          parseEther('1'),
          ZERO_ADDRESS,
          uniswap.router.address,
          parseEther('100000'),
        );

      const user1Weth = await uniswap.weth.balanceOf(user1.address);
      expect(
        user1Weth.gt(parseEther('0.148')) && user1Weth.lt(parseEther('0.149')),
      ).to.be.true;
      expect(await uniswap.dai.balanceOf(premiaOption.address)).to.eq(
        parseEther('10'),
      );
      expect(await premiaOption.balanceOf(user1.address, 1)).to.eq(
        parseEther('1'),
      );
    });
  });
});
