// The orb: one canvas, four behaviours.
//   idle       slow breathing pulse
//   listening  ripples driven by microphone volume
//   thinking   rotating orbit pattern while waiting for a reply
//   speaking   a moving outline that settles the moment playback stops
// With motion off (by setting or prefers-reduced-motion) it draws one still
// frame per state; colour and shape still tell the states apart.

const COLORS = {
  idle: [94, 214, 196],
  listening: [150, 236, 128],
  thinking: [170, 146, 255],
  speaking: [255, 182, 104],
  error: [255, 118, 110],
};

const lerp = (a, b, t) => a + (b - a) * t;

export class Orb {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.level = 0;
    this.shownLevel = 0;
    this.env = 0;
    this.color = [...COLORS.idle];
    this.ripples = [];
    this.lastRipple = 0;
    this.motionSetting = 'auto';
    this.mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.mq?.addEventListener?.('change', () => this.apply());
    this.t0 = performance.now();
    this.raf = 0;
    this.resize();
    new ResizeObserver(() => { this.resize(); this.drawStill(); }).observe(canvas);
    this.apply();
  }

  get animated() {
    if (this.motionSetting === 'off') return false;
    if (this.motionSetting === 'on') return true;
    return !this.mq?.matches;
  }

  setMotion(mode) { this.motionSetting = mode; this.apply(); }

  apply() {
    this.c.dataset.motion = this.animated ? 'on' : 'off';
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.animated) this.loop();
    else this.drawStill();
  }

  setState(s) {
    if (!COLORS[s]) return;
    if (s !== this.state) {
      this.state = s;
      this.c.dataset.state = s;
      if (s !== 'listening') { this.ripples = []; this.level = 0; }
      if (s === 'speaking') this.env = 0.6;
      if (s !== 'speaking') this.env = 0;
    }
    if (!this.animated) { this.color = [...COLORS[s]]; this.drawStill(); }
  }

  setLevel(v) { this.level = v; }
  word() { this.env = Math.min(1, this.env + 0.45); }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.c.width = Math.round(this.w * dpr);
    this.c.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  loop() {
    const step = () => {
      this.frame((performance.now() - this.t0) / 1000);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  drawStill() {
    this.color = [...COLORS[this.state]];
    this.frame(0, true);
  }

  frame(t, still = false) {
    const { ctx, w, h } = this;
    const target = COLORS[this.state];
    if (!still) for (let i = 0; i < 3; i++) this.color[i] = lerp(this.color[i], target[i], 0.08);
    const [r, g, b] = this.color.map(Math.round);
    const rgba = (a) => `rgba(${r},${g},${b},${a})`;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.26;
    this.shownLevel = lerp(this.shownLevel, this.level, 0.25);
    ctx.clearRect(0, 0, w, h);

    let scale = 1;
    if (this.state === 'idle') scale = still ? 1 : 1 + 0.035 * Math.sin((t * Math.PI * 2) / 4.2);
    if (this.state === 'listening') scale = 1 + this.shownLevel * 0.16;
    if (this.state === 'thinking') scale = 0.94;

    // Halo
    const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 2.1);
    halo.addColorStop(0, rgba(0.32));
    halo.addColorStop(1, rgba(0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    // Listening ripples
    if (this.state === 'listening') {
      if (still) {
        for (const k of [1.25, 1.5]) { ctx.strokeStyle = rgba(0.45 / k); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, R * k, 0, Math.PI * 2); ctx.stroke(); }
      } else {
        const gap = this.shownLevel > 0.08 ? 0.28 : 1.1;
        if (t - this.lastRipple > gap) {
          this.ripples.push({ born: t, s: Math.max(0.25, Math.min(1, this.shownLevel * 1.6)) });
          this.lastRipple = t;
        }
        this.ripples = this.ripples.filter((p) => t - p.born < 1.6);
        for (const p of this.ripples) {
          const age = (t - p.born) / 1.6;
          ctx.strokeStyle = rgba((1 - age) * 0.6 * p.s);
          ctx.lineWidth = 2 + p.s * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, R * scale * (1.02 + age * 0.9), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Body: a sphere, or a moving outline while speaking
    const grad = ctx.createRadialGradient(cx - R * 0.32, cy - R * 0.38, R * 0.08, cx, cy, R * 1.1);
    grad.addColorStop(0, 'rgba(255,255,255,0.92)');
    grad.addColorStop(0.28, rgba(1));
    grad.addColorStop(1, `rgba(${Math.round(r * 0.25)},${Math.round(g * 0.25)},${Math.round(b * 0.32)},1)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    if (this.state === 'speaking') {
      if (!still) this.env = Math.max(0.25, this.env * 0.96);
      const amp = still ? 0.5 : this.env;
      const N = 120;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const k = 1 + amp * (0.07 * Math.sin(3 * a + t * 4.1) + 0.045 * Math.sin(5 * a - t * 5.7) + 0.03 * Math.sin(8 * a + t * 3.2));
        const x = cx + Math.cos(a) * R * k;
        const y = cy + Math.sin(a) * R * k;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    } else {
      ctx.arc(cx, cy, R * scale, 0, Math.PI * 2);
    }
    ctx.fill();

    // Thinking: rotating arcs and orbiting points
    if (this.state === 'thinking') {
      const rot = still ? 0.6 : t * 1.6;
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        const rr = R * (1.22 + i * 0.16);
        const start = rot * (i % 2 ? -1 : 1) * (1 + i * 0.35) + i * 2.1;
        ctx.strokeStyle = rgba(0.75 - i * 0.18);
        ctx.lineWidth = 3 - i * 0.6;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, start, start + Math.PI * (0.55 + 0.15 * i));
        ctx.stroke();
      }
      for (let i = 0; i < 6; i++) {
        const a = rot * 1.3 + (i * Math.PI * 2) / 6;
        ctx.fillStyle = rgba(0.85);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * R * 0.62, cy + Math.sin(a) * R * 0.62, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (this.state === 'error') {
      ctx.strokeStyle = rgba(0.7);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
