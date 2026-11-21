# Performance report
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

## Method

- 200 sequential requests per read set and side, interleaved: one legacy request, then one target request.
- p50 and p95 by nearest rank, in ms rounded to 0.1.
- Target is the gateway with the active cut-over version; legacy is the ColdFusion origin, requested directly.
- Source `catalogue` rows are the GS-CO-05 scenario's own requests, one per session and path of its matrix, named `<scenario>:<session> <route>` with seed placeholders kept; source `read-set` rows are the fixed findMany, feed, `cusers.listusers`, `csettings.list` and timesheet sheet reads. The feed row reads a Local collection the run creates through the gateway just before the set and deletes just after it.
- Served by is the side the active cut-over version routes the row's route key to. On a `legacy` row the target columns measure the gateway proxying to legacy, and a `legacy-served` finding says so.
- The request sets no latency threshold: a target p95 above 1.5x legacy and a write window over 5 s are flags, not failures.
- The legacy-direct admin and timesheet sessions log in on legacy itself, which updates that user's `tusers.LastLogin` on the legacy side.
- Cold start is measured locally (process start to the first `/healthz` 200); scale to zero and back is derived (stopped service, restart, first successful request through the gateway), and `unavailable` where no such request was timed. Each poll is bounded at 60000 ms.
- Each service is probed only by identity's admin login or by a request that leaves the compared state unchanged: a read, or a view whose writes are idempotent. A service none of whose probe candidates the active version routes to target has an `unavailable` row and a `probe-not-target` finding naming the candidates' route keys; one whose target-routed candidates all need the absent fixtures has an `unavailable` row and a `scale-probe-skipped` finding.
- Cloud measurement: not possible without apply.

## Latency

| Set | Source | Served by | Requests | Target p50 (ms) | Target p95 (ms) | Legacy p50 (ms) | Legacy p95 (ms) | Ratio p95 | Finding |
|---|---|---|---|---|---|---|---|---|---|
| gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID} | catalogue | legacy | 200 | 133.3 | 146.8 | 32.3 | 37.4 | 3.93 | target p95 146.8 ms is 3.93x legacy p95 37.4 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content | catalogue | legacy | 200 | 260.2 | 280.7 | 156.5 | 165.1 | 1.7 | target p95 280.7 ms is 1.7x legacy p95 165.1 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?title=GS | catalogue | legacy | 200 | 127 | 149.9 | 31.2 | 36.7 | 4.08 | target p95 149.9 ms is 4.08x legacy p95 36.7 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | catalogue | legacy | 200 | 249.4 | 275.8 | 145.5 | 156 | 1.77 | target p95 275.8 ms is 1.77x legacy p95 156 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/new | catalogue | legacy | 200 | 121.4 | 141.6 | 27.2 | 32.8 | 4.32 | target p95 141.6 ms is 4.32x legacy p95 32.8 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/properties | catalogue | legacy | 200 | 118.2 | 145.9 | 17.2 | 20.3 | 7.19 | target p95 145.9 ms is 7.19x legacy p95 20.3 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | catalogue | legacy | 200 | 118.3 | 136.1 | 21.1 | 26.3 | 5.17 | target p95 136.1 ms is 5.17x legacy p95 26.3 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | catalogue | legacy | 200 | 126.4 | 150.3 | 30.5 | 35.5 | 4.23 | target p95 150.3 ms is 4.23x legacy p95 35.5 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | catalogue | legacy | 200 | 141.9 | 166.4 | 44.2 | 49.2 | 3.38 | target p95 166.4 ms is 3.38x legacy p95 49.2 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | catalogue | legacy | 200 | 129.5 | 149.6 | 35.2 | 41.9 | 3.57 | target p95 149.6 ms is 3.57x legacy p95 41.9 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | catalogue | legacy | 200 | 117.1 | 138.7 | 19.6 | 24.5 | 5.66 | target p95 138.7 ms is 5.66x legacy p95 24.5 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 119.3 | 139.8 | 12.6 | 14.4 | 9.71 | target p95 139.8 ms is 9.71x legacy p95 14.4 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 119 | 144.2 | 21.1 | 26.4 | 5.46 | target p95 144.2 ms is 5.46x legacy p95 26.4 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 124.1 | 148.2 | 12.8 | 16.4 | 9.04 | target p95 148.2 ms is 9.04x legacy p95 16.4 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | catalogue | legacy | 200 | 121.2 | 145.1 | 15.4 | 19.4 | 7.48 | target p95 145.1 ms is 7.48x legacy p95 19.4 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | catalogue | legacy | 200 | 117.5 | 140.5 | 15.4 | 18.6 | 7.55 | target p95 140.5 ms is 7.55x legacy p95 18.6 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID} | catalogue | legacy | 200 | 56.3 | 66.4 | 38.3 | 42 | 1.58 | target p95 66.4 ms is 1.58x legacy p95 42 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/content | catalogue | legacy | 200 | 173.8 | 186.8 | 154.1 | 162 | 1.15 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/content/?title=GS | catalogue | legacy | 200 | 49 | 59.5 | 30.6 | 34.8 | 1.71 | target p95 59.5 ms is 1.71x legacy p95 34.8 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | catalogue | legacy | 200 | 164.2 | 176.4 | 144.5 | 153.5 | 1.15 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/content/new | catalogue | legacy | 200 | 52 | 60.8 | 33.6 | 37.8 | 1.61 | target p95 60.8 ms is 1.61x legacy p95 37.8 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/content/properties | catalogue | legacy | 200 | 35.7 | 42.8 | 17.3 | 18.9 | 2.26 | target p95 42.8 ms is 2.26x legacy p95 18.9 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | catalogue | legacy | 200 | 45.9 | 55.1 | 27 | 31.1 | 1.77 | target p95 55.1 ms is 1.77x legacy p95 31.1 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | catalogue | legacy | 200 | 60.2 | 69.7 | 40.8 | 45.8 | 1.52 | target p95 69.7 ms is 1.52x legacy p95 45.8 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | catalogue | legacy | 200 | 74.8 | 84.5 | 54.7 | 60.7 | 1.39 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | catalogue | legacy | 200 | 55.7 | 65.9 | 36.2 | 39.7 | 1.66 | target p95 65.9 ms is 1.66x legacy p95 39.7 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | catalogue | legacy | 200 | 79.5 | 87.7 | 59.6 | 64.2 | 1.37 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 31.6 | 39.5 | 12.4 | 13.7 | 2.88 | target p95 39.5 ms is 2.88x legacy p95 13.7 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 39.6 | 47.6 | 20.7 | 22.8 | 2.09 | target p95 47.6 ms is 2.09x legacy p95 22.8 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 32 | 40.2 | 12.9 | 14.4 | 2.79 | target p95 40.2 ms is 2.79x legacy p95 14.4 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | catalogue | legacy | 200 | 35.4 | 43.9 | 15.4 | 17.7 | 2.48 | target p95 43.9 ms is 2.48x legacy p95 17.7 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | catalogue | legacy | 200 | 35.4 | 44.7 | 15.4 | 17.5 | 2.55 | target p95 44.7 ms is 2.55x legacy p95 17.5 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?pageIndex=-3 | catalogue | legacy | 200 | 413.6 | 444.2 | 304.6 | 320.6 | 1.39 |  |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?pageIndex=0 | catalogue | legacy | 200 | 412.2 | 445.9 | 307.2 | 328 | 1.36 |  |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?pageIndex=-1 | catalogue | legacy | 200 | 412 | 442.3 | 306.9 | 328.9 | 1.34 |  |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | catalogue | legacy | 200 | 150 | 170 | 50.5 | 54.6 | 3.11 | target p95 170 ms is 3.11x legacy p95 54.6 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?fields=title | catalogue | legacy | 200 | 193 | 219.7 | 91.1 | 95.6 | 2.3 | target p95 219.7 ms is 2.3x legacy p95 95.6 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?fields=title,summary,url | catalogue | legacy | 200 | 207.9 | 226 | 106.9 | 114.1 | 1.98 | target p95 226 ms is 1.98x legacy p95 114.1 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/contentnav/?fields=title | catalogue | legacy | 200 | 191.9 | 210.9 | 90.3 | 96.2 | 2.19 | target p95 210.9 ms is 2.19x legacy p95 96.2 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | catalogue | legacy | 200 | 180.3 | 199.2 | 81.7 | 87.7 | 2.27 | target p95 199.2 ms is 2.27x legacy p95 87.7 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/contentnav/properties | catalogue | legacy | 200 | 120.9 | 146.2 | 17.1 | 20.8 | 7.03 | target p95 146.2 ms is 7.03x legacy p95 20.8 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/comment/properties | catalogue | legacy | 200 | 121.1 | 140.9 | 17.3 | 19.5 | 7.23 | target p95 140.9 ms is 7.23x legacy p95 19.5 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/category/properties | catalogue | legacy | 200 | 119.7 | 144.8 | 18.4 | 20.2 | 7.17 | target p95 144.8 ms is 7.17x legacy p95 20.2 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/contentCategoryAssign/properties | catalogue | legacy | 200 | 124 | 145.2 | 17.2 | 19.4 | 7.48 | target p95 145.2 ms is 7.48x legacy p95 19.4 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/fileMetaData/properties | catalogue | legacy | 200 | 121.5 | 148.4 | 17 | 19.7 | 7.53 | target p95 148.4 ms is 7.53x legacy p95 19.7 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/feed/properties | catalogue | legacy | 200 | 120.2 | 141 | 21.6 | 24.2 | 5.83 | target p95 141 ms is 5.83x legacy p95 24.2 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/stats/properties | catalogue | legacy | 200 | 123.6 | 142.9 | 16.7 | 19.2 | 7.44 | target p95 142.9 ms is 7.44x legacy p95 19.2 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/?method=findProperties&entityname=file | catalogue | legacy | 200 | 123.2 | 145.4 | 12.3 | 13.8 | 10.54 | target p95 145.4 ms is 10.54x legacy p95 13.8 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/content/?pageIndex=-3 | catalogue | legacy | 200 | 321.9 | 335.5 | 301.1 | 313.9 | 1.07 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/content/?pageIndex=0 | catalogue | legacy | 200 | 326.4 | 340.9 | 308 | 321 | 1.06 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/content/?pageIndex=-1 | catalogue | legacy | 200 | 334 | 355.3 | 315.2 | 329.6 | 1.08 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | catalogue | legacy | 200 | 66.7 | 79.8 | 49.2 | 53.2 | 1.5 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/content/?fields=title | catalogue | legacy | 200 | 109 | 118.5 | 90.4 | 99.1 | 1.2 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/content/?fields=title,summary,url | catalogue | legacy | 200 | 126.4 | 139.1 | 107.9 | 114.4 | 1.22 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/contentnav/?fields=title | catalogue | legacy | 200 | 108 | 118.7 | 89.3 | 95.1 | 1.25 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | catalogue | legacy | 200 | 99.4 | 108 | 81.6 | 88.2 | 1.22 |  |
| gs-co-05:admin /_api/json/v1/tenant-a/contentnav/properties | catalogue | legacy | 200 | 35.4 | 43.6 | 17.1 | 20.1 | 2.17 | target p95 43.6 ms is 2.17x legacy p95 20.1 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/comment/properties | catalogue | legacy | 200 | 35.9 | 43.2 | 16.8 | 18.6 | 2.32 | target p95 43.2 ms is 2.32x legacy p95 18.6 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/category/properties | catalogue | legacy | 200 | 37.8 | 44.6 | 18.1 | 20.7 | 2.15 | target p95 44.6 ms is 2.15x legacy p95 20.7 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/contentCategoryAssign/properties | catalogue | legacy | 200 | 37.2 | 47 | 17.3 | 19.4 | 2.42 | target p95 47 ms is 2.42x legacy p95 19.4 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/fileMetaData/properties | catalogue | legacy | 200 | 37.8 | 45.1 | 17.5 | 19.5 | 2.31 | target p95 45.1 ms is 2.31x legacy p95 19.5 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/feed/properties | catalogue | legacy | 200 | 41.7 | 50 | 20.8 | 23.1 | 2.16 | target p95 50 ms is 2.16x legacy p95 23.1 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/stats/properties | catalogue | legacy | 200 | 38.6 | 47.5 | 17.3 | 18.9 | 2.51 | target p95 47.5 ms is 2.51x legacy p95 18.9 ms (above 1.5x) |
| gs-co-05:admin /_api/json/v1/tenant-a/?method=findProperties&entityname=file | catalogue | legacy | 200 | 34.1 | 40.2 | 13 | 14.9 | 2.7 | target p95 40.2 ms is 2.7x legacy p95 14.9 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?sortBy=nosuchcol | catalogue | legacy | 200 | 300.8 | 327.5 | 191.4 | 203.5 | 1.61 | target p95 327.5 ms is 1.61x legacy p95 203.5 ms (above 1.5x) |
| gs-co-05:anon /_api/json/v1/tenant-a/content/?itemsPerPage=1001&pageIndex=0&fields=title | catalogue | legacy | 200 | 2936.3 | 3026.2 | 2812.6 | 2913.6 | 1.04 |  |
| gs-co-05.content.findMany | read-set | legacy | 200 | 156.1 | 178.2 | 57.1 | 62 | 2.87 | target p95 178.2 ms is 2.87x legacy p95 62 ms (above 1.5x) |
| gs-co-05.feed | read-set | legacy | 200 | 195.4 | 219.2 | 69.4 | 76.6 | 2.86 | target p95 219.2 ms is 2.86x legacy p95 76.6 ms (above 1.5x) |
| cusers.listusers | read-set | legacy | 200 | 139.7 | 155 | 101.2 | 110.6 | 1.4 |  |
| csettings.list | read-set | target | 200 | 77.3 | 94.8 | 50.5 | 56.4 | 1.68 | target p95 94.8 ms is 1.68x legacy p95 56.4 ms (above 1.5x) |
| timesheets.sheets | read-set | legacy | 200 | 39.8 | 49.7 | 20.9 | 24.6 | 2.02 | target p95 49.7 ms is 2.02x legacy p95 24.6 ms (above 1.5x) |

## Cold start (measured)

| Service | Start to first 200 (ms) |
|---|---|
| identity | 1293.9 |
| people | 1144.3 |
| programs-sites | 1137.9 |
| strategies-content | 1239.2 |
| communications | 1136.5 |
| reporting | 1393.9 |
| surveys | 1135.4 |
| timesheets | 1188.2 |
| finance | 1141.2 |
| e-signature | 1136.3 |

## min_instance_count (measured from the Terraform plan)

Source: `minInstanceCounts`.

| Service | Planned | Expected |
|---|---|---|
| gateway | 0 | 0 |
| web | 0 | 0 |
| identity | 0 | 0 |
| people | 0 | 0 |
| programs-sites | 0 | 0 |
| strategies-content | 0 | 0 |
| communications | 0 | 0 |
| reporting | 0 | 0 |
| surveys | 0 | 0 |
| timesheets | 0 | 0 |
| finance | 0 | 0 |
| e-signature | 0 | 0 |
| migration | 1 | 1 |

## Scale to zero and back (derived)

| Service | Stop to first success through the gateway (ms) | Label |
|---|---|---|
| identity | 2105.4 | derived |
| people | n/a | unavailable |
| programs-sites | 1288.6 | derived |
| strategies-content | 1381.7 | derived |
| communications | n/a | unavailable |
| reporting | n/a | unavailable |
| surveys | 1175.3 | derived |
| timesheets | n/a | unavailable |
| finance | 1195.4 | derived |
| e-signature | 1182.3 | derived |

## Windows over 5 s

| Window | Route key | Duration (ms) |
|---|---|---|
| DC89312A-B233-729E-969AFA3ACCE473B8 | startup:legacy-start | 51125 |
| DCB13798-2265-FC57-B2A7EF10324F25DD | fault:window-import-interrupted | 31147 |
| DCDCDA1E-50C7-0FC3-9FA32B2F261856D7 | admin:carch.list{sharedid} | 8952 |
| DCCDCF1F-1766-7E56-9E2C82E8E3F862D7 | admin:csettings.sitecopy | 8129 |
| DCF58A6A-7EEA-5F1F-3FF5704B0BF1C5D6 | admin:carch.edit | 6588 |
| DCF49420-D53F-3209-7D7EEDF6F700EED0 | admin:carch.update | 6295 |

## Findings

| Kind | Subject | Detail |
|---|---|---|
| latency-ratio | csettings.list | target p95 94.8 ms is 1.68x legacy p95 56.4 ms (above 1.5x) |
| latency-ratio | gs-co-05.content.findMany | target p95 178.2 ms is 2.87x legacy p95 62 ms (above 1.5x) |
| latency-ratio | gs-co-05.feed | target p95 219.2 ms is 2.86x legacy p95 76.6 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/?method=findProperties&entityname=file | target p95 40.2 ms is 2.7x legacy p95 14.9 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/category/properties | target p95 44.6 ms is 2.15x legacy p95 20.7 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/comment/properties | target p95 43.2 ms is 2.32x legacy p95 18.6 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID} | target p95 66.4 ms is 1.58x legacy p95 42 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | target p95 55.1 ms is 1.77x legacy p95 31.1 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | target p95 65.9 ms is 1.66x legacy p95 39.7 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/content/?title=GS | target p95 59.5 ms is 1.71x legacy p95 34.8 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/content/new | target p95 60.8 ms is 1.61x legacy p95 37.8 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/content/properties | target p95 42.8 ms is 2.26x legacy p95 18.9 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/contentCategoryAssign/properties | target p95 47 ms is 2.42x legacy p95 19.4 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | target p95 69.7 ms is 1.52x legacy p95 45.8 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/contentnav/properties | target p95 43.6 ms is 2.17x legacy p95 20.1 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/feed/properties | target p95 50 ms is 2.16x legacy p95 23.1 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/fileMetaData/properties | target p95 45.1 ms is 2.31x legacy p95 19.5 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | target p95 43.9 ms is 2.48x legacy p95 17.7 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | target p95 39.5 ms is 2.88x legacy p95 13.7 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | target p95 47.6 ms is 2.09x legacy p95 22.8 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | target p95 40.2 ms is 2.79x legacy p95 14.4 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | target p95 44.7 ms is 2.55x legacy p95 17.5 ms (above 1.5x) |
| latency-ratio | gs-co-05:admin /_api/json/v1/tenant-a/stats/properties | target p95 47.5 ms is 2.51x legacy p95 18.9 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/?method=findProperties&entityname=file | target p95 145.4 ms is 10.54x legacy p95 13.8 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/category/properties | target p95 144.8 ms is 7.17x legacy p95 20.2 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/comment/properties | target p95 140.9 ms is 7.23x legacy p95 19.5 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content | target p95 280.7 ms is 1.7x legacy p95 165.1 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID} | target p95 146.8 ms is 3.93x legacy p95 37.4 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | target p95 166.4 ms is 3.38x legacy p95 49.2 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | target p95 138.7 ms is 5.66x legacy p95 24.5 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | target p95 136.1 ms is 5.17x legacy p95 26.3 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | target p95 149.6 ms is 3.57x legacy p95 41.9 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/?fields=title | target p95 219.7 ms is 2.3x legacy p95 95.6 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/?fields=title,summary,url | target p95 226 ms is 1.98x legacy p95 114.1 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | target p95 170 ms is 3.11x legacy p95 54.6 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | target p95 275.8 ms is 1.77x legacy p95 156 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/?sortBy=nosuchcol | target p95 327.5 ms is 1.61x legacy p95 203.5 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/?title=GS | target p95 149.9 ms is 4.08x legacy p95 36.7 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/new | target p95 141.6 ms is 4.32x legacy p95 32.8 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/content/properties | target p95 145.9 ms is 7.19x legacy p95 20.3 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/contentCategoryAssign/properties | target p95 145.2 ms is 7.48x legacy p95 19.4 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | target p95 150.3 ms is 4.23x legacy p95 35.5 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/contentnav/?fields=title | target p95 210.9 ms is 2.19x legacy p95 96.2 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | target p95 199.2 ms is 2.27x legacy p95 87.7 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/contentnav/properties | target p95 146.2 ms is 7.03x legacy p95 20.8 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/feed/properties | target p95 141 ms is 5.83x legacy p95 24.2 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/fileMetaData/properties | target p95 148.4 ms is 7.53x legacy p95 19.7 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | target p95 145.1 ms is 7.48x legacy p95 19.4 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | target p95 139.8 ms is 9.71x legacy p95 14.4 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | target p95 144.2 ms is 5.46x legacy p95 26.4 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | target p95 148.2 ms is 9.04x legacy p95 16.4 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | target p95 140.5 ms is 7.55x legacy p95 18.6 ms (above 1.5x) |
| latency-ratio | gs-co-05:anon /_api/json/v1/tenant-a/stats/properties | target p95 142.9 ms is 7.44x legacy p95 19.2 ms (above 1.5x) |
| latency-ratio | timesheets.sheets | target p95 49.7 ms is 2.02x legacy p95 24.6 ms (above 1.5x) |
| legacy-served | cusers.listusers | admin:cusers.listusers is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05.content.findMany | api:content.findmany is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05.feed | feed:v1 is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/?method=findProperties&entityname=file | api:file.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/category/properties | api:category.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/comment/properties | api:comment.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content | api:content.findall is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID} | api:content.findone is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | api:content.findcrumbarray is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | api:content.findversionhistory is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | api:content.findpermissions is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | api:content.findrelatedcontent is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/?fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/?fields=title,summary,url | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/?pageIndex=-1 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/?pageIndex=-3 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/?pageIndex=0 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/?title=GS | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/new | api:content.findnew is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/content/properties | api:content.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/contentCategoryAssign/properties | api:contentcategoryassign.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | api:content.findone is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/contentnav/?fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/contentnav/properties | api:content.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/feed/properties | api:feed.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/fileMetaData/properties | api:filemetadata.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | api:findcalendaritems is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | api:findcrumbarray is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | api:findrelatedcontent is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | api:findversionhistory is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | api:geturlforimage is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:admin /_api/json/v1/tenant-a/stats/properties | api:stats.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/?method=findProperties&entityname=file | api:file.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/category/properties | api:category.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/comment/properties | api:comment.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content | api:content.findall is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID} | api:content.findone is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | api:content.findcrumbarray is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | api:content.findversionhistory is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | api:content.findpermissions is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | api:content.findrelatedcontent is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?fields=title,summary,url | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?itemsPerPage=1001&pageIndex=0&fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?pageIndex=-1 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?pageIndex=-3 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?pageIndex=0 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?sortBy=nosuchcol | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/?title=GS | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/new | api:content.findnew is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/content/properties | api:content.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/contentCategoryAssign/properties | api:contentcategoryassign.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | api:content.findone is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/contentnav/?fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/contentnav/properties | api:content.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/feed/properties | api:feed.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/fileMetaData/properties | api:filemetadata.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | api:findcalendaritems is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | api:findcrumbarray is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | api:findrelatedcontent is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | api:findversionhistory is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | api:geturlforimage is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | gs-co-05:anon /_api/json/v1/tenant-a/stats/properties | api:stats.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | timesheets.sheets | fixture:timesheets/sheets@get is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| non-ok-response | gs-co-05:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID}/legacy | 200 of 200: 500 |
| non-ok-response | gs-co-05:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID}/target | 200 of 200: 500 |
| non-ok-response | gs-co-05:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID}/legacy | 200 of 200: 500 |
| non-ok-response | gs-co-05:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID}/target | 200 of 200: 500 |
| non-ok-response | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history/legacy | 200 of 200: 401 |
| non-ok-response | gs-co-05:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history/target | 200 of 200: 401 |
| non-ok-response | gs-co-05:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID}/legacy | 200 of 200: 500 |
| non-ok-response | gs-co-05:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID}/target | 200 of 200: 500 |
| non-ok-response | gs-co-05:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID}/legacy | 200 of 200: 500 |
| non-ok-response | gs-co-05:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID}/target | 200 of 200: 500 |
| probe-not-target | communications | fixture:communications/templates@get is legacy-routed in v0002, so no gateway read reaches communications |
| probe-not-target | people | admin:cusers.listusers is legacy-routed in v0002, so no gateway read reaches people |
| probe-not-target | reporting | fixture:reporting/exports@get is legacy-routed in v0002, so no gateway read reaches reporting |
| probe-not-target | timesheets | fixture:timesheets/sheets@get is legacy-routed in v0002, so no gateway read reaches timesheets |
| window-over-threshold | DC89312A-B233-729E-969AFA3ACCE473B8 | startup:legacy-start 51125 ms |
| window-over-threshold | DCB13798-2265-FC57-B2A7EF10324F25DD | fault:window-import-interrupted 31147 ms |
| window-over-threshold | DCCDCF1F-1766-7E56-9E2C82E8E3F862D7 | admin:csettings.sitecopy 8129 ms |
| window-over-threshold | DCDCDA1E-50C7-0FC3-9FA32B2F261856D7 | admin:carch.list{sharedid} 8952 ms |
| window-over-threshold | DCF49420-D53F-3209-7D7EEDF6F700EED0 | admin:carch.update 6295 ms |
| window-over-threshold | DCF58A6A-7EEA-5F1F-3FF5704B0BF1C5D6 | admin:carch.edit 6588 ms |
