// Percentage-closer soft shadows (PCSS) for the key light. Replaces the BasicShadowMap filter of three.js r187.
import * as THREE from 'three';

export const SHADOW_RANGE = 48; // near-to-far depth of the shadow camera in world units (constant)
const MAX_BLOCKER = 2.4; // longest caster-to-receiver distance along a light ray, world units

// Call before the first material compiles. `shadow.radius` must hold the penumbra radius in uv per unit of depth.
export function patchShadowChunk({ blockerTaps = 12, filterTaps = 16 } = {}) {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  // The BasicShadowMap variant is the last 2D getShadow in the chunk. Replace that one function, brace to brace.
  const start = chunk.lastIndexOf('float getShadow( sampler2D shadowMap');
  let end = chunk.indexOf('{', start), depth = 0;
  for (; start >= 0 && end < chunk.length; end++) {
    if (chunk[end] === '{') depth++;
    if (chunk[end] === '}' && --depth === 0) break;
  }
  if (start < 0 || depth !== 0) {
    console.warn('look: shadow chunk layout changed, soft shadows are off');
    return;
  }
  const pcss = /* glsl */`

		vec2 atlasDisk( int i, int n, float phi ) {
			float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
			float a = float( i ) * 2.399963229728653 + phi;
			return vec2( cos( a ), sin( a ) ) * r;
		}

		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {

			vec3 sc = shadowCoord.xyz / shadowCoord.w;
			// Depth slope of the receiver plane in shadow uv: a wide filter stays on the plane, so no acne.
			vec3 dx = dFdx( sc ), dy = dFdy( sc );
			float det = dx.x * dy.y - dx.y * dy.x;
			vec2 slope = abs( det ) > 1e-14 ? vec2( dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z ) / det : vec2( 0.0 );
			slope = clamp( slope, vec2( - 3.0 ), vec2( 3.0 ) );
			if ( sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 ) return 1.0;

			float texel = 1.0 / shadowMapSize.x;
			float zr = sc.z + shadowBias;
			// Each pixel of a 2x2 block takes every fourth point of one disc; the 3x3 tent in the composite merges them.
			vec2 cell = mod( floor( gl_FragCoord.xy ), 2.0 );
			int k = int( cell.x + 2.0 * cell.y );
			float margin = texel * 1.5 * ( abs( slope.x ) + abs( slope.y ) );
			float searchR = shadowRadius * ${(MAX_BLOCKER / SHADOW_RANGE).toFixed(5)};

			// Blocker search with the same taps on every pixel, so the filter radius is smooth.
			// The harmonic mean of the gaps keeps a near caster (a trunk, a foot) firm; the plain mean keeps tips wide.
			float gap = 0.0, far = 0.0, hits = 0.0;
			for ( int i = 0; i < ${blockerTaps}; i ++ ) {
				vec2 o = atlasDisk( i, ${blockerTaps}, 0.0 ) * searchR;
				float d = texture2D( shadowMap, sc.xy + o ).r;
				float z = zr + dot( slope, o ) - margin;
				if ( d < z ) { gap += 1.0 / ( z - d + 0.002 ); far += z - d; hits += 1.0; }
			}
			// The sparse search can miss a thin caster (a leg, a trunk). Then the filter still runs, on a small disc.
			if ( hits > 0.5 ) {
				far /= hits;
				gap = mix( hits / gap, far, 0.85 ); // between the harmonic and the plain mean
			} else {
				far = 1.0;
				gap = 0.0;
			}

			// Filter radius grows with the gap: sharp at contact, wide far from the caster.
			float r = clamp( gap * shadowRadius, texel * ( hits > 0.5 ? 1.5 : 5.0 ), searchR );
			float lit = 0.0;
			for ( int i = 0; i < ${filterTaps}; i ++ ) {
				vec2 o = atlasDisk( i * 4 + k, ${filterTaps * 4}, 1.7 ) * r;
				float d = texture2D( shadowMap, sc.xy + o ).r;
				float z = zr + dot( slope, o ) - margin;
				// Blocked: in front of the receiver plane, or behind that plane but still in front of the receiver
				// itself (a caster that touches the page next to this pixel). The plane itself is never a blocker.
				lit += ( d < z || ( d < zr - margin && d > z + 2.0 * margin - shadowBias ) ) ? 0.0 : 1.0;
			}
			// A caster that lies on its receiver (mean gap under 0.004 units) casts nothing; full strength from 0.02.
			float lift = smoothstep( ${(0.004 / SHADOW_RANGE).toExponential(3)}, ${(0.02 / SHADOW_RANGE).toExponential(3)}, far );
			return 1.0 - lift * ( 1.0 - lit / ${filterTaps}.0 );

		}

	`;
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk.slice(0, start) + pcss + chunk.slice(end + 1);
}

// Paper translucency: a card lit from behind shows its colour, warm, at `amount` of the front light.
export function patchTranslucency(amount = 0.3) {
  const name = 'lights_physical_pars_fragment';
  const chunk = THREE.ShaderChunk[name];
  const a = 'vec3 irradiance = dotNL * directLight.color;';
  const b = 'reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );';
  const start = chunk.indexOf('void RE_Direct_Physical');
  if (start < 0 || chunk.indexOf(a, start) < 0 || chunk.indexOf(b, start) < 0) {
    console.warn('look: light chunk layout changed, paper translucency is off');
    return;
  }
  const through = `vec3 atlasThrough = ${amount.toFixed(3)} * saturate( - dot( geometryNormal, directLight.direction ) )`
    + ' * directLight.color * vec3( 1.0, 0.84, 0.66 );';
  THREE.ShaderChunk[name] = chunk.slice(0, start) + chunk.slice(start)
    .replace(a, `${a}\n\t${through}`)
    .replace(b, `${b}\n\treflectedLight.directDiffuse += atlasThrough * diffuseBRDF;`);
}

// Page bounce: the lit cream page throws warm light up onto the lower part of faces that do not point up.
export function patchPageBounce(strength = 0.9, reach = 0.3) {
  const name = 'lights_physical_pars_fragment';
  const chunk = THREE.ShaderChunk[name];
  const start = chunk.indexOf('void RE_IndirectDiffuse_Physical');
  const brace = chunk.indexOf('{', start);
  if (start < 0 || brace < 0) {
    console.warn('look: light chunk layout changed, page bounce is off');
    return;
  }
  const code = `
	float atlasHeight = dot( viewMatrix[ 1 ].xyz, geometryPosition - viewMatrix[ 3 ].xyz );
	float atlasUp = dot( viewMatrix[ 1 ].xyz, geometryNormal );
	vec3 atlasBounce = vec3( 1.0, 0.80, 0.58 ) * ${strength.toFixed(3)} * exp( - max( atlasHeight, 0.0 ) / ${reach.toFixed(3)} )
		* saturate( 0.6 - 0.6 * atlasUp );
	reflectedLight.indirectDiffuse += atlasBounce * BRDF_Lambert( material.diffuseContribution );`;
  THREE.ShaderChunk[name] = chunk.slice(0, brace + 1) + code + chunk.slice(brace + 1);
}
