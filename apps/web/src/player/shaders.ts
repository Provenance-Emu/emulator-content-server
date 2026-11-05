export type ShaderId = 'off' | 'scanlines' | 'lcd';
export interface ShaderResult {
  selection: ShaderId | null;
  status: 'off' | 'requested' | 'failed';
}
export interface SettingsInfo {
  commands: boolean;
  shaders: boolean;
  shaderResult?: ShaderResult;
}
export function validShaderId(value: unknown): value is ShaderId {
  return value === 'off' || value === 'scanlines' || value === 'lcd';
}
export function validShaderResult(value: unknown): value is ShaderResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as ShaderResult;
  return (
    (r.status === 'off' && r.selection === 'off') ||
    (r.status === 'requested' && validShaderId(r.selection) && r.selection !== 'off') ||
    (r.status === 'failed' && (r.selection === null || r.selection === 'off'))
  );
}
// Original, single-pass GLSL ES effects. No remote shader pack or includes.
const vertex = `#if defined(VERTEX)
attribute vec4 VertexCoord;
attribute vec2 TexCoord;
uniform mat4 MVPMatrix;
varying vec2 vTexCoord;
void main(){gl_Position=MVPMatrix*VertexCoord;vTexCoord=TexCoord;}
#elif defined(FRAGMENT)
#ifdef GL_ES
precision mediump float;
#endif
uniform sampler2D Texture;
uniform vec2 InputSize;
varying vec2 vTexCoord;
`;
export const builtinShaders = {
  scanlines:
    vertex +
    `void main(){vec4 c=texture2D(Texture,vTexCoord);float stripe=mod(floor(vTexCoord.y*InputSize.y),2.0);gl_FragColor=vec4(c.rgb*mix(0.72,1.0,stripe),c.a);}
#endif`,
  lcd:
    vertex +
    `void main(){vec4 c=texture2D(Texture,vTexCoord);float col=mod(floor(vTexCoord.x*InputSize.x),3.0);vec3 mask=vec3(0.78);if(col<1.0)mask.r=1.0;else if(col<2.0)mask.g=1.0;else mask.b=1.0;float row=mod(floor(vTexCoord.y*InputSize.y),3.0);gl_FragColor=vec4(c.rgb*mask*mix(0.88,1.0,step(1.0,row)),c.a);}
#endif`,
} as const;
