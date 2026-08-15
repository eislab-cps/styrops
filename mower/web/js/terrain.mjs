// terrain.mjs — the two things every other module has to agree on: where the
// ground is, and which way the wind is blowing.
//
// COORDINATE CONVENTION (see scene.mjs): three.x = model.x, three.z = -model.y.
// heightAt() takes MODEL x,y (metres) and returns the ground height in metres.
//
// The property is not flat. A gentle two-octave swell gives the lawn real
// relief, which is what makes the grass shells read as a surface rather than a
// decal. Everything that stands on the ground — robot, obstacles, dock, fence,
// paths, the turf itself — samples THIS function, so nothing ever floats or
// sinks. Keep the wavelengths long: paths and shape geometry are tessellated at
// ~0.6 m, and a short wavelength would make them cut through the lawn.

/** Peak relief in metres, ON THE PLOT ONLY. The land outside rolls far harder
 *  (see landscapeY in scene.mjs) — but this is the surface being mowed, and a
 *  mowing surface has to stay gentle. */
export const RELIEF = 0.75;

export function heightAt(x, y) {
  return RELIEF * (
    0.62 * Math.sin(x * 0.0680 + 0.9) * Math.cos(y * 0.0910 - 0.4) +
    0.38 * Math.sin(x * 0.1310 - 1.7) * Math.sin(y * 0.0570 + 2.2)
  );
}

/** Shared wind clock + strength. Every swaying material binds these. */
export const WIND = {
  uTime: { value: 0 },
  uWind: { value: 0.055 },
};

/**
 * GLSL twin of the wind model, injected into every vertex shader that sways.
 *
 * gustField() returns a horizontal displacement direction * strength for a
 * world position. Three sine waves with different wave vectors and phase
 * speeds add up to gusts that TRAVEL across the lawn — the wavelengths are
 * 40-50 m and the phase speed ~7 m/s, so a wave crosses a 40 m garden in about
 * five seconds. That travelling band of bending is the thing you notice first;
 * the per-blade jitter on top only sells it close up.
 */
export const GUST_GLSL = /* glsl */`
  uniform float uTime;
  uniform float uWind;

  float gustAmount( vec2 p, float t ) {
    float a = sin( dot( p, vec2(  0.115,  0.072 ) ) - t * 1.05 );
    float b = sin( dot( p, vec2( -0.058,  0.134 ) ) - t * 0.71 + 1.7 );
    float c = sin( dot( p, vec2(  0.242, -0.196 ) ) - t * 1.62 + 3.1 );
    return 0.5 + 0.5 * ( 0.42 * a + 0.34 * b + 0.24 * c );
  }

  // xz displacement for a blade/leaf whose base is at world p
  vec2 gustField( vec2 p, float t ) {
    float g = gustAmount( p, t );
    // prevailing wind toward +x, veering a little as the gust passes
    vec2 dir = normalize( vec2( 0.94, 0.30 + 0.30 * ( g - 0.5 ) ) );
    float amt = 0.30 + 1.45 * g * g;
    // high-frequency flutter so individual blades are not locked in step
    float f = sin( p.x * 3.1 + p.y * 2.3 + t * 6.0 ) * 0.16
            + sin( p.x * 5.7 - p.y * 4.1 + t * 8.7 ) * 0.10;
    return dir * ( amt + f * ( 0.35 + g ) );
  }
`;
