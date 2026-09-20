/** Lightweight frame diagnostics. Measurement only: no render settings are changed. */
export class PerformanceDiagnostics {
  constructor(renderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
      && this.gl instanceof WebGL2RenderingContext;
    this.ext = this.gl.getExtension(this.isWebGL2
      ? 'EXT_disjoint_timer_query_webgl2'
      : 'EXT_disjoint_timer_query');
    this.pending = [];
    this.active = null;
    this.gpuMs = null;
    this.gpuStatus = this.ext ? 'warming-up' : 'unsupported';
    this.cpuMs = 0;
    this.frameMs = 0;
    this.lastFrameAt = performance.now();
    this.samples = [];

    const debug = this.gl.getExtension('WEBGL_debug_renderer_info');
    this.environment = {
      renderer: debug
        ? this.gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : this.gl.getParameter(this.gl.RENDERER),
      webgl: this.gl.getParameter(this.gl.VERSION),
      gpuTimerQuery: !!this.ext,
    };
  }

  beginFrame(now = performance.now()) {
    this.frameMs = now - this.lastFrameAt;
    this.lastFrameAt = now;
    this.cpuStartedAt = performance.now();
    this._pollQueries();
    if (!this.ext || this.active || this.pending.length >= 4) return;
    try {
      const query = this.isWebGL2 ? this.gl.createQuery() : this.ext.createQueryEXT();
      if (this.isWebGL2) this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
      else this.ext.beginQueryEXT(this.ext.TIME_ELAPSED_EXT, query);
      this.active = query;
    } catch (_) {
      this.active = null;
      this.gpuStatus = 'query-error';
    }
  }

  endFrame() {
    if (this.active) {
      try {
        if (this.isWebGL2) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        else this.ext.endQueryEXT(this.ext.TIME_ELAPSED_EXT);
        this.pending.push(this.active);
      } catch (_) {
        this._deleteQuery(this.active);
        this.gpuStatus = 'query-error';
      }
      this.active = null;
    }
    this.cpuMs = performance.now() - this.cpuStartedAt;
  }

  _pollQueries() {
    if (!this.ext || !this.pending.length) return;
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      for (const query of this.pending) this._deleteQuery(query);
      this.pending.length = 0;
      this.gpuMs = null;
      this.gpuStatus = 'disjoint';
      return;
    }
    const query = this.pending[0];
    const available = this.isWebGL2
      ? this.gl.getQueryParameter(query, this.gl.QUERY_RESULT_AVAILABLE)
      : this.ext.getQueryObjectEXT(query, this.ext.QUERY_RESULT_AVAILABLE_EXT);
    if (!available) return;
    const ns = this.isWebGL2
      ? this.gl.getQueryParameter(query, this.gl.QUERY_RESULT)
      : this.ext.getQueryObjectEXT(query, this.ext.QUERY_RESULT_EXT);
    this.pending.shift();
    this._deleteQuery(query);
    this.gpuMs = ns / 1e6;
    this.gpuStatus = 'available';
  }

  _deleteQuery(query) {
    if (this.isWebGL2) this.gl.deleteQuery(query);
    else this.ext.deleteQueryEXT(query);
  }

  snapshot(extra = {}) {
    return {
      frameTimeMs: this.frameMs,
      cpuFrameTimeMs: this.cpuMs,
      gpuFrameTimeMs: this.gpuMs,
      gpuTimerStatus: this.gpuStatus,
      resolution: `${this.gl.drawingBufferWidth}×${this.gl.drawingBufferHeight}`,
      pixelRatio: this.renderer.getPixelRatio(),
      ...this.environment,
      ...extra,
    };
  }
}
