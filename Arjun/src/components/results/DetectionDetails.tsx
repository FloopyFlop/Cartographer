import { useEffect, useState } from 'react'
import { X, MapPin, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { FeatureIcon } from './FeatureIcon'
import type { Detection } from '@/types'

function imageBoundingBox(value: unknown) {
  const coordinates = Array.isArray(value) ? value : value && typeof value === 'object'
    ? [Reflect.get(value, 'x'), Reflect.get(value, 'y'), Reflect.get(value, 'width'), Reflect.get(value, 'height')]
    : []
  if (coordinates.length !== 4 || !coordinates.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) return undefined
  const [x, y, width, height] = coordinates as number[]
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) return undefined
  return { x, y, width, height }
}

export function DetectionDetails({ detection, onClose, onFocus, compact = false }: { detection: Detection; onClose: () => void; onFocus: () => void; compact?: boolean }) {
  const demo = detection.source.provider === 'demo'
  const [imageFailed, setImageFailed] = useState(false)
  useEffect(() => { setImageFailed(false) }, [detection.id, detection.source.imageUrl])
  const boundingBox = imageBoundingBox(detection.metadata?.imageBoundingBox)
  const evidence = typeof detection.metadata?.visualEvidence === 'string' ? detection.metadata.visualEvidence.trim() : ''
  const capturedAt = detection.metadata?.capturedAt
  const imageDate = typeof capturedAt === 'string' && /^\d{4}-\d{2}(?:-|$|T)/.test(capturedAt)
    ? new Date(`${capturedAt.slice(0, 7)}-01T00:00:00Z`) : undefined
  const photographed = imageDate && Number.isFinite(imageDate.getTime())
    ? new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(imageDate) : undefined
  const attributes = Object.entries(detection.attributes).filter(([key]) => !['synthetic', 'demo', 'illustrative'].includes(key))
  const osmUrl = `https://www.openstreetmap.org/?mlat=${detection.position.latitude}&mlon=${detection.position.longitude}#map=19/${detection.position.latitude}/${detection.position.longitude}`
  return <Card className={compact ? 'detection-card compact' : 'detection-card'}>
    <CardHeader className="detection-header"><div className="detection-heading"><FeatureIcon type={detection.featureType} size={20}/><div><p className="feature-label">{detection.featureType.replaceAll('_', ' ')}</p><CardTitle>{detection.title}</CardTitle></div></div><Button variant="ghost" size="icon" aria-label="Close detection details" onClick={onClose}><X size={17}/></Button></CardHeader>
    <CardContent className="detection-content">
      {!demo && <p className="mb-3 text-sm font-medium text-foreground">{detection.verification === 'confirmed' ? 'Confirmed visual match' : detection.verification === 'rejected' ? 'Rejected visual match' : 'Unverified visual match'}</p>}
      {detection.source.imageUrl && !imageFailed && <a href={detection.source.referenceUrl || detection.source.imageUrl} target="_blank" rel="noreferrer" className="source-photo" style={{ position: 'relative' }}>
        <img key={`${detection.id}:${detection.source.imageUrl}`} src={detection.source.imageUrl} alt={`Street-level source for ${detection.title}`} style={{ height: 'auto', maxHeight: 'none' }} onError={() => setImageFailed(true)}/>
        {boundingBox && <span role="img" aria-label="Reported object area" className="pointer-events-none absolute border-2 border-foreground outline outline-1 outline-background" style={{ left: `${boundingBox.x * 100}%`, top: `${boundingBox.y * 100}%`, width: `${boundingBox.width * 100}%`, height: `${boundingBox.height * 100}%` }}/>} 
      </a>}
      {imageFailed && <p className="mb-3 text-sm text-muted-foreground">Source image unavailable. You can still open the source imagery below.</p>}
      {evidence && <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{evidence}</p>}
      {!evidence && detection.description && <p>{detection.description}</p>}
      {!demo && <p className="location-accuracy">The marker shows the camera location. The object is nearby; its exact position has not been established.</p>}
      {!!attributes.length && <dl className="attribute-list">{attributes.map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2')}</dt><dd>{typeof value === 'boolean' ? value ? 'Yes' : 'No' : value}</dd></div>)}</dl>}
      <div className="source-note"><strong>{demo ? 'Demonstration data' : 'Source'}</strong><p>{demo ? 'An illustrative sample, not verified infrastructure. Street-level imagery has not been analyzed.' : detection.source.attribution}</p>{!demo && photographed && <p>Photographed {photographed}</p>}</div>
      {detection.source.license && <a href={detection.source.license.url} target="_blank" rel="noreferrer" className="imagery-license">{detection.source.license.name}</a>}
      {(detection.source.referenceUrl || detection.source.imageUrl) && <a href={detection.source.referenceUrl || detection.source.imageUrl} target="_blank" rel="noreferrer" className="source-image-link">View source imagery <ExternalLink size={13}/></a>}
      <div className="detail-actions"><Button variant="outline" onClick={onFocus}><MapPin size={14}/>Locate on map</Button><Button asChild variant="ghost" size="icon"><a href={osmUrl} target="_blank" rel="noreferrer" aria-label="Open location in OpenStreetMap"><ExternalLink size={16}/></a></Button></div>
    </CardContent>
  </Card>
}
