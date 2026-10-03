import * as Cesium from 'cesium'
import type { ViewerHandle } from './types'
import { OpenFreeMapImageryProvider } from './OpenFreeMapImageryProvider'

export function createDefaultImageryProvider() {
  return new OpenFreeMapImageryProvider()
}

export function createFallbackImageryProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    // Cartographer's dark neutral adapter. The legacy CARTO endpoint now returns
    // API-key watermarks; this public Esri service supplies actual map imagery.
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    credit: esriCredit(),
    maximumLevel: 16,
  })
}

function esriCredit() {
  return new Cesium.Credit('<a href="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer" target="_blank" rel="noopener noreferrer">Esri</a>, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>, and the GIS user community', true)
}

export function createReferenceImageryProvider() {
  return new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    credit: esriCredit(),
    maximumLevel: 16,
  })
}

export function setBaseLayer(handle: ViewerHandle, provider: Cesium.ImageryProvider) {
  handle.viewer.imageryLayers.removeAll()
  return handle.viewer.imageryLayers.addImageryProvider(provider)
}
