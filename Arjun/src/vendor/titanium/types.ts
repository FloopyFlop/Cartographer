import type { Entity, JulianDate, PostProcessStage, TimeIntervalCollection, Viewer } from 'cesium'

export type ViewerHandle = {
  viewer: Viewer
  entities: {
    demoEntity?: Entity
  }
  stages: {
    stylize?: {
      edge: PostProcessStage
      toon: PostProcessStage
    } | null
  }
  config: {
    clock: {
      start?: JulianDate
      stop?: JulianDate
    }
    timeline: {
      markers: TimeIntervalCollection
    }
    stylization?: StylizationConfig
    enemyPalette?: EnemyPaletteKey
  }
}

export type ClockState = {
  totalSeconds: number
  currentSeconds: number
  isPlaying: boolean
  multiplier: number
}

export type ClockConfig = {
  start: JulianDate
  stop: JulianDate
  current?: JulianDate
  multiplier?: number
  shouldAnimate?: boolean
}

export type SceneMode = '3D' | '2D' | 'COLUMBUS'

export type EnemyPaletteKey = 'red' | 'orange'

export type StylizationConfig = {
  enabled: boolean
  edge: {
    enabled: boolean
    threshold: number
  }
  toon: {
    enabled: boolean
    intensity: number
  }
}
