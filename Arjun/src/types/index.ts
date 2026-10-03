export interface Position { longitude: number; latitude: number }
export interface Bounds { west: number; south: number; east: number; north: number }
export type SearchArea =
  | { kind: 'radius'; center: Position; radiusMeters: number; label?: string }
  | { kind: 'viewport' | 'region'; bounds: Bounds; label?: string }
  | { kind: 'route'; coordinates: Position[]; corridorMeters: number; label?: string }
export type AreaTool = 'navigate' | 'radius' | 'region' | 'route'
export type ImageBoundingBox = [number, number, number, number] | { x: number; y: number; width: number; height: number }
export interface DetectionMetadata extends Record<string, unknown> {
  /** Image-relative coordinates from 0 to 1, measured from the top left. */
  imageBoundingBox?: ImageBoundingBox
  visualEvidence?: string
}
export interface Detection {
  id: string; position: Position; featureType: string; title: string; description?: string;
  confidence: number; searchId: string; attributes: Record<string, string | number | boolean>;
  source: { provider: string; attribution: string; imageUrl?: string; referenceUrl?: string; license?: { name: string; url: string } };
  detectedAt: string; model: { name: string; version: string };
  verification: 'unverified' | 'confirmed' | 'rejected'; metadata?: DetectionMetadata;
}
export type SearchStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
export interface SearchJob {
  id: string; query: string; status: SearchStatus;
  progress: { completed: number; total: number; stage: string };
  detections: Detection[]; area: SearchArea; createdAt: string; updatedAt: string;
  mode: 'demo' | 'live' | 'precomputed'; interpretation?: { featureType: string; description: string };
  error?: { code: string; message: string }; label?: string;
  cacheHit?: boolean;
}
export interface SearchRequest { query: string; area: SearchArea; mode: 'auto' | 'live' | 'precomputed' }
export interface SearchLayer { job: SearchJob; visible: boolean }
export interface Location { id?: string; label: string; position: Position; bounds?: Bounds; description?: string }
export const INITIAL_LOCATION: Location = { label: 'Cornell University', position: { longitude: -76.4831, latitude: 42.4474 }, description: 'Ithaca, New York' }
export const INITIAL_AREA: SearchArea = { kind: 'radius', center: INITIAL_LOCATION.position, radiusMeters: 1000, label: 'Cornell University' }
