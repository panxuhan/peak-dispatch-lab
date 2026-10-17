/* =====================================================================
   boot.js — 启动入口：注册好的场景统一开始
   ===================================================================== */
(function boot() {
  const A = window.App;
  if (!A) return;

  function run() {
    A.init();
    Object.entries(A.scenes).forEach(([name, scene]) => {
      if (scene && typeof scene.start === "function") {
        try {
          scene.start();
        } catch (err) {
          console.error(`[scene:${name}] 启动失败`, err);
        }
      }
    });
    const hash = location.hash.replace("#", "");
    if (hash && A.scenes[hash]) A.switchTo(hash);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
