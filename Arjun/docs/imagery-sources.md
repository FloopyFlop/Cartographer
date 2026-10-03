# Street-level imagery sources

Cartographer's current local prototype defaults to **Google Street View**, as requested by its user, with OpenAI visual analysis. **Panoramax remains an optional implemented alternative**: it has real Cornell coverage, needs no new access token for public reads, and exposes item licenses and image assets through a geographic API. KartaView and Mapillary were investigated but are not implemented providers. Search coverage is sampled: a result does not establish that every object in the area has been found.

## Current prototype behavior

Set `GOOGLE_MAPS_API_KEY`, `OPENAI_API_KEY`, and `CARTOGRAPHER_IMAGERY_PROVIDER=google` in the backend's private `.env`. The default is four photographs per run, with fixed local spending ceilings of **$4 Google** and **$2 OpenAI**. These ceilings apply to this application's requests, not all use of the provider accounts. MongoDB persistently caches job snapshots, completed searches, per-image analyses, panorama identifiers, source references, and spending reservations. An identical completed search reuses its results without another imagery or model call.

Google image pixels are held only in server memory for up to **10 minutes**, bounded to 32 images and 16 MiB total, with a 5 MiB per-image maximum. They are not stored on disk or in MongoDB. `GET /api/imagery/google-<opaque-id>` serves only already-fetched bytes with `Cache-Control: no-store`; it makes no external request. Expiry, buffer eviction, or a server restart makes the preview unavailable. The endpoint then returns HTTP 410 with `error.code = "imagery_expired"`. Cached jobs retain their original preview reference and analysis, along with a key-free Google Maps viewer link that remains usable when the local preview has expired.

This describes the prototype's behavior, not a claim that temporary imagery or persistent analysis is authorized under Google's standard terms. User authorization to build a local prototype is not a legal exemption. There is no software flag asserting that additional Google reuse rights have been obtained. The relevant restrictions are described [below](#google-street-view-and-separately-licensed-imagery).

To choose the open source, set `CARTOGRAPHER_IMAGERY_PROVIDER=panoramax` and provide the OpenAI key. Panoramax requires no Google key or new imagery token; its photographs can be stored under their individual licenses. Preserve MongoDB's local data directory and, when using licensed image files, `backend/.cache/images` when moving the project. This retains analysis caches, attribution, and the spending ledger.

## Coverage checked on October 3, 2026

The test bounding box was west **-76.49**, south **42.44**, east **-76.47**, north **42.46**, covering part of Cornell University and its surroundings. Only bounded metadata requests and a few image-header checks were made. These counts are **lower bounds**, not complete inventory counts.

| Source | Verified public response | Capture dates in the sample | Access |
| --- | --- | --- | --- |
| Panoramax federation | 100 photos inside the box, from 3 collections | October 31, 2025 | Public reads succeeded without a token |
| KartaView | 150 photos inside the box, with `hasMoreData: true` | Latest first-page sample: July 20, 2018 | Public reads succeeded without a token |
| Mapillary | Geographic request rejected with OAuth error 190 | Not verified | An access token is required |

These observations establish that imagery exists, not that individual benches, ramps, entrances, or other objects have been surveyed or verified. Old imagery can describe infrastructure that has since changed. Camera coordinates locate the photograph; an object's position requires additional estimation and should retain that uncertainty.

## Panoramax

This is an optional alternative to the active Google prototype source.

Verified geographic discovery endpoint:

```text
https://explore.panoramax.fr/api/search?bbox=-76.49,42.44,-76.47,42.46&limit=10
```

The response has `features[]`, each containing `id`, `collection`, `geometry.coordinates` in longitude/latitude order, `properties.datetime`, `properties.license`, `providers`, and `assets.sd.href`, `assets.thumb.href`, and `assets.hd.href`. Its `links` include the item's license and source instance. A sample item's azimuth exceeded 360 degrees, so normalize headings modulo 360.

The federation also documents `api.panoramax.xyz`; that hostname failed a transport check in this environment while `explore.panoramax.fr` responded successfully. The tested federation response did not expose a total count or pagination link, and a `fields` parameter did not reduce its metadata. Keep discovery limits small and select spatially separated photographs rather than analyzing adjacent frames repeatedly. [Panoramax API introduction](https://docs.panoramax.fr/backend/api/api/), [federation documentation](https://docs.panoramax.fr/federated-catalog/).

Sample image assets returned HTTP 200:

- [Source item metadata](https://panoramax.openstreetmap.fr/api/collections/d548aaff-3f7b-4839-b136-545c55b24c93/items/a8513a4a-a223-45cb-8798-b388a472bad0)
- [Standard definition image](https://panoramax.openstreetmap.fr/derivates/a8/51/3a/4a/a223-45cb-8798-b388a472bad0/sd.jpg)
- [Thumbnail](https://panoramax.openstreetmap.fr/derivates/a8/51/3a/4a/a223-45cb-8798-b388a472bad0/thumb.jpg)

The sampled producer was **slinky309**, the source instance was **OpenStreetMap France**, and the item license was **CC BY-SA 4.0**. Store source attribution and license links with every detection and cached image. Reproducing and adapting licensed imagery is permitted under the license; sharing requires creator attribution, the source and license links, and an indication of modifications. Shared adapted imagery must satisfy ShareAlike. [CC BY-SA 4.0 legal terms, sections 2–4](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en).

Panoramax's federation policy explicitly supports nonphotographic derived open data, including AI models, under LO 2.0, CC BY 4.0, or ODbL 1.0 for its accepted CC BY-SA arrangement. This supports an openly licensed detection dataset; attribution alone is not a basis for making derived data proprietary. Preserve each item's actual license rather than assigning one blanket license to every instance. [Federation licensing policy](https://docs.panoramax.fr/federated-catalog/).

## KartaView

Verified geographic discovery endpoint:

```text
https://api.openstreetcam.org/2.0/photo/?nwLat=42.46&nwLng=-76.49&seLat=42.44&seLng=-76.47&page=1&itemsPerPage=150&orderBy=id&orderDirection=desc
```

The response uses `result.data[]` and `result.hasMoreData`. Useful fields include `id`, string-valued `lat` and `lng`, `heading`, `shotDate`, `sequenceId`, `fileurlProc`, and thumbnail URLs. Convert coordinates to numbers and use processed, anonymized images. Public discovery required no token. [Photo API documentation](https://kartaview.org/doc/photos), [authentication FAQ](https://kartaview.org/doc/faq).

KartaView is free to use and licenses its street imagery and 3D spatial data under CC BY-SA 4.0. It permits copying and adapting subject to the license and requires the credit **© Grab and KartaView Contributors**. The older Cornell sample makes it a useful secondary source, with capture time retained beside results. [KartaView terms, sections 2 and 4](https://kartaview.org/terms).

## Mapillary

An unauthenticated request to `https://graph.mapillary.com/images?bbox=-76.49,42.44,-76.47,42.46&fields=id,geometry&limit=1` returned an invalid OAuth access-token error. No Cornell coverage count was inferred from that failed request. Mapillary's official API demo also requires a token. [Mapillary API demo](https://mapillary.github.io/api-demo/).

Mapillary says its platform is free and its images are shared under CC BY-SA, with attribution linking the image and creator. Its built-in object detections are accessible through its API. Those permissions should be distinguished from credentials and any additional API-specific terms; an imagery license does not make unauthenticated API access available. [Mapillary FAQ](https://help.mapillary.com/hc/en-us/articles/8348198426396-Mapillary-FAQ), [imagery licensing](https://help.mapillary.com/hc/en-us/articles/115001770409-CC-BY-SA-license-for-open-data), [object detections](https://help.mapillary.com/hc/en-us/articles/115000967191-Object-detections).

## Google Street View and separately licensed imagery

Google's standard Maps Platform terms restrict extracting, indexing, rehosting, and caching Maps content. Section 3.2.3(c) gives deriving a tree-location index from Street View as a prohibited example. The same section restricts creating content from Maps content, and section 3.2.3(e) restricts displaying Street View imagery and non-Google maps on the same screen. These standard terms do not authorize Cartographer's persistent object index or general Cesium imagery workflow. Keeping image pixels temporary does not, by itself, resolve the restrictions on derived data or non-Google map display. [Google Maps Platform terms, section 3.2.3](https://cloud.google.com/maps-platform/terms).

The current Google default records a product choice for a local prototype, not evidence of Google's permission. Education or accessibility goals and user authorization do not automatically establish an exception or grant those reuse rights. Any negotiated permission or applicable legal exception must be established separately. Google's reseller exemptions concern entering a direct contract, not a blanket right to extract Street View data. [Google reseller contract exemptions](https://cloud.google.com/terms/direct-tos-exemptions).

A third-party scraper does not remove the source's reuse restrictions. A photographer can instead grant separate rights to their own original photographs when they own the necessary rights: obtain those files directly under that license, with documented attribution and permitted analysis, storage, and redistribution. This is separate from downloading the photographer's images through Google services. Cartographer's owned-imagery boundary can accommodate such a collection.
