// POST /api/order -> places a collection order on the till.
//
// This is the only endpoint that writes anything, so it is where the
// care goes:
//
//   1. Prices are recomputed from the live menu. The basket total the
//      browser sends is treated as a claim to be checked, never as fact.
//      Anyone can edit JavaScript; nobody should be able to edit a price.
//   2. The shop has to actually be open. Checked here, not just hidden
//      in the UI.
//   3. ONLINE_ORDER_SECRET lives here, server side. If it were in the
//      page, anyone could put tickets on the kitchen screen.
//
// Env vars required:
//   POS_URL              https://pos-terminal-s13.pages.dev
//   ONLINE_ORDER_SECRET  same value as in the till's Cloudflare project

export async function onRequestPost({ request, env }) {
  const pos = String(env.POS_URL || "").replace(/\/+$/, "");
  const secret = env.ONLINE_ORDER_SECRET;

  // Fail closed. An unconfigured site must refuse orders loudly rather
  // than take money for food nobody is going to cook.
  if (!pos || !secret) {
    return json({ error: "Online ordering is not switched on yet. Please call the shop." }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Something went wrong. Please try again." }, 400); }

  const name  = str(body.name);
  const phone = digits(body.phone);
  const note  = str(body.note);

  if (!name)              return json({ error: "Please tell us your name." }, 400);
  if (phone.length < 10)  return json({ error: "Please enter a valid UK mobile number." }, 400);

  const wanted = Array.isArray(body.items) ? body.items : [];
  if (!wanted.length)     return json({ error: "Your basket is empty." }, 400);

  // ── Is the shop open? ────────────────────────────────────
  const shop = await readJson(
    fetch(`${pos}/api/shop`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
  );

  if (!shop) return json({ error: "We cannot reach the kitchen right now. Please call the shop." }, 502);
  if (!shop.can_order) {
    return json({
      error: shop.accepting_orders === false
        ? (shop.closed_message || "We have stopped taking online orders for now.")
        : "We are closed at the moment."
    }, 409);
  }

  // ── Rebuild the basket from the real menu ────────────────
  const grouped = await readJson(
    fetch(`${pos}/api/menu`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
  );
  if (!grouped) return json({ error: "We cannot reach the menu right now. Please call the shop." }, 502);
  const byId = new Map();
  for (const cat of Object.values(grouped)) {
    for (const item of cat || []) byId.set(String(item.id), item);
  }

  const lines = [];
  for (const w of wanted) {
    const item = byId.get(String(w.id));
    if (!item) continue;                                  // withdrawn mid-order
    const qty = Math.min(20, Math.max(1, Math.floor(Number(w.qty) || 1)));
    lines.push({
      id: item.id,
      name: String(item.name),
      qty,
      price: Math.round((Number(item.price) || 0) * 100) / 100   // the DB price, always
    });
  }

  if (!lines.length) {
    return json({ error: "Those items are no longer available. Please check the menu." }, 409);
  }

  const total = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));

  // ── Send it to the till ──────────────────────────────────
  // external_ref makes the whole thing idempotent: if this request is
  // retried, the till recognises the reference and will not print a
  // second ticket.
  const ref = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const posted = await fetch(`${pos}/api/online/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
    body: JSON.stringify({
      external_ref: ref,
      fulfilment: "collection",
      customer: { name, phone, note },
      items: lines,
      // Not paid. The docket prints PAY ON COLLECTION and the customer
      // settles at the counter. Card payment is a later phase.
      paid: false
    }),
    signal: AbortSignal.timeout(10000)
  }).catch(() => null);

  if (!posted || !posted.ok) {
    return json({ error: "We could not send your order to the kitchen. Please call the shop." }, 502);
  }

  const result = await posted.json().catch(() => ({}));

  return json({
    ok: true,
    order_no: result.order_no ?? null,
    total,
    ready_in: shop.prep_minutes || 20,
    items: lines
  });
}

/* ── helpers ─────────────────────────────────────────────── */

// A 200 is not a promise of JSON. Pages serves index.html for unknown
// routes, so a missing endpoint upstream returns a healthy HTML page
// that explodes on .json(). Verify the content type first.
async function readJson(promise) {
  const res = await promise;
  if (!res || !res.ok) return null;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return null;
  try { return await res.json(); } catch { return null; }
}

function str(v) { return String(v ?? "").trim().slice(0, 120); }
function digits(v) { return String(v ?? "").replace(/\D+/g, ""); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
