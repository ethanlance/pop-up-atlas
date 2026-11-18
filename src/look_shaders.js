// GLSL for the look passes. All passes draw one full-screen triangle.

export const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

// lens: x = near, y = far, z = focus depth, w = CoC gain (full-res pixels). cocLimit: x = knee, y = max, pixels.
const LENS = /* glsl */`
uniform vec4 lens;
uniform vec2 cocLimit;
float viewDepth( float d ) {
  return lens.x * lens.y / ( lens.y - d * ( lens.y - lens.x ) );
}
// Signed circle of confusion in full-res pixels: negative in front of the focus plane, positive behind it.
float cocPx( float z ) {
  float c = lens.w * ( 1.0 - lens.z / z );
  float a = abs( c );
  // Knee: under cocLimit.x the blur is held near zero, so the focus band is wide enough for the traveller.
  return sign( c ) * min( a * smoothstep( cocLimit.x * 0.5, cocLimit.x * 2.5, a ), cocLimit.y );
}`;

const NOISE = /* glsl */`
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}`;

const AO_READ = /* glsl */`
uniform sampler2D tAo;
uniform vec3 aoTint;
// Four bilinear taps (3x3 tent) merge the 2x2 interleaved AO samples.
vec3 aoAt( vec2 uv ) {
  vec2 o = texel * 0.5;
  float ao = 0.25 * ( texture2D( tAo, uv + o ).r + texture2D( tAo, uv - o ).r
    + texture2D( tAo, uv + vec2( o.x, - o.y ) ).r + texture2D( tAo, uv + vec2( - o.x, o.y ) ).r );
  return mix( aoTint, vec3( 1.0 ), ao );
}`;

// Full-res contact occlusion from depth only (Alchemy estimator, 8 of 32 disc taps per pixel, 2x2 interleaved).
export const AO = /* glsl */`
varying vec2 vUv;
uniform sampler2D tDepth;
uniform vec2 texel;
uniform vec4 projInfo; // tan(fov/2)*aspect, tan(fov/2), radius (world), strength
${LENS}
${NOISE}
vec3 posAt( vec2 uv ) {
  float z = viewDepth( texture2D( tDepth, uv ).x );
  return vec3( ( uv * 2.0 - 1.0 ) * projInfo.xy * z, - z );
}
void main() {
  vec3 p = posAt( vUv );
  if ( - p.z > lens.y * 0.9 ) { gl_FragColor = vec4( 1.0 ); return; }
  vec2 e = texel;
  vec3 pl = posAt( vUv - vec2( e.x, 0.0 ) ), pr = posAt( vUv + vec2( e.x, 0.0 ) );
  vec3 pd = posAt( vUv - vec2( 0.0, e.y ) ), pu = posAt( vUv + vec2( 0.0, e.y ) );
  vec3 dx = abs( pl.z - p.z ) < abs( pr.z - p.z ) ? p - pl : pr - p;
  vec3 dy = abs( pd.z - p.z ) < abs( pu.z - p.z ) ? p - pd : pu - p;
  vec3 n = normalize( cross( dx, dy ) );
  float radius = projInfo.z;
  vec2 rUv = radius / ( - 2.0 * p.z * projInfo.xy );
  vec2 cell = mod( floor( gl_FragCoord.xy ), 2.0 );
  float k = cell.x + 2.0 * cell.y;
  float sum = 0.0;
  for ( int i = 0; i < 8; i ++ ) {
    float j = float( i ) * 4.0 + k;
    float r = sqrt( ( j + 0.5 ) / 32.0 );
    float a = j * 2.399963;
    vec3 v = posAt( vUv + vec2( cos( a ), sin( a ) ) * r * rUv ) - p;
    float vv = dot( v, v );
    float fall = 1.0 - clamp( vv / ( radius * radius * 4.0 ), 0.0, 1.0 );
    sum += fall * max( dot( v, n ) - 0.004, 0.0 ) / ( vv + 0.0004 );
  }
  float ao = clamp( 1.0 - projInfo.w * sum * radius * 0.5, 0.0, 1.0 );
  gl_FragColor = vec4( ao );
}`;

// Half-res colour with AO applied; alpha = signed CoC in half-res pixels.
export const PREP = /* glsl */`
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform vec2 texel;
${LENS}
${AO_READ}
void main() {
  vec3 c = texture2D( tScene, vUv ).rgb * aoAt( vUv );
  float z = viewDepth( texture2D( tDepth, vUv ).x );
  gl_FragColor = vec4( c, cocPx( z ) * 0.5 );
}`;

// Bokeh gather on a golden-angle disc. A tap counts when its own CoC reaches the centre pixel (scatter as gather).
// Taps behind the centre are clamped to the centre CoC, so a blurred background does not bleed over sharp cards.
export const GATHER = /* glsl */`
varying vec2 vUv;
uniform sampler2D tPrep;
uniform vec2 texel;
uniform vec2 cocLimit;
${NOISE}
void main() {
  vec4 c = texture2D( tPrep, vUv );
  float cs = abs( c.a );
  // Kernel radius: own CoC plus a margin for nearer, more blurred cards that overlap this pixel.
  float maxR = min( cocLimit.y * 0.5, cs + cocLimit.y * 0.16 );
  vec3 col = c.rgb;
  float acc = cs;
  float tot = 1.0;
  float phi = ign( gl_FragCoord.xy ) * 6.2831853;
  vec2 px = texel * 2.0;
  for ( int i = 0; i < TAPS; i ++ ) {
    float r = maxR * sqrt( ( float( i ) + 0.5 ) / float( TAPS ) );
    float a = float( i ) * 2.399963 + phi;
    vec4 s = texture2D( tPrep, vUv + vec2( cos( a ), sin( a ) ) * r * px );
    float ss = abs( s.a );
    if ( s.a > c.a ) ss = min( ss, cs * 2.0 );
    float m = smoothstep( r - 0.6, r + 0.6, ss );
    col += mix( col / tot, s.rgb, m );
    acc += mix( acc / tot, ss, m );
    tot += 1.0;
  }
  gl_FragColor = vec4( col / tot, acc / tot );
}`;

// 3x3 tent: removes the gather noise.
export const FILL = /* glsl */`
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 texel;
void main() {
  vec2 o = texel; // half of a half-res pixel
  gl_FragColor = 0.25 * ( texture2D( tMap, vUv + o ) + texture2D( tMap, vUv - o )
    + texture2D( tMap, vUv + vec2( o.x, - o.y ) ) + texture2D( tMap, vUv + vec2( - o.x, o.y ) ) );
}`;

export const BLOOM_DOWN = /* glsl */`
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 srcTexel;
uniform float threshold;
vec3 tap( vec2 uv ) {
  vec3 c = texture2D( tMap, uv ).rgb;
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  return c * max( l - threshold, 0.0 ) / max( l, 1e-4 );
}
void main() {
  vec2 o = srcTexel;
  gl_FragColor = vec4( 0.25 * ( tap( vUv + o ) + tap( vUv - o ) + tap( vUv + vec2( o.x, - o.y ) ) + tap( vUv + vec2( - o.x, o.y ) ) ), 1.0 );
}`;

export const BLOOM_UP = /* glsl */`
varying vec2 vUv;
uniform sampler2D tMap;
uniform vec2 srcTexel;
void main() {
  vec2 o = srcTexel * 0.5;
  gl_FragColor = vec4( 0.25 * ( texture2D( tMap, vUv + o ).rgb + texture2D( tMap, vUv - o ).rgb
    + texture2D( tMap, vUv + vec2( o.x, - o.y ) ).rgb + texture2D( tMap, vUv + vec2( - o.x, o.y ) ).rgb ), 1.0 );
}`;

// Composite: sharp or blurred by CoC, bloom, exposure, AgX, contrast, sRGB, vignette, grain.
export const FINAL = /* glsl */`
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tDof;
uniform sampler2D tBloom;
uniform vec2 texel;
uniform float exposure;
uniform float contrast;
uniform float saturation;
uniform vec4 bloom; // rgb tint, a strength
uniform float vignette;
uniform float grain;
uniform float time;
uniform float aspect; // height / width
uniform vec4 projInfo; // tan(fov/2)*aspect, tan(fov/2)
uniform mat4 camWorld;
uniform vec4 lantern; // xyz = world position of the key lamp, w = its distance to the focus
uniform float aoDebug;
uniform float pool; // 0 = even light, 1 = full inverse-square pool around the focus
${LENS}
${AO_READ}

vec3 agxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
// AgX as in three.js r187 (Filament port, rec 2020 primaries), then a contrast look about middle grey.
vec3 agx( vec3 color ) {
  const mat3 toRec2020 = mat3( vec3( 0.6274, 0.0691, 0.0164 ), vec3( 0.3293, 0.9195, 0.0880 ), vec3( 0.0433, 0.0113, 0.8956 ) );
  const mat3 toSrgb = mat3( vec3( 1.6605, - 0.1246, - 0.0182 ), vec3( - 0.5876, 1.1329, - 0.1006 ), vec3( - 0.0728, - 0.0083, 1.1187 ) );
  const mat3 inset = mat3( vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
  const mat3 outset = mat3( vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
    vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
    vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
  color = inset * ( toRec2020 * color );
  color = clamp( ( log2( max( color, 1e-10 ) ) + 12.47393 ) / 16.5, 0.0, 1.0 );
  color = agxContrast( color );
  float l = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = l + saturation * ( color - l );
  color = 0.5 * pow( max( color, 0.0 ) * 2.0, vec3( contrast ) );
  color = outset * color;
  color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
  return clamp( toSrgb * color, 0.0, 1.0 );
}
vec3 toDisplay( vec3 c ) {
  return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
}
float hash( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}
void main() {
  // The 3x3 tent merges the 2x2 interleaved shadow and AO samples. At a depth step (a card outline) the centre
  // sample is kept, so outlines in the focus band stay crisp.
  vec2 h = texel * 0.5;
  vec3 tent = 0.25 * ( texture2D( tScene, vUv + h ).rgb + texture2D( tScene, vUv - h ).rgb
    + texture2D( tScene, vUv + vec2( h.x, - h.y ) ).rgb + texture2D( tScene, vUv + vec2( - h.x, h.y ) ).rgb );
  float z = viewDepth( texture2D( tDepth, vUv ).x );
  float zx = viewDepth( texture2D( tDepth, vUv + vec2( texel.x, 0.0 ) ).x ) + viewDepth( texture2D( tDepth, vUv - vec2( texel.x, 0.0 ) ).x );
  float zy = viewDepth( texture2D( tDepth, vUv + vec2( 0.0, texel.y ) ).x ) + viewDepth( texture2D( tDepth, vUv - vec2( 0.0, texel.y ) ).x );
  float step2 = max( abs( zx - 2.0 * z ), abs( zy - 2.0 * z ) ); // second difference: zero on any flat plane
  vec3 sharp = mix( tent, texture2D( tScene, vUv ).rgb, smoothstep( 0.004, 0.014, step2 ) ) * aoAt( vUv );
  float coc = cocPx( z );
  vec4 dof = texture2D( tDof, vUv );
  float blend = smoothstep( 0.5, 2.6, max( abs( coc ), dof.a * 2.0 ) );
  vec3 c = mix( sharp, dof.rgb, blend );
  c += texture2D( tBloom, vUv ).rgb * bloom.rgb * bloom.a;
  // Lamp falloff: the key is a near lamp, so the page is brightest toward it and falls away behind the focus.
  vec3 world = ( camWorld * vec4( ( vUv * 2.0 - 1.0 ) * projInfo.xy * z, - z, 1.0 ) ).xyz - lantern.xyz;
  float fall = clamp( lantern.w * lantern.w / dot( world, world ), 0.4, 1.1 );
  c = toDisplay( agx( c * exposure * mix( 1.0, fall, pool ) ) );
  vec2 q = ( vUv - 0.5 ) * vec2( 2.0, 2.0 * aspect );
  c *= 1.0 - vignette * pow( min( length( q ), 1.2 ), 2.2 );
  // Fine grain, new pattern 24 times a second, stronger in the shadows.
  vec2 gp = gl_FragCoord.xy + floor( time * 24.0 ) * vec2( 37.0, 91.0 );
  float g = ( hash( gp ) + hash( gp + 19.19 ) + hash( gp + 47.7 ) + hash( gp + 83.1 ) - 2.0 ) * 1.732;
  c += g * grain * ( 0.6 + 0.8 * ( 1.0 - c ) );
  if ( aoDebug > 0.5 ) c = aoAt( vUv );
  gl_FragColor = vec4( c, 1.0 );
}`;
