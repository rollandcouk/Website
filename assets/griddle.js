/* The hero is a hot flat-top. You are the heat.
 *
 * Move a cursor or a finger across it and the surface sears: bright
 * where you are, crisping amber behind you, cooling back to charcoal
 * over a couple of seconds. Smoke lifts off the hottest patches.
 *
 * It is a real heat simulation, not a glow chasing the pointer, and the
 * difference is the whole effect. A coarse grid holds a temperature per
 * cell. Every frame it bleeds into its neighbours and loses a fixed
 * fraction of its heat, and the pointer adds energy where it dwells.
 * Dwell and you burn a bright hole; sweep and you leave a thin trail.
 * Nobody will think about why, they will just keep doing it.
 *
 * The grid is tiny on purpose — around 110 cells across, a few thousand
 * in total. It is drawn into an offscreen canvas at that size and
 * scaled up with smoothing on, so the browser's own bilinear filter
 * does the blurring for free. That is what makes this cheap enough for
 * a phone.
 */
(function () {
  "use strict";

  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  /* Temperature ramp. Cold griddle is transparent — the page background
   * shows through — then char, red, orange, and finally the near-white
   * of metal that is far too hot to put your hand on. */
  var RAMP = [
    [0.00,   0,   0,   0,   0],
    [0.10,  70,  16,   4,  90],
    [0.26, 150,  32,   2, 170],
    [0.44, 219,  60,   0, 215],
    [0.62, 255, 112,   0, 238],
    [0.80, 255, 174,  36, 250],
    [1.00, 255, 244, 214, 255]
  ];

  function rampLUT(steps) {
    var lut = new Uint8ClampedArray(steps * 4);
    for (var i = 0; i < steps; i++) {
      var v = i / (steps - 1), k = 0;
      while (k < RAMP.length - 2 && RAMP[k + 1][0] < v) k++;
      var a = RAMP[k], b = RAMP[k + 1];
      var f = (v - a[0]) / (b[0] - a[0] || 1);
      lut[i * 4]     = lerp(a[1], b[1], f);
      lut[i * 4 + 1] = lerp(a[2], b[2], f);
      lut[i * 4 + 2] = lerp(a[3], b[3], f);
      lut[i * 4 + 3] = lerp(a[4], b[4], f);
    }
    return lut;
  }

  function init(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;

    var mobile = matchMedia("(max-width: 900px)").matches;
    var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    var GW = mobile ? 76 : 116;            // grid columns
    var GH = 1, heat, next, grid, gctx, gimg;
    var LUT = rampLUT(256);

    var w = 0, h = 0, dpr = 1, cell = 1;
    var t = 0, last = 0, raf = 0, visible = false, appear = 0;
    var smoke = [], SMOKE_MAX = mobile ? 26 : 60;

    // Pointer, and the ghost that takes over when there isn't one.
    var p = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, live: false, since: 0 };
    var ghost = { x: 0.5, y: 0.55, a: Math.random() * 6.28 };

    var surface = null;

    /* ── Layout ────────────────────────────────────────────── */

    function layout() {
      dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      GH = Math.max(8, Math.round(GW * (h / w)));
      cell = w / GW;

      heat = new Float32Array(GW * GH);
      next = new Float32Array(GW * GH);

      grid = document.createElement("canvas");
      grid.width = GW; grid.height = GH;
      gctx = grid.getContext("2d");
      gimg = gctx.createImageData(GW, GH);

      buildSurface();
    }

    /* The cold metal underneath. Drawn once — it never changes, and
     * re-drawing a few hundred grain lines every frame would be the
     * most expensive thing here by a wide margin. */
    function buildSurface() {
      var c = document.createElement("canvas");
      c.width = Math.max(2, Math.round(w));
      c.height = Math.max(2, Math.round(h));
      var g = c.getContext("2d");

      g.fillStyle = "#15110f";
      g.fillRect(0, 0, c.width, c.height);

      // Brushed steel: long horizontal strokes, barely there.
      for (var i = 0; i < 260; i++) {
        var y = Math.random() * c.height;
        var len = c.width * (0.25 + Math.random() * 0.75);
        var x0 = Math.random() * (c.width - len);
        g.strokeStyle = "rgba(255,225,205," + (0.004 + Math.random() * 0.016) + ")";
        g.lineWidth = 0.6 + Math.random() * 1.6;
        g.beginPath();
        g.moveTo(x0, y);
        g.lineTo(x0 + len, y + (Math.random() - 0.5) * 2);
        g.stroke();
      }
      // Pitting, from everything cooked on it before.
      for (var j = 0; j < 900; j++) {
        var r = 0.4 + Math.random() * 1.5;
        g.fillStyle = "rgba(0,0,0," + (0.05 + Math.random() * 0.22) + ")";
        g.beginPath();
        g.arc(Math.random() * c.width, Math.random() * c.height, r, 0, 6.2832);
        g.fill();
      }
      surface = c;
    }

    /* ── Heat ──────────────────────────────────────────────── */

    // Stamp heat along the segment the pointer covered this frame, not
    // just where it ended up. Without this a quick flick leaves dots.
    function sear(x0, y0, x1, y1, amount) {
      var steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * GW / 2));
      for (var s = 0; s <= steps; s++) {
        stamp(lerp(x0, x1, s / steps), lerp(y0, y1, s / steps), amount / (steps + 1) * 2.2);
      }
    }

    function stamp(nx, ny, amount) {
      var cx = nx * GW, cy = ny * GH;
      var rad = mobile ? 4.2 : 5.4;
      var x0 = Math.max(0, (cx - rad) | 0), x1 = Math.min(GW - 1, (cx + rad) | 0);
      var y0 = Math.max(0, (cy - rad) | 0), y1 = Math.min(GH - 1, (cy + rad) | 0);
      for (var y = y0; y <= y1; y++) {
        for (var x = x0; x <= x1; x++) {
          var dx = x - cx, dy = y - cy;
          var d = Math.sqrt(dx * dx + dy * dy) / rad;
          if (d >= 1) continue;
          var f = (1 - d); f *= f;                 // soft edge
          var i = y * GW + x;
          heat[i] = Math.min(1.35, heat[i] + amount * f);
        }
      }
    }

    function diffuse(dt) {
      // Lose a fixed fraction per second: a half-life, so the trail
      // fades the way heat actually leaves metal.
      var keep = Math.pow(0.42, dt);
      var bleed = clamp(dt * 3.4, 0, 0.45);

      for (var y = 0; y < GH; y++) {
        var up = y > 0 ? y - 1 : 0, dn = y < GH - 1 ? y + 1 : GH - 1;
        for (var x = 0; x < GW; x++) {
          var lf = x > 0 ? x - 1 : 0, rt = x < GW - 1 ? x + 1 : GW - 1;
          var i = y * GW + x;
          var avg = (heat[y * GW + lf] + heat[y * GW + rt] +
                     heat[up * GW + x] + heat[dn * GW + x]) * 0.25;
          // Heat rises: pull a little harder from below than above.
          next[i] = (heat[i] + (avg - heat[i]) * bleed + heat[dn * GW + x] * 0.012) * keep;
        }
      }
      var tmp = heat; heat = next; next = tmp;
    }

    /* ── Smoke ─────────────────────────────────────────────── */

    function spawnSmoke(dt) {
      if (smoke.length >= SMOKE_MAX) return;
      // Sample a few cells at random; the hot ones give off smoke.
      for (var k = 0; k < 6; k++) {
        var x = (Math.random() * GW) | 0, y = (Math.random() * GH) | 0;
        var v = heat[y * GW + x];
        if (v > 0.52 && Math.random() < dt * 9 * (v - 0.45)) {
          smoke.push({
            x: (x + Math.random()) / GW,
            y: (y + Math.random()) / GH,
            vx: (Math.random() - 0.5) * 0.03,
            vy: -(0.05 + Math.random() * 0.09),
            life: 0,
            span: 1.4 + Math.random() * 1.6,
            r: 10 + Math.random() * 34,
            seed: Math.random() * 6.28
          });
          if (smoke.length >= SMOKE_MAX) return;
        }
      }
    }

    function stepSmoke(dt) {
      for (var i = smoke.length - 1; i >= 0; i--) {
        var s = smoke[i];
        s.life += dt / s.span;
        if (s.life >= 1) { smoke.splice(i, 1); continue; }
        s.y += s.vy * dt;
        s.x += (s.vx + Math.sin(t * 0.9 + s.seed) * 0.016) * dt;
        s.r += dt * 26;
      }
    }

    function drawSmoke() {
      ctx.save();
      for (var i = 0; i < smoke.length; i++) {
        var s = smoke[i];
        var a = Math.sin(s.life * Math.PI) * 0.1 * appear;
        if (a <= 0.003) continue;
        var px = s.x * w, py = s.y * h;
        var g = ctx.createRadialGradient(px, py, 0, px, py, s.r);
        g.addColorStop(0, "rgba(206,196,188," + a + ")");
        g.addColorStop(1, "rgba(206,196,188,0)");
        ctx.fillStyle = g;
        ctx.fillRect(px - s.r, py - s.r, s.r * 2, s.r * 2);
      }
      ctx.restore();
    }

    /* ── Frame ─────────────────────────────────────────────── */

    function input(dt) {
      if (p.live) {
        p.since += dt;
        if (p.since > 2.4) { p.live = false; return; }   // cursor abandoned

        // Heat follows movement. A parked cursor still radiates a
        // little, because a hand resting on a griddle would, but it
        // must not drill a white hole through the surface — which is
        // exactly what a flat rate per frame does.
        var moved = Math.hypot(p.x - p.px, p.y - p.py);
        var amount = dt * (1.1 + Math.min(moved * 60, 7.5));
        sear(p.px, p.py, p.x, p.y, amount);
        p.px = p.x; p.py = p.y;
        return;
      }
      // Nobody is touching it, so the griddle cooks on its own. This is
      // what a phone sees, and it is what proves the surface is live
      // before anyone thinks to drag a finger over it.
      ghost.a += dt * 0.55;
      var gx = 0.5 + Math.cos(ghost.a) * 0.3 + Math.cos(ghost.a * 0.37) * 0.11;
      var gy = 0.54 + Math.sin(ghost.a * 0.82) * 0.2;
      sear(ghost.x, ghost.y, gx, gy, dt * 3.1);
      ghost.x = gx; ghost.y = gy;
    }

    function render() {
      ctx.clearRect(0, 0, w, h);

      if (surface) ctx.drawImage(surface, 0, 0, w, h);

      // Grid -> offscreen pixels -> scaled up. The browser's bilinear
      // filter is doing the blur, which is why this stays cheap.
      var d = gimg.data;
      for (var i = 0, n = GW * GH; i < n; i++) {
        var v = clamp(heat[i], 0, 1);
        var li = (v * 255) | 0;
        var o = i * 4, l = li * 4;
        d[o] = LUT[l]; d[o + 1] = LUT[l + 1]; d[o + 2] = LUT[l + 2];
        d[o + 3] = LUT[l + 3] * appear;
      }
      gctx.putImageData(gimg, 0, 0);

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.globalCompositeOperation = "lighter";
      // Drawn twice: once soft and wide for the bloom, once tight for
      // the sear itself. One pass alone reads as either a smudge or a
      // sticker, never as hot metal.
      ctx.globalAlpha = 0.55;
      ctx.filter = "blur(14px)";
      ctx.drawImage(grid, -cell, -cell, w + cell * 2, h + cell * 2);
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.drawImage(grid, 0, 0, w, h);
      ctx.restore();
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!visible) { last = now; return; }
      var dt = (now - last) / 1000;
      last = now;
      if (!(dt > 0)) dt = 0.016;
      if (dt > 0.05) dt = 0.05;

      t += dt;
      appear = Math.min(1, appear + dt * 0.6);

      input(dt);
      diffuse(dt);
      spawnSmoke(dt);
      stepSmoke(dt);

      render();
      if (opts.middle) opts.middle(ctx, w, h, appear, p, t);
      drawSmoke();
    }

    /* ── Wiring ────────────────────────────────────────────── */

    function at(ev) {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      p.x = clamp((ev.clientX - r.left) / r.width, 0, 1);
      p.y = clamp((ev.clientY - r.top) / r.height, 0, 1);
      if (!p.live) { p.px = p.x; p.py = p.y; }
      p.live = true;
      p.since = 0;
    }

    var host = canvas.parentElement || canvas;
    host.addEventListener("pointermove", at, { passive: true });
    host.addEventListener("pointerdown", at, { passive: true });
    host.addEventListener("pointerleave", function () { p.live = false; });

    if (typeof IntersectionObserver === "function") {
      new IntersectionObserver(function (es) { visible = es[0].isIntersecting; })
        .observe(canvas);
    } else { visible = true; }

    var rt;
    addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(layout, 160);
    });

    layout();
    if (!heat) return null;

    if (reduce) {
      // A warm griddle, held still. Someone who asked for less motion
      // still gets a hot surface, it just is not moving.
      appear = 1;
      for (var s = 0; s < 90; s++) { input(0.03); diffuse(0.03); }
      render();
      if (opts.middle) opts.middle(ctx, w, h, 1, p, 0);
      return { stop: function () {} };
    }

    last = performance.now();
    raf = requestAnimationFrame(frame);
    return { stop: function () { cancelAnimationFrame(raf); } };
  }

  window.GriddleFX = { init: init };
})();
