# Architecture Research

**Domain:** Self-improving chess engine (C++ UCI engine + Python training/RL loop + web API + React UI), single Windows laptop now, public product later
**Researched:** 2026-10-12
**Confidence:** MEDIUM-HIGH (process/data-flow/schema design: HIGH, it is standard engine-dev practice; throughput numbers and Stockfish Elo calibration: MEDIUM, must be measured in-phase)

Scope note: this file covers SYSTEM architecture only (process boundaries, data flow, storage, orchestration). The network's internal architecture, input features, label design and export format belong to the separate NN researcher. They appear here only as interfaces: a **net file** with an architecture id in its header, and a **sample shard** format.

---

## Standard Architecture

### The one-sentence shape

Three kinds of long-lived things talk through **files + one SQL database + one subprocess protocol (UCI)**: a stateless-ish **API process**, a **worker process** that runs jobs, and **engine/trainer subprocesses** that the other two spawn. The browser only ever talks to the API.

### System Overview

```
 BROWSER (React, Vite)
   |  REST (commands, queries)            ^  SSE (engine thinking, job progress)
   v                                      |
+------------------------------ API PROCESS (FastAPI/uvicorn, 1 worker) -------------------------+
|  routers (thin)  ->  services (game, training, rating, ingest, jobs)  ->  repositories (SQL)   |
|        |                          |                                                            |
|   auth seam              EngineService (UCI wrapper, engine pool for HUMAN games only)         |
|  current_user()                   |  stdin/stdout UCI                       EventBus (in-mem)  |
+-----------------------------------|-----------------------------------------|------------------+
        |                           v                                         |
        |                  [engine.exe  --  play instance, Threads=N]          | (jobs table +
        |                                                                      |  progress rows)
        v                                                                      v
+------------------+     +----------------------------------------------------------------------+
|  DATABASE        |<--->|  WORKER PROCESS (Python, separate from API)                          |
|  SQLite (WAL)    |     |  JobQueue poller -> ResourceManager (cpu tokens, gpu lease, priority) |
|  Postgres-ready  |     |  Pipeline state machine: train -> smoke -> gate -> promote -> rate    |
+------------------+     |        |             |                |               |              |
        ^                |        v             v                v               v              |
        |                |   [trainer]     [fastchess]      [fastchess]     [ingest / label /   |
        |                |   python -m     self-play        gate + rating   shard-writer procs] |
        |                |   trainer.train  (N games)       vs Stockfish                         |
        |                |    GPU+3 CPU     N x engine.exe   engine.exe + stockfish.exe          |
        |                +----------------------------------------------------------------------+
        |                       | JSON-lines on stdout (progress, metrics)  | PGN files + exit code
        |                       v                                           v
+------------------------------------------ BLOB STORE (data/ now, S3-style later) ------------+
|  nets/<id>.nnue   shards/<id>.binpack   pgn/<match|selfplay|human>/...   uploads/   runs/   |
+---------------------------------------------------------------------------------------------+
```

Two rules make this structure survive the move to a public product:

1. **Subprocess contracts are narrow and file/stdout based.** The trainer takes a manifest file and writes a net file plus JSON-lines on stdout. The match runner takes a config and writes PGN plus an exit code. Neither knows the database exists. That means each can later move to another machine or container without code change.
2. **The database is the only shared mutable state**, and only the API and worker write to it. Bulk data (positions, PGN archives, nets) lives in files; the DB holds metadata and pointers.

### Component Responsibilities

| Component | Responsibility | Implementation | Talks to |
|-----------|----------------|----------------|----------|
| **Engine (C++)** | Legal move generation, alpha-beta search, evaluation via net loaded from `EvalFile`; UCI; reports `info` lines. Also `bench`, `perft`, and later `datagen`. | CMake project, single binary `engine.exe`, one process per concurrent game, Threads/Hash set via `setoption` | stdin/stdout UCI only |
| **Net file** | The interface between trainer and engine: a binary with a header (architecture id, version hash, checksum) so the engine refuses a mismatched net instead of playing garbage | Written by `trainer.export`, read by engine | Engine, trainer, BlobStore |
| **EngineService** (backend) | Own thin UCI wrapper: spawn, handshake, `setoption`, `position`/`go`, parse `info`, `stop`, kill on timeout. Engine pool for human/analysis use. | `subprocess.Popen` + reader thread -> asyncio queue (see Pattern 4). python-chess used only for board/legality/SAN/PGN, not as the engine driver | Engine process, EventBus |
| **Game service** | Authority on game state. Validates moves, persists plies, triggers engine reply, detects game end, writes PGN, marks game for the training pool | Plain Python service class over repositories | EngineService, DB, EventBus |
| **API** | HTTP surface: REST commands/queries + SSE streams. Thin; no business logic | FastAPI (async, native streaming); replaces the Flask hello-world | Browser, services |
| **Job queue + worker** | Durable queue in the DB; one worker process claims jobs, applies resource limits, spawns subprocesses, parses their JSON-lines, writes progress, chains pipeline steps, recovers from crashes | `jobs` table + poll loop; no Celery/Redis | DB, all runner subprocesses |
| **ResourceManager** | Decides which jobs may start now: CPU-thread tokens, one GPU lease, process priority classes, "human game open" reduces background budget | In-worker class, config-driven | Worker, DB (active-games heartbeat) |
| **Ingest pipeline** | PGN upload / finished game -> validated, deduplicated, (optionally relabelled) -> sample shards + `games` rows | Python job (light lane), streaming parser | BlobStore, DB, engine (for relabel) |
| **Trainer** | Dataset manifest -> candidate net. Resumable, checkpointing, emits metrics; exports engine-format net; runs engine smoke test | `python -m trainer.train --manifest ... --out ...`; PyTorch on GPU; **no DB access** | Manifest/shards in, net + JSON-lines out |
| **Arena (match runner)** | Plays N games between two engine configs at fixed nodes/depth, with openings, adjudication, SPRT early stop; used for self-play, gating, and rating | **fastchess** (MIT-licensed, Windows builds, concurrency, PGN out) as an external binary; Python wrapper builds the command line and parses PGN. Contract = config in, PGN + exit code out, so it can be swapped for a custom runner | Engine, Stockfish, PGN files |
| **Rating module** | Pure functions: W/D/L (and pentanomial) -> Elo + error bars; SPRT/LLR; opponent selection. No I/O | Python, unit-tested against known values | Gate and rate pipelines |
| **Frontend** | Board, play, live thinking panel, review, training history, rating dashboard, self-play/upload controls | React 19 + Vite per cookbook (zustand, axios, tokens) | API only |

---

## Recommended Project Structure

```
chess-engine/
├── engine/                     # C++ (CMake). Nothing here imports Python.
│   ├── CMakeLists.txt
│   ├── src/                    # board, movegen, search, eval (Evaluator interface), uci, nnue loader
│   ├── tests/                  # perft suite, search sanity, net-load tests
│   └── tools/                  # later: datagen, bench driver
├── trainer/                    # Python package, runnable standalone, NO dependency on backend/
│   ├── pyproject.toml
│   ├── trainer/
│   │   ├── data/               # shard reader/writer, PGN->samples, Lichess prep, labelers
│   │   ├── model/              # network definition (owned by the NN-architecture phase)
│   │   ├── train.py            # CLI: manifest -> checkpoints -> candidate
│   │   ├── export.py           # torch weights -> engine net file (+ header)
│   │   └── progress.py         # JSON-lines emitter (the only "API" to the worker)
│   └── tests/
├── backend/
│   ├── pyproject.toml
│   ├── alembic/                # migrations (Postgres-compatible DDL)
│   ├── app/
│   │   ├── main.py             # FastAPI app factory
│   │   ├── config.py           # pydantic-settings; env-driven paths and limits
│   │   ├── api/v1/             # routers: games, selfplay, uploads, training, networks, ratings, jobs, events
│   │   ├── deps.py             # current_user(), require_admin() -- the auth seam
│   │   ├── services/           # game_service, training_service, rating_service, ingest_service
│   │   ├── engine/             # uci.py (wrapper), pool.py, info_parser.py, builds.py
│   │   ├── arena/              # fastchess command builder, PGN result parser, openings, selfplay/gate/rate runners
│   │   ├── rating/             # elo.py, sprt.py, ladder.py (pure functions)
│   │   ├── jobs/               # models, queue, worker.py, resources.py, pipeline.py (chaining rules), handlers/
│   │   ├── db/                 # SQLAlchemy models, session, repositories
│   │   ├── storage/            # BlobStore interface + LocalBlobStore
│   │   └── events/             # EventBus interface + InMemoryEventBus, SSE helpers
│   └── tests/
├── frontend/                   # existing Vite/React boilerplate, retrofitted per cookbook skills
│   └── src/ (apis/, stores/, routes/, components/, features/{play,review,training,rating,selfplay,upload})
├── tools/                      # gitignored binaries + download scripts: stockfish/, fastchess/, books/
├── data/                       # gitignored runtime state (see below)
│   ├── db/chess.sqlite
│   ├── nets/                   # <network_id>.nnue
│   ├── shards/                 # <shard_id>.binpack  (training samples)
│   ├── pgn/                    # selfplay/, matches/, human/
│   ├── uploads/                # raw user PGNs
│   ├── runs/<run_id>/          # checkpoints, manifest.json, trainer.log
│   ├── engines/<git-sha>/      # frozen engine builds referenced by matches
│   └── tmp/                    # atomic-write staging
├── docs/                       # protocol notes: net file header, shard format, job JSON-lines schema
└── scripts/                    # dev launcher (api + worker + vite), build engine, fetch tools
```

### Structure Rationale

- **`engine/` and `trainer/` have zero dependency on `backend/`.** They are the two compute-heavy cores and the ones most likely to move to other hardware. They communicate via UCI and via files only. This is also what keeps the NN-architecture phase independent: it changes `trainer/model` + `engine/src/nnue` and the net-header spec, nothing in `backend/`.
- **`backend/arena` and `backend/rating` separated.** Arena is I/O (spawning, PGN); rating is pure math. The pure part gets exhaustive unit tests, which matters because the project's Core Value is a *measured* Elo.
- **`jobs/handlers/` one file per job type** (`train`, `selfplay`, `gate`, `rate`, `ingest_pgn`, `review`, `bootstrap_prepare`). Adding a pipeline step never touches the API.
- **`data/` is runtime, never committed, and never referenced by absolute path in the DB.** Only keys like `nets/01J....nnue` are stored; `LocalBlobStore` joins them to `DATA_DIR`.
- **`engines/<git-sha>/`** freezes the exact binary used in a match so a rating row stays reproducible after the engine source changes.
- Existing `backend/app.py` (Flask hello-world) should be replaced, not extended: streaming + async subprocess management is first-class in FastAPI and awkward in Flask.

---

## Architectural Patterns

### Pattern 1: Jobs as the unit of long work, DB-backed queue, one worker

**What:** Every long operation is a row in `jobs` (type, params JSON, status, resource needs, progress JSON, heartbeat). The API only inserts rows and reads them; the worker claims and runs them. Pipeline steps are chained by code in `jobs/pipeline.py` ("when `train` succeeds, enqueue `smoke` then `gate`"), not by a workflow engine.
**When to use:** Always here. Training is hours-days, matches are tens of minutes, and all must survive an API restart.
**Trade-offs:** + no Redis/Celery to install on a laptop, + durable, inspectable, easy to show in the UI ("training history" is just a query). - polling latency (1-2 s, irrelevant), - SQLite has one writer, so keep transactions tiny. On Postgres, claim with `FOR UPDATE SKIP LOCKED`; on SQLite, a single `UPDATE ... WHERE id=(SELECT ... LIMIT 1) RETURNING *` is atomic enough with one worker.

```python
# worker loop (sketch)
while True:
    job = queue.claim_next(fits=resources.can_start)   # atomic status queued->running, sets pid/heartbeat
    if not job: sleep(1); continue
    handler = HANDLERS[job.type]
    try:    result = handler.run(job, resources.lease(job))   # spawns subprocesses, parses JSON-lines
    except Cancelled:  queue.mark(job, "cancelled")
    except Exception:  queue.mark(job, "failed", error=...)
    else:   queue.mark(job, "succeeded", result=result); pipeline.on_success(job)   # enqueue next step
```

Crash recovery: on worker start, any `running` job whose heartbeat is stale is set to `interrupted`; training and self-play handlers are written to resume (checkpoint / chunk files already written are kept).

### Pattern 2: Subprocess contract = files in, files + JSON-lines out

**What:** Runner subprocesses are given a config/manifest path, write outputs to a temp dir, then **atomically rename** into place on success, and report progress as one JSON object per stdout line (`{"event":"progress","games":412,"of":1000,"w":..,"d":..,"l":..}`). The worker translates those lines into `jobs.progress` updates (throttled to about 1 per second).
**When to use:** Trainer, self-play, gating, rating, ingest.
**Trade-offs:** + the trainer is testable without a DB or API; + same contract works remotely later; + no SQLite writer contention from many processes. - need a documented JSON-lines schema (put it in `docs/`).

### Pattern 3: Immutable artifacts, mutable pointers

**What:** Nets, shards, PGN chunks, manifests are write-once and content-hashed. The only mutable thing is a pointer: `active_network_id`. Promotion = one DB transaction that inserts a `promotions` row and moves the pointer. Rollback = move it back.
**When to use:** Always. It is what makes "a candidate replaces the live network only after winning" auditable and reversible.
**Trade-offs:** disk grows (nets are small, tens of MB at most; shards are the big item and have a retention policy, see Scaling).

### Pattern 4: Thread-based UCI reader, asyncio at the edge

**What:** Wrap the engine with `subprocess.Popen(stdin=PIPE, stdout=PIPE, creationflags=...)`, a dedicated reader thread that parses lines into typed `InfoLine`/`BestMove` objects, and `loop.call_soon_threadsafe` to push them into an asyncio queue. Commands (`position`, `go`, `stop`) are written from the event loop.
**When to use:** The play/analysis path inside the API.
**Why not `asyncio.create_subprocess_exec`:** on Windows it requires the Proactor loop, and Python docs state the default Selector loop does not support subprocesses; there are field reports of it breaking under uvicorn `--reload` (unverified for current uvicorn; LOW-MEDIUM confidence). A reader thread is portable and removes the question entirely.
**Trade-offs:** ~150 lines of own code instead of python-chess's engine module, but full access to raw `info` lines, custom options (`EvalFile`), and clean `stop`/kill semantics. python-chess is still used for `Board`, legality, SAN, PGN.

### Pattern 5: Fixed nodes for every automated game

**What:** Self-play, gating and rating games use `go nodes N` (or fixed depth), never wall-clock time controls. Human play uses `go movetime`.
**Why:** results then do not depend on CPU contention, thermals, how many games run concurrently, or whether a human game is running. This is the single biggest simplification of the concurrency story: background work can be slowed, paused or reprioritised freely without corrupting any measurement.
**Trade-offs:** nodes-based strength differs from time-based strength (nps differs between our engine and Stockfish). Rating is therefore "Elo versus the Stockfish ladder at stated settings" and must carry a `protocol_id` (see Rating pipeline). Stockfish's `UCI_Elo` (range 1320-3190, active only when `UCI_LimitStrength=true`) is calibrated against CCRL at a fixed time control, and field reports say the mapping drifts; treat the ladder as a stable yardstick, not as absolute truth.

### Pattern 6: Auth seam and owner column from day one

**What:** Every user-owned row carries `owner_id` referencing `users`; v1 seeds one `local` user. A FastAPI dependency `current_user()` returns it; admin-only endpoints (training, self-play, rating, promotions) depend on `require_admin()`. The frontend keeps its existing guard/token plumbing dormant.
**Trade-offs:** a few columns and one dependency now vs a schema migration plus a security audit later.

---

## Data Flow

### Request Flow (human move)

```
Browser: user drops a piece
    |  POST /api/v1/games/{id}/moves {uci:"e2e4"}                       (REST, returns 202 + new state)
    v
GameService.apply_user_move: validate (python-chess) -> persist ply -> publish "move" event
    |  EngineService.think(game_id, position(startpos+moves), limits)   (UCI: position..., go movetime X)
    v
engine.exe  --info lines-->  reader thread -> InfoParser -> EventBus.publish(game:{id}, "thinking", {...})
    |                                                                      |
    |                                                                      v
    |                                              GET /api/v1/games/{id}/events (SSE)  ->  Browser panel + eval bar
    |  bestmove e7e5
    v
GameService.apply_engine_move: validate legal -> persist ply (+ last eval/depth/nodes) -> publish "move"
    v
if game over (checkmate/stalemate/draw rules/resign): finalize -> PGN -> games.status=finished,
    games.pool_status='pending' -> enqueue 'review' job (light lane) -> publish "game_over"
```

### State Management

Server is the source of truth; the browser holds a *view*. Zustand slices: `gameStore` (board FEN, move list, status), `thinkingStore` (latest info per multipv, replaced not appended), `jobsStore` (progress by job id). On SSE reconnect the client first GETs the current state, then resumes the stream. Moves are REST commands; SSE is read-only push.

### Key Data Flows

1. **Human game -> training pool.** Steps above end with `games` row (`source='human'`, `network_id` = net used, `pool_status='pending'`, moves + per-ply engine eval stored). The pool counter is a query: `COUNT(games WHERE pool_status='pending')` (games whose positions have not yet been written to a shard). A periodic check in the worker materialises pending games into a shard when the threshold is hit (or on "train now").

2. **Self-play session.** `POST /selfplay {target_games, network_id?, nodes}` -> `selfplay_sessions` + `jobs(type=selfplay)`. Worker claims when the heavy lane is free -> arena runner launches fastchess with concurrency N (single-thread engines, both sides the same net, fixed nodes, randomised openings) -> PGN chunks (with per-move eval comments) written to `data/tmp`, renamed to `data/pgn/selfplay/<session>/chunk-k.pgn` every K games -> JSON-lines progress -> `jobs.progress` -> SSE to UI -> at target, handler converts chunks to a shard (`pgn -> samples`), registers `data_shards`, bulk-inserts `games` rows (`source='selfplay'`). Cancel leaves finished chunks usable.

3. **PGN upload.** `POST /uploads` (multipart) -> blob `uploads/<id>.pgn` + `uploads` row -> `ingest_pgn` job (light lane, runs even while a human game is open) -> streaming parse, reject illegal/short/unfinished games, dedupe by a hash of the move list, take `[%eval]` comments when present else mark samples `needs_label` -> optional `label` step (engine at fixed nodes, CPU) -> shard + `games` rows (`source='upload'`) -> result report (accepted / duplicate / rejected with reasons) returned through job `result`. No replay UI, per scope.

4. **Bootstrap (Lichess).** Not a user flow: `trainer.data.prepare_lichess` streams the monthly `.pgn.zst` dumps, filters (rating band, result present, evals present), writes shards directly and records a `datasets` row. **Billions of positions never enter SQLite.** Only the dataset record and shard pointers do.

5. **Training run.** Trigger = `POST /training/runs` ("train now") or the worker's periodic pool check (enqueue only; never starts a heavy job while another heavy job runs). Handler: build **dataset manifest** (list of shard ids + checksums + window policy, e.g. bootstrap shards + most recent K selfplay/human shards) and freeze it in `training_runs.manifest` -> spawn `trainer.train --manifest ... --init <parent net> --out data/runs/<id>` (GPU lease + 3 CPU tokens) -> JSON-lines metrics (loss, positions/s, epoch) -> checkpoints (resumable) -> `export` -> **engine smoke test** (spawn engine with the new net: `uci`, `isready`, `bench`, and a fixed-position eval sanity check; fails fast on header/arch mismatch or NaN) -> register `networks` row `status='candidate'` -> pipeline enqueues `gate`.

6. **Gating match.** Candidate vs active net, same engine build, fixed nodes, balanced opening pairs (each opening played from both colors), SPRT with a positive H1 (for example elo0=0, elo1=+5..10, alpha=beta=0.05; values tuned in the rating phase) and a max-games cap. fastchess writes PGN; the arena wrapper parses PGN into `match_games` and totals into `matches`. Decision = `pass` / `fail` / `inconclusive`. Only `pass` promotes (single transaction: `promotions` row + pointer move + `networks.status`). `fail` and `inconclusive` -> candidate `rejected`, kept for post-mortems. Pipeline then optionally enqueues `rate` for the new active net.

7. **Rating match.** `rate` job for network X: choose ladder opponents (Stockfish at `UCI_Elo` levels, single thread, fixed nodes) whose expected score vs X is roughly 25-75% (seeded from the previous net's rating, widened if the first results are lopsided) -> M games per level with opening pairs -> `matches` rows (one per opponent config) -> `rating_service` computes Elo + error from all of them with the pure rating module -> `ratings` row keyed `(network_id, protocol_id)`. **Raw W/D/L are the stored truth; Elo is recomputable.** Rating noise at about 200 games per level is roughly +/-30-50 Elo, which is why the dashboard must show error bars and why the "went up" success criterion should use the same protocol and enough games.

8. **Post-game review.** After a game ends, a `review` job (light lane, Threads=1-2, fixed nodes per ply, MultiPV=1-2) evaluates each position, stores `game_analysis` rows per ply (eval before/after, best move, win-probability loss, class: best/good/inaccuracy/mistake/blunder), streams progress via SSE. Classification thresholds are a feature-phase decision.

### Live thinking: transport and mapping

**Recommendation: REST for commands, SSE for all server-to-browser push (thinking + job progress). Not WebSocket, not polling.**

| Option | Verdict | Reason |
|--------|---------|--------|
| **SSE (`text/event-stream`)** | **Use** | One-directional is exactly the need. Works over plain HTTP and proxies, auto-reconnect with `Last-Event-ID`, trivial in FastAPI (`StreamingResponse`/`sse-starlette`) and browser `EventSource`. Moves/commands are ordinary REST, which fits the cookbook's axios layer and the stateless-API goal. Same mechanism serves job progress, so the frontend has one push client. |
| WebSocket | Defer | Needed only if bidirectional low-latency control appears (human-vs-human, live annotation). "Stop thinking" and "resign" are rare commands that REST handles fine. Adds connection-state and auth-on-upgrade complexity. |
| Polling | Fallback only | Wasteful for 5-10 updates/sec; fine for job lists. Keep `GET /games/{id}/state` for reconnect and for tests. |

Dev note: Vite's dev proxy must not buffer the SSE route; send `X-Accel-Buffering: no` and `Cache-Control: no-cache`, and emit a comment heartbeat every 15 s. `EventSource` cannot set headers, so the future auth seam should be cookie/session based for SSE routes (or use `fetch`-based SSE client with Authorization header).

**UCI `info` line -> event mapping** (server does the translation; the browser never sees raw UCI):

| UCI field | Event field | Server-side handling |
|-----------|-------------|----------------------|
| `depth`, `seldepth` | `depth`, `seldepth` | pass through |
| `multipv k` | `multipv` | keep a map k -> latest; UI shows k=1 by default |
| `score cp X` | `eval.cp` | **UCI score is from the side-to-move's view.** Convert to White's view (negate when Black to move) before sending. |
| `score mate N` | `eval.mate` | same sign conversion; UI draws a full bar |
| `lowerbound` / `upperbound` | dropped | aspiration-window fail lines are not real scores; do not display or store |
| `nodes`, `nps`, `time` | `nodes`, `nps`, `elapsed_ms` | pass through |
| `hashfull`, `tbhits` | optional `hashfull` | debug panel only |
| `pv m1 m2 ...` | `pv_uci[]` and `pv_san[]` | SAN produced server-side with python-chess from the searched position; UI never needs a move generator for the display |
| `currmove`, `currmovenumber` | dropped | noisy, little value |
| `info string ...` | logged | debug log, not streamed |
| `bestmove m [ponder p]` | `move` event, final `thinking` snapshot | closes the thinking phase, triggers persistence |

**Throttle:** coalesce to at most about 10 events/s per game, always flushing on a depth change and on `bestmove`. The thinking event replaces prior state (`latest`), it is not an append log. Eval bar: frontend converts cp to a win percentage with a logistic curve (display concern), clamps mate to 0/100.

SSE event types: `thinking`, `move`, `game_over`, `error`; job stream: `job_progress`, `job_state`.

---

## Storage

### Principles

- SQLite in WAL mode (`PRAGMA journal_mode=WAL; busy_timeout=5000; foreign_keys=ON`), SQLAlchemy 2.x + Alembic, portable types only (no SQLite-isms: use `JSON` type, `TIMESTAMP WITH TIME ZONE` stored UTC, text enums via `CHECK`).
- **IDs:** ULID text PKs for entities users or files reference (games, networks, runs, matches, jobs, sessions): sortable, generated in app code (no DB dependence), non-enumerable in a public API. Integer autoincrement for high-volume child tables (`game_plies`, `match_games`).
- **Bulk data is files, not rows.** Positions/training samples live in shard files; the DB tracks shards and provenance. A `positions` table with one row per training sample is a trap (see Anti-Patterns).
- **Blob keys, not paths.** Columns named `*_key` hold relative keys; `BlobStore.path(key)` / `open(key)` is the only code that knows `DATA_DIR`.
- **Only the API and worker write the DB.** Trainer/arena/ingest subprocesses report via JSON-lines. Keeps SQLite's single-writer limit a non-issue and keeps transactions short.

### Schema sketch

```sql
-- identity / auth seam ----------------------------------------------------
users(id TEXT PK, handle TEXT UNIQUE, role TEXT CHECK(role IN ('admin','user')), created_at)
  -- v1: one seeded row id='local', role='admin'

-- engine + opponents (provenance) -----------------------------------------
engine_builds(id TEXT PK, git_sha TEXT, arch_id TEXT, binary_key TEXT, built_at)
opponents(id TEXT PK, kind TEXT CHECK(kind IN ('stockfish','self','other')),
          name TEXT, version TEXT, options JSON,     -- e.g. {"UCI_LimitStrength":true,"UCI_Elo":1800,"Threads":1}
          anchor_elo REAL NULL, protocol_note TEXT)  -- assumed Elo used as the rating anchor

-- networks ----------------------------------------------------------------
networks(id TEXT PK, version_no INT UNIQUE,          -- human-friendly "v7"
         arch_id TEXT, file_key TEXT, sha256 TEXT,
         parent_id TEXT NULL REFERENCES networks, training_run_id TEXT NULL,
         status TEXT CHECK(status IN ('bootstrap','candidate','active','rejected','retired')),
         created_at, notes TEXT)
promotions(id TEXT PK, network_id, previous_network_id NULL, gating_match_id NULL,
           reason TEXT, created_at)                   -- append-only history
settings(key TEXT PK, value JSON)                      -- includes 'active_network_id'

-- games -------------------------------------------------------------------
games(id TEXT PK, owner_id REFERENCES users, source TEXT CHECK(source IN ('human','selfplay','upload','match')),
      white TEXT, black TEXT,                          -- 'human' | 'net:v7' | 'stockfish:UCI_Elo=1800'
      network_id NULL, engine_build_id NULL,           -- what the engine side was running
      result TEXT CHECK(result IN ('1-0','0-1','1/2-1/2','*')), termination TEXT,
      start_fen TEXT NULL, moves_uci TEXT,             -- compact; PGN rebuilt on demand
      pgn_key TEXT NULL,                               -- or pointer into a bulk PGN chunk
      status TEXT CHECK(status IN ('active','finished','abandoned')),
      pool_status TEXT CHECK(pool_status IN ('pending','in_shard','excluded')) DEFAULT 'pending',
      training_consent BOOLEAN DEFAULT 1,              -- public-product seam
      selfplay_session_id NULL, match_id NULL, upload_id NULL,
      created_at, finished_at)
game_plies(id INTEGER PK, game_id, ply INT, move_uci, fen_after NULL,
           eval_cp NULL, eval_mate NULL, depth NULL, nodes NULL, elapsed_ms NULL, pv_san TEXT NULL,
           UNIQUE(game_id, ply))                       -- human/engine games only; bulk games skip this
game_analysis(id INTEGER PK, game_id, ply, eval_before, eval_after, best_move_uci,
              winprob_loss REAL, classification TEXT, analysis_build_id, network_id)

-- training data (files + provenance) --------------------------------------
datasets(id TEXT PK, kind TEXT CHECK(kind IN ('lichess_bootstrap','selfplay','human','upload','mixed')),
         description, source_ref TEXT, created_at)      -- e.g. "lichess_db_standard_rated_2025-03"
data_shards(id TEXT PK, dataset_id, file_key, sha256, format TEXT, label_scheme TEXT,
            n_positions BIGINT, n_games BIGINT, labeler TEXT,   -- e.g. 'sf16@d12' | 'self:v7@5000n' | 'result_only'
            status TEXT CHECK(status IN ('building','ready','retired')), created_at)
shard_games(shard_id, game_id, PRIMARY KEY(shard_id, game_id))   -- only for games that exist in `games`
uploads(id TEXT PK, owner_id, file_key, filename, size, status, report JSON, created_at)

-- runs --------------------------------------------------------------------
selfplay_sessions(id TEXT PK, owner_id, network_id, engine_build_id, target_games INT, games_done INT,
                  params JSON,                          -- nodes, concurrency, opening policy, seed
                  status, job_id, started_at, finished_at)
training_runs(id TEXT PK, owner_id, parent_network_id, candidate_network_id NULL,
              manifest JSON,                            -- frozen shard ids + checksums + window policy
              params JSON, trainer_git_sha, seed, status,
              metrics_summary JSON, trigger TEXT CHECK(trigger IN ('manual','auto_pool')),
              job_id, started_at, finished_at)

-- matches (gating + rating share one table) -------------------------------
matches(id TEXT PK, kind TEXT CHECK(kind IN ('gating','rating','adhoc')),
        a_network_id, a_engine_build_id,
        b_network_id NULL, b_opponent_id NULL,           -- exactly one of the two
        limits JSON,                                     -- {"nodes":5000} or {"depth":9}
        openings JSON, games_planned INT, games_done INT,
        wins INT, draws INT, losses INT, ptnml JSON,     -- pentanomial counts from opening pairs
        sprt JSON NULL,                                  -- elo0, elo1, alpha, beta, llr, bounds
        decision TEXT CHECK(decision IN ('pass','fail','inconclusive','n/a')),
        protocol_id TEXT, status, job_id, started_at, finished_at)
-- games.match_id links every game of a match; PGN is the raw record

-- ratings (derived, recomputable) -----------------------------------------
ratings(id INTEGER PK, network_id, protocol_id TEXT,     -- e.g. 'sf-ladder-v1'
        elo REAL, error_95 REAL, n_games INT, match_ids JSON,
        computed_at, UNIQUE(network_id, protocol_id, computed_at))
rating_protocols(id TEXT PK, ladder JSON, limits JSON, opening_set TEXT, anchor_method TEXT, created_at)

-- jobs --------------------------------------------------------------------
jobs(id TEXT PK, owner_id, type TEXT, params JSON,
     status TEXT CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
     lane TEXT CHECK(lane IN ('heavy','light')), needs JSON,   -- {"cpu":12,"gpu":0} resource declaration
     priority INT, parent_job_id NULL, progress JSON, result JSON, error TEXT,
     pid INT NULL, heartbeat_at, log_key TEXT, created_at, started_at, finished_at)
```

Notes on the sketch:
- `games.moves_uci` keeps every game reconstructable at about 400 bytes; 1M self-play games is about 400 MB, acceptable on SQLite and trivial on Postgres. If self-play volume explodes, switch bulk sources to `pgn_key` + offset and stop inserting per-ply rows (already the default: `game_plies` is only for human/engine-vs-human games).
- `ratings` is **derived** from `matches`; if the Elo formula or anchor changes, recompute under a new `protocol_id` instead of overwriting history. This prevents fake "Elo went up" jumps caused by changing the yardstick.
- `training_runs.manifest` + `trainer_git_sha` + `seed` is what makes a candidate reproducible and the training-history screen meaningful.
- Index: `games(pool_status, source)`, `games(match_id)`, `jobs(status, lane, priority, created_at)`, `matches(a_network_id, kind)`, `ratings(network_id)`.

### Files (BlobStore)

| Kind | Location (key) | Format | Retention |
|------|----------------|--------|-----------|
| Nets | `nets/<network_id>.nnue` | engine net file with header (arch id, hash) | keep all (small); needed for rating history |
| Training samples | `shards/<shard_id>.binpack` (or format chosen by NN phase) | write-once, checksummed | bootstrap kept; selfplay/human shards windowed (older retired by policy) |
| Match / self-play PGN | `pgn/<kind>/<id>/chunk-k.pgn` | text, per-move eval comments | keep match PGN; selfplay PGN can be deleted after sharding |
| Uploads | `uploads/<id>.pgn` | raw | keep until ingested + N days |
| Run artefacts | `runs/<id>/` | manifest, checkpoints, logs | keep manifest + log + final; prune intermediate checkpoints |
| Engine builds | `engines/<git-sha>/engine.exe` | frozen binary | keep those referenced by matches |

---

## Concurrency on One Laptop

Hardware: 8 cores / 16 threads, 6 GB VRAM (Windows also reserves some for the display), 16 GB RAM, one thermally limited chassis.

### Key insights

1. **A game costs one thread of search, not two.** In a game only the side to move is searching, so with single-thread engines, N concurrent *games* use about N threads. "N engine pairs on 16 threads" therefore means up to about 12-14 concurrent games, not 8. Self-play, gating and rating engines run `Threads=1`, `Hash=16-32 MB`.
2. **Fixed-node limits (Pattern 5) make background work elastic.** It can be niced, paused or reduced without changing any result.
3. **The natural pipeline is sequential** (self-play -> train -> gate -> rate). The real overlaps are: *a human game with anything* and *light jobs with anything*. So v1 does not need clever packing.

### v1 policy: two lanes + priority

| Lane | Job types | Rule |
|------|-----------|------|
| **heavy** (exclusive: at most 1 running) | `bootstrap_prepare`, `label`, `selfplay`, `train`, `gate`, `rate` | One at a time. Each declares its resource needs. |
| **light** | `ingest_pgn`, `review`, shard-building | Up to 2 at once, 1-2 threads each, never blocked by heavy jobs. |
| **interactive** (not a job) | human game engine in the API process | Always allowed; has priority over everything. |

Declared resources and caps (starting values, to be tuned by benchmark in the first heavy-job phase):

| Activity | CPU threads | GPU | RAM | Process priority |
|----------|-------------|-----|-----|------------------|
| Human game engine | `Threads=6` (setting), `Hash=256-512 MB` | no | ~0.6 GB | Normal/Above normal |
| Self-play / gating / rating | concurrency 12 (default), 14 max when nothing else open; 8 while a human game is open | no | ~12 x (hash + net) well under 1 GB | **Below normal** |
| Training | 3 (loader workers + main), plus GPU lease | exclusive (1 job), batch sized for ~5 GB | 3-5 GB | Normal |
| Review / ingest | 1-2 | no | < 1 GB | Below normal |
| OS + API + browser | reserve 2 | | ~3 GB | |

Mechanics (all in `jobs/resources.py`, small):
- `cpu_tokens` and `gpu` capacity from config. A job starts only if its declared needs fit; heavy lane exclusivity is just "heavy jobs declare `cpu` = full budget" at first, and can be relaxed later (for example letting a 3-thread GPU training job overlap a 10-thread self-play) without touching handlers.
- **Human-game presence:** the API writes a heartbeat (`settings: active_games_until`) while any game is `active` and updates it on every move. The worker reads it: if present, it spawns new background runs with the reduced concurrency (8 instead of 12) and sets child priority to `BELOW_NORMAL_PRIORITY_CLASS` (Windows: `creationflags`, or `psutil.Process.nice`). Priority classes alone mostly protect the human's move latency; the reduced concurrency protects memory bandwidth and heat.
- **Escape hatch if jitter is measured:** while the engine is actually thinking for a human, `psutil` suspend/resume the background process tree (safe *because* of fixed nodes), resumed on `bestmove`. Build only if measurement shows a need.
- fastchess cannot change concurrency mid-run; the policy is applied at job start plus priority/suspend at runtime. For long self-play, run in sessions of bounded size and re-evaluate the budget between chunks.
- **Cancellation on Windows:** no reliable SIGTERM for children. Use a sentinel (`cancel` file polled by runners / stdin command for the trainer) first, `taskkill /T` as the hard fallback, and put children in a Job Object (or use `CREATE_NEW_PROCESS_GROUP`) so killing the worker never leaves orphan `engine.exe` processes. Engine pool kills its process on a hard timeout.
- **Thermal / noise:** one `power_profile` setting (`quiet`: cap at 8 threads, `balanced`: 12, `max`: 14) applied by the ResourceManager, matching the "laptop fan" concern in PROJECT.md. GPU training + heavy CPU self-play are not overlapped by default.
- **VRAM:** one training process at a time, expandable-segments allocator, mixed precision, gradient accumulation to fit 6 GB; engine inference is CPU (NNUE-style), so playing never contends with the GPU.
- **SQLite:** WAL, short transactions, progress writes throttled to 1/s per job, only API and worker write. Do not let N self-play processes write rows.

### What this buys / what it defers

Defers true pipelining (train on shard k while generating shard k+1 with the older net). That is a Leela-style optimisation worth doing only after the loop works end to end and shows Elo gain.

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Single laptop, 1 user (v1) | Exactly as above. In-memory EventBus, SQLite, local BlobStore, one API worker. |
| Public beta, tens-hundreds of concurrent players | Postgres; Redis (or Postgres LISTEN/NOTIFY) behind `EventBus`; run N API instances (no sticky state: game state in DB, thinking stream is per-game channel); extract **engine service** (pool of engine workers consuming a queue, API streams their output); S3-compatible BlobStore; per-user rate limits. Training/self-play stay admin-only on dedicated hardware. |
| Larger | Dedicated GPU trainer host(s) and a farm of self-play workers pulling jobs; users' games stream into the same shard pipeline; object storage lifecycle policies. |

### Scaling Priorities

1. **First bottleneck: engine CPU for concurrent human games.** Each active human game holds an engine process and burns CPU while thinking. Fix: pool with a cap and a queue, `think()` interface already async, move pool to its own service.
2. **Second bottleneck: SSE fan-out and in-process EventBus once more than one API instance exists.** Fix: swap `InMemoryEventBus` for Redis/PG-notify; the interface (`publish(channel, event)`, `subscribe(channel)`) is the seam, define it now.
3. **Third: shard storage growth** from self-play. Fix: retention windows keyed on `data_shards.status`.

---

## Public-Product Seams (cheap now, expensive later)

| Seam | Do now | Avoid |
|------|--------|-------|
| Auth | `users` table with seeded `local` admin; `current_user()`/`require_admin()` FastAPI dependencies on every route; `owner_id` on games/uploads/sessions/runs | Reading "the user" from a global; frontend-only guards (cookbook already says guards are UX-only) |
| Statelessness | All game state in DB; any request can be served by any API process; engine process is a *cache* of a position (a missing engine is re-spawned from the stored move list) | Keeping the board in a Python global or dict as the only copy |
| Paths | Env-driven `DATA_DIR`; DB stores keys; no absolute paths in rows, logs shown to UI, or API payloads | `C:\Users\...` in any model or JSON |
| IDs | ULIDs in URLs | Autoincrement ints in public URLs |
| Event bus | `EventBus` interface with in-memory impl | Importing a global queue in handlers |
| Engine access | `EngineService.think(position, limits) -> AsyncIterator[Info]` | Routers spawning `subprocess` directly |
| Data rights | `games.training_consent`, `source`, `owner_id` | Assuming every game may feed training |
| Config | pydantic-settings from env; no hardcoded host/port (frontend per cookbook: env config, not hardcoded hosts; existing Axios base URL 8000 vs Flask 5000 mismatch must be resolved by env) | Magic numbers for threads/hash/nodes in code |
| API contract | `/api/v1` prefix, OpenAPI published, flat JSON per cookbook `01-rules/api-response-envelope.md` (read it before fixing the envelope shape; it says envelopes are "flat, but not uniformly" and the backend shape is a fact to define, not assume) | Ad-hoc response shapes |
| Licensing | Engine and nets are ours; Stockfish and fastchess are invoked as separate executables, not linked or redistributed in the product build | Bundling Stockfish binaries/nets in a distributed product without a license review |
| Rate/abuse | Per-owner caps on concurrent games and uploads enforced in services | Unbounded `POST /uploads` (limit size, count, parse in a subprocess) |

---

## Build Order and Dependencies

```
[0 Foundations: repo layout, config, DB+migrations, BlobStore, dev launcher]
        |
[1 Engine core: movegen+perft, classical eval behind Evaluator interface, search, UCI, bench]
        |                                       (no net yet; a material+PST eval is fine)
[2 Engine manager + Arena + Rating pipeline + Jobs/Worker v0]  <- first "job" is the rating match
        |        gives: a measured baseline Elo for the classical engine vs the Stockfish ladder
        |
        +--> [3 API + Game service + SSE + Play UI]  (needs 1, 2's UCI wrapper, DB games schema)
        |         human games saved -> pool; post-game review (needs 3)
        |
[4 Net: engine NNUE loader + net header spec + export]  (NN-architecture phase; needs 1)
        |
[5 Trainer data pipeline: Lichess prep -> shards; training loop; export; smoke test]  (needs 4, 0)
        |        bootstrap net registered, rated through 2's pipeline: first real "net vs classical" number
        |
[6 Closing the loop: self-play orchestrator, gating + promotion, networks registry,
    PGN ingest, pool trigger, training-history UI]  (needs 2, 5; ingest needs 0; self-play needs 2 arena)
        |
[7 Dashboards + hardening: rating history, power profiles, retention, recovery tests, public-ready seams audit]
```

Dependency rationale and ordering opinions:

- **Build the measuring instrument before the thing it measures.** Core Value says Elo must rise because of training. Doing Arena + rating + SPRT math (step 2) on the *classical* engine gives a baseline number and validates the yardstick (does Stockfish ladder behave? how noisy at N games?) before any net exists. Every later phase has a ruler.
- **The job queue's first customer is the rating match**, not training. It is a bounded, CPU-only, easily verified long job, so worker, resource limits, progress JSON-lines, SSE progress and crash recovery get proven on something cheap before the multi-hour trainer depends on them.
- **Engine UCI correctness (perft + legal play) gates everything**: arena, play UI, self-play all assume it. A buggy movegen silently poisons training data.
- **Play UI (3) is independent of nets** and can proceed in parallel with 4-5 once 1-2 exist; it also starts collecting human games early.
- **Net spec (4) is the one hard cross-boundary contract** (net header, arch id, shard format). Freeze a v0 of it early; the trainer and engine can then be developed against fixtures by separate people/agents.
- **Gating (6) needs both a registry and a match runner but not self-play**; it can be proven by gating the bootstrap net against the classical engine, then against itself with a deliberately degraded candidate (must be rejected). That is the key acceptance test of the whole project.
- **Self-play comes after the loop's measuring and gating parts**, because self-play without gating is just a way to damage the net faster.
- **Uploaded-PGN ingest** (6) reuses the shard writer from 5; if bootstrap data lacks labels, the `label` step is shared.

Research flags by component:
- Step 2 (rating protocol: ladder levels, nodes vs Stockfish `UCI_Elo` calibration, games per level, opening set): **needs deeper research/measurement**.
- Step 4/5 (net format, label scheme, binpack vs own shard format, Lichess eval availability): owned by the NN researcher, **needs its own phase research**.
- Step 6 gating thresholds (SPRT bounds vs time budget): needs a short experiment.
- Steps 0, 3 (FastAPI + SSE + React play UI): standard patterns, unlikely to need research.

---

## Anti-Patterns

### Anti-Pattern 1: One-row-per-position table for training data
**What people do:** insert every training position into a `positions` table "for queryability".
**Why it's wrong:** the bootstrap alone is hundreds of millions to billions of positions; SQLite and even Postgres choke, and the trainer needs sequential streaming reads anyway.
**Do this instead:** shard files + `data_shards` provenance. Per-ply rows only for human games (small) and review.

### Anti-Pattern 2: Wall-clock matches under shared load
**What people do:** gating/rating with `movetime`/clocks while self-play and a browser are running.
**Why it's wrong:** results depend on contention and heat; a promotion decision or Elo bump can be an artifact.
**Do this instead:** fixed nodes for every automated game; keep time-based search for humans only.

### Anti-Pattern 3: Training process writes to the database / API calls trainer directly
**What people do:** import SQLAlchemy in the trainer, or have a request handler launch it.
**Why it's wrong:** couples the ML code to the app, locks SQLite from a long job, loses state on API restart.
**Do this instead:** worker owns the subprocess, trainer speaks JSON-lines, DB updated by the worker.

### Anti-Pattern 4: Mutable "current net" file
**What people do:** overwrite `net.nnue` on promotion.
**Why it's wrong:** no rollback, running games may load a half-written file, rating history loses its subject.
**Do this instead:** immutable `nets/<id>.nnue` + `active_network_id` pointer; games record `network_id`; swap only takes effect when a new engine process starts.

### Anti-Pattern 5: Hot-swapping the net mid-game, or training on whatever net happened to play
**What people do:** reload weights in a live engine; lose track of which net generated which data.
**Why it's wrong:** unexplainable results; stale-label contamination.
**Do this instead:** stamp `network_id` on every game/shard, load nets only at process start.

### Anti-Pattern 6: Storing Elo as the primary fact
**What people do:** write "Elo = 2143" to a table.
**Why it's wrong:** protocol changes make history incomparable and the number cannot be re-derived or audited.
**Do this instead:** store W/D/L (and pentanomial) per opponent config; derive Elo under a named `protocol_id`.

### Anti-Pattern 7: Hand-rolling the match runner
**What people do:** write own asyncio arena with pairing, adjudication, crash/timeout handling, SPRT.
**Why it's wrong:** weeks of subtle bugs (engine hangs, illegal-move forfeits, color balance) that fastchess and cutechess already solved.
**Do this instead:** fastchess behind the PGN-in/PGN-out contract; keep only Elo/SPRT math and result parsing in our code (so it can be unit-tested and the runner swapped).

### Anti-Pattern 8: Streaming raw UCI lines to the browser
**What people do:** forward engine text, parse in React.
**Why it's wrong:** side-to-move sign confusion, bound lines flicker the eval bar, no SAN, couples UI to the engine protocol.
**Do this instead:** server parses, normalises to White's view, drops bound lines, coalesces, and sends typed events.

### Anti-Pattern 9: Sticky in-process game state
**What people do:** keep the board and engine in a Python dict keyed by game id as the only copy.
**Why it's wrong:** restart or second API instance loses every game; blocks the public-product path.
**Do this instead:** DB is truth; engine process is a disposable cache re-derived from moves.

---

## Integration Points

### External Services / Binaries

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Stockfish | Separate executable, UCI, `UCI_LimitStrength=true`, `UCI_Elo=<level>`, `Threads=1`, run through fastchess | Path from config; pin version; record version+options in `opponents`. `UCI_Elo` range 1320-3190, calibrated to CCRL at a fixed TC, so with fixed nodes the mapping is approximate: treat as ladder, not absolute |
| fastchess | External binary (MIT), command line built by `backend/app/arena`, PGN out (can include per-move eval/depth/nodes/time comments) | Windows builds exist; pin version; keep wrapper thin so cutechess-cli or a custom runner can replace it |
| Lichess open database | Offline download of monthly `.pgn.zst` dumps, streamed by `trainer.data.prepare_lichess` | Many games lack `[%eval]`; label availability drives the bootstrap plan (NN researcher). Large downloads: keep resumable |
| python-chess | Library for Board, legality, SAN, PGN read/write in backend and ingest | Not the engine driver (own thin UCI wrapper, Pattern 4) |
| PyTorch/CUDA | In `trainer/` only | Backend must not import torch (keeps API light and installable on non-GPU hosts) |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Browser <-> API | REST + SSE, `/api/v1`, flat JSON per cookbook, env-configured base URL | Mock-first dev per cookbook `react-data-layer` is viable since schema is defined here |
| API <-> Worker | DB only (`jobs`, `settings`, progress rows) | No direct IPC; either can restart independently |
| API <-> Engine (play) | UCI over pipes, in-process pool | Behind `EngineService` |
| Worker <-> Trainer | manifest file in; JSON-lines + net file out | Documented schema in `docs/` |
| Worker <-> Arena | config in; PGN + exit code out | Same |
| Engine <-> Trainer | net file (header: arch id, hash) and sample shard format | The two frozen contracts; owned with the NN-architecture phase |
| Services <-> DB | repositories (SQLAlchemy) | Only layer that knows SQL dialect |
| Anything <-> files | `BlobStore` | Only layer that knows `DATA_DIR` |

---

## Sources

- Project context: `.planning/PROJECT.md` (requirements, hardware, constraints, cookbook governance) - HIGH
- Stockfish UCI options (`UCI_LimitStrength`, `UCI_Elo` 1320-3190, `Skill Level`): [Stockfish wiki, UCI Protocol and Stockfish Commands](https://github.com/official-stockfish/Stockfish/wiki/UCI-Protocol-and-Stockfish-Commands) - HIGH for ranges; calibration accuracy MEDIUM-LOW (forum reports of drift, e.g. [TalkChess thread](https://www.talkchess.com/viewtopic.php?p=951046))
- fastchess (MIT, C++17, concurrency, PGN output with extra per-move data, Windows builds): [github.com/Disservin/fastchess](https://github.com/Disservin/fastchess), [Chessprogramming wiki: Fastchess](https://chessprogramming.org/Fastchess_(Game_Manager)), [LinuxLinks listing](https://www.linuxlinks.com/fastchess-manage-chess-games-engines/) - MEDIUM (SPRT flag and exact PGN comment format to be confirmed against current README during the arena phase)
- cutechess-cli as the established alternative (GPLv3+, gauntlet, concurrency): [Chessprogramming wiki: Cutechess-cli](https://chessprogramming.org/Cutechess-cli) - MEDIUM
- Windows asyncio subprocess caveat (Selector loop does not support subprocesses; Proactor needed; reload interaction unverified): [Python asyncio-subprocess docs mirror](https://omz-software.com/pythonista/docs/library/asyncio-subprocess.html) - MEDIUM/LOW
- Cookbook rules (flat envelope, env config, guards are UX-only): `D:/TupCode/Khalil-React-cookbook/01-rules/api-response-envelope.md` (referenced, not fully read; read before locking the API contract) - MEDIUM
- Domain practice (Leela-style generate -> train -> gate loop; Stockfish/Fishtest SPRT gating; immutable nets + pointer; engine `bench`/`perft` as correctness gates; fixed-node testing) - from established engine-development practice, MEDIUM-HIGH
- Throughput and thread-budget figures in this document are planning estimates, not measurements; phase 2/6 must benchmark them - LOW-MEDIUM

---
*Architecture research for: self-improving chess engine (C++ UCI + Python RL loop + web)*
*Researched: 2026-10-12*
