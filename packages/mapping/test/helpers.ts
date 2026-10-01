import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SecretStore } from '@unicontext/core';
import type { ResourceCaller, ResourceRequest, ResourceResponse } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export const CANVAS_YAML_PATH = join(here, 'fixtures', 'canvas.yaml');
export const canvasYaml = (): string => readFileSync(CANVAS_YAML_PATH, 'utf8');

/** Synthetic Canvas-like data. */
export const COURSES = [
  {
    id: 101,
    name: 'データベースシステム論',
    course_code: 'DB-101',
    term: { name: '2026年度 前期' },
    html_url: 'https://canvas.example/courses/101',
    updated_at: '2026-09-30T10:00:00Z',
    access_token: 'SHOULD-BE-STRIPPED',
  },
  {
    id: 102,
    name: 'Algorithms',
    course_code: 'CS-210',
    term: { name: '2026 Fall' },
    html_url: 'https://canvas.example/courses/102',
    updated_at: '2026-09-29T10:00:00Z',
  },
];

export const ASSIGNMENTS: Record<number, unknown[]> = {
  101: [
    {
      id: 5001,
      name: '課題1: ER図',
      description: 'ER図を作成せよ',
      due_at: '2026-10-08T14:59:00Z',
      html_url: 'https://canvas.example/courses/101/assignments/5001',
      updated_at: '2026-09-30T11:00:00Z',
    },
  ],
  102: [
    {
      id: 5002,
      name: 'Problem set 1',
      due_at: '2026-10-09T23:59:00',
      html_url: 'https://canvas.example/courses/102/assignments/5002',
      updated_at: '2026-09-30T12:00:00Z',
    },
    {
      id: 5003,
      name: 'Problem set 2',
      due_at: null,
      html_url: 'https://canvas.example/courses/102/assignments/5003',
    },
  ],
};

export const ANNOUNCEMENTS = {
  items: [
    {
      id: 9001,
      course_id: 101,
      title: '教室変更のお知らせ',
      message: '来週から11教室で行います',
      posted_at: '2026-10-01T09:00:00+09:00',
      author: { display_name: '山田先生' },
      html_url: 'https://canvas.example/courses/101/discussion_topics/9001',
    },
  ],
};

export interface RecordingCaller extends ResourceCaller {
  requests: ResourceRequest[];
}

/** Fake MCP-like caller: dispatches on `call.tool`. `overrides` replace a tool's behaviour. */
export function canvasCaller(
  overrides: Record<
    string,
    (req: ResourceRequest) => ResourceResponse | Promise<ResourceResponse>
  > = {},
): RecordingCaller {
  const requests: ResourceRequest[] = [];
  return {
    requests,
    call(req: ResourceRequest): Promise<ResourceResponse> {
      requests.push(req);
      const tool = String(req.call.tool);
      const override = overrides[tool];
      if (override) return Promise.resolve(override(req));
      const args = (req.call.args ?? {}) as Record<string, unknown>;
      switch (tool) {
        case 'list_courses':
          return Promise.resolve({ data: COURSES });
        case 'list_assignments':
          return Promise.resolve({ data: ASSIGNMENTS[Number(args.course_id)] ?? [] });
        case 'list_announcements':
          return Promise.resolve({ data: ANNOUNCEMENTS });
        default:
          return Promise.reject(new Error(`unknown tool ${tool}`));
      }
    },
  };
}

/** Minimal in-memory SecretStore for tests. */
export class MemorySecrets implements SecretStore {
  readonly backend = 'memory';
  private readonly map = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
}
