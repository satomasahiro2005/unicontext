/*
 * Detecting "the tenant (admin) has not allowed this app" so the connector can report
 * auth_required with an actionable message instead of a generic failure.
 */

const CONSENT_PATTERN =
  /AADSTS(?:65001|90094|90095)|consent_required|admin[_ ]approval|administrator consent|admin[_ ]consent|access_denied/i;
const GRAPH_DENIED_PATTERN =
  /Authorization_RequestDenied|insufficient privileges|AccessDenied|Authorization_IdentityNotFound/i;

export const CONSENT_MESSAGE =
  'Microsoft 365: テナント管理者の同意が必要です。大学のテナントでは、このアプリの権限に本人だけでは同意できない場合があります。管理者に承認を依頼するか、ブラウザ adapter（Outlook on the web / Teams web）で代替してください（docs/connectors/microsoft365.md）。' +
  ' / Tenant admin consent is required for the requested permissions. Ask your tenant administrator to approve the app, or fall back to the browser adapter (Outlook on the web / Teams web); see docs/connectors/microsoft365.md.';

export const MISSING_CLIENT_ID_MESSAGE =
  'Microsoft 365: clientId が未設定です。Entra ID にアプリを登録して clientId を設定してください。 / clientId is not configured; register an app in Entra ID (docs/connectors/microsoft365.md).';

/** True when an OAuth error code/description says consent or admin approval is missing. */
export function isConsentBlockedText(text: string | undefined): boolean {
  return text !== undefined && CONSENT_PATTERN.test(text);
}

/** True for a Graph error body that means the signed-in user/app lacks the permission. */
export function isGraphDeniedText(text: string | undefined): boolean {
  return text !== undefined && (GRAPH_DENIED_PATTERN.test(text) || CONSENT_PATTERN.test(text));
}

/** Concatenates message, oauth error code and the whole cause chain of an error. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 6 && current !== undefined && current !== null; i++) {
    if (current instanceof Error) {
      parts.push(current.message);
      const oauth = (current as { oauthError?: unknown }).oauthError;
      if (typeof oauth === 'string') parts.push(oauth);
      const details = (current as { details?: { error?: unknown } }).details;
      if (typeof details?.error === 'string') parts.push(details.error);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' | ');
}

export function isConsentBlockedError(error: unknown): boolean {
  return isConsentBlockedText(describeError(error));
}
