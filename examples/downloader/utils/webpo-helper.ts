import { BG, type BgConfig, buildURL, GOOG_API_KEY, USER_AGENT, type WebPoSignalOutput } from 'bgutils-js';
import { JSDOM } from 'jsdom';
import { Innertube } from 'youtubei.js';
// import { configureProxy } from './proxy-helper.js';

// let innertubePromise: Promise<Innertube> | undefined;

// async function getInnertube() {
//   configureProxy();

//   innertubePromise ??= Innertube.create({
//     user_agent: USER_AGENT,
//     enable_session_cache: false,
//   });

//   return await innertubePromise;
// }


export async function generateWebPoToken(innertube: Innertube, contentBinding: string) {
  // const innertube = await getInnertube();
  const requestKey = 'O43z0dpjhgX20SCx4KAo';

  if (!contentBinding)
    throw new Error('Could not get visitor data');

  // #region BotGuard Initialization
  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
    {
      url: 'https://www.youtube.com/',
      referrer: 'https://www.youtube.com/',
      userAgent: USER_AGENT,
    }
  )

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  })

  if (!Reflect.has(globalThis, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
    })
  }

  const challengeResponse = await innertube.getAttestationChallenge(
    'ENGAGEMENT_TYPE_UNBOUND'
  )

  if (!challengeResponse.bg_challenge) throw new Error('Could not get challenge')

  const interpreterUrl =
    challengeResponse.bg_challenge.interpreter_url
      .private_do_not_access_or_else_trusted_resource_url_wrapped_value


  const bgScriptResponse = await fetch(`https:${interpreterUrl}`)
  const interpreterJavascript = await bgScriptResponse.text()

  if (interpreterJavascript) {
    new Function(interpreterJavascript)()
  } else throw new Error('Could not load VM')

  const botguard = await BG.BotGuardClient.create({
    program: challengeResponse.bg_challenge.program,
    globalName: challengeResponse.bg_challenge.global_name,
    globalObj: globalThis,
  })
  // #endregion

  // #region WebPO Token Generation
  const webPoSignalOutput: WebPoSignalOutput = []
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput })

  const integrityTokenResponse = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: {
      'content-type': 'application/json+protobuf',
      'x-goog-api-key': GOOG_API_KEY,
      'x-user-agent': 'grpc-web-javascript/0.1',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
    },
    body: JSON.stringify([requestKey, botguardResponse]),
  })

  const response = (await integrityTokenResponse.json()) as unknown[]


  if (typeof response[0] !== 'string')
    throw new Error('Could not get integrity token')

  const integrityTokenBasedMinter = await BG.WebPoMinter.create(
    { integrityToken: response[0] },
    webPoSignalOutput
  )
  // #endregion


  const poToken = await integrityTokenBasedMinter.mintAsWebsafeString(contentBinding)

  return {
    poToken
  }

  // const bgConfig: BgConfig = {
  //   fetch: (input: string | URL | globalThis.Request, init?: RequestInit) => fetch(input, init),
  //   globalObj: globalThis,
  //   identifier: contentBinding,
  //   requestKey
  // };

  // const bgChallenge = await BG.Challenge.create(bgConfig);

  // if (!bgChallenge)
  //   throw new Error('Could not get challenge');

  // const interpreterJavascript = bgChallenge.interpreterJavascript.privateDoNotAccessOrElseSafeScriptWrappedValue;

  // if (interpreterJavascript) {
  //   new Function(interpreterJavascript)();
  // } else throw new Error('Could not load VM');

  // const poTokenResult = await BG.PoToken.generate({
  //   program: bgChallenge.program,
  //   globalName: bgChallenge.globalName,
  //   bgConfig
  // });

  // const placeholderPoToken = BG.PoToken.generatePlaceholder(contentBinding);

  // return {
  //   visitorData: contentBinding,
  //   placeholderPoToken,
  //   poToken: poTokenResult.poToken,
  // };
}
