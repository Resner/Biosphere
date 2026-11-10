# Soak report

Reproduce with `npm run soak -- --full` (about 70 minutes; `.github/workflows/soak.yml` runs it).

200 life clients and 2 Chromium pages (low preset) played for 60 minutes on the free plan's own limits.

## Checks

| Check | Result | Detail |
| --- | --- | --- |
| every client seated at once | pass | 200 of 200 |
| no socket closed for its rate | pass | 0 closed |
| no where dropped | pass | 0 dropped |
| no audit flag but authority-only | **FAIL** | growth-too-fast 10, energy-over 1, health-over 5, claim-over 1 |
| consistent empty at every sample | pass | 60 samples |
| no audit flag at any sample | **FAIL** | minutes 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60 |
| nobody waited in line | pass | at most 0 queued |
| authority heap level | pass | 1.2 MB an hour (limit 20), 13.4 MB at minute 60 |
| authority CPU per message level | pass | 2.0993 ms against 1.4960 ms (1.40x, limit 1.5x) |
| messages per player-minute | pass | 8.78 (model 20.98, limit 31.48) |
| rows written per player-hour | pass | 121.44 (model 159.70, limit 239.55; the mix played: 2.87 sessions, 3.48 fights, 4.73 matings and 1.26 hatches a player-hour) |
| pages sampled | pass | 2 pages |
| page 1 heap level | pass | 10.9 MB at minute 10, 9.5 MB at 55 (-12.5%) |
| page 1 renderer resources do not grow | pass | geometries 11 → 9, textures 1 → 1, programs 9 → 7 |
| page 1 frame time level | pass | p95 116.7 ms at minute 5, 116.6 ms at 55 |
| page 2 heap level | pass | 11.2 MB at minute 10, 9.7 MB at 55 (-14.0%) |
| page 2 renderer resources do not grow | pass | geometries 11 → 9, textures 1 → 1, programs 9 → 7 |
| page 2 frame time level | pass | p95 100.1 ms at minute 5, 100.1 ms at 55 |
| page 1 played and reloaded | **FAIL** | 5 hatches, reloads at 30, errors: pageerror: food c489_485_s1_k0 is not alive; pageerror: food c489_485_s1_k0 is not alive; pageerror: food c489_485_s1_k0 is not alive |
| page 2 played and reloaded | pass | 3 hatches, reloads at 30 |
| bundles verify | pass | 240 sampled, 3 of the pages' creatures |

## What happened

| Count | Total |
| --- | --- |
| matings | 948 |
| births | 943 |
| fights | 698 |
| kills | 42 |
| restores | 74 |
| drops | 374 |

## Rows written, by table

| Table | Rows | Share |
| --- | --- | --- |
| creatures | 9226 | 38.1% |
| records | 5568 | 23.0% |
| encounters | 2952 | 12.2% |
| commitments | 2192 | 9.0% |
| matings | 1424 | 5.9% |
| players | 1097 | 4.5% |
| flags | 1094 | 4.5% |
| beacons | 423 | 1.7% |
| genesis_log | 256 | 1.1% |
| ponds | 2 | 0.0% |
| keys | 1 | 0.0% |

## Authority, per minute

| Minute | Heap MB | Resident MB | CPU s | Messages | Seated | Queued |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 10.5 | 476.4 | 14.9 | 9858 | 194 | 0 |
| 6 | 11.9 | 498.4 | 43.8 | 11219 | 200 | 0 |
| 11 | 12.7 | 509.8 | 110.6 | 20388 | 200 | 0 |
| 16 | 12.9 | 516.1 | 196.2 | 29240 | 196 | 0 |
| 21 | 12.9 | 527.9 | 299.0 | 38390 | 193 | 0 |
| 26 | 13.5 | 531.1 | 418.7 | 48174 | 198 | 0 |
| 31 | 13.2 | 541.5 | 553.6 | 56473 | 194 | 0 |
| 36 | 13.1 | 544.1 | 697.0 | 64849 | 197 | 0 |
| 41 | 13.3 | 548.8 | 845.0 | 72637 | 194 | 0 |
| 46 | 13.3 | 554.9 | 1012.3 | 81148 | 197 | 0 |
| 51 | 13.4 | 554.3 | 1187.7 | 89316 | 196 | 0 |
| 56 | 13.9 | 556.5 | 1371.9 | 97666 | 192 | 0 |
| 60 | 13.4 | 476.2 | 1376.3 | 99819 | 194 | 0 |

## Pages, every five minutes

| Page | Minute | Heap MB | Geometries | Textures | Programs | Frame p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 | 10.6 | 11 | 1 | 9 | 116.7 |
| 2 | 5 | 11.0 | 11 | 1 | 9 | 100.1 |
| 1 | 10 | 10.9 | 11 | 1 | 9 | 100.0 |
| 2 | 10 | 11.2 | 11 | 1 | 9 | 100.0 |
| 1 | 15 | 10.4 | 11 | 1 | 9 | 100.1 |
| 2 | 15 | 11.8 | 11 | 1 | 9 | 100.0 |
| 1 | 20 | 10.8 | 11 | 1 | 9 | 100.1 |
| 2 | 20 | 11.9 | 11 | 1 | 9 | 100.0 |
| 1 | 25 | 12.1 | 11 | 1 | 9 | 100.1 |
| 2 | 25 | 11.2 | 11 | 1 | 9 | 100.1 |
| 1 | 30 | 10.1 | 9 | 1 | 7 | 116.6 |
| 2 | 30 | 9.8 | 9 | 1 | 7 | 100.1 |
| 1 | 35 | 9.4 | 9 | 1 | 7 | 100.0 |
| 2 | 35 | 9.4 | 9 | 1 | 7 | 100.0 |
| 1 | 40 | 9.5 | 9 | 1 | 7 | 100.0 |
| 2 | 40 | 10.1 | 9 | 1 | 7 | 100.0 |
| 1 | 45 | 9.3 | 9 | 1 | 7 | 100.1 |
| 2 | 45 | 9.9 | 9 | 1 | 7 | 100.1 |
| 1 | 50 | 10.1 | 9 | 1 | 7 | 116.6 |
| 2 | 50 | 10.0 | 9 | 1 | 7 | 116.6 |
| 1 | 55 | 9.5 | 9 | 1 | 7 | 116.6 |
| 2 | 55 | 9.7 | 9 | 1 | 7 | 100.1 |
| 1 | 60 | 13.3 | 10 | 1 | 8 | 99.9 |
| 2 | 60 | 10.1 | 9 | 1 | 7 | 100.0 |

Result: FAIL
