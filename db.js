const Database = require("better-sqlite3");
const path     = require("path");

// Store DB in /tmp on Railway (ephemeral but fine for testing)
// For production, use a proper persistent volume or switch to postgres
const DB_PATH = process.env.DB_PATH || path.join("/tmp", "mpesa.db");
const db = new Database(DB_PATH);

// ── Schema ─────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id   TEXT    UNIQUE NOT NULL,
    amount           REAL    NOT NULL,
    phone            TEXT    NOT NULL,
    customer_name    TEXT    NOT NULL DEFAULT '',
    account_ref      TEXT    NOT NULL DEFAULT '',
    short_code       TEXT    NOT NULL DEFAULT '',
    transaction_time TEXT    NOT NULL,
    raw              TEXT    NOT NULL DEFAULT '{}',
    used             INTEGER NOT NULL DEFAULT 0,   -- 0 = pending, 1 = consumed by POS
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_payments_used_amount
    ON payments (used, amount);
`);

// ── Insert a new payment (ignore duplicates) ───────────────────────────
function insertPayment(p) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO payments
      (transaction_id, amount, phone, customer_name, account_ref, short_code, transaction_time, raw)
    VALUES
      (@transaction_id, @amount, @phone, @customer_name, @account_ref, @short_code, @transaction_time, @raw)
  `);
  return stmt.run(p);
}

// ── Find the most recent unused payment matching amount (± 1 KES tolerance)
// Matches on amount + 10-minute window only — no account_ref or short_code
// filter since Till payments have no account reference from the customer ──
function findPendingPayment({ amount }) {
  const query = `
    SELECT * FROM payments
    WHERE used = 0
      AND amount >= @minAmount
      AND amount <= @maxAmount
      AND created_at >= datetime('now', '-10 minutes')
    ORDER BY created_at DESC LIMIT 1
  `;
  return db.prepare(query).get({
    minAmount: amount - 1,
    maxAmount: amount + 1,
  }) || null;
}

// ── Mark a payment as consumed so it can't be matched again ───────────
function markPaymentUsed(transactionId) {
  db.prepare(`UPDATE payments SET used = 1 WHERE transaction_id = ?`)
    .run(transactionId);
}

module.exports = { insertPayment, findPendingPayment, markPaymentUsed };
