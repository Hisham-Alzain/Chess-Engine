# Requirements: Chess Engine

**Defined:** 2026-10-12
**Core Value:** The engine's measured Elo goes up because of games it has played, and that rise is a measured fact, not a hope.

## v1 Requirements

Requirements for the first release. Each maps to roadmap phases.

### Environment

- [ ] **ENV-01**: Repo is laid out as `engine/`, `trainer/`, `backend/`, `frontend/`, `tools/`, `data/`; all large artifacts (datasets, nets, PGN pools) live in a space-free directory on drive C: configured by environment variable, never under the repo path (which contains a space) and never on the nearly full D: drive
- [ ] **ENV-02**: One build script compiles the C++ engine on Windows using the installed Visual Studio 2022 toolchain (MSVC, CMake, Ninja) without manual PATH setup
- [ ] **ENV-03**: Stockfish and fastchess binaries are pinned by version and hash, installed outside the repo, and verified on startup
- [ ] **ENV-04**: Backend skeleton exists: FastAPI, SQLite in WAL mode with Postgres-portable schema, Alembic migrations, API response envelope matching the cookbook rule, environment-driven settings

### Engine

- [ ] **ENG-01**: Move generation is legal, verified by the standard perft suite (start, Kiwipete, CPW positions 3 to 6) and random-playout legal-move-set equality against python-chess
- [ ] **ENG-02**: Engine speaks UCI fully: answers `stop` and `isready` during search, flushes output, accepts `setoption` values containing spaces, passes a UCI conformance script
- [ ] **ENG-03**: Alpha-beta search with transposition table, quiescence search, iterative deepening, and fixed-depth and fixed-node limits; results only from completed iterations
- [ ] **ENG-04**: Hand-written classical evaluation (material plus piece-square tables) exists as the baseline the net must beat
- [ ] **ENG-05**: Built-in `bench` command whose node count is committed as a correctness signature
- [ ] **ENG-06**: Evaluation sits behind an interface so classical and net evaluators are swappable at startup
- [ ] **ENG-07**: Engine emits `info` lines with depth, score, nodes, nodes per second, time and principal variation while thinking
- [ ] **ENG-08**: Engine completes a 200-game fastchess smoke match with no hangs, crashes or forfeits

### Network

- [ ] **NET-01**: Net architecture v0 is designed together with the user in plain language and recorded as an ADR, with Stockfish NNUE as the reference design and `.planning/research/NET-ARCHITECTURE.md` as raw material
- [ ] **NET-02**: Net file has a versioned header (magic, format version, architecture id, feature set, scales, checksum, dataset hash); the engine refuses a mismatched file
- [ ] **NET-03**: AVX2 incremental-accumulator inference in C++ with a scalar reference path
- [ ] **NET-04**: Export tool runs a bit-exact parity test between the PyTorch model (integer simulation) and the C++ inference on at least 10,000 positions on every export
- [ ] **NET-05**: Incremental accumulator equals full refresh across captures, promotions, castling, en passant and king moves (assertion tests)
- [ ] **NET-06**: Architecture documents an extension point for a future policy head without retraining from scratch
- [ ] **NET-07**: A larger second architecture candidate is trained on the full pool and adopted only if it beats v0 through the promotion gate

### Training Data

- [ ] **DATA-01**: Lichess evaluation database is streamed as a bounded subset into the artifacts directory; the 22 GB dump is never downloaded in full
- [ ] **DATA-02**: Label sign convention and position alignment are verified on hand-checked games before bulk conversion; one sign convention is stored and documented
- [ ] **DATA-03**: Positions are filtered (not in check, quiet best move, centipawn score clipped, no mate scores, opening plies skipped), deduplicated, and split into train/validation by group
- [ ] **DATA-04**: Training records use one fixed-size binary format that includes the best move, readable via memory map; format decided before any bulk conversion
- [ ] **DATA-05**: PGN upload accepts multiple files with a size cap and progress, and returns an ingestion report: parsed, accepted, duplicates skipped, rejected with grouped reasons
- [ ] **DATA-06**: Duplicate games are detected by a hash of the normalised move sequence (headers ignored) across the whole pool, including games played in-app
- [ ] **DATA-07**: Pool panel shows total games and positions, counts by source (bootstrap, human, self-play, upload), and a "Ready to train" state when the threshold is met
- [ ] **DATA-08**: Every game the user plays is saved with the net version that played it and added to the pool; the end-of-game screen says "this game added N positions to the training pool"

### Training

- [ ] **TRAIN-01**: Own PyTorch trainer takes a manifest, writes checkpoints and an exported net plus JSON-lines progress, and never accesses the database
- [ ] **TRAIN-02**: Bootstrap net trained from the Lichess subset beats predict-the-mean and material-only baselines on held-out loss
- [ ] **TRAIN-03**: "Train now" button with disabled-with-reason states (pool too small, another heavy job running, no GPU); an auto-train toggle exists and defaults to off
- [ ] **TRAIN-04**: Training run list and detail view showing status, pool snapshot, positions used, and train/validation loss per epoch
- [ ] **TRAIN-05**: Each training run mixes replayed older data with new data (replay ratio configurable) to prevent catastrophic forgetting
- [ ] **TRAIN-06**: Candidate net list with version id, parent net, source run, and status: pending, promoted, rejected, inconclusive

### Self-play

- [ ] **SELF-01**: Engine has a `datagen` mode: fixed nodes, opening book plus random plies, writes records with score, result and best move
- [ ] **SELF-02**: User starts a self-play session with a validated target game count; sees a progress bar and estimated time; can stop and keep finished games; gets a completion summary
- [ ] **SELF-03**: Unique-game ratio is computed per session and the UI warns when games repeat

### Gating

- [ ] **GATE-01**: Promotion match runs via fastchess SPRT with paired openings (disjoint from rating openings), fixed nodes, a hard game cap; inconclusive at the cap means reject
- [ ] **GATE-02**: Each promotion also requires one fixed-time confirmation match, so a net that is stronger per node but slower per second is caught
- [ ] **GATE-03**: Promotion is atomic: nets are immutable hashed files and the active-net pointer is swapped in one database transaction
- [ ] **GATE-04**: Gate is calibrated before trust: same net on both sides must not promote across repeated runs; a doubled-nodes candidate must be detected within the cap
- [ ] **GATE-05**: Promotion match view shows games played of cap, win/draw/loss, score, Elo difference with 95% interval, SPRT progress against its bounds, and a plain-language verdict sentence
- [ ] **GATE-06**: User can roll back to a previous promoted net via an explicit, logged action
- [ ] **GATE-07**: Read-only gating policy card shows current SPRT bounds, game cap, minimum pool size, openings set and limits
- [ ] **GATE-08**: Provenance panel per net shows pool snapshot by source, training config, match config, Stockfish version and openings used

### Rating

- [ ] **RATE-01**: Rating matches run against the pinned Stockfish at capped strength levels; levels are chosen adaptively to keep scores between 15% and 85%; games use fixed nodes
- [ ] **RATE-02**: Rating math (Elo from results, confidence intervals, likelihood of superiority, SPRT log-likelihood ratio) lives in one pure, unit-tested module
- [ ] **RATE-03**: Ratings are stored as raw win/draw/loss per opponent under a named protocol id that records Stockfish hash, options, time or node limits and opening set; protocols are never spliced
- [ ] **RATE-04**: Dashboard shows the current Elo with interval, labelled "vs this Stockfish configuration" and never as absolute Elo, with net version, game count and date
- [ ] **RATE-05**: Rating history chart by net version (promotion order) with error bars and a version-0 baseline point for the classical engine
- [ ] **RATE-06**: Improvement attribution shows the head-to-head result against the previous net beside each rating; a rise is flagged only when intervals do not overlap
- [ ] **RATE-07**: Elo versus cumulative pool size chart
- [ ] **RATE-08**: v1 done criterion: a promoted net's rating exceeds the previous net's with non-overlapping 95% intervals, confirmed by an independent re-measurement on held-out openings under the same protocol version

### Play

- [ ] **PLAY-01**: Responsive board built from design tokens with click-click and drag-and-drop input, legal-move hints, last-move, check and selected-square highlights, and a promotion picker (no silent auto-queen)
- [ ] **PLAY-02**: Castling, en passant and promotion with capture are correct; game end is detected (checkmate, stalemate, repetition, fifty-move, insufficient material, resignation, agreed draw) with a result banner
- [ ] **PLAY-03**: New game, colour choice (white, black, random), flip board, resign with confirm dialog, draw offer the engine accepts or declines by a simple rule
- [ ] **PLAY-04**: Engine replies automatically after the user's move with a visible "thinking" state, at a fixed depth or seconds per move
- [ ] **PLAY-05**: Move list in SAN with click-to-navigate and keyboard arrows (view-only during a live game); captured-pieces indicator
- [ ] **PLAY-06**: Every game is persisted server-side, survives a refresh, exports to PGN with the standard tag roster, and appears in a history list of played games only (uploaded games never appear there)
- [ ] **PLAY-07**: Play screen shows a net version badge with its current rating and interval
- [ ] **PLAY-08**: Move sounds and piece animation with a mute toggle

### Live Engine Output

- [ ] **LIVE-01**: Evaluation bar always from White's point of view on a sigmoid scale, flips with board orientation
- [ ] **LIVE-02**: Principal variation in SAN with move numbers (truncated to about 6 to 10 plies), depth, nodes, nodes per second and elapsed time
- [ ] **LIVE-03**: Server converts UCI `info` lines to White's view, drops bound lines, coalesces to at most 10 updates per second, and streams them over server-sent events with stale-message drop
- [ ] **LIVE-04**: Clear idle, thinking and final-move states; the final depth and evaluation stay visible after the move
- [ ] **LIVE-05**: Show/hide toggle for the engine panel, remembered per browser
- [ ] **LIVE-06**: Plain-language tooltip on every metric (for example "depth = how many moves ahead it looked")
- [ ] **LIVE-07**: Evaluation sparkline over the game so far in the play view
- [ ] **LIVE-08**: Hovering a move in the best line previews it on the board

### Post-game Review

- [ ] **REV-01**: Review runs as a background job with progress; results (eval, best move, line, depth, net version per ply) are cached per game and analysing net
- [ ] **REV-02**: Step-through controls (first, previous, next, last), keyboard arrows, click on move list, and an evaluation graph over the game with click to jump
- [ ] **REV-03**: Each move is classified (best, inaccuracy, mistake, blunder) using the Lichess win-percentage thresholds from one shared constants module; markers use colour plus symbol, never colour alone
- [ ] **REV-04**: Each flagged move shows the better move as an arrow on the board with its SAN and evaluation versus the played move
- [ ] **REV-05**: Accuracy percentage per side with classification counts
- [ ] **REV-06**: Review shows which net version played the game and which version analysed it
- [ ] **REV-07**: "Jump to next mistake" button
- [ ] **REV-08**: Reviewer is selectable: own current net or Stockfish
- [ ] **REV-09**: "Retry from here": replay from the position before a mistake and try to find the best move, with feedback
- [ ] **REV-10**: Loading, running, failed, cancelled, empty and game-too-short states

### Operations

- [ ] **OPS-01**: Database-backed jobs table and one worker process supervising child processes; one exclusive heavy lane (self-play, train, gate, rate) plus a light lane (ingest, review); global lock prevents two heavy jobs
- [ ] **OPS-02**: Job progress streams over server-sent events; cancel kills the whole process tree; crashed jobs recover to an "interrupted" state on restart
- [ ] **OPS-03**: A human game in progress takes priority: background concurrency is reduced while a game is live
- [ ] **OPS-04**: Single job status bar in the UI shows the running job, progress and cancel
- [ ] **OPS-05**: Training history view links pool snapshot to run to candidate to promotion result to rating, newest first
- [ ] **OPS-06**: Data models carry owner and training-consent fields, a seeded local user, and environment-driven config, so accounts can be added later without schema rework

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Play
- **PLAY-V2-01**: Takeback (undo last pair of moves) with games flagged and excluded from the training pool by default
- **PLAY-V2-02**: Adjustable engine strength / handicap levels
- **PLAY-V2-03**: Clocks and time controls (blitz, rapid); engine respects the clock
- **PLAY-V2-04**: User accounts, login, per-user game history
- **PLAY-V2-05**: Opening name (ECO) tag on games
- **PLAY-V2-06**: Free analysis board independent of a played game

### Review
- **REV-V2-01**: Multi-line (MultiPV) analysis in review only

### Learning
- **DATA-V2-01**: Upload quality filters (minimum player rating, drop forfeits and abandoned games)
- **NET-V2-01**: Policy head for learned move ordering
- **NET-V2-02**: Distributed self-play across machines

### Rating
- **RATE-V2-01**: Online rating via a Lichess bot account

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Net-only play mode (net picks moves without search) | An evaluation net cannot pick moves alone; user dropped it once understood |
| Visual replay of uploaded games against the engine | User decision: uploads are ingestion only |
| AlphaZero-style MCTS driven by a policy net | Unproven with alpha-beta; turns the project into search research |
| Starting from Stockfish's published net weights | Sits at the ceiling so training can only regress it; GPL on the weights complicates a public product |
| Training after every single game | Single games are noisy and damage a net; batches with gating is how serious engines train |
| Always-on idle self-play | Laptop thermals and battery; on-demand only |
| Pure Python search | About 1000x slower than compiled; caps Elo far too low |
| Multi-PV during live play | Weakens play; real C++ work; belongs in review only (v2) |
| "Brilliant" / "Great" move labels | Criteria are rating-dependent and unpublished; Lichess thresholds are enough |
| Absolute or FIDE-comparable Elo claims | Stockfish capped strength is loosely calibrated; all ratings are labelled relative to the configuration |
| Chessground board library | GPL in the browser bundle conflicts with the public-product goal |
| Copying Stockfish source code | GPL-3.0; own implementation only, Stockfish runs only as a separate executable |
| Numeric strength promises (for example "2000 to 2500 after bootstrap") | No reliable data; the phase 2 baseline and phase 5 bootstrap ratings replace guesses |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| (filled by roadmap) | | |

**Coverage:**
- v1 requirements: 83 total
- Mapped to phases: 0
- Unmapped: 83 ⚠️ (pending roadmap)

---
*Requirements defined: 2026-10-12*
*Last updated: 2026-10-12 after initial definition*
