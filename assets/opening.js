// Pre-opening countdown. Change OPENS to the real opening moment (UK time).
// After that moment nothing here renders, so it can stay until it's removed.
(() => {
  const OPENS = new Date("2026-11-21T00:00:00Z"); // Sat 21 Nov 2026 (GMT, so this is midnight UK time)
  const WHATSAPP = "https://whatsapp.com/channel/0029Vb9Uk8y6RGJHFCyxqR3z";
  // index.html reads these to switch ordering off until opening day.
  window.RC_OPENS = OPENS;
  window.RC_WHATSAPP = WHATSAPP;
  if (Date.now() >= OPENS.getTime()) return;

  const dateText = OPENS.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
  const seen = (() => { try { return sessionStorage.getItem("rc-oc-seen") === "1" } catch { return false } })();

  // Slim bar at the top of the page, always shown before opening.
  const bar = document.createElement("div");
  bar.className = "oc-bar";
  bar.innerHTML = `<span>Opening ${dateText} · <span data-oc-days></span></span><a href="${WHATSAPP}" target="_blank" rel="noopener">Join the opening list</a>`;
  document.body.prepend(bar);

  // Full-screen intro, once per visit.
  const screen = document.createElement("div");
  screen.className = "oc-screen";
  screen.setAttribute("role", "dialog");
  screen.setAttribute("aria-modal", "true");
  screen.setAttribute("aria-labelledby", "ocTitle");
  screen.innerHTML = `
    <div class="oc-card">
      <img class="oc-logo" src="/assets/logo-mark.png" alt="Roll &amp; Co.">
      <div class="oc-kicker">Bolton · Opening soon</div>
      <h1 class="oc-title" id="ocTitle">We're <span>nearly ready.</span></h1>
      <p class="oc-date">Doors open ${dateText}.</p>
      <div class="oc-clock" aria-live="off">
        <div class="oc-unit"><b data-oc="d">0</b><small>Days</small></div>
        <div class="oc-unit"><b data-oc="h">00</b><small>Hours</small></div>
        <div class="oc-unit"><b data-oc="m">00</b><small>Mins</small></div>
        <div class="oc-unit"><b data-oc="s">00</b><small>Secs</small></div>
      </div>
      <div class="oc-actions">
        <a class="btn btn-flame oc-wa" href="${WHATSAPP}" target="_blank" rel="noopener"><i class="ph ph-whatsapp-logo" aria-hidden="true"></i>Join the opening list</a>
        <button class="oc-skip" type="button" data-oc-close>See the menu</button>
      </div>
      <p class="oc-note">The list gets the menu first, the opening time, and an offer only for people on it.</p>
    </div>`;
  if (seen) screen.hidden = true;
  document.body.prepend(screen);

  const close = () => {
    screen.hidden = true;
    document.documentElement.style.overflow = "";
    try { sessionStorage.setItem("rc-oc-seen", "1") } catch {}
  };
  if (!seen) {
    document.documentElement.style.overflow = "hidden";
    screen.querySelector("[data-oc-close]").focus({ preventScroll: true });
  }
  screen.querySelector("[data-oc-close]").addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !screen.hidden) close() });

  const pad = n => String(n).padStart(2, "0");
  const tick = () => {
    const ms = OPENS.getTime() - Date.now();
    if (ms <= 0) { bar.remove(); close(); clearInterval(timer); return }
    const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
    screen.querySelector('[data-oc="d"]').textContent = d;
    screen.querySelector('[data-oc="h"]').textContent = pad(h);
    screen.querySelector('[data-oc="m"]').textContent = pad(m);
    screen.querySelector('[data-oc="s"]').textContent = pad(s);
    const days = Math.ceil(ms / 864e5);
    bar.querySelector("[data-oc-days]").textContent = days === 1 ? "tomorrow" : days + " days to go";
  };
  const timer = setInterval(tick, 1000);
  tick();
})();
