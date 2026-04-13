import { env } from 'node:process';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

let isProxyConfigured = false;

export function configureProxy() {
  if (isProxyConfigured) {
    return;
  }

  const proxyUrl =
    env.https_proxy ??
    env.HTTPS_PROXY ??
    env.http_proxy ??
    env.HTTP_PROXY ??
    env.all_proxy ??
    env.ALL_PROXY;

  if (!proxyUrl) {
    return;
  }

  setGlobalDispatcher(new ProxyAgent({ uri: new URL(proxyUrl).toString() }));
  isProxyConfigured = true;
}
