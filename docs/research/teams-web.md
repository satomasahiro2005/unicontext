# Microsoft Teams through the official web client (research, 2026-10-02)

Why: the shizuoka.ac.jp tenant blocks user consent for self-registered apps, so Graph with our own
app is out (see `shizuoka.md` §5 and `docs/connectors/microsoft365.md`). This note maps what the
official Teams web client (`https://teams.cloud.microsoft/`, build `26090315820`, ring `general`,
locale ja-jp) loads for the student, and proposes a connector that only observes that client in the
UniContext browser profile. Rules kept during the research: no other apps' client ids, no token
extraction or reuse outside the page, no policy bypass, read-only (nothing posted, reacted, joined,
submitted or marked).

Labels: **[observed]** = seen in this session (network entry, response, DOM, IndexedDB, or a literal in
the client's own shipped JS); **[code]** = a URL template / header name read from the client's
shipped JS but not seen on the wire; **[inferred]** = reasoning or public knowledge, not verified here.

## 0. Method and its limits

- Chrome (logged-in profile) via claude-in-chrome, one tab. Sign-in was already valid; no password or
  MFA prompt appeared for Teams, SharePoint or Assignments.
- **The data traffic is not visible from the page.** Teams v2 runs its data layer in a dedicated web
  worker (`/v2/worker/precompiled-web-worker-<hash>.js`, `workerId: "precore-worker"`) behind a
  service worker. `read_network_requests` (tab-level) and the main thread's Resource Timing only
  showed CDN chunks, profile pictures, token calls and five main-thread fetches; none of the
  CSA/chatsvc calls. A hard reload (page not controlled by the SW) did not change that.
- So the endpoint map comes from:
  1. the worker's own code: the bootstrap lists its chunks in `self.cdlWorkerManifest`
     (6 files, ~19.5 MB, public CDN `teams.public.onecdn.static.microsoft/teams-modular-packages/hashed-assets/`),
     grepped in-page for URL templates, `apiName`s and header names **[code]**;
  2. the client's region/endpoint config in `localStorage` key `tmp.auth.v1.<userId>.Discover.DISCOVER-REGION-GTM`
     (service base URLs only; the neighbouring token keys were not read) **[observed]**;
  3. the client's IndexedDB caches (`conversation-manager`, `replychain-manager`, `syncstate-manager`,
     `activity-manager`), which hold what the worker fetched, in the client's own shape **[observed]**;
  4. cookie-only probes (same-origin `fetch` with `credentials: 'include'` and no auth header) to see
     which services accept the page's cookies **[observed]**;
  5. SharePoint REST, read with same-origin `fetch` on the team's SharePoint site **[observed]**;
  6. the Assignments iframe's bundles (`res.public.onecdn.static.microsoft/eduassignmentsui/`) **[code]**.
- Not observed on the wire: CSA / chatsvc / Assignments request and response bodies, paging headers
  in responses, throttling responses. A Playwright spike (§8) must confirm these before coding.

## 1. Client architecture (what loads)

| Piece | Where | Notes |
|---|---|---|
| Shell, React UI | `teams.cloud.microsoft` (main thread) | URL stays `/` while navigating; title shows `チームとチャネル \| <team> \| <channel>` **[observed]** |
| Data worker | `/v2/worker/precompiled-web-worker-<hash>.js` → chunks in `cdlWorkerManifest` | All CSA/chatsvc/middle-tier calls, GraphQL-style resolvers back to the UI **[observed: worker exists; code]** |
| Service worker | controls the page normally | `navigator.serviceWorker.controller` true; false after Ctrl+Shift+R, and the client still worked **[observed]** |
| Local cache | ~100 IndexedDB DBs named `Teams:<manager>:react-web-client:<userId>:<tenantId>:ja-jp` | e.g. `conversation-manager` v3 (56 rows), `replychain-manager` v2 (140 chains), `syncstate-manager` v3 (188 rows) **[observed]** |
| Assignments / 課題 | iframe `https://assignments.edu.cloud.microsoft/?isTeamsFrame&tenantId&userId&hostClientType&locale&sessionId&subEntityId&theme&trackingId&userRole&userClickTime&appLaunchId` | Cross-origin; gets tokens from the Teams host (nested app auth: token POSTs to `login.microsoftonline.com/<tenant>/oauth2/v2.0/token` with a `brk_client_id` were observed when it opened). Opened stand-alone it renders blank (waits for the Teams host) **[observed]** |
| Channel "共有済み" (Shared) tab | iframe `https://<tenant>.sharepoint.com/sites/<site>/_layouts/15/filebrowser.aspx?fileBrowser&app&teamId&channelId&entityId&theme&ringId&locale&sid&asid&subEntityId&scenario&auth&p&hostName` | This is SharePoint's own UI. New Teams shows "共有済み" instead of a "Files" tab **[observed]** |

Endpoint config from `DISCOVER-REGION-GTM` (112 keys) **[observed]**:

| Key | Value for this user |
|---|---|
| `chatServiceAfd` | `https://teams.cloud.microsoft/api/chatsvc/jp` |
| `chatService` | `https://jp.ng.msg.teams.microsoft.com` |
| `chatServiceAggregator` | `https://chatsvcagg.teams.microsoft.com` (CSA; worker default `https://teams.microsoft.com/api/csa`, version paths `api/v1/`, `api/v2/`, `api/v3/` **[code]**) |
| `middleTier`, `teamsAndChannelsService` | `https://teams.cloud.microsoft/api/mt/apac` |
| `ams`, `urlp` | `https://jp-prod.asyncgw.teams.microsoft.com` (+`/urlp`) |
| `search` | `https://jp-prod.asyncgw.teams.microsoft.com/msgsearch` |
| `userIntelligenceService` | `https://teams.cloud.microsoft/api/nss/apac` |
| `calling_trouterUrl` | `https://go.trouter.teams.microsoft.com/v3/c` (push channel) |
| `eduGRGServiceUrl` | `https://gateway.schoolapp.microsoft.com` |

The worker also carries `chatServiceAfdHostnames: ["teams.microsoft.com","teams.live.com","teams.cloud.microsoft",...]`
and sends the regional backend in header `x-csendpoint` **[code]**.

## 2. What this student has (counts only)

- 9 teams: 7 `spaceType: class` (shown under "クラス"), 2 `spaceType: edu` (shown under "チーム") **[observed]**.
  Channels per team (non-General): 6, 3, 3, 15, 2, 4, 3, 1, 3 → 50 channels incl. the 9 General threads.
- Class team names mix year position and separators: `2026情報科学実験B`, `2025アルゴリズムとデータ構造`,
  `PBL演習2024情報科学科`, `2024プログラミング入門(科学科)`, `2026-機械語と計算機械`, `認知科学2024`,
  `2024-プログラミング(科学科)` **[observed]**. Old-year teams stay in the list.
- Class team left pane: ホームページ, Class Notebook, 授業 (Classwork), 課題 (Assignments), 成績 (Grades),
  Reflect; channel tabs: 投稿, 共有済み, ページ, Notes **[observed]**.
- In one class the teacher's pinned post says materials are in the channel's "共有済み/Shared" tab,
  i.e. the SharePoint folder, not in posts **[observed]**. Files are the main material source.
- Assignments bot cards: 36 cached posts by `28:7254e396-868c-4bf7-96b2-6fe763590b5a` ("Assignments"),
  21 in General, 13 in other channels **[observed]**.
- 3 chats (1:1/group). Global 課題 app showed "現在、今後の課題はありません" and an overdue banner **[observed]**.

## 3. Endpoint table

`{csa}` = CSA base (`.../api/csa/{region}` on the AFD host, or `chatsvcagg`), `{cs}` = `chatServiceAfd`,
`{mt}` = `middleTier`. Ids: team thread `19:<hex32>@thread.tacv2` (= General channel id), channel
`19:<hex32>@thread.tacv2`, group id = Entra group GUID, post id / reply chain id = ms-epoch string.

### 3.1 Teams and channels

| Method | Path pattern | Purpose | Response shape | Status |
|---|---|---|---|---|
| GET | `{csa}/api/v3/teams/users/me` (`apiName: startupclean`) | Full list: teams (with channels), chats, private feeds, folders | `{teams[], chats[], privateFeeds[], metadata{syncToken, isPartialData, latestRcmMetadataVersion}}`; team fields read by the client: `id, displayName, description, teamType (Standard/Edu/Class/Plc/Staff/...), isArchived?, isDeleted, isFavorite, isFollowed, isPinned, smtpAddress, threadVersion, picture, pictureETag, classification, dynamicMembership, isTeamLocked, isTenantWide, membershipSummary, teamSiteInformation{groupId, sharepointSiteUrl, notebookId}, sensitivityLabel, channels[]` | code (URL, keys); a cookie-only GET to `https://teams.cloud.microsoft/api/csa/apac/api/v3/teams/users/me` returned **401** (route exists, needs a token) |
| GET | `{csa}/api/v?/teams/users/me/updates` (`startupdelta`), header `x-ms-synctoken` | Incremental team/chat list | same as above, partial | code |
| GET | `{csa}/.../teams/users/me/groupchats`, `.../nonrecentchats?skipNonRecentMeeting&pageSize`, `.../chats?pageSize&continuationToken` | Chat lists | — | code |
| GET | `{mt}/beta/teams/usergroups`, `{mt}/beta/teams/{groupId}/groupSettings`, `groups/{groupId}/channels` | Membership/settings, channel list per team | — | code; cookie-only GET `.../beta/teams/usergroups` → **401** with `www-authenticate` |
| GET | `{mt}/beta/users/{userId}/profilepicturev2/teams/{groupId}?etag&displayName&voidCache=true` | Team picture | image | observed (200, loaded as `<img>`, so cookie-based) |

Client cache equivalent: `conversation-manager/conversations`, one row per team (`type: Space`) and per
channel (`type: Topic`), see `samples/teams-idb-conversations.json` **[observed]**. Useful fields:
`threadProperties.spaceThreadTopic` (team name), `spaceType` (`class`/`edu`), `groupId`,
`sharepointSiteUrl`, `channelDocsFolderRelativeUrl` (per channel folder), `description`, `createdat`,
`topics` (JSON string list of channels), `notebookId`; per channel `lastMessageTimeUtc`,
`properties.consumptionhorizon` (read marker), `lastMessage`.

### 3.2 Channel posts and replies

| Method | Path pattern | Purpose | Status |
|---|---|---|---|
| GET | `{csa}/.../containers/{channelId}/posts?modality=&pageSize=&teamId=&includeRcMetadata=true&filterSystemMessage=true&shouldIncludeSharedToL1Rc=true&includeReplySummary=true&tailMessageSize=`; next page: same + header `x-ms-continuation` (`apiName: recentposts[_continuation]`) | Newest posts with the last N replies of each | code |
| GET | `{csa}/.../containers/{channelId}/posts?threadedPostsOnly=true&pageSize=&teamId=...` (`recentthreads`) | Thread view variant | code |
| GET | `{csa}/.../teams/{teamThreadId}/channels/{channelId}?pageSize=[&filterSystemMessage=true][&skip=]` + `x-ms-continuation` (`replychains`, `replychains_v2`) | Older reply-chain listing | code |
| GET | `{csa}/.../teams/{teamThreadId}/channels/{channelId}/{replyChainId}` (`replychain`) | One post with its replies | code |
| GET | `{csa}/.../teams/{teamThreadId}/channels/{channelId}/posts/{postId}/replies?pageSize=[&includeRCLiteSummary=true][&orderByVersion=true]` + `x-ms-continuation` (`replies`, `repliesInChain`) | "Load more replies" | code |
| GET | `{csa}/.../teams/{teamThreadId}/channels/{channelId}/posts/{postId}` (`getPost`) | Single post | code |
| POST | `{csa}/.../batch/posts?tailMessageSize&includeReplySummary&includeRcMetadata&summaryExclusionSize`, body `{postRequests:[...]}` | Batched read of several posts (a POST that only reads) | code |
| GET | `{csa}/.../teams/{teamThreadId}/channels/{channelId}/pinbar` | Pinned posts | code |
| GET | `{cs}/v1/users/ME/conversations/{threadId}/messages?view=msnp24Equivalent\|supportsMessageProperties&pageSize=&startTime=` or `&syncState=` | Raw chat-service message stream (channels and chats); paging/sync via `syncState` | code; cookie-only GET of `{cs}/v1/users/ME/conversations` → **401** |
| GET | `{cs}/v1/users/ME/conversations?view=msnp24Equivalent&pageSize=&startTime=\|syncState=&targetType=&filterThreadType=` | Conversation list delta | code |
| GET | `{cs}/v1/threads/{threadId}`, `{cs}/v1/users/ME/conversations/{id}/rcmetadata`, `.../consumptionhorizons` | Thread properties, reply-chain metadata, read markers | code |

Message shape (client cache, `samples/teams-idb-replychain.json`) **[observed]**: per reply chain
`{conversationId, replyChainId, latestDeliveryTime, messageMap{id → message}}`; message fields
`id, parentMessageId (== id for the root post), version, messageType (RichText/Html | Text |
RichText/Media_Card | Event/Call | ThreadActivity/*), imDisplayName, creator (8:orgid:<guid> | 28:<botAppId>),
originalArrivalTime, content (HTML), properties{subject, importance, mentions[{itemid, mri, mentionType,
displayName}], files (JSON string: fileName, fileType, objectUrl, fileInfo{fileUrl, siteUrl, shareUrl},
sharepointIds{siteId, webId, listId, listItemUniqueId}), links, cards, emotions, edittime, deletetime}`.
Mentions appear in the HTML as `<span itemtype="http://schema.skype.com/Mention" itemscope itemid="0">`
linked by `itemid` **[observed]**. `mentionType` values seen: `person`, `channel`; `team`/`tag`
(@team, @tag) exist in the product but were not in the cache **[inferred]**. `importance` was always
empty in the cache; "important/urgent" posts were not present. Inline images are AMS objects
`https://jp-prod.asyncgw.teams.microsoft.com/v1/objects/{id}/views/imgo` **[observed]**, which the
browser loads with a cookie set by the main thread's call to `.../v1/skypetokenauth` **[observed call,
mechanism inferred]**.

Paging and increments: the cache held at most **20 reply chains per channel** and only for **15 of 50
channels** **[observed]** → first page ≈ 20 chains, fetched when a channel is opened; older posts load
on scroll (`x-ms-continuation`) **[code/inferred]**. Per-conversation sync state lives in
`syncstate-manager` with fields `syncToken, continuationToken, chatServiceStartOfSyncWindow,
chatServiceEndOfSyncWindow, _csaStartOfSyncWindow, _csaEndOfSyncWindow, latestSequenceId,
_isSyncedToStartOfTime, isGapDetected, staleReason, ...` **[observed keys]**. Live updates arrive by
push (Trouter) **[inferred]**; the team list uses `x-ms-synctoken` deltas **[code]**.

### 3.3 Files (channel "共有済み" tab)

| Method | Path pattern | Purpose | Response | Status |
|---|---|---|---|---|
| GET (iframe) | `https://<tenant>.sharepoint.com/sites/<site>/_layouts/15/filebrowser.aspx?...&teamId&channelId...` | Teams' Files UI = SharePoint page | HTML | observed |
| GET | `/sites/<site>/_api/v2.0/drive/root:/<channelFolder>:/children` | Folder listing (OneDrive-style API on SharePoint) | `{value:[{id, name, size, webUrl, eTag, cTag, createdBy{user{email,id,displayName}}, lastModifiedBy, createdDateTime, lastModifiedDateTime, parentReference{driveId, id, name, path, siteId, driveType}, file{mimeType, fileExtension, hashes{quickXorHash}}, folder{childCount}, shared{scope, effectiveRoles}, @content.downloadUrl}]}` | **observed, 200 with cookies only** |
| GET | `/sites/<site>/_api/v2.0/drive/root/delta` then `@odata.deltaLink` | Whole library + incremental changes | `{value[], @odata.deltaLink (…/view.delta?token=), @delta.hasMoreData, @delta.syncStatus: "FullData", @delta.token}` | **observed, 200** (40 items in one page) |
| GET | `/sites/<site>/_api/web/GetFolderByServerRelativePath(decodedurl='<folder>')?$expand=Folders,Files` | Classic REST listing | `{Files[{Name, Length, ServerRelativeUrl, TimeLastModified, UniqueId, ETag, LinkingUrl, ...}], Folders[], ItemCount, ...}` | observed, 200 |
| GET | `/sites/<site>/_api/web/lists/GetByTitle('ドキュメント')?$select=CurrentChangeToken,...` | Change token for `GetChanges` | `{CurrentChangeToken, Id, ItemCount, LastItemModifiedDate, Title}` | observed, 200 |

Where the folder is: team `sharepointSiteUrl` + channel `channelDocsFolderRelativeUrl`
(`/sites/<site>/Shared Documents/<channel name>`; General → `.../General`) **[observed]**. Class teams
also have `クラスの資料` (Class Materials) in the same library **[observed in the SharePoint UI]**.
Files attached to posts point into the same library (`properties.files[].fileInfo.fileUrl`,
`sharepointIds.listItemUniqueId`) **[observed]**, so posts and the folder can be joined.
`@content.downloadUrl` carries a `tempauth` token **[observed]** and must never be stored.
SharePoint REST and the v2.0 drive API are documented Microsoft APIs **[inferred: public docs]**.
Response headers seen: `sprequestguid`, `splogid`, `ms-cv`, `x-sp-serverstate`, `spclientservicerequestduration`.
The site is reached by SSO without any prompt **[observed]**.

### 3.4 Assignments (課題), Classwork (授業)

All paths relative to the Assignments service, called from the cross-origin iframe **[code]**:

| Method | Path pattern | Purpose |
|---|---|---|
| GET | `/api/v1.0/edu/me/work?$filter=…&$expand=submissions($expand=outcomes),categories,submissionAggregates`, header `Prefer: AssignmentStatusV2`, `X-MS-IsWeekView`; paging via `@odata.nextLink` (`apiName: get-all-up-assignments`) | All my assignments across classes (the left-rail 課題 app) |
| GET | `/api/v1.0/edu/me/classes`, `/api/v1.0/edu/me/classes/{classId}`, `/api/v1.0/edu/me/joinedTeams` | My classes |
| GET | `/api/v1.0/edu/classes/{classId}/assignments[?$filter&$expand]`, `.../assignments/{id}` (`get-assignment`, `Prefer: AssignmentStatusV2`) | Per class / one assignment |
| GET | `.../assignments/{id}/resources`, `.../assignments/{id}/submissions[/{subId}]?$expand=`, `.../submissions/{subId}/outcomes`, `.../submissions/{subId}/resources` | Instructions' attachments, my submission, feedback/grade |
| GET | `/api/v1.0/edu/classes/{classId}/assignmentCategories` | Tags |
| GET | `classwork/v1.0/edu/classes/{classId}/modules?$expand=resources`, `.../modules/{moduleId}?$expand=resources` | 授業 (Classwork) modules and their resources |

`$filter` building blocks seen: `id eq '…'`, `classworkModuleId eq/ne null`,
`categories/any(c: c/id eq '…')`, `status eq microsoft.education.assignments.api.educationAssignmentStatus'assigned'|…`
**[code]**. The shapes follow Graph's documented `educationAssignment` / `educationSubmission`
(displayName, instructions{content, contentType}, dueDateTime, assignedDateTime, closeDateTime,
status, webUrl, submissions[{status, submittedDateTime, outcomes}]) **[inferred]**. The host is not
in the code as a literal (relative URLs; `wus2.assignments.edu.svc.cloud.microsoft` appears as one
regional host) **[code]**; the production host for this tenant was not determined. The class id equals
the team's `groupId` (34/34 bot cards) **[observed]**.

Without the iframe: Assignments posts an adaptive card per assignment into the team
(`samples/teams-assignments-card.json`) **[observed]**: title, a display-only due date (`期限 5月9日`,
no year/time), and a deep link `https://teams.microsoft.com/l/entity/66aeee93-507d-479a-a3ef-8f494af43945/classroom?context=`
whose `subEntityId` JSON holds `config.classes[{id: <groupId>, assignmentIds:[<guid>]}]`.

### 3.5 Chats (high level)

CSA `teams/users/me` (chats[]), `teams/users/me/chats/{id}`, `chats/{id}/messages?messagePageSize`
(+`x-ms-messageToken`), chatsvc `v1/users/ME/conversations/{19:…@thread.v2 | 19:…@unq.gbl.spaces}/messages`
**[code]**. Activity feed: `activity-manager/feed-items` rows `{activityId, activityType,
activitySubtype, sourceThreadId, sourceMessageId, sourceReplyChainId, timestamp, isRead}` (1 row:
`teamMembershipChange/addedToTeam`) **[observed]**; its server source is the `48:notifications`
stream on chatsvc **[inferred]**.

## 4. Auth, in-page calls, headers, throttling (Q6)

| Service | Cookie-only same-origin fetch | Needs client tokens | Header names (no values recorded) |
|---|---|---|---|
| CSA (`/api/csa/...`) | **401** [observed] | yes | `Authorization` (Bearer, CSA resource), `x-ms-synctoken`, `x-ms-continuation`, `x-ms-client-version` [inferred], `x-skypetoken` (some APIs) [code] |
| chatsvc (`/api/chatsvc/jp/...`) | **401** [observed] | yes | `Authentication` / `x-skypetoken` (skype token) [code/inferred], `x-csendpoint`, `x-ms-continuation` |
| middle tier (`/api/mt/apac/beta/...`) | **401** + `www-authenticate` [observed] | yes (images excepted) | `Authorization` |
| AMS images, profile pictures | 200 as `<img>` [observed] | cookie set by the client | — |
| SharePoint REST / v2.0 drive | **200** [observed] | no (SharePoint session cookies) | none needed; `Accept: application/json;odata=nometadata` |
| Assignments API | not testable (fetch from its origin failed: `TypeError: Failed to fetch`) | yes, Bearer for resource `8f348934-64be-4bb2-bc16-c54c96789f43` obtained through the Teams host [code] | `Authorization`, `MS-Int-AppID`, `x-aui-version`, `x-correlationid`, `x-usersessionid`, `x-teams-ring`, `x-rh`, `x-deeplink-referer`, `Prefer`, `X-MS-IsWeekView`, `x-lms-id` [code] |

Conclusion: CSA, chatsvc, middle tier and Assignments can only be **observed** (capture the responses
the client receives). Re-issuing them ourselves would mean lifting the client's in-memory/MSAL tokens,
which we do not do. SharePoint is the exception: in a page on the team's SharePoint origin, plain
same-origin `fetch` with the browser's own session works and uses documented APIs.

Throttling: no 429/503 seen. The worker honours `retry-after` (17 references; one retry helper caps the
wait at 300 000 ms) **[code]**; the Assignments client keeps a per-`apiName` throttle-until map and
refuses calls until it expires **[code]**. SharePoint returns 429/503 with `Retry-After` when throttled
**[inferred: public docs]**. Telemetry POSTs to `browser.events.data.microsoft.com` returned 503
(irrelevant; telemetry).

## 5. Stability (Q7)

| Surface | Status | Drift risk |
|---|---|---|
| CSA `api/v1-3/...`, chatsvc `v1/users/ME/...`, middle tier `beta/...` | internal, undocumented; versions chosen per call; worker bundles change with every build (`buildVersion` in the worker URL hash) | high |
| IndexedDB stores | internal; DB versions `conversation-manager` v3, `replychain-manager` v2, `syncstate-manager` v3; the cache rewrites fields (`from: "worker/…"`) | high |
| Assignments `/api/v1.0/edu/...` | internal service, but mirrors Graph's documented education resources | medium |
| Adaptive card from the Assignments bot | content layout, Japanese display text | medium (good as a trigger, not as data) |
| SharePoint REST `_api/web`, `_api/v2.0/drive` (delta) | documented | low |
| Teams deep links `/l/channel/...`, `/l/entity/...` | documented format | low |

Breakage detection: (1) zod schemas per raw type with `detectSchemaDrift` (required: team `id`,
`displayName`, `teamSiteInformation.groupId`; post `id`, `content`, `imdisplayname|creator`,
`composetime|originalarrivaltime`); (2) record the worker build (`buildVersion` from the worker URL)
as `productVersion` and alert when it changes and drift appears in the same run; (3) "expected
traffic" checks: opening a channel must yield ≥1 posts response within N s, otherwise
`degraded`; (4) counts sanity (teams list suddenly 0 → `degraded`, not deletions); (5) SharePoint
delta returning `resyncRequired` (410) → full resync.

## 6. Recommended connector design

Name: `connectors/teams-web` on `@unicontext/adapter-browser`; metadata `apiStability: 'unofficial'`,
`risk: 'unsupported'`, `adapter: 'browser'`, `defaultAuthority: 'collaboration'` (teacher posts →
`instructor-announcement`, Assignments → its own authority).

1. **Session**: Playwright persistent context in the UniContext browser profile (`BrowserSession`);
   the human signs in once (password + MFA) in a headed window; later runs are headless. Detect
   `login.microsoftonline.com` interstitials → `AuthRequiredError`. Never export Teams tokens; only
   the existing cookie export (SharePoint origin) is needed.
2. **Two lanes**:
   - **Lane A, Teams client capture (posts, team list, assignments)**: open `https://teams.cloud.microsoft/`,
     subscribe to `context.on('response')` and keep JSON bodies whose URL matches
     `/api/csa/`, `/api/chatsvc/`, `chatsvcagg`, `/api/mt/`, and the Assignments `/api/v1.0/edu/` and
     `classwork/v1.0/edu/` paths. Store them unmodified as raw items (`teamsweb.csaStartup`,
     `teamsweb.posts`, `teamsweb.replies`, `teamsweb.eduWork`, `teamsweb.classworkModules`). Drop
     request headers entirely; strip `@content.downloadUrl`/`tempauth`/`token=` values before storing.
     Launch with `serviceWorkers: 'block'` so the worker's fetches are real network requests
     (the client works without its SW, observed); verify in the spike that Playwright reports
     dedicated-worker traffic (§8).
   - **Lane B, SharePoint REST (files)**: for each team, `page.goto(sharepointSiteUrl)` then
     in-page `fetch('/sites/<site>/_api/v2.0/drive/root/delta')`, follow `@odata.nextLink` and keep
     `@odata.deltaLink` as the cursor. Alternative without a page: Node HTTP with the exported
     SharePoint cookies (as LCU does with `JSESSIONID`). Download file content only on demand.
3. **Driving the client** (read-only navigation only): deep link each channel
   `https://teams.cloud.microsoft/l/channel/<channelId>/<name>?groupId=<groupId>&tenantId=<tenantId>`;
   wait for a posts response; scroll the post list up until the oldest captured post is older than
   the last cursor or a page limit is hit. Open the left-rail 課題 app once per run (lane A captures
   `me/work`); for classes, open the team's 課題 / 授業 tabs. Never click compose, reply, react, join,
   "turn in", or anything in Settings. One page, serial, jittered waits (a few seconds per channel),
   at most every 30-60 min; stop on any `retry-after`.
4. **Incremental strategy**: team list each run (cheap). Channels: visit only those whose
   `lastMessageTimeUtc` (from the team list / Space rows) is newer than our stored cursor, plus a slow
   round-robin for edits/deletions. Cursor per channel = max `version` seen. Files: SharePoint delta
   link per drive. Assignments: `me/work` each run (small), keyed by assignment id and
   `lastModifiedDateTime`.
5. **Fallback** if response capture proves unreliable: read the client's IndexedDB stores
   (`conversation-manager`, `replychain-manager`) from the page after the client has synced. Same
   data, but the shapes are the client's internal ones (higher drift).

## 7. Mapping into the canonical model

| Teams thing | Canonical | Key / notes |
|---|---|---|
| Class team (`spaceType: class` / CSA `teamType: Class`) | `courseOffering` via `IdentityResolver` | External id = `groupId`. Match by normalized name: NFKC, strip a 4-digit year (start or end, with/without `-`), strip `(科学科)`-style class suffixes into a "section" hint; compare to LCU `getClassSubjectList` titles of the same academic year (year from the name, else `createdat`). Emit `suggested` links unless exact; old-year teams map to past offerings or stay unlinked. Keep `description`, `sharepointSiteUrl`, `notebookId` in `extra`. |
| Non-class team (`edu`) | `thread` container / no course | e.g. lab or group teams. |
| Channel | `thread` (`platform: 'teams'`, `title` = channel name, `url` = channel deep link) | One per channel. |
| Root post by an owner/teacher, or any post with `subject`, `importance: high|urgent`, or a `team`/`channel` mention | `announcement` (`title` = subject or first line, `body` = HTML→text, `importance`, `scope: course`, `authorName`) and authority `instructor-announcement` when the author is a team owner | Owner role comes from team membership roles (not observed yet; the cache only has `rosterSummary.roleCounts`). Until that is captured, do not label an author as teacher. |
| Other posts and all replies | `message` (`threadId`, `authorName`, `sentAt` = `originalarrivaltime`, `body`, `url` = message deep link, `isQuestion` heuristic) | `ref.location.messageId` = post id; reply chain id = root id. |
| `properties.files[]` / SharePoint drive items | `document` (`title`, `mimeType`, `sizeBytes`, `path`, `url` = `webUrl`, `modifiedAt`, `contentHash` = `quickXorHash`) + `material` (`materialKind` from extension, `courseOfferingId` from the team) | Join post attachments to drive items by `listItemUniqueId` / URL. |
| Assignment (`me/work`) | `assignment` (`title` = displayName, `description` = instructions, `dueAt` = dueDateTime, `availableFrom` = assignedDateTime, `url` = webUrl or the classroom deep link) + `submission` (`status`, `submittedAt`) → task engine | Class id = team `groupId` → offering. |
| Assignments bot card | `assignment` stub (title + deep link + `assignmentIds`) and a `fact` `assignment_due` with `origin: 'extracted'` from `期限 M月D日` | Superseded by `me/work` data when available. |
| Classwork module resources | `material` | |
| Chats | `message` without course (low priority, opt-in) | |

## 8. Spike to run before implementation (not done here)

1. Playwright 1.63 persistent Chrome, `serviceWorkers: 'block'`: does `context.on('response')` (or
   `page.on('response')`) deliver the dedicated worker's CSA/chatsvc responses with bodies? Also try
   with the SW allowed.
2. Record real response bodies for `teams/users/me`, `containers/{id}/posts`, `.../replies`, and
   `me/work`; replace the [code]/[inferred] shapes above; note `x-ms-continuation` placement.
3. Confirm deep-link navigation to a channel and to the 課題 app in headless mode, and how long the
   headless session survives before Entra asks for MFA again.
4. Assignments production host and whether `me/work` covers past (overdue/completed) items.

## 9. Samples

| File | Content |
|---|---|
| `samples/teams-idb-conversations.json` | Team (Space) and channel (Topic) rows from the client cache |
| `samples/teams-idb-replychain.json` | One post + reply with mention, file attachment, observed enums |
| `samples/teams-assignments-card.json` | Assignments bot card, decoded Swift payload and deep-link context |
| `samples/teams-sharepoint-drive.json` | SharePoint v2.0 children/delta, classic folder REST keys, change-token call |

Sanitizing: people → 教員 花子 / 学生 太郎, emails → `example.ac.jp`, SharePoint host → `example.sharepoint.com`,
ids randomized consistently (the team `groupId` and thread ids match across files), message text
synthetic, tokens/sync tokens/download URLs removed. Microsoft's global Assignments app/bot ids are kept.

## 10. Spike results (2026-10-02, Playwright 1.63, installed Chrome, headless)

Run against the real tenant in the UniContext browser profile (the LiveCampusU profile, whose SSO
had already signed the student in to Microsoft; no password or MFA prompt appeared, headless). All
requests that are not reads were aborted by a context route from the first navigation on. Only
counts and shapes were recorded; fixtures are synthetic
(`connectors/teams-web/test/fixtures/*.json`).

1. **Worker traffic is visible.** With `serviceWorkers: 'block'`, `context.on('response')` delivered
   the data worker's CSA/chatsvc/middle-tier responses with bodies (e.g. `GET
   /api/csa/apac/api/v3/teams/users/me`, `GET /api/csa/apac/api/v1/containers/{channelId}/posts`;
   posts body keys `posts, hasMoreForward, hasMoreBackward, hasMore,
   lastModifiedTimeOfLastReturnedReplyChain, rcMetadataStatusCode`; no paging header in the
   response, the client sends `x-ms-*` headers only). `context.route` also sees and can abort the
   worker's requests.
2. **But the client does not refetch what it has cached.** The full team list
   (`teams/users/me`) came only on the profile's first boot; later boots asked
   `teams/users/me/updates` (delta). Opening a channel the client already cached produced no posts
   request at all. So the connector reads teams/channels and posts from the client's own IndexedDB
   cache (read-only transactions) after the client booted / opened the channel; response capture is
   used for Assignments. (Fallback of §6.5, with the reason above.)
3. **Navigation.** `page.goto('/l/channel/…')` lands on the desktop-app launcher
   (`/dl/launcher/launcher.html`). `https://teams.cloud.microsoft/_#/l/channel/…` opens the web app
   directly, and once it runs, setting `location.hash = '#/l/channel/…'` switches channels in-app in
   ~0.5 s; a never-opened channel then triggers its posts request and ~20 reply chains are cached,
   two scroll-ups load ~20 more each. `history.pushState` alone did not route. The `/l/app/<id>`
   deep link shows the store dialog (and triggers `POST …/sharetoteams/installApp`, blocked); the
   app-bar button `button[data-tid="66aeee93-507d-479a-a3ef-8f494af43945"]` opens 課題 without it.
4. **Mark-read is a client write.** Viewing a channel makes the client send `PUT
   /api/chatsvc/jp/v1/users/ME/conversations/{id}/properties?name=consumptionhorizon`; the route
   aborted it every time and the client kept working. Other non-read calls blocked without visible
   effect: `registrar/prod/V2/registrations` (push), `mcps/initArtifactFolder`,
   `users/{id}/cookiev2`, `tps/…/metadata/pushupdates`, telemetry. Read POSTs that must pass:
   `authsvc/v1.0/authz`, `skypetokenauth`, `aadtokenauth`, `beta/users/fetch*`, `effectivePolicies`,
   `useraggregatesettings`, `groupsSettings`, `apps/aggregatedEntitlements|eligibilities|batchedDefinitions`,
   `presence/getpresence`.
5. **Assignments.** Production host `https://assignments.edu.cloud.microsoft`. Each tab issues its
   own `GET /api/v1.0/edu/me/work?$filter&$top&$orderby&$expand=submissions($expand=outcomes),categories,submissionAggregates`
   (今後の予定: assigned/not completed with `dueDateTime ge` today, 期限を経過: `dueDateTime le` now,
   完了: completed or inactive), paging via `@odata.nextLink` (`$skiptoken`) when the list is
   scrolled. Past (overdue, completed) items are included: 88 for this student across 2024–2026.
   `instructions` is `null` in list responses; `createdBy.user.id` is the teacher's object id;
   submission `status` values seen: `working`, `submitted`, `returned`. 20 assignment cards in
   channels pointed at assignments the service did not list (old classes): the service is taken as
   authoritative.
6. **Cache shapes (real).** `originalArrivalTime` is an epoch-ms **number** in `replychain-manager`
   (the research sample showed a string); `properties.files` is a JSON string; `properties.mentions`
   an array or a JSON string; announcement-style posts carry `properties.title`/`subject`;
   deleted posts keep `properties.deletetime`. The DB name
   `Teams:conversation-manager:react-web-client:<userId>:<tenantId>:<locale>` gives the student's
   own MRI (for `mentionsMe`).
7. **SharePoint.** `GET {site}/_api/web` answered 403 before the site was opened; loading the site
   page completes the SSO (a form POST to `/_forms/default.aspx`, which the route allows) and after
   that same-origin `fetch` of `/_api/v2.0/drive/root/delta` works for every site on the host
   (255 items in 2 pages for one class team; 1 190 files across the 9 teams). Delta items carried no
   `@content.downloadUrl` here; the connector strips it anyway.
8. **Session lifetime.** Not measured beyond this day; headless boots kept working across ~15
   launches. When Entra asks again, the run ends with `auth_required` (no window opens).

First real sync (in-process, daemon stopped): 9 teams (7 class), 49 channels, 46 read in the first
full pass, 524 cached messages → 134 announcements + 299 messages, 1 190 files, 88 assignments with
88 submission states; 2 of 7 class teams linked automatically to the academic system / syllabus
(the 5 others are 2024–2025 teams with no offering of that year in UniContext).
