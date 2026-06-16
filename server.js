require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const db      = require("./db");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 1 — Safaricom C2B callback
// ═══════════════════════════════════════════════════════════════════════
app.post("/notify/payment", (req, res) => {
  try {
    const body = req.body;
    console.log("[C2B] Incoming payment:", JSON.stringify(body, null, 2));

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
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

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
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 2 — Safaricom STK Push callback
// ═══════════════════════════════════════════════════════════════════════
app.post("/notify/stk", (req, res) => {
  try {
    const body     = req.body;
    console.log("[STK] Callback received:", JSON.stringify(body, null, 2));

    const callback = body?.Body?.stkCallback;
    if (!callback) {
      console.warn("[STK] Invalid callback structure");
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const resultCode  = callback.ResultCode;
    const resultDesc  = callback.ResultDesc        || "";
    const checkoutId  = callback.CheckoutRequestID || "";

    console.log(`[STK] CheckoutRequestID: ${checkoutId} | ResultCode: ${resultCode} | ${resultDesc}`);

    if (resultCode !== 0) {
      console.log(`[STK] Payment failed or cancelled — not storing. Code: ${resultCode}`);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const items    = callback.CallbackMetadata?.Item || [];
    const getItem  = (name) => items.find(i => i.Name === name)?.Value ?? null;

    const amount          = parseFloat(getItem("Amount")      || 0);
    const receiptNumber   = getItem("MpesaReceiptNumber")     || "";
    const phone           = String(getItem("PhoneNumber")     || "");
    const transactionTime = String(getItem("TransactionDate") || new Date().toISOString());

    if (!receiptNumber || amount <= 0) {
      console.warn("[STK] Missing receipt number or amount — skipping");
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    db.insertPayment({
      transaction_id:   receiptNumber,
      amount,
      phone,
      customer_name:    "STK Customer",
      account_ref:      checkoutId,
      short_code:       "",
      transaction_time: transactionTime,
      raw:              JSON.stringify(body),
    });

    console.log(`[STK] Saved: ${receiptNumber} | KES ${amount} | ${phone}`);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (err) {
    console.error("[STK] Callback error:", err);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 3 — POS polls this to check for a pending payment
// ═══════════════════════════════════════════════════════════════════════
app.get("/payments/pending", requireApiKey, (req, res) => {
  const amount = parseFloat(req.query.amount || "0");

  if (amount <= 0) {
    return res.status(400).json({ error: "amount is required" });
  }

  const payment = db.findPendingPayment({ amount });

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
// ROUTE 4 — POS confirms it has consumed a payment
// ═══════════════════════════════════════════════════════════════════════
app.post("/payments/confirm", requireApiKey, (req, res) => {
  const { transaction_id } = req.body;
  if (!transaction_id) {
    return res.status(400).json({ error: "transaction_id is required" });
  }
  db.markPaymentUsed(transaction_id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 5 — Register C2B URLs with Safaricom (run once per shortcode)
// ═══════════════════════════════════════════════════════════════════════
app.post("/register/urls", requireApiKey, async (req, res) => {
  const { consumer_key, consumer_secret, short_code, environment } = req.body;

  if (!consumer_key || !consumer_secret || !short_code) {
    return res.status(400).json({ error: "consumer_key, consumer_secret and short_code are required" });
  }

  const baseUrl   = environment === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

  const serverUrl = process.env.SERVER_URL || `https://${req.headers.host}`;

  try {
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

    const payload = {
      ShortCode:       short_code,
      ResponseType:    "Completed",
      ConfirmationURL: `${serverUrl}/notify/payment`,
      ValidationURL:   `${serverUrl}/notify/payment`,
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
    res.json({ ok: true, response: regData, registered_url: `${serverUrl}/notify/payment` });

  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ROUTE 6 — Health check
// ═══════════════════════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`M-PESA C2B server running on port ${PORT}`);
});
