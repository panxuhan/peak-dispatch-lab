/* =====================================================================
   main.js — 通用工具、标签页、弹窗、音效、FPS
   两个场景分别实现在 peak.js / dispatch.js
   ===================================================================== */
window.App = (() => {
  const scenes = {};

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const fmt1 = (n) => Number(n).toFixed(1);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /* ---------- Canvas 自适应 ---------- */
  function setupCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    const state = { w: 0, h: 0, dpr: 1 };
    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      state.w = rect.width;
      state.h = rect.height;
      state.dpr = dpr;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return { ctx, state, resize };
  }

  /* ---------- 日志 ---------- */
  function makeLogger(el, limit = 26) {
    return function log(msg, kind = "info") {
      if (!el) return;
      const now = new Date();
      const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      const row = document.createElement("div");
      row.className = `log-row ${kind}`;
      row.innerHTML = `<span class="t">${t}</span><span class="msg"></span>`;
      row.querySelector(".msg").textContent = msg;
      el.prepend(row);
      while (el.children.length > limit) el.lastChild.remove();
    };
  }

  /* ---------- 极简音效（WebAudio，无外部资源） ---------- */
  // 浏览器要求音频必须由用户手势解锁，避免控制台刷 "AudioContext was not allowed to start"
  let audioUnlocked = false;
  const unlockAudio = () => {
    audioUnlocked = true;
    window.removeEventListener("pointerdown", unlockAudio);
    window.removeEventListener("keydown", unlockAudio);
  };
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);

  const audio = {
    enabled: true,
    ctx: null,
    ensure() {
      if (!audioUnlocked) return null;
      if (!this.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (Ctor) this.ctx = new Ctor();
      }
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
      return this.ctx;
    },
    blip(freq = 520, dur = 0.09, type = "sine", gain = 0.05) {
      if (!this.enabled) return;
      const ac = this.ensure();
      if (!ac) return;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(gain, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      osc.connect(g).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + dur);
    },
    chord(freqs = [440, 660], dur = 0.18) {
      freqs.forEach((f, i) => setTimeout(() => this.blip(f, dur, "triangle", 0.04), i * 55));
    },
  };

  /* ---------- 场景注册与标签页 ---------- */
  function registerScene(name, api) {
    scenes[name] = api;
  }

  let active = "peak";

  function switchTo(name) {
    active = name;
    document.querySelectorAll(".tab").forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".scene").forEach((sc) => {
      sc.classList.toggle("active", sc.id === `scene-${name}`);
    });
    const ink = document.getElementById("tabInk");
    const tab = document.querySelector(`.tab[data-tab="${name}"]`);
    if (ink && tab) {
      ink.style.width = `${tab.offsetWidth}px`;
      ink.style.transform = `translateX(${tab.offsetLeft}px)`;
    }
    Object.entries(scenes).forEach(([key, api]) => {
      if (api && typeof api.setVisible === "function") api.setVisible(key === name);
    });
    audio.blip(name === "peak" ? 480 : 640, 0.08, "sine", 0.035);
  }

  /* ---------- 原理弹窗内容 ---------- */
  const knowledge = {
    flow: {
      tag: "入口层",
      title: "第一道闸门：先别让流量进核心",
      body: `
        <p>零点洪峰最怕的不是「多」，而是「同时多」。入口层要做三件事：</p>
        <ol class="steps">
          <li><b>静态资源上 CDN</b>：图片、JS、活动页由边缘节点返回，核心机房只处理交易请求。</li>
          <li><b>网关限流</b>：按用户、接口、机房维度做令牌桶，超出阈值的请求快速返回 <code>429</code>，保护后端。</li>
          <li><b>排队而不是超时</b>：秒杀类接口给用户一个明确的排队页，比 30 秒白屏体验好得多。</li>
        </ol>
        <p>在演示里试试：开启「网关限流」后，再点「触发零点洪峰」——错误率会上升，但系统不会整体崩掉。</p>`,
    },
    cache: {
      tag: "缓存",
      title: "把 85% 的读挡在数据库之前",
      body: `
        <p>典型链路是 <b>本地缓存 → Redis 集群 → 数据库</b>。商品详情、库存快照、活动配置都适合缓存。</p>
        <p>但缓存本身也会制造事故：</p>
        <ol class="steps">
          <li><b>缓存雪崩</b>：大批 Key 同时过期。解决：过期时间加随机抖动、多级缓存、互斥重建。</li>
          <li><b>热点 Key</b>：单个 SKU 的 QPS 打满一个分片。解决：本地缓存兜底、Key 拆分、读写分离。</li>
          <li><b>缓存穿透</b>：查不存在的数据。解决：布隆过滤器 + 空值缓存。</li>
        </ol>
        <p>在演示里点击「缓存雪崩」，观察命中率塌陷后数据库负载如何瞬间冲顶。</p>`,
    },
    queue: {
      tag: "削峰",
      title: "把 1 秒的洪峰摊到 5 分钟",
      body: `
        <p>下单成功后并不是所有事情都要同步做完：发短信、加积分、更新推荐、生成物流单，都可以异步化。</p>
        <p>消息队列把瞬时写入变成平滑消费：入口只需把消息可靠落盘，后端按自己的消费能力拉取。代价是<b>最终一致</b>和<b>延迟增加</b>，所以必须区分核心链路与非核心链路。</p>
        <p>在演示里开启「削峰队列」，你会看到排队数上升、延迟变高，但服务与数据库的负载被压在安全线以内。</p>`,
    },
    degrade: {
      tag: "稳定性",
      title: "有策略地放弃，才能保住核心",
      body: `
        <p>稳定性建设不是「所有功能都活着」，而是「核心功能必须活着」。</p>
        <ol class="steps">
          <li><b>熔断</b>：下游错误率超过阈值时快速失败，避免线程池被拖死。</li>
          <li><b>降级</b>：关闭推荐、评价、皮肤等非核心功能，把资源让给交易。</li>
          <li><b>隔离</b>：线程池/信号量隔离，单个慢接口不能拖垮整个应用。</li>
          <li><b>预案</b>：限流阈值、开关、回滚、扩容都要能在一分钟内生效。</li>
        </ol>
        <p>切换「熔断降级」后再注入「慢查询」，对比系统是整体雪崩还是只损失部分体验。</p>`,
    },
    matching: {
      tag: "匹配",
      title: "派单 = 二分图上的最小成本匹配",
      body: `
        <p>左侧是待派订单，右侧是可用骑手；每条边的成本由三部分组成：</p>
        <p><code>cost = 取餐距离 + 预计超时惩罚 + 骑手负载权重</code></p>
        <p>就近派单只优化第一项，所以会出现「一个商圈被抢空、隔壁商圈骑手闲着」的扎堆现象。</p>
        <p>更稳的做法是把负载与超时风险纳入成本，并在全局视角下求解。演示中的「负载均衡」和「全局最优」就是这两条路线的对比。</p>`,
    },
    batch: {
      tag: "算法",
      title: "批量匹配：用 2 秒换更低的成本",
      body: `
        <p>如果来一单就算一次，算法只能看到局部最优。把 1~3 秒内的订单攒成一批，复杂度上升，但解的质量明显更好。</p>
        <ol class="steps">
          <li>对每一对「订单-骑手」计算成本；</li>
          <li>按成本排序，贪心选取互不冲突的匹配（演示用的就是这个）；</li>
          <li>规模更大时用匈牙利算法 / 最小费用最大流；</li>
          <li>线上通常再加一层规则：同方向拼单、跨区调度、超时单优先。</li>
        </ol>
        <p>演示里切到「全局最优」，观察派单线如何成批出现、平均接单时长如何下降。</p>`,
    },
    shed: {
      tag: "运力",
      title: "运力不够时，算法也变不出骑手",
      body: `
        <p>十万骑手听起来很多，但暴雨 + 午高峰时仍然会缺运力。此时调度系统要做的是「有序降级」：</p>
        <ul class="steps">
          <li>动态延长承诺时间，避免大量必然超时的订单；</li>
          <li>提高恶劣天气补贴，引导骑手向爆单区域流动；</li>
          <li>限制远距离订单、暂停部分低优先级商家；</li>
          <li>跨商圈调度，把空闲运力往热点区域迁移。</li>
        </ul>
        <p>点击「暴雨」或「午高峰」，观察超时率与空闲率怎样反向变化。</p>`,
    },
    scale: {
      tag: "架构",
      title: "十万级实时调度怎么算得动",
      body: `
        <p>一次性对 10 万骑手 × 10 万订单求解是不现实的。工程上通常这样拆：</p>
        <ol class="steps">
          <li><b>地理分片</b>：按城市、商圈、六边形网格切分，片内独立匹配；</li>
          <li><b>增量计算</b>：只在骑手/订单状态变化时触发局部重算；</li>
          <li><b>流式处理</b>：Kafka + Flink 维护骑手位置流与订单流；</li>
          <li><b>内存索引</b>：GeoHash / S2 索引快速找附近骑手；</li>
          <li><b>边界交换</b>：相邻分片之间做有限的二次匹配，减少「墙」效应。</li>
        </ol>
        <p>演示用 1:400 抽样可视化，指标按抽样结果外推，所以数字是教学意义而非真实生产值。</p>`,
    },
  };

  function openModal(key) {
    const data = knowledge[key];
    if (!data) return;
    const modal = document.getElementById("modal");
    document.getElementById("modalTag").textContent = data.tag;
    document.getElementById("modalTitle").textContent = data.title;
    document.getElementById("modalBody").innerHTML = data.body;
    modal.hidden = false;
    audio.blip(720, 0.08, "sine", 0.03);
  }

  function bindModal() {
    document.querySelectorAll(".k-card").forEach((card) => {
      const open = () => openModal(card.dataset.k);
      card.addEventListener("click", open);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
      card.tabIndex = 0;
    });
    const modal = document.getElementById("modal");
    const close = () => (modal.hidden = true);
    document.getElementById("modalClose").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  function bindSound() {
    const btn = document.getElementById("soundToggle");
    btn.addEventListener("click", () => {
      audio.enabled = !audio.enabled;
      btn.textContent = audio.enabled ? "🔊 音效开" : "🔇 音效关";
      btn.setAttribute("aria-pressed", String(audio.enabled));
      if (audio.enabled) audio.blip(660, 0.08, "sine", 0.04);
    });
    const unlock = () => { audio.ensure(); document.removeEventListener("pointerdown", unlock); };
    document.addEventListener("pointerdown", unlock);
  }

  function bindTabs() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => switchTo(tab.dataset.tab));
    });
    const ink = document.getElementById("tabInk");
    const activeTab = document.querySelector(".tab.active");
    if (ink && activeTab) {
      ink.style.width = `${activeTab.offsetWidth}px`;
      ink.style.transform = `translateX(${activeTab.offsetLeft}px)`;
    }
    window.addEventListener("resize", () => {
      const t = document.querySelector(`.tab[data-tab="${active}"]`);
      if (ink && t) {
        ink.style.width = `${t.offsetWidth}px`;
        ink.style.transform = `translateX(${t.offsetLeft}px)`;
      }
    });
  }

  /* ---------- FPS ---------- */
  let frames = 0, lastFps = performance.now();
  function tickFps(now) {
    frames++;
    if (now - lastFps >= 1000) {
      const fps = Math.round((frames * 1000) / (now - lastFps));
      const el = document.getElementById("fpsReadout");
      if (el) el.textContent = `${fps} FPS`;
      frames = 0;
      lastFps = now;
    }
  }

  function init() {
    bindTabs();
    bindModal();
    bindSound();
    switchTo("peak");
  }

  return {
    clamp, lerp, rand, randInt, pick, easeOut, easeInOut,
    fmt, fmt1, dist, setupCanvas, makeLogger, audio,
    registerScene, switchTo, openModal, init, tickFps, scenes,
  };
})();


