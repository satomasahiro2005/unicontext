/** Minimal server-rendered pages of the remote authorization flow (no scripts, no external assets). */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#f6f6f4;--card:#fff;--muted:#6b6b6b;--accent:#1f5fbf;--warn:#b3261e}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--card:#222;--muted:#a0a0a0;--accent:#7aa7ff;--warn:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Yu Gothic UI",sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}
.warn{color:var(--warn)}dl{margin:12px 0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}dt{color:var(--muted)}dd{margin:0;word-break:break-all}
label{display:block;margin:16px 0 4px}input[type=password]{width:100%;padding:10px;font-size:1rem;border:1px solid var(--muted);border-radius:8px;background:transparent;color:var(--fg)}
.row{display:flex;gap:12px;margin-top:16px}button{flex:1;padding:10px;font-size:1rem;border-radius:8px;border:1px solid var(--accent);cursor:pointer}
button.primary{background:var(--accent);color:#fff}button.secondary{background:transparent;color:var(--accent)}
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><div class="card">${body}</div></main></body></html>`;
}

export interface ConsentPageInput {
  clientName: string | undefined;
  clientId: string;
  redirectHost: string;
  scope: string;
  sealed: string;
  message?: string | undefined;
  canUnlock: boolean;
}

export function consentPage(input: ConsentPageInput): string {
  const who = input.clientName ?? input.redirectHost;
  const message = input.message ? `<p class="warn">${escapeHtml(input.message)}</p>` : '';
  const form = input.canUnlock
    ? `<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="request" value="${escapeHtml(input.sealed)}">
<label for="passphrase">UniContextのパスフレーズ</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="current-password" autofocus>
<div class="row" style="flex-direction:row-reverse"><button class="primary" type="submit" name="action" value="approve">許可</button>
<button class="secondary" type="submit" name="action" value="deny">拒否</button></div></form>`
    : `<p class="warn">パスフレーズが設定されていません。このパソコンで<code>unicontext remote set-passphrase</code>を実行してから、もう一度やり直してください。</p>`;
  return page(
    'UniContextへの接続',
    `<h1>UniContextへの接続を許可しますか</h1>
<p><strong>${escapeHtml(who)}</strong>が、あなたのUniContextの内容を<strong>読み取り専用</strong>で使えるようになります。何かを変更・送信することはできません。</p>
<dl><dt>接続元</dt><dd>${escapeHtml(input.redirectHost)}</dd><dt>クライアント</dt><dd>${escapeHtml(input.clientId)}</dd><dt>範囲</dt><dd>${escapeHtml(input.scope)}</dd></dl>
${message}${form}
<p class="muted">許可は<code>unicontext remote revoke</code>でいつでも取り消せます。</p>`,
  );
}

export function messagePage(title: string, text: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);
}
