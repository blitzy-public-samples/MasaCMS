# Performance report
Source SHA: 696383140578f8dea3ece26f80cd7bfb370ddf0f

## Method

- 200 sequential requests per read set and side, interleaved: one legacy request, then one target request.
- p50 and p95 by nearest rank, in ms rounded to 0.1.
- Target is the gateway with the active cut-over version; legacy is the ColdFusion origin, requested directly.
- Source `catalogue` rows are the fixed JSON API content reads, written as catalogue steps: one per session and path of their matrix, named `content-reads:<session> <route>` with seed placeholders kept; source `read-set` rows are the fixed findMany, feed, `cusers.listusers` and `csettings.list` reads. The feed row reads a Local collection the run creates through the gateway just before the set and deletes just after it.
- Served by is the side the active cut-over version routes the row's route key to. On a `legacy` row the target columns measure the gateway proxying to legacy, and a `legacy-served` finding says so.
- The request sets no latency threshold: a target p95 above 1.5x legacy and a write window over 5 s are flags, not failures.
- The legacy-direct admin session logs in on legacy itself, which updates that user's `tusers.LastLogin` on the legacy side.
- Cold start is measured locally (process start to the first `/healthz` 200); scale to zero and back is derived (stopped service, restart, first successful request through the gateway), and `unavailable` where no such request was timed. Each poll is bounded at 60000 ms.
- Each service is probed only by identity's admin login or by a request that leaves the compared state unchanged: a read, or a view whose writes are idempotent. A service none of whose probe candidates the active version routes to target has an `unavailable` row and a `probe-not-target` finding naming the candidates' route keys.
- Cloud measurement: not possible without apply.

## Latency

| Set | Source | Served by | Requests | Target p50 (ms) | Target p95 (ms) | Legacy p50 (ms) | Legacy p95 (ms) | Ratio p95 | Finding |
|---|---|---|---|---|---|---|---|---|---|
| content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID} | catalogue | legacy | 200 | 101.5 | 164 | 31.6 | 40.4 | 4.06 | target p95 164 ms is 4.06x legacy p95 40.4 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content | catalogue | legacy | 200 | 228.9 | 253 | 156.4 | 170.1 | 1.49 |  |
| content-reads:anon /_api/json/v1/tenant-a/content/?title=GS | catalogue | legacy | 200 | 98.4 | 119.4 | 31.7 | 38 | 3.14 | target p95 119.4 ms is 3.14x legacy p95 38 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | catalogue | legacy | 200 | 218.6 | 245.4 | 145.9 | 161.1 | 1.52 | target p95 245.4 ms is 1.52x legacy p95 161.1 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/new | catalogue | legacy | 200 | 93.6 | 113.9 | 27 | 33.9 | 3.36 | target p95 113.9 ms is 3.36x legacy p95 33.9 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/properties | catalogue | legacy | 200 | 81.7 | 101.9 | 17.1 | 20.7 | 4.92 | target p95 101.9 ms is 4.92x legacy p95 20.7 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | catalogue | legacy | 200 | 89.7 | 124 | 21.6 | 26.5 | 4.68 | target p95 124 ms is 4.68x legacy p95 26.5 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | catalogue | legacy | 200 | 98.2 | 122.5 | 30.7 | 35.9 | 3.41 | target p95 122.5 ms is 3.41x legacy p95 35.9 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | catalogue | legacy | 200 | 119.7 | 142.1 | 50.2 | 59.2 | 2.4 | target p95 142.1 ms is 2.4x legacy p95 59.2 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | catalogue | legacy | 200 | 105.3 | 133.4 | 36.5 | 45.2 | 2.95 | target p95 133.4 ms is 2.95x legacy p95 45.2 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | catalogue | legacy | 200 | 92.8 | 122.5 | 20.6 | 24.7 | 4.96 | target p95 122.5 ms is 4.96x legacy p95 24.7 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 82 | 113.6 | 13.1 | 18.1 | 6.28 | target p95 113.6 ms is 6.28x legacy p95 18.1 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 95.8 | 124.7 | 22.6 | 27.7 | 4.5 | target p95 124.7 ms is 4.5x legacy p95 27.7 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 83.5 | 172.8 | 13.7 | 27.9 | 6.19 | target p95 172.8 ms is 6.19x legacy p95 27.9 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | catalogue | legacy | 200 | 91.8 | 138.5 | 16.6 | 22.1 | 6.27 | target p95 138.5 ms is 6.27x legacy p95 22.1 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | catalogue | legacy | 200 | 90.4 | 132.5 | 16.5 | 22.3 | 5.94 | target p95 132.5 ms is 5.94x legacy p95 22.3 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID} | catalogue | legacy | 200 | 63.4 | 76.2 | 42.6 | 51.5 | 1.48 |  |
| content-reads:admin /_api/json/v1/tenant-a/content | catalogue | legacy | 200 | 196.3 | 220.5 | 169.7 | 210.6 | 1.05 |  |
| content-reads:admin /_api/json/v1/tenant-a/content/?title=GS | catalogue | legacy | 200 | 54.1 | 66.4 | 33.9 | 42.5 | 1.56 | target p95 66.4 ms is 1.56x legacy p95 42.5 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | catalogue | legacy | 200 | 185.4 | 198.1 | 160.9 | 174 | 1.14 |  |
| content-reads:admin /_api/json/v1/tenant-a/content/new | catalogue | legacy | 200 | 54.5 | 66.6 | 35.2 | 42 | 1.59 | target p95 66.6 ms is 1.59x legacy p95 42 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/content/properties | catalogue | legacy | 200 | 36.5 | 46.1 | 17.2 | 22 | 2.1 | target p95 46.1 ms is 2.1x legacy p95 22 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | catalogue | legacy | 200 | 46.3 | 58.1 | 26.8 | 34.1 | 1.7 | target p95 58.1 ms is 1.7x legacy p95 34.1 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | catalogue | legacy | 200 | 62.5 | 91.6 | 42.1 | 51.2 | 1.79 | target p95 91.6 ms is 1.79x legacy p95 51.2 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | catalogue | legacy | 200 | 87.3 | 162.7 | 65 | 84.5 | 1.93 | target p95 162.7 ms is 1.93x legacy p95 84.5 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | catalogue | legacy | 200 | 62.6 | 96.9 | 40.2 | 53.7 | 1.8 | target p95 96.9 ms is 1.8x legacy p95 53.7 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | catalogue | legacy | 200 | 76.6 | 125.5 | 52.9 | 63.9 | 1.96 | target p95 125.5 ms is 1.96x legacy p95 63.9 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 33.9 | 51.9 | 13.2 | 18.4 | 2.82 | target p95 51.9 ms is 2.82x legacy p95 18.4 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 43.3 | 52.5 | 22.7 | 28.7 | 1.83 | target p95 52.5 ms is 1.83x legacy p95 28.7 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | catalogue | legacy | 200 | 35.2 | 46.4 | 13.3 | 21.7 | 2.14 | target p95 46.4 ms is 2.14x legacy p95 21.7 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | catalogue | legacy | 200 | 37.5 | 48.2 | 16.2 | 22.2 | 2.17 | target p95 48.2 ms is 2.17x legacy p95 22.2 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | catalogue | legacy | 200 | 37.1 | 46.6 | 15.8 | 20.5 | 2.27 | target p95 46.6 ms is 2.27x legacy p95 20.5 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/?pageIndex=-3 | catalogue | legacy | 200 | 426.2 | 890.7 | 330.8 | 625.5 | 1.42 |  |
| content-reads:anon /_api/json/v1/tenant-a/content/?pageIndex=0 | catalogue | legacy | 200 | 409.5 | 688.8 | 323.7 | 410.9 | 1.68 | target p95 688.8 ms is 1.68x legacy p95 410.9 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/?pageIndex=-1 | catalogue | legacy | 200 | 528.4 | 1322.7 | 340.1 | 658.2 | 2.01 | target p95 1322.7 ms is 2.01x legacy p95 658.2 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | catalogue | legacy | 200 | 214.1 | 706 | 59 | 248.8 | 2.84 | target p95 706 ms is 2.84x legacy p95 248.8 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/?fields=title | catalogue | legacy | 200 | 266.9 | 752.4 | 99.9 | 234.5 | 3.21 | target p95 752.4 ms is 3.21x legacy p95 234.5 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/?fields=title,summary,url | catalogue | legacy | 200 | 208.9 | 439.5 | 115.3 | 134.6 | 3.27 | target p95 439.5 ms is 3.27x legacy p95 134.6 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/contentnav/?fields=title | catalogue | legacy | 200 | 194.3 | 464 | 96.3 | 162.7 | 2.85 | target p95 464 ms is 2.85x legacy p95 162.7 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | catalogue | legacy | 200 | 249.8 | 763.8 | 87.7 | 198.3 | 3.85 | target p95 763.8 ms is 3.85x legacy p95 198.3 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/contentnav/properties | catalogue | legacy | 200 | 134.9 | 534.2 | 18.1 | 103.4 | 5.17 | target p95 534.2 ms is 5.17x legacy p95 103.4 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/comment/properties | catalogue | legacy | 200 | 155.9 | 543.2 | 18 | 102.7 | 5.29 | target p95 543.2 ms is 5.29x legacy p95 102.7 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/category/properties | catalogue | legacy | 200 | 105.6 | 235.4 | 18.2 | 45.7 | 5.15 | target p95 235.4 ms is 5.15x legacy p95 45.7 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/contentCategoryAssign/properties | catalogue | legacy | 200 | 85.9 | 109.7 | 16.3 | 22.5 | 4.88 | target p95 109.7 ms is 4.88x legacy p95 22.5 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/fileMetaData/properties | catalogue | legacy | 200 | 86.3 | 122.6 | 16.9 | 23.2 | 5.28 | target p95 122.6 ms is 5.28x legacy p95 23.2 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/feed/properties | catalogue | legacy | 200 | 95 | 191 | 19.9 | 84.8 | 2.25 | target p95 191 ms is 2.25x legacy p95 84.8 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/stats/properties | catalogue | legacy | 200 | 97.5 | 231.4 | 16.6 | 53.8 | 4.3 | target p95 231.4 ms is 4.3x legacy p95 53.8 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/?method=findProperties&entityname=file | catalogue | legacy | 200 | 94.7 | 267.7 | 12 | 16.1 | 16.63 | target p95 267.7 ms is 16.63x legacy p95 16.1 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/content/?pageIndex=-3 | catalogue | legacy | 200 | 336.7 | 498 | 310.5 | 506.9 | 0.98 |  |
| content-reads:admin /_api/json/v1/tenant-a/content/?pageIndex=0 | catalogue | legacy | 200 | 328.2 | 360.4 | 307.5 | 337.2 | 1.07 |  |
| content-reads:admin /_api/json/v1/tenant-a/content/?pageIndex=-1 | catalogue | legacy | 200 | 330.4 | 362.9 | 308.6 | 339.2 | 1.07 |  |
| content-reads:admin /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | catalogue | legacy | 200 | 70.3 | 81.4 | 51.5 | 59.2 | 1.38 |  |
| content-reads:admin /_api/json/v1/tenant-a/content/?fields=title | catalogue | legacy | 200 | 114 | 138.9 | 94 | 109.1 | 1.27 |  |
| content-reads:admin /_api/json/v1/tenant-a/content/?fields=title,summary,url | catalogue | legacy | 200 | 132.9 | 142.9 | 110.5 | 125.8 | 1.14 |  |
| content-reads:admin /_api/json/v1/tenant-a/contentnav/?fields=title | catalogue | legacy | 200 | 113.8 | 129.3 | 93.3 | 101.6 | 1.27 |  |
| content-reads:admin /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | catalogue | legacy | 200 | 104.7 | 130.1 | 85 | 109.2 | 1.19 |  |
| content-reads:admin /_api/json/v1/tenant-a/contentnav/properties | catalogue | legacy | 200 | 36.1 | 44.1 | 17.1 | 22.5 | 1.96 | target p95 44.1 ms is 1.96x legacy p95 22.5 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/comment/properties | catalogue | legacy | 200 | 34.1 | 41.3 | 15.9 | 19.9 | 2.08 | target p95 41.3 ms is 2.08x legacy p95 19.9 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/category/properties | catalogue | legacy | 200 | 36.7 | 47.4 | 17.2 | 22.2 | 2.14 | target p95 47.4 ms is 2.14x legacy p95 22.2 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/contentCategoryAssign/properties | catalogue | legacy | 200 | 37 | 146 | 16.6 | 174.2 | 0.84 |  |
| content-reads:admin /_api/json/v1/tenant-a/fileMetaData/properties | catalogue | legacy | 200 | 37.3 | 96.9 | 17 | 86 | 1.13 |  |
| content-reads:admin /_api/json/v1/tenant-a/feed/properties | catalogue | legacy | 200 | 40.5 | 106.9 | 20.2 | 55.9 | 1.91 | target p95 106.9 ms is 1.91x legacy p95 55.9 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/stats/properties | catalogue | legacy | 200 | 37 | 46.6 | 16.2 | 22.3 | 2.09 | target p95 46.6 ms is 2.09x legacy p95 22.3 ms (above 1.5x) |
| content-reads:admin /_api/json/v1/tenant-a/?method=findProperties&entityname=file | catalogue | legacy | 200 | 33.7 | 43.8 | 12.3 | 14.2 | 3.08 | target p95 43.8 ms is 3.08x legacy p95 14.2 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/?sortBy=nosuchcol | catalogue | legacy | 200 | 323.4 | 1046.1 | 200.4 | 358.3 | 2.92 | target p95 1046.1 ms is 2.92x legacy p95 358.3 ms (above 1.5x) |
| content-reads:anon /_api/json/v1/tenant-a/content/?itemsPerPage=1001&pageIndex=0&fields=title | catalogue | legacy | 200 | 3279.8 | 4637 | 2908.2 | 3485.1 | 1.33 |  |
| content-reads.content.findMany | read-set | legacy | 200 | 464.5 | 1222.2 | 85.2 | 244.6 | 5 | target p95 1222.2 ms is 5x legacy p95 244.6 ms (above 1.5x) |
| content-reads.feed | read-set | legacy | 200 | 404.9 | 1253.4 | 84.3 | 279.2 | 4.49 | target p95 1253.4 ms is 4.49x legacy p95 279.2 ms (above 1.5x) |
| cusers.listusers | read-set | legacy | 200 | 169.9 | 248.9 | 124.4 | 191.9 | 1.3 |  |
| csettings.list | read-set | target | 200 | 103.5 | 228.3 | 57.4 | 71.6 | 3.19 | target p95 228.3 ms is 3.19x legacy p95 71.6 ms (above 1.5x) |

## Cold start (measured)

| Service | Start to first 200 (ms) |
|---|---|
| identity | 1397.7 |
| people | 1277.8 |
| programs-sites | 1292 |
| strategies-content | 1341.3 |

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
| migration | 1 | 1 |

## Scale to zero and back (derived)

| Service | Stop to first success through the gateway (ms) | Label |
|---|---|---|
| identity | 3783 | derived |
| people | n/a | unavailable |
| programs-sites | 1509.6 | derived |
| strategies-content | 1500.2 | derived |

## Windows over 5 s

| Window | Route key | Duration (ms) |
|---|---|---|
| C4059A51-747B-30A3-A2A8CE7794A0F469 | startup:legacy-start | 58790 |
| DC89312A-B233-729E-969AFA3ACCE473B8 | startup:legacy-start | 51125 |
| C4265CC5-52E7-4CBC-F082251598080821 | fault:window-import-interrupted | 33723 |
| DCB13798-2265-FC57-B2A7EF10324F25DD | fault:window-import-interrupted | 31147 |
| DCDCDA1E-50C7-0FC3-9FA32B2F261856D7 | admin:carch.list{sharedid} | 8952 |
| DCCDCF1F-1766-7E56-9E2C82E8E3F862D7 | admin:csettings.sitecopy | 8129 |
| DCF58A6A-7EEA-5F1F-3FF5704B0BF1C5D6 | admin:carch.edit | 6588 |
| DCF49420-D53F-3209-7D7EEDF6F700EED0 | admin:carch.update | 6295 |

## Findings

| Kind | Subject | Detail |
|---|---|---|
| latency-ratio | content-reads.content.findMany | target p95 1222.2 ms is 5x legacy p95 244.6 ms (above 1.5x) |
| latency-ratio | content-reads.feed | target p95 1253.4 ms is 4.49x legacy p95 279.2 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/?method=findProperties&entityname=file | target p95 43.8 ms is 3.08x legacy p95 14.2 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/category/properties | target p95 47.4 ms is 2.14x legacy p95 22.2 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/comment/properties | target p95 41.3 ms is 2.08x legacy p95 19.9 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | target p95 162.7 ms is 1.93x legacy p95 84.5 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | target p95 125.5 ms is 1.96x legacy p95 63.9 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | target p95 58.1 ms is 1.7x legacy p95 34.1 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | target p95 96.9 ms is 1.8x legacy p95 53.7 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/content/?title=GS | target p95 66.4 ms is 1.56x legacy p95 42.5 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/content/new | target p95 66.6 ms is 1.59x legacy p95 42 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/content/properties | target p95 46.1 ms is 2.1x legacy p95 22 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | target p95 91.6 ms is 1.79x legacy p95 51.2 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/contentnav/properties | target p95 44.1 ms is 1.96x legacy p95 22.5 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/feed/properties | target p95 106.9 ms is 1.91x legacy p95 55.9 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | target p95 48.2 ms is 2.17x legacy p95 22.2 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | target p95 51.9 ms is 2.82x legacy p95 18.4 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | target p95 52.5 ms is 1.83x legacy p95 28.7 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | target p95 46.4 ms is 2.14x legacy p95 21.7 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | target p95 46.6 ms is 2.27x legacy p95 20.5 ms (above 1.5x) |
| latency-ratio | content-reads:admin /_api/json/v1/tenant-a/stats/properties | target p95 46.6 ms is 2.09x legacy p95 22.3 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/?method=findProperties&entityname=file | target p95 267.7 ms is 16.63x legacy p95 16.1 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/category/properties | target p95 235.4 ms is 5.15x legacy p95 45.7 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/comment/properties | target p95 543.2 ms is 5.29x legacy p95 102.7 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID} | target p95 164 ms is 4.06x legacy p95 40.4 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | target p95 142.1 ms is 2.4x legacy p95 59.2 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | target p95 122.5 ms is 4.96x legacy p95 24.7 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | target p95 124 ms is 4.68x legacy p95 26.5 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | target p95 133.4 ms is 2.95x legacy p95 45.2 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/?fields=title | target p95 752.4 ms is 3.21x legacy p95 234.5 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/?fields=title,summary,url | target p95 439.5 ms is 3.27x legacy p95 134.6 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | target p95 706 ms is 2.84x legacy p95 248.8 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | target p95 245.4 ms is 1.52x legacy p95 161.1 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/?pageIndex=-1 | target p95 1322.7 ms is 2.01x legacy p95 658.2 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/?pageIndex=0 | target p95 688.8 ms is 1.68x legacy p95 410.9 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/?sortBy=nosuchcol | target p95 1046.1 ms is 2.92x legacy p95 358.3 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/?title=GS | target p95 119.4 ms is 3.14x legacy p95 38 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/new | target p95 113.9 ms is 3.36x legacy p95 33.9 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/content/properties | target p95 101.9 ms is 4.92x legacy p95 20.7 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/contentCategoryAssign/properties | target p95 109.7 ms is 4.88x legacy p95 22.5 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | target p95 122.5 ms is 3.41x legacy p95 35.9 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/contentnav/?fields=title | target p95 464 ms is 2.85x legacy p95 162.7 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | target p95 763.8 ms is 3.85x legacy p95 198.3 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/contentnav/properties | target p95 534.2 ms is 5.17x legacy p95 103.4 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/feed/properties | target p95 191 ms is 2.25x legacy p95 84.8 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/fileMetaData/properties | target p95 122.6 ms is 5.28x legacy p95 23.2 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | target p95 138.5 ms is 6.27x legacy p95 22.1 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | target p95 113.6 ms is 6.28x legacy p95 18.1 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | target p95 124.7 ms is 4.5x legacy p95 27.7 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | target p95 172.8 ms is 6.19x legacy p95 27.9 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | target p95 132.5 ms is 5.94x legacy p95 22.3 ms (above 1.5x) |
| latency-ratio | content-reads:anon /_api/json/v1/tenant-a/stats/properties | target p95 231.4 ms is 4.3x legacy p95 53.8 ms (above 1.5x) |
| latency-ratio | csettings.list | target p95 228.3 ms is 3.19x legacy p95 71.6 ms (above 1.5x) |
| legacy-served | content-reads.content.findMany | api:content.findmany is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads.feed | feed:v1 is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/?method=findProperties&entityname=file | api:file.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/category/properties | api:category.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/comment/properties | api:comment.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content | api:content.findall is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID} | api:content.findone is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | api:content.findcrumbarray is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | api:content.findversionhistory is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | api:content.findpermissions is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | api:content.findrelatedcontent is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/?fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/?fields=title,summary,url | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/?pageIndex=-1 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/?pageIndex=-3 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/?pageIndex=0 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/?title=GS | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/new | api:content.findnew is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/content/properties | api:content.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/contentCategoryAssign/properties | api:contentcategoryassign.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | api:content.findone is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/contentnav/?fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/contentnav/properties | api:content.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/feed/properties | api:feed.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/fileMetaData/properties | api:filemetadata.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | api:findcalendaritems is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | api:findcrumbarray is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | api:findrelatedcontent is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | api:findversionhistory is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | api:geturlforimage is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:admin /_api/json/v1/tenant-a/stats/properties | api:stats.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/?method=findProperties&entityname=file | api:file.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/category/properties | api:category.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/comment/properties | api:comment.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content | api:content.findall is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID} | api:content.findone is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/crumbs | api:content.findcrumbarray is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history | api:content.findversionhistory is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/permissions | api:content.findpermissions is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/relatedcontent | api:content.findrelatedcontent is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?fields=title,summary,url | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?itemsPerPage=-1 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?itemsPerPage=1001&pageIndex=0&fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?method=findQuery&entityname=content&type=Page | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?pageIndex=-1 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?pageIndex=-3 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?pageIndex=0 | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?sortBy=nosuchcol | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/?title=GS | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/new | api:content.findnew is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/content/properties | api:content.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/contentCategoryAssign/properties | api:contentcategoryassign.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/contentnav/${seed.page.contentID} | api:content.findone is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/contentnav/?fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/contentnav/?parentid=${seed.feed.contentID}&fields=title | api:content.findquery is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/contentnav/properties | api:content.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/feed/properties | api:feed.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/fileMetaData/properties | api:filemetadata.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/findCalendarItems?calendarid=${seed.page.contentID}&start=2026-06-01&end=2026-06-30 | api:findcalendaritems is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID} | api:findcrumbarray is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/findRelatedContent?contentid=${seed.page.contentID} | api:findrelatedcontent is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID} | api:findversionhistory is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/getURLForImage?fileid=${seed.image.fileID}&size=small | api:geturlforimage is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | content-reads:anon /_api/json/v1/tenant-a/stats/properties | api:stats.findproperties is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| legacy-served | cusers.listusers | admin:cusers.listusers is legacy-routed in v0002: the target columns measure the gateway proxying to legacy |
| non-ok-response | content-reads:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID}/legacy | 200 of 200: 500 |
| non-ok-response | content-reads:admin /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID}/target | 200 of 200: 500 |
| non-ok-response | content-reads:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID}/legacy | 200 of 200: 500 |
| non-ok-response | content-reads:admin /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID}/target | 200 of 200: 500 |
| non-ok-response | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history/legacy | 200 of 200: 401 |
| non-ok-response | content-reads:anon /_api/json/v1/tenant-a/content/${seed.page.contentID}/history/target | 200 of 200: 401 |
| non-ok-response | content-reads:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID}/legacy | 200 of 200: 500 |
| non-ok-response | content-reads:anon /_api/json/v1/tenant-a/findCrumbArray?contentid=${seed.page.contentID}/target | 200 of 200: 500 |
| non-ok-response | content-reads:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID}/legacy | 200 of 200: 500 |
| non-ok-response | content-reads:anon /_api/json/v1/tenant-a/findVersionHistory?contentid=${seed.page.contentID}/target | 200 of 200: 500 |
| probe-not-target | people | admin:cusers.listusers is legacy-routed in v0002, so no gateway read reaches people |
| window-over-threshold | C4059A51-747B-30A3-A2A8CE7794A0F469 | startup:legacy-start 58790 ms |
| window-over-threshold | C4265CC5-52E7-4CBC-F082251598080821 | fault:window-import-interrupted 33723 ms |
| window-over-threshold | DC89312A-B233-729E-969AFA3ACCE473B8 | startup:legacy-start 51125 ms |
| window-over-threshold | DCB13798-2265-FC57-B2A7EF10324F25DD | fault:window-import-interrupted 31147 ms |
| window-over-threshold | DCCDCF1F-1766-7E56-9E2C82E8E3F862D7 | admin:csettings.sitecopy 8129 ms |
| window-over-threshold | DCDCDA1E-50C7-0FC3-9FA32B2F261856D7 | admin:carch.list{sharedid} 8952 ms |
| window-over-threshold | DCF49420-D53F-3209-7D7EEDF6F700EED0 | admin:carch.update 6295 ms |
| window-over-threshold | DCF58A6A-7EEA-5F1F-3FF5704B0BF1C5D6 | admin:carch.edit 6588 ms |
