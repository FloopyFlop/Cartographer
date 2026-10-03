import * as Cesium from 'cesium'
import { createDefaultImageryProvider, createFallbackImageryProvider, createReferenceImageryProvider, setBaseLayer } from './imagery'
import type { ViewerHandle } from './types'

type BaseLayerStyle = {
  brightness: number
  contrast: number
  saturation: number
  gamma: number
  hue: number
}

// Cartographer's neutral map adapter. The supplied Titanium renderer and shaders
// remain the rendering implementation; these settings only change its palette.
const CARTOGRAPHER_DARK_STYLE: BaseLayerStyle = {
  brightness: 1.04,
  contrast: 1.05,
  saturation: 0,
  gamma: 1,
  hue: 0,
}

const FALLBACK_STYLE: BaseLayerStyle = {
  brightness: 1,
  contrast: 0.95,
  saturation: 0,
  gamma: 1,
  hue: 0,
}

function applyBaseLayerStyle(layer: Cesium.ImageryLayer, style: BaseLayerStyle) {
  layer.brightness = style.brightness
  layer.contrast = style.contrast
  layer.saturation = style.saturation
  layer.gamma = style.gamma
  layer.hue = style.hue
}

export function initializeViewer(container: HTMLElement): ViewerHandle {
  const imageryProvider = createDefaultImageryProvider()
  const baseLayer = new Cesium.ImageryLayer(imageryProvider, {
    show: true,
  })
  applyBaseLayerStyle(baseLayer, CARTOGRAPHER_DARK_STYLE)

  const viewer = new Cesium.Viewer(container, {
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    infoBox: false,
    selectionIndicator: false,
    sceneMode: Cesium.SceneMode.SCENE2D,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    skyBox: false,
    skyAtmosphere: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    showRenderLoopErrors: false,
    baseLayer,
  })

  viewer.scene.postProcessStages.fxaa.enabled = true
  const referenceLayer = viewer.imageryLayers.addImageryProvider(createReferenceImageryProvider())
  referenceLayer.saturation = 0
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#242424')
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#181818')
  viewer.scene.globe.enableLighting = false
  viewer.useBrowserRecommendedResolution = false
  viewer.resolutionScale = Math.min(1.5, Math.max(1, window.devicePixelRatio))
  viewer.scene.globe.maximumScreenSpaceError = 0.9
  // Cesium applies MSAA only on supported WebGL2 contexts. Use its public API.
  viewer.scene.msaaSamples = 4

  const handle: ViewerHandle = {
    viewer,
    entities: {},
    stages: {
      stylize: null,
    },
    config: {
      clock: {},
      timeline: {
        markers: new Cesium.TimeIntervalCollection(),
      },
    },
  }

  let fallbackApplied = false
  imageryProvider.errorEvent.addEventListener((error) => {
    if (fallbackApplied) {
      return
    }
    fallbackApplied = true
    console.warn('[Titanium] Base layer failed, using the neutral fallback map.', error)
    const fallbackLayer = setBaseLayer(handle, createFallbackImageryProvider())
    applyBaseLayerStyle(fallbackLayer, FALLBACK_STYLE)
  })

  return handle
}

export function destroyViewer(handle: ViewerHandle) {
  if (!handle.viewer.isDestroyed()) {
    handle.viewer.destroy()
  }
}
