// GET /api/menu -> everything the page needs to render, in one request.
//
// The browser never talks to the till's API directly. Two reasons:
// cross-origin requests to it would be blocked, and routing through here
// means the site decides what the public can see.
//
// Env var required:
//   POS_URL   https://pos-terminal-s13.pages.dev   (no trailing slash)

export async function onRequestGet({ env }) {
  const pos = String(env.POS_URL || "").replace(/\/+$/, "");
  if (!pos) {
    return json({ error: "Ordering is not configured yet." }, 503);
  }

  // Both at once. The menu is the slow one; waiting for them in sequence
  // would add a round trip to every page load.
  const [menuRes, shopRes] = await Promise.allSettled([
    fetch(`${pos}/api/menu`,  { signal: AbortSignal.timeout(8000) }),
    fetch(`${pos}/api/shop`,  { signal: AbortSignal.timeout(8000) })
  ]);

  const grouped = await readJson(menuRes);
  if (!grouped) {
    return json({ error: "The menu is unavailable right now." }, 502);
  }

  // The till groups by category with no guaranteed order. The website
  // decides how the menu reads: food first, biggest sellers near the top,
  // drinks last. Anything new the kitchen adds falls in before drinks
  // rather than vanishing off the end.
  const ORDER = ["Burgers", "Chicken Rolls", "Loaded Fries", "Rice", "Drinks"];
  const categories = Object.keys(grouped)
    .sort((a, b) => {
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      return (ia === -1 ? ORDER.length - 1 : ia) - (ib === -1 ? ORDER.length - 1 : ib)
          || a.localeCompare(b);
    })
    .map(name => ({
      name,
      items: (grouped[name] || [])
        .slice()
        .sort((a, b) => (a.sort || 0) - (b.sort || 0))
        .map(i => ({
          id: i.id,
          name: i.name,
          price: Number(i.price) || 0,
          description: i.description || null,
          badge: i.badge || null,
          image: i.image_url || null
        }))
    }))
    .filter(c => c.items.length);

  // Shop status is allowed to fail. A menu that renders with ordering
  // temporarily disabled is far better than a blank page.
  const shop = (await readJson(shopRes)) ||
    { can_order: false, within_hours: false, accepting_orders: false, prep_minutes: 20, unknown: true };

  return json({ categories, shop });
}

// A 200 is not a promise of JSON. Pages serves index.html for any route
// it does not recognise, so a missing endpoint upstream comes back as a
// perfectly healthy HTML page that explodes on .json(). Check the
// content type before trusting the body.
async function readJson(settled) {
  const res = settled && settled.status === "fulfilled" ? settled.value : settled;
  if (!res || !res.ok) return null;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return null;
  try { return await res.json(); } catch { return null; }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Short, and no stale-while-revalidate. This response carries the
      // open/closed status, so a long window would keep telling
      // customers we are open for minutes after the counter pressed the
      // closed button. The menu itself barely changes, so there is
      // little to gain from caching it harder.
      "Cache-Control": "public, max-age=20"
    }
  });
}
