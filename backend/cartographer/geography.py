"""Validated geographic search areas and independent spatial filtering.

Coordinates are WGS84 decimal degrees; distances are meters. These routines
filter sample results, not geolocate image detections. A vision provider must
supply its own location-estimation pipeline.
"""

import math

from .errors import ApiError


EARTH_RADIUS = 6_371_008.8
MAX_AREA_KM2 = 10_000


def _invalid(message: str, field: str) -> None:
    raise ApiError("invalid_search_area", message, field=field)


def number(value: object, field: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _invalid(f"{field} must be a number.", field)
    try:
        value = float(value)
    except (OverflowError, ValueError):
        _invalid(f"{field} must be a finite number.", field)
    if not math.isfinite(value) or not minimum <= value <= maximum:
        _invalid(f"{field} must be between {minimum:g} and {maximum:g}.", field)
    return float(value)


def position(value: object, field: str = "area.center") -> dict:
    if not isinstance(value, dict):
        _invalid(f"{field} must contain longitude and latitude.", field)
    return {
        "longitude": number(value.get("longitude"), f"{field}.longitude", -180, 180),
        "latitude": number(value.get("latitude"), f"{field}.latitude", -90, 90),
    }


def longitude_delta(longitude: float) -> float:
    return (longitude + 180) % 360 - 180


def haversine(a: dict, b: dict) -> float:
    lat_a, lat_b = math.radians(a["latitude"]), math.radians(b["latitude"])
    dlat = lat_b - lat_a
    dlon = math.radians(longitude_delta(b["longitude"] - a["longitude"]))
    chord = math.sin(dlat / 2) ** 2 + math.cos(lat_a) * math.cos(lat_b) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS * 2 * math.asin(math.sqrt(min(1, max(0, chord))))


def validate_area(value: object) -> dict:
    if not isinstance(value, dict):
        _invalid("Choose a geographic search area.", "area")
    kind = value.get("kind")
    if not isinstance(kind, str):
        _invalid("Choose a radius, viewport, region, or route search area.", "area.kind")
    area = {"kind": kind}
    if "label" in value:
        label = value["label"]
        if not isinstance(label, str) or len(label) > 150:
            _invalid("The area label must be text of at most 150 characters.", "area.label")
        if label.strip():
            area["label"] = label.strip()
    if kind == "radius":
        area["center"] = position(value.get("center"))
        area["radiusMeters"] = number(value.get("radiusMeters"), "area.radiusMeters", 25, 50_000)
    elif kind in {"viewport", "region"}:
        bounds = value.get("bounds")
        if not isinstance(bounds, dict):
            _invalid("The area must contain geographic bounds.", "area.bounds")
        west = number(bounds.get("west"), "area.bounds.west", -180, 180)
        east = number(bounds.get("east"), "area.bounds.east", -180, 180)
        south = number(bounds.get("south"), "area.bounds.south", -90, 90)
        north = number(bounds.get("north"), "area.bounds.north", -90, 90)
        if north <= south or west == east:
            _invalid("The selected area must have a positive width and height.", "area.bounds")
        width = (east - west) % 360
        if width == 0:
            _invalid("Zoom in or select a smaller area.", "area.bounds")
        spherical_area = EARTH_RADIUS**2 * math.radians(width) * (
            math.sin(math.radians(north)) - math.sin(math.radians(south))
        ) / 1_000_000
        if spherical_area > MAX_AREA_KM2:
            _invalid("Zoom in or select an area smaller than 10,000 km².", "area.bounds")
        area["bounds"] = {"west": west, "south": south, "east": east, "north": north}
    elif kind == "route":
        coordinates = value.get("coordinates")
        if not isinstance(coordinates, list) or not 2 <= len(coordinates) <= 500:
            _invalid("A route must have between 2 and 500 points.", "area.coordinates")
        points = [position(point, f"area.coordinates[{index}]") for index, point in enumerate(coordinates)]
        length = sum(haversine(a, b) for a, b in zip(points, points[1:]))
        if length < 1 or length > 100_000:
            _invalid("The route must be between 1 meter and 100 kilometers long.", "area.coordinates")
        area["coordinates"] = points
        area["corridorMeters"] = number(value.get("corridorMeters"), "area.corridorMeters", 5, 5_000)
    else:
        _invalid("Choose a radius, viewport, region, or route search area.", "area.kind")
    return area


def _segment_distance(point: dict, start: dict, end: dict) -> float:
    """Great-circle segment distance, including longitude-wrap support."""
    segment_length = haversine(start, end)
    if segment_length < 0.001:
        return haversine(point, start)

    def bearing(a: dict, b: dict) -> float:
        lat_a, lat_b = math.radians(a["latitude"]), math.radians(b["latitude"])
        dlon = math.radians(longitude_delta(b["longitude"] - a["longitude"]))
        return math.atan2(
            math.sin(dlon) * math.cos(lat_b),
            math.cos(lat_a) * math.sin(lat_b) - math.sin(lat_a) * math.cos(lat_b) * math.cos(dlon),
        )

    angular_distance = haversine(start, point) / EARTH_RADIUS
    angle = bearing(start, point) - bearing(start, end)
    along_track = math.atan2(math.sin(angular_distance) * math.cos(angle), math.cos(angular_distance))
    if along_track < 0:
        return haversine(point, start)
    if along_track * EARTH_RADIUS > segment_length:
        return haversine(point, end)
    return abs(math.asin(max(-1, min(1, math.sin(angular_distance) * math.sin(angle))))) * EARTH_RADIUS


def contains(area: dict, point: dict) -> bool:
    kind = area["kind"]
    if kind == "radius":
        return haversine(area["center"], point) <= area["radiusMeters"]
    if kind in {"viewport", "region"}:
        bounds = area["bounds"]
        if not bounds["south"] <= point["latitude"] <= bounds["north"]:
            return False
        if bounds["west"] <= bounds["east"]:
            return bounds["west"] <= point["longitude"] <= bounds["east"]
        return point["longitude"] >= bounds["west"] or point["longitude"] <= bounds["east"]
    return any(
        _segment_distance(point, start, end) <= area["corridorMeters"]
        for start, end in zip(area["coordinates"], area["coordinates"][1:])
    )
