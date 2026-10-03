---
name: cartographer-map-ui
description: >-
  Builds Cartographer map-first UI with React, shadcn/ui, and CesiumJS.
  Covers search overlays, viewport/radius/region tools, detection markers,
  selection sheets, layers, and Titanium stub integration. Use when editing
  frontend map UX, Cesium code, or search interaction states.
---

# Cartographer Map UI

## When to use

Frontend work under `eric_wang/frontend` involving the map, search chrome, or detection display.

## Principles

- Map is the workspace; overlays stay sparse and task-focused.
- Black / white / gray only; typography and spacing carry hierarchy.
- shadcn/ui for all conventional controls; no second component library.
- Isolate Cesium in `src/cesium/`; use Titanium only via the adapter stub.
- Talk to Flask only through `src/api/` — never `fetch` from UI components.

## Interaction states to respect

Initial → locate/area → enter query → searching → progressive results → complete / empty / error → select detection → revise query or area → another search (preserve camera context).

## References

See `eric_wang/PLANNING.md` sections 6 and 10; rule `cartographer-frontend`.
