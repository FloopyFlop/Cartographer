# Cartographer (eric_wang)

See [PLANNING.md](./PLANNING.md) for product, architecture, API, and implementation order.

## Status

Planning and agent guidance only. App scaffolding (React + Flask) comes next.

## Agent guidance

- Rules: `.cursor/rules/`
- Skills: `.cursor/skills/` (`cartographer-search-pipeline`, `cartographer-map-ui`, `cartographer-gemini-detection`)

## Required secrets (upcoming backend)

- `GEMINI_API_KEY`
- `GOOGLE_MAPS_API_KEY` (Street View Static API enabled)
- Optional: `GEMINI_MODEL` (default `gemini-2.0-flash`)
- Optional frontend: `VITE_CESIUM_ION_TOKEN`
