
const express = require("express");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();
app.disable("x-powered-by");

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
const FieldValue = admin.firestore.FieldValue;

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

function validateCommonParameters(query) {
  const { user_id, token, signature } = query;

  if (
    typeof user_id !== "string" ||
    typeof token !== "string" ||
    typeof signature !== "string"
  ) {
    return false;
  }

  if (
    user_id.length === 0 ||
    user_id.length > 128 ||
    token.length === 0 ||
    token.length > 256
  ) {
    return false;
  }

  return true;
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).send(
    "MyContest PubScale Backend Running"
  );
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
    const {
      user_id,
      value,
      token,
      signature,
    } = req.query;

    // Validate parameters
    if (!validateCommonParameters(req.query)) {
      return res.status(400).send("Invalid parameters");
    }

    // Validate reward
    const rewardValue = parsePositiveValue(value);

    if (rewardValue === null) {
      return res.status(400).send("Invalid reward value");
    }

    const integerValue = Math.trunc(rewardValue);

    if (integerValue <= 0) {
      return res.status(400).send("Invalid integer reward");
    }

    // Verify PubScale signature
    const valid = isValidSignature({
      userId: user_id,
      integerValue,
      token,
      signature,
    });

    if (!valid) {
      console.error("PubScale reward signature verification failed");
      return res.status(403).send("Invalid signature");
    }

    // Firebase UID must be used as PubScale unique_id.
    const firebaseUid = user_id;

    const transactionId = hashId(token);

    const transactionRef = pubscaleTransactions
      .doc(transactionId);

    const userRef = pubscaleUsers
      .doc(firebaseUid);

    // Atomic reward credit and duplicate protection
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

      if (
        !Number.isFinite(previousEarned) ||
        !Number.isFinite(previousOffers)
      ) {
        throw new Error("Invalid existing PubScale user balance");
      }

      tx.set(
        userRef,
        {
          unique_id: firebaseUid,
          total_earned: previousEarned + rewardValue,
          total_offers: previousOffers + 1,
          updated_at: FieldValue.serverTimestamp(),
          last_offer_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.create(transactionRef, {
        provider: "pubscale",
        event_type: "reward",
        user_id: firebaseUid,
        token,
        reward_value: rewardValue,
        signature_verified: true,
        status: "credited_to_pubscale_balance",
        created_at: FieldValue.serverTimestamp(),
      });

      return "credited";
    });

    if (result === "duplicate") {
      console.log("Duplicate PubScale reward:", transactionId);
      return res.status(200).send("Duplicate transaction");
    }

    console.log(
      "PubScale reward credited:",
      firebaseUid,
      rewardValue
    );

    return res.status(200).send("OK");

  } catch (error) {
    console.error(
      "PubScale reward callback error:",
      error.message
    );

    return res.status(500).send("Internal server error");
  }
});

// --------------------------------------------------
// CHARGEBACK CALLBACK
// --------------------------------------------------

app.get("/pubscale/chargeback", async (req, res) => {
  try {
    const {
      user_id,
      value,
      token,
      signature,
    } = req.query;

    // Validate parameters
    if (!validateCommonParameters(req.query)) {
      return res.status(400).send("Invalid parameters");
    }

    // Chargeback value may be positive or negative.
    const callbackValue = parseSignedValue(value);

    if (callbackValue === null) {
      return res.status(400).send("Invalid chargeback value");
    }

    const integerValue = Math.trunc(callbackValue);

    if (integerValue === 0) {
      return res.status(400).send("Invalid integer chargeback value");
    }

    // Verify chargeback signature
    const valid = isValidSignature({
      userId: user_id,
      integerValue,
      token,
      signature,
    });

    if (!valid) {
      console.error("PubScale chargeback signature verification failed");
      return res.status(403).send("Invalid signature");
    }

    const firebaseUid = user_id;
    const reversalAmount = Math.abs(callbackValue);

    // IMPORTANT:
    // This implementation assumes PubScale sends the original
    // reward token in its chargeback callback.
    const transactionId = hashId(token);
    const reversalId = hashId(`chargeback:${token}`);

    const originalRef = pubscaleTransactions
      .doc(transactionId);

    const reversalRef = pubscaleTransactions
      .doc(reversalId);

    const userRef = pubscaleUsers
      .doc(firebaseUid);

    const result = await db.runTransaction(async (tx) => {
      // All reads happen before writes.
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

      const userData = userSnapshot.data();

      const currentEarned = Number(userData.total_earned || 0);
      const currentReversed = Number(userData.total_reversed || 0);

      if (
        !Number.isFinite(currentEarned) ||
        !Number.isFinite(currentReversed)
      ) {
        throw new Error("Invalid PubScale user balance");
      }

      // Reverse only the separate PubScale balance.
      tx.update(userRef, {
        total_earned: currentEarned - reversalAmount,
        total_reversed: currentReversed + reversalAmount,
        updated_at: FieldValue.serverTimestamp(),
      });

      // Mark original transaction as reversed.
      tx.update(originalRef, {
        status: "reversed",
        reversed_at: FieldValue.serverTimestamp(),
      });

      // Save separate chargeback history.
      tx.create(reversalRef, {
        provider: "pubscale",
        event_type: "chargeback",
        user_id: firebaseUid,
        token,
        reward_value: -reversalAmount,
        signature_verified: true,
        status: "reversed_from_pubscale_balance",
        original_transaction_id: transactionId,
        created_at: FieldValue.serverTimestamp(),
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
      return res.status(404).send("PubScale user not found");
    }

    console.log(
      "PubScale chargeback processed:",
      firebaseUid,
      reversalAmount
    );

    return res.status(200).send("OK");

  } catch (error) {
    console.error(
      "PubScale chargeback error:",
      error.message
    );

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
