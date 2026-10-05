import { describe, expect, it } from 'vitest';
import { routeDecision, buildListUrl, buildDownloadUrl } from '../src/index.js';
import { DEPLOYMENT } from './helpers.js';

const O = 'https://vpn.inf.shizuoka.ac.jp';

describe('read-only route policy', () => {
  it('allows GET/HEAD/OPTIONS on the portal', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS'])
      expect(routeDecision(m, `${O}/api/v1/fb/list?dir=class`, O)).toBe('continue');
  });

  it('allows the Ivanti sign-in POST so the human can log in', () => {
    expect(routeDecision('POST', `${O}/dana-na/auth/url_3/login.cgi`, O)).toBe('continue');
  });

  it('blocks every write to the file browser (upload, new folder, delete)', () => {
    expect(routeDecision('POST', `${O}/dana/fb/smb/wu.cgi`, O)).toBe('abort');
    expect(routeDecision('POST', `${O}/dana/fb/smb/wnf.cgi`, O)).toBe('abort');
    expect(routeDecision('POST', `${O}/dana/fb/smb/wfd.cgi?delete=1`, O)).toBe('abort');
    expect(routeDecision('DELETE', `${O}/api/v1/fb/item`, O)).toBe('abort');
    expect(routeDecision('PUT', `${O}/api/v1/fb/item`, O)).toBe('abort');
  });

  it('leaves non-portal hosts (an IdP sign-in form) alone', () => {
    expect(routeDecision('POST', 'https://idp.shizuoka.ac.jp/idp/profile/SAML2/POST/SSO', O)).toBe(
      'continue',
    );
  });
});

describe('url builders (GET only)', () => {
  const root = DEPLOYMENT.roots[0]!;
  it('builds a list URL with the resource id, bookmark and dir', () => {
    const url = buildListUrl(DEPLOYMENT, { resourceId: root.resourceId, bookmark: root.bookmark, bmtype: root.bmtype, dir: 'class' });
    expect(url).toContain(DEPLOYMENT.listPath);
    expect(url).toContain(`v=${root.resourceId}`);
    expect(url).toContain('dir=class');
    expect(url).toContain('bmname=FS+share');
  });

  it('builds a download URL for wfd.cgi', () => {
    const url = buildDownloadUrl(DEPLOYMENT, {
      resourceId: root.resourceId,
      bookmark: root.bookmark,
      bmtype: root.bmtype,
      dir: 'class/2026',
      name: 'a.pdf',
      maxBytes: 100,
    });
    expect(url).toContain(DEPLOYMENT.downloadPath);
    expect(url).toContain('file=a.pdf');
  });
});
