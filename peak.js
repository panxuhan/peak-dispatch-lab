/* =====================================================================
   peak.js — 双十一零点洪峰演练
   ===================================================================== */
window.PeakScene = (() => {
  const A = window.App;
  const { clamp, rand, fmt, lerp, audio } = A;

  const canvas = document.getElementById("peakCanvas");
  const { ctx, state: view } = A.setupCanvas(canvas);
  const wrap = document.getElementById("peakWrap");
  const banner = document.getElementById("peakBanner");
  const statusChip = document.getElementById("peakStatus");
  const log = A.makeLogger(document.getElementById("peakLog"), 30);

  const BASE_QPS = 20000;

  const FEATURES = {
    cdn:       { name: "CDN 加速", glyph: "CDN", desc: "静态资源边缘化", cost: "静态流量 -22%" },
    cache:     { name: "多级缓存", glyph: "CACHE", desc: "本地 + Redis", cost: "读流量 -86%" },
    rateLimit: { name: "网关限流", glyph: "GW", desc: "令牌桶", cost: "超额请求被拒" },
    queue:     { name: "削峰队列", glyph: "MQ", desc: "异步缓冲", cost: "延迟增加" },
    degrade:   { name: "熔断降级", glyph: "CB", desc: "保住核心链路", cost: "非核心功能关闭" },
    autoscale: { name: "弹性扩容", glyph: "SVC", desc: "从 2 组到 6 组", cost: "30 秒生效" },
    sharding:  { name: "分库分表", glyph: "DB", desc: "写流量摊到 3 库", cost: "运维复杂度上升" },
    hotspot:   { name: "热点探测", glyph: "HOT", desc: "本地缓存兜底", cost: "内存占用上升" },
  };

  const NODES = [
    { id: "clients", title: "用户", sub: "秒杀 / 详情", fx: 0.075, fy: 0.50, w: 0.095, feature: null },
    { id: "cdn",     title: "CDN",  sub: "静态资源", fx: 0.225, fy: 0.17, feature: "cdn" },
    { id: "gateway", title: "API 网关", sub: "鉴权 / 限流", fx: 0.315, fy: 0.50, feature: "rateLimit" },
    { id: "cache",   title: "缓存集群", sub: "命中率", fx: 0.490, fy: 0.19, feature: "cache" },
    { id: "service", title: "交易服务", sub: "实例组", fx: 0.490, fy: 0.63, feature: "autoscale" },
    { id: "queue",   title: "消息队列", sub: "积压", fx: 0.665, fy: 0.855, feature: "queue" },
    { id: "breaker", title: "熔断器", sub: "降级开关", fx: 0.665, fy: 0.27, feature: "degrade" },
    { id: "db",      title: "数据库", sub: "读写 / 分片", fx: 0.865, fy: 0.52, feature: "sharding" },
  ];

  const state = {
    on: {},
    crashed: false,
    crashMelt: 0,
    t: 0,
    clockBase: 23 * 3600 + 59 * 60 + 52,
    burst: 1,
    spikeAt: -99,
    traffic: 1,
    queueBuffer: 0,
    buffers: { qps: 0, latency: 86, error: 0.02, db: 21, svc: 0.35, hit: 0.05 },
    faults: { cacheAvalanche: 0, hotKey: 0, idcDown: 0, slowSql: 0 },
    hover: null,
    ripples: [],
    sparks: [],
    history: [],
    histTimer: 0,
    uiTimer: 0,
    capacityRamp: 0,
    overloadTimer: 0,
  };

  const nodes = {};

  function layout() {
    const W = view.w || 800;
    const H = view.h || 450;
    NODES.forEach((def) => {
      const w = clamp(W * (def.w || 0.095), 62, 118);
      const h = clamp(H * 0.13, 46, 64);
      nodes[def.id] = {
        ...def,
        w, h,
        x: W * def.fx - w / 2,
        y: H * def.fy - h / 2,
        cx: W * def.fx,
        cy: H * def.fy,
        flash: 0,
        hit: 0,
      };
    });
  }
  layout();
  new ResizeObserver(layout).observe(wrap);

  const isOn = (id) => !!(id && state.on[id]);
  function onCount() { return Object.values(state.on).filter(Boolean).length; }

  /* ---------------- 路由与粒子 ---------------- */
  const particles = [];
  let spawnAcc = 0;

  function pointOf(id) {
    const n = nodes[id];
    return { x: n.cx + rand(-8, 8), y: n.cy + rand(-8, 8) };
  }

  function buildRoute() {
    const { on, faults } = state;
    const r = Math.random();
    if (on.cdn && r < 0.16) return { route: ["clients", "cdn"], kind: "static" };
    if (on.rateLimit && r > 0.9 && state.buffers.svc > 0.92) return { route: ["clients", "gateway"], kind: "drop" };
    if (on.queue && r > 0.72) return { route: ["clients", "gateway", "queue", "service", "db"], kind: "queued" };
    const hitRate = on.cache ? (faults.cacheAvalanche > 0 ? 0.16 : 0.86 + (on.hotspot ? 0.06 : 0)) : 0.04;
    if (Math.random() < hitRate) return { route: ["clients", "gateway", "cache", "service"], kind: "hit" };
    return { route: ["clients", "gateway", "cache", "service", "db"], kind: "miss" };
  }

  function spawnParticle() {
    const { route, kind } = buildRoute();
    const pts = route.map(pointOf);
    if (pts.length < 2) return;
    particles.push({
      pts,
      seg: 0,
      t: 0,
      speed: 290 + rand(-40, 90),
      kind,
      color: kind === "hit" ? "#34e0a1"
        : kind === "miss" ? "#38e1ff"
        : kind === "queued" ? "#b07bff"
        : kind === "static" ? "#7aa6ff"
        : "#ff5d6c",
      wait: 0,
      dead: false,
      life: 1,
      size: kind === "drop" ? 2.9 : 2.2,
    });
    if (particles.length > 460) particles.shift();
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (p.dead) {
        p.life -= dt * 2.6;
        if (p.life <= 0) particles.splice(i, 1);
        continue;
      }
      if (p.wait > 0) { p.wait -= dt; continue; }
      const a = p.pts[p.seg];
      const b = p.pts[p.seg + 1];
      if (!b) { p.dead = true; continue; }
      const segLen = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      p.t += (p.speed * dt) / segLen;
      if (p.t >= 1) {
        p.t = 0;
        p.seg++;
        if (!p.pts[p.seg + 1]) {
          p.dead = true;
          if (p.kind === "hit" || p.kind === "miss") addSpark(p.pts[p.seg].x, p.pts[p.seg].y, p.color, 2);
        } else if (p.kind === "queued" && p.seg === 2) {
          p.wait = rand(0.25, 1.0);
        } else if (p.kind === "drop" && p.seg === 1) {
          p.dead = true;
          addSpark(b.x, b.y, "#ff5d6c", 5);
        }
        if (state.crashed && Math.random() < 0.5) p.dead = true;
      }
    }
  }

  function addSpark(x, y, color, count = 4) {
    for (let i = 0; i < count; i++) {
      state.sparks.push({
        x, y,
        vx: rand(-70, 70), vy: rand(-80, 20),
        life: 1, color, r: rand(1, 2.6),
      });
    }
    if (state.sparks.length > 260) state.sparks.splice(0, state.sparks.length - 260);
  }

  function updateSparks(dt) {
    for (let i = state.sparks.length - 1; i >= 0; i--) {
      const s = state.sparks[i];
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += 90 * dt;
      s.life -= dt * 1.4;
      if (s.life <= 0) state.sparks.splice(i, 1);
    }
  }

  function updateRipples(dt) {
    for (let i = state.ripples.length - 1; i >= 0; i--) {
      const r = state.ripples[i];
      r.r += 130 * dt;
      r.life -= dt * 1.8;
      if (r.life <= 0) state.ripples.splice(i, 1);
    }
  }

  /* ---------------- 指标模型 ---------------- */
  function computeMetrics(dt) {
    const f = state.faults;
    for (const k of Object.keys(f)) if (f[k] > 0) f[k] = Math.max(0, f[k] - dt);

    const targetRamp = state.on.autoscale ? 1 : 0;
    state.capacityRamp += (targetRamp - state.capacityRamp) * Math.min(1, dt * 0.9);

    if (state.spikeAt >= 0) {
      const e = state.t - state.spikeAt;
      const shape = e < 1.4 ? A.easeInOut(e / 1.4) : Math.exp(-(e - 1.4) / 9);
      state.burst = 1 + 3.4 * Math.max(0, shape);
    } else {
      state.burst = 1;
    }

    const rawQps = BASE_QPS * state.traffic * state.burst;
    const ingress = state.on.cdn ? rawQps * 0.8 : rawQps;

    const replicas = 2 + state.capacityRamp * 4;
    const idc = f.idcDown > 0 ? 0.64 : 1;
    const svcCap = 10500 * replicas * idc;
    const dbCap = 22000 * (state.on.sharding ? 3 : 1) * (f.slowSql > 0 ? 0.42 : 1) * idc;

    let hit = state.on.cache ? 0.86 : 0.03;
    if (state.on.hotspot) hit = Math.min(0.97, hit + 0.05);
    if (f.cacheAvalanche > 0) hit = state.on.cache ? 0.15 : 0.02;
    if (f.hotKey > 0) hit = Math.max(0, hit - 0.08);
    hit = clamp(hit, 0, 0.98);

    let dbDemand = (ingress * 0.55 * (1 - hit) + ingress * 0.1) *
      (f.hotKey > 0 ? (state.on.hotspot ? 1.15 : 1.5) : 1);

    let svcDemand = ingress;
    if (state.on.degrade && (dbDemand / dbCap > 0.8 || svcDemand / svcCap > 1)) {
      dbDemand *= 0.62;
      svcDemand *= 0.78;
    }

    let rejected = 0;
    if (state.on.queue) {
      const cap = svcCap * 0.95;
      const excess = Math.max(0, svcDemand - cap);
      svcDemand = Math.min(svcDemand, cap);
      const drain = svcCap * 0.045;
      state.queueBuffer = clamp(state.queueBuffer + (excess * 0.62 - drain) * dt, 0, 900000);
    } else {
      state.queueBuffer = Math.max(0, state.queueBuffer - 220000 * dt);
    }
    if (state.on.rateLimit && svcDemand > svcCap * 1.12) {
      rejected = svcDemand - svcCap * 1.12;
      svcDemand = svcCap * 1.12;
    }

    const svcLoad = svcDemand / Math.max(1, svcCap);
    const dbLoad = dbDemand / Math.max(1, dbCap);
    const overload = Math.max(0, svcLoad - 1) + Math.max(0, dbLoad - 1);

    let error = 0.02 + (rejected / Math.max(1, rawQps)) * 100 + overload * 46;
    if (f.idcDown > 0) error += 1.4;
    if (f.hotKey > 0) error += 0.6;
    if (state.on.degrade) error = Math.min(error, 1.8 + overload * 8);
    error = clamp(error, 0, 99);

    let latency = 55 + 70 * Math.pow(svcLoad, 3) + 900 * Math.pow(Math.max(0, dbLoad - 0.8), 2)
      + state.queueBuffer / 220 + (f.slowSql > 0 ? 320 : 0)
      + (f.cacheAvalanche > 0 ? 90 : 0) + (f.idcDown > 0 ? 40 : 0);

    if (state.crashed) {
      error = 92;
      latency = 2600 + Math.sin(state.t * 7) * 300;
    }

    state.buffers = {
      qps: rawQps,
      ingress,
      latency,
      error,
      db: dbLoad * 100,
      svc: svcLoad,
      hit,
      rejected,
      dbDemand,
    };

    /* 雪崩判定 */
    const over = svcLoad > 1.22 || dbLoad > 1.18;
    const protectedNow = state.on.rateLimit || state.on.queue || state.on.degrade;
    if (!state.crashed) {
      if (over && !protectedNow) {
        state.overloadTimer += dt;
        if (state.overloadTimer > 1.2) triggerCrash();
      } else {
        state.overloadTimer = Math.max(0, state.overloadTimer - dt * 1.6);
      }
    } else {
      state.crashMelt = Math.min(1, state.crashMelt + dt * 1.5);
      if (svcLoad < 1.02 && dbLoad < 1.02 && (protectedNow || state.traffic <= 1.5)) {
        state.recoverTimer = (state.recoverTimer || 0) + dt;
        if (state.recoverTimer > 2.2) recover();
      } else {
        state.recoverTimer = 0;
      }
    }

    state.histTimer += dt;
    if (state.histTimer > 0.2) {
      state.histTimer = 0;
      state.history.push({ qps: rawQps, err: error, db: dbLoad * 100 });
      if (state.history.length > 150) state.history.shift();
    }
  }

  function triggerCrash() {
    state.crashed = true;
    state.crashMelt = 0;
    state.overloadTimer = 0;
    state.recoverTimer = 0;
    state.queueBuffer *= 1.2;
    A.audio.chord([180, 140, 110], 0.5);
    log("服务与数据库同时过载，线程池耗尽 —— 系统雪崩", "bad");
    addSpark(nodes.service.cx, nodes.service.cy, "#ff5d6c", 26);
    addSpark(nodes.db.cx, nodes.db.cy, "#ff9a52", 22);
    nodes.service.flash = 1;
    nodes.db.flash = 1;
  }

  function recover() {
    state.crashed = false;
    state.crashMelt = 0;
    state.recoverTimer = 0;
    state.overloadTimer = 0;
    state.queueBuffer *= 0.25;
    A.audio.chord([520, 660, 880], 0.22);
    log("保护策略生效，服务恢复中 —— 已重新接住流量", "ok");
  }

  /* ---------------- 绘制 ---------------- */
  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawGrid(time) {
    const W = view.w, H = view.h;
    ctx.save();
    ctx.strokeStyle = "rgba(90,140,210,.09)";
    ctx.lineWidth = 1;
    const gap = 46;
    const off = (time * 6) % gap;
    for (let x = -off; x < W; x += gap) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += gap) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();
  }

  const LINKS = [
    ["clients", "gateway", null],
    ["clients", "cdn", "cdn"],
    ["gateway", "cache", "cache"],
    ["cache", "service", null],
    ["service", "breaker", "degrade"],
    ["breaker", "db", "sharding"],
    ["service", "db", null],
    ["gateway", "queue", "queue"],
    ["queue", "service", null],
  ];

  function edgePoint(a, b) {
    const dx = b.cx - a.cx, dy = b.cy - a.cy;
    const tx = Math.min(a.w / 2 / Math.abs(dx || 1), 0.5);
    const ty = Math.min(a.h / 2 / Math.abs(dy || 1), 0.5);
    const t2x = Math.min(b.w / 2 / Math.abs(dx || 1), 0.5);
    const t2y = Math.min(b.h / 2 / Math.abs(dy || 1), 0.5);
    return {
      x1: a.cx + dx * Math.min(tx, ty),
      y1: a.cy + dy * Math.min(tx, ty),
      x2: b.cx - dx * Math.min(t2x, t2y),
      y2: b.cy - dy * Math.min(t2x, t2y),
    };
  }

  function drawLinks(time) {
    LINKS.forEach(([from, to, feature]) => {
      const a = nodes[from], b = nodes[to];
      if (!a || !b) return;
      const active = feature ? isOn(feature) : true;
      const { x1, y1, x2, y2 } = edgePoint(a, b);
      ctx.save();
      ctx.lineWidth = active ? 1.6 : 1;
      ctx.strokeStyle = active ? "rgba(96,180,255,.3)" : "rgba(110,130,165,.12)";
      ctx.setLineDash([5, 9]);
      ctx.lineDashOffset = -time * 26;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (active) {
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(90,200,255,.45)";
        const t = (time * 0.22 + (from.length + to.length) * 0.09) % 1;
        ctx.beginPath();
        ctx.arc(lerp(x1, x2, t), lerp(y1, y2, t), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
  }

  function nodeSub(n) {
    const b = state.buffers;
    switch (n.id) {
      case "clients": return `${fmt(b.qps)} QPS`;
      case "gateway": return isOn("rateLimit") ? "限流保护中" : "无保护";
      case "cache": return isOn("cache") ? `命中 ${(b.hit * 100).toFixed(0)}%` : "未启用";
      case "service": return `${(2 + state.capacityRamp * 4).toFixed(0)} 组 · ${(b.svc * 100).toFixed(0)}%`;
      case "queue": return `${fmt(state.queueBuffer)} 积压`;
      case "breaker": return isOn("degrade") ? "降级保护中" : "关闭";
      case "db": return `负载 ${b.db.toFixed(0)}%`;
      case "cdn": return isOn("cdn") ? "已接管静态" : "未启用";
      default: return "";
    }
  }

  const NODE_ACCENT = {
    clients: "#7aa6ff", cdn: "#38e1ff", gateway: "#62b4ff", cache: "#34e0a1",
    service: "#ffb648", queue: "#b07bff", breaker: "#ff7ad1", db: "#ff9a52",
  };

  function drawNodes(time) {
    Object.values(nodes).forEach((n) => {
      const accent = NODE_ACCENT[n.id];
      const active = n.feature ? isOn(n.feature) : true;
      const hover = state.hover === n.id;
      const danger = state.crashed && (n.id === "service" || n.id === "db" || n.id === "gateway");
      const glow = n.flash;
      n.flash = Math.max(0, n.flash - 0.03);

      ctx.save();
      if (danger) ctx.translate(rand(-2.5, 2.5) * state.crashMelt, rand(-1.5, 1.5) * state.crashMelt);

      const grad = ctx.createLinearGradient(n.x, n.y, n.x, n.y + n.h);
      grad.addColorStop(0, active ? "rgba(28,52,84,.96)" : "rgba(17,27,45,.94)");
      grad.addColorStop(1, active ? "rgba(13,26,45,.98)" : "rgba(11,19,33,.96)");

      if (hover || glow > 0) {
        ctx.shadowColor = accent;
        ctx.shadowBlur = 22 + glow * 26;
      }
      roundRect(n.x, n.y, n.w, n.h, 11);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.lineWidth = hover ? 1.8 : 1;
      ctx.strokeStyle = danger
        ? `rgba(255,93,108,${0.5 + 0.4 * Math.sin(time * 12)})`
        : active ? `${accent}88` : "rgba(120,150,195,.2)";
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(n.x + 10, n.y + 1);
      ctx.lineTo(n.x + n.w - 10, n.y + 1);
      ctx.strokeStyle = active ? `${accent}55` : "rgba(120,150,195,.12)";
      ctx.stroke();

      ctx.fillStyle = accent;
      ctx.globalAlpha = active ? 0.95 : 0.38;
      ctx.font = '700 9.5px "JetBrains Mono", Consolas, monospace';
      ctx.textAlign = "center";
      ctx.fillText(FEATURES[n.feature]?.glyph || "USER", n.cx, n.y + 15);
      ctx.globalAlpha = 1;

      ctx.fillStyle = active ? "#e8f2ff" : "#879bb9";
      ctx.font = '600 12px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(n.title, n.cx, n.y + 32);
      ctx.fillStyle = danger ? "#ff9aa6" : active ? "#7fb6e8" : "#5f7392";
      ctx.font = '9.5px "JetBrains Mono", Consolas, monospace';
      ctx.fillText(nodeSub(n), n.cx, n.y + 46);

      const bx = n.x + n.w - 11, by = n.y + 10;
      const invite = n.feature && !active;
      ctx.beginPath();
      ctx.arc(bx, by, invite ? 5.2 + Math.sin(time * 4) : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = active ? `${accent}cc` : invite ? "rgba(56,225,255,.85)" : "rgba(120,150,195,.4)";
      ctx.fill();
      if (invite) {
        ctx.strokeStyle = "rgba(56,225,255,.45)";
        ctx.beginPath();
        ctx.arc(bx, by, 8 + Math.sin(time * 4) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (n.id === "service") {
        const count = Math.round(2 + state.capacityRamp * 4);
        const bw = 7, gap = 3;
        const total = count * bw + (count - 1) * gap;
        let sx = n.cx - total / 2;
        for (let i = 0; i < count; i++) {
          ctx.fillStyle = "rgba(255,182,72,.8)";
          ctx.fillRect(sx, n.y + n.h - 7, bw, 3);
          sx += bw + gap;
        }
      }

      if (n.id === "queue" && state.queueBuffer > 0) {
        const hRatio = clamp(state.queueBuffer / 260000, 0.08, 1);
        for (let i = 0; i < 7; i++) {
          const lit = i / 7 < hRatio;
          ctx.fillStyle = lit ? "rgba(176,123,255,.9)" : "rgba(176,123,255,.15)";
          ctx.fillRect(n.x + 10 + i * 6, n.y + n.h - 6, 4, 3);
        }
      }
      ctx.restore();
    });
  }

  function drawParticles() {
    if (!particles.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      const a = p.pts[p.seg];
      const b = p.pts[p.seg + 1];
      if (!a) continue;
      const alpha = p.dead ? Math.max(0, p.life) : 1;
      if (alpha <= 0.01) continue;
      const tt = b ? clamp(p.t, 0, 1) : 1;
      const x = b ? lerp(a.x, b.x, tt) : a.x;
      const y = b ? lerp(a.y, b.y, tt) : a.y;

      // 拖尾：沿当前路段取一小段渐隐的线
      if (b && !p.dead) {
        const back = Math.max(0, tt - 0.22);
        const tx = lerp(a.x, b.x, back);
        const ty = lerp(a.y, b.y, back);
        if (Math.hypot(x - tx, y - ty) > 0.4) {
          const grad = ctx.createLinearGradient(tx, ty, x, y);
          grad.addColorStop(0, "rgba(0,0,0,0)");
          grad.addColorStop(1, p.color);
          ctx.globalAlpha = alpha * 0.5;
          ctx.strokeStyle = grad;
          ctx.lineWidth = p.size * 0.8;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
      }

      // 光晕 + 核心
      ctx.globalAlpha = alpha * 0.18;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, p.size * 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSparks() {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    state.sparks.forEach((s) => {
      ctx.globalAlpha = Math.max(0, s.life);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawRipples() {
    state.ripples.forEach((r) => {
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(56,225,255,${Math.max(0, r.life) * 0.5})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  function drawChart() {
    const W = view.w;
    const cw = clamp(W * 0.27, 160, 236);
    const ch = 62;
    const x = W - cw - 14;
    const y = 12;
    const b = state.buffers;

    ctx.save();
    roundRect(x, y, cw, ch, 10);
    ctx.fillStyle = "rgba(6,12,23,.72)";
    ctx.fill();
    ctx.strokeStyle = "rgba(120,160,220,.18)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "rgba(150,180,220,.7)";
    ctx.font = '9px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = "left";
    ctx.fillText("入口 QPS / 最近 30s", x + 9, y + 13);
    ctx.textAlign = "right";
    ctx.fillStyle = state.crashed ? "#ff7c8a" : "#8ce9ff";
    ctx.fillText(fmt(b.qps), x + cw - 9, y + 13);

    const maxQ = Math.max(120000, ...state.history.map((h) => h.qps)) * 1.08;
    const chartX = x + 9;
    const chartY = y + 20;
    const chartW = cw - 18;
    const chartH = ch - 28;

    // 容量参考线
    const cap = 10500 * (2 + state.capacityRamp * 4);
    const capY = chartY + chartH - (cap / maxQ) * chartH;
    if (capY > chartY) {
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(255,182,72,.35)";
      ctx.beginPath();
      ctx.moveTo(chartX, capY);
      ctx.lineTo(chartX + chartW, capY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (state.history.length > 1) {
      const step = chartW / Math.max(1, state.history.length - 1);
      ctx.beginPath();
      state.history.forEach((h, i) => {
        const px = chartX + i * step;
        const py = chartY + chartH - (h.qps / maxQ) * chartH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = state.crashed ? "#ff5d6c" : "#38e1ff";
      ctx.lineWidth = 1.4;
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.lineTo(chartX + chartW, chartY + chartH);
      ctx.lineTo(chartX, chartY + chartH);
      ctx.closePath();
      const area = ctx.createLinearGradient(0, chartY, 0, chartY + chartH);
      area.addColorStop(0, state.crashed ? "rgba(255,93,108,.28)" : "rgba(56,225,255,.22)");
      area.addColorStop(1, "rgba(56,225,255,0)");
      ctx.fillStyle = area;
      ctx.fill();
    }
    ctx.restore();
  }

  function draw(time) {
    const W = view.w, H = view.h;
    ctx.clearRect(0, 0, W, H);

    if (state.crashed) {
      const pulse = 0.06 + 0.05 * Math.sin(time * 6);
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.15, W / 2, H / 2, H * 0.9);
      g.addColorStop(0, "rgba(120,10,24,0)");
      g.addColorStop(1, `rgba(255,40,64,${pulse})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    drawGrid(time);
    drawLinks(time);
    drawParticles();
    drawSparks();
    drawNodes(time);
    drawRipples();
    drawChart();

    if (state.crashed) {
      ctx.save();
      ctx.fillStyle = "rgba(255,120,130,.85)";
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.textAlign = "center";
      ctx.fillText("THREAD POOL EXHAUSTED · 请启用限流 / 队列 / 降级", W / 2, H - 22);
      ctx.restore();
    }
  }

  /* ---------------- UI 刷新 ---------------- */
  const el = {
    qps: document.getElementById("mQps"),
    qpsTrend: document.getElementById("mQpsTrend"),
    latency: document.getElementById("mLatency"),
    latencyTrend: document.getElementById("mLatencyTrend"),
    error: document.getElementById("mError"),
    errorTrend: document.getElementById("mErrorTrend"),
    db: document.getElementById("mDb"),
    dbTrend: document.getElementById("mDbTrend"),
    queue: document.getElementById("mQueue"),
    queueTrend: document.getElementById("mQueueTrend"),
    clock: document.getElementById("peakClock"),
    badge: document.getElementById("peakLevelBadge"),
    trafficLabel: document.getElementById("peakTrafficLabel"),
  };

  function setMetric(node, level) {
    const card = node.closest(".metric");
    card.classList.remove("good", "up", "bad");
    if (level) card.classList.add(level);
  }

  function updateUI() {
    const b = state.buffers;
    el.qps.textContent = fmt(b.qps);
    el.latency.innerHTML = b.latency >= 1000
      ? `${(b.latency / 1000).toFixed(1)}<em>s</em>`
      : `${Math.round(b.latency)}<em>ms</em>`;
    el.error.innerHTML = `${b.error.toFixed(2)}<em>%</em>`;
    el.db.innerHTML = `${Math.round(clamp(b.db, 0, 999))}<em>%</em>`;
    el.queue.textContent = fmt(state.queueBuffer);

    el.qpsTrend.textContent = state.burst > 1.15 ? `洪峰 ×${state.burst.toFixed(1)}` : "基线";
    el.latencyTrend.textContent = b.latency > 1200 ? "严重超时" : b.latency > 300 ? "偏高" : "健康";
    el.errorTrend.textContent = b.error > 5 ? "大量失败" : b.error > 0.5 ? "有损运行" : "健康";
    el.dbTrend.textContent = b.db > 100 ? "过载" : b.db > 80 ? "压力较大" : "余量充足";
    el.queueTrend.textContent = state.queueBuffer > 120000 ? "严重积压" : state.queueBuffer > 0 ? "削峰中" : "无积压";

    setMetric(el.qps, state.burst > 1.15 ? "up" : null);
    setMetric(el.latency, b.latency > 1200 ? "bad" : b.latency > 300 ? "up" : "good");
    setMetric(el.error, b.error > 5 ? "bad" : b.error > 0.5 ? "up" : "good");
    setMetric(el.db, b.db > 100 ? "bad" : b.db > 80 ? "up" : "good");
    setMetric(el.queue, state.queueBuffer > 120000 ? "bad" : state.queueBuffer > 0 ? "up" : "good");

    const total = ((state.clockBase + Math.floor(state.t)) % 86400 + 86400) % 86400;
    const hh = String(Math.floor(total / 3600)).padStart(2, "0");
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    el.clock.textContent = `${hh}:${mm}:${ss}`;

    const lvl = onCount();
    const names = ["裸奔", "起步", "加固", "稳健", "铁壁", "满配"];
    el.badge.textContent = `Lv.${lvl} ${names[Math.min(4, Math.floor(lvl / 2))]}`;

    const span = statusChip.querySelector("span");
    statusChip.classList.remove("warn", "danger");
    if (state.crashed) {
      statusChip.classList.add("danger");
      span.textContent = "系统雪崩";
      banner.className = "peak-banner show";
      banner.textContent = "系统雪崩";
    } else if (b.svc > 1 || b.db > 90 || state.queueBuffer > 80000) {
      statusChip.classList.add("warn");
      span.textContent = "高负载 · 保护中";
      banner.className = "peak-banner show banner-warn";
      banner.textContent = state.on.degrade ? "降级保护生效" : "接近容量上限";
    } else if (b.qps > 60000) {
      statusChip.classList.add("warn");
      span.textContent = "洪峰通过中";
      banner.className = "peak-banner show banner-warn";
      banner.textContent = "洪峰通过中";
    } else {
      span.textContent = "系统平稳";
      banner.className = "peak-banner";
      banner.textContent = "";
    }

    document.querySelectorAll("[data-fault]").forEach((btn) => {
      btn.classList.toggle("active", state.faults[btn.dataset.fault] > 0);
    });
    document.querySelectorAll("#peakSwitches .switch-btn").forEach((btn) => {
      btn.classList.toggle("on", !!state.on[btn.dataset.feature]);
    });
  }

  /* ---------------- 交互 ---------------- */
  function nodeAt(x, y) {
    return Object.values(nodes).find(
      (n) => x >= n.x - 6 && x <= n.x + n.w + 6 && y >= n.y - 6 && y <= n.y + n.h + 6
    ) || null;
  }

  function toggleFeature(key) {
    if (!FEATURES[key]) return;
    state.on[key] = !state.on[key];
    const on = state.on[key];
    const f = FEATURES[key];
    const target = Object.values(nodes).find((n) => n.feature === key);
    if (target) {
      target.flash = 1;
      addSpark(target.cx, target.cy, on ? "#38e1ff" : "#ff5d6c", 10);
    }
    A.audio.blip(on ? 640 : 320, 0.1, on ? "sine" : "square", 0.045);
    log(`${on ? "开启" : "关闭"}「${f.name}」 · ${on ? f.desc : f.cost}`, on ? "ok" : "warn");
    updateUI();
  }

  function syncSwitches() {
    document.querySelectorAll("#peakSwitches .switch-btn").forEach((btn) => {
      btn.classList.toggle("on", !!state.on[btn.dataset.feature]);
    });
  }

  const FAULT_INFO = {
    cacheAvalanche: { dur: 12, node: "cache", msg: "缓存雪崩：大批热点 Key 同时过期，请求直冲数据库", kind: "bad", color: "#34e0a1" },
    hotKey: { dur: 14, node: "cache", msg: "热点 Key：单个 SKU 打满缓存分片", kind: "warn", color: "#ffb648" },
    idcDown: { dur: 12, node: "service", msg: "机房断电：三分之一服务与数据库实例下线", kind: "bad", color: "#ff5d6c" },
    slowSql: { dur: 12, node: "db", msg: "慢查询：数据库连接池被长时间占用", kind: "warn", color: "#ff9a52" },
  };

  function injectFault(key) {
    const info = FAULT_INFO[key];
    if (!info) return;
    state.faults[key] = info.dur;
    const n = nodes[info.node];
    if (n) { n.flash = 1; addSpark(n.cx, n.cy, info.color, 14); }
    A.audio.blip(220, 0.25, "sawtooth", 0.05);
    log(info.msg, info.kind);
    updateUI();
  }

  function resetAll() {
    state.on = {};
    state.faults = { cacheAvalanche: 0, hotKey: 0, idcDown: 0, slowSql: 0 };
    state.crashed = false;
    state.crashMelt = 0;
    state.overloadTimer = 0;
    state.recoverTimer = 0;
    state.queueBuffer = 0;
    state.traffic = 1;
    state.burst = 1;
    state.spikeAt = -1;
    state.capacityRamp = 0;
    state.history = [];
    state.ripples = [];
    state.sparks = [];
    particles.length = 0;
    state.t = 0;
    state.clockBase = 23 * 3600 + 59 * 60 + 52;
    document.getElementById("peakTraffic").value = "1";
    el.trafficLabel.textContent = "1.0×";
    syncSwitches();
    updateUI();
    log("演练已重置：一切回到零点前的平静", "info");
  }

  function bind() {
    const grid = document.getElementById("peakSwitches");
    Object.entries(FEATURES).forEach(([key, f]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "switch-btn";
      btn.dataset.feature = key;
      btn.innerHTML = `<span class="sw"></span><span>${f.name}</span>`;
      btn.title = `${f.desc} · ${f.cost}`;
      btn.addEventListener("click", () => toggleFeature(key));
      grid.appendChild(btn);
    });

    wrap.addEventListener("pointermove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const n = nodeAt(x, y);
      state.hover = n ? n.id : null;
      canvas.style.cursor = n && n.feature ? "pointer" : "crosshair";
    });
    wrap.addEventListener("pointerleave", () => { state.hover = null; });

    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      state.ripples.push({ x, y, r: 4, life: 1 });
      addSpark(x, y, "#38e1ff", 5);
      const n = nodeAt(x, y);
      if (n && n.feature) toggleFeature(n.feature);
      else if (n) log("用户层：所有请求从这里涌入，先被 CDN 和网关分流", "info");
    });

    document.getElementById("peakTraffic").addEventListener("input", (e) => {
      state.traffic = parseFloat(e.target.value);
      el.trafficLabel.textContent = `${state.traffic.toFixed(1)}×`;
    });

    document.getElementById("peakSpike").addEventListener("click", () => {
      state.spikeAt = state.t;
      A.audio.chord([880, 1180, 1480], 0.16);
      addSpark(nodes.clients.cx, nodes.clients.cy, "#38e1ff", 18);
      log("23:59:59 —— 零点洪峰抵达，入口 QPS 瞬间拉满", "warn");
    });

    document.getElementById("peakReset").addEventListener("click", resetAll);
    document.querySelectorAll("[data-fault]").forEach((btn) => {
      btn.addEventListener("click", () => injectFault(btn.dataset.fault));
    });
  }

  /* ---------------- 主循环 ---------------- */
  let running = false;
  let visible = true;
  let last = 0;
  let uiAcc = 0;

  function frame(now) {
    A.tickFps(now);
    if (!running) return;
    const dt = clamp((now - last) / 1000 || 0.016, 0, 0.05);
    last = now;
    if (!visible) {
      requestAnimationFrame(frame);
      return;
    }
    state.t += dt;
    computeMetrics(dt);

    const rate = clamp(state.buffers.ingress / 1300, 3, 110);
    spawnAcc += rate * dt;
    while (spawnAcc >= 1) { spawnAcc -= 1; spawnParticle(); }

    updateParticles(dt);
    updateSparks(dt);
    updateRipples(dt);

    uiAcc += dt;
    if (uiAcc > 0.15) { uiAcc = 0; updateUI(); }

    draw(state.t);
    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    bind();
    updateUI();
    log("演练就绪：当前无任何保护，试试直接触发零点洪峰", "info");
    requestAnimationFrame(frame);
  }

  const api = {
    start,
    setVisible(v) { visible = v; if (v) last = performance.now(); },
  };
  A.registerScene("peak", api);
  return api;
})();







