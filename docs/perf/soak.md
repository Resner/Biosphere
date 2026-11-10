# Soak report

Reproduce with `npm run soak -- --full` (about 70 minutes; `.github/workflows/soak.yml` runs it).

200 life clients and 2 Chromium pages (low preset) played for 60 minutes on the free plan's own limits.

## Checks

| Check | Result | Detail |
| --- | --- | --- |
| every client seated at once | pass | 200 of 200 |
| no socket closed for its rate | **FAIL** | 436 closed |
| no where dropped | pass | 0 dropped |
| no audit flag but authority-only | **FAIL** | biomass-over-max 5, growth-too-fast 157, energy-over 39, health-over 130, clock-too-fast 293, claim-over 2 |
| consistent empty at every sample | **FAIL** | minutes 1, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 19, 34 |
| no audit flag at any sample | **FAIL** | minutes 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 24, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 50, 51, 52, 53, 54 |
| nobody waited in line | pass | at most 0 queued |
| authority memory level | **FAIL** | 355.6 MB an hour (limit 20) |
| authority CPU per message level | pass | 18.2593 ms against 17.5248 ms (1.04x, limit 1.5x) |
| messages per player-minute | pass | 17.13 (MEASURED 19.57, limit 29.35) |
| rows written per player-hour | **FAIL** | 187.96 (MEASURED 88.01, limit 132.01) |
| pages sampled | pass | 2 pages |
| page 1 heap level | pass | 10.5 MB at minute 10, 9.6 MB at 54 (-9.3%) |
| page 1 renderer resources do not grow | pass | geometries 11 → 9, textures 1 → 1, programs 9 → 7 |
| page 1 frame time level | pass | p95 1116.6 ms at minute 5, 1099.9 ms at 54 |
| page 2 heap level | pass | 12.5 MB at minute 10, 10.4 MB at 54 (-16.2%) |
| page 2 renderer resources do not grow | pass | geometries 11 → 9, textures 1 → 1, programs 9 → 7 |
| page 2 frame time level | pass | p95 150.1 ms at minute 5, 150.0 ms at 54 |
| page 1 played and reloaded | pass | 4 hatches, reloads at 30 |
| page 2 played and reloaded | pass | 3 hatches, reloads at 30.1 |
| bundles verify | pass | 237 sampled, 2 of the pages' creatures |

## What happened

| Count | Total |
| --- | --- |
| matings | 759 |
| births | 744 |
| fights | 1312 |
| kills | 91 |
| restores | 140 |
| drops | 1039 |

## Authority, per minute

| Minute | Resident MB | CPU s | Messages | Seated | Queued |
| --- | --- | --- | --- | --- | --- |
| 1 | 691.1 | 74.2 | 16160 | 189 | 0 |
| 6 | 833.2 | 192.4 | 22641 | 175 | 0 |
| 12 | 808.4 | 454.2 | 38080 | 179 | 0 |
| 18 | 881.8 | 831.3 | 58134 | 188 | 0 |
| 23 | 918.5 | 1039.2 | 70743 | 187 | 0 |
| 32 | 974.4 | 1655.8 | 99439 | 185 | 0 |
| 37 | 967.1 | 1803.2 | 108664 | 168 | 0 |
| 53 | 1076.6 | 3046.0 | 149664 | 184 | 0 |
| 54 | 1077.0 | 3075.2 | 151305 | 177 | 0 |

## Pages, every five minutes

| Page | Minute | Heap MB | Geometries | Textures | Programs | Frame p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 | 9.7 | 11 | 1 | 9 | 1116.6 |
| 2 | 5 | 11.6 | 11 | 1 | 9 | 150.1 |
| 1 | 10 | 10.5 | 11 | 1 | 9 | 1200.0 |
| 2 | 10 | 12.5 | 11 | 1 | 9 | 283.3 |
| 1 | 15 | 10.7 | 11 | 1 | 9 | 1116.6 |
| 2 | 15 | 11.2 | 11 | 1 | 9 | 150.0 |
| 1 | 20 | 10.3 | 11 | 1 | 9 | 1116.7 |
| 2 | 20 | 10.9 | 11 | 1 | 9 | 150.0 |
| 1 | 25 | 11.2 | 11 | 1 | 9 | 1116.7 |
| 2 | 25 | 11.5 | 11 | 1 | 9 | 150.0 |
| 1 | 30 | 8.8 | 9 | 1 | 7 | 1116.7 |
| 2 | 30 | 9.8 | 9 | 1 | 7 | 166.7 |
| 1 | 35 | 9.1 | 9 | 1 | 7 | 1116.6 |
| 2 | 35 | 9.8 | 9 | 1 | 7 | 150.0 |
| 1 | 40 | 9.6 | 9 | 1 | 7 | 1183.3 |
| 2 | 40 | 9.8 | 9 | 1 | 7 | 299.9 |
| 1 | 45 | 9.4 | 9 | 1 | 7 | 1100.0 |
| 2 | 45 | 10.3 | 9 | 1 | 7 | 150.0 |
| 1 | 50 | 9.9 | 9 | 1 | 7 | 1116.5 |
| 2 | 50 | 10.0 | 9 | 1 | 7 | 150.0 |

Result: FAIL
