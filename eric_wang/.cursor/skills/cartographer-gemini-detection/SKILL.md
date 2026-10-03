---
name: cartographer-gemini-detection
description: >-
  Configures and improves Gemini multimodal object detection on Google Street
  View images for Cartographer. Use when changing detection prompts, response
  JSON schema, confidence thresholds, Street View headings/sampling density,
  GEMINI_MODEL, or imagery metadata on detections.
---

# Cartographer Gemini Detection

## When to use

Changes to `detection/gemini.py`, `imagery/street_view.py`, sampling density, or detection payload shape.

## Expectations

- Model default: `gemini-2.0-flash` via `GEMINI_MODEL`.
- Prompt must request structured JSON: present/absent, labels, confidence, short attributes.
- Emit detections only for positive findings with usable confidence.
- Attach `sourceImagery` (location, heading, ref) and `model` on each detection.
- Multiple headings per sample point are allowed when it improves recall without blowing cost.

## Do not

- Call Gemini from the browser.
- Log raw API keys.
- Fabricate detections when the API fails — surface the error on the job.

## References

See `eric_wang/PLANNING.md` section 5; rule `cartographer-backend`.
