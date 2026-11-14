// fx.ts — browser enhancement layer: WebGL hero shader, scroll reveals,
// count-up stats, marquee ticker, generative sigils, card spotlight.
// Injected raw before </body> by shell.ts; no framework, no build step.

export const FX = `<script>
(function () {
  "use strict";
  var RM = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------ generative sigils */
  // Seeded fingerprint mark for each bounty — deterministic from the record
  // id, drawn in gold/teal strokes. Reads like a wax-seal sigil, not clipart.
  function hashSeed(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function drawSigil(cv, seed) {
    var ctx = cv.getContext("2d");
    if (!ctx) return;
    var W = cv.width, H = cv.height, rnd = mulberry32(hashSeed(seed));
    ctx.clearRect(0, 0, W, H);
    var cx = W / 2, cy = H / 2;
    var gold = "rgba(240,180,41,.85)", teal = "rgba(57,208,192,.55)";
    ctx.lineWidth = 1.1; ctx.lineCap = "round";
    // orbit rings
    var rings = 2 + Math.floor(rnd() * 2);
    for (var r = 0; r < rings; r++) {
      var rad = 6 + r * (7 + rnd() * 4);
      ctx.beginPath();
      ctx.arc(cx, cy, rad, rnd() * Math.PI * 2, rnd() * Math.PI * 2 + Math.PI * (0.7 + rnd()));
      ctx.strokeStyle = r === 0 ? gold : teal; ctx.globalAlpha = 0.75 - r * 0.18;
      ctx.stroke();
    }
    // signature strokes — 3 bezier flicks across the mark
    for (var s = 0; s < 3; s++) {
      var y0 = H * (0.25 + rnd() * 0.5);
      ctx.beginPath();
      ctx.moveTo(W * 0.14, y0);
      ctx.bezierCurveTo(W * (0.35 + rnd() * 0.2), y0 + (rnd() - 0.5) * H * 0.5,
                        W * (0.55 + rnd() * 0.15), y0 + (rnd() - 0.5) * H * 0.5,
                        W * (0.86 - rnd() * 0.1), y0 + (rnd() - 0.5) * H * 0.35);
      ctx.strokeStyle = s === 1 ? teal : gold; ctx.globalAlpha = 0.9;
      ctx.stroke();
    }
    // node dots
    for (var d = 0; d < 4; d++) {
      ctx.beginPath();
      ctx.arc(W * (0.18 + rnd() * 0.64), H * (0.2 + rnd() * 0.6), 1.6, 0, 7);
      ctx.fillStyle = gold; ctx.globalAlpha = 0.9; ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  document.querySelectorAll("canvas.sigil[data-seed]").forEach(function (cv) {
    drawSigil(cv, cv.getAttribute("data-seed"));
  });

  /* ------------------------------------------------ scroll reveals */
  var io = ("IntersectionObserver" in window) ? new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }) : null;
  document.querySelectorAll(".reveal").forEach(function (el) {
    if (io) io.observe(el); else el.classList.add("in");
  });

  /* ------------------------------------------------ stat counters */
  document.querySelectorAll("[data-count]").forEach(function (el) {
    var target = parseFloat(el.getAttribute("data-count"));
    if (!isFinite(target)) return;
    var dec = parseInt(el.getAttribute("data-decimals") || "0", 10);
    var suffix = el.getAttribute("data-suffix") || "";
    if (RM) { el.textContent = target.toLocaleString("en-US", { maximumFractionDigits: dec }) + suffix; return; }
    var t0 = null, dur = 1400;
    function step(ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = (target * e).toLocaleString("en-US", { maximumFractionDigits: dec }) + suffix;
      if (k < 1) requestAnimationFrame(step);
    }
    // only count up when visible
    var counted = false;
    var cio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting && !counted) { counted = true; requestAnimationFrame(step); cio.disconnect(); }
      });
    }, { threshold: 0.4 });
    cio.observe(el);
  });

  /* ------------------------------------------------ ticker loop */
  document.querySelectorAll(".ticker-track").forEach(function (t) {
    if (!t.dataset.duped) { t.innerHTML += t.innerHTML; t.dataset.duped = "1"; }
  });

  /* ------------------------------------------------ card spotlight */
  document.addEventListener("mousemove", function (ev) {
    var card = ev.target.closest && ev.target.closest(".card");
    if (!card) return;
    var r = card.getBoundingClientRect();
    card.style.setProperty("--mx", ((ev.clientX - r.left) / r.width * 100) + "%");
    card.style.setProperty("--my", ((ev.clientY - r.top) / r.height * 100) + "%");
  }, { passive: true });

  /* ------------------------------------------------ hero shader */
  var cv = document.getElementById("fx-hero");
  if (cv) {
    var gl = null;
    try { gl = cv.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" })
             || cv.getContext("experimental-webgl"); } catch (e) {}
    if (!gl) {
      cv.style.background = "radial-gradient(1200px 600px at 70% 20%, rgba(240,180,41,.14), transparent 60%)," +
        "radial-gradient(900px 500px at 15% 80%, rgba(57,208,192,.08), transparent 60%), var(--bg)";
    } else {
      var VS = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
      var FS = [
        "precision mediump float;",
        "uniform vec2 u_res;uniform float u_time;uniform vec2 u_ptr;",
        "float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}",
        "float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);",
        "return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}",
        "float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p*=2.03;a*=.5;}return v;}",
        "void main(){",
        "vec2 uv=gl_FragCoord.xy/u_res.xy;",
        "vec2 p=(uv-.5)*vec2(u_res.x/u_res.y,1.)*1.9;",
        "float t=u_time*.045;",
        "vec2 q=vec2(fbm(p+t),fbm(p+vec2(5.2,1.3)-t));",
        "vec2 r=vec2(fbm(p+2.2*q+vec2(1.7,9.2)+.18*t),fbm(p+2.2*q+vec2(8.3,2.8)-.12*t));",
        "float f=fbm(p+2.6*r);",
        "float g=fbm(p*1.6-vec2(t*.7)-r*.8+3.1);",
        "float tri1=1.-abs(2.*fract(f*3.)-1.);",
        "float tri2=1.-abs(2.*fract(g*4.5)-1.);",
        "vec3 ink=vec3(.039,.043,.055);",
        "vec3 gold=vec3(.94,.71,.16);",
        "vec3 teal=vec3(.22,.82,.75);",
        "vec3 col=ink;",
        "col+=gold*(smoothstep(.93,1.,tri1)*.85+smoothstep(.72,1.,tri1)*.16);",
        "col+=teal*smoothstep(.9,1.,tri2)*.22;",
        "col+=gold*.10*exp(-length(p)*1.1);",
        "vec2 m=u_ptr-.5;",
        "col+=gold*.05*exp(-dot(uv-u_ptr,uv-u_ptr)*6.);",
        "col*=1.-.5*dot(uv-.5,uv-.5);",
        "col+=(hash(gl_FragCoord.xy+fract(u_time)*61.)-.5)*.028;",
        "gl_FragColor=vec4(col,1.);",
        "}"
      ].join("\\n");
      function sh(type, src) {
        var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
      }
      var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
      var prog = gl.createProgram();
      if (vs && fs) {
        gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
        gl.useProgram(prog);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
        var loc = gl.getAttribLocation(prog, "p");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        var uRes = gl.getUniformLocation(prog, "u_res");
        var uTime = gl.getUniformLocation(prog, "u_time");
        var uPtr = gl.getUniformLocation(prog, "u_ptr");
        var ptr = [0.5, 0.5], ptrT = [0.5, 0.5];
        function resize() {
          var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
          var w = cv.clientWidth * dpr, h = cv.clientHeight * dpr;
          if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
        }
        resize();
        window.addEventListener("resize", resize);
        cv.parentElement && cv.parentElement.addEventListener("pointermove", function (ev) {
          var r = cv.getBoundingClientRect();
          ptrT = [(ev.clientX - r.left) / r.width, 1 - (ev.clientY - r.top) / r.height];
        }, { passive: true });
        var visible = true, raf = 0, start = performance.now();
        function frame(now) {
          resize();
          ptr[0] += (ptrT[0] - ptr[0]) * 0.04; ptr[1] += (ptrT[1] - ptr[1]) * 0.04;
          gl.uniform2f(uRes, cv.width, cv.height);
          gl.uniform1f(uTime, (now - start) / 1000);
          gl.uniform2f(uPtr, ptr[0], ptr[1]);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          raf = requestAnimationFrame(frame);
        }
        function sync() {
          var r = cv.getBoundingClientRect();
          visible = r.bottom > 0 && r.top < window.innerHeight && !document.hidden;
          if (visible && !raf && !RM) raf = requestAnimationFrame(frame);
          if (!visible && raf) { cancelAnimationFrame(raf); raf = 0; }
        }
        if (RM) {
          // one static frame, no loop
          gl.uniform2f(uRes, cv.width || 2, cv.height || 2);
          gl.uniform1f(uTime, 4.2); gl.uniform2f(uPtr, .5, .5);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        } else {
          window.addEventListener("scroll", sync, { passive: true });
          document.addEventListener("visibilitychange", sync);
          sync();
        }
      } else {
        cv.style.background = "radial-gradient(1200px 600px at 70% 20%, rgba(240,180,41,.14), transparent 60%), var(--bg)";
      }
    }
  }

  /* ------------------------------------------------ hero scroll parallax */
  var heroInner = document.querySelector(".hero-inner");
  if (heroInner && !RM) {
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () {
        var y = Math.min(window.scrollY * 0.18, 120);
        heroInner.style.transform = "translateY(" + y + "px)";
        ticking = false;
      });
    }, { passive: true });
  }
})();
</script>`;
