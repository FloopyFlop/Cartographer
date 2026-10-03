"""Sparse, bounded camera samples inside the requested geographic area."""

import math

from .geography import EARTH_RADIUS, contains, haversine, longitude_delta


MAX_VIEWPOINTS = 6
HEADINGS = (0, 180)
SAMPLING_VERSION = "sparse-six-v1"


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


def sample_area(area: dict) -> list[dict]:
    if area["kind"] == "radius":
        center = area["center"]
        samples = [dict(center)]
        lat_a = math.radians(center["latitude"])
        lon_a = math.radians(center["longitude"])
        angular = area["radiusMeters"] * 0.55 / EARTH_RADIUS
        for index in range(MAX_VIEWPOINTS - 1):
            bearing = 2 * math.pi * index / (MAX_VIEWPOINTS - 1)
            latitude = math.asin(math.sin(lat_a) * math.cos(angular) + math.cos(lat_a) * math.sin(angular) * math.cos(bearing))
            longitude = lon_a + math.atan2(math.sin(bearing) * math.sin(angular) * math.cos(lat_a), math.cos(angular) - math.sin(lat_a) * math.sin(latitude))
            samples.append({"longitude": longitude_delta(math.degrees(longitude)), "latitude": math.degrees(latitude)})
    elif area["kind"] in {"region", "viewport"}:
        bounds = area["bounds"]
        width = (bounds["east"] - bounds["west"]) % 360
        samples = [
            {
                "longitude": longitude_delta(bounds["west"] + width * (column + 0.5) / 2),
                "latitude": bounds["south"] + (bounds["north"] - bounds["south"]) * (row + 0.5) / 3,
            }
            for row in range(3) for column in range(2)
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
