// Native helpers for the hair bake (compiled on first use into tools/hair-bake/build/).
//
//   raster     thin anti-aliased strand segments composited back to front ("over"),
//              depth-tested against an occluder depth map; carries C shading channels.
//   tri_zbuf   z-buffered triangles (largest z wins: +z points at the viewer) with
//              per-vertex attributes, for the head/body occluder and the head masks.
//   splat3d    trilinear density splat into a 3D grid (deep opacity maps).
//   zmax       front-most z per pixel of a point cloud.
//
// All buffers are float32, row-major, pixel centres at integer + 0.5.
#include <math.h>
#include <stdlib.h>

static const float* g_zsoft = 0;
static const float* g_asoft = 0;
// Optional soft occluder: where a strand is behind g_zsoft[i] its coverage is scaled by
// (1 - g_asoft[i]).  Used for the neck and shoulders so hair passing behind them fades
// over a few pixels instead of being cut with a hard line.
void set_soft(const float* zs, const float* as) { g_zsoft = zs; g_asoft = as; }

static const float* g_zalt = 0;
static int g_alt_ch = -1;
// Optional alternative occluder: a deposit hidden by zocc but NOT by g_zalt (e.g. the body
// without the arms) still shows, with its coverage scaled by its channel g_alt_ch (0..1).
// The bake uses it so hair hanging in FRONT of the shoulders is never cut by the proxy's
// arms (real arms hang at the sides), while hair behind the body stays hidden.
void set_alt(const float* za, int ch) { g_zalt = za; g_alt_ch = ch; }

static inline void splat(float* out, int W, int H, int C, const float* zocc, float zbias,
                         float x, float y, float z, float cov, const float* ch) {
  int ix = (int)floorf(x - .5f), iy = (int)floorf(y - .5f);
  float fx = x - .5f - ix, fy = y - .5f - iy;
  float wts[4] = {(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy};
  int px[4] = {ix, ix + 1, ix, ix + 1}, py[4] = {iy, iy, iy + 1, iy + 1};
  for (int k = 0; k < 4; k++) {
    int X = px[k], Y = py[k];
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    long i = (long)Y * W + X;
    float a = cov * wts[k];
    if (zocc && z < zocc[i] - zbias) {
      if (!g_zalt || g_alt_ch < 0 || z < g_zalt[i] - zbias) continue;
      a *= ch[g_alt_ch];
    }
    if (g_zsoft && z < g_zsoft[i]) a *= 1.f - g_asoft[i];
    if (a > 1.f) a = 1.f;
    if (a <= 0.f) continue;
    float* o = out + i * (1 + C);
    float r = 1.f - a;
    o[0] = o[0] * r + a;
    for (int c = 0; c < C; c++) o[1 + c] = o[1 + c] * r + ch[c] * a;
  }
}

// seg: nseg x 2 x (5+C) floats, per vertex x, y (px), z, width (px), opacity, C channels.
// out: H x W x (1+C), premultiplied: A, ch[0..C-1].  Segments must be sorted back to front.
// Each segment is walked in sub-pixel steps; each step deposits coverage width*ds*opacity
// bilinearly into the 4 nearest pixels (a box-filtered line for sub-pixel strands).  A strand
// wider than a pixel is split across its width into ceil(width) parallel sub-lines, so thick
// strands (zoomed bakes, clumps) keep an anti-aliased edge instead of a 2x2 blob.
// C may be at most 64.
void raster(int nseg, const float* seg, int C, int W, int H, float* out, const float* zocc,
            float zbias, float step) {
  int NA = 5 + C;
  float ch[64];
  if (C > 64) return;
  for (int s = 0; s < nseg; s++) {
    const float* p = seg + (long)s * 2 * NA;
    const float* q = p + NA;
    float dx = q[0] - p[0], dy = q[1] - p[1];
    float len = sqrtf(dx * dx + dy * dy);
    int n = (int)ceilf(len / step);
    if (n < 1) n = 1;
    float ds = len / n;
    if (ds < 0.05f) ds = 0.05f;
    float nx = 0.f, ny = 0.f;
    if (len > 1e-6f) { nx = -dy / len; ny = dx / len; }
    for (int j = 0; j < n; j++) {
      float t = (j + 0.5f) / n, u = 1.f - t;
      float x = p[0] * u + q[0] * t, y = p[1] * u + q[1] * t, z = p[2] * u + q[2] * t;
      float w = p[3] * u + q[3] * t, a = p[4] * u + q[4] * t;
      for (int c = 0; c < C; c++) ch[c] = p[5 + c] * u + q[5 + c] * t;
      if (w <= 1.f) {
        splat(out, W, H, C, zocc, zbias, x, y, z, w * ds * a, ch);
      } else {
        int k = (int)ceilf(w);
        float sub = w / k;
        for (int i = 0; i < k; i++) {
          float o = (i + 0.5f) * sub - 0.5f * w;
          splat(out, W, H, C, zocc, zbias, x + nx * o, y + ny * o, z, sub * ds * a, ch);
        }
      }
    }
  }
}

// Triangles: P is ntri x 3 x 3 (x px, y px, z), A is ntri x 3 x na attributes.
// zbuf (H x W) must be initialised by the caller (e.g. -1e9); attr (H x W x na) receives
// the attributes of the front-most triangle.  Pixel centres at +0.5.
void tri_zbuf(int ntri, const float* P, const float* A, int na, int W, int H, float* zbuf, float* attr) {
  for (int t = 0; t < ntri; t++) {
    const float* v = P + (long)t * 9;
    float x0 = v[0], y0 = v[1], z0 = v[2], x1 = v[3], y1 = v[4], z1 = v[5], x2 = v[6], y2 = v[7], z2 = v[8];
    float det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (fabsf(det) < 1e-12f) continue;
    int bx0 = (int)floorf(fminf(x0, fminf(x1, x2))), bx1 = (int)ceilf(fmaxf(x0, fmaxf(x1, x2)));
    int by0 = (int)floorf(fminf(y0, fminf(y1, y2))), by1 = (int)ceilf(fmaxf(y0, fmaxf(y1, y2)));
    if (bx0 < 0) bx0 = 0;
    if (by0 < 0) by0 = 0;
    if (bx1 > W - 1) bx1 = W - 1;
    if (by1 > H - 1) by1 = H - 1;
    const float* a = A ? A + (long)t * 3 * na : 0;
    for (int Y = by0; Y <= by1; Y++) {
      float py = Y + 0.5f;
      for (int X = bx0; X <= bx1; X++) {
        float px = X + 0.5f;
        float l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / det;
        float l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / det;
        float l2 = 1.f - l0 - l1;
        if (l0 < -1e-5f || l1 < -1e-5f || l2 < -1e-5f) continue;
        float z = l0 * z0 + l1 * z1 + l2 * z2;
        long i = (long)Y * W + X;
        if (z <= zbuf[i]) continue;
        zbuf[i] = z;
        if (a && attr)
          for (int k = 0; k < na; k++) attr[i * na + k] = l0 * a[k] + l1 * a[na + k] + l2 * a[2 * na + k];
      }
    }
  }
}

// Density splat into a 3D grid [NZ][NY][NX] (trilinear), for deep opacity maps.
void splat3d(int n, const float* pts, const float* mass, int NX, int NY, int NZ, float* grid) {
  for (int i = 0; i < n; i++) {
    float fx = pts[i * 3], fy = pts[i * 3 + 1], fz = pts[i * 3 + 2];
    int x = (int)floorf(fx), y = (int)floorf(fy), z = (int)floorf(fz);
    float ax = fx - x, ay = fy - y, az = fz - z;
    for (int k = 0; k < 8; k++) {
      int X = x + (k & 1), Y = y + ((k >> 1) & 1), Z = z + ((k >> 2) & 1);
      if (X < 0 || Y < 0 || Z < 0 || X >= NX || Y >= NY || Z >= NZ) continue;
      float w = ((k & 1) ? ax : 1 - ax) * (((k >> 1) & 1) ? ay : 1 - ay) * (((k >> 2) & 1) ? az : 1 - az);
      grid[((long)Z * NY + Y) * NX + X] += mass[i] * w;
    }
  }
}

// Front-most z per pixel (z-buffer max) of points.
void zmax(int n, const float* px, const float* py, const float* pz, int W, int H, float* zb) {
  for (int i = 0; i < n; i++) {
    int X = (int)px[i], Y = (int)py[i];
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    long k = (long)Y * W + X;
    if (pz[i] > zb[k]) zb[k] = pz[i];
  }
}
