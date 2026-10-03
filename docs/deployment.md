# Deploy Cartographer with Coolify

The Docker image builds React and Cesium with Node, then serves the built `dist` directory and Flask API through Waitress on port 5050. The API runs as a nonroot user and all Python installation, startup, and health checks use uv. The runtime image contains neither Node nor a Vite server.

This deployment provides one password-protected application instance. It is not an organization account system or a distributed worker deployment. Keep one application replica: active jobs, cancellation, and concurrent-request coordination currently run inside one process.

## Coolify setup

1. Add this Git repository as a Coolify application and select **Docker Compose** as the build pack. The application lives at the repository root: use base directory `/` and Compose location `/docker-compose.yaml`.
2. Add the runtime variables `OPENAI_API_KEY`, `GOOGLE_MAPS_API_KEY`, and a strong `CARTOGRAPHER_AUTH_PASSWORD`. Optionally set `CARTOGRAPHER_AUTH_USERNAME`; its default is `cartographer`. Enable Google Street View Static API and Geocoding API for the server's Google key. Keep keys private and configure provider-side restrictions for the deployed server.
3. Set a domain on the **cartographer** service, including its internal port, for example `https://cartographer.example.com:5050`. Coolify terminates HTTPS and sends traffic to port 5050; visitors use the ordinary HTTPS address. Give the MongoDB service no domain and no published ports.
4. Keep the Compose-managed `mongo-data` and `application-cache` volumes. Deploy the application. To carry over the existing prototype's caches and spending totals, restore the private backup described below before running any live searches. The MongoDB health check must succeed before the API starts; `/api/health` then checks database readiness without making paid provider requests.
5. Open the HTTPS domain, sign in with the configured username/password, and first verify navigation and **Sample data**. Real searches call the configured imagery and vision providers and consume the instance's remaining budget.

The Compose file forces `CARTOGRAPHER_AUTH_REQUIRED=true` and refuses configuration without the required credentials and password. Only the minimal health probe is public; the interface, assets, and other API routes require the same HTTP Basic authentication. Always use HTTPS for a public deployment.

The frontend also sends `X-Cartographer-Request: 1` for API requests. Protected deployments require this header for mutating API methods and paid remote location lookups, preventing third-party forms or embedded URLs from using a signed-in browser's credentials to spend the budget. Direct API clients must supply the header along with authentication; read-only photos and the health probe remain accessible through their normal request paths.

Do not add provider keys as build arguments or frontend variables. Leave **Inject Build Args** disabled: this image requires no build-time secrets. Neither `.env`, `keys.env`, local caches, nor MongoDB data enter the build context. The Dockerfile also copies application sources explicitly rather than copying the whole repository.

Coolify can populate the runtime variables directly. For a local Compose configuration check, an ignored project-root `.env` is loaded automatically. An existing ignored `keys.env` can instead be supplied explicitly:

```sh
docker compose --env-file keys.env config --quiet
docker compose --env-file keys.env up -d --build
```

Add the deployment password to that ignored file or set it in the shell before running these commands. Use `config --quiet`; printing the fully resolved configuration can expose credentials. No host ports are published by this Compose file, so traffic normally reaches the application through Coolify's proxy. The independent `npm start` launcher remains available for a local production build without Docker.

## Persistent data and budgets

For local Docker access, use the included override:

```sh
docker compose -f docker-compose.yaml -f docker-compose.local.yaml up -d --build
```

Open `http://127.0.0.1:8080` and use the username/password from the private `.env`. This override publishes only the application on loopback. MongoDB stays internal. Set `CARTOGRAPHER_LOCAL_PORT` to choose another local port; the Coolify deployment uses the main Compose file without this override.

The official MongoDB container is reachable only on the internal database network. Its `mongo-data` volume contains job snapshots, completed runs, per-image analyses, discovery/reference caches, location caches, and the spending ledger. The application cache volume preserves licensed imagery when using Panoramax or another supported licensed source. Google photograph bytes remain in bounded memory and expire; a restart does not preserve those previews.

The ceilings remain **$4 for Google** and **$2 for OpenAI**, enforced by the application's persistent ledger. They are instance ceilings, not provider-account limits. Deploying into a fresh volume creates a fresh ledger; moving this application must include a backup and restore of the existing MongoDB database if previous spending should remain accounted for. Preserve uncertain reservations as well as charged totals. Do not remove or reset the database to refresh search results.

### Carry the local prototype into Coolify

The verified local backup is in `build/private/mongodb/cartographer/`, also packaged as `build/private/cartographer-mongodb.tar.gz`. It contains standard BSON collection dumps and index metadata, including all cached analyses, completed jobs and the existing spending ledger. It deliberately excludes credentials and Google photograph bytes. This private backup is ignored by Git and omitted from the public release archive; transfer it separately to your server and extract the archive to obtain the `mongodb/` parent folder.

Stop the application service before restoring. In the Coolify deployment's Compose directory on the server, with its runtime variables available, use the following commands against a **fresh destination database**. Replace `/path/to/mongodb` with the copied parent folder containing `cartographer/`:

```sh
docker compose stop cartographer
docker compose up -d mongo
docker compose cp /path/to/mongodb mongo:/tmp/cartographer-dump
docker compose exec -T mongo mongorestore --nsInclude='cartographer.*' /tmp/cartographer-dump
docker compose up -d cartographer
```

Use Coolify's existing Compose project and environment for these operations; do not create a second deployment or new volumes. The official MongoDB image includes `mongorestore`. Check **Usage & sources** after signing in: this backup preserves Google usage of **$0.567**, OpenAI usage of **$0.208352**, and an unresolved OpenAI reservation of **$0.04**. The backup was restored into a separate test database and every document and index was compared successfully.

Do not restore an old dump over a deployment that has already incurred new usage. Preserve that deployment's newer ledger and data instead; do not use `--drop` to reset spending. For another local snapshot, run `npm run db:backup` with searches stopped. The helper briefly locks writes, releases the lock on completion or failure, and refuses to overwrite an existing backup. Move the previous backup to another private location before running it again.

Before replacing a deployed instance, back up MongoDB using `mongodump` and restore into the destination with `mongorestore`, using the MongoDB tools matching the deployment. Keep the same database name, and back up `application-cache` when it contains licensed source photographs. Coolify volume persistence is not itself a backup. Keep the previous data until the restored ledger and caches have been verified. Do not run `docker compose down --volumes` unless intentionally deleting both persistent volumes.

Updates rebuild the image and retain these volumes. Active in-memory jobs are interrupted during restart; completed results and the ledger persist. Authentication is shared rather than per user, so anyone with the password shares the same data and spending ceiling. Public multi-user operation would additionally require account-scoped permissions and budgets, request controls, and durable worker coordination.

The default Google Street View source remains subject to Google's reuse and display terms. Deployment, password protection, and temporary image storage do not grant an exception. Review [imagery sources and terms](imagery-sources.md) before publishing the application. Panoramax is an optional licensed alternative through `CARTOGRAPHER_IMAGERY_PROVIDER=panoramax`.

## Container verification

The image was built and run on Linux ARM64 through Docker on October 3, 2026. Both Compose services became healthy. Checks covered the public minimal health response, authentication for the interface and API, authenticated provider availability, the built JavaScript and Cesium assets, JSON API errors, nonroot UID 10001, a writable persistent cache, and exclusion of credential files from the image. The validation instance made no paid provider requests and retained zero charged or reserved usage. Its separate database volume did not replace the existing local ledger.

The Node, Python, uv, and MongoDB base images also publish Linux AMD64 manifests for typical Coolify servers. AMD64 runtime execution and a real Coolify deployment have not been verified here. The release folder contains the same Docker configuration; deploy one instance and verify its HTTPS domain and persistence after installation.

## References

- [Coolify Docker Compose deployment and domain ports](https://coolify.io/docs/applications/builds/docker-compose)
- [uv Docker integration](https://docs.astral.sh/uv/guides/integration/docker/)
- [Waitress usage](https://docs.pylonsproject.org/projects/waitress/en/stable/usage.html)
- [Official MongoDB Docker image](https://hub.docker.com/_/mongo)
