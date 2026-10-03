import * as Cesium from 'cesium'
import type { StylizationConfig, ViewerHandle } from '../types'
import edgeDetectShader from './shaders/edgeDetect.glsl?raw'
import toonShader from './shaders/celShading.glsl?raw'

// Keep Titanium's original stages and GLSL, with gentler neutral contrast so
// small geographic labels and thin roads remain crisp at close zoom levels.
const DEFAULT_EDGE_COLOR = new Cesium.Color(1.12, 1.12, 1.12, 1.0)

function ensureStages(handle: ViewerHandle) {
  if (handle.stages.stylize) {
    return handle.stages.stylize
  }

  const toonStage = new Cesium.PostProcessStage({
    name: 'titanium-toon',
    fragmentShader: toonShader,
    uniforms: {
      levels: 8.0,
      intensity: 0.35,
    },
  })

  const edgeStage = new Cesium.PostProcessStage({
    name: 'titanium-edge',
    fragmentShader: edgeDetectShader,
    uniforms: {
      edgeThreshold: 0.24,
      edgeStrength: 1.6,
      edgeStep: 1.0,
      edgeColor: DEFAULT_EDGE_COLOR,
    },
  })

  handle.viewer.scene.postProcessStages.add(toonStage)
  handle.viewer.scene.postProcessStages.add(edgeStage)

  handle.stages.stylize = { edge: edgeStage, toon: toonStage }
  return handle.stages.stylize
}

export function setStylizationConfig(handle: ViewerHandle, config: StylizationConfig) {
  const stages = ensureStages(handle)
  const enabled = config.enabled

  stages.toon.enabled = enabled && config.toon.enabled
  stages.edge.enabled = enabled && config.edge.enabled

  stages.toon.uniforms.intensity = config.toon.intensity
  stages.edge.uniforms.edgeThreshold = config.edge.threshold

  handle.config.stylization = config
  handle.viewer.scene.requestRender()
}
