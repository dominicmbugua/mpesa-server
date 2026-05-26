require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const db      = require("./db");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── API Key guard ──────────────────────────────────────────────────────
// All routes except the Safaricom callback require an API key.
// Safaricom doesn't send an API key so /mpesa/c2b is unguarded
// but validated by checking the payload structure instead.
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 1 — Safaricom C2B callback
// Safaricom POSTs here when a customer pays to your Till/Paybill.
// Must respond with { ResultCode: 0 } quickly or Safaricom retries.
// ═══════════════════════════════════════════════════════════════════════
app.post("/mpesa/c2b", (req, res) => {
  try {
    const body = req.body;
    console.log("[C2B] Incoming payment:", JSON.stringify(body, null, 2));

    // Safaricom sends different fields for Paybill vs Till
    const transactionId   = body.TransID            || body.TransactionID || "";
    const amount          = parseFloat(body.TransAmount || body.Amount || 0);
    const phone           = body.MSISDN             || body.PhoneNumber   || "";
    const firstName       = body.FirstName          || "";
    const middleName      = body.MiddleName         || "";
    const lastName        = body.LastName           || "";
    const customerName    = [firstName, middleName, lastName].filter(Boolean).join(" ") || "Unknown";
    const accountRef      = body.BillRefNumber      || body.AccountReference || "";
    const shortCode       = body.BusinessShortCode  || body.PartyB           || "";
    const transactionTime = body.TransTime          || new Date().toISOString();

    if (!transactionId || amount <= 0) {
      // Invalid payload — still return success so Safaricom doesn't retry
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    // Store in DB (ignore duplicates)
    db.insertPayment({
      transaction_id:   transactionId,
      amount,
      phone,
      customer_name:    customerName,
      account_ref:      accountRef,
      short_code:       shortCode,
      transaction_time: transactionTime,
      raw:              JSON.stringify(body),
    });

    console.log(`[C2B] Saved: ${transactionId} | ${customerName} | KES ${amount}`);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (err) {
    console.error("[C2B] Error:", err);
    // Always return success to Safaricom even on our errors
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 2 — POS polls this to check for a pending payment
// The POS sends the expected amount and optional account ref.
// Returns the most recent unmatched payment that fits.
// ═══════════════════════════════════════════════════════════════════════
app.get("/mpesa/payment", requireApiKey, (req, res) => {
  const amount     = parseFloat(req.query.amount     || "0");
  const accountRef = (req.query.account_ref || "").trim();
  const shortCode  = (req.query.short_code  || "").trim();

  if (amount <= 0) {
    return res.status(400).json({ error: "amount is required" });
  }

  const payment = db.findPendingPayment({ amount, accountRef, shortCode });

  if (!payment) {
    return res.json({ found: false });
  }

  res.json({
    found:            true,
    transaction_id:   payment.transaction_id,
    amount:           payment.amount,
    phone:            payment.phone,
    customer_name:    payment.customer_name,
    account_ref:      payment.account_ref,
    transaction_time: payment.transaction_time,
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 3 — POS confirms it has consumed a payment
// Call this after the sale is saved so the payment isn't matched again.
// ═══════════════════════════════════════════════════════════════════════
app.post("/mpesa/payment/confirm", requireApiKey, (req, res) => {
  const { transaction_id } = req.body;
  if (!transaction_id) {
    return res.status(400).json({ error: "transaction_id is required" });
  }
  db.markPaymentUsed(transaction_id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 4 — Register C2B URLs with Safaricom (run once per shortcode)
// POST { consumer_key, consumer_secret, short_code, environment }
// ═══════════════════════════════════════════════════════════════════════
app.post("/mpesa/register", requireApiKey, async (req, res) => {
  const { consumer_key, consumer_secret, short_code, environment } = req.body;

  if (!consumer_key || !consumer_secret || !short_code) {
    return res.status(400).json({ error: "consumer_key, consumer_secret and short_code are required" });
  }

  const baseUrl = environment === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

  const serverUrl = process.env.SERVER_URL || `https://${req.headers.host}`;

  try {
    // Step 1 — get token
    const credentials = Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64");
    const tokenRes    = await fetch(
      `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${credentials}` } }
    );
    const tokenData = await tokenRes.json();
    const token     = tokenData.access_token;

    if (!token) {
      return res.status(400).json({ error: "Could not get token", detail: tokenData });
    }

    // Step 2 — register URLs
    const payload = {
      ShortCode:       short_code,
      ResponseType:    "Completed",
      ConfirmationURL: `${serverUrl}/mpesa/c2b`,
      ValidationURL:   `${serverUrl}/mpesa/c2b`,
    };

    const regRes  = await fetch(`${baseUrl}/mpesa/c2b/v1/registerurl`, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const regData = await regRes.json();

    console.log("[Register] Response:", regData);
    res.json({ ok: true, response: regData, registered_url: `${serverUrl}/mpesa/c2b` });

  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 5 — Health check
// ═══════════════════════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── Start ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`M-PESA C2B server running on port ${PORT}`);
});
