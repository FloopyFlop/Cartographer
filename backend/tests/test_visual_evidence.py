import math

import pytest

from cartographer.live import validate_vision_output


def candidate(**changes):
    return {
        "title": "Bench", "description": "Wooden seating", "featureType": "bench", "confidence": 0.9,
        "attributes": {"material": "wood", "covered": None, "accessible": True, "notes": None},
        "visualEvidence": "Horizontal seat boards with a backrest and two visible supporting legs.",
        "imageBoundingBox": {"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4},
        **changes,
    }


def test_evidence_is_preserved_but_accessibility_is_not_certified():
    detection = validate_vision_output({"detections": [candidate()]})[0]
    assert detection["metadata"]["visualEvidence"].startswith("Horizontal seat")
    assert detection["metadata"]["imageBoundingBox"] == candidate()["imageBoundingBox"]
    assert detection["attributes"] == {"material": "wood"}


@pytest.mark.parametrize("box", [
    {"x": 0.9, "y": 0.1, "width": 0.2, "height": 0.2},
    {"x": 0.1, "y": 0.1, "width": 0, "height": 0.2},
    {"x": math.nan, "y": 0.1, "width": 0.2, "height": 0.2},
    {"x": True, "y": 0.1, "width": 0.2, "height": 0.2},
    {"x": 0.1, "y": 0.1, "width": 0.2},
])
def test_invalid_visual_localization_is_rejected(box):
    with pytest.raises(ValueError, match="bounding box"):
        validate_vision_output({"detections": [candidate(imageBoundingBox=box)]})


def test_uncertain_matches_are_omitted_and_empty_results_are_valid():
    assert validate_vision_output({"detections": [candidate(confidence=0.79)]}) == []
    assert validate_vision_output({"detections": []}) == []
    with pytest.raises(ValueError, match="evidence"):
        validate_vision_output({"detections": [candidate(visualEvidence=" ")]})
