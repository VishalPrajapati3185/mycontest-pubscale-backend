
const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

const PORT = process.env.PORT || 3000;
const PUBSCALE_SECRET_KEY = process.env.PUBSCALE_SECRET_KEY;

// --------------------------------------------------
// FIREBASE ADMIN INITIALIZATION
// --------------------------------------------------

if (!PUBSCALE_SECRET_KEY) {
  throw new Error("Missing PUBSCALE_SECRET_KEY");
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
} catch (error) {
  throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// --------------------------------------------------
// FIRESTORE PATHS
// --------------------------------------------------

const pubscaleRoot = db
  .collection("Offerwall")
  .doc("pubscale");

const pubscaleUsers = pubscaleRoot
  .collection("pubscale_users");

const pubscaleTransactions = pubscaleRoot
  .collection("pubscale_transactions");

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).send("MyContest PubScale Backend Running");
});

app.get("/pubscale/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "MyContest PubScale Backend",
    status: "running",
  });
});

// --------------------------------------------------
// PUBSCALE SIGNATURE VERIFICATION
// --------------------------------------------------

function verifyPubScaleSignature({
  userId,
  integerValue,
  token,
  receivedSignature,
}) {
  if (
    typeof receivedSignature !== "string" ||
    !/^[a-fA-F0-9]{32}$/.test(receivedSignature)
  ) {
    return false;
  }

  const signatureTemplate =
    `${PUBSCALE_SECRET_KEY}.${userId}.${integerValue}.${token}`;

  const expectedSignature = crypto
    .createHash("md5")
    .update(signatureTemplate)
    .digest("hex");

  const expectedBuffer = Buffer.from(
    expectedSignature,
    "hex"
  );

  const receivedBuffer = Buffer.from(
    receivedSignature,
    "hex"
  );

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(
      expectedBuffer,
      receivedBuffer
    )
  );
}

// --------------------------------------------------
// PUBSCALE S2S CALLBACK
// --------------------------------------------------

app.get("/pubscale/callback", async (req, res) => {
  try {
    const {
      user_id,
      value,
      token,
      signature,
    } = req.query;

    // 1. Validate required parameters

    if (
      typeof user_id !== "string" ||
      typeof value !== "string" ||
      typeof token !== "string" ||
      typeof signature !== "string"
    ) {
      return res.status(400).send("Missing or invalid parameters");
    }

    if (
      user_id.length === 0 ||
      user_id.length > 128 ||
      token.length === 0 ||
      token.length > 256
    ) {
      return res.status(400).send("Invalid user or token");
    }

    // 2. Validate reward value

    // Accept ordinary positive decimal numbers only.
    if (!/^\d+(\.\d+)?$/.test(value)) {
      return res.status(400).send("Invalid reward value");
    }

    const rewardValue = Number(value);

    if (
      !Number.isFinite(rewardValue) ||
      rewardValue <= 0
    ) {
      return res.status(400).send("Invalid reward value");
    }

    // PubScale signature uses the integer part of value.
    const integerValue = Math.trunc(rewardValue);

    if (integerValue <= 0) {
      return res.status(400).send("Invalid integer reward value");
    }

    // 3. Verify signature

    const isValidSignature = verifyPubScaleSignature({
      userId: user_id,
      integerValue,
      token,
      receivedSignature: signature,
    });

    if (!isValidSignature) {
      console.error("PubScale signature verification failed");
      return res.status(403).send("Signature verification failed");
    }

    // 4. Use Firebase UID as PubScale unique_id.
    // Flutter SDK must initialize PubScale with currentUser.uid.

    const firebaseUid = user_id;

    // 5. Create a stable transaction document ID.
    // This prevents duplicate reward credits on callback retries.

    const transactionId = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const transactionRef = pubscaleTransactions
      .doc(transactionId);

    const userRef = pubscaleUsers
      .doc(firebaseUid);

    // 6. Atomically save transaction and update PubScale balance.

    const result = await db.runTransaction(async (transaction) => {
      const existingTransaction = await transaction.get(
        transactionRef
      );

      // Duplicate callback: do not credit again.
      if (existingTransaction.exists) {
        return "duplicate";
      }

      const userSnapshot = await transaction.get(userRef);

      const previousEarned = userSnapshot.exists
        ? Number(userSnapshot.data().total_earned || 0)
        : 0;

      const previousOffers = userSnapshot.exists
        ? Number(userSnapshot.data().total_offers || 0)
        : 0;

      const newTotalEarned = previousEarned + rewardValue;
      const newTotalOffers = previousOffers + 1;

      // PubScale user's separate balance document.
      transaction.set(
        userRef,
        {
          unique_id: firebaseUid,
          total_earned: newTotalEarned,
          total_offers: newTotalOffers,
          last_offer_at: admin.firestore.FieldValue.serverTimestamp(),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Verified PubScale transaction record.
      transaction.create(
        transactionRef,
        {
          provider: "pubscale",
          user_id: firebaseUid,
          token: token,
          reward_value: rewardValue,
          signature_verified: true,
          status: "credited_to_pubscale_balance",
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        }
      );

      return "credited";
    });

    // 7. Callback response

    if (result === "duplicate") {
      console.log("Duplicate PubScale transaction:", transactionId);
      return res.status(200).send("Duplicate transaction");
    }

    console.log(
      "PubScale reward credited to separate balance:",
      firebaseUid,
      rewardValue
    );

    return res.status(200).send("OK");

  } catch (error) {
    console.error("PubScale callback error:", error.message);
    return res.status(500).send("Internal server error");
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `MyContest PubScale Backend running on port ${PORT}`
  );
});
