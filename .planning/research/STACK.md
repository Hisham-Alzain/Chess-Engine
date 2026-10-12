# Stack Research

**Domain:** Self-improving chess engine (C++ alpha-beta + learned NNUE-style eval, Python training/RL loop, Python web API, React UI) on one Windows 11 laptop
**Researched:** 2026-10-12
**Confidence:** MEDIUM-HIGH. Versions and release dates were read live from PyPI, the npm registry and GitHub releases on 2026-10-12. Source-code facts (Stockfish UCI_Elo range) were read from Stockfish master. Performance numbers and a few format details come from memory or forum posts and are marked MEDIUM/LOW.

Confidence tags used below: HIGH = read from a primary source today; MEDIUM = documented but not re-verified, or one secondary source; LOW = estimate or recollection, to be confirmed by a spike.

## Machine Facts That Shape The Stack (measured in this repo's environment)

| Fact | Value | Consequence |
|------|-------|-------------|
| MSVC | VS 2022 Enterprise, MSVC 14.44, CMake 3.31.6 and Ninja bundled, `clang-cl` bundled (Llvm\x64\bin) | No toolchain install needed. `cl`, `cmake`, `ninja` are NOT on PATH in plain shells. |
| nvcc | 13.2.51 present | CUDA toolkit is installed, so a Rust/Bullet CUDA build is possible if ever needed. |
| Rust | not installed | Bullet fallback needs `rustup` (MSVC target). |
| **Free disk** | **D: 20 GB free (97% full), C: 69 GB free** | The repo is on D:. Datasets, nets and game pools must live on C: (or an external drive). The Lichess eval dump is 22.4 GB compressed. Budget disk before the bootstrap phase. |
| Repo path | `D:\TupCode\Chess Engine` contains a **space** | Breaks naive `cmd=` / `option.EvalFile=` arguments to fastchess. Use a space-free artifacts dir (e.g. `C:\chess-artifacts\`) via an env var. |
| Python env | torch 2.9.1+cu130, numpy 2.4.6, fastapi 0.139.0, uvicorn 0.40.0, SQLAlchemy 2.0.41, zstandard 0.25.0, Flask 3.0.3 already installed. `chess`, `tensorboard`, `psutil`, `orjson`, `alembic` NOT installed. | Do not upgrade torch/numpy without cause. Install the missing pieces into a project venv. |
| CPU | Ryzen 9 5900HS = Zen 3: AVX2, BMI2 (fast PEXT), **no AVX-512** | Target AVX2 for NNUE inference. PEXT is fast on Zen 3 but slow on Zen 1/2, so keep it a compile switch (see Engine). |
| Node | v20.20.0 | Satisfies Vite 8 (needs 20.19+) and React 19. |

## Recommended Stack

### C++ Engine (search, board, NNUE inference, UCI)

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| C++20 (`/std:c++20`) | MSVC 14.44 | Language level | `<bit>` gives `std::popcount`, `std::countr_zero`; concepts/constexpr make table init clean. MSVC 14.44 supports it fully. | HIGH |
| CMake + Ninja (VS-bundled) | CMake 3.31.6 / Ninja bundled | Build system | Already installed with VS 2022. `CMakePresets.json` gives reproducible `release` / `release-clangcl` / `debug-asan` builds. Standalone `pip install cmake` (4.4.4) is only needed if you want a version newer than VS's. | HIGH |
| MSVC `cl` as the default compiler, flags `/O2 /Oi /GL /arch:AVX2 /MT /utf-8 /permissive- /W4` + linker `/LTCG` | 14.44 | Release builds | Zero extra install, best debugger, `/arch:AVX2` also defines `__AVX2__` so `#ifdef __AVX2__` NNUE paths work. `/MT` links the CRT statically so `engine.exe` runs from any folder or machine without the VC redistributable (important when fastchess launches it). | HIGH |
| `clang-cl` (VS "C++ Clang tools", `-T ClangCL`) | bundled | Optional second compiler | Chess engines usually run 5-15% faster under Clang/GCC than MSVC; also a second compiler catches UB. Add as a preset, benchmark with the `bench` command, keep whichever is faster. Do not make it a hard dependency. | MEDIUM |
| Hand-rolled bitboards: 64-bit `uint64_t` sets, **magic bitboards** for sliders, with PEXT indexing behind `-DUSE_PEXT=ON` | n/a | Board, attack tables, move generation | Magic bitboards are portable and fast everywhere; PEXT is faster only on Intel Haswell+ and AMD Zen 3+ (Zen 1/2 microcode PEXT is very slow, per TalkChess threads). Since the end goal is a public product on unknown CPUs, default to magics, benchmark PEXT on this Zen 3, and only enable if it measurably wins. Legal move generation by pin/check masks (or pseudo-legal + legality check), validated by perft. | HIGH (approach), MEDIUM (PEXT payoff on Zen 3) |
| Hand-rolled UCI loop (~300 lines) | n/a | UCI protocol | No C++ UCI library is worth a dependency; the protocol is a line parser. Own it so you control custom commands (`bench`, `perft`, `datagen`, `eval`, `d`) and `info` output (depth, seldepth, score cp/mate, nodes, nps, time, pv, hashfull) that the live-thinking UI needs. | HIGH |
| NNUE inference: hand-written AVX2 intrinsics with a **scalar reference path** | n/a | Evaluation | Standard NNUE design: sparse first layer kept as an int16 **accumulator** updated **incrementally** (add/subtract the weight columns of the features a move changes; full refresh only on events like king moves if using king buckets), then small int8/int16 dense layers with `_mm256_madd_epi16`, clipped-ReLU or SCReLU activation. Scalar path = test oracle and portability fallback. Zen 3 has no AVX-512, so AVX2 is the ceiling. | HIGH (design), MEDIUM (exact layer shapes, decided in the architecture phase) |
| Own weights file format: magic + version + arch id + hash + quantized int16/int8 blobs | n/a | Net loading | Versioned so a policy head can be added later without breaking old nets (PROJECT.md requirement). Loaded with `std::ifstream`; avoid `incbin`-style embedding in v1 (one more Windows build gotcha). | HIGH |
| Catch2 (via CMake `FetchContent`) | v3.16.1 (2026-10-08) | C++ unit tests, perft suite as test cases | Mainstream, header+lib, CTest integration. doctest 2.5.3 is an equally fine lighter alternative. | HIGH |
| Built-in `bench` UCI command (fixed-depth search over a fixed FEN list, prints total nodes + nps) | n/a | Benchmarking and determinism check | Stockfish convention: the **node count is a signature**; if a "non-functional" change alters it, you broke something. nps tracks speed. Beats an external benchmark library for this job. Google Benchmark 1.9.5 is optional for micro-benchmarks of `accumulator_update`. | HIGH |
| Windows profiler: Visual Studio CPU Usage profiler (Enterprise includes it) | n/a | Hot-spot finding | Already installed; no extra tool. | MEDIUM |

**Do not copy code from Stockfish (GPL-3.0).** PROJECT.md wants a license-clean public product. Take the *ideas* (NNUE accumulator, TT, LMR, history heuristics) from the Chess Programming Wiki and papers, write the code yourself. Disservin's `chess-library` (MIT, header-only) is acceptable as a test oracle or a bootstrap move generator, but its API does not expose the make/unmake hooks that incremental accumulators need, so the engine's own board should be hand-rolled.

### Python Training Side

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| **Own PyTorch trainer** (~300-500 lines) | torch 2.9.1+cu130 (already installed) | Train the eval net | `nnue-pytorch` (official-stockfish, GPL-3.0) is built for Linux/conda/Docker, needs a compiled C++ sparse data loader, and its recommended recipe wants 800+ GB of data; it is also a Stockfish-architecture trainer, which PROJECT.md says to use as reference only. A custom trainer lets the architecture be designed "together in its own phase", adds a policy head later, and is readable by a user new to ML. Sparse first layer = `torch.nn.EmbeddingBag` (sum mode) over feature indices, two perspectives, then a few `Linear` layers; loss = MSE on `sigmoid(score/K)` blended with game result (lambda). Plain fp32 + TF32 is fine for a net this small on Ampere. | HIGH (choice), MEDIUM (throughput, see Gaps) |
| **Bullet** (jw1912/bullet, Rust, MIT) as the documented **fallback trainer** | no tagged releases; track `main` (pushed 2026-10-12) | If the PyTorch trainer cannot keep the 3060 busy, or to cross-check a trained net | "Best-in-class" NNUE trainer, supports NVIDIA CUDA, Windows is supported (`bullet-utils[.exe]`), MIT licensed, builds with `cargo r -r --example simple` once Rust + CUDA toolkit are present (nvcc 13.2 already is). Its `simple` example `(768 -> N)x2 -> 1` is the recommended first architecture. Architecture lives in Rust code, which is why it is the fallback, not the default. | MEDIUM |
| **Bulletformat-compatible 32-byte training records** | n/a | On-disk dataset format | Fixed-size record = occupancy `u64` + 32 piece nibbles + score `i16` + result `u8` + king squares + padding, side-to-move-relative. Fixed size means `np.memmap` random access with no parser. Being bulletformat-compatible means Bullet and `bullet-utils` (shuffle, interleave, validate, convert) work on the same files at zero cost, so the fallback is free. Write this format once in the C++ `datatool`/`datagen` and read it in numpy. Confirm the exact byte layout against bullet's `docs/3-data.md` and source before freezing. Do not use Stockfish `.bin`/binpack: binpack is a compressed game-chain format whose loader is the hard part (that is why nnue-pytorch has a C++ loader). | MEDIUM (layout from memory) |
| numpy | 2.4.6 installed (2.5.4 latest) | memmap, batching | No upgrade needed. | HIGH |
| Feature expansion **on the GPU** | n/a | Data loading that keeps up | Ship raw occupancy + nibbles to the GPU, expand to feature indices with vectorized torch ops there. This removes the Python per-position cost and the need for a compiled loader. Use a background **thread** (numpy memmap reads release the GIL) with a prefetch queue and pinned memory. | MEDIUM |
| `torch.utils.data.DataLoader` with `num_workers>0` | n/a | NOT recommended on Windows | Windows uses `spawn`, so worker start-up is slow and each worker re-imports torch; the thread+memmap design above avoids it. | HIGH |
| `torch.compile` | n/a | NOT recommended | Needs MSVC + Triton on Windows; high risk, small net does not need it. Run eager. | MEDIUM |
| orjson | 3.13.0 | Fast JSONL parsing | Lichess eval dump is JSON-per-line; orjson is several times faster than `json`. | HIGH |
| zstandard | 0.25.0 (installed) | Stream `.zst` | `ZstdDecompressor().stream_reader(...)`; Lichess files use a large window, so pass `max_window_size=2**31` or you get a "window too large" error. Always open in binary mode. | MEDIUM |
| `chess` (**PyPI name is `chess`, not `python-chess`**) | 1.11.2 (2025-02-25; repo still active, last commit 2026-08-22) | FEN/PGN parsing for low-volume data (uploaded games, tests), legality oracle | `pip install python-chess` installs a 1.999 shim from 2020 that depends on `chess`; install `chess==1.11.2` directly. GPL-3.0: fine for a hosted backend (network use is not distribution), note it if you ever ship the Python code. | HIGH |
| TensorBoard | 2.21.0 | Loss curves during training | Local, no account; `torch.utils.tensorboard`. Training *history shown in the product* comes from SQLite rows, not TensorBoard. | HIGH |
| Weights & Biases / MLflow | wandb 0.30.0 / mlflow 3.17.0 | NOT recommended | Account/cloud (W&B) or a second database and server (MLflow) duplicating the project's own `training_runs` / `candidates` tables and dashboard. | MEDIUM |

**Bootstrap data source: the Lichess evaluation dump, not PGNs.** `lichess_db_eval.jsonl.zst`: **416,442,401 positions evaluated with Stockfish, CC0, 22.4 GB compressed**, updated 2026-10-05 (HIGH, read from database.lichess.org). One JSON object per line: `fen` (no move counters), and `evals[]` each with `knodes`, `depth`, `pvs[]` (`cp` or `mate`, `line`). Lichess's own advice: take the eval with the highest depth and its first PV. This gives (position, deep-search score) pairs, exactly the label type Stockfish trains on (PROJECT.md "Domain facts"), with no PGN parsing. Practical consequences:

- **Do not download all 22 GB onto D:.** Stream from the start and stop after N positions (100-200M is plenty for a laptop-size net). A truncated `.zst` still decodes up to the cut, so an HTTP `Range` download of the first ~6-8 GB is valid. Convert to 32-byte records (150M x 32 B = ~4.8 GB) on C:.
- Standard monthly game dumps are huge (September 2026: **29.2 GB** compressed for one month) and mostly lack engine evals. Use them only if you want result-labelled WDL data, and only a sample of one month.
- Filter before training: drop positions in check, positions whose best move is a capture/promotion (non-quiet), and mate scores or |cp| beyond a clip (e.g. 3000). Verify the sign convention (white-relative vs side-to-move) with a unit test on a known position before converting 100M rows.
- Do the conversion in **C++** (a `datatool` subcommand reusing the engine's FEN parser, ~100x faster than python-chess at roughly 20-50 us per `Board(fen)`), orjson-parse in Python workers feeding it, or parse in C++ entirely. Use python-chess only to validate samples.

### Python <-> Engine Bridge, Matches, Rating

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| **fastchess** | v1.8.2-alpha (2026-07-26), MIT, Windows x86-64 zip published | Engine-vs-engine matches, SPRT gating, rating matches | Maintained (last push 2026-10-11), pentanomial stats, SPRT built in, handles up to 250 concurrent games, crash `-recover`, resume via `-config`, EPD/PGN openings. "alpha" is a label, not instability: it is the tool the chess dev community moved to. CLI verified from its `man.md`: `-sprt elo0= elo1= alpha= beta= model=(normalized\|logistic\|bayesian)`, `-openings file= format=(epd\|pgn) order=random`, `-each tc=10+0.1 option.Hash=16 option.Threads=1`, `-engine cmd= name= nodes= option.X=`, `-concurrency N`, `-rounds N -repeat`, `-pgnout`, `-draw`/`-resign` adjudication, `-ratinginterval`. | HIGH |
| cutechess-cli (as fallback) | 1.5.1 (2026-06-14), GPL-3.0, win64 zip | Alternative runner | Older, slower, but if fastchess misbehaves on some engine quirk it is the reference implementation. Do not build both pipelines; keep one runner and swap only if blocked. | HIGH |
| `chess` `chess.engine` (`SimpleEngine.popen_uci`) | chess 1.11.2 | Drive UCI engines from Python for interactive play, analysis, relabelling | Handles UCI handshake, options, `go` limits, parsed `info` stream (`engine.analysis()`), clean shutdown. Use the **synchronous `SimpleEngine` from worker threads**: it runs its own private asyncio loop, avoiding the Windows asyncio-subprocess trap (see Pitfalls below). | HIGH |
| **Stockfish** | sf_19 (2026-09-05), GPL-3.0, Windows asset `stockfish-windows-x86-64-universal.zip` | The external yardstick | Pin one exact version in config and **store the version string + options with every rating row**; its limited-strength mapping can change between releases. Do not commit or ship the binary (GPL); keep `STOCKFISH_PATH` in env. Verify the unpacked build uses AVX2/BMI2 (`uci`/`bench` output `compiler` line) since the asset is a "universal" package. | MEDIUM (asset layout) |
| Stockfish limited strength: `UCI_LimitStrength=true`, `UCI_Elo=<1320..3190>` | verified in Stockfish master source: `LowestElo = 1320`, `HighestElo = 3190` | Capped opponents | `UCI_Elo` overrides `Skill Level` (0-20). Ladder anchors e.g. 1600 / 1900 / 2200 / 2500 / 2800. **The nominal numbers are not CCRL Elo**: the README calibration is stated as 60s+0.6s anchored to CCRL 40/4, and forum users report real strength differs. Treat results as "Elo relative to Stockfish-capped levels at our time control", which is all the product needs (a measured, reproducible rise). Pick opponent levels within about 200 Elo of the engine so scores stay in 25-75%; wider gaps give noisy estimates. | HIGH (range), MEDIUM (calibration) |
| Own Elo computation in Python (~60 lines) from W/D/L (or pentanomial) vs each anchor: logistic MLE + confidence interval, combine anchors | n/a | Rating number for the dashboard | fastchess already prints Elo +/- and LOS per match; parse that for the pairwise number, then combine multiple Stockfish levels in Python with the anchor Elos. This avoids a dependency on stale tools. | MEDIUM |
| Ordo | v1.2.6 (last repo push 2023) | Optional, not v1 | Fine for a multi-engine pool ranking, but unmaintained and the single-opponent-family case does not need it. BayesElo is older still. | MEDIUM |
| Openings: `official-stockfish/books` | `UHO_Lichess_4852_v1.epd.zip` (43 MB), `8moves_v3.pgn.zip`, `UHO_4060_v4.epd.zip` | Opening diversity for gating and rating | Without a book every game from the start position repeats and SPRT/rating is invalid. UHO sets are pre-balanced (near-equal evals). Use `-openings ... order=random -repeat` so each opening is played with both colors. Unzip to the space-free artifacts dir. | HIGH |
| `psutil` | 7.2.2 | Kill process trees, CPU/mem monitoring | `subprocess` on Windows does not kill grandchildren (fastchess spawns engines). | HIGH |

**Match settings (opinionated defaults):**
- **Promotion gating** (candidate vs current net, same engine binary, different `EvalFile`): fixed **nodes** per move (e.g. `nodes=20000`, tune in the gating phase), `Threads=1`, `Hash=16`, `-repeat`, UHO_Lichess_4852 openings, `-sprt elo0=0 elo1=5 alpha=0.05 beta=0.05`, game cap (a few thousand) after which "not promoted". Fixed nodes make the result independent of laptop thermal throttling and background load. Same architecture means same speed, so nodes are a fair budget; revisit if a future net is slower to evaluate.
- **Rating vs Stockfish**: time-based (`tc=10+0.1`, both `Threads=1`), because Stockfish's limited-strength is calibrated on time, not nodes. Concurrency about 6 (leave cores for turbo headroom), 400-1000 games per anchor per net version. Run rating jobs when nothing else heavy is running.
- **Self-play data generation**: do NOT run fastchess and scrape PGN comments. Add a **`datagen` mode inside the C++ engine** (multi-threaded, fixed nodes, random opening plies from a book, writes 32-byte records with search score + final result) and have Python launch it as a job. This is the standard design (Stockfish `gensfen`, Viridithas/Bullet-era engines). Rough order of magnitude: 14 threads x ~1M nps / 5k nodes per move is a few thousand positions per second, i.e. around 10M positions per hour (LOW; measure it).

### Backend API

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| **FastAPI** | 0.143.0 (0.139.0 installed; upgrade is routine) | HTTP API + live streams | Replace the 20-line Flask file, do not migrate it. Pydantic v2 validation, OpenAPI for free, first-class async, and **native SSE** (`from fastapi.sse import EventSourceResponse, ServerSentEvent` exists in the installed 0.139). Flask can stream but has no typed models and weak async. | HIGH |
| Pydantic | 2.14.1 | Request/response schemas | Ships with FastAPI. | HIGH |
| uvicorn | 0.54.0 (0.40.0 installed) | ASGI server | `uvicorn[standard]`. **Windows: do not use `--reload` together with asyncio subprocesses** (see Pitfalls). Run dev without `--reload`, or use `watchfiles`-based restart in a wrapper. Port 8000 to match the existing Axios base URL. | HIGH |
| SQLite (WAL mode) via **SQLAlchemy 2.0.x** (sync engine) + **Alembic** 1.20.0 | SQLAlchemy `>=2.0.41,<2.1` (2.1.4 was released 5 days ago, wait for it to settle; already installed 2.0.41) | Database | `PRAGMA journal_mode=WAL; foreign_keys=ON; busy_timeout=5000` on every connection (API and worker both write). Alembic with `render_as_batch=True` (SQLite ALTER support). **Postgres-ready rules**: no SQLite-only types or `AUTOINCREMENT` tricks, use `JSON` and `DateTime(timezone=True)`, explicit naming conventions for constraints, claim jobs inside a transaction so `with_for_update(skip_locked=True)` can be added later, UUID or integer PKs consistently. Swap to `psycopg[binary]` 3.x later by changing the URL. Use sync sessions in `def` endpoints; do not add `aiosqlite` (0.22.1): the DB is never the bottleneck here and async SQLite adds complexity for no gain. | HIGH |
| **Custom job runner**: `jobs` table in the DB + one `python -m worker` process that claims jobs and runs each as a child process | n/a | Self-play, training, matches, ingestion, rating | The hard part of these jobs is supervising long-running external processes (engine `datagen`, `python train.py`, `fastchess`): start, stream JSON-line progress, cancel, kill the whole tree, survive restarts. A queue library does none of that. **Execution rule: one heavy job at a time** (GPU training, 14-thread datagen and rating matches fight for CPU, GPU, thermals). Progress goes to DB rows; the API tails them and re-emits over SSE. Keep the claim/complete logic behind a tiny interface so it can move to a Postgres queue later. About 200-300 lines. | HIGH |
| Celery 5.6.3 | NOT recommended | Needs a broker (Redis/RabbitMQ) and is not officially supported on Windows since 4.x. | n/a | HIGH |
| RQ 2.12.0 | NOT recommended | Relies on `fork()`, does not run on native Windows; needs Redis. | n/a | HIGH |
| Dramatiq 2.2.1 / ARQ 0.28.0 / Huey 3.4.0 | NOT recommended for v1 | Dramatiq and ARQ require Redis/RabbitMQ (no native Windows Redis); Huey+SQLite would work but you still hand-write the process supervision. Revisit when moving off the laptop. | n/a | MEDIUM |
| FastAPI `BackgroundTasks` | NOT for these jobs | Dies with the request worker, no persistence, no cancel. Fine only for tiny post-response work (e.g. saving a finished game). | n/a | HIGH |
| pytest 9.1.1 + httpx (FastAPI `TestClient`) + ruff 0.17.0 | pinned in dev extras | Backend tests and lint | Standard. | HIGH |
| Engine access from the API | n/a | Play + live thinking | A small **engine pool** of `SimpleEngine` UCI subprocesses, each request sends the full position (`position startpos moves ...` or FEN) then `go`. This keeps the API stateless in the sense PROJECT.md asks for (game state = move list in DB), at the cost of re-sending the position, which is trivial. Coalesce `info` lines to about 10 updates/s before pushing over SSE. | HIGH |
| API error shape | n/a | Cookbook compatibility | FastAPI's default 422 body (`detail: [...]`) differs from the cookbook's envelope + field-errors convention. Add global exception handlers and a response wrapper so the cookbook's `react-data-layer` skill works unchanged. Decide the envelope once, in the API phase. | HIGH |

### Frontend

The Khalil React Cookbook is mandatory (tokens not hex colors, env config not hardcoded hosts, shared constants in one place, route through `task-to-files-map.md`, invoke the four skills). The cookbook already uses axios + zustand, and its knowledge base already covers **Recharts**, so the choices below follow it.

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| React | 19.3.0 latest (scaffold has `^19.0.0`) | UI | Already in repo. | HIGH |
| Vite | scaffold has `^6.2.0`; latest is 8.3.4 | Dev server/build | **Keep the scaffold's Vite 6 + plugin-react 4 for v1 unless the cookbook retrofit bumps them.** `@vitejs/plugin-react` 6.x requires Vite 8, so they move together; do it as a separate chore, not mixed into feature work. Vite 8 needs Node 20.19+ (you have 20.20). Use the Vite dev **proxy** for `/api` to avoid CORS entirely. | MEDIUM |
| **react-chessboard** | 5.12.1 (2026-08-16), MIT, peer `react ^19` | Board | React-idiomatic, drag/drop and click-to-move, custom arrows (best-move arrow) and square styling. Its colors are props, so board themes can come from design tokens. | HIGH |
| **chess.js** | 1.4.0 (BSD-2-Clause) | Client-side legality, SAN, game state | Standard pair for react-chessboard. Client legality is UX only (frontend guards are UX-only, per cookbook); the server/engine remains the authority. | HIGH |
| **Chessground** | 10.4.2 (`@lichess-org/chessground`) | NOT recommended | **GPL-3.0.** Shipping GPL JavaScript to every browser forces the frontend to GPL, which conflicts with the "public product, license-clean" constraint. Superior animation is not worth that. | HIGH |
| **Server-Sent Events** via native `EventSource` | browser built-in | Live engine thinking, job progress | The traffic is one-directional (server -> browser); moves, "stop", "train now" are ordinary POSTs. SSE gives automatic reconnect and `Last-Event-ID` resume, plain HTTP through Vite proxy, trivial FastAPI side. Multiplex: one stream for the current game's thinking, one for job/dashboard events. Auth later: cookie-based (EventSource cannot set headers); if bearer tokens are required, use `fetch` streaming with `eventsource-parser` 4.1.1 rather than `@microsoft/fetch-event-source` (2.0.1, unmaintained). WebSocket only becomes worthwhile if v2 adds clocks/two-way low-latency play; not in v1. | HIGH |
| Recharts | 3.10.1, peer React 19 OK | Elo-over-versions chart, training history | Matches the cookbook (it has Recharts notes: color by semantic key, definite-height ancestor, tooltip dataKey). Data volume is tens to hundreds of points, so no need for uPlot (1.6.32) or ECharts. | HIGH |
| Eval bar, move list, PV line, mistake markers | custom components | Play + post-game review | Small, token-styled components; not worth a library. | HIGH |
| zustand 5.0.15 / axios 1.20.0 / react-router-dom 7.18.4 | as in scaffold | State, HTTP, routing | Per cookbook. Do not add TanStack Query (5.104.2) unless the cookbook's data-layer skill adopts it: two data-fetching idioms in one app is the actual cost. | MEDIUM |
| Vitest 5.0.4 + Playwright | dev | Component tests + UI audit | Playwright is what the cookbook's `react-uiux-audit` skill drives. | MEDIUM |
| `stockfish` (npm WASM) | NOT recommended | Looks tempting for client-side analysis | Duplicates the server engine, and would put a second (GPL) engine in the browser. The project's engine is the one that must be shown. | HIGH |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not / When |
|----------|-------------|-------------|----------------|
| Compiler | MSVC `cl` (+ `clang-cl` preset) | MinGW-w64/GCC (MSYS2) | Stockfish's own builds are GCC/MinGW and often fastest, but it adds a second toolchain/shell/CRT to maintain beside VS. Only worth it if `clang-cl` is not enough and you want to chase the last 5%. |
| Build | CMake + Ninja/VS generator | Meson, plain Makefile, vcpkg/Conan | Zero third-party C++ dependencies besides Catch2 (FetchContent); a package manager is overhead. |
| Move gen | Hand-rolled magic bitboards | `Disservin/chess-library` (MIT) | Faster to a first working perft, but hides make/unmake internals that incremental NNUE updates need. Use it as a test oracle if wanted. |
| Move gen | Magic bitboards default | PEXT default | Slow on Zen 1/2, which matters for a public product. Compile switch instead. |
| Trainer | Own PyTorch trainer | nnue-pytorch | Linux/Docker/conda, compiled loader, Stockfish-specific, GPL, 800+ GB recipe. |
| Trainer | Own PyTorch trainer | Bullet | Better raw speed, but architecture edits mean Rust recompiles, adds a Rust toolchain, and the project says Python training. Kept as fallback via compatible data format. |
| Data format | bulletformat-style 32 B records | Stockfish binpack, `.bin` (PackedSfen), text FEN | Binpack needs a specialist loader; `.bin` is 40 B and Stockfish-specific; text is too slow to parse. |
| Bootstrap data | Lichess eval JSONL | Lichess game PGNs | PGNs are huge, mostly without evals; the eval dump is already the label type needed. |
| Match runner | fastchess | cutechess-cli 1.5.1 | Both work; fastchess is faster, lighter, SPRT/pentanomial first-class. |
| Elo calc | fastchess output + 60-line Python MLE | Ordo / BayesElo | Stale tools for a one-opponent-family case. |
| API | FastAPI | Flask 3.1.3 | Flask works, but typed schemas, OpenAPI and SSE are what this API is made of. |
| Queue | Custom DB-backed runner | Celery / RQ / Dramatiq / ARQ | No native-Windows story and/or Redis dependency; none supervises external processes. |
| Live transport | SSE | WebSocket | One-way data; reconnect and proxying are free with SSE. |
| Board UI | react-chessboard + chess.js | Chessground | GPL-3.0 in the browser bundle. |
| Experiment tracking | TensorBoard + own SQLite tables | W&B, MLflow | Cloud account / extra server for something the product's own DB must store anyway. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `pip install python-chess` | Installs a 2020 shim (1.999) | `pip install chess==1.11.2` |
| Stockfish source or its network files | GPL-3.0; PROJECT.md bans starting from its net and wants a clean license | Own code, own weights |
| `uvicorn --reload` + asyncio subprocess on Windows | uvicorn switches to `SelectorEventLoop` there, which cannot create subprocesses (`NotImplementedError`) | `SimpleEngine` in threads; run without `--reload`; or set `WindowsProactorEventLoopPolicy` in the entry point |
| PyTorch `DataLoader(num_workers>0)` for this workload | Windows `spawn` cost, per-worker torch import | In-process thread prefetch over a memmap |
| `torch.compile` on this setup | Windows Triton/MSVC fragility | Eager mode |
| `/fp:fast` anywhere in the engine | Non-determinism; the engine path should be integer anyway | Default `/fp:precise` and integer NNUE |
| `std::aligned_alloc` | Missing in MSVC | `_aligned_malloc`/`_aligned_free` or `operator new(size, std::align_val_t{64})` |
| `incbin`/embedding the net in the exe | Another MSVC/GCC portability tangle | Load `EvalFile` at startup |
| Training after every game | Rejected in PROJECT.md | Batched + SPRT-gated |
| Python-driven search or MCTS for strength | Rejected in PROJECT.md | C++ alpha-beta |
| Redis/WSL just to get a queue | New always-on service on a laptop | DB-backed runner |

## Installation

```bash
# --- Python env (project venv, Python 3.12; torch/numpy/zstandard already present) ---
pip install "chess==1.11.2" "fastapi==0.143.0" "uvicorn[standard]==0.54.0" \
            "pydantic==2.14.1" "sqlalchemy>=2.0.41,<2.1" "alembic==1.20.0" \
            "orjson==3.13.0" "psutil==7.2.2" "tensorboard==2.21.0"
pip install -D pytest==9.1.1 httpx ruff==0.17.0   # dev extras (use your tool's dev-group syntax)

# --- C++ toolchain (nothing to install; use VS 2022's bundled tools) ---
# From "Developer PowerShell for VS 2022":
cmake --preset release && cmake --build --preset release
# From a plain shell (no vcvars), use the VS generator, it finds MSVC itself:
#   "C:/Program Files/Microsoft Visual Studio/2022/Enterprise/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe" \
#       -S . -B build -G "Visual Studio 17 2022" -A x64
#   ... --build build --config Release

# --- Match tooling (download, unzip into a space-free dir, never commit) ---
# fastchess v1.8.2-alpha : fastchess-windows-x86-64.zip   (github.com/Disservin/fastchess/releases)
# Stockfish sf_19         : stockfish-windows-x86-64-universal.zip (github.com/official-stockfish/Stockfish/releases)
# Openings                : UHO_Lichess_4852_v1.epd.zip (github.com/official-stockfish/books)

# --- Frontend (adds to the existing scaffold) ---
npm install react-chessboard@5.12.1 chess.js@1.4.0 recharts@3.10.1
# keep axios / zustand / react-router-dom / react-i18next as in the scaffold
```

## Windows-Specific Gotchas (flag these in phase plans)

1. **No `cl`/`cmake`/`ninja` on PATH in Git Bash or plain PowerShell.** Either use the "Developer PowerShell for VS 2022", call `vcvars64.bat` first, or use the `Visual Studio 17 2022` generator which needs no environment setup. Decide once and put it in a `build.ps1`.
2. **Space in repo path** (`Chess Engine`): quote everything, and keep nets, books, engines and datasets in a space-free `C:\chess-artifacts\` referenced by env vars (`ENGINE_PATH`, `STOCKFISH_PATH`, `ARTIFACTS_DIR`). fastchess `cmd=` and `option.EvalFile=` arguments are the usual breakage.
3. **Disk**: D: has ~20 GB free. Datasets, game pools and checkpoints go to C: (69 GB free) with a size budget; add a disk-space check to the ingest job.
4. **Long paths / CRLF**: enable `LongPathsEnabled` (registry) and `git config core.longpaths true`. Open PGN/EPD/zst files in **binary** mode and strip `\r` in any hand-written scanner; python-chess `chess.pgn` tolerates CRLF, custom line splitters do not. Add `.gitattributes` forcing LF for `.epd`, `.pgn`, `.cpp`, `.h`, `.py`.
5. **MSVC**: `/arch:AVX2` enables AVX2 codegen and `__AVX2__`, but `_pext_u64` still needs BMI2 hardware (Zen 3 OK); define `NOMINMAX`, `WIN32_LEAN_AND_MEAN`, `_CRT_SECURE_NO_WARNINGS`; use `/utf-8`; `/MT` for the engine so no VC redistributable; no VLAs, no GNU `__builtin_*` (use `<bit>`).
6. **Killing processes**: `terminate()` does not kill children. Start jobs with `CREATE_NEW_PROCESS_GROUP` and kill the tree with `psutil`.
7. **Defender**: exclude the build dir, artifacts dir and venv; real-time scanning slows process spawns (fastchess) and memmap reads measurably.
8. **Thermals**: a laptop boosts hard for a few minutes then throttles. Fixed-node gating is immune; time-based Stockfish rating is not, so keep concurrency conservative and record CPU load with each rating run.

## Stack Patterns by Variant

**If the PyTorch trainer cannot exceed roughly 1M positions/s on the 3060:**
- Spike Bullet on the same 32-byte files (`cargo r -r --example simple`), compare throughput and final loss, keep the Python orchestrator calling it as a subprocess.
- Because the data format is shared, nothing else changes.

**If the final net is wide enough that AVX2 inference is the bottleneck:**
- Move to int8 weights in the second layer, SCReLU with `madd`, and a king-bucketed or output-bucketed layout; keep the scalar path as the oracle. These are architecture-phase decisions.

**If a policy head is added later (deferred in PROJECT.md):**
- The net file header carries an arch id and a section table; the trainer already has a multi-head loss function; the engine loads optional sections.

**If the project moves to a server (public product):**
- Swap SQLite URL for Postgres (`psycopg`), the job runner for a Postgres-backed queue, run the worker on a GPU machine, serve the SPA statically, and keep the engine pool as separate processes. No change to the engine, SSE, or schemas.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| torch 2.9.1+cu130 | numpy 2.4.6 (installed), Python 3.12.7, driver for CUDA 13.x, nvcc 13.2 | Working per PROJECT.md; leave pinned. |
| fastapi 0.143.0 | pydantic 2.14.x, starlette (pulled in), Python >= 3.10 | `fastapi.sse` present from at least 0.139. |
| SQLAlchemy 2.0.41+ | alembic 1.20.0 | 2.1.x requires Python >= 3.11 and is newly released; stay on 2.0.x for v1. |
| react-chessboard 5.12.1 | react ^19, react-dom ^19 | v5 API differs from v4 (options object); do not copy v4 snippets from older tutorials. |
| @vitejs/plugin-react 6.x | vite ^8 only | Do not bump one without the other; scaffold's plugin-react 4 pairs with Vite 6. |
| Vite 8.3.4 | Node ^20.19 or >=22.12 | Node 20.20.0 here is fine. |
| zustand 5.0.15 | react >= 18 | OK. |
| fastchess v1.8.2-alpha | engines speaking UCI on Windows | Engine must flush stdout after every line and answer `isready`; test with fastchess early. |
| Stockfish sf_19 | fastchess `option.UCI_Elo`, `option.UCI_LimitStrength` | Range 1320-3190 from master source. |
| chess 1.11.2 | Python 3.12 | Last release Feb 2025; project is active, API stable. |

## Gaps To Resolve In Phase Research

- **Trainer throughput on the 3060 (LOW):** the 1-5M positions/s figure for an EmbeddingBag-based trainer is an estimate. Phase 1 of training should include a 1-hour throughput spike before committing the pipeline design.
- **Bulletformat exact layout and Bullet-on-Windows build with CUDA 13.2 (MEDIUM/LOW):** read `docs/3-data.md` and source, and try a 10-minute build before relying on the fallback.
- **Lichess eval score sign convention and mate/clip handling (MEDIUM):** settle with a test on known positions.
- **Stockfish sf_19 "universal" Windows package contents (MEDIUM):** confirm which CPU variants are inside, and that `UCI_Elo` options behave identically to master.
- **Stockfish limited-strength behavior at 10+0.1 TC (MEDIUM):** measure that anchors at 1600-2800 are actually ordered and spaced as expected before building the Elo curve on them.
- **PEXT vs magics on Zen 3 (MEDIUM):** one `bench` comparison during the movegen phase.
- **clang-cl vs MSVC speed (MEDIUM):** one `bench` comparison once search exists.
- **Cookbook API envelope specifics:** read `01-rules/api-response-envelope.md` and `adr-002` in the API phase and mirror them in FastAPI handlers.

## Sources

- PyPI JSON API (live, 2026-10-12): `chess`, `fastapi`, `uvicorn`, `sqlalchemy`, `alembic`, `tensorboard`, `zstandard`, `orjson`, `pydantic`, `psutil`, `pytest`, `ruff`, `wandb`, `mlflow`, `celery`, `rq`, `dramatiq`, `arq`, `huey`, `numpy` (HIGH)
- npm registry (live): `react`, `vite`, `@vitejs/plugin-react`, `react-chessboard`, `chess.js`, `@lichess-org/chessground`, `recharts`, `zustand`, `axios`, `react-router-dom`, `@tanstack/react-query`, `vitest`, `eventsource-parser` (HIGH)
- GitHub releases API (live): Disservin/fastchess v1.8.2-alpha, official-stockfish/Stockfish sf_19, cutechess v1.5.1, michiguel/Ordo v1.2.6, Catch2 v3.16.1, niklasf/python-chess v1.11.2, lichess-org/chessground v10.4.2, Clariity/react-chessboard v5.12.1 (HIGH)
- https://raw.githubusercontent.com/Disservin/fastchess/master/man.md and README: CLI flags, SPRT, openings, concurrency (HIGH)
- https://raw.githubusercontent.com/official-stockfish/Stockfish/master/src/search.h and engine.cpp: `Skill Level` 0-20, `UCI_Elo` 1320-3190 (HIGH)
- https://database.lichess.org/ : eval dump size/format/license; HEAD requests gave 22,423,777,007 bytes (eval dump) and 29,224,520,887 bytes (2026-09 standard rated) (HIGH)
- https://github.com/jw1912/bullet README and `docs/2-getting-started.md`, `docs/3-data.md`: CUDA/Windows, data formats, text format `FEN | score | result` (HIGH for stated facts)
- https://github.com/official-stockfish/nnue-pytorch README: Docker/conda setup, 800+ GB recipe (HIGH)
- https://github.com/official-stockfish/books : file listing (HIGH)
- https://fastapi.tiangolo.com/tutorial/server-sent-events/ and local import of `fastapi.sse` in 0.139.0 (HIGH)
- https://uvicorn.dev/concepts/event-loop/ via web search: Windows `SelectorEventLoop` with `--reload`/workers (MEDIUM)
- TalkChess threads on PEXT performance on Zen 1/2 (MEDIUM); Zen 3 PEXT being fast is background knowledge, unverified (LOW-MEDIUM)
- Stockfish README copies for UCI_Elo calibration "60s+0.6s, anchored to CCRL 40/4" (MEDIUM, secondary copies)
- Local environment probes: VS 2022 Enterprise MSVC 14.44, CMake 3.31.6, nvcc 13.2.51, disk free space, installed Python packages (HIGH)
- Khalil React Cookbook (`D:/TupCode/Khalil-React-cookbook`): axios/zustand/envelope conventions, Recharts knowledge notes (HIGH)

---
*Stack research for: self-improving chess engine (C++ alpha-beta + NNUE-style eval, Python training/API, React UI)*
*Researched: 2026-10-12*
