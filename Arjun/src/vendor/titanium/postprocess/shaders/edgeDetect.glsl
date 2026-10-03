precision mediump float;

uniform sampler2D colorTexture;

uniform float edgeThreshold;
uniform float edgeStrength;
uniform float edgeStep;
uniform vec4 edgeColor;

in vec2 v_textureCoordinates;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec2 step = edgeStep / vec2(textureSize(colorTexture, 0));

  float tl = luminance(texture(colorTexture, v_textureCoordinates + step * vec2(-1.0, 1.0)).rgb);
  float tc = luminance(texture(colorTexture, v_textureCoordinates + step * vec2(0.0, 1.0)).rgb);
  float tr = luminance(texture(colorTexture, v_textureCoordinates + step * vec2(1.0, 1.0)).rgb);
  float ml = luminance(texture(colorTexture, v_textureCoordinates + step * vec2(-1.0, 0.0)).rgb);
  float mr = luminance(texture(colorTexture, v_textureCoordinates + step * vec2(1.0, 0.0)).rgb);
  float bl = luminance(texture(colorTexture, v_textureCoordinates + step * vec2(-1.0, -1.0)).rgb);
  float bc = luminance(texture(colorTexture, v_textureCoordinates + step * vec2(0.0, -1.0)).rgb);
  float br = luminance(texture(colorTexture, v_textureCoordinates + step * vec2(1.0, -1.0)).rgb);

  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -bl - 2.0 * bc - br + tl + 2.0 * tc + tr;

  float g = length(vec2(gx, gy)) * edgeStrength;
  float edge = smoothstep(edgeThreshold, edgeThreshold + 0.2, g);

  vec3 base = texture(colorTexture, v_textureCoordinates).rgb;
  float baseLum = luminance(base);
  float suppress = smoothstep(0.8, 1.0, baseLum);
  edge *= (1.0 - 0.35 * suppress);

  vec3 edgeTint = clamp(base * edgeColor.rgb, 0.0, 1.0);
  vec3 mixed = mix(base, edgeTint, edge);

  out_FragColor = vec4(mixed, 1.0);
}
