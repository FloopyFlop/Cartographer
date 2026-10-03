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
  brightness: 1.25,
  contrast: 1,
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
  // No ion imagery or terrain is used. Keep the actual providers' credits in
  // Cesium's live credit display, without its unrelated default ion branding.
  Cesium.CreditDisplay.cesiumCredit = new Cesium.Credit('', true)
  const attribution = document.createElement('div')
  attribution.className = 'map-attribution'
  attribution.setAttribute('aria-label', 'Map data attribution')
  const attributionLabel = document.createElement('span')
  attributionLabel.className = 'map-attribution-label'
  attributionLabel.textContent = 'Map data from '
  const creditContainer = document.createElement('div')
  creditContainer.className = 'map-attribution-sources'
  attribution.append(attributionLabel, creditContainer)
  container.append(attribution)

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
    sceneMode: Cesium.SceneMode.SCENE3D,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    skyBox: false,
    skyAtmosphere: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
    showRenderLoopErrors: false,
    creditContainer,
    creditViewport: container,
    baseLayer,
  })

  viewer.scene.postProcessStages.fxaa.enabled = true
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#101114')
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#090a0c')
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

  const providers: Cesium.ImageryProvider[] = [imageryProvider]
  const disposeProvider = (provider: Cesium.ImageryProvider) => {
    const disposable = provider as Cesium.ImageryProvider & { destroy?: () => void; isDestroyed?: () => boolean }
    if (!disposable.isDestroyed?.()) disposable.destroy?.()
  }
  let fallbackApplied = false
  const removeErrorListener = imageryProvider.errorEvent.addEventListener((error) => {
    if (fallbackApplied) {
      return
    }
    fallbackApplied = true
    console.warn('[Titanium] Base layer failed, using the neutral fallback map.', error)
    const fallback = createFallbackImageryProvider()
    providers.push(fallback)
    const fallbackLayer = setBaseLayer(handle, fallback)
    const reference = createReferenceImageryProvider()
    providers.push(reference)
    viewer.imageryLayers.addImageryProvider(reference).saturation = 0
    disposeProvider(imageryProvider)
    applyBaseLayerStyle(fallbackLayer, FALLBACK_STYLE)
  })
  handle.dispose = () => {
    removeErrorListener()
    providers.forEach(disposeProvider)
    attribution.remove()
  }

  return handle
}

export function destroyViewer(handle: ViewerHandle) {
  if (!handle.viewer.isDestroyed()) {
    const container = handle.viewer.container
    handle.viewer.destroy()
    handle.dispose?.()
    container.querySelector('.map-attribution')?.remove()
  }
}
