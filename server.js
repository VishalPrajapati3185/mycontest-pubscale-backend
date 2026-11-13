
const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

const PORT = process.env.PORT || 3000;
const PUBSCALE_SECRET_KEY = process.env.PUBSCALE_SECRET_KEY;

// --------------------------------------------------
// FIREBASE INITIALIZATION
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
// HELPERS
// --------------------------------------------------

function hashId(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function isValidSignature({
  userId,
  integerValue,
  token,
  signature,
}) {
  if (
    typeof signature !== "string" ||
    !/^[a-fA-F0-9]{32}$/.test(signature)
  ) {
    return false;
  }

  const template =
    `${PUBSCALE_SECRET_KEY}.${userId}.${integerValue}.${token}`;

  const expected = crypto
    .createHash("md5")
    .update(template)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(signature, "hex");

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function parsePositiveValue(value) {
  if (
    typeof value !== "string" ||
    !/^\d+(\.\d+)?$/.test(value)
  ) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  return number;
}

function parseSignedValue(value) {
  if (
    typeof value !== "string" ||
    !/^-?\d+(\.\d+)?$/.test(value)
  ) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number) || number === 0) {
    return null;
  }

  return number;
}

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
// REWARD CALLBACK
// --------------------------------------------------

app.get("/pubscale/callback", async (req, res) => {
  try {
    const { user_id, value, token, signature } = req.query;

    if (
      typeof user_id !== "string" ||
      typeof token !== "string" ||
      typeof signature !== "string"
    ) {
      return res.status(400).send("Missing parameters");
    }

    if (
      user_id.length === 0 ||
      user_id.length > 128 ||
      token.length === 0 ||
      token.length > 256
    ) {
      return res.status(400).send("Invalid parameters");
    }

    const rewardValue = parsePositiveValue(value);

    if (rewardValue === null) {
      return res.status(400).send("Invalid reward value");
    }

    const integerValue = Math.trunc(rewardValue);

    if (integerValue <= 0) {
      return res.status(400).send("Invalid integer reward");
    }

    const valid = isValidSignature({
      userId: user_id,
      integerValue,
      token,
      signature,
    });

    if (!valid) {
      console.error("PubScale reward signature failed");
      return res.status(403).send("Invalid signature");
    }

    // Firebase UID must be passed as PubScale unique_id.
    const firebaseUid = user_id;

    const transactionId = hashId(token);

    const transactionRef = pubscaleTransactions
      .doc(transactionId);

    const userRef = pubscaleUsers
      .doc(firebaseUid);

    const result = await db.runTransaction(async (tx) => {
      const existing = await tx.get(transactionRef);

      if (existing.exists) {
        return "duplicate";
      }

      const userSnapshot = await tx.get(userRef);

      const previousEarned = userSnapshot.exists
        ? Number(userSnapshot.data().total_earned || 0)
        : 0;

      const previousOffers = userSnapshot.exists
        ? Number(userSnapshot.data().total_offers || 0)
        : 0;

      tx.set(
        userRef,
        {
          unique_id: firebaseUid,
          total_earned: previousEarned + rewardValue,
          total_offers: previousOffers + 1,
          updated_at:
            admin.firestore.FieldValue.serverTimestamp(),
          last_offer_at:
            admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.create(transactionRef, {
        provider: "pubscale",
        user_id: firebaseUid,
        token,
        reward_value: rewardValue,
        signature_verified: true,
        status: "credited_to_pubscale_balance",
        created_at:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      return "credited";
    });

    if (result === "duplicate") {
      return res.status(200).send("Duplicate transaction");
    }

    console.log("PubScale reward credited:", firebaseUid);

    return res.status(200).send("OK");

  } catch (error) {
    console.error("PubScale reward callback error:", error.message);
    return res.status(500).send("Internal server error");
  }
});

// --------------------------------------------------
// CHARGEBACK CALLBACK
// --------------------------------------------------

app.get("/pubscale/chargeback", async (req, res) => {
  try {
    const { user_id, value, token, signature } = req.query;

    if (
      typeof user_id !== "string" ||
      typeof token !== "string" ||
      typeof signature !== "string"
    ) {
      return res.status(400).send("Missing parameters");
    }

    if (
      user_id.length === 0 ||
      user_id.length > 128 ||
      token.length === 0 ||
      token.length > 256
    ) {
      return res.status(400).send("Invalid parameters");
    }

    const callbackValue = parseSignedValue(value);

    if (callbackValue === null) {
      return res.status(400).send("Invalid chargeback value");
    }

    const integerValue = Math.trunc(callbackValue);

    if (integerValue === 0) {
      return res.status(400).send("Invalid integer chargeback value");
    }

    const valid = isValidSignature({
      userId: user_id,
      integerValue,
      token,
      signature,
    });

    if (!valid) {
      console.error("PubScale chargeback signature failed");
      return res.status(403).send("Invalid signature");
    }

    const firebaseUid = user_id;
    const reversalAmount = Math.abs(callbackValue);

    // Assumption: PubScale sends the ORIGINAL reward token.
    const transactionId = hashId(token);

    const originalRef = pubscaleTransactions
      .doc(transactionId);

    // Separate idempotency key for the reversal event.
    const reversalId = hashId(`chargeback:${token}`);

    const reversalRef = pubscaleTransactions
      .doc(reversalId);

    const userRef = pubscaleUsers
      .doc(firebaseUid);

    const result = await db.runTransaction(async (tx) => {
      const reversalSnapshot = await tx.get(reversalRef);

      if (reversalSnapshot.exists) {
        return "duplicate";
      }

      const originalSnapshot = await tx.get(originalRef);

      if (!originalSnapshot.exists) {
        return "original_not_found";
      }

      const original = originalSnapshot.data();

      if (original.user_id !== firebaseUid) {
        return "user_mismatch";
      }

      if (original.status !== "credited_to_pubscale_balance") {
        return "already_reversed";
      }

      const originalAmount = Number(original.reward_value);

      // Do not reverse an amount different from the original credit.
      if (
        !Number.isFinite(originalAmount) ||
        Math.abs(originalAmount - reversalAmount) > 0.000001
      ) {
        return "amount_mismatch";
      }

      const userSnapshot = await tx.get(userRef);

      if (!userSnapshot.exists) {
        return "user_not_found";
      }

      const currentEarned = Number(
        userSnapshot.data().total_earned || 0
      );

      const currentReversed = Number(
        userSnapshot.data().total_reversed || 0
      );

      // A reversal may make the separate balance negative.
      // This preserves the full reversal amount.
      tx.update(userRef, {
        total_earned: currentEarned - reversalAmount,
        total_reversed: currentReversed + reversalAmount,
        updated_at:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.update(originalRef, {
        status: "reversed",
        reversed_at:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.create(reversalRef, {
        provider: "pubscale",
        event_type: "chargeback",
        user_id: firebaseUid,
        token,
        reward_value: -reversalAmount,
        signature_verified: true,
        status: "reversed_from_pubscale_balance",
        original_transaction_id: transactionId,
        created_at:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      return "reversed";
    });

    if (result === "duplicate") {
      return res.status(200).send("Duplicate chargeback");
    }

    if (result === "original_not_found") {
      return res.status(404).send("Original transaction not found");
    }

    if (result === "user_mismatch") {
      return res.status(403).send("User mismatch");
    }

    if (result === "already_reversed") {
      return res.status(200).send("Already reversed");
    }

    if (result === "amount_mismatch") {
      return res.status(400).send("Chargeback amount mismatch");
    }

    if (result === "user_not_found") {
      return res.status(404).send("User balance not found");
    }

    console.log("PubScale chargeback processed:", firebaseUid);

    return res.status(200).send("OK");

  } catch (error) {
    console.error("PubScale chargeback error:", error.message);
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
