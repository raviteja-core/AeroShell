import { session, shell, WebContents } from 'electron';
import { APP_SCHEME, ASSET_SCHEME } from './protocol-handler';

const TRUSTED_HTTPS = ['autodesk.com'];
const hostOk = (h: string): boolean => TRUSTED_HTTPS.some((d) => h === d || h.endsWith('.' + d));

function parseUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function isAppUrl(u: URL): boolean {
  return u.protocol === `${APP_SCHEME}:` && u.host === 'app';
}

export function installSessionPolicy(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);

  // Deny-by-default network policy: only allowlisted schemes
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = parseUrl(details.url);
    const ok =
      !!u &&
      (u.protocol === `${ASSET_SCHEME}:` ||
        isAppUrl(u) ||
        u.protocol === 'devtools:' ||
        u.protocol === 'data:' ||
        u.protocol === 'blob:');
    cb({ cancel: !ok });
  });
}

export function hardenWebContents(wc: WebContents): void {
  const checkNavigation = (e: Electron.Event, targetUrl: string) => {
    const u = parseUrl(targetUrl);
    if (!u || !isAppUrl(u)) {
      e.preventDefault();
      console.warn('[security] blocked navigation to:', targetUrl);
    }
  };

  wc.on('will-navigate', (event, url) => {
    // Explicitly check event.url from Electron's navigation event object
    const targetUrl = (event as unknown as { url?: string }).url || url;
    checkNavigation(event, targetUrl);
  });

  wc.on('will-redirect', (event, url) => {
    const targetUrl = (event as unknown as { url?: string }).url || url;
    checkNavigation(event, targetUrl);
  });

  wc.on('will-frame-navigate', (event: unknown) => {
    const eventObj = event as { url?: string; isMainFrame?: boolean; preventDefault: () => void };
    const targetUrl = eventObj.url || '';
    checkNavigation(eventObj as unknown as Electron.Event, targetUrl);
  });


  wc.on('will-attach-webview', (e) => {
    e.preventDefault();
    console.warn('[security] blocked webview attachment');
  });

  wc.setWindowOpenHandler(({ url }) => {
    const u = parseUrl(url);
    if (u && u.protocol === 'https:' && hostOk(u.hostname)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}
