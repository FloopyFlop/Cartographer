"""Provider boundary: replace DemoProvider when imagery and vision are ready.

The finite, hand-authored fixture is intentionally synthetic. No street images
were retrieved, no model ran, and none of these positions are verified objects.
"""

import re
from dataclasses import dataclass

from .geography import contains


@dataclass(frozen=True)
class Interpretation:
    feature_type: str
    title: str
    description: str
    covered_only: bool = False

    def as_dict(self) -> dict:
        return {"featureType": self.feature_type, "description": self.description}


FEATURES = [
    ("bicycle_rack", "Bicycle rack", r"\b(?:bicycl(?:e|es)|bik(?:e|es)|cycle)\b.*\b(?:racks?|parking|stands?|storage)\b|\bbike\s+racks?\b"),
    ("bench", "Bench", r"\bbench(?:es)?\b|\bseating\b"),
    ("drinking_fountain", "Drinking fountain", r"\b(?:drinking|water)\s+fountains?\b|\bwater\s+(?:bottle\s+)?(?:refill|filling)\s+stations?\b"),
    ("curb_ramp", "Curb ramp", r"\b(?:curb|kerb)\s+(?:ramps?|cuts?)\b|\bwheelchair(?:[- ]accessible)?\s+ramps?\b"),
    ("crosswalk", "Crosswalk", r"\bcrosswalks?\b|\b(?:pedestrian|zebra)\s+crossings?\b"),
    ("accessible_entrance", "Accessible entrance", r"\b(?:accessible|step[- ]free|wheelchair(?:[- ]accessible)?)\s+entrances?\b"),
]


def interpret_query(query: str) -> Interpretation:
    for feature_type, title, pattern in FEATURES:
        if re.search(pattern, query, re.IGNORECASE):
            covered = feature_type == "bicycle_rack" and bool(re.search(r"\b(?:covered|sheltered)\b", query, re.IGNORECASE))
            description = f"{'Covered bicycle parking' if covered else title + 's'} within the selected area, using illustrative Cornell sample data."
            return Interpretation(feature_type, title, description, covered)
    return Interpretation("custom", query, "No demonstration layer is available for this request. Connect an imagery and vision provider for arbitrary objects.")


# Synthetic examples, grouped around the Cornell campus for a navigable first use.
# These positions must never be represented as surveyed or model-detected assets.
POINTS = {
    "bicycle_rack": [
        (-76.48545, 42.44760), (-76.48420, 42.44831), (-76.48370, 42.44911),
        (-76.48256, 42.44862), (-76.48095, 42.44838), (-76.48213, 42.44765),
        (-76.48581, 42.44624), (-76.48305, 42.44548), (-76.48070, 42.44706),
        (-76.47884, 42.44920), (-76.47763, 42.44850), (-76.48156, 42.45041),
    ],
    "bench": [
        (-76.48510, 42.44813), (-76.48478, 42.44876), (-76.48369, 42.44808),
        (-76.48405, 42.44965), (-76.48272, 42.44878), (-76.48220, 42.44656),
        (-76.48024, 42.44775), (-76.47995, 42.44887), (-76.48517, 42.44669),
        (-76.48314, 42.45016), (-76.48119, 42.44975), (-76.48602, 42.44771),
        (-76.47792, 42.44874), (-76.47882, 42.44698),
    ],
    "drinking_fountain": [
        (-76.48504, 42.44772), (-76.48355, 42.44857), (-76.48261, 42.44742),
        (-76.48021, 42.44838), (-76.48106, 42.45005), (-76.48462, 42.44596),
    ],
    "curb_ramp": [
        (-76.48557, 42.44605), (-76.48303, 42.44723), (-76.48190, 42.44833),
        (-76.48054, 42.44709), (-76.47909, 42.44803), (-76.48394, 42.45038),
        (-76.48282, 42.44586), (-76.47781, 42.44913),
    ],
    "crosswalk": [
        (-76.48564, 42.44617), (-76.48302, 42.44735), (-76.48186, 42.44843),
        (-76.48052, 42.44717), (-76.47903, 42.44814), (-76.48387, 42.45046),
        (-76.48280, 42.44598), (-76.47781, 42.44850),
    ],
    "accessible_entrance": [
        (-76.48531, 42.44737), (-76.48410, 42.44840), (-76.48299, 42.44929),
        (-76.48195, 42.44790), (-76.48086, 42.44822), (-76.47892, 42.44901),
        (-76.48423, 42.44626),
    ],
}


class DemoProvider:
    name = "demo"

    def search(self, interpretation: Interpretation, area: dict) -> list[dict]:
        samples = []
        for index, (longitude, latitude) in enumerate(POINTS.get(interpretation.feature_type, [])):
            point = {"longitude": longitude, "latitude": latitude}
            covered = interpretation.feature_type == "bicycle_rack" and index % 3 == 0
            if not contains(area, point) or (interpretation.covered_only and not covered):
                continue
            attributes: dict = {"illustrative": True}
            if interpretation.feature_type == "bicycle_rack":
                attributes.update({"covered": covered, "capacity": 4 + index % 4 * 2})
            samples.append({
                "fixtureId": f"{interpretation.feature_type}-{index + 1}",
                "position": point,
                "featureType": interpretation.feature_type,
                "title": "Covered bicycle parking" if interpretation.covered_only else interpretation.title,
                "description": "Illustrative sample location. No street imagery was analyzed and this object has not been verified.",
                "confidence": 0.78 + (index % 5) * 0.035,
                "attributes": attributes,
                "source": {"provider": "demo", "attribution": "Synthetic Cartographer demonstration data; not verified infrastructure."},
                "model": {"name": "synthetic-fixture", "version": "1.0"},
                "verification": "unverified",
                "metadata": {"confidenceIsIllustrative": True},
            })
        return samples
