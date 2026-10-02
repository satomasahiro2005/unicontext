import type { Capability, HealthStatus } from '@unicontext/canonical-model';
import type {
  AuthResult,
  InteractiveAuthAdapter,
  InteractiveLoginOptions,
  RawDeletion,
  RawItem,
  SyncInput,
  SyncResult,
} from '@unicontext/connector-sdk';
import {
  AuthRequiredError,
  type Clock,
  ConnectorError,
  errorMessage,
  type Logger,
  RateLimitedError,
  zonedParts,
} from '@unicontext/core';
import type {
  ClientConversations,
  ConversationRow,
  ReplyChainRow,
  TeamsWebClient,
} from './client.js';
import type { TeamsWebConfig } from './config.js';
import { PRODUCT } from './metadata.js';
import {
  ASSIGNMENTS_BOT_MRI,
  decodeAssignmentCard,
  extensionOf,
  folderNameOf,
  jsonList,
  scrubSecrets,
  toIso,
  truthy,
} from './parse.js';

export const CAPABILITIES: Capability[] = [
  'courses',
  'announcements',
  'messages',
  'materials',
  'assignments',
  'submissions',
];

// ---------------------------------------------------------------------------------------------
// Sync state (persisted as cursor.extra in sync_state)

export interface TeamsWebState {
  v: 1;
  /** Per channel: the client's last-activity time when we last read it, and when that was. */
  channels: Record<string, { last: number; visitedAt: string }>;
  /** Per team (groupId): SharePoint drive delta link. */
  drives: Record<string, string>;
  filesFullAt?: string;
  /** Assignment ids the Assignments service returned (cards for them are not needed). */
  workIds: string[];
  /** Assignment cards currently stored as fallbacks. */
  cardIds: string[];
  /** classId → AAD object ids of assignment authors (instructor hint). */
  instructors: Record<string, string[]>;
  /** groupId → display name of the team creator (seen on one of their posts). */
  creatorNames: Record<string, string>;
  /** `${groupId}/${itemId}` → file version whose text was extracted. */
  extracted: Record<string, string>;
  /** Files waiting for text extraction (cap per run). */
  extractQueue: {
    groupId: string;
    itemId: string;
    siteUrl: string;
    name: string;
    version: string;
  }[];
  teamCount?: number;
  /** Teams (groupId) whose document library was listed before. */
  knownDrives?: string[];
}

export function emptyState(): TeamsWebState {
  return {
    v: 1,
    channels: {},
    drives: {},
    workIds: [],
    cardIds: [],
    instructors: {},
    creatorNames: {},
    extracted: {},
    extractQueue: [],
  };
}

export function loadState(extra: unknown): TeamsWebState {
  const s = {
    ...emptyState(),
    ...(extra && typeof extra === 'object' ? extra : {}),
  } as TeamsWebState;
  return s.v === 1 ? s : emptyState();
}

// ---------------------------------------------------------------------------------------------
// Team list from the client's cache

export interface ChannelInfo {
  id: string;
  name: string;
  isGeneral: boolean;
  createdat: string | number | null;
  folderUrl: string | null;
  folderName: string | undefined;
  /** Last activity (ms epoch) according to the client; 0 = unknown. */
  last: number;
}

export interface TeamInfo {
  id: string;
  groupId: string;
  name: string;
  spaceType: string | undefined;
  tenantId: string | undefined;
  creator: string | undefined;
  siteUrl: string | undefined;
  threadProperties: Record<string, unknown>;
  channels: ChannelInfo[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function buildTeams(conv: ClientConversations): TeamInfo[] {
  const topicRows = new Map<string, ConversationRow>(conv.topics.map((t) => [t.id, t]));
  const teams: TeamInfo[] = [];
  for (const space of conv.spaces) {
    const tp = space.threadProperties;
    const groupId = str(tp.groupId);
    if (!groupId || truthy(tp.isdeleted as string | boolean | undefined)) continue;
    const name = str(tp.spaceThreadTopic) ?? str(tp.topic) ?? '(チーム)';
    const listed = jsonList(tp.topics) as Record<string, unknown>[];
    const channels: ChannelInfo[] = [
      {
        id: space.id,
        name: 'General',
        isGeneral: true,
        createdat: (tp.createdat as string | null | undefined) ?? null,
        folderUrl: str(tp.channelDocsFolderRelativeUrl) ?? null,
        folderName: folderNameOf(str(tp.channelDocsFolderRelativeUrl)) ?? 'General',
        last: Number(space.lastMessageTimeUtc ?? 0) || 0,
      },
    ];
    for (const t of listed) {
      const id = str(t.id);
      if (!id || id === space.id || truthy(t.isdeleted as boolean | string | undefined)) continue;
      const row = topicRows.get(id);
      const folderUrl = str(row?.threadProperties.channelDocsFolderRelativeUrl) ?? null;
      const channelName = str(t.name) ?? str(row?.threadProperties.topic) ?? '(チャネル)';
      channels.push({
        id,
        name: channelName,
        isGeneral: false,
        createdat: (t.createdat as string | number | null | undefined) ?? null,
        folderUrl,
        folderName: folderNameOf(folderUrl) ?? channelName,
        last: Number(row?.lastMessageTimeUtc ?? 0) || 0,
      });
    }
    teams.push({
      id: space.id,
      groupId,
      name,
      spaceType: str(tp.spaceType),
      tenantId: str(tp.tenantid) ?? conv.tenantId,
      creator: str(tp.creator),
      siteUrl: str(tp.sharepointSiteUrl)?.replace(/\/+$/, ''),
      threadProperties: tp,
      channels,
    });
  }
  return teams;
}

/** `teamsweb.team` payload: the team's cached properties and its channel list (no volatile data). */
export function teamPayload(
  team: TeamInfo,
  creatorName: string | undefined,
): Record<string, unknown> {
  const keep = [
    'spaceThreadTopic',
    'topic',
    'spaceType',
    'description',
    'groupId',
    'tenantid',
    'creator',
    'createdat',
    'sharepointSiteUrl',
    'sharepointRootLibrary',
    'channelDocsFolderRelativeUrl',
    'isdeleted',
  ];
  const threadProperties: Record<string, unknown> = {};
  for (const k of keep)
    if (team.threadProperties[k] !== undefined) threadProperties[k] = team.threadProperties[k];
  return scrubSecrets({
    id: team.id,
    threadProperties,
    channels: team.channels.map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.isGeneral ? { isGeneral: true } : {}),
      ...(c.createdat !== null ? { createdat: c.createdat } : {}),
      ...(c.folderUrl ? { channelDocsFolderRelativeUrl: c.folderUrl } : {}),
    })),
    ...(creatorName ? { creatorName } : {}),
  });
}

// ---------------------------------------------------------------------------------------------
// Channel plan

export interface PlannedChannel {
  team: TeamInfo;
  channel: ChannelInfo;
  reason: 'new' | 'changed' | 'revisit';
}

/**
 * Changed channels first (newest activity first, never-read ones after them), capped at
 * `maxChannelsPerRun`; then a few unchanged ones, least recently read first, so edits and deletions
 * are picked up slowly. The rest wait for the next run (the state remembers what was read).
 */
export function planChannels(
  teams: TeamInfo[],
  state: TeamsWebState,
  config: Pick<TeamsWebConfig, 'maxChannelsPerRun' | 'revisitPerRun'>,
): PlannedChannel[] {
  const changed: PlannedChannel[] = [];
  const unchanged: PlannedChannel[] = [];
  for (const team of teams)
    for (const channel of team.channels) {
      const seen = state.channels[channel.id];
      if (!seen) changed.push({ team, channel, reason: 'new' });
      else if (channel.last > seen.last) changed.push({ team, channel, reason: 'changed' });
      else unchanged.push({ team, channel, reason: 'revisit' });
    }
  changed.sort(
    (a, b) =>
      b.channel.last - a.channel.last ||
      a.team.name.localeCompare(b.team.name) ||
      a.channel.name.localeCompare(b.channel.name),
  );
  unchanged.sort((a, b) =>
    (state.channels[a.channel.id]?.visitedAt ?? '').localeCompare(
      state.channels[b.channel.id]?.visitedAt ?? '',
    ),
  );
  return [
    ...changed.slice(0, config.maxChannelsPerRun),
    ...unchanged.slice(0, config.revisitPerRun),
  ];
}

// ---------------------------------------------------------------------------------------------

export type WithClient = <T>(
  fn: (client: TeamsWebClient) => Promise<T>,
) => Promise<{ result: T } | { auth: AuthResult }>;

export interface TeamsWebAdapterOptions {
  sourceId: string;
  config: TeamsWebConfig;
  clock: Clock;
  logger: Logger;
  timezone: string;
  withClient: WithClient;
  /** True when a persistent browser profile exists (someone signed in before). */
  profileExists: () => boolean;
  login?: (options?: InteractiveLoginOptions) => Promise<AuthResult>;
  logout?: () => Promise<void>;
  close?: () => Promise<void>;
  /** Text extraction (default: the local-files extractors). */
  extract?: (
    data: Uint8Array,
    ext: string,
  ) => Promise<{ text: string; pages?: { page: number; text: string }[] }>;
  random?: () => number;
}

interface RunOutput {
  items: RawItem[];
  deletions: RawDeletion[];
  warnings: string[];
  version: string;
  completeTypes: string[];
  counts: Record<string, number>;
}

/**
 * Reads the student's own Teams data through the official web client (docs/research/teams-web.md
 * §6): the client's own cache after it loaded each channel, the Assignments responses the client
 * received, and SharePoint's documented drive API from a page on the team site. Read-only.
 */
export class TeamsWebAdapter implements InteractiveAuthAdapter {
  readonly id: string;
  readonly version = '1.0.0';
  private healthState: HealthStatus;
  lastRunCounts: Record<string, number> = {};

  constructor(private readonly options: TeamsWebAdapterOptions) {
    this.id = `teams-web:${options.sourceId}`;
    this.healthState = { state: 'healthy', checkedAt: options.clock.now().toISOString() };
  }

  capabilities(): Promise<Capability[]> {
    return Promise.resolve([...CAPABILITIES]);
  }

  authenticate(): Promise<AuthResult> {
    if (this.options.profileExists())
      return Promise.resolve({ status: 'authenticated', message: 'Browser profile present' });
    return Promise.resolve({
      status: 'auth_required',
      message: `Microsoft sign-in required. Run \`unicontext login ${this.options.sourceId}\` (or sign in to LiveCampusU, whose browser profile is shared).`,
    });
  }

  login(options?: InteractiveLoginOptions): Promise<AuthResult> {
    if (!this.options.login)
      return Promise.resolve({ status: 'failed', message: 'Interactive login is not available' });
    return this.options.login(options);
  }

  async logout(): Promise<void> {
    await this.options.logout?.();
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ ...this.healthState });
  }

  async dispose(): Promise<void> {
    await this.options.close?.();
  }

  private now(): Date {
    return this.options.clock.now();
  }

  private fullListingDue(state: TeamsWebState, mode: SyncInput['mode']): boolean {
    if (mode === 'full' || mode === 'initial') return true;
    if (!state.filesFullAt) return true;
    const age = this.now().getTime() - new Date(state.filesFullAt).getTime();
    if (age > 48 * 3600_000) return true;
    const [from, to] = this.options.config.files.fullListingHours;
    const hour = zonedParts(this.now(), this.options.timezone).hour;
    return age > 20 * 3600_000 && hour >= from && hour < to;
  }

  async sync(input: SyncInput): Promise<SyncResult> {
    const state = loadState(input.cursor?.extra);
    const out = await this.options.withClient((client) => this.run(client, state, input));
    const now = this.now().toISOString();
    if ('auth' in out) {
      this.healthState = {
        state: 'auth_required',
        checkedAt: now,
        ...(out.auth.message ? { message: out.auth.message } : {}),
      };
      throw new AuthRequiredError(out.auth.message ?? 'Microsoft sign-in required');
    }
    const r = out.result;
    this.lastRunCounts = r.counts;
    this.healthState = { state: 'healthy', checkedAt: now, lastSuccessAt: now };
    return {
      items: r.items,
      ...(r.deletions.length ? { deletions: r.deletions } : {}),
      cursor: { extra: state as unknown as Record<string, unknown> },
      productVersion: { product: PRODUCT, version: r.version },
      ...(r.completeTypes.length ? { complete: { sourceTypes: r.completeTypes } } : {}),
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
    };
  }

  private async pause(ms: number): Promise<void> {
    const jitter = Math.floor(ms * 0.5 * (this.options.random ?? Math.random)());
    await this.options.clock.sleep(ms + jitter);
  }

  private async run(
    client: TeamsWebClient,
    state: TeamsWebState,
    input: SyncInput,
  ): Promise<RunOutput> {
    const cfg = this.options.config;
    const log = this.options.logger;
    const items: RawItem[] = [];
    const deletions: RawDeletion[] = [];
    const warnings: string[] = [];
    const completeTypes: string[] = [];
    const counts: Record<string, number> = {
      teams: 0,
      channels: 0,
      channelsRead: 0,
      posts: 0,
      assignments: 0,
      cards: 0,
      files: 0,
      filesDeleted: 0,
      textExtracted: 0,
    };
    const soft = (what: string, e: unknown): void => {
      if (e instanceof AuthRequiredError || e instanceof RateLimitedError) throw e;
      warnings.push(`${what}: ${errorMessage(e)}`);
      log.warn(`teams-web: ${what} failed`, { error: errorMessage(e) });
    };

    const { version } = await client.open();
    const conv = await client.conversations();
    const selfMri = conv.userId ? `8:orgid:${conv.userId}` : undefined;
    const teams = buildTeams(conv).filter(
      (t) => cfg.includeNonClassTeams || t.spaceType === 'class',
    );
    if (teams.length === 0)
      throw new ConnectorError('The Teams client listed no teams (cache not ready?)');
    counts.teams = teams.length;
    counts.channels = teams.reduce((n, t) => n + t.channels.length, 0);

    // 1. Assignments (first, so their authors are known as instructors for the posts below).
    let workComplete = false;
    if (cfg.assignments) {
      try {
        const work = await client.assignments();
        // The very first read lists every past assignment: not news.
        const firstRead = state.workIds.length === 0;
        const ids = new Set(state.workIds);
        for (const raw of work.items) {
          const a = scrubSecrets(raw);
          const id = str(a.id);
          if (!id) continue;
          ids.add(id);
          items.push({
            sourceType: 'teamsweb.assignment',
            externalId: id,
            payload: a,
            ...(firstRead ? { backfill: true } : {}),
            ...(str(a.lastModifiedDateTime)
              ? { sourceUpdatedAt: str(a.lastModifiedDateTime) }
              : {}),
          });
          const classId = str(a.classId);
          const author = str((a.createdBy as { user?: { id?: unknown } } | undefined)?.user?.id);
          if (classId && author) {
            const list = new Set(state.instructors[classId] ?? []);
            list.add(author);
            state.instructors[classId] = [...list].sort();
          }
        }
        state.workIds = [...ids].sort();
        counts.assignments = work.items.length;
        workComplete = work.complete && work.items.length > 0;
        if (workComplete) completeTypes.push('teamsweb.assignment');
      } catch (e) {
        soft('assignments', e);
      }
    }

    // 2. Channels, one at a time.
    const workIds = new Set(state.workIds);
    const cards = new Set(state.cardIds);
    for (const planned of planChannels(teams, state, cfg)) {
      const { team, channel } = planned;
      try {
        await client.openChannel(
          {
            channelId: channel.id,
            channelName: channel.name,
            groupId: team.groupId,
            tenantId: team.tenantId,
          },
          { scrollPages: cfg.scrollPages, settleMs: cfg.settleMs },
        );
        const chains = await client.replyChains(channel.id);
        // Posts of a channel read for the first time are mostly old: only the last two days are news.
        const newsSince =
          planned.reason === 'new'
            ? this.now().getTime() - 48 * 3600_000
            : Number.NEGATIVE_INFINITY;
        for (const chain of chains)
          this.emitChain(team, channel, chain, state, selfMri, items, {
            workIds,
            cards: workComplete ? undefined : cards,
            counts,
            backfill: (Number(chain.latestDeliveryTime) || 0) < newsSince,
          });
        state.channels[channel.id] = { last: channel.last, visitedAt: this.now().toISOString() };
        counts.channelsRead = (counts.channelsRead ?? 0) + 1;
      } catch (e) {
        soft(`channel ${team.name} / ${channel.name}`, e);
      }
      await this.pause(cfg.channelDelayMs);
    }
    // Cards superseded by the Assignments service are removed. When the service listed the
    // student's work completely, a card it does not list is an assignment the student no longer
    // has (deleted or not assigned to them): Teams' own state wins.
    for (const id of [...cards])
      if (workComplete || workIds.has(id)) {
        cards.delete(id);
        deletions.push({ sourceType: 'teamsweb.assignmentCard', externalId: id });
      }
    state.cardIds = [...cards].sort();

    // 3. Files (SharePoint drive delta per team).
    if (cfg.files.enabled)
      await this.syncFiles(
        client,
        teams,
        state,
        input,
        items,
        deletions,
        completeTypes,
        counts,
        soft,
      );

    // 4. Teams and channels (after the posts, which reveal the team creator's display name).
    for (const team of teams)
      items.push({
        sourceType: 'teamsweb.team',
        externalId: team.groupId,
        payload: teamPayload(team, state.creatorNames[team.groupId]),
      });
    const shrunk = state.teamCount !== undefined && teams.length < state.teamCount / 2;
    if (shrunk)
      warnings.push(`team list shrank from ${state.teamCount} to ${teams.length}; not deleting`);
    else completeTypes.push('teamsweb.team');
    state.teamCount = teams.length;

    log.info('teams-web run', counts);
    return { items, deletions, warnings, version, completeTypes, counts };
  }

  private emitChain(
    team: TeamInfo,
    channel: ChannelInfo,
    chain: ReplyChainRow,
    state: TeamsWebState,
    selfMri: string | undefined,
    items: RawItem[],
    opts: {
      workIds: Set<string>;
      /** Collect fallback cards (undefined when the Assignments service answered completely). */
      cards: Set<string> | undefined;
      counts: Record<string, number>;
      backfill: boolean;
    },
  ): void {
    const { workIds, cards, counts, backfill } = opts;
    const isClass = team.spaceType === 'class';
    const instructorMris = isClass
      ? [
          ...new Set([
            ...(team.creator ? [team.creator] : []),
            ...(state.instructors[team.groupId] ?? []).map((id) => `8:orgid:${id}`),
          ]),
        ].sort()
      : [];
    const messages = chain.messages.map((m) => scrubSecrets(m));
    for (const m of messages) {
      if (team.creator && m.creator === team.creator && typeof m.imDisplayName === 'string')
        state.creatorNames[team.groupId] = m.imDisplayName;
      if (m.creator !== ASSIGNMENTS_BOT_MRI) continue;
      const card = decodeAssignmentCard(str(m.content));
      if (!card || !cards || workIds.has(card.assignmentId)) continue;
      cards.add(card.assignmentId);
      counts.cards = (counts.cards ?? 0) + 1;
      items.push({
        sourceType: 'teamsweb.assignmentCard',
        externalId: card.assignmentId,
        payload: {
          assignmentId: card.assignmentId,
          classId: card.classId,
          title: card.title,
          ...(card.dueText ? { dueText: card.dueText } : {}),
          ...(toIso(m.originalArrivalTime as string | number | undefined)
            ? { postedAt: toIso(m.originalArrivalTime as string | number | undefined) }
            : {}),
          teamGroupId: team.groupId,
          channelId: channel.id,
          messageId: str(m.id) ?? '',
          url: card.url,
        },
        ...(backfill ? { backfill: true } : {}),
      });
    }
    counts.posts = (counts.posts ?? 0) + messages.length;
    items.push({
      sourceType: 'teamsweb.replychain',
      externalId: `${channel.id}/${chain.replyChainId}`,
      payload: {
        teamGroupId: team.groupId,
        teamId: team.id,
        teamName: team.name,
        ...(team.spaceType ? { spaceType: team.spaceType } : {}),
        ...(team.tenantId ? { tenantId: team.tenantId } : {}),
        channelId: channel.id,
        channelName: channel.name,
        instructorMris,
        ...(selfMri ? { selfMri } : {}),
        replyChainId: chain.replyChainId,
        latestDeliveryTime: chain.latestDeliveryTime,
        messages,
      },
      ...(backfill ? { backfill: true } : {}),
    });
  }

  private async syncFiles(
    client: TeamsWebClient,
    teams: TeamInfo[],
    state: TeamsWebState,
    input: SyncInput,
    items: RawItem[],
    deletions: RawDeletion[],
    completeTypes: string[],
    counts: Record<string, number>,
    soft: (what: string, e: unknown) => void,
  ): Promise<void> {
    const cfg = this.options.config.files;
    const full = this.fullListingDue(state, input.mode);
    let allListed = true;
    const seenKeys = new Set<string>();
    for (const team of teams) {
      if (!team.siteUrl) continue;
      const folders = new Map(team.channels.map((c) => [c.folderName ?? c.name, c.name]));
      // A library listed for the first time (a newly joined team) holds old files: not news.
      const firstListing = !(state.knownDrives ?? []).includes(team.groupId);
      try {
        let link = full ? undefined : state.drives[team.groupId];
        let res = await client.driveDelta(team.siteUrl, link);
        if (res.resync) {
          link = undefined;
          res = await client.driveDelta(team.siteUrl, undefined);
        }
        if (link !== undefined || res.truncated) allListed = false;
        for (const raw of res.items) {
          const item = scrubSecrets(raw);
          const id = str(item.id);
          if (!id || item.root) continue;
          const key = `${team.groupId}/${id}`;
          if (item.deleted) {
            deletions.push({ sourceType: 'teamsweb.driveItem', externalId: key });
            if (state.extracted[key]) {
              deletions.push({ sourceType: 'teamsweb.fileText', externalId: key });
              delete state.extracted[key];
            }
            counts.filesDeleted = (counts.filesDeleted ?? 0) + 1;
            continue;
          }
          if (!item.file) continue;
          seenKeys.add(key);
          const parentPath = str((item.parentReference as { path?: unknown } | undefined)?.path);
          const top = (parentPath?.split('root:')[1] ?? '').replace(/^\/+/, '').split('/')[0];
          let topDecoded = top;
          try {
            topDecoded = decodeURIComponent(top ?? '');
          } catch {
            // keep
          }
          const channelName = topDecoded ? folders.get(topDecoded) : undefined;
          items.push({
            sourceType: 'teamsweb.driveItem',
            externalId: key,
            payload: {
              teamGroupId: team.groupId,
              teamName: team.name,
              ...(team.spaceType ? { spaceType: team.spaceType } : {}),
              ...(team.tenantId ? { tenantId: team.tenantId } : {}),
              siteUrl: team.siteUrl,
              ...(channelName ? { channelName } : {}),
              item,
            },
            ...(str(item.lastModifiedDateTime)
              ? { sourceUpdatedAt: str(item.lastModifiedDateTime) }
              : {}),
            ...(firstListing ? { backfill: true } : {}),
          });
          counts.files = (counts.files ?? 0) + 1;
          const name = str(item.name) ?? '';
          const fileVersion = str(item.cTag) ?? str(item.eTag) ?? '';
          const size = typeof item.size === 'number' ? item.size : 0;
          if (
            cfg.extractText &&
            cfg.extractExtensions.includes(extensionOf(name)) &&
            size > 0 &&
            size <= cfg.maxExtractBytes &&
            state.extracted[key] !== fileVersion &&
            !state.extractQueue.some(
              (q) => `${q.groupId}/${q.itemId}` === key && q.version === fileVersion,
            )
          ) {
            state.extractQueue = state.extractQueue.filter(
              (q) => `${q.groupId}/${q.itemId}` !== key,
            );
            state.extractQueue.push({
              groupId: team.groupId,
              itemId: id,
              siteUrl: team.siteUrl,
              name,
              version: fileVersion,
            });
          }
        }
        if (res.deltaLink && !res.truncated) state.drives[team.groupId] = res.deltaLink;
        else delete state.drives[team.groupId];
        if (firstListing) state.knownDrives = [...(state.knownDrives ?? []), team.groupId].sort();
      } catch (e) {
        allListed = false;
        soft(`files of ${team.name}`, e);
      }
      await this.pause(500);
    }
    if (full && allListed) {
      completeTypes.push('teamsweb.driveItem');
      state.filesFullAt = this.now().toISOString();
      for (const key of Object.keys(state.extracted))
        if (!seenKeys.has(key)) {
          deletions.push({ sourceType: 'teamsweb.fileText', externalId: key });
          delete state.extracted[key];
        }
    }
    state.extractQueue = state.extractQueue.slice(-500);
    if (cfg.extractText) await this.extractTexts(client, state, items, counts, soft);
  }

  private async extractTexts(
    client: TeamsWebClient,
    state: TeamsWebState,
    items: RawItem[],
    counts: Record<string, number>,
    soft: (what: string, e: unknown) => void,
  ): Promise<void> {
    const cfg = this.options.config.files;
    const extract = this.options.extract ?? defaultExtract;
    const batch = state.extractQueue.slice(0, cfg.maxExtractPerRun);
    for (const job of batch) {
      const key = `${job.groupId}/${job.itemId}`;
      state.extractQueue = state.extractQueue.filter((q) => q !== job);
      try {
        const data = await client.downloadFile(job.siteUrl, job.itemId, cfg.maxExtractBytes);
        state.extracted[key] = job.version;
        if (!data) continue;
        const content = await extract(data, extensionOf(job.name));
        if (!content.text.trim()) continue;
        items.push({
          sourceType: 'teamsweb.fileText',
          externalId: key,
          payload: {
            teamGroupId: job.groupId,
            itemId: job.itemId,
            name: job.name,
            version: job.version,
            text: content.text,
            ...(content.pages?.length ? { pages: content.pages } : {}),
          },
        });
        counts.textExtracted = (counts.textExtracted ?? 0) + 1;
      } catch (e) {
        soft(`text of ${job.name}`, e);
      }
      await this.pause(1000);
    }
  }
}

async function defaultExtract(
  data: Uint8Array,
  ext: string,
): Promise<{ text: string; pages?: { page: number; text: string }[] }> {
  const { extractContent } = await import('@unicontext/local-files');
  const c = await extractContent(data, ext);
  if (c.pages?.length) return { text: c.pages.map((p) => p.text).join('\n\n'), pages: c.pages };
  if (c.slides?.length)
    return {
      text: c.slides.map((s) => [s.title, s.text, s.notes].filter(Boolean).join('\n')).join('\n\n'),
      pages: c.slides.map((s) => ({
        page: s.slide,
        text: [s.title, s.text, s.notes].filter(Boolean).join('\n'),
      })),
    };
  return { text: c.text ?? '' };
}
