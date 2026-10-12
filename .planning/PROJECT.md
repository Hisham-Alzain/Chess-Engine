# Chess Engine

## What This Is

A self-improving chess engine you play against in the browser. The engine is a hybrid: a classical
alpha-beta search written in C++ that uses a neural network, trained in Python, as its position
evaluation. Every game it plays, whether against a human, against itself, or ingested from an
uploaded PGN, feeds a training loop that produces candidate networks, and a candidate replaces the
live network only after winning a promotion match. The goal is to push the engine's measured Elo as
high as possible and to be able to watch that number rise because of training.

## Core Value

The engine's measured Elo goes up because of games it has played. If the search is strong but the
learning loop is a hope rather than a measured fact, the project has failed.

## Requirements

### Validated

(None yet — ship to validate)

### Active

**Engine**
- [ ] A C++ alpha-beta engine that plays legal chess at full strength with a learned evaluation
- [ ] The evaluation is a neural network with our own weights; the architecture is designed together
      in its own phase, with Stockfish's NNUE design as the reference baseline
- [ ] The engine reports its thinking live: evaluation, principal variation, depth, nodes per second
- [ ] The engine speaks a standard protocol (UCI) so it can play Stockfish and be driven from Python

**Play**
- [ ] User plays a full game against the engine in the browser on a proper board
- [ ] The engine's evaluation bar, best line and depth are shown live while it thinks
- [ ] After a game, the user can step through it with the engine marking mistakes, blunders and
      better moves (post-game review)
- [ ] Games played are saved and feed the training pool

**Learning**
- [ ] Bootstrap: an initial network is trained from the open Lichess game database so the engine
      starts near club strength rather than random
- [ ] Uploaded PGN games are ingested as training examples (no visual replay; ingestion only)
- [ ] Self-play runs on demand: the user starts a session with a target game count, watches progress,
      and it stops when done
- [ ] Training runs in batches: reaching the pool threshold flips a "Ready to train" state and the user
      presses "train now"; an auto-train toggle exists but defaults to off (resolves the tension with
      "never always-on", decided 2026-10-12)
- [ ] All automated games (gating, self-play, rating) use fixed node counts for reproducibility, and
      each promotion additionally requires one fixed-time confirmation match
- [ ] Gating: a newly trained candidate plays a promotion match against the current network and
      replaces it only if it wins by a statistically meaningful margin
- [ ] The user can see the training history: pools, runs, candidates, promotion results

**Rating**
- [ ] Elo is measured by matches against Stockfish at capped strength levels, computed from results
- [ ] A dashboard shows the current rating and its history over network versions
- [ ] v1 is done when a promoted net's rating exceeds the previous net's with non-overlapping 95%
      confidence intervals, confirmed by an independent re-measurement on held-out openings under the
      same protocol version (tightened 2026-10-12 after research: a bare "went up once" is satisfied
      by noise alone given enough candidates)

### Out of Scope

- **Net-only play mode** (net picks moves with no search) — the user explicitly dropped it; the
  engine is always net plus alpha-beta
- **Visual replay of uploaded games against the engine** — dropped; uploads are ingestion only
- **Policy network / learned move ordering** — deferred; design the net so a policy head can be
  added later without a rewrite, but v1 is evaluation only
- **AlphaZero-style MCTS driven by a policy net** — rejected; unproven with alpha-beta and would turn
  the project into search research instead of engine building
- **Starting from Stockfish's published net** — rejected; it sits at the ceiling so training would
  only regress it and the Elo curve would be flat, plus the GPL on the net complicates a public product
- **Training after every single game** — rejected; single games are noisy and damage a net; batches
  with gating is how every serious engine trains
- **Adjustable strength / handicap levels** — v2; v1 always plays full strength
- **Clocks and time controls** — v2; v1 thinks for a fixed depth or seconds per move
- **User accounts and login** — v2; v1 is single-user local. The existing auth boilerplate stays out
  of the v1 path, but the code is structured so accounts can be added without rework
- **Online rating via a Lichess bot** — v2; Stockfish levels are the only yardstick in v1
- **Always-on idle self-play** — rejected for v1; laptop fan and battery. On-demand only
- **Takeback / undo during a game** — v2; when added, games using it are flagged and excluded from
  the training pool by default
- **Numeric strength promises** — removed 2026-10-12; no reliable Elo-vs-data curve exists, so the
  phase 2 classical baseline and phase 5 bootstrap rating replace any guess
- **Pure Python search** — rejected; roughly 1000x slower than compiled, caps Elo far too low

## Context

**Repo state at start (2026-10-12).** One commit. `backend/app.py` is a 20-line Flask hello-world with
a hardcoded piece list route. `frontend/` is a copied React 19 + Vite auth boilerplate ("basecode"):
Zustand store, Axios with a base64-encoded cookie token, admin/anonymous route guards, Arabic/English
i18n via react-i18next. None of it is chess-specific. The Axios base URL points at port 8000 while
Flask runs on 5000, and nothing calls the Flask route. Treat it as scaffolding to retrofit or replace,
not as validated functionality.

**Frontend governance.** The repo is wired to the Khalil React Cookbook
(`D:/TupCode/Khalil-React-cookbook`) via its installer: project CLAUDE.md block, AGENTS.md, four skills
(react-project-setup, react-ui-implementation, react-data-layer, react-uiux-audit) and a SessionStart
hook. All React work routes through `00-index/task-to-files-map.md` and must invoke the relevant skill.
Hard rules: design tokens not hardcoded colors, env config not hardcoded hosts, single source for
shared constants, frontend guards are UX-only.

**Hardware (measured).**

| Component | Value |
|---|---|
| GPU | NVIDIA RTX 3060 Laptop, 6 GB VRAM |
| CPU | AMD Ryzen 9 5900HS, 8 cores / 16 threads |
| RAM | 16 GB |
| Toolchain | CUDA 13.2, Python 3.12.7, PyTorch 2.9.1+cu130 with CUDA working |

6 GB VRAM means modest batch sizes and overnight training runs; it comfortably trains NNUE-size nets
and rules out the largest Leela-size nets.

**Domain facts that shaped the design.**
- Alpha-beta strength is roughly nodes-per-second times evaluation quality. Python with python-chess
  does tens of thousands of nodes per second; compiled engines do tens of millions. No evaluation
  closes a 1000x gap, so the search must be compiled.
- An evaluation-only net cannot pick a move by itself; it scores positions. That is why net-only play
  was dropped once understood.
- Learning from uploaded games is supervised imitation; learning from self-play and own games is
  reinforcement. Both feed the same net through two pipelines.
- Stockfish does not train its nets on game results but on deep-search scores of billions of
  positions. A small, result-labelled dataset fine-tuned onto such a net regresses it.
- The Lichess evaluation database (416 million Stockfish-scored positions, CC0, 22 GB compressed) is
  the bootstrap source; a streamed subset is used because drive D: has about 20 GB free. Expected
  strength after bootstrap is deliberately not stated; it is measured in phases 2 and 5.
- Research (2026-10-12, five dimensions, `.planning/research/`) converged on: build the engine with a
  classical eval and the measurement harness first, calibrate the gate (same-net must not promote,
  doubled-nodes must be detected), then the net with a bit-exact C++/PyTorch parity test, then
  bootstrap training, then the self-play and gating loop; the play UI runs in parallel with net work.
- Gating (promotion match before adoption) is how Leela avoids silent regressions.

**User's understanding.** The user is new to engine internals and asked for every concept to be
explained from the ground up (what a net is, what evaluation and pruning are). Phase discussions and
plans must keep explaining in plain terms and must not assume engine or ML vocabulary.

## Constraints

- **Tech stack**: Search in C++; model, training, API and orchestration in Python; frontend React per
  the cookbook — user decision, driven by the speed argument above
- **Hardware**: Everything must train and run on the RTX 3060 Laptop (6 GB) and 16 GB RAM — no
  cloud GPU budget
- **Protocol**: Engine must speak UCI — needed to play Stockfish for rating and to be driven from
  Python; also keeps the engine usable by any chess GUI
- **Yardstick**: Stockfish at capped strength is the external measure — must be installed and
  callable from the rating pipeline
- **Deployment**: Runs locally on one laptop for v1, but is designed as a public product: stateless
  API boundaries, a real database schema (SQLite now, swappable), no single-user shortcuts baked into
  data models
- **Licensing**: Own weights only; architecture ideas from NNUE are fine, Stockfish's weights are not
  shipped — keeps a future public product license-clean
- **Frontend**: Khalil React Cookbook rules are mandatory for all UI code
- **Compute etiquette**: Self-play and training are on-demand, never always-on

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Net is the evaluation function only; search stays classical alpha-beta | Proven path (Stockfish NNUE); one learning target so regressions are traceable; fits a compiled core | — Pending |
| Design the net so a policy head can be added later | Keeps learned move ordering (option 2) as an addition, not a rewrite | — Pending |
| No net-only play mode | An eval net cannot pick moves without search; dropped once understood | ✓ Settled |
| Search in C++, model and API in Python | 1000x speed gap between Python and compiled search; Python is right for training and web | — Pending |
| Own weights, bootstrapped from Lichess open data, NNUE as reference architecture; architecture to be designed together in its own phase | Starting from Stockfish's net leaves no room for measurable improvement and carries GPL; own weights make the Elo curve real and the license clean | — Pending |
| Batched training with promotion-match gating plus manual trigger | Per-game updates are noisy and damage nets; gating turns "got better" into a measured fact | — Pending |
| Elo measured against Stockfish at capped levels | Objective, reproducible, no network dependency | — Pending |
| Uploaded PGNs are ingestion only, no replay UI | User decision; simpler scope | ✓ Settled |
| Self-play is on-demand with a target game count | Laptop thermals and battery; predictable load | ✓ Settled |
| Accounts, clocks, adjustable strength, Lichess bot are v2 | Keep v1 focused on proving the learning loop | ✓ Settled |
| Design for public product while running locally | User's stated end goal; avoids rework on data models and API boundaries | — Pending |
| Done criterion is statistical (non-overlapping 95% CIs plus independent re-measurement) | Four of five research files found "went up once" is satisfied by noise | ✓ Settled |
| "Ready to train" state plus manual button; auto-train toggle default off | Resolves "batches when ready" vs "never always-on" | ✓ Settled |
| Fixed nodes for all automated games plus one fixed-time confirmation per promotion | Reproducible under thermal throttling; timed check catches nets that are stronger per node but slower per second | ✓ Settled |
| No takeback in v1 | Keeps the play loop and pool honest; add later with exclude-from-pool flag | ✓ Settled |
| FastAPI replaces Flask; SQLite WAL now, Postgres-portable; DB-backed job worker, no Celery/Redis | Native SSE, no Windows-hostile broker, one laptop | — Pending |
| fastchess for matches, Stockfish sf_19 pinned as yardstick, both as separate executables only | MIT and GPL respectively; keeps our code license-clean | — Pending |
| react-chessboard + chess.js, not Chessground | Chessground is GPL in the browser bundle | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-12 after research and requirements definition*
