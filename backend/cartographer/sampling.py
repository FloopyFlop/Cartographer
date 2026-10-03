"""Sparse, bounded camera samples inside the requested geographic area."""

import math

from .geography import EARTH_RADIUS, _segment_distance, contains, haversine, longitude_delta


MAX_VIEWPOINTS = 12
HEADINGS = (0, 90, 180, 270)
DEFAULT_IMAGES = 16
MAX_IMAGES = 48
MAX_CAMERA_OFFSET_METERS = 250
SAMPLING_VERSION = "surrounding-cameras-360-v4"


def _interpolate(a: dict, b: dict, fraction: float) -> dict:
    distance = haversine(a, b) / EARTH_RADIUS
    if distance < 1e-12:
        return dict(a)
    first = math.sin((1 - fraction) * distance) / math.sin(distance)
    second = math.sin(fraction * distance) / math.sin(distance)
    lat_a, lon_a = map(math.radians, (a["latitude"], a["longitude"]))
    lat_b, lon_b = map(math.radians, (b["latitude"], b["longitude"]))
    x = first * math.cos(lat_a) * math.cos(lon_a) + second * math.cos(lat_b) * math.cos(lon_b)
    y = first * math.cos(lat_a) * math.sin(lon_a) + second * math.cos(lat_b) * math.sin(lon_b)
    z = first * math.sin(lat_a) + second * math.sin(lat_b)
    return {"latitude": math.degrees(math.atan2(z, math.hypot(x, y))), "longitude": math.degrees(math.atan2(y, x))}


def _ring(center: dict, radius_meters: float, count: int) -> list[dict]:
    latitude = math.radians(center["latitude"])
    longitude = math.radians(center["longitude"])
    angular = radius_meters / EARTH_RADIUS
    samples = []
    for index in range(count):
        bearing = 2 * math.pi * index / count
        target_latitude = math.asin(math.sin(latitude) * math.cos(angular) + math.cos(latitude) * math.sin(angular) * math.cos(bearing))
        target_longitude = longitude + math.atan2(math.sin(bearing) * math.sin(angular) * math.cos(latitude), math.cos(angular) - math.sin(latitude) * math.sin(target_latitude))
        samples.append({"longitude": longitude_delta(math.degrees(target_longitude)), "latitude": math.degrees(target_latitude)})
    return samples


def sample_area(area: dict) -> list[dict]:
    if area["kind"] == "radius":
        center = area["center"]
        samples = [dict(center)] + _ring(center, area["radiusMeters"] * 0.55, MAX_VIEWPOINTS - 1)
    elif area["kind"] in {"region", "viewport"}:
        bounds = area["bounds"]
        width = (bounds["east"] - bounds["west"]) % 360
        samples = [
            {
                "longitude": longitude_delta(bounds["west"] + width * (column + 0.5) / 4),
                "latitude": bounds["south"] + (bounds["north"] - bounds["south"]) * (row + 0.5) / 3,
            }
            for row in range(3) for column in range(4)
        ]
    else:
        points = area["coordinates"]
        segments = [(a, b, haversine(a, b)) for a, b in zip(points, points[1:])]
        total = sum(segment[2] for segment in segments)
        samples = []
        for index in range(MAX_VIEWPOINTS):
            target = total * index / (MAX_VIEWPOINTS - 1)
            traversed = 0.0
            for start, end, length in segments:
                if traversed + length >= target and length > 0:
                    samples.append(_interpolate(start, end, (target - traversed) / length))
                    break
                traversed += length
    return [point for point in samples if contains(area, point)]


def sample_imagery_locations(area: dict) -> list[dict]:
    """Camera lookup positions; tiny landmark areas also inspect nearby roads.

These are observation locations, not inferred object positions or a change to
the user's selected search area. Source metadata records when a returned camera
is outside that area.
"""
    if area["kind"] == "radius":
        return [dict(area["center"])] + _ring(area["center"], max(90, area["radiusMeters"] * 0.55), MAX_VIEWPOINTS - 1)
    samples = sample_area(area)
    if area["kind"] in {"region", "viewport"}:
        bounds = area["bounds"]
        center = {"longitude": longitude_delta(bounds["west"] + ((bounds["east"] - bounds["west"]) % 360) / 2), "latitude": (bounds["south"] + bounds["north"]) / 2}
        if samples:
            samples.remove(min(samples, key=lambda point: haversine(center, point)))
        return [center] + samples
    return samples


def distance_from_area(area: dict, camera: dict) -> float:
    if contains(area, camera):
        return 0
    if area["kind"] == "radius":
        return max(0, haversine(area["center"], camera) - area["radiusMeters"])
    if area["kind"] == "route":
        return max(0, min(_segment_distance(camera, start, end) for start, end in zip(area["coordinates"], area["coordinates"][1:])) - area["corridorMeters"])
    bounds = area["bounds"]
    latitude = max(bounds["south"], min(bounds["north"], camera["latitude"]))
    if bounds["west"] <= bounds["east"]:
        longitude = max(bounds["west"], min(bounds["east"], camera["longitude"]))
        return haversine(camera, {"longitude": longitude, "latitude": latitude})
    return min(haversine(camera, {"longitude": longitude, "latitude": latitude}) for longitude in (bounds["west"], bounds["east"]))
