import { createWriteStream, type WriteStream } from 'node:fs';
import cliProgress from 'cli-progress';
import { ClientType, Constants, Innertube, type IPlayerResponse, Platform, UniversalCache, YTNodes } from 'youtubei.js';
import type { Types } from 'youtubei.js';

import { configureProxy } from './proxy-helper.js';
import { generateWebPoToken } from './webpo-helper.js';
import type { SabrFormat } from 'googlevideo/shared-types';
import type { ReloadPlaybackContext } from 'googlevideo/protos';
import { SabrStream, type SabrPlaybackOptions } from 'googlevideo/sabr-stream';
import { buildSabrFormat } from 'googlevideo/utils';

export interface DownloadOutput {
  stream: WriteStream;
  filePath: string;
}

export interface StreamResults {
  videoStream: ReadableStream;
  audioStream: ReadableStream;
  selectedFormats: {
    videoFormat: SabrFormat;
    audioFormat: SabrFormat;
  };
  videoTitle: string;
}

Platform.shim.eval = async (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
  const properties = [];

  if (env.n) {
    properties.push(`n: exportedVars.nFunction("${env.n}")`);
  }

  if (env.sig) {
    properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  }

  const code = `${data.output}\nreturn { ${properties.join(', ')} }`;

  return new Function(code)();
};

/**
 * Fetches video details and streaming information from YouTube.
 */
export async function makePlayerRequest(innertube: Innertube, videoId: string, reloadPlaybackContext?: ReloadPlaybackContext): Promise<IPlayerResponse> {
  const watchEndpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });

  const extraArgs: Record<string, any> = {
    playbackContext: {
      // adPlaybackContext: { pyv: false },
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        lactMilliseconds: '-1',
        signatureTimestamp: innertube.session.player?.signature_timestamp
      }
    },
    contentCheckOk: true,
    racyCheckOk: true
  };

  if (reloadPlaybackContext) {
    extraArgs.playbackContext.reloadPlaybackContext = reloadPlaybackContext;
  }

  return await watchEndpoint.call<IPlayerResponse>(innertube.actions, { ...extraArgs, parse: true });
}

export function determineFileExtension(mimeType: string): string {
  if (mimeType.includes('video')) {
    return mimeType.includes('webm') ? 'webm' : 'mp4';
  } else if (mimeType.includes('audio')) {
    return mimeType.includes('webm') ? 'webm' : 'm4a';
  }
  return 'bin';
}

export function createOutputStream(title: string, mimeType: string): DownloadOutput {
  const type = mimeType.includes('video') ? 'video' : 'audio';
  const sanitizedTitle = title?.replace(/[^a-z0-9]/gi, '_') || 'unknown';
  const extension = determineFileExtension(mimeType);
  const fileName = `${sanitizedTitle}.${type}.${extension}`;

  return {
    stream: createWriteStream(fileName, { flags: 'w', encoding: 'binary' }),
    filePath: fileName
  };
}

export function bytesToMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export function createMultiProgressBar(): cliProgress.MultiBar {
  return new cliProgress.MultiBar({
    stopOnComplete: true,
    hideCursor: true
  }, cliProgress.Presets.rect);
}

/**
 * Creates and configures a progress bar.
 */
export function setupProgressBar(
  multiBar: cliProgress.MultiBar,
  type: 'audio' | 'video' | 'merge',
  totalSizeBytes?: number
): cliProgress.SingleBar {
  if (type === 'merge') {
    const bar = multiBar.create(100, 0, undefined, {
      format: `${type} [{bar}] {percentage}%`
    });
    bar.update(0);
    return bar;
  }

  const totalSizeMB = totalSizeBytes ? bytesToMB(totalSizeBytes) : '0.00';
  const bar = multiBar.create(100, 0, undefined, {
    format: `${type} [{bar}] {percentage}% | {currentSizeMB}/{totalSizeMB} MB`
  });

  bar.update(0, { currentSizeMB: '0.00', totalSizeMB });
  return bar;
}

/**
 * Creates a WritableStream that tracks download progress.
 */
export function createStreamSink(format: SabrFormat, outputStream: WriteStream, progressBar?: cliProgress.SingleBar) {
  let size = 0;
  const totalSize = Number(format.contentLength || 0);

  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        size += chunk.length;

        if (totalSize > 0 && progressBar) {
          const percentage = (size / totalSize) * 100;
          progressBar.update(percentage, {
            currentSizeMB: bytesToMB(size),
            totalSizeMB: bytesToMB(totalSize)
          });
        }

        outputStream.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    close() {
      outputStream.end();
    }
  });
}

/**
 * Initializes Innertube client and sets up SABR streaming for a YouTube video.
 */
export async function createSabrStream(
  videoId: string,
  options: SabrPlaybackOptions
): Promise<{
  innertube: Innertube;
  streamResults: StreamResults;
}> {
  configureProxy();
  const innertube = await Innertube.create({
    cache: undefined,//new UniversalCache(true), 
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    cookie: 'YSC=WF3cSBJCZqo; VISITOR_INFO1_LIVE=J4Cm6hPQS2I; VISITOR_PRIVACY_METADATA=CgJVUxIEGgAgOQ%3D%3D; LOGIN_INFO=AFmmF2swRQIhAIIL_2pmE2XVlZcXkgELgIlpQq7sySCtNHUOiNDbUXd4AiBA9kIwjT3_VNKwWJHR9BSYpM6IIIkzyDfPUWha038Dqg:QUQ3MjNmd0ZnMFMwMng2dnluaDVlTFRZZDV1VktYOGVEdFpuWnZJZnM0T0NLMHlsdWtXWnZQNjBZMHl3T0ZTTThOMTJhR0RIY1Q4WXpWOHlpblQ0NTU3THJNX3F3VHVnNWdDem5raVRvRzludzE4aWpBWUdBdTRpUUdvUFRjell1QmhCTU5iZmo4b1FvQVdDa3ZxeVFJN1dVNnlZNk9fTkpn; HSID=AjOF2GxFa96XIY_zr; SSID=AlimHly3qF2gVV0v9; APISID=BiTlChAbsFMYwgEA/AbmPqwOedSXFI7MOz; SAPISID=ed7HvlzOlsfoHviC/AOqrUTPMJQplO-1L9; __Secure-1PAPISID=ed7HvlzOlsfoHviC/AOqrUTPMJQplO-1L9; __Secure-3PAPISID=ed7HvlzOlsfoHviC/AOqrUTPMJQplO-1L9; SID=g.a0007whfwAT7qhrwBHZhTPSsUWmZ6EAS8kYL-levuoqkGKafKehSzFYzego-RohcWHDm9xXAyAACgYKAWwSARUSFQHGX2MiSE8YqZ5fx-JckfqgAL77hBoVAUF8yKqRMXDWOiEbUPd0egXMhwrM0076; __Secure-1PSID=g.a0007whfwAT7qhrwBHZhTPSsUWmZ6EAS8kYL-levuoqkGKafKehS-39TpwOxpPJPyVEkZVnzUAACgYKAdwSARUSFQHGX2MiipRR48dl46fa_IFHaS8kKRoVAUF8yKrab8k9jqIyOSKuMlht-p8V0076; __Secure-3PSID=g.a0007whfwAT7qhrwBHZhTPSsUWmZ6EAS8kYL-levuoqkGKafKehSIilvZYS4_xGZCiKoqrj5zgACgYKAVESARUSFQHGX2MiARLC8YPJRf8QFdaGvQWvaxoVAUF8yKqMldCAzP9XZaIyeykqS4jK0076; __Secure-BUCKET=CI0E; __Secure-ROLLOUT_TOKEN=CKzfvKay4t7E9AEQ-5zxw8GzigMYl7m0opbpkwM%3D; PREF=f4=4000000&tz=Asia.Shanghai&f5=30000&hl=zh-CN&f7=100; ST-l3hjtt=session_logininfo=AFmmF2swRQIhAIIL_2pmE2XVlZcXkgELgIlpQq7sySCtNHUOiNDbUXd4AiBA9kIwjT3_VNKwWJHR9BSYpM6IIIkzyDfPUWha038Dqg%3AQUQ3MjNmd0ZnMFMwMng2dnluaDVlTFRZZDV1VktYOGVEdFpuWnZJZnM0T0NLMHlsdWtXWnZQNjBZMHl3T0ZTTThOMTJhR0RIY1Q4WXpWOHlpblQ0NTU3THJNX3F3VHVnNWdDem5raVRvRzludzE4aWpBWUdBdTRpUUdvUFRjell1QmhCTU5iZmo4b1FvQVdDa3ZxeVFJN1dVNnlZNk9fTkpn; ST-tladcw=session_logininfo=AFmmF2swRQIhAIIL_2pmE2XVlZcXkgELgIlpQq7sySCtNHUOiNDbUXd4AiBA9kIwjT3_VNKwWJHR9BSYpM6IIIkzyDfPUWha038Dqg%3AQUQ3MjNmd0ZnMFMwMng2dnluaDVlTFRZZDV1VktYOGVEdFpuWnZJZnM0T0NLMHlsdWtXWnZQNjBZMHl3T0ZTTThOMTJhR0RIY1Q4WXpWOHlpblQ0NTU3THJNX3F3VHVnNWdDem5raVRvRzludzE4aWpBWUdBdTRpUUdvUFRjell1QmhCTU5iZmo4b1FvQVdDa3ZxeVFJN1dVNnlZNk9fTkpn; ST-3opvp5=session_logininfo=AFmmF2swRQIhAIIL_2pmE2XVlZcXkgELgIlpQq7sySCtNHUOiNDbUXd4AiBA9kIwjT3_VNKwWJHR9BSYpM6IIIkzyDfPUWha038Dqg%3AQUQ3MjNmd0ZnMFMwMng2dnluaDVlTFRZZDV1VktYOGVEdFpuWnZJZnM0T0NLMHlsdWtXWnZQNjBZMHl3T0ZTTThOMTJhR0RIY1Q4WXpWOHlpblQ0NTU3THJNX3F3VHVnNWdDem5raVRvRzludzE4aWpBWUdBdTRpUUdvUFRjell1QmhCTU5iZmo4b1FvQVdDa3ZxeVFJN1dVNnlZNk9fTkpn; ST-xuwub9=session_logininfo=AFmmF2swRQIhAIIL_2pmE2XVlZcXkgELgIlpQq7sySCtNHUOiNDbUXd4AiBA9kIwjT3_VNKwWJHR9BSYpM6IIIkzyDfPUWha038Dqg%3AQUQ3MjNmd0ZnMFMwMng2dnluaDVlTFRZZDV1VktYOGVEdFpuWnZJZnM0T0NLMHlsdWtXWnZQNjBZMHl3T0ZTTThOMTJhR0RIY1Q4WXpWOHlpblQ0NTU3THJNX3F3VHVnNWdDem5raVRvRzludzE4aWpBWUdBdTRpUUdvUFRjell1QmhCTU5iZmo4b1FvQVdDa3ZxeVFJN1dVNnlZNk9fTkpn; __Secure-1PSIDTS=sidts-CjUBWhotCRJxvmYyOm9E0jkQtnTQWPYbGUdkSmvxT0JqhyNRswJhRQ73zj6lif-qtb0m-WyP7xAA; __Secure-3PSIDTS=sidts-CjUBWhotCRJxvmYyOm9E0jkQtnTQWPYbGUdkSmvxT0JqhyNRswJhRQ73zj6lif-qtb0m-WyP7xAA; NID=530=hheJQlzuTmjuJsHf1tVJzxSS6s3FJk2pXodns0j8PLyss1Nxfs9tznPwgFUmZ25HDIKuDwyZzTwtvsKOse2aNkCGP6d78a0-bTBzApOO5gGdoXF-6lxvqtyZF-VVC20lJI52SjWyOinkhL6QHZiDr4ykrM55v_0HtHSyD80WY3Yz6SKJ5KXw53PlZ91mZRQzhXeowGEAsjIw72v-ECdPdzfmLDx8fz2a-3ZCYE6sXvP39yaTPBYq_pp-msI; SIDCC=AKEyXzVajAxHgDFhuFnxgLkkqn9ltlP1Q2h1CiRLeZKsj4GUf_1sVuKISmeVM3YTj2HA3C-Sxg; __Secure-1PSIDCC=AKEyXzXWbbK68x0Sg0WI-zWAP8VqCP01Uro9AjA6FGbBHOPJT58Nc87xz-gPuX4On1bzfMUMKA; __Secure-3PSIDCC=AKEyXzXQ38fylMIS-xyqg_WpmJhodrnmK82kXa8hSImlhZnpHmvoLxuL9NeIHCm1pHf1njnOAHA',
    visitor_data: 'CgtKNENtNmhQUVMySSjTx_LOBjIKCgJVUxIEGgAgOQ%3D%3D',
    enable_session_cache: false,
    client_type: ClientType.WEB,
    generate_session_locally: false,
    retrieve_innertube_config: true,
  });
  const webPoTokenResult = await generateWebPoToken(innertube, videoId);

  // Get video metadata.
  const playerResponse = await makePlayerRequest(innertube, videoId);
  const videoTitle = playerResponse.video_details?.title || 'Unknown Video';

  console.info(`
    Title: ${videoTitle}
    Duration: ${playerResponse.video_details?.duration}
    Views: ${playerResponse.video_details?.view_count}
    Author: ${playerResponse.video_details?.author}
    Video ID: ${playerResponse.video_details?.id}
  `);

  // Now get the streaming information.
  const serverAbrStreamingUrl = await innertube.session.player?.decipher(playerResponse.streaming_data?.server_abr_streaming_url);
  const videoPlaybackUstreamerConfig = playerResponse.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

  if (!videoPlaybackUstreamerConfig) throw new Error('ustreamerConfig not found');
  if (!serverAbrStreamingUrl) throw new Error('serverAbrStreamingUrl not found');

  const sabrFormats = playerResponse.streaming_data?.adaptive_formats.map(buildSabrFormat) || [];

  const serverAbrStream = new SabrStream({
    formats: sabrFormats,
    serverAbrStreamingUrl,
    videoPlaybackUstreamerConfig,
    poToken: webPoTokenResult.poToken,
    clientInfo: {
      clientName: parseInt(Constants.CLIENT_NAME_IDS[innertube.session.context.client.clientName as keyof typeof Constants.CLIENT_NAME_IDS]),
      clientVersion: innertube.session.context.client.clientVersion
    }
  });

  // Handle player response reload events (e.g, when IP changes, or formats expire).
  serverAbrStream.on('reloadPlayerResponse', async (reloadPlaybackContext) => {
    const playerResponse = await makePlayerRequest(innertube, videoId, reloadPlaybackContext);

    const serverAbrStreamingUrl = await innertube.session.player?.decipher(playerResponse.streaming_data?.server_abr_streaming_url);
    const videoPlaybackUstreamerConfig = playerResponse.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

    if (serverAbrStreamingUrl && videoPlaybackUstreamerConfig) {
      serverAbrStream.setStreamingURL(serverAbrStreamingUrl);
      serverAbrStream.setUstreamerConfig(videoPlaybackUstreamerConfig);
    }
  });

  const { videoStream, audioStream, selectedFormats } = await serverAbrStream.start(options);

  return {
    innertube,
    streamResults: {
      videoStream,
      audioStream,
      selectedFormats,
      videoTitle
    }
  };
}
