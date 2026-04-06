import { describe, expect, it, vi } from "vitest";
import { config as baseConfig, type BotConfig } from "../config.js";
import { CtfSettlementService } from "../ctfSettlement.js";
import type { WalletService } from "../wallet.js";

const createConfig = (overrides: Partial<BotConfig> = {}): BotConfig => ({
  ...baseConfig,
  ctfContractAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  usdcCollateralAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  polygonRpcUrl: "https://polygon-rpc.example",
  ...overrides,
});

const createLoggerStub = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as const;

describe("ctf settlement service", () => {
  it("submits mergePositions for the binary full-set partition", async () => {
    const mergePositions = vi.fn().mockResolvedValue({
      hash: "0xmerge",
      wait: vi.fn().mockResolvedValue({
        status: 1,
        blockNumber: 123,
        gasUsed: 42000n,
      }),
    });

    const service = new CtfSettlementService(
      createConfig(),
      {
        hasOnchainSigner: vi.fn().mockReturnValue(true),
        requireOnchainSigner: vi.fn(),
      } as unknown as WalletService,
      createLoggerStub() as never,
      () =>
        ({
          mergePositions,
          splitPosition: vi.fn(),
          redeemPositions: vi.fn(),
          isApprovedForAll: vi.fn().mockResolvedValue(true),
        }) as never,
    );

    const receipt = await service.mergeFullSet(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      5,
    );

    expect(mergePositions).toHaveBeenCalledWith(
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      expect.any(String),
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      [1, 2],
      5000000n,
    );
    expect(receipt).toMatchObject({
      action: "merge",
      conditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      amount: 5,
      txHash: "0xmerge",
      blockNumber: 123,
      gasUsed: "42000",
    });
  });

  it("submits convertPositions for neg-risk conversion after approval is present", async () => {
    const convertPositions = vi.fn().mockResolvedValue({
      hash: "0xconvert",
      wait: vi.fn().mockResolvedValue({
        status: 1,
        blockNumber: 456,
        gasUsed: 43000n,
      }),
    });

    const service = new CtfSettlementService(
      createConfig({
        negRiskAdapterAddress: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
      }),
      {
        hasOnchainSigner: vi.fn().mockReturnValue(true),
        requireOnchainSigner: vi.fn().mockReturnValue({
          getAddress: vi.fn().mockResolvedValue("0xabc"),
        }),
      } as unknown as WalletService,
      createLoggerStub() as never,
      () =>
        ({
          mergePositions: vi.fn(),
          splitPosition: vi.fn(),
          redeemPositions: vi.fn(),
          isApprovedForAll: vi.fn().mockResolvedValue(true),
        }) as never,
      () =>
        ({
          convertPositions,
        }) as never,
    );

    const receipt = await service.convertNegRiskPosition(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222222222222222222222222222",
      2,
      5,
    );

    expect(convertPositions).toHaveBeenCalledWith(
      "0x2222222222222222222222222222222222222222222222222222222222222222",
      4n,
      5000000n,
    );
    expect(receipt).toMatchObject({
      action: "convert",
      conditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      amount: 5,
      txHash: "0xconvert",
      blockNumber: 456,
      gasUsed: "43000",
    });
  });
});
