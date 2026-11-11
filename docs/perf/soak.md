# Soak report

Reproduce with `npm run soak -- --full` (about 70 minutes; `.github/workflows/soak.yml` runs it).

200 life clients and 2 Chromium pages (low preset) played for 60 minutes on the free plan's own limits.

## Checks

| Check | Result | Detail |
| --- | --- | --- |
| every client seated at once | pass | 200 of 200 |
| no socket closed for its rate | pass | 0 closed |
| no where dropped | pass | 0 dropped |
| no audit flag but authority-only | pass | none |
| consistent empty at every sample | pass | 60 samples |
| no audit flag at any sample | pass | none |
| nobody waited in line | pass | at most 0 queued |
| authority heap level | pass | 0.9 MB an hour (limit 20), 13.2 MB at minute 60 |
| authority CPU per message level | pass | 1.7299 ms against 1.4922 ms (1.16x, limit 1.5x) |
| messages per player-minute | pass | 9.35 (model 24.71, limit 37.06) |
| rows written per player-hour | pass | 147.62 (model 199.58, limit 299.37; the mix played: 2.92 sessions, 4.76 fights, 5.70 matings and 1.30 hatches a player-hour) |
| pages sampled | pass | 2 pages |
| page 1 heap level | pass | 10.7 MB at minute 10, 11.9 MB at 55 (11.1%) |
| page 1 renderer resources do not grow | pass | geometries at most 11 early, at least 11 late, textures at most 1 early, at least 1 late, programs at most 9 early, at least 9 late |
| page 1 frame time level | pass | p95 116.7 ms at minute 5, 83.4 ms at 55 |
| page 2 heap level | pass | 10.5 MB at minute 10, 9.9 MB at 55 (-5.2%) |
| page 2 renderer resources do not grow | pass | geometries at most 10 early, at least 9 late, textures at most 1 early, at least 1 late, programs at most 8 early, at least 7 late |
| page 2 frame time level | pass | p95 116.6 ms at minute 5, 83.4 ms at 55 |
| page 1 played and reloaded | pass | 5 hatches, reloads at 30 |
| page 2 played and reloaded | pass | 3 hatches, reloads at 30 |
| bundles verify | pass | 241 sampled, 3 of the pages' creatures |

## What happened

| Count | Total |
| --- | --- |
| matings | 1082 |
| births | 1081 |
| fights | 903 |
| kills | 67 |
| restores | 120 |
| drops | 353 |

## Rows written, by table

| Table | Rows | Share |
| --- | --- | --- |
| creatures | 10558 | 37.8% |
| records | 6372 | 22.8% |
| encounters | 3998 | 14.3% |
| commitments | 2373 | 8.5% |
| matings | 1623 | 5.8% |
| flags | 1237 | 4.4% |
| players | 1063 | 3.8% |
| beacons | 460 | 1.6% |
| genesis_log | 250 | 0.9% |
| ponds | 2 | 0.0% |
| keys | 1 | 0.0% |

## Authority, per minute

| Minute | Heap MB | Resident MB | CPU s | Messages | Seated | Queued |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 11.4 | 428.7 | 15.2 | 10170 | 196 | 0 |
| 6 | 12.1 | 426.6 | 22.2 | 11020 | 196 | 0 |
| 11 | 12.6 | 430.4 | 43.3 | 21105 | 200 | 0 |
| 16 | 13.2 | 442.7 | 64.7 | 29694 | 198 | 0 |
| 21 | 12.7 | 452.4 | 89.7 | 38276 | 196 | 0 |
| 26 | 12.9 | 475.6 | 115.2 | 46645 | 198 | 0 |
| 31 | 12.8 | 461.7 | 146.5 | 55136 | 194 | 0 |
| 36 | 13.1 | 467.8 | 177.1 | 63720 | 194 | 0 |
| 41 | 13.3 | 471.1 | 208.1 | 72306 | 198 | 0 |
| 46 | 13.2 | 472.5 | 239.8 | 80844 | 200 | 0 |
| 51 | 13.5 | 495.3 | 270.9 | 89093 | 193 | 0 |
| 56 | 13.2 | 493.2 | 303.4 | 98102 | 197 | 0 |
| 60 | 13.2 | 441.2 | 316.4 | 105464 | 194 | 0 |

## Pages, every five minutes

| Page | Minute | Heap MB | Geometries | Textures | Programs | Frame p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 | 10.9 | 11 | 1 | 9 | 116.7 |
| 2 | 5 | 11.0 | 11 | 1 | 9 | 116.6 |
| 1 | 10 | 10.7 | 11 | 1 | 9 | 83.4 |
| 2 | 10 | 10.5 | 10 | 1 | 8 | 66.8 |
| 1 | 15 | 12.0 | 11 | 1 | 9 | 83.4 |
| 2 | 15 | 10.5 | 10 | 1 | 8 | 83.3 |
| 1 | 20 | 11.3 | 10 | 1 | 8 | 83.3 |
| 2 | 20 | 10.6 | 10 | 1 | 8 | 83.3 |
| 1 | 25 | 11.3 | 10 | 1 | 8 | 66.8 |
| 2 | 25 | 10.6 | 10 | 1 | 8 | 83.3 |
| 1 | 30 | 9.0 | 9 | 1 | 7 | 100.1 |
| 2 | 30 | 8.7 | 9 | 1 | 7 | 100.1 |
| 1 | 35 | 9.9 | 9 | 1 | 7 | 83.4 |
| 2 | 35 | 9.6 | 9 | 1 | 7 | 83.4 |
| 1 | 40 | 9.3 | 9 | 1 | 7 | 83.4 |
| 2 | 40 | 9.2 | 9 | 1 | 7 | 83.4 |
| 1 | 45 | 10.1 | 9 | 1 | 7 | 83.4 |
| 2 | 45 | 10.1 | 9 | 1 | 7 | 83.4 |
| 1 | 50 | 10.6 | 11 | 1 | 9 | 100.0 |
| 2 | 50 | 10.2 | 9 | 1 | 7 | 100.0 |
| 1 | 55 | 11.9 | 11 | 1 | 9 | 83.4 |
| 2 | 55 | 9.9 | 9 | 1 | 7 | 83.4 |
| 1 | 60 | 11.2 | 11 | 1 | 9 | 83.4 |
| 2 | 60 | 10.8 | 9 | 1 | 7 | 83.4 |

Result: pass
