import crypto from "crypto";

// Derive a stable system token from the application secret so it remains
// consistent across process restarts. This is an internal token used only
// for background features such as session title summarization.
const seed =
  process.env.PROMPTGATE_SECRET || "dev_secret_key_which_is_32_bytes_!";
export const systemToken = crypto
  .createHash("sha256")
  .update("promptgate:system:" + seed)
  .digest("hex");
