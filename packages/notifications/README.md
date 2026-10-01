# @unicontext/notifications

Notification engine (SPEC §46). It turns sync-engine bus events and a deadline poll into
notifications, dedupes them, keeps a persistent log and fans them out to sinks. It makes no
network calls of its own except the optional webhook sink, and has no telemetry.

```ts
import { createUniContext } from '@unicontext/context-engine';
import { createSinksFromConfig, NotificationService } from '@unicontext/notifications';

const uc = createUniContext({ dataDir });
const sinks = await createSinksFromConfig(config.notifications, { secrets, logger });
const notifications = new NotificationService({
  uc,
  sinks,
  logFile: path.join(paths.logs, 'notifications.jsonl'),
  minPriority: config.notifications.minPriority,
  deadlineLeadTimes: config.notifications.deadlineLeadTimes,
});
notifications.start(); // subscribes to uc.bus and polls deadlines; stop() undoes both
notifications.list({ unreadOnly: true }); // newest first
notifications.markRead(id);
```

## Rules

| Kind                     | Trigger                                                                          | Priority                                                      |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `room_change`            | `change`: classSession / courseOffering `room` updated                           | critical if the class is today or tomorrow, otherwise high    |
| `class_cancelled`        | `change`: classSession `status` becomes `cancelled`                              | critical                                                      |
| `new_assignment`         | `change`: assignment created                                                     | normal                                                        |
| `deadline_changed`       | `change`: assignment `dueAt` updated                                             | high, critical if the new due date is less than 24 hours away |
| `deadline_approaching`   | poll of `context.deadline()`                                                     | normal at the 24h lead, high at 3h, critical at 1h            |
| `exam_announced`         | `change`: exam created                                                           | high                                                          |
| `important_announcement` | `change`: announcement created with importance high/critical or scope university | high, critical for critical importance                        |
| `auth_expired`           | `health` / `sync:failed` with state `auth_required`                              | high (body carries `unicontext login <sourceId>`)             |
| `sync_failure`           | `sync:failed`, `health` with state `failed`                                      | normal, high once the source is `failed`                      |
| `conflict`               | `change` of type `conflict_detected`, `conflict` event `opened`                  | high                                                          |
| `schema_drift`           | `drift`                                                                          | low                                                           |

Other change events are ignored. Class sessions that are already over are ignored. Titles and
bodies are Japanese and include `citations` (from `context.citationsFor`). Source error text is
passed through the core redactor.

`deadline_approaching` fires once per task, due date and lead-time bucket (the tightest bucket that
contains the remaining time), and not for submitted, completed or cancelled tasks. The due date is
part of the dedupe key, so a moved deadline fires again. Default leads are `24h`, `3h`, `1h`; the
check runs on `uc.clock` every 5 minutes (and once at `start()`).

## Dedupe and the log

Every notification has a `dedupeKey`. Keys are checked against the persisted log, so a restart
does not repeat anything. `auth_expired`, `sync_failure` and `conflict` may repeat: they are
suppressed for `dedupeWindowMs` (default 6 hours) and are forgotten when the source reports
`healthy`. `NotificationLog` is an append-only JSONL file (notification, read-state and key-reset
entries); it is loaded on construction, skips corrupt lines, keeps at most 1000 entries in memory,
and falls back to in-memory if no `logFile` is given. Notifications below `minPriority` are dropped
before they are logged or sent.

## Sinks

- `createConsoleSink()` writes `[重要] title — body` to stderr (stdout is reserved for MCP stdio).
- `createDesktopSink()` uses the optional `node-notifier` module and resolves to `undefined` when
  it cannot be loaded. It shows `normal` and above by default.
- `createWebhookSink({ url, secret?, minPriority? })` POSTs
  `{"event":"notification","notification":{...}}`. With a secret it adds
  `X-UniContext-Signature: sha256=<HMAC-SHA256 hex of the exact body>`. Errors never include the URL.
- `createSinksFromConfig(config.notifications, { secrets, logger })` builds the enabled sinks. The
  webhook is off by default; it is created only when enabled with a `url`, and is skipped (with a
  warning) if `secretRef` is set but the secret is missing. It returns `[]` when notifications are
  disabled.

A failing sink is logged with `logger.warn` and never stops the others.

## Tests

`npx vitest run packages/notifications` (no network, no desktop notifications). The tests import
`@unicontext/connector-sdk`, listed as a devDependency.
