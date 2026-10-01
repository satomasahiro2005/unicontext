/* global process, setTimeout */
// Fake "edstem"-style CLI used by the adapter-cli tests. Prints JSON depending on argv[2].
const [cmd, ...rest] = process.argv.slice(2);

const courses = [{ id: 55, code: 'CS101', name: 'Intro to CS', year: '2026', session: 'Fall' }];
const threads = [
  {
    id: 1,
    course_id: 55,
    title: 'Midterm room',
    document: 'The midterm will be in Room 11.',
    type: 'announcement',
    category: 'Announcements',
    pinned: true,
    created_at: '2026-10-01T09:00:00+09:00',
    comment_count: 0,
    answer_count: 0,
    user: { name: 'Prof Smith', role: 'admin' },
  },
  {
    id: 2,
    course_id: 55,
    title: 'How do I submit lab 1?',
    document: 'Where do I submit lab 1?',
    type: 'question',
    category: 'Labs',
    created_at: '2026-10-02T10:00:00+09:00',
    comment_count: 1,
    answer_count: 1,
    user: { name: 'Student A', role: 'student' },
  },
];
const detail = {
  id: 2,
  course_id: 55,
  title: 'How do I submit lab 1?',
  created_at: '2026-10-02T10:00:00+09:00',
  answers: [
    {
      id: 21,
      document: 'Upload it on Canvas before Friday.',
      created_at: '2026-10-02T11:00:00+09:00',
      user: { name: 'TA Jones', role: 'staff' },
    },
  ],
  comments: [
    {
      id: 22,
      document: 'Thanks!',
      created_at: '2026-10-02T12:00:00+09:00',
      user: { name: 'Student A', role: 'student' },
    },
  ],
};

const out = (v) => process.stdout.write(JSON.stringify(v));

switch (cmd) {
  case 'courses':
    out(courses);
    break;
  case 'threads':
    out(rest[0] === '55' ? threads : []);
    break;
  case 'thread':
    out(rest[0] === '2' ? detail : { id: Number(rest[0]), course_id: 55 });
    break;
  case 'dashy':
    out([{ id: 1, name: '--delete-everything' }]);
    break;
  case 'jsonl':
    process.stdout.write(courses.map((c) => JSON.stringify(c)).join('\n') + '\n\n');
    break;
  case 'badjsonl':
    process.stdout.write('{"id":1}\nnot json\n');
    break;
  case 'paged': {
    const i = rest.indexOf('--cursor');
    const cursor = i >= 0 ? rest[i + 1] : undefined;
    out(
      cursor === 'p3'
        ? { items: [{ id: 3 }] }
        : cursor === 'p2'
          ? { items: [{ id: 2 }], next: 'p3' }
          : { items: [{ id: 1 }], next: 'p2' },
    );
    break;
  }
  case 'fail':
    process.stderr.write('boom: request failed with token=abc123 and more text\n');
    process.exit(3);
    break;
  case 'login':
    process.stderr.write('Error: not logged in. Run `edstem login`.\n');
    process.exit(1);
    break;
  case 'badjson':
    process.stdout.write('this is definitely not json');
    break;
  case 'empty':
    break;
  case 'slow':
    setTimeout(() => out([]), 15000);
    break;
  case 'big': {
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 64; i++) process.stdout.write(chunk);
    break;
  }
  case 'env':
    out([
      {
        id: 'env',
        injected: process.env.UC_TEST_SECRET ?? null,
        literal: process.env.UC_TEST_LITERAL ?? null,
        hostOnly: process.env.UC_HOST_ONLY ?? null,
      },
    ]);
    break;
  case 'stdin': {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (text += d));
    process.stdin.on('end', () => out([{ id: 'stdin', received: text }]));
    break;
  }
  case 'argv':
    out([{ id: 'argv', argv: rest }]);
    break;
  case '--version':
    process.stdout.write('fake-cli 1.2.3\n');
    break;
  case 'badversion':
    process.stderr.write('nope\n');
    process.exit(2);
    break;
  default:
    process.stderr.write(`unknown command ${cmd}\n`);
    process.exit(64);
}
