# Project Research Summary

**Project:** Chess Engine (self-improving, browser-played; C++ alpha-beta with NNUE-style eval trained in Python)
**Domain:** Self-improving chess engine on one Windows laptop (RTX 3060 Laptop 6 GB, Ryzen 9 5900HS 8C/16T, 16 GB RAM); public product later
**Researched:** 2026-10-12
**Confidence:** MEDIUM-HIGH overall. Tool and version facts read live. No published Elo-vs-data curve exists for this scale; C++ inference speed is unmeasured.

## Executive Summary

This is a hybrid engine. Search is classical alpha-beta in compiled C++; evaluation is a small NNUE-style net with our own weights, trained in Python on the Lichess evaluation database and then on the engine's own games. The project's Core Value (measured Elo rises because of training) depends almost entirely on the measurement harness being trustworthy. All four standard researchers and the deep dive agree: build and calibrate the harness before the learning loop, and build the loop before any polish.

Recommended order: (1) a correct C++ engine with a hand-written classical eval, proven by perft and a UCI conformance suite; (2) a match harness and rating pipeline on that classical engine, giving a measured baseline before any net exists; (3) the play UI and API, buildable in parallel with the net work; (4) Net v0 (768 to 256) with a bit-exact PyTorch-to-C++ parity test; (5) bootstrap training from a streamed subset of the Lichess eval dump; (6) self-play, gating, and promotion; (7) dashboards, hardening, and Option R. Stack: FastAPI with SQLite (WAL) and a DB-backed job runner (no Celery or Redis); React with react-chessboard and chess.js (not Chessground, which is GPL); SSE for live output; fastchess as the only match runner; Stockfish as an external capped-strength yardstick.

Main risks are measurement and data, not search speed. A 100 to 400 game gate cannot see 5 to 30 Elo gains, so it promotes noise. Parity bugs, label sign or alignment errors, and duplicate self-play games can each produce an engine that appears to train while it does not. Mitigations: calibrate the gate (A-vs-A and known-better tests), use fixed-node games for automated play, enforce a parity gate on every export, stream and filter all data, keep artifacts on C: in a space-free directory, and run one heavy job at a time.

**Scope conflict to resolve (do not silently change PROJECT.md):** PROJECT.md says v1 is done when the rating "has gone up at least once because of training." Four of five research files call this too weak. The proposed replacement is a statistical criterion, but it changes a stated requirement, so the user must approve it. *(Resolved 2026-10-12 during requirements: user approved the statistical criterion.)*

## Key Findings

### Recommended Stack
- C++20, CMake presets, VS 2022 MSVC 14.44 (`/arch:AVX2`, `/MT`); clang-cl optional. Hand-rolled bitboards, magic default, PEXT behind a switch. Hand-written UCI. Hand-written AVX2 NNUE inference with a scalar reference. Catch2 for tests. Do not copy Stockfish code (GPL-3.0).
- Own PyTorch trainer (torch 2.9.1+cu130 already works); 32-byte bulletformat-style records via numpy memmap; feature expansion on GPU. Bullet (Rust, MIT) is the fallback. nnue-pytorch rejected (Linux/Docker, compiled loader, GPL, Stockfish-specific).
- Bootstrap: `lichess_db_eval.jsonl.zst` (416M Stockfish-scored positions, CC0, 22.4 GB compressed). Stream a subset; never download fully to D:.
- FastAPI 0.143 + Pydantic 2 + native SSE (replaces Flask). SQLAlchemy 2.0.x (stay below 2.1) + Alembic; SQLite WAL with Postgres-portable DDL. Job runner = `jobs` table + one worker supervising child processes. Celery, RQ, Dramatiq, ARQ rejected.
- fastchess v1.8.2-alpha (MIT, Windows builds, SPRT and pentanomial built in); cutechess-cli 1.5.1 as fallback.
- Stockfish sf_19 as yardstick via `UCI_LimitStrength` + `UCI_Elo` (1320 to 3190). Pinned by hash, never committed.
- Frontend (cookbook-governed): React 19, Vite 6 kept for v1, react-chessboard 5.12.1, chess.js 1.4.0, Recharts 3.x, zustand, axios, native EventSource. Chessground rejected (GPL).

### Expected Features
- **Table stakes:** legal board with click and drag, hints, promotion picker, last-move and check highlights, LTR notation; engine reply with thinking state; live eval bar (White POV, sigmoid), PV in SAN, depth, nodes, nps, throttled to 4 to 10 Hz; game save with net version; resume after refresh; history; PGN export; post-game review job with cache and Lichess-style Win% classification (inaccuracy, mistake, blunder, best), accuracy %, eval graph, step-through; data pool panel with "Ready to train"; Train-now with disabled-with-reason states; run and candidate lists; promotion match view (W/D/L, score, Elo with 95% CI, SPRT status, plain decision reason); rating dashboard and history chart with error bars and a version-0 baseline; single job bar and global lock.
- **Differentiators:** plain-language explanations on every number; "this game added N positions"; net badge with rating and CI; improvement attribution (flag a rise only when intervals separate); provenance panel per net; auto-train toggle default OFF.
- **Defer:** takeback (with exclude-from-pool flag), jump-to-mistake, retry-from-here, multi-PV in review only, rollback UI, loss curves, Elo-vs-data chart, upload filters; later: strength levels, clocks, accounts, Lichess bot rating, free analysis board, ECO names, policy head.
- **Refuse:** strength sliders, clocks, multi-PV in play, Brilliant/Great labels, replay of uploads, always-on self-play, per-game training, absolute FIDE-like Elo claims.

### Architecture Approach
- API process (FastAPI: routers, services, repositories; in-process engine pool for human games only) and a separate worker process that claims DB jobs and spawns children: trainer, fastchess, C++ `datagen`, ingest. Browser talks only to the API: REST for commands, SSE for thinking and job progress.
- DB is the only shared mutable state; only API and worker write it. Bulk data (positions, PGN, nets) is in files referenced by keys.
- Rules: subprocess contracts are narrow (manifest or config in; JSON-lines or PGN plus exit code out); nets and shards are immutable and hashed; promotion moves one pointer in one transaction; games record `network_id`; nets load only at process start; automated games use fixed nodes; Elo stored as W/D/L, derived under a named protocol ID.
- Lanes: one exclusive **heavy** lane (prepare, label, self-play, train, gate, rate; max one job) and a **light** lane (ingest, review, shards; up to two jobs at 1 to 2 threads). Human games take priority and lower background concurrency. Cancel via sentinel file or stdin, then `taskkill /T`; children in a process group or Job Object.
- Public-product seams now: `owner_id` and `current_user()` (seeded `local` admin), `training_consent`, ULIDs, env-driven config, `EventBus` interface.

**Major components:**
1. Engine (C++): movegen, search, Evaluator interface, UCI, `bench`, `perft`, later `datagen`; `Threads=1` for automated games.
2. Net file: versioned header (magic, format version, arch id, feature set, scales, checksum, dataset hash); engine refuses mismatches.
3. EngineService and Game service: own UCI wrapper with reader thread; python-chess only for legality, SAN, PGN.
4. Job runner and ResourceManager: DB queue, heartbeats, crash recovery to `interrupted`, lane and CPU policy, power profile.
5. Arena and rating module: fastchess wrapper (config in, PGN out); pure Elo, CI, SPRT, LLR math with unit tests.
6. Trainer: manifest in, checkpoints and export out, smoke test; no DB access.
7. Frontend: API-only client; mock-first from this schema.

### Critical Pitfalls
1. **Move-gen bugs** surface weeks later as unexplained losses and poisoned data. Prevent with perft (start, Kiwipete, CPW 3 to 6), random-playout legal-set equality vs python-chess, incremental-vs-refresh assertions. Engine-core exit criterion.
2. **Under-powered gate** promotes noise and rejects real gains. Prevent with SPRT (pentanomial via fastchess), hard cap where inconclusive means reject, and calibration: A-vs-A must not promote; a known-better candidate must be detected.
3. **C++ inference disagrees with PyTorch** (feature indexing, perspective order, quantization overflow, rounding). Prevent with bit-exact parity on at least 10k positions per export, scalar reference, versioned header, trivial 768-to-64-to-1 net first.
4. **Lichess labels misread** (White POV, attached to the position after the move, mate tokens). Prevent with a hand-checked alignment test on five games, one stored sign convention, filters (not in check, quiet best move, |cp| clip, no mate, ply >= 8 to 10), dedup, game-level split.
5. **Self-play adds no information** (deterministic repeats; same-depth self-labels). Prevent with opening book and random plies, unique-game ratio check, deeper-search labels, offline-validated adjudication, replay mixing.
6. **Moving target:** Stockfish auto-update, option drift, chained head-to-head sums. Prevent with pinned hash, options, opening hash, and protocol version per rating row; never splice protocols.
7. **Windows hazards:** spaces in paths break `cmd=` and `EvalFile=`; cp1252 defaults and BOM; locked net files; orphan engines; Defender slowdown; `uvicorn --reload` breaks asyncio subprocesses. Prevent with argument lists, space-free `C:\chess-artifacts\` via env vars, UTF-8 everywhere, immutable nets with a pointer, psutil or Job Object tree-kill, reload off, path-with-space test from day one.

## Implications for Roadmap

Dependency-driven order: the instrument before the measured thing; the cheap rating match is the job queue's first customer; the play UI runs in parallel with the net work.

### Phase 0: Foundations and Conventions
**Rationale:** Environment and conventions block everything; space-in-path and disk constraints must be enforced from the start.
**Delivers:** Repo layout (`engine/`, `trainer/`, `backend/`, `frontend/`, `tools/`, `data/`); `ARTIFACTS_DIR` on C: in a space-free path; `build.ps1` with the VS generator; `.gitattributes` (LF for code and PGN/EPD); LongPaths; disk budget check; FastAPI skeleton, pydantic-settings, SQLAlchemy and Alembic with WAL pragmas, BlobStore, dev launcher; API envelope decided per cookbook `api-response-envelope.md` (not yet read).
**Avoids:** Pitfalls 18, 19; cookbook envelope mismatch (FastAPI 422 default).

### Phase 1: Engine Core
**Rationale:** Everything inherits its legality. Classical eval (material plus PST) is the baseline the net must beat.
**Delivers:** Magic-bitboard movegen with pin and check handling; perft suite; UCI with reader thread, `stop` and `isready` answered during search, flushed output, `setoption` that accepts paths with spaces; alpha-beta with TT (validated moves, mate-score ply adjustment, completed-iteration results only), bounded quiescence, fixed-node and fixed-depth limits (no `go infinite` on the web); `bench` with committed node signature.
**Avoids:** Pitfalls 1, 2, 4, 5, 25, 29 (single-thread v1; no Lazy SMP).
**Exit:** perft and random-playout oracle pass; UCI conformance script passes; 200-game fastchess smoke match with no hangs or forfeits.

### Phase 2: Measurement Harness and Rating Pipeline (first job)
**Rationale:** Validates the ruler before any net exists; gives the classical engine's baseline; proves job runner, progress, cancel, and crash recovery on a bounded CPU job.
**Delivers:** fastchess wrapper (argument lists, UHO openings with paired colors, concurrency = physical cores minus headroom, `-recover`, PGN out); pure rating math (W/D/L and pentanomial to Elo with CI, SPRT, LLR, LOS); Stockfish ladder runner (pinned binary, `UCI_LimitStrength` + `UCI_Elo` only, adaptive levels keeping scores near 15 to 85%); `ratings` keyed by protocol ID and derived from `matches`; jobs table, worker, ResourceManager v0, SSE progress.
**Avoids:** Pitfalls 13, 14, 15, 16, 19, 23.
**Exit:** A-vs-A does not promote across repeated runs; a clearly stronger candidate (for example 2x nodes) is detected within the cap; classical engine rating has CI at most about +/-40 Elo with 400+ games per bracketing level; ladder spacing measured and recorded.

### Phase 3: Play UI, API, Live Output, Review (parallel with Phases 4 and 5)
**Rationale:** Depends only on Phases 1 and 2 for UCI and DB; starts collecting human games early.
**Delivers:** Game service and games schema (`network_id`, `owner_id`, `training_consent`, `pool_status`); human-game engine pool with cap; SSE thinking stream at <=10 Hz, White POV, bound lines dropped, stale-message drop, one stream per game; react-chessboard board with tokens; eval bar (sigmoid); PV in SAN; move list; resume; PGN export; review job (fixed nodes per ply, cached by game and net); Win% classification from a shared constants module; accuracy; eval graph; cookbook states.
**Uses:** cookbook skills `react-project-setup`, `react-data-layer`, `react-ui-implementation`, `react-uiux-audit`.
**Avoids:** Pitfalls 22, 23, 24, 26, 27.

### Phase 4: Net Architecture and Inference (Net v0 = Option L)
**Rationale:** The one hard cross-boundary contract; freeze v0 early so trainer and engine can proceed on fixtures.
**Delivers:** Net v0: 768 to 256 per perspective, side-to-move first, CReLU, output with optional 8 piece-count buckets, about 0.2M parameters; versioned net file; AVX2 incremental accumulator with refresh; scalar reference; export tool with bit-exact parity test (integer simulation equals C++; float within stated tolerance); accumulator-equals-refresh assertions across captures, promotions, castling, en passant, king moves; weight clamping to quantizable range; overflow check; flip and mirror symmetry tests; `best_move` stored in every record from day one.
**Avoids:** Pitfalls 3 (store K and output scale in header; clamp inside mate range), 9.
**Exit:** Parity passes on >=10k positions every export; trivial 768-to-64-to-1 net proves the loop first; equal-node match of Net v0 vs classical runs.

### Phase 5: Bootstrap Data and Training
**Rationale:** Data and labels set the ceiling; measure before committing.
**Delivers:** Streaming ingest of `lichess_db_eval.jsonl.zst` (Range or stream of first 6 to 8 GB; zstd `max_window_size`); highest-depth eval and first PV; filters (not in check, quiet best move, |cp| clip about 2000 to 3000, no mate, dedup, ply >= 8 to 10); validation split by grouping (the eval set has no game IDs; document the choice); 32-byte record writer (C++ `datatool`) read via numpy memmap; trainer (AdamW, batch 16,384, LR decay, EMA, checkpoints, early stop on held-out loss); predict-mean and material baselines; export plus smoke test; bootstrap net registered and rated via Phase 2.
**Avoids:** Pitfalls 6, 7, 8 (lambda and K stored per run), 10, 18.
**Exit:** Alignment test passes on hand-checked games; held-out loss beats baselines; first "net vs classical" number measured with a CI.

### Phase 6: Closing the Loop
**Rationale:** Self-play without gating only damages the net faster; gating is proven on the bootstrap net first.
**Delivers:** C++ `datagen` (fixed nodes, opening book plus random plies, records with score, result, best move); self-play sessions with target count, stop that keeps finished games, unique-game check, adjudication validated offline; gating via fastchess SPRT (`elo0=0`, `elo1=5` to 10, alpha = beta = 0.05, hard cap, inconclusive = reject) on disjoint gating openings; atomic promotion (immutable `nets/<id>.nnue`, pointer change in one transaction, rollback kept); pool with source breakdown and "Ready to train"; Train-now and auto-train toggle (default OFF); replay-mixed training data; PGN ingest with validation report and move-hash dedup; training history view.
**Avoids:** Pitfalls 11, 12, 13, 20 (disjoint openings; purpose tag), 21 (promotion needs a match-evidence row), 27, 28.
**Exit:** Gate rejects a deliberately degraded candidate; promotion atomic and reversible; one full self-play, train, gate, promote cycle runs without manual DB edits.

### Phase 7: Rating Dashboard, Hardening, Option R
**Rationale:** Make the claim measurable and survivable; Option R must beat L by SPRT before adoption.
**Delivers:** Rating history by net version with error bars and version-0 baseline; improvement attribution; re-measurement on fresh openings; node-limited full-strength Stockfish ladder as second yardstick (UCI_Elo tops out at 3190); power profiles, sleep prevention, AC check, kill -9 resume tests, retention, orphan audit; public-seam audit; Option R (768 times 5 king buckets to 512, output buckets) trained on the full pool and gated against L.
**Avoids:** Pitfalls 14, 15, 17, 21, 30.

### Phase Ordering Rationale
- Engine correctness first: all later data inherits its bugs.
- Harness before net: the first measured number is the classical engine's, and the yardstick is validated before it is trusted.
- Play UI parallel to the net work: depends only on UCI and DB; collects human games early.
- Net contract frozen before trainer: both can proceed on fixtures.
- Self-play after gating: self-play without gating degrades the net.
- Option R and the statistical done-criterion last: they need the loop to exist.

### Decisions Needed (research conflicts to resolve)
1. **v1 done-criterion (conflicts with PROJECT.md; user approval required).** Current: "gone up at least once." Proposed: "net N+k measured at least X Elo above net N with non-overlapping 95% intervals on an independent re-measurement with held-out openings and the same protocol version." *Approved by user 2026-10-12.*
2. **Expected strength (unverified either way).** PROJECT.md expects 2000 to 2500 after a day or two of bootstrap. NET-ARCHITECTURE estimates 2800 to 3300 CCRL Blitz for a mature engine, from one developer's history, and warns the first search will be weaker. Do not promise either; Phases 2 and 5 replace both.
3. **Rating time control vs nodes.** STACK proposes time-based Stockfish ladder (`tc=10+0.1`); ARCHITECTURE and the cross-cutting rule say fixed nodes for all automated play. Recommended: fixed nodes for gating, self-play, and the ladder, plus a one-time calibration of the ladder spacing under the chosen protocol.
4. **Gate limit.** Fixed nodes for every gate decision (ARCHITECTURE, PITFALLS) versus fixed time for the final check (NET-ARCHITECTURE). Recommended: fixed nodes for decisions, plus one fixed-time confirmation per promotion, since a bigger net can look stronger at equal nodes while losing at equal time.
5. **Training record format.** STACK: 32-byte bulletformat-compatible (no best move). ARCHITECTURE and NET-ARCHITECTURE: 37-byte own format with `best_move`. Decide in Phase 4; leaning toward a 32-byte record plus a sidecar or variant carrying `best_move`. Settle before any bulk conversion.
6. **Auto-train default.** "Ready to train" on threshold; manual Train-now; auto-train toggle default OFF. *Approved by user 2026-10-12.*
7. **Heavy lane.** One exclusive heavy job for v1; GPU-training overlap with CPU self-play deferred until measured.

### Research Flags
Needs deeper research (`/gsd-plan-phase --research-phase`):
- **Phase 2:** Stockfish sf_19 spacing at the chosen protocol; fastchess SPRT option names and model default (verify with `fastchess --help`); UHO opening use.
- **Phase 4:** exact feature indexing, perspective and mirror conventions, quantization scales, bulletformat byte layout (confirm against bullet `docs/3-data.md`), AVX2 accumulator microbenchmark.
- **Phase 5:** `[%eval]` and eval-DB depth, sign, coverage and bias; throughput spike (EmbeddingBag vs dense; GPU feature expansion); Bullet CUDA 13.2 build on Windows if the fallback is needed.
- **Phase 6:** replay ratios, temperature, random plies, adjudication thresholds; no published laptop-scale recipe.

Standard patterns (skip research-phase):
- **Phase 0:** FastAPI, SQLAlchemy, Alembic; Windows conventions in STACK.md.
- **Phase 1:** Chess Programming Wiki (perft, magic bitboards, UCI, TT, aspiration).
- **Phase 3:** React and SSE patterns, governed by cookbook skills.
- **Phase 7:** operational work once the loop exists.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM-HIGH | Versions read live on 2026-10-12; MEDIUM on fastchess option names, sf_19 universal package contents, Bullet on Windows with CUDA 13.2, PEXT payoff on Zen 3 |
| Features | MEDIUM-HIGH | Play and review conventions documented; dashboard conventions from fishtest and cutechess practice; board and piece licences not fully verified |
| Architecture | MEDIUM-HIGH | Standard engine-dev patterns; throughput figures are estimates; cookbook envelope referenced, not read |
| Pitfalls | MEDIUM-HIGH | Engine and NNUE pitfalls long established; some forum sources LOW |
| Net architecture | MEDIUM-HIGH design, MEDIUM throughput, LOW Elo | Primary-source feature and quantization facts; trainer step measured, data loading and C++ inference unmeasured; no Elo-vs-data curve exists |

**Overall:** MEDIUM-HIGH for the plan and stack; LOW for any specific Elo outcome. Treat expected gains as hypotheses until Phase 2 baseline and Phase 5 bootstrap measurements exist.

### Gaps to Address
- **v1 done-criterion:** approved (statistical criterion, see Decision 1).
- **Expected strength:** both 2000 to 2500 and 2800 to 3300 unverified; measure in Phases 2 and 5.
- **Rating protocol:** time vs nodes; nodes-only vs fixed-time confirmation (Decisions 3 and 4); spacing test on pinned sf_19.
- **sf_19 universal package:** confirm CPU builds inside; check `bench` compiler line for AVX2 or BMI2.
- **fastchess:** verify SPRT option names and model default; calibrate bound semantics.
- **Lichess eval dump:** sign convention, depth distribution, coverage, bias; measure on a 1 GB sample; alignment test before converting 100M rows.
- **Eval-dump game IDs:** none; group by FEN or source-position hash for the validation split.
- **Bulletformat layout and Bullet on Windows:** confirm layout; try a 10-minute build before relying on the fallback.
- **Trainer throughput:** synthetic GPU-resident numbers only; run a one-hour spike in Phase 5.
- **C++ inference speed:** no compiler measurement yet; run the AVX2 microbenchmark in Phase 4.
- **PEXT vs magics; clang-cl vs MSVC:** one `bench` comparison each in Phase 1.
- **Cookbook API envelope:** read `01-rules/api-response-envelope.md` and ADR-002 in Phase 0.
- **Licence of self-generated labels:** labels from CC0 Lichess are clean; labels from running Stockfish ourselves need a licence check before any public-product phase.
- **Environment:** D: has about 20 GB free, so stream a subset of the 22 GB dump to C:. VS 2022 MSVC 14.44, CMake, Ninja exist but are not on PATH (use VS generator or Developer shell). Rust is not installed (only needed for Bullet fallback).
- **Repo state:** `backend/app.py` is the Flask hello-world (replace, do not extend); Axios base URL 8000 vs Flask 5000 mismatch; `frontend/` is auth boilerplate to retrofit per cookbook.

## Sources

**Primary (HIGH):** PyPI, npm, and GitHub releases read 2026-10-12 (fastapi, uvicorn, sqlalchemy, alembic, chess 1.11.2, orjson, zstandard, psutil, react-chessboard 5.12.1, chess.js 1.4.0, recharts 3.10.1, fastchess v1.8.2-alpha, Stockfish sf_19, cutechess 1.5.1, Catch2 v3.16.1); fastchess `man.md`/README; Stockfish master `search.h`, `engine.cpp`, `nnue_architecture.h`, `half_ka_v2_hm.h`; nnue-pytorch `nnue.md`, architecture history, training docs; Stockfish 19 release notes; database.lichess.org (eval dump 416,442,401 positions, CC0, 22.4 GB; ~6% of standard games have `[%eval]`); bullet README and docs; FastAPI SSE docs; Lichess accuracy page; Chess.com classification help; local probes (MSVC 14.44, nvcc 13.2, disk, installed packages, measured trainer throughput on RTX 3060 Laptop); Khalil React Cookbook (envelope doc not fully read).

**Secondary (MEDIUM):** Chessprogramming wiki (SPRT, fishtest bounds, NNUE, Fastchess, Cutechess); Leorik README (one developer's claims); Viridithas NNUE write-up; Lc0 format docs; Rapfi (arXiv 2503.13178); DeepMind no-search chess (arXiv 2402.04494); vdbergh pentanomial; Fishtest FAQ; arXiv 2412.17948 (noisy NNUE data); Stockfish PRs #4314, #4465; Stefan Pohl NN-vs-SF page.

**Tertiary (LOW, validate):** TalkChess threads (UCI_Elo drift, NNUE fine-tuning and forgetting, Lichess filtering, Lc0 noise); Mantissa v3.3.0 notes; continual-learning papers (arXiv 1612.00796, 2604.13627); throughput and games-per-hour estimates.

---
*Research completed: 2026-10-12*
*Synthesizer note: the synthesizer subagent was blocked from writing this file by the harness and returned it inline; the orchestrator persisted it unchanged except for the two "approved by user" annotations.*
*Ready for roadmap: yes.*
