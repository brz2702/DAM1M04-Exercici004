/* hero-graph.js
 * v2 only — mounts a subtle 3D force-directed graph behind the hero section.
 *
 * - Loads after React renders. Polls for .hero, then prepends a graph div.
 * - Honors prefers-reduced-motion (single static frame, no orbit) and skips
 *   entirely below 768px. Disables all interactivity. pointer-events: none on
 *   the canvas so all CTA clicks pass through.
 * - IntersectionObserver pauses the render loop when hero scrolls out of view.
 * - DPR capped at 2.
 */
(function () {
  'use strict';

  // ── Guards ────────────────────────────────────────────────────────────────
  if (window.innerWidth < 768) return;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof ForceGraph3D !== 'function') return;

  // ── Generate decorative graph data ───────────────────────────────────────
  // Clustered but not chaotic: 3 clusters, soft inter-cluster links.
  // No real-world terms — IDs only.
  function makeGraph() {
    const clusters = 4;
    const perCluster = [18, 17, 17, 16];      // 68 nodes
    const nodes = [];
    const links = [];
    let id = 0;
    const clusterOf = [];

    // Cluster centers spaced around origin
    const clusterCenters = [
      { x: -60, y:   8, z:  10 },
      { x:  55, y: -12, z: -18 },
      { x:   0, y:  38, z:  28 },
      { x:  -8, y: -32, z: -22 },
    ];

    for (let c = 0; c < clusters; c++) {
      const startId = id;
      const count = perCluster[c];
      const center = clusterCenters[c];
      for (let i = 0; i < count; i++) {
        // Random offset around the cluster center (gaussian-ish via summed uniforms)
        const r = 22;
        const rand = () => (Math.random() + Math.random() + Math.random() - 1.5) * r / 1.5;
        nodes.push({
          id: id,
          cluster: c,
          // Initial positions — 3d-force-graph honors these (fx/fy/fz are fixed; x/y/z are starting hints)
          x: center.x + rand(),
          y: center.y + rand(),
          z: center.z + rand(),
        });
        clusterOf[id] = c;
        id++;
      }
      // Intra-cluster links: dense-ish, not complete
      for (let i = startId; i < startId + count; i++) {
        for (let j = i + 1; j < startId + count; j++) {
          if (Math.random() < 0.18) links.push({ source: i, target: j });
        }
      }
    }
    // Inter-cluster bridges: a handful per cluster pair
    for (let c1 = 0; c1 < clusters; c1++) {
      for (let c2 = c1 + 1; c2 < clusters; c2++) {
        for (let k = 0; k < 3; k++) {
          const a = nodes.filter(n => n.cluster === c1)[(Math.random() * perCluster[c1]) | 0];
          const b = nodes.filter(n => n.cluster === c2)[(Math.random() * perCluster[c2]) | 0];
          if (a && b) links.push({ source: a.id, target: b.id });
        }
      }
    }
    // Ensure every node has at least one link (no orphans floating alone)
    const degree = new Array(nodes.length).fill(0);
    for (const l of links) { degree[l.source]++; degree[l.target]++; }
    for (let i = 0; i < nodes.length; i++) {
      if (degree[i] === 0) {
        // Connect to a random neighbor in same cluster
        const sameCluster = nodes.filter(n => n.cluster === nodes[i].cluster && n.id !== i);
        const partner = sameCluster[(Math.random() * sameCluster.length) | 0];
        if (partner) { links.push({ source: i, target: partner.id }); degree[i]++; degree[partner.id]++; }
      }
    }
    while (links.length < 130) {
      const a = nodes[(Math.random() * nodes.length) | 0];
      const b = nodes[(Math.random() * nodes.length) | 0];
      if (a.id !== b.id) links.push({ source: a.id, target: b.id });
    }

    return { nodes, links };
  }

  // Low-saturation brand-aligned palette (soft purples, muted greens, light blues)
  const PALETTE = [
    '#A6B8E0', // soft blue
    '#9FC9B7', // muted green
    '#C6B0DE', // soft purple
    '#B8D0E8', // pale blue
    '#A8C9A8', // sage
    '#D0BDE0', // light lavender
  ];

  // ── Mount once .hero exists ──────────────────────────────────────────────
  let mounted = false;
  function tryMount() {
    if (mounted) return true;
    const hero = document.querySelector('.hero');
    if (!hero) return false;
    mounted = true;
    try { mount(hero); } catch (e) { console.error('[hero-graph] mount failed:', e); }
    return true;
  }

  function mount(hero) {
    // Create the host element
    const host = document.createElement('div');
    host.className = 'hero-graph';
    host.setAttribute('aria-hidden', 'true');
    host.style.opacity = '0';                    // start invisible
    // Prepend so it sits behind .container (which has z-index 2 in CSS)
    hero.insertBefore(host, hero.firstChild);

    // Size to hero
    function sizeOf() {
      const r = hero.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }
    let { w, h } = sizeOf();
    host.style.width = w + 'px';
    host.style.height = h + 'px';

    const data = makeGraph();

    // ── Initialize 3d-force-graph ───────────────────────────────────────────
    const Graph = ForceGraph3D({
      controlType: 'orbit',
      rendererConfig: { alpha: true, antialias: true },
    })(host);
    window.__heroGraph = Graph;
    Graph
      .backgroundColor('rgba(0,0,0,0)')
      .width(w)
      .height(h)
      // Run a quick synchronous layout pass — needed because rAF-driven
      // simulation can stall in throttled iframes.
      .cooldownTicks(0)
      .warmupTicks(150)
      .graphData(data)
      .nodeRelSize(2.6)
      .nodeColor(n => PALETTE[n.cluster % PALETTE.length])
      .nodeOpacity(1)
      .nodeResolution(16)
      .linkColor(() => 'rgba(130, 145, 185, 0.85)')
      .linkOpacity(0.9)
      .linkWidth(0)
      .enableNodeDrag(false)
      .enableNavigationControls(false)
      .showNavInfo(false);

    // ── Camera auto-orbit (slow, continuous) ────────────────────────────────
    // We drive everything ourselves with setInterval rather than relying on
    // 3d-force-graph's internal requestAnimationFrame loop — rAF can be
    // throttled to zero ticks/sec in non-foreground iframes, which leaves the
    // graph stuck with all meshes at the origin.
    const renderer = Graph.renderer();
    const scene = Graph.scene();
    const camera = Graph.camera();

    if (renderer && typeof renderer.setPixelRatio === 'function') {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    }

    // Default 3d-force-graph lights blow Lambert/Standard materials out to
    // pure white. Replace node materials with unlit MeshBasicMaterial so the
    // chosen colors render faithfully.
    function flatlightNodes() {
      const d = Graph.graphData();
      for (const n of d.nodes) {
        const mesh = n.__threeObj;
        if (!mesh || !mesh.material) continue;
        if (mesh.material.type !== 'MeshBasicMaterial') {
          const c = mesh.material.color ? mesh.material.color.clone() : new THREE.Color(0xffffff);
          mesh.material.dispose && mesh.material.dispose();
          mesh.material = new THREE.MeshBasicMaterial({ color: c, transparent: false });
        }
      }
    }

    function syncMeshesToData() {
      const d = Graph.graphData();
      for (const n of d.nodes) {
        if (n.__threeObj && typeof n.x === 'number') {
          n.__threeObj.position.set(n.x, n.y, n.z);
        }
      }
      for (const l of d.links) {
        const s = l.source, t = l.target, lineObj = l.__lineObj;
        if (!lineObj || typeof s !== 'object' || typeof t !== 'object') continue;
        const geom = lineObj.geometry;
        const pos = geom && geom.attributes && geom.attributes.position;
        if (!pos) continue;
        // Straight 2-vertex line
        if (pos.count === 2) {
          pos.array[0] = s.x; pos.array[1] = s.y; pos.array[2] = s.z;
          pos.array[3] = t.x; pos.array[4] = t.y; pos.array[5] = t.z;
          pos.needsUpdate = true;
        } else if (pos.count > 2) {
          // Curved (>=3 control points): linearly interpolate between s and t.
          const N = pos.count;
          for (let i = 0; i < N; i++) {
            const u = i / (N - 1);
            pos.array[i * 3 + 0] = s.x + (t.x - s.x) * u;
            pos.array[i * 3 + 1] = s.y + (t.y - s.y) * u;
            pos.array[i * 3 + 2] = s.z + (t.z - s.z) * u;
          }
          pos.needsUpdate = true;
        }
      }
    }

    let angle = 0;
    let paused = false;
    let lastTime = performance.now();
    const camDistance = 180;
    const orbitSpeed = reducedMotion ? 0 : 0.00018; // radians/ms

    // Loop dispatch. In a top-level tab, requestAnimationFrame pauses when the
    // tab is backgrounded and syncs to the display refresh rate. In throttled
    // iframes (deck-stage / FleetView embeds where this component originated)
    // rAF can be capped at zero ticks/sec, so fall back to setInterval there.
    const useRAF = window.parent === window;
    let loopHandle = null;
    function startLoop() {
      if (loopHandle !== null) return;
      if (useRAF) {
        const frame = () => { tick(); loopHandle = requestAnimationFrame(frame); };
        loopHandle = requestAnimationFrame(frame);
      } else {
        loopHandle = setInterval(tick, 33);
      }
    }
    function stopLoop() {
      if (loopHandle === null) return;
      if (useRAF) cancelAnimationFrame(loopHandle);
      else clearInterval(loopHandle);
      loopHandle = null;
    }

    function tick() {
      if (paused) return;
      const now = performance.now();
      const dt = now - lastTime;
      lastTime = now;
      angle += orbitSpeed * dt;
      camera.position.set(
        camDistance * Math.sin(angle),
        camDistance * 0.18,
        camDistance * Math.cos(angle)
      );
      camera.lookAt(0, 0, 0);
      syncMeshesToData();
      flatlightNodes();
      renderer.render(scene, camera);
    }

    // Initial render position
    camera.position.set(0, camDistance * 0.18, camDistance);
    camera.lookAt(0, 0, 0);
    syncMeshesToData();
    flatlightNodes();
    renderer.render(scene, camera);

    // Subtle bloom — guarded, since composer presence varies by version
    try {
      if (typeof THREE !== 'undefined' && typeof Graph.postProcessingComposer === 'function') {
        // 3d-force-graph ships with three-render-objects which exposes a
        // post-processing composer. Add a soft UnrealBloomPass if available.
        const composer = Graph.postProcessingComposer();
        if (composer && THREE.UnrealBloomPass) {
          const bloom = new THREE.UnrealBloomPass(
            new THREE.Vector2(w, h),
            0.55, // strength (subtle)
            0.9,  // radius
            0.85  // threshold (only bright pixels)
          );
          composer.addPass(bloom);
        }
      }
    } catch (e) { /* bloom is decorative — ignore failures */ }

    // Disable canvas interactivity defensively (CSS already does this, but
    // make doubly sure no listeners fire).
    const canvas = host.querySelector('canvas');
    if (canvas) {
      canvas.style.pointerEvents = 'none';
      ['click', 'mousedown', 'mouseup', 'mousemove', 'wheel', 'touchstart', 'touchmove', 'touchend']
        .forEach(ev => canvas.addEventListener(ev, e => e.stopPropagation(), { capture: true, passive: true }));
    }

    // Fade in opacity manually (no CSS transition) + start the tick loop.
    setTimeout(() => {
      const fadeStart = performance.now();
      const fadeDur = 900;
      const fadeTarget = 0.85;
      let fadeInterval = setInterval(() => {
        const t = Math.min(1, (performance.now() - fadeStart) / fadeDur);
        host.style.opacity = (t * fadeTarget).toFixed(3);
        if (t >= 1) clearInterval(fadeInterval);
      }, 32);
      // Safety net
      setTimeout(() => { host.style.opacity = String(fadeTarget); }, fadeDur + 250);

      lastTime = performance.now();
      if (reducedMotion) {
        // Render one static frame and stop
        renderer.render(scene, camera);
        return;
      }
      startLoop();
    }, 350);

    // ── Pause when hero scrolls out of view ─────────────────────────────────
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          if (paused && !reducedMotion) {
            paused = false;
            lastTime = performance.now();
            startLoop();
          }
        } else {
          paused = true;
          stopLoop();
        }
      });
    }, { threshold: 0 });
    io.observe(hero);

    // ── Resize ──────────────────────────────────────────────────────────────
    const onResize = () => {
      // Drop graph entirely if viewport falls below mobile breakpoint
      if (window.innerWidth < 768) {
        host.style.display = 'none';
        return;
      } else {
        host.style.display = '';
      }
      const s = sizeOf();
      w = s.w; h = s.h;
      host.style.width = w + 'px';
      host.style.height = h + 'px';
      Graph.width(w).height(h);
      // Re-render once after a resize
      renderer.render(scene, camera);
    };
    window.addEventListener('resize', onResize, { passive: true });

    // Also re-size when the hero box changes (e.g. tweaks panel toggling hero variant)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => onResize());
      ro.observe(hero);
    }
  }

  // Kick off — observe DOM for the React-rendered .hero
  if (!tryMount()) {
    const mo = new MutationObserver(() => {
      if (tryMount()) mo.disconnect();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    // Belt-and-suspenders: also poll a couple of times
    [50, 200, 500, 1000, 2000, 4000].forEach(t => setTimeout(() => {
      if (tryMount()) mo.disconnect();
    }, t));
  }
})();
