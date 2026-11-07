// @ds-adherence-ignore -- omelette starter scaffold (raw elements/hex/px by design)
// Copied omelette starter. Re-running copy_starter_component with this kind overwrites this file with the latest version (page content is unaffected).
/* BEGIN USAGE */
/**
 * <three-d-stage> — 3D object viewer + exporter shell (three.js).
 *
 * The stage owns the whole scene: WebGL renderer, neutral studio lighting
 * with a soft ground shadow, orbit controls (drag to orbit, wheel to zoom,
 * right-drag to pan), a camera auto-framed to the object's bounds, resize
 * handling, and a download toolbar that exports the current object as
 * OBJ + MTL or GLB (binary glTF). FBX cannot be exported in the browser;
 * GLB is the interchange format every modern 3D tool imports.
 *
 * three.js loads through the page's import map. Include this EXACT pinned
 * map in <head>, before any module runs — versions and integrity hashes
 * stay together (same map the "3D object" skill mandates):
 *
 *   <script type="importmap">
 *   {
 *     "imports": {
 *       "three": "https://unpkg.com/three@0.184.0/build/three.module.js",
 *       "three/addons/controls/OrbitControls.js": "https://unpkg.com/three@0.184.0/examples/jsm/controls/OrbitControls.js",
 *       "three/addons/exporters/OBJExporter.js": "https://unpkg.com/three@0.184.0/examples/jsm/exporters/OBJExporter.js",
 *       "three/addons/exporters/GLTFExporter.js": "https://unpkg.com/three@0.184.0/examples/jsm/exporters/GLTFExporter.js"
 *     },
 *     "integrity": {
 *       "https://unpkg.com/three@0.184.0/build/three.module.js": "sha384-8FCZ1eVO6it4+pbec2aDtnTrwjWXZLJRC+MAGCIPDgsYnUrl/E0A2YlF8ioMKI/J",
 *       "https://unpkg.com/three@0.184.0/build/three.core.js": "sha384-dw2ooPewaEIrAgl6oFDBmmBWCE9oW9LxRGcfwZ0hLvEprzo202wXl7vCYHRlSnOT",
 *       "https://unpkg.com/three@0.184.0/examples/jsm/controls/OrbitControls.js": "sha384-4rziNxOBZKQ69i+w+f89KJ55TCYquwchVbByQwmaOeIOXdOU2PLDn3kOfXHwIJC9",
 *       "https://unpkg.com/three@0.184.0/examples/jsm/exporters/OBJExporter.js": "sha384-nbwtoZENJD3Vq+ACK0CuGQdPMuDWHkamC2KJD70EV5nfg6jQjfppKOea07YJN+N3",
 *       "https://unpkg.com/three@0.184.0/examples/jsm/exporters/GLTFExporter.js": "sha384-VofkvpG6HERhFCYbsUOHeNXBCqID2nfqkQqnVzE1jc/oPcz+qJ13ADdXH08hE+cQ"
 *     }
 *   }
 *   </script>
 *
 * Usage:
 *   <style>three-d-stage:not(:defined){visibility:hidden}</style>
 *   <three-d-stage name="rocket"></three-d-stage>
 *   <script src="three-d-stage.js"></script>
 *   <script type="module">
 *     const stage = document.querySelector('three-d-stage');
 *     const { THREE } = await stage.ready;
 *     const model = new THREE.Group();
 *     // …build the model out of named meshes with named materials —
 *     // the names become the o / usemtl entries in the exported OBJ…
 *     stage.setObject(model);
 *   </script>
 *
 * Attributes:
 *   name       — export file basename (default "model")
 *   background — CSS color behind the scene (default a warm paper tone)
 *   autorotate — when present, a slow turntable until the user interacts
 *
 * Model in real-world meters, centered on the origin, y-up — exports
 * inherit the scene's units and orientation. The stage fills its own box;
 * size it with ordinary CSS (default 100vw/100vh page hero).
 *
 * Default setup: neutral studio lighting (hemisphere + key + fill), a
 * soft ground shadow, and NO environment map — so high metalness has
 * nothing to reflect and renders near-black. Cap metalness around
 * 0.3–0.4 and carry a metal look with a brighter base color. The copied
 * file is yours: adjust the lights, shadow, or background in _boot()
 * when the object needs a different look.
 */
/* END USAGE */

(() => {
  const stylesheet = `
    :host {
      position: relative;
      display: block;
      width: 100%;
      height: 100vh;
      background: var(--stage-bg, #f0eee6);
      overflow: hidden;
    }
    canvas { display: block; outline: none; }
    .toolbar {
      position: absolute;
      right: 16px;
      bottom: 16px;
      display: flex;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .toolbar button {
      appearance: none;
      border: 1px solid rgba(20, 20, 19, 0.18);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.92);
      color: #1a1915;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 500;
      line-height: 1;
      padding: 9px 12px;
      cursor: default;
    }
    .toolbar button:hover { background: #fff; }
    .toolbar button:active { transform: translateY(1px); }
    .toolbar button[disabled] { opacity: 0.5; pointer-events: none; }
    .note {
      position: absolute;
      left: 16px;
      bottom: 16px;
      max-width: 60%;
      font: 400 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: rgba(26, 25, 21, 0.55);
      user-select: none;
    }
    :host([bare]) .note { display: none; }
    :host([bare]:not([export])) .toolbar { display: none; }
    .err {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
      font: 500 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #8a2f20;
      text-align: center;
      white-space: pre-line;
    }
  `;

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /** Tell the host an export attempt settled — telemetry only. The host
   *  (HTMLViewer) verifies the source and re-reads these fields defensively
   *  before counting; nothing else crosses the frame boundary. Guarded so
   *  telemetry can never break the download path. */
  function notifyExport(format, ok) {
    try {
      window.parent.postMessage(
        { type: 'omelette:notify-3d-export', format: format, ok: ok === true },
        '*'
      );
    } catch (e) {}
  }

  class ThreeDStage extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = stylesheet;
      root.appendChild(style);
      this._err = document.createElement('div');
      this._err.className = 'err';
      root.appendChild(this._err);
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'Drag to orbit · scroll to zoom · right-drag to pan';
      root.appendChild(note);
      this._toolbar = document.createElement('div');
      this._toolbar.className = 'toolbar';
      this._objBtn = document.createElement('button');
      this._objBtn.type = 'button';
      this._objBtn.textContent = 'Download OBJ + MTL';
      this._objBtn.addEventListener('click', () => this._runExport('obj'));
      this._glbBtn = document.createElement('button');
      this._glbBtn.type = 'button';
      this._glbBtn.textContent = 'Download GLB';
      this._glbBtn.addEventListener('click', () => this._runExport('glb'));
      this._toolbar.appendChild(this._objBtn);
      this._toolbar.appendChild(this._glbBtn);
      root.appendChild(this._toolbar);
      this._setButtonsEnabled(false);
      /** Resolves with { THREE } once the scene is live — build the model
       *  in `await stage.ready` so nothing races the library load. */
      this.ready = new Promise((resolve, reject) => {
        this._readyResolve = resolve;
        this._readyReject = reject;
      });
    }

    connectedCallback() {
      if (this._booted) {
        // Re-attached after a removal — resume what disconnected stopped.
        if (this._renderer) {
          this._renderer.setAnimationLoop(this._loop);
          this._ro && this._ro.observe(this);
        }
        return;
      }
      this._booted = true;
      this._boot().catch((err) => {
        this._err.style.display = 'flex';
        this._err.textContent =
          'three.js failed to load.\n' +
          'Check that the pinned <script type="importmap"> from the usage ' +
          'notes is in <head> before any module script.\n\n' +
          String(err && err.message ? err.message : err);
        this._readyReject(err);
      });
    }

    async _boot() {
      const bg = this.getAttribute('background');
      if (bg) this.style.setProperty('--stage-bg', bg);
      const [THREE, controlsMod] = await Promise.all([
        import('three'),
        import('three/addons/controls/OrbitControls.js'),
      ]);
      this._THREE = THREE;
      // preserveDrawingBuffer keeps the last frame readable after
      // compositing (toDataURL / drawImage) — it's what lets the
      // screenshot tools capture the scene instead of a blank canvas.
      const px = Math.max(0, parseFloat(this.getAttribute('pixel')) || 0);
      this._px = px;
      // ?sharp=0 forces the old way, ?sharp=1 forces sharp (no fallback); otherwise sharp falls back by itself when the
      // machine cannot hold it (measured on Ozi's laptop 2026-10-15: the built-in AMD chip runs sharp at ~30 fps, the RTX ~60).
      this._sharpForce = /[?&]sharp=1\b/.test(location.search);
      this._sharp = this.hasAttribute('sharp') && !/[?&]sharp=0\b/.test(location.search);
      this._sharpWhy = this._sharp ? 'on' : 'off';
      const renderer = new THREE.WebGLRenderer({ antialias: !px, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(px ? 1 : Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = px ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
      if (px) { renderer.domElement.style.imageRendering = 'pixelated'; renderer.shadowMap.autoUpdate = false; }
      this._renderer = renderer;
      this.shadowRoot.insertBefore(renderer.domElement, this._err);

      const scene = new THREE.Scene();
      this._scene = scene;

      const camera = px
        ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 500)
        : new THREE.PerspectiveCamera(45, 1, 0.01, 500);
      camera.position.set(3, 2.2, 4);
      this._camera = camera;

      const controls = new controlsMod.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      if (px) { controls.maxPolarAngle = 1.3; controls.minZoom = 0.5; controls.maxZoom = 6; }
      this._controls = controls;

      scene.add(px ? new THREE.HemisphereLight(0xfff0d4, 0x8fae78, 1.35) : new THREE.HemisphereLight(0xffffff, 0xd8d2c4, 1.0));
      const key = new THREE.DirectionalLight(px ? 0xffe4bd : 0xffffff, px ? 2.3 : 2.2);
      key.position.set(4, 7, 5);
      key.castShadow = true;
      // 2048 is already finer than the half-resolution pixel render; 4096 cost a 16-megapixel shadow pass every frame.
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.bias = px ? -0.0006 : -0.0002;
      if (px) key.shadow.normalBias = 0.02;
      this._key = key;
      scene.add(key);
      scene.add(key.target);
      const fill = new THREE.DirectionalLight(px ? 0xffe9d0 : 0xfff4e6, px ? 0.45 : 0.5);
      fill.position.set(px ? 5 : -5, 3, px ? 4 : -4);
      scene.add(fill);

      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(400, 400),
        new THREE.ShadowMaterial({ opacity: px ? 0.1 : 0.18 })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      this._ground = ground;
      scene.add(ground);

      if (px) {
        scene.background = new THREE.Color(bg || '#f3ead7');
        this._setupPixel(THREE);
      }

      this._autorotate = this.hasAttribute('autorotate');
      controls.autoRotate = this._autorotate;
      controls.autoRotateSpeed = 1.2;
      controls.addEventListener('start', () => { controls.autoRotate = false; });

      const fit = () => {
        const w = this.clientWidth || 1;
        const h = this.clientHeight || 1;
        if (px) {
          // TV pass: with the `sharp` attribute a pixel block is `px` SCREEN pixels, not `px` CSS pixels. On a 4K TV at
          // 150% scaling the old way drew 1280x720 and stretched it 3x; sharp draws 1920x1080 and stretches it 2x, so every
          // block is still a whole number of the screen's own pixels (pixel-true, never blurred). ?sharp=0 shows the old way.
          const dpr = this._sharp ? (window.devicePixelRatio || 1) : 1;
          const lw = Math.max(1, Math.floor((w * dpr) / px)), lh = Math.max(1, Math.floor((h * dpr) / px));
          renderer.setSize(lw, lh, false);
          renderer.domElement.style.width = (lw * px) / dpr + 'px';
          renderer.domElement.style.height = (lh * px) / dpr + 'px';
          this._renderSize = [lw, lh];
          this._rtColor.setSize(lw, lh);
          this._rtNormal.setSize(lw, lh);
          this._post.uniforms.res.value.set(lw, lh, 1 / lw, 1 / lh);
          const a = lw / lh, R = this._viewR || 5;
          const vs = Math.max(R * 1.12, (R * 1.75) / a);
          camera.left = (-vs * a) / 2; camera.right = (vs * a) / 2;
          camera.top = vs / 2; camera.bottom = -vs / 2;
        } else {
          renderer.setSize(w, h);
          camera.aspect = w / h;
        }
        camera.updateProjectionMatrix();
      };
      this._fit = fit;
      fit();
      this._ro = new ResizeObserver(fit);
      // Dragging the window to another screen changes devicePixelRatio without a resize.
      const watchDpr = () => matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => { fit(); watchDpr(); }, { once: true });
      if (this._sharp) watchDpr();
      this.noNormal = new Set();
      const clock = new THREE.Clock();
      // Sharp fallback: after the scene settles, time 90 frames; if the median frame is slower than 22 ms (under ~45 fps),
      // go back to the old resolution once and stay there. Fail toward smooth, never toward a choppy TV.
      const frames = [], t0 = performance.now(); let lastT = t0;
      const watchSharp = () => {
        const now = performance.now(), d = now - lastT; lastT = now;
        if (!this._sharp || this._sharpForce || this._sharpDecided || now - t0 < 3000) return;
        if (d > 250 || document.hidden) return; // a hidden or paused tab is not a slow machine
        frames.push(d); if (frames.length < 90) return;
        this._sharpDecided = true;
        const med = frames.sort((a, b) => a - b)[45];
        if (med > 22) { this._sharp = false; this._sharpWhy = `fell back: median frame ${med.toFixed(1)} ms`; fit(); console.info(`three-d-stage: sharp ${this._sharpWhy}`); }
        else this._sharpWhy = `kept: median frame ${med.toFixed(1)} ms`;
      };
      this._loop = () => {
        watchSharp();
        const dt = Math.min(clock.getDelta(), 0.1);
        if (this.onTick) { try { this.onTick(clock.elapsedTime, dt); } catch (e) { console.error(e); this.onTick = null; } }
        controls.update();
        if (px) this._renderPixel();
        else renderer.render(scene, camera);
      };
      if (this.isConnected) {
        this._ro.observe(this);
        renderer.setAnimationLoop(this._loop);
      }

      this._readyResolve({ THREE });
    }

    _setupPixel(THREE) {
      const mk = () => new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType,
      });
      this._rtColor = mk();
      this._rtColor.depthTexture = new THREE.DepthTexture(1, 1);
      this._rtNormal = mk();
      this._normalMat = new THREE.MeshNormalMaterial();
      this._post = new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: this._rtColor.texture },
          tDepth: { value: this._rtColor.depthTexture },
          tNormal: { value: this._rtNormal.texture },
          res: { value: new THREE.Vector4(1, 1, 1, 1) },
          near: { value: 0.1 }, far: { value: 500 },
          ink: { value: new THREE.Color(0x2b221e) },
        },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `
          uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform sampler2D tNormal;
          uniform vec4 res; uniform float near; uniform float far; uniform vec3 ink;
          varying vec2 vUv;
          float dep(vec2 o){ return texture2D(tDepth, vUv + o * res.zw).r * (far - near); }
          vec3 nor(vec2 o){ return texture2D(tNormal, vUv + o * res.zw).rgb * 2.0 - 1.0; }
          float nEdge(vec2 o, float d, vec3 n){
            float dd = dep(o) - d; vec3 nn = nor(o);
            float ni = clamp(smoothstep(-0.01, 0.01, dot(n - nn, vec3(1.0))), 0.0, 1.0);
            float di = clamp(sign(dd * 0.25 + 0.01), 0.0, 1.0);
            return (1.0 - dot(n, nn)) * di * ni;
          }
          void main(){
            vec4 c = texture2D(tDiffuse, vUv);
            float d = dep(vec2(0.0)); vec3 n = nor(vec2(0.0));
            // Outline where depth JUMPS, not where it merely slopes. A surface seen at a slant changes depth on
            // every pixel; a first-difference test inked whole slanted surfaces (the grey sky and dark island
            // underside Ozi saw when zoomed out or looking low). The second difference (laplacian) is ~0 on any
            // flat surface, whatever its slant or the zoom, and large only at a real silhouette.
            float lx = dep(vec2(1.0,0.0)) + dep(vec2(-1.0,0.0)) - 2.0 * d;
            float ly = dep(vec2(0.0,1.0)) + dep(vec2(0.0,-1.0)) - 2.0 * d;
            float dd = max(lx, 0.0) + max(ly, 0.0);
            float de = step(0.3, dd);
            float ne = nEdge(vec2(1.0,0.0), d, n) + nEdge(vec2(-1.0,0.0), d, n) + nEdge(vec2(0.0,1.0), d, n) + nEdge(vec2(0.0,-1.0), d, n);
            ne = step(0.12, ne);
            vec3 col = c.rgb;
            if (de > 0.0) col = mix(col, ink, 0.88);
            else col = col * (1.0 + 0.28 * ne);
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }`,
        depthTest: false, depthWrite: false,
      });
      this._postScene = new THREE.Scene();
      this._postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this._postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._post));
    }

    _renderPixel() {
      const r = this._renderer, s = this._scene, c = this._camera;
      r.shadowMap.needsUpdate = true;
      r.setRenderTarget(this._rtColor);
      r.render(s, c);
      const bg = s.background;
      s.background = null;
      s.overrideMaterial = this._normalMat;
      const hid = [];
      if (this.noNormal) for (const o of this.noNormal) if (o.visible) { o.visible = false; hid.push(o); }
      r.setRenderTarget(this._rtNormal);
      r.render(s, c);
      for (const o of hid) o.visible = true;
      s.overrideMaterial = null;
      s.background = bg;
      r.setRenderTarget(null);
      r.render(this._postScene, this._postCam);
    }

    disconnectedCallback() {
      // Stop rendering and observing while detached; connectedCallback
      // resumes both. (The renderer itself is kept — a move within the
      // document must not rebuild the scene.)
      if (this._renderer) this._renderer.setAnimationLoop(null);
      if (this._ro) this._ro.disconnect();
    }

    /** Show (and own) the object. Replaces any previous object, enables
     *  shadows on every mesh, rests it on the ground plane, and frames
     *  the camera to its bounds. */
    setObject(object, opts = {}) {
      const THREE = this._THREE;
      if (!THREE) throw new Error('three-d-stage: not ready — await stage.ready first');
      if (this._object) this._scene.remove(this._object);
      this._object = object;
      object.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      const box = new THREE.Box3().setFromObject(object);
      if (!box.isEmpty() && this._px) {
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const R = opts.radius || sphere.radius;
        const ctr = opts.target ? new THREE.Vector3().fromArray(opts.target) : sphere.center;
        this._viewR = R;
        const cam = this._camera;
        cam.position.copy(ctr).add(new THREE.Vector3(1, 0.95, 1).normalize().multiplyScalar(R * 3));
        cam.near = 0.1; cam.far = R * 6; cam.zoom = 1;
        this._post.uniforms.near.value = cam.near;
        this._post.uniforms.far.value = cam.far;
        this._controls.target.copy(ctr);
        this._ground.position.y = box.min.y - R * 0.15;
        this._key.position.copy(ctr).add(new THREE.Vector3(-0.55, 1, 0.45).normalize().multiplyScalar(R * 2.5));
        this._key.target.position.copy(ctr);
        const sc = this._key.shadow.camera, span = R * 1.7;
        sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 0.1; sc.far = R * 6;
        sc.updateProjectionMatrix();
        this._fit();
        this._controls.update();
      } else if (!box.isEmpty()) {
        // Rest the object on the ground without moving its origin.
        this._ground.position.y = box.min.y;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const dist =
          (sphere.radius / Math.tan((this._camera.fov * Math.PI) / 360)) * 1.35;
        const dir = new THREE.Vector3(1, 0.55, 1.25).normalize();
        this._camera.position
          .copy(sphere.center)
          .add(dir.multiplyScalar(dist));
        this._camera.near = Math.max(dist / 100, 0.01);
        this._camera.far = dist * 100;
        this._camera.updateProjectionMatrix();
        this._controls.target.copy(sphere.center);
        this._controls.update();
        const span = sphere.radius * 3;
        this._key.shadow.camera.left = -span;
        this._key.shadow.camera.right = span;
        this._key.shadow.camera.top = span;
        this._key.shadow.camera.bottom = -span;
        this._key.shadow.camera.updateProjectionMatrix();
      }
      this._scene.add(object);
      this._setButtonsEnabled(true);
    }

    get _basename() {
      return (this.getAttribute('name') || 'model').replace(/[^\w.-]+/g, '_');
    }

    _setButtonsEnabled(on) {
      this._objBtn.disabled = !on;
      this._glbBtn.disabled = !on;
    }

    /** Every mesh and material needs a unique name for o/usemtl lines —
     *  fill in stable fallbacks, and return the unique material list. */
    _nameParts() {
      const mats = [];
      const seen = new Set();
      let meshI = 0;
      let matI = 0;
      this._object.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.name) o.name = 'part_' + meshI;
        meshI += 1;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) {
          if (!m || mats.includes(m)) continue;
          if (!m.name) {
            m.name = 'mat_' + matI;
            matI += 1;
          }
          while (seen.has(m.name)) {
            m.name = m.name + '_' + matI;
            matI += 1;
          }
          seen.add(m.name);
          mats.push(m);
        }
      });
      return mats;
    }

    /** One export attempt, reported to the host however it settles.
     *  Rethrows so a failure stays visible on the guest console exactly as
     *  before. The no-object early return is not an attempt (the toolbar is
     *  disabled until the model loads) and reports nothing. */
    async _runExport(format) {
      if (!this._object) return;
      try {
        await (format === 'obj' ? this._exportObj() : this._exportGlb());
        notifyExport(format, true);
      } catch (err) {
        notifyExport(format, false);
        throw err;
      }
    }

    async _exportObj() {
      if (!this._object) return;
      const mod = await import('three/addons/exporters/OBJExporter.js');
      const mats = this._nameParts();
      const base = this._basename;
      const obj =
        'mtllib ' + base + '.mtl\n' + new mod.OBJExporter().parse(this._object);
      let mtl = '# Exported by three-d-stage\n';
      for (const m of mats) {
        const c = m.color || { r: 0.8, g: 0.8, b: 0.8 };
        const rough = typeof m.roughness === 'number' ? m.roughness : 0.5;
        const opacity = typeof m.opacity === 'number' ? m.opacity : 1;
        mtl += 'newmtl ' + m.name + '\n';
        mtl +=
          'Kd ' + c.r.toFixed(4) + ' ' + c.g.toFixed(4) + ' ' + c.b.toFixed(4) + '\n';
        mtl += 'Ks 0.2000 0.2000 0.2000\n';
        mtl += 'Ns ' + Math.round((1 - rough) * 200) + '\n';
        mtl += 'd ' + opacity.toFixed(4) + '\n\n';
      }
      download(new Blob([obj], { type: 'text/plain' }), base + '.obj');
      download(new Blob([mtl], { type: 'text/plain' }), base + '.mtl');
    }

    async _exportGlb() {
      if (!this._object) return;
      const mod = await import('three/addons/exporters/GLTFExporter.js');
      this._nameParts();
      const base = this._basename;
      const buf = await new mod.GLTFExporter().parseAsync(this._object, {
        binary: true,
      });
      download(
        new Blob([buf], { type: 'model/gltf-binary' }),
        base + '.glb'
      );
    }
  }

  customElements.define('three-d-stage', ThreeDStage);
})();
