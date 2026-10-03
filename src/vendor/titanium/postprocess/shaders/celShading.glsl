precision mediump float;

uniform sampler2D colorTexture;

uniform float levels;
uniform float intensity;

in vec2 v_textureCoordinates;

vec3 quantize(vec3 color, float steps) {
  return floor(color * steps + 0.5) / steps;
}

void main() {
  vec4 sampleColor = texture(colorTexture, v_textureCoordinates);
  float steps = max(levels, 2.0);
  vec3 toonColor = quantize(sampleColor.rgb, steps);
  float baseLuma = dot(sampleColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float toonLuma = dot(toonColor, vec3(0.2126, 0.7152, 0.0722));
  if (toonLuma > 0.0001) {
    toonColor *= baseLuma / toonLuma;
  }
  toonColor = clamp(toonColor, 0.0, 1.0);

  vec3 mixed = mix(sampleColor.rgb, toonColor, clamp(intensity, 0.0, 1.0));

  out_FragColor = vec4(mixed, sampleColor.a);
}
