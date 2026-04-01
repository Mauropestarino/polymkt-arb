import type { BotConfig } from "./config.js";

export const resolvePrivateKey = async (
  config: BotConfig,
): Promise<string | undefined> => {
  if (!config.useGcpSecretManager) {
    return config.privateKey;
  }

  if (!config.gcpPrivateKeySecretName) {
    throw new Error(
      "USE_GCP_SECRET_MANAGER=true requires GCP_PRIVATE_KEY_SECRET_NAME to be set.",
    );
  }

  const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: config.gcpPrivateKeySecretName,
  });

  const payload = version.payload?.data?.toString().trim();
  if (!payload) {
    throw new Error("Resolved GCP Secret Manager value for PRIVATE_KEY is empty.");
  }

  return payload;
};
