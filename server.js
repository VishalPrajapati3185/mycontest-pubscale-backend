const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const PUBSCALE_SECRET_KEY = process.env.PUBSCALE_SECRET_KEY;

// Firebase Admin initialization
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
}

const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Health check
app.get("/pubscale/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "MyContest PubScale Backend",
    status: "running",
  });
});

// PubScale S2S Callback
app.get("/pubscale/callback", async (req, res) => {
  try {
    const { user_id, value, token, signature } = req.query;

    // Required fields
    if (!user_id || !value || !token || !signature) {
      return res.status(400).send("Missing parameters");
    }

    if (!PUBSCALE_SECRET_KEY) {
      console.error("PubScale secret key is missing");
      return res.status(500).send("Server configuration error");
    }

    // Validate reward value
    const rewardValue = Number(value);

    if (!Number.isFinite(rewardValue) || rewardValue <= 0) {
      return res.status(400).send("Invalid reward value");
    }

    // PubScale signature uses integer reward value
    const integerValue = Math.trunc(rewardValue);

    // Generate expected MD5 signature
    const signatureTemplate =
      `${PUBSCALE_SECRET_KEY}.${user_id}.${integerValue}.${token}`;

    const expectedSignature = crypto
      .createHash("md5")
      .update(signatureTemplate)
      .digest("hex");

    // Validate signature format
    if (!/^[a-fA-F0-9]{32}$/.test(signature)) {
      return res.status(403).send("Invalid signature");
    }

    // Constant-time signature comparison
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const receivedBuffer = Buffer.from(signature, "hex");

    if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return res.status(403).send("Signature verification failed");
    }

    // Unique transaction ID
    const transactionId = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const transactionRef = db
      .collection("pubscale_transactions")
      .doc(transactionId);

    // Save verified callback only once
    try {
      await transactionRef.create({
        provider: "pubscale",
        userId: user_id,
        token: token,
        rewardValue: rewardValue,
        signature: signature,
        status: "verified_pending_credit",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      if (error.code === 6 || error.code === "already-exists") {
        return res.status(200).send("Duplicate transaction");
      }

      throw error;
    }

    console.log("PubScale callback verified and stored");

    return res.status(200).send("OK");

  } catch (error) {
    console.error("PubScale callback error:", error.message);
    return res.status(500).send("Internal server error");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`PubScale server running on port ${PORT}`);
});
