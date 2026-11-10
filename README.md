# Smart Parking License Plate Tracker

![CI](../../actions/workflows/ci.yml/badge.svg)

A microservices system for a smart parking lot. An IoT camera reads license
plates and sends them to our API. The guard's dashboard shows, in real time
(no page refresh), which cars are inside, how long they've been parked and how
much they need to pay.

**Track 2 – Full Stack DevOps**

---

## Architecture

```
                 ┌────────────── docker compose network ──────────────┐
  Browser        │                                                    │
  (guard) ──8080──▶  web (Nginx)  ──/api/*──▶  api (Node.js)  ──▶  redis │
                 │  dashboard HTML/JS          Express            │     │
  IoT camera ────┼──── HTTP POST /api/cars ──▶                    ▼     │
                 │                                          [redis-data]│
                 └──────────────────────────────────────────── volume ──┘
```

| Service  | Image                   | What it does                                                                 |
|----------|-------------------------|------------------------------------------------------------------------------|
| `web`    | `nginx:1.27-alpine`     | Serves the dashboard and proxies `/api/*` to the API (same origin, no CORS). |
| `api`    | `node:22-alpine`        | Express REST API: receives plates, computes prices, reads/writes Redis.      |
| `redis`  | `redis:7.4-alpine`      | The database. AOF persistence (`--appendonly yes`) on the `redis-data` volume. |
| `camera` | `curlimages/curl`       | *Optional* fake IoT camera that POSTs a random plate every 10 s.              |

Only `web` publishes a port (8080). The API and Redis are reachable only
inside the Compose network.

## Run it

Requirements: Docker Desktop (Docker + Compose).

```bash
docker compose up -d --build
```

Open **http://localhost:8080**

With the fake camera sending cars automatically:

```bash
docker compose --profile camera up -d --build
```

Stop (data is kept in the volume):

```bash
docker compose down
```

Stop **and delete all data**:

```bash
docker compose down -v
```

Settings (optional, in a `.env` file or the shell):

| Variable         | Default | Meaning                       |
|------------------|---------|-------------------------------|
| `CAPACITY`       | 10      | Number of parking spots       |
| `PRICE_PER_HOUR` | 12      | ₪ per started hour            |

## API

| Method   | Path                 | Body                     | Response                                          |
|----------|----------------------|--------------------------|---------------------------------------------------|
| `POST`   | `/api/cars`          | `{"plate":"12-345-67"}`  | `201` added · `400` bad plate · `409` already in · `503` lot full |
| `GET`    | `/api/cars`          |                          | Capacity, count, cars + current price, revenue, last 10 exits |
| `DELETE` | `/api/cars/:plate`   |                          | Releases the car, returns the price paid · `404` not found |
| `GET`    | `/api/health`        |                          | `{"ok":true}` if Redis is reachable               |

Example (simulating the camera from the terminal):

```bash
curl -X POST http://localhost:8080/api/cars -H "Content-Type: application/json" -d '{"plate":"12-345-67"}'
```

### Data in Redis

| Key                  | Type       | Content                                       |
|----------------------|------------|-----------------------------------------------|
| `parked`             | Sorted set | member = plate, score = entry time (ms)       |
| `history`            | List       | JSON exit records, newest first (max 50)      |
| `stats:totalEntries` | String     | Counter of all entries ever                   |
| `stats:revenue`      | String     | Total ₪ collected                             |

## Our personal touch ✨

- **Parking price calculator:** every started hour costs ₪12, shown live per car.
- **Release car button:** the car leaves, gets billed, and moves to "Recent exits".
- **Full Capacity Alert:** a flashing red banner + the meter turns red when the lot is full.
- **Funny entry messages:** a random joke pops up for every new car.
- **Dark mode** toggle (remembered in the browser).
- **Easter egg:** type `vroom` anywhere on the page 🏎️

## Persistence demo (Demo Day)

```bash
docker compose up -d --build        # 1. start
# 2. add a few cars in the dashboard
docker compose down                 # 3. stop + remove containers
docker compose up -d                # 4. start again
# 5. refresh the dashboard: the cars are still there
```

Why it works: Redis runs with `--appendonly yes`, so every write is appended to
`/data/appendonly.aof`. `/data` is the named volume `redis-data`, which lives
outside the container. `docker compose down` removes containers but **not**
volumes (only `down -v` does).

## CI/CD

- **`.github/workflows/ci.yml`:** on every push / PR: builds the images, starts
  the stack, adds a car through the API, runs `down` + `up` and checks the car
  is still there.
- **`.github/workflows/publish.yml` (bonus):** on push to the main branch or a
  `v*` tag: logs in to `ghcr.io` with `GITHUB_TOKEN`, tags the images
  automatically (`v1.0.<run>`, `latest`, `sha-…`, and semver for git tags) and
  pushes `…-api` and `…-web` to GitHub Container Registry.

## Project structure

```
.
├── docker-compose.yml
├── api/            Node.js + Express API
│   ├── Dockerfile
│   ├── package.json / package-lock.json
│   └── server.js
├── web/            Nginx + dashboard
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── index.html
│   ├── style.css
│   └── app.js
├── .github/workflows/
│   ├── ci.yml
│   └── publish.yml
├── ARCHITECTURE.md
└── AI_USAGE.md
```
