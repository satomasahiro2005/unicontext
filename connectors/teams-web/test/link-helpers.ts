import type { RawItem } from '@unicontext/connector-sdk';
import { type JsonGetResult, shareIdOf } from '../src/index.js';
import { CLASS_GROUP, FakeTeamsClient, fixture, SITE, TEAM_ID } from './helpers.js';

/*
 * A scripted SharePoint for open_link: `getJson` answers from `answer(url, redeem)`; every request
 * is recorded (site, url, redeem flag). The class team of the fixtures (SITE, CLASS_GROUP) has the
 * default library `b!SYNTHETIC`.
 */

export const ORIGIN = new URL(SITE).origin;
export const DRIVE = 'b!SYNTHETIC';
export const OTHER_DRIVE = 'b!DOCLIB';
export const PERSONAL = 'https://example-my.sharepoint.com/personal/teacher_example_ac_jp';

export interface JsonRequest {
  siteUrl: string;
  url: string;
  redeem: boolean;
}

export class FakeLinkClient extends FakeTeamsClient {
  requests: JsonRequest[] = [];
  answer: (url: string, redeem: boolean) => JsonGetResult = () => ({ status: 404 });

  getJson(
    siteUrl: string,
    url: string,
    options: { redeemSharingLink?: boolean } = {},
  ): Promise<JsonGetResult> {
    const redeem = options.redeemSharingLink === true;
    this.requests.push({ siteUrl, url, redeem });
    return Promise.resolve(JSON.parse(JSON.stringify(this.answer(url, redeem))) as JsonGetResult);
  }
}

/** `/_api/v2.0/shares/{id}/driveItem…` of a link. */
export const shareItemPath = (link: string) => `/_api/v2.0/shares/${shareIdOf(link)}/driveItem?`;
export const shareChildrenPath = (link: string) =>
  `/_api/v2.0/shares/${shareIdOf(link)}/driveItem/children?`;

export function driveItem(
  id: string,
  name: string,
  options: {
    driveId?: string;
    path?: string;
    siteUrl?: string;
    folder?: number;
    size?: number;
  } = {},
): Record<string, unknown> {
  const siteUrl = options.siteUrl ?? SITE;
  return {
    '@odata.context': `${siteUrl}/_api/v2.0/$metadata#items/$entity`,
    '@content.downloadUrl': `${siteUrl}/_layouts/15/download.aspx?UniqueId=x&tempauth=SECRET`,
    id,
    name,
    eTag: '"{0C44DBAF-25CB-42EE-A697-CE197B2C257F},2"',
    cTag: '"c:{0C44DBAF-25CB-42EE-A697-CE197B2C257F},2"',
    size: options.size ?? 1234,
    webUrl: `${siteUrl}/Shared%20Documents/${encodeURIComponent(name)}`,
    lastModifiedDateTime: '2026-09-30T01:00:00Z',
    createdDateTime: '2026-09-29T01:00:00Z',
    parentReference: {
      driveType: 'documentLibrary',
      driveId: options.driveId ?? DRIVE,
      id: '01PARENT',
      path: `/drives/${options.driveId ?? DRIVE}/root:${options.path ?? ''}`,
      sharepointIds: { siteUrl },
    },
    ...(options.folder !== undefined
      ? { folder: { childCount: options.folder } }
      : { file: { mimeType: 'application/pdf' } }),
  };
}

/** The class team and its synced file `01FILEWEEK1` as the engine passes them (link context). */
export function classContext(): {
  items: { sourceType: string; externalId: string; payload: unknown }[];
} {
  const conv = fixture<{ spaces: { id: string; threadProperties: Record<string, unknown> }[] }>(
    'client-conversations.json',
  );
  const space = conv.spaces.find((s) => s.id === TEAM_ID)!;
  return {
    items: [
      {
        sourceType: 'teamsweb.team',
        externalId: CLASS_GROUP,
        payload: {
          id: TEAM_ID,
          threadProperties: space.threadProperties,
          channels: [
            {
              id: TEAM_ID,
              name: '一般',
              channelDocsFolderRelativeUrl: '/sites/2026X_abc123/Shared Documents/General',
            },
            {
              id: '19:mat@thread.tacv2',
              name: '講義資料',
              channelDocsFolderRelativeUrl: '/sites/2026X_abc123/Shared Documents/00_講義資料',
            },
          ],
        },
      },
      {
        sourceType: 'teamsweb.driveItem',
        externalId: `${CLASS_GROUP}/01FILEWEEK1`,
        payload: {
          teamGroupId: CLASS_GROUP,
          teamName: 'データベース演習X',
          spaceType: 'class',
          siteUrl: SITE,
          item: {
            id: '01FILEWEEK1',
            name: 'week1.pdf',
            file: {},
            parentReference: { driveId: DRIVE, path: '/drive/root:/00_講義資料' },
          },
        },
      },
    ],
  };
}

export function payloadOf(raw: RawItem | undefined): Record<string, unknown> {
  return (raw?.payload ?? {}) as Record<string, unknown>;
}
