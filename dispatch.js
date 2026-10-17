/* =====================================================================
   dispatch.js — 十万骑手实时派单
   ===================================================================== */
window.DispatchScene = (() => {
  const A = window.App;
  const { clamp, rand, randInt, pick, fmt, lerp, audio } = A;

  const canvas = document.getElementById("dispatchCanvas");
  const { ctx, state: view } = A.setupCanvas(canvas);
  const wrap = document.getElementById("dispatchWrap");
  const rainLayer = document.getElementById("rainLayer");
  const toastEl = document.getElementById("dispatchToast");
  const log = A.makeLogger(document.getElementById("dispatchLog"), 30);

  const card = {
    root: document.getElementById("riderCard"),
    name: document.getElementById("riderName"),
    state: document.getElementById("riderState"),
    load: document.getElementById("riderLoad"),
    done: document.getElementById("riderDone"),
    onTime: document.getElementById("riderOnTime"),
    score: document.getElementById("riderScore"),
    assign: document.getElementById("riderAssign"),
  };

  const VISIBLE_RIDERS = 180;
  const SIM_MIN_PER_SEC = 6;     // 1 秒真实时间 ≈ 6 分钟城市时间（加速仿真）
  const BASE_PROMISE = 38;

  const HOTSPOTS = [
    { x: 0.18, y: 0.30, r: 86, name: "西单商圈" },
    { x: 0.44, y: 0.20, r: 74, name: "国贸 CBD" },
    { x: 0.76, y: 0.34, r: 92, name: "望京" },
    { x: 0.28, y: 0.72, r: 80, name: "中关村" },
    { x: 0.62, y: 0.70, r: 88, name: "三里屯" },
    { x: 0.84, y: 0.78, r: 70, name: "亦庄" },
  ];

  const state = {
    t: 0,
    running: true,
    visible: false,
    strategy: "nearest",
    totalRiders: 100000,
    pressure: 1,
    spawnAcc: 0,
    paused: false,
    riders: [],
    orders: [],
    beams: [],
    sparks: [],
    pulses: [],
    selected: null,
    weather: "clear",
    rushTimer: 0,
    outageTimer: 0,
    outageSpot: -1,
    lightning: 0,
    assignTimes: [],
    deliveryTimes: [],
    delivered: 0,
    onTime: 0,
    throughput: 0,
    deliverWindow: [],
    uiTimer: 0,
    cardTimer: 0,
    batchTimer: 0,
    batchQueue: [],
    nextOrderId: 100001,
    clockBase: 12 * 3600,
    flash: 0,
    hoverRider: null,
  };

  const stats = { idle: 0, busy: 0 };

  function simMinute() { return state.t * SIM_MIN_PER_SEC; }
  function scaleFactor() { return state.totalRiders / Math.max(1, state.riders.length); }
  function promise() { return BASE_PROMISE + (state.weather === "rain" ? 8 : 0); }

  function hotspotPoint(i) {
    const h = HOTSPOTS[i % HOTSPOTS.length];
    const ang = rand(0, Math.PI * 2);
    const rad = rand(0, h.r * 0.75);
    return { x: h.x * view.w + Math.cos(ang) * rad, y: h.y * view.h + Math.sin(ang) * rad };
  }

  function randomPoint() {
    return {
      x: rand(view.w * 0.06, view.w * 0.94),
      y: rand(view.h * 0.1, view.h * 0.92),
    };
  }

  function riderName(i) {
    const n = (10000 + ((i * 3719) % 89999)) % 100000;
    return `骑手 #${String(n).padStart(5, "0")}`;
  }

  function makeRider(i) {
    const p = randomPoint();
    return {
      i,
      name: riderName(i),
      x: p.x,
      y: p.y,
      vx: 0,
      vy: 0,
      speed: rand(88, 122),
      mode: "idle",
      target: null,
      order: null,
      orders: [],
      load: 0,
      done: 0,
      onTime: 0,
      totalDone: 0,
      score: (4.6 + Math.random() * 0.4).toFixed(1),
      trail: [],
      angle: rand(0, Math.PI * 2),
      wait: 0,
    };
  }

  function resetRiders() {
    state.riders = [];
    const n = Math.round(clamp(view.w / 5.2, 110, VISIBLE_RIDERS));
    for (let i = 0; i < n; i++) state.riders.push(makeRider(i));
  }

  function makeOrder(at, near) {
    let pickup;
    if (at) pickup = { x: at.x, y: at.y };
    else if (near) {
      pickup = hotspotPoint(near);
    } else if (Math.random() < 0.62) {
      pickup = hotspotPoint(randInt(0, HOTSPOTS.length - 1));
    } else {
      pickup = randomPoint();
    }
    let drop;
    if (near && Math.random() < 0.45) {
      const h = HOTSPOTS[near];
      const ang = rand(0, Math.PI * 2);
      drop = { x: h.x * view.w + Math.cos(ang) * h.r * 1.35, y: h.y * view.h + Math.sin(ang) * h.r * 1.35 };
    } else if (Math.random() < 0.6) {
      drop = hotspotPoint(randInt(0, HOTSPOTS.length - 1));
    } else {
      drop = randomPoint();
    }
    drop.x = clamp(drop.x, 24, view.w - 24);
    drop.y = clamp(drop.y, 24, view.h - 24);
    return {
      id: state.nextOrderId++,
      pickup,
      drop,
      created: simMinute(),
      assignedAt: null,
      pickedAt: null,
      delivered: null,
      rider: null,
      waiting: true,
      timeout: false,
      life: 1,
    };
  }

  layout();
  function layout() {
    if (!state.riders.length) resetRiders();
    if (view.w < 20 || view.h < 20) return;
    const oldW = state._w || view.w;
    const oldH = state._h || view.h;
    state._w = view.w;
    state._h = view.h;
    const first = oldW < 40 || oldH < 40;
    if (first) {
      state.riders.forEach((r) => {
        const p = randomPoint();
        r.x = p.x; r.y = p.y; r.target = null;
      });
      state.orders.forEach((o) => {
        o.pickup = randomPoint();
        o.drop = randomPoint();
      });
      state.riders.forEach((r) => { if (r.orders.length) startNext(r); });
      return;
    }
    const sx = view.w / oldW || 1;
    const sy = view.h / oldH || 1;
    state.riders.forEach((r) => {
      r.x = clamp(r.x * sx, 12, view.w - 12);
      r.y = clamp(r.y * sy, 12, view.h - 12);
    });
    state.orders.forEach((o) => {
      o.pickup.x *= sx; o.pickup.y *= sy;
      o.drop.x *= sx; o.drop.y *= sy;
    });
  }
  new ResizeObserver(layout).observe(wrap);

  /* ---------------- 派单算法 ---------------- */
  const strategyNames = { nearest: "就近派单", balanced: "负载均衡", global: "全局最优", random: "随机派单" };

  function distanceCost(r, o) {
    return A.dist(r, o.pickup);
  }

  function canTake(r, allowBusy) {
    return r.orders.length === 0 || (allowBusy && r.orders.length < 2);
  }

  function assign(rider, order) {
    order.waiting = false;
    order.assignedAt = simMinute();
    order.rider = rider;
    rider.orders.push(order);
    rider.load = rider.orders.length;
    const wait = Math.max(0, order.assignedAt - order.created);
    state.assignTimes.push(wait);
    if (state.assignTimes.length > 90) state.assignTimes.shift();
    state.beams.push({
      x1: rider.x, y1: rider.y,
      x2: order.pickup.x, y2: order.pickup.y,
      life: 1, kind: "assign", color: "#38e1ff",
    });
    state.pulses.push({ x: order.pickup.x, y: order.pickup.y, r: 3, life: 1, color: "#ffb648" });
    if (rider.orders.length === 1) {
      rider.mode = "pickup";
      rider.target = { x: order.pickup.x, y: order.pickup.y };
    }
    A.audio.blip(760 + Math.random() * 120, 0.03, "sine", 0.012);
  }

  function nearestIdle(order) {
    let best = null, bestD = Infinity;
    for (const r of state.riders) {
      if (!canTake(r, false)) continue;
      const d = distanceCost(r, order);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  function balancedPick(order) {
    let best = null, bestCost = Infinity;
    for (const r of state.riders) {
      if (!canTake(r, true)) continue;
      const cost = distanceCost(r, order) + r.orders.length * 110;
      if (cost < bestCost) { bestCost = cost; best = r; }
    }
    return best;
  }

  function randomPick() {
    const pool = state.riders.filter((r) => canTake(r, false));
    return pool.length ? pick(pool) : null;
  }

  function autoAssign(order) {
    if (state.strategy === "global") {
      state.batchQueue.push(order);
      return;
    }
    const rider = state.strategy === "nearest" ? nearestIdle(order)
      : state.strategy === "balanced" ? balancedPick(order)
      : randomPick();
    if (rider) assign(rider, order);
  }

  function runBatch() {
    const pool = state.batchQueue.filter((o) => o.waiting);
    state.batchQueue = [];
    if (!pool.length) return;
    const pairs = [];
    for (const o of pool) {
      for (const r of state.riders) {
        if (!canTake(r, true)) continue;
        pairs.push({
          o, r,
          cost: distanceCost(r, o) + r.orders.length * 95 + (o.timeout ? -60 : 0),
        });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const usedOrders = new Set();
    const usedRiders = new Set();
    let matched = 0;
    for (const p of pairs) {
      if (usedOrders.has(p.o.id) || usedRiders.has(p.r.i)) continue;
      if (p.r.orders.length >= 2) continue;
      usedOrders.add(p.o.id);
      usedRiders.add(p.r.i);
      assign(p.r, p.o);
      matched++;
    }
    if (matched) {
      state.pulses.push({ x: view.w * 0.5, y: 18, r: 4, life: 1, color: "#b07bff" });
    }
  }

  /* ---------------- 仿真推进 ---------------- */
  function startNext(rider) {
    const order = rider.orders[0];
    if (!order) {
      rider.mode = "idle";
      rider.target = null;
      return;
    }
    rider.mode = "pickup";
    rider.target = { x: order.pickup.x, y: order.pickup.y };
  }

  function completeOrder(rider, order) {
    order.delivered = simMinute();
    const dur = Math.max(0, order.delivered - order.created);
    state.deliveryTimes.push(dur);
    if (state.deliveryTimes.length > 100) state.deliveryTimes.shift();
    state.delivered++;
    rider.done++;
    if (dur <= promise()) {
      state.onTime++;
      rider.onTime++;
    }
    state.deliverWindow.push(state.t);
    state.pulses.push({ x: order.drop.x, y: order.drop.y, r: 4, life: 1, color: "#34e0a1" });
    for (let i = 0; i < 4; i++) {
      state.sparks.push({
        x: order.drop.x, y: order.drop.y,
        vx: rand(-40, 40), vy: rand(-50, -5),
        life: 1, color: "#34e0a1", r: rand(1, 2),
      });
    }
    rider.orders.shift();
    rider.load = rider.orders.length;
    order.life = 0;
    startNext(rider);
  }

  function moveRider(r, dt) {
    if (!r.target) return;
    const dx = r.target.x - r.x;
    const dy = r.target.y - r.y;
    const d = Math.hypot(dx, dy);
    if (d < 5) {
      const order = r.orders[0];
      if (!order) { startNext(r); return; }
      if (r.mode === "pickup") {
        order.pickedAt = simMinute();
        r.mode = "drop";
        r.target = { x: order.drop.x, y: order.drop.y };
        state.pulses.push({ x: order.pickup.x, y: order.pickup.y, r: 5, life: 1, color: "#b07bff" });
        state.beams.push({
          x1: order.pickup.x, y1: order.pickup.y,
          x2: order.drop.x, y2: order.drop.y,
          life: 1, kind: "route", color: "#b07bff",
        });
        A.audio.blip(520, 0.04, "triangle", 0.014);
      } else if (r.mode === "drop") {
        completeOrder(r, order);
      }
      return;
    }
    let mul = state.weather === "rain" ? 0.65 : 1;
    if (state.outageTimer > 0 && state.outageSpot >= 0) {
      const h = HOTSPOTS[state.outageSpot];
      const hx = h.x * view.w, hy = h.y * view.h;
      if (Math.hypot(r.x - hx, r.y - hy) < h.r * 1.2) mul *= 0.5;
    }
    if (state.rushTimer > 0) mul *= 0.92;
    const step = Math.min(d, r.speed * mul * dt);
    r.x += (dx / d) * step;
    r.y += (dy / d) * step;
    r.angle = Math.atan2(dy, dx);
    if (Math.random() < 0.4) {
      r.trail.push({ x: r.x, y: r.y, life: 1 });
      if (r.trail.length > 9) r.trail.shift();
    }
  }

  function update(dt) {
    state.t += dt;
    if (state.rushTimer > 0) state.rushTimer = Math.max(0, state.rushTimer - dt);
    if (state.outageTimer > 0) {
      state.outageTimer = Math.max(0, state.outageTimer - dt);
      if (state.outageTimer === 0) state.outageSpot = -1;
    }
    if (state.weather === "rain") {
      state.lightning = Math.max(0, state.lightning - dt * 3);
      if (Math.random() < dt * 0.25) state.lightning = 1;
    }

    const spawnRate = state.riders.length * 0.062 * state.pressure
      * (state.rushTimer > 0 ? 2.4 : 1)
      * (state.weather === "rain" ? 1.15 : 1);
    state.spawnAcc += spawnRate * dt;
    while (state.spawnAcc >= 1) {
      state.spawnAcc -= 1;
      if (state.orders.filter((o) => o.waiting).length < 130) {
        state.orders.push(makeOrder());
      }
    }

    for (const r of state.riders) {
      for (const p of r.trail) p.life -= dt * 1.6;
      r.trail = r.trail.filter((p) => p.life > 0);
      moveRider(r, dt);
    }

    state.uiTimer += dt;
    if (state.uiTimer > 0.25) {
      state.uiTimer = 0;
      const pending = state.orders
        .filter((o) => o.waiting)
        .sort((a, b) => (b.timeout ? 1 : 0) - (a.timeout ? 1 : 0) || a.created - b.created);
      for (const o of pending) {
        if (state.strategy === "global") {
          if (!state.batchQueue.includes(o)) state.batchQueue.push(o);
          continue;
        }
        autoAssign(o);
      }
      const idle = state.riders.filter((r) => r.mode === "idle").length;
      stats.idle = idle;
      stats.busy = state.riders.length - idle;
    }

    if (state.strategy === "global") {
      state.batchTimer += dt;
      if (state.batchTimer > 1.1) {
        state.batchTimer = 0;
        runBatch();
      }
    }

    const now = simMinute();
    for (const o of state.orders) {
      if (o.waiting && now - o.created > promise() && !o.timeout) {
        o.timeout = true;
        log(`订单 #${String(o.id).slice(-4)} 等待超过承诺时间，进入超时队列`, "bad");
      }
      if (o.delivered !== null) o.life -= dt * 2;
    }
    state.orders = state.orders.filter((o) => o.delivered === null || o.life > 0);

    for (const b of state.beams) b.life -= dt * 0.55;
    state.beams = state.beams.filter((b) => b.life > 0);
    for (const p of state.pulses) { p.r += 46 * dt; p.life -= dt * 1.4; }
    state.pulses = state.pulses.filter((p) => p.life > 0);
    for (const s of state.sparks) {
      s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 40 * dt; s.life -= dt * 1.2;
    }
    state.sparks = state.sparks.filter((s) => s.life > 0);
    state.deliverWindow = state.deliverWindow.filter((t) => state.t - t < 20);
    state.flash = Math.max(0, state.flash - dt * 2);
  }

  /* ---------------- 绘制 ---------------- */
  let base = null;
  let baseKey = "";

  function rrect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function buildBase() {
    const key = `${Math.round(view.w)}x${Math.round(view.h)}@${view.dpr}`;
    if (base && key === baseKey) return;
    baseKey = key;
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.round(view.w * view.dpr));
    off.height = Math.max(1, Math.round(view.h * view.dpr));
    const c = off.getContext("2d");
    c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    const W = view.w, H = view.h;

    const bg = c.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#070d18");
    bg.addColorStop(0.55, "#050a13");
    bg.addColorStop(1, "#081120");
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    // 商圈热力底
    for (const h of HOTSPOTS) {
      const hx = h.x * W, hy = h.y * H;
      const g = c.createRadialGradient(hx, hy, 4, hx, hy, h.r * 1.7);
      g.addColorStop(0, "rgba(255,182,72,.10)");
      g.addColorStop(1, "rgba(255,182,72,0)");
      c.fillStyle = g;
      c.beginPath();
      c.arc(hx, hy, h.r * 1.7, 0, Math.PI * 2);
      c.fill();
    }

    // 城市街区
    const BW = 92, BH = 82, GAP = 17;
    for (let y = GAP; y < H; y += BH + GAP) {
      for (let x = GAP; x < W; x += BW + GAP) {
        const w = Math.min(BW, W - x - GAP);
        const h = Math.min(BH, H - y - GAP);
        if (w < 16 || h < 16) continue;
        const seed = (x * 13 + y * 7) % 11;
        c.fillStyle = seed % 3 === 0 ? "rgba(24,48,44,.30)" : `rgba(20,34,56,${0.26 + (seed % 4) * 0.035})`;
        rrect(c, x, y, w, h, 3);
        c.fill();
        c.strokeStyle = "rgba(96,150,220,.085)";
        c.lineWidth = 1;
        c.stroke();
        if (seed % 3 === 1) {
          c.fillStyle = "rgba(120,180,240,.055)";
          c.fillRect(x + 6, y + 7, Math.max(8, w * 0.42), 2);
          c.fillRect(x + 6, y + 13, Math.max(6, w * 0.22), 2);
        }
      }
    }

    // 主干道
    c.save();
    c.strokeStyle = "rgba(110,170,240,.09)";
    c.lineWidth = 9;
    c.lineCap = "round";
    const roads = [
      [W * 0.5, 0, W * 0.5, H],
      [0, H * 0.5, W, H * 0.5],
      [0, H * 0.16, W, H * 0.26],
      [0, H * 0.84, W, H * 0.72],
      [W * 0.24, 0, W * 0.31, H],
      [W * 0.7, 0, W * 0.64, H],
    ];
    for (const r of roads) {
      c.beginPath();
      c.moveTo(r[0], r[1]);
      c.lineTo(r[2], r[3]);
      c.stroke();
    }
    c.strokeStyle = "rgba(150,210,255,.14)";
    c.lineWidth = 1;
    c.setLineDash([9, 13]);
    for (const r of roads) {
      c.beginPath();
      c.moveTo(r[0], r[1]);
      c.lineTo(r[2], r[3]);
      c.stroke();
    }
    c.restore();

    // 河流
    c.save();
    c.strokeStyle = "rgba(38,96,168,.28)";
    c.lineWidth = 26;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(-30, H * 0.62);
    c.bezierCurveTo(W * 0.28, H * 0.5, W * 0.52, H * 0.9, W + 30, H * 0.78);
    c.stroke();
    c.strokeStyle = "rgba(120,190,255,.10)";
    c.lineWidth = 2;
    c.stroke();
    c.restore();

    // 商圈标签
    c.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textAlign = "center";
    for (const h of HOTSPOTS) {
      const hx = h.x * W, hy = h.y * H;
      c.fillStyle = "rgba(255,196,110,.72)";
      c.fillText(h.name, hx, hy + h.r * 0.55 + 14);
      c.strokeStyle = "rgba(255,182,72,.22)";
      c.lineWidth = 1;
      c.beginPath();
      c.arc(hx, hy, h.r * 0.55, 0, Math.PI * 2);
      c.stroke();
    }
    base = off;
  }

  function drawHotspots(time) {
    for (const h of HOTSPOTS) {
      const hx = h.x * view.w, hy = h.y * view.h;
      const p = 0.5 + 0.5 * Math.sin(time * 1.4 + h.x * 12);
      ctx.strokeStyle = `rgba(255,182,72,${0.06 + p * 0.08})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hx, hy, h.r * (0.72 + p * 0.12), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (state.outageTimer > 0 && state.outageSpot >= 0) {
      const h = HOTSPOTS[state.outageSpot];
      const hx = h.x * view.w, hy = h.y * view.h;
      const p = 0.5 + 0.5 * Math.sin(time * 6);
      ctx.save();
      ctx.strokeStyle = `rgba(255,93,108,${0.4 + p * 0.35})`;
      ctx.fillStyle = "rgba(255,93,108,.10)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(hx, hy, h.r * 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,140,150,.9)";
      ctx.font = "600 10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("运力受限", hx, hy - h.r * 1.2 - 8);
      ctx.restore();
    }
  }

  function drawOrders(time) {
    for (const o of state.orders) {
      const pending = o.delivered === null && o.waiting;
      const active = o.assignedAt !== null && o.delivered === null;
      if (pending) {
        const pulse = 0.5 + 0.5 * Math.sin(time * 3.4 + o.id);
        ctx.strokeStyle = o.timeout ? `rgba(255,93,108,${0.5 + pulse * 0.4})` : `rgba(255,182,72,${0.28 + pulse * 0.3})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(o.pickup.x, o.pickup.y, 5 + pulse * 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = o.timeout ? "#ff5d6c" : "#ffb648";
        ctx.beginPath();
        ctx.arc(o.pickup.x, o.pickup.y, o.timeout ? 2.6 : 2.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = o.timeout ? "rgba(255,93,108,.18)" : "rgba(255,182,72,.13)";
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.moveTo(o.pickup.x, o.pickup.y);
        ctx.lineTo(o.drop.x, o.drop.y);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (active) {
        ctx.strokeStyle = "rgba(176,123,255,.28)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(o.drop.x, o.drop.y, 3.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function drawBeams() {
    for (const b of state.beams) {
      const a = clamp(b.life, 0, 1);
      ctx.save();
      ctx.strokeStyle = b.color;
      ctx.globalAlpha = a * (b.kind === "assign" ? 0.5 : 0.34);
      ctx.lineWidth = b.kind === "assign" ? 1.2 : 1;
      ctx.setLineDash(b.kind === "assign" ? [4, 5] : [2, 7]);
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (b.kind === "assign") {
        const p = 1 - a;
        const mx = lerp(b.x1, b.x2, p);
        const my = lerp(b.y1, b.y2, p);
        ctx.globalAlpha = a;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(mx, my, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawRiders(time) {
    for (const r of state.riders) {
      const busy = r.orders.length > 0;
      const color = busy ? "#38e1ff" : "#34e0a1";
      const selected = state.selected === r.i;
      if (r.trail.length > 1) {
        ctx.strokeStyle = busy ? "rgba(56,225,255,.15)" : "rgba(52,224,161,.13)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(r.trail[0].x, r.trail[0].y);
        for (let i = 1; i < r.trail.length; i++) ctx.lineTo(r.trail[i].x, r.trail[i].y);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.arc(r.x, r.y, selected ? 9 : 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(r.x, r.y, selected ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (busy) {
        ctx.strokeStyle = "rgba(56,225,255,.6)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x + Math.cos(r.angle) * 8, r.y + Math.sin(r.angle) * 8);
        ctx.stroke();
        if (r.orders.length > 1) {
          ctx.fillStyle = "#ffb648";
          ctx.beginPath();
          ctx.arc(r.x + 6, r.y - 6, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (selected) {
        const p = 0.5 + 0.5 * Math.sin(time * 4);
        ctx.strokeStyle = `rgba(255,182,72,${0.55 + p * 0.4})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 10 + p * 4, 0, Math.PI * 2);
        ctx.stroke();
        if (r.target) {
          ctx.strokeStyle = "rgba(255,182,72,.28)";
          ctx.setLineDash([3, 5]);
          ctx.beginPath();
          ctx.moveTo(r.x, r.y);
          ctx.lineTo(r.target.x, r.target.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    const hr = state.hoverRider;
    if (hr && state.selected !== hr.i) {
      ctx.fillStyle = "rgba(9,16,29,.92)";
      const label = `${hr.name} · ${hr.orders.length ? "配送中" : "空闲"}`;
      ctx.font = "600 10px ui-monospace, monospace";
      const w = ctx.measureText(label).width + 16;
      rrect(ctx, hr.x - w / 2, hr.y - 26, w, 18, 6);
      ctx.fill();
      ctx.strokeStyle = "rgba(56,225,255,.3)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#bfe9ff";
      ctx.textAlign = "center";
      ctx.fillText(label, hr.x, hr.y - 13);
    }
  }

  function drawFX() {
    for (const p of state.pulses) {
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = clamp(p.life, 0, 1) * 0.5;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.1, p.r), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const s of state.sparks) {
      ctx.globalAlpha = clamp(s.life, 0, 1);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0.1, s.r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    const pad = 12;
    const ratio = Math.round(scaleFactor());
    ctx.save();
    ctx.font = "600 10px ui-monospace, monospace";
    ctx.textAlign = "left";
    const text = `路网实时仿真 · 抽样 1:${ratio}`;
    const w = ctx.measureText(text).width + 20;
    rrect(ctx, pad, pad, w, 22, 8);
    ctx.fillStyle = "rgba(7,14,26,.82)";
    ctx.fill();
    ctx.strokeStyle = "rgba(56,225,255,.22)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#8fdcf5";
    ctx.fillText(text, pad + 10, pad + 15);

    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(150,180,210,.5)";
    ctx.fillText(
      `${strategyNames[state.strategy]} · 待派 ${state.orders.filter((o) => o.waiting).length}`,
      view.w - pad, pad + 15
    );
    ctx.restore();

    if (state.lightning > 0) {
      ctx.fillStyle = `rgba(180,215,255,${state.lightning * 0.16})`;
      ctx.fillRect(0, 0, view.w, view.h);
    }
  }

  function draw(time) {
    buildBase();
    ctx.clearRect(0, 0, view.w, view.h);
    ctx.drawImage(base, 0, 0, view.w, view.h);
    drawHotspots(time);
    drawOrders(time);
    drawBeams();
    drawRiders(time);
    drawFX();
    drawHUD();
  }

  /* ---------------- 指标与 UI ---------------- */
  const ui = {
    riders: document.getElementById("dRiders"),
    assign: document.getElementById("dAssign"),
    delivery: document.getElementById("dDelivery"),
    onTime: document.getElementById("dOnTime"),
    idle: document.getElementById("dIdle"),
    throughput: document.getElementById("dThroughput"),
    clock: document.getElementById("dispatchClock"),
    badge: document.getElementById("strategyBadge"),
    status: document.getElementById("dispatchStatus"),
    play: document.getElementById("dispatchPlay"),
    rain: document.getElementById("rainLayer"),
    toast: toastEl,
  };

  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function setCard(node, level) {
    const c = node.closest(".metric");
    if (!c) return;
    c.classList.remove("good", "up", "bad");
    if (level) c.classList.add(level);
  }

  let toastTimer = 0;
  function toast(msg, kind = "ok") {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    toastEl.style.borderColor = kind === "bad" ? "rgba(255,93,108,.5)" : "rgba(56,225,255,.35)";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1900);
  }

  function formatClock() {
    const secs = state.clockBase + state.t * 60 * SIM_MIN_PER_SEC;
    const total = ((Math.floor(secs) % 86400) + 86400) % 86400;
    const hh = String(Math.floor(total / 3600)).padStart(2, "0");
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
    const ss = String(total % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function updateUI() {
    const scale = scaleFactor();
    ui.riders.textContent = fmt(state.totalRiders);
    ui.riders.nextElementSibling.textContent = `1:${Math.round(scale)} 抽样可视化`;

    const assignSec = mean(state.assignTimes) * 60;
    ui.assign.innerHTML = state.assignTimes.length
      ? `${assignSec < 10 ? assignSec.toFixed(1) : Math.round(assignSec)}<em>s</em>`
      : "—";
    const deliverMin = mean(state.deliveryTimes);
    ui.delivery.innerHTML = state.deliveryTimes.length ? `${Math.round(deliverMin)}<em>min</em>` : "—";
    const onRate = state.delivered ? (state.onTime / state.delivered) * 100 : 100;
    ui.onTime.innerHTML = `${onRate.toFixed(1)}<em>%</em>`;
    const idleRate = state.riders.length ? (stats.idle / state.riders.length) * 100 : 0;
    ui.idle.innerHTML = `${Math.round(idleRate)}<em>%</em>`;

    const throughput = (state.deliverWindow.length / 20) * scale;
    ui.throughput.innerHTML = throughput >= 1000
      ? `${(throughput / 1000).toFixed(1)}<em>k/s</em>`
      : `${Math.round(throughput)}<em>/s</em>`;

    setCard(ui.assign, assignSec > 60 ? "bad" : assignSec > 20 ? "up" : "good");
    setCard(ui.delivery, deliverMin > 45 ? "bad" : deliverMin > 38 ? "up" : "good");
    setCard(ui.onTime, onRate < 90 ? "bad" : onRate < 96 ? "up" : "good");
    setCard(ui.idle, idleRate > 55 ? "up" : "good");

    ui.clock.textContent = formatClock();
    ui.badge.textContent = strategyNames[state.strategy];

    const span = ui.status.querySelector("span");
    ui.status.classList.remove("warn", "danger");
    if (state.paused) {
      span.textContent = "仿真已暂停";
    } else if (state.outageTimer > 0) {
      ui.status.classList.add("danger");
      span.textContent = "区域运力故障";
    } else if (state.weather === "rain") {
      ui.status.classList.add("warn");
      span.textContent = "暴雨 · 配送降速";
    } else if (state.rushTimer > 0) {
      ui.status.classList.add("warn");
      span.textContent = "午高峰爆单";
    } else {
      span.textContent = "实时仿真中";
    }

    ui.rain.classList.toggle("on", state.weather === "rain");
    document.querySelectorAll("#strategyGrid .strategy").forEach((b) => {
      b.classList.toggle("active", b.dataset.strategy === state.strategy);
    });
    document.querySelectorAll("[data-event]").forEach((b) => {
      const k = b.dataset.event;
      b.classList.toggle("active",
        (k === "rain" && state.weather === "rain") ||
        (k === "rush" && state.rushTimer > 0) ||
        (k === "outage" && state.outageTimer > 0));
    });
    ui.play.textContent = state.paused ? "▶ 继续仿真" : "⏸ 暂停仿真";

    updateCard();
  }

  function updateCard() {
    if (state.selected === null) {
      card.root.hidden = true;
      return;
    }
    const r = state.riders.find((x) => x.i === state.selected);
    if (!r) {
      state.selected = null;
      card.root.hidden = true;
      return;
    }
    card.root.hidden = false;
    card.name.textContent = r.name;
    card.state.textContent = r.orders.length
      ? (r.mode === "pickup" ? `前往取餐 · 载 ${r.orders.length} 单` : `配送中 · 载 ${r.orders.length} 单`)
      : "空闲中 · 等待派单";
    card.load.textContent = `${r.orders.length} 单`;
    card.done.textContent = `${r.done} 单`;
    card.onTime.textContent = `${r.done ? Math.round((r.onTime / r.done) * 100) : 100}%`;
    card.score.textContent = r.score;
    card.assign.disabled = r.orders.length >= 2;
    card.assign.textContent = r.orders.length >= 2 ? "该骑手已满载" : "手动指派最近订单";
  }

  /* ---------------- 交互 ---------------- */
  function selectRider(r) {
    state.selected = r.i;
    state.hoverRider = r;
    updateCard();
    state.pulses.push({ x: r.x, y: r.y, r: 4, life: 1, color: "#38e1ff" });
    A.audio.blip(680, 0.05, "sine", 0.02);
  }

  function addOrderAt(x, y) {
    const o = makeOrder({ x, y });
    state.orders.push(o);
    state.pulses.push({ x, y, r: 3, life: 1, color: "#ffb648" });
    for (let i = 0; i < 5; i++) {
      state.sparks.push({
        x, y, vx: rand(-55, 55), vy: rand(-70, -10),
        life: 1, color: "#ffb648", r: rand(1, 2.2),
      });
    }
    autoAssign(o);
    toast("已下单 · 系统正在匹配骑手");
    log(`你在地图 (${Math.round(x)}, ${Math.round(y)}) 下了一单，等待分配`, "ok");
    A.audio.chord([640, 820], 0.06);
  }

  function setEvent(kind) {
    if (kind === "rain") {
      state.weather = state.weather === "rain" ? "clear" : "rain";
      log(state.weather === "rain" ? "暴雨来袭：路面湿滑，骑手速度 -35%，准时率承压" : "天气转晴，配送恢复常态", state.weather === "rain" ? "warn" : "ok");
      toast(state.weather === "rain" ? "🌧 暴雨 · 配送速度下降 35%" : "☀ 天气转晴");
      A.audio.blip(state.weather === "rain" ? 300 : 620, 0.3, "sine", 0.04);
    } else if (kind === "rush") {
      state.rushTimer = 22;
      state.batchQueue = [];
      log("午高峰爆发：订单量瞬间 ×2.4，检查你的派单策略能否扛住", "warn");
      toast("🔥 午高峰 · 订单压力骤增");
      A.audio.chord([440, 660, 880], 0.1);
    } else if (kind === "outage") {
      state.outageSpot = randInt(0, HOTSPOTS.length - 1);
      state.outageTimer = 14;
      log(`${HOTSPOTS[state.outageSpot].name} 区域运力故障：该商圈配送速度减半`, "bad");
      toast(`⚠ ${HOTSPOTS[state.outageSpot].name} 运力受限`);
      A.audio.blip(180, 0.35, "sawtooth", 0.05);
    } else if (kind === "clear") {
      state.weather = "clear";
      state.rushTimer = 0;
      state.outageTimer = 0;
      state.outageSpot = -1;
      log("天气转晴，突发状况解除，城市运力恢复常态", "ok");
      toast("☀ 已恢复常态");
    }
    updateUI();
  }

  function resetAll() {
    state.t = 0;
    state.orders = [];
    state.beams = [];
    state.sparks = [];
    state.pulses = [];
    state.assignTimes = [];
    state.deliveryTimes = [];
    state.delivered = 0;
    state.onTime = 0;
    state.deliverWindow = [];
    state.batchQueue = [];
    state.batchTimer = 0;
    state.spawnAcc = 0;
    state.weather = "clear";
    state.rushTimer = 0;
    state.outageTimer = 0;
    state.outageSpot = -1;
    state.selected = null;
    state.hoverRider = null;
    state.paused = false;
    state.clockBase = 12 * 3600;
    state.totalRiders = parseInt(document.getElementById("riderScale").value, 10);
    state.pressure = parseFloat(document.getElementById("orderPressure").value);
    document.getElementById("riderScaleLabel").textContent = fmt(state.totalRiders);
    document.getElementById("orderPressureLabel").textContent = `${state.pressure.toFixed(1)}×`;
    resetRiders();
    stats.idle = state.riders.length;
    stats.busy = 0;
    for (let i = 0; i < 26; i++) {
      const o = makeOrder();
      state.orders.push(o);
      if (state.strategy === "global") state.batchQueue.push(o);
      else autoAssign(o);
    }
    document.querySelectorAll("[data-event]").forEach((b) => b.classList.remove("active"));
    log(`仿真已重置：12:00 整，${fmt(state.totalRiders)} 名骑手上线`, "info");
    toast("↻ 仿真已重置");
    updateUI();
  }

  function riderAt(x, y) {
    let best = null;
    let bestD = 12;
    for (const r of state.riders) {
      const d = Math.hypot(r.x - x, r.y - y);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  function manualAssign() {
    const r = state.riders.find((x) => x.i === state.selected);
    if (!r) return;
    if (r.orders.length >= 2) { toast("该骑手已满载，无法继续指派", "bad"); return; }
    const pending = state.orders
      .filter((o) => o.waiting)
      .sort((a, b) => A.dist(r, a.pickup) - A.dist(r, b.pickup));
    if (!pending.length) { toast("当前没有待派订单"); return; }
    const order = pending[0];
    assign(r, order);
    toast(`已手动指派订单 #${String(order.id).slice(-4)}`);
    log(`人工调度：将订单 #${String(order.id).slice(-4)} 指派给 ${r.name}`, "ok");
    updateCard();
  }

  function bind() {
    canvas.addEventListener("pointermove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const r = riderAt(e.clientX - rect.left, e.clientY - rect.top);
      state.hoverRider = r;
      canvas.style.cursor = r ? "pointer" : "crosshair";
    });
    canvas.addEventListener("pointerleave", () => { state.hoverRider = null; });

    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const r = riderAt(x, y);
      if (r) selectRider(r);
      else addOrderAt(x, y);
    });

    document.querySelectorAll("#strategyGrid .strategy").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.strategy;
        if (key === state.strategy) return;
        state.strategy = key;
        state.batchQueue = [];
        state.batchTimer = key === "global" ? 999 : 0;
        const notes = {
          nearest: "就近派单：取餐距离最短，但热点商圈容易扎堆抢单",
          balanced: "负载均衡：允许顺路带第二单，用一点距离换更高运力利用率",
          global: "全局最优：每 1.1 秒攒批后统一匹配，成本更低但接单稍慢",
          random: "随机派单：只用来做对照，看没有优化时指标会差多少",
        };
        log(notes[key], key === "random" ? "warn" : "info");
        toast(`派单策略 → ${strategyNames[key]}`);
        A.audio.blip(key === "global" ? 760 : 620, 0.1, "sine", 0.035);
        updateUI();
      });
    });

    const scaleInput = document.getElementById("riderScale");
    scaleInput.addEventListener("input", () => {
      state.totalRiders = parseInt(scaleInput.value, 10);
      document.getElementById("riderScaleLabel").textContent = fmt(state.totalRiders);
      updateUI();
    });
    scaleInput.addEventListener("change", () => {
      log(`全城骑手规模调整为 ${fmt(state.totalRiders)}，抽样比例同步变化`, "info");
      A.audio.blip(560, 0.07, "triangle", 0.025);
    });

    const pressureInput = document.getElementById("orderPressure");
    pressureInput.addEventListener("input", () => {
      state.pressure = parseFloat(pressureInput.value);
      document.getElementById("orderPressureLabel").textContent = `${state.pressure.toFixed(1)}×`;
    });
    pressureInput.addEventListener("change", () => {
      log(`订单压力调整为 ${state.pressure.toFixed(1)}×：${state.pressure > 2 ? "爆单模式" : state.pressure < 0.8 ? "低峰时段" : "正常水平"}`, state.pressure > 2 ? "warn" : "info");
    });

    document.getElementById("dispatchPlay").addEventListener("click", () => {
      state.paused = !state.paused;
      log(state.paused ? "仿真已暂停，可继续观察当前路网状态" : "仿真继续运行", "info");
      updateUI();
    });
    document.getElementById("dispatchReset").addEventListener("click", resetAll);
    document.querySelectorAll("[data-event]").forEach((btn) => {
      btn.addEventListener("click", () => setEvent(btn.dataset.event));
    });

    document.getElementById("riderCardClose").addEventListener("click", () => {
      state.selected = null;
      updateCard();
    });
    document.getElementById("riderAssign").addEventListener("click", manualAssign);
  }

  /* ---------------- 主循环 ---------------- */
  let running = false;
  let last = 0;
  let uiAcc = 0;

  function frame(now) {
    A.tickFps(now);
    if (!running) return;
    const dt = clamp((now - last) / 1000 || 0.016, 0, 0.05);
    last = now;
    if (!state.visible) {
      requestAnimationFrame(frame);
      return;
    }
    if (!state.paused) update(dt);
    uiAcc += dt;
    if (uiAcc > 0.18) { uiAcc = 0; updateUI(); }
    draw(state.t);
    requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    bind();
    for (let i = 0; i < 20; i++) {
      const o = makeOrder();
      state.orders.push(o);
      if (state.strategy === "global") state.batchQueue.push(o);
      else autoAssign(o);
    }
    stats.idle = state.riders.filter((r) => !r.orders.length).length;
    stats.busy = state.riders.length - stats.idle;
    log("十万骑手已上线：点击地图下单，或切换策略观察派单差异", "info");
    updateUI();
    last = performance.now();
    requestAnimationFrame(frame);
  }

  const api = {
    start,
    setVisible(v) {
      state.visible = v;
      if (v) {
        last = performance.now();
        setTimeout(layout, 40);
      }
    },
    reset: resetAll,
  };
  A.registerScene("dispatch", api);
  return api;
})();










