const base = 'http://127.0.0.1:5050'
const usage = async () => (await fetch(`${base}/api/usage`)).json()
const before = await usage()
const payload = { query: process.env.CARTOGRAPHER_SMOKE_QUERY || 'Bicycle racks', mode: 'live', configuration: { maxImages: Number(process.env.CARTOGRAPHER_SMOKE_MAX_IMAGES || 16) }, area: { kind: 'radius', center: { longitude: Number(process.env.CARTOGRAPHER_SMOKE_LONGITUDE || -76.48293788666092), latitude: Number(process.env.CARTOGRAPHER_SMOKE_LATITUDE || 42.44515275699593) }, radiusMeters: Number(process.env.CARTOGRAPHER_SMOKE_RADIUS || 150), label: 'Near Duffield Hall' } }
let response = await fetch(`${base}/api/searches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
let job = await response.json()
if (!response.ok) throw new Error(JSON.stringify(job))
console.log('Created live search', { id: job.id, mode: job.mode, status: job.status })
for (let i=0; i<160 && ['queued','running'].includes(job.status); i++) {
  await new Promise(resolve => setTimeout(resolve, 750))
  response = await fetch(`${base}/api/searches/${job.id}`); job = await response.json()
  if (i % 8 === 0) console.log({ status: job.status, progress: job.progress, detections: job.detections?.length })
}
const after = await usage()
console.log('Completed live smoke', { id: job.id, status: job.status, detections: job.detections?.length, analyzedImages: job.frames?.length, cameras: new Set(job.frames?.map(frame => JSON.stringify(frame.position))).size, stage: job.progress?.stage, error: job.error, google: after.google, openai: after.openai })
if (job.status !== 'completed') process.exitCode = 1
else {
  const repeat = await (await fetch(`${base}/api/searches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json()
  const cachedUsage = await usage()
  console.log('Cache verified', { cacheHit: repeat.cacheHit, status: repeat.status, sameId: repeat.id === job.id, unchangedGoogle: JSON.stringify(after.google) === JSON.stringify(cachedUsage.google), unchangedOpenAI: JSON.stringify(after.openai) === JSON.stringify(cachedUsage.openai), incrementalCost: Number((after.openai.usedUsd - before.openai.usedUsd).toFixed(6)) })
  if (!repeat.cacheHit || JSON.stringify(after) !== JSON.stringify(cachedUsage)) process.exitCode = 1
}
