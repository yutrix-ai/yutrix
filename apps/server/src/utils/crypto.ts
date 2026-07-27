import crypto from "crypto";

// Use the application secret as the encryption key
const algorithm = "aes-256-gcm";
const getSecret = () => {
  const secret = process.env.PROMPTGATE_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.warn(
        "[PromptGate] WARNING: PROMPTGATE_SECRET is not set in production. Using insecure fallback. Set a strong secret with: openssl rand -hex 32",
      );
    }
    // Keep the previous fallback for maximum backward compatibility
    return crypto
      .createHash("sha256")
      .update("dev_secret_key_which_is_32_bytes_!")
      .digest();
  }
  return crypto.createHash("sha256").update(secret).digest();
};

export function encryptText(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, getSecret(), iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  // Format: iv:authTag:encryptedData
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decryptText(encryptedText: string): string {
  try {
    const parts = encryptedText.split(":");
    if (parts.length !== 3) throw new Error("Invalid encrypted text format");

    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(algorithm, getSecret(), iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    console.error("Failed to decrypt text:", error);
    return "";
  }
}
