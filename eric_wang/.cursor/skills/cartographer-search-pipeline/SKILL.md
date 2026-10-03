---
name: cartographer-search-pipeline
description: >-
  Implements or debugs Cartographer live search jobs end-to-end: geographic
  sampling, Street View Static imagery, Gemini vision detection, progressive
  job store updates, and Flask POST/GET /api/searches. Use when working on
  search jobs, the detection pipeline, polling, progress, or live search API.
---

# Cartographer Search Pipeline

## When to use

Extending, fixing, or implementing the live search path in `eric_wang/backend`.

## Flow

1. `POST /api/searches` accepts `{ query, area }` and creates a job (`queued`).
2. Background runner samples points in the area (`geo/sampling`).
3. For each point: fetch Street View Static image(s); skip if unavailable.
4. Send image + query to Gemini; parse structured JSON detections.
5. Attach lat/lon (and imagery metadata); append to job; update `progress`.
6. Frontend polls `GET /api/searches/:id` until `completed` or `failed`.

## Rules

- Keys stay in backend `.env` only (`GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY`).
- Cap sample count; prefer progressive appends over one bulk response.
- On missing keys: fail the job with a clear configuration error — do not invent detections.
- Keep the HTTP contract stable so the frontend API layer does not churn.

## References

See `eric_wang/PLANNING.md` sections 3 and 5.
