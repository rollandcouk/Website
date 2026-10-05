/* Scroll-scrubbed image sequence.
 *
 * A short clip, exploded into frames, with the scroll position choosing
 * which one is on screen. It is how product heroes have been built for
 * years, and it beats faking motion with transforms because the motion
 * is real — the wrap actually opens, because something actually opened
 * in front of a camera.
 *
 * Two things matter and everything here serves them:
 *
 *   Never show a gap. Frames are drawn into a canvas rather than swapped
 *   as <img> sources, so there is no moment where the old one has gone
 *   and the new one has not arrived. If the frame the scroll asks for is
 *   not decoded yet, the nearest one that is stays up instead.
 *
 *   Never block the page. The first frame is fetched on its own and
 *   shown immediately; the rest arrive a few at a time in the
 *   background, in scroll order, so the early ones are ready first.
 */
(function () {
  "use strict";

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = "0" + s;
    return s;
  }

  function init(canvas, opts) {
    opts = opts || {};
    var count = opts.count || 0;
    var src = opts.src;                   // function(i) -> url
    if (!canvas || !count || typeof src !== "function") return null;

    var ctx = canvas.getContext("2d");
    if (!ctx) return null;

    var frames = new Array(count);        // Image objects, once decoded
    var ready = new Array(count);         // decoded flag
    var loaded = 0;
    var current = -1;
    var want = 0;
    var W = 0, H = 0, dpr = 1;
    var raf = 0, dirty = true;

    /* ── Sizing ────────────────────────────────────────────── */

    function layout() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      if (!W || !H) return;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty = true;
    }

    /* ── Drawing ───────────────────────────────────────────── */

    // The frame the scroll asked for, or the closest one that has
    // actually arrived. Searching outward from the target means a
    // half-loaded sequence degrades to a chunkier version of the same
    // animation rather than to a blank screen.
    function nearestReady(i) {
      if (ready[i]) return i;
      for (var d = 1; d < count; d++) {
        if (i - d >= 0 && ready[i - d]) return i - d;
        if (i + d < count && ready[i + d]) return i + d;
      }
      return -1;
    }

    function paint() {
      raf = 0;
      if (!W || !H) { layout(); if (!W || !H) return; }

      var i = nearestReady(want);
      if (i < 0) return;
      if (i === current && !dirty) return;
      current = i;
      dirty = false;

      var img = frames[i];
      ctx.clearRect(0, 0, W, H);

      // "cover" fills the stage and pushes the clip's own frame edges
      // off screen, which is the only reliable way to stop a rendered
      // backdrop reading as a video pasted onto the page — its corners
      // are never pure black, so fading them into the page always left
      // a seam. "contain" stays available for a sequence shot against a
      // real transparent or matching background.
      var sx = W / img.naturalWidth, sy = H / img.naturalHeight;
      var s = opts.fit === "contain" ? Math.min(sx, sy) : Math.max(sx, sy);
      var dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      var oy = typeof opts.focusY === "number" ? opts.focusY : 0.5;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) * oy, dw, dh);
    }

    function schedule() {
      if (!raf) raf = requestAnimationFrame(paint);
    }

    /* ── Loading ───────────────────────────────────────────── */

    function load(i, done) {
      if (frames[i]) return done && done();
      var img = new Image();
      img.decoding = "async";
      frames[i] = img;
      img.onload = function () {
        ready[i] = true;
        loaded++;
        if (opts.onProgress) opts.onProgress(loaded / count);
        if (loaded === 1 || i === want) schedule();
        if (loaded === count && opts.onComplete) opts.onComplete();
        done && done();
      };
      img.onerror = function () {
        // A missing frame is not worth stalling the queue for; the
        // nearest-ready search will simply step over it.
        loaded++;
        done && done();
      };
      img.src = src(i);
    }

    // A few at a time, in order. Firing all of them at once makes the
    // browser fight itself over connections and the first frame — the
    // only one anybody is waiting for — arrives last.
    function queue() {
      var next = 0, inFlight = 0;
      var CONCURRENCY = 4;
      function pump() {
        while (inFlight < CONCURRENCY && next < count) {
          var i = next++;
          if (ready[i]) continue;
          inFlight++;
          load(i, function () { inFlight--; pump(); });
        }
      }
      pump();
    }

    /* ── Public ────────────────────────────────────────────── */

    function setProgress(p) {
      var i = Math.round(Math.min(1, Math.max(0, p)) * (count - 1));
      if (i === want) return;
      want = i;
      schedule();
    }

    var rt;
    addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(function () { layout(); schedule(); }, 150);
    });

    layout();
    // First frame alone, so something is on screen as soon as possible.
    load(0, queue);

    return {
      setProgress: setProgress,
      get loaded() { return loaded; },
      get count() { return count; },
      refresh: function () { layout(); schedule(); }
    };
  }

  window.Scrub = { init: init, pad: pad };
})();
