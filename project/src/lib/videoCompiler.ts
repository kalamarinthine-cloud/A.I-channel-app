import { supabase } from '@/lib/supabase';
import { pruneBucket } from '@/lib/storage';
import type { BrollAsset } from '@/lib/supabase';

export interface CompileProgress {
  phase: 'preparing' | 'compiling' | 'uploading' | 'done' | 'error';
  message: string;
  percent: number;
}

export interface CompileResult {
  url: string;
  duration: number;
}

/**
 * Compiles voiceover audio + B-roll visual assets into a single video using
 * Canvas + MediaRecorder. The voiceover drives the total duration; visual assets
 * are shown in sequence, each getting an equal slice of the timeline. The final
 * WebM blob is uploaded to Supabase Storage and the public URL is returned.
 */
export async function compileVideo(
  voiceoverUrl: string,
  assets: BrollAsset[],
  videoId: string,
  projectId: string,
  onProgress: (p: CompileProgress) => void,
): Promise<{ result?: CompileResult; error?: string }> {
  try {
    onProgress({ phase: 'preparing', message: 'Loading voiceover audio…', percent: 5 });

    // 1. Load voiceover audio and measure duration
    const audioResp = await fetch(voiceoverUrl);
    if (!audioResp.ok) throw new Error('Failed to fetch voiceover audio');
    const audioBlob = await audioResp.blob();
    const audioBuffer = await audioBlob.arrayBuffer();
    const audioCtx = new AudioContext();
    const decoded = await audioCtx.decodeAudioData(audioBuffer);
    const totalDuration = decoded.duration;

    if (totalDuration < 0.5) throw new Error('Voiceover is too short to compile a video');

    // 2. Filter to visual asset types only (footage, image, screen_recording)
    const visualAssets = assets.filter(
      (a) => a.type === 'footage' || a.type === 'image' || a.type === 'screen_recording',
    );

    if (visualAssets.length === 0) throw new Error('No visual B-roll assets available. Add footage, images, or screen recordings and mark them as ready.');

    // 3. Set up canvas (1920x1080)
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');
    const drawCtx = ctx;

    // 4. Pre-load all visual assets (videos + images)
    onProgress({ phase: 'preparing', message: `Loading ${visualAssets.length} visual assets…`, percent: 15 });

    interface LoadedAsset {
      asset: BrollAsset;
      type: 'video' | 'image';
      element: HTMLVideoElement | HTMLImageElement;
    }

    const loadedAssets: LoadedAsset[] = [];

    for (const asset of visualAssets) {
      if (!asset.source_url) continue;
      try {
        if (asset.type === 'image') {
          const img = await loadImage(asset.source_url);
          loadedAssets.push({ asset, type: 'image', element: img });
        } else {
          const vid = await loadVideo(asset.source_url);
          loadedAssets.push({ asset, type: 'video', element: vid });
        }
      } catch {
        // Skip assets that fail to load
      }
    }

    if (loadedAssets.length === 0) throw new Error('No visual assets could be loaded. Check that asset URLs are valid.');

    // 5. Decide how many segments to cut. A short voiceover with a lot of clips would
    // otherwise give each one a fraction of a second, which reads as a strobe rather
    // than as B-roll, so drop the extras instead.
    const MIN_SEGMENT_SECONDS = 2;
    const maxSegments = Math.max(1, Math.floor(totalDuration / MIN_SEGMENT_SECONDS));
    const segments = loadedAssets.slice(0, Math.min(loadedAssets.length, maxSegments));

    // 6. Set up MediaRecorder with canvas stream + audio
    onProgress({ phase: 'preparing', message: 'Setting up recorder…', percent: 25 });

    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Your browser does not support video recording. Try Chrome, Edge, or Firefox.');
    }

    const canvasStream = canvas.captureStream(30);

    // Create a MediaStreamAudioSourceNode from the decoded audio and route to a stream
    // Some browsers start the AudioContext in "suspended" state until a user gesture
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    const dest = audioCtx.createMediaStreamDestination();
    const source = audioCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(dest);

    // Combine canvas video track + audio track
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const mimeType = pickMimeType();
    if (!mimeType) {
      throw new Error('No supported video recording format found in your browser.');
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 4_000_000,
      });
    } catch {
      throw new Error('Failed to start video recorder. Your browser may not support WebM recording.');
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    let recorderError: string | null = null;
    recorder.onerror = (e) => {
      recorderError = (e as unknown as { error?: Error }).error?.message || 'Recording error';
    };

    const recordingDone = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    // Holds the last frame we drew successfully. If a decoder momentarily has nothing
    // ready, repeating the previous frame is far less jarring than flashing to black.
    const lastFrame = document.createElement('canvas');
    lastFrame.width = canvas.width;
    lastFrame.height = canvas.height;
    const lastFrameCtx = lastFrame.getContext('2d');
    let hasLastFrame = false;

    let activeSegIdx = -1;

    // 7. Get the first clip actually producing frames *before* the recorder rolls.
    // Starting them at the same moment records the decoder's spin-up as black.
    onProgress({ phase: 'preparing', message: 'Cueing the first clip…', percent: 28 });

    const firstSegment = segments[0];
    if (firstSegment.type === 'video') {
      const vid = firstSegment.element as HTMLVideoElement;
      try { vid.currentTime = 0; } catch { /* ignore */ }
      await vid.play().catch(() => { /* keep going even if playback is refused */ });
      await waitForFrame(vid);
    }

    drawCtx.fillStyle = '#0a0a0a';
    drawCtx.fillRect(0, 0, canvas.width, canvas.height);
    drawImageCover(drawCtx, firstSegment.element, canvas.width, canvas.height);
    if (lastFrameCtx) {
      lastFrameCtx.drawImage(canvas, 0, 0);
      hasLastFrame = true;
    }
    activeSegIdx = 0;

    // 8. Start recording and render frames
    onProgress({ phase: 'compiling', message: 'Compiling video…', percent: 30 });
    recorder.start(100);

    source.start(0);
    const startTime = performance.now();

    await new Promise<void>((resolve) => {
      function renderFrame() {
        const elapsed = (performance.now() - startTime) / 1000;
        const progress = Math.min(elapsed / totalDuration, 1);

        // Determine which asset segment we're in
        const segIdx = Math.min(Math.floor(progress * segments.length), segments.length - 1);
        const loaded = segments[segIdx];

        // Exactly one clip plays at a time: start the incoming one, stop the outgoing
        // one. This is also the only place we seek — seeking every frame (which is what
        // this used to do) fights playback and stalls the decoder outright.
        if (segIdx !== activeSegIdx) {
          const previous = segments[activeSegIdx];
          if (previous && previous.type === 'video') {
            (previous.element as HTMLVideoElement).pause();
          }
          if (loaded.type === 'video') {
            const vid = loaded.element as HTMLVideoElement;
            try { vid.currentTime = 0; } catch { /* ignore */ }
            vid.play().catch(() => { /* keep rendering even if playback is refused */ });
          }
          activeSegIdx = segIdx;
        }

        // Draw background
        drawCtx.fillStyle = '#0a0a0a';
        drawCtx.fillRect(0, 0, canvas.width, canvas.height);

        // The element loops on its own, so a clip shorter than its segment just repeats.
        const element = loaded.element;
        const ready = loaded.type === 'image' || (element as HTMLVideoElement).readyState >= 2;

        if (ready) {
          drawImageCover(drawCtx, element, canvas.width, canvas.height);
          if (lastFrameCtx) {
            lastFrameCtx.drawImage(canvas, 0, 0);
            hasLastFrame = true;
          }
        } else if (hasLastFrame) {
          drawCtx.drawImage(lastFrame, 0, 0);
        }

        // Update progress
        const pct = 30 + Math.round(progress * 50);
        onProgress({ phase: 'compiling', message: `Compiling video… ${Math.round(progress * 100)}%`, percent: pct });

        if (progress >= 1) {
          resolve();
        } else {
          requestAnimationFrame(renderFrame);
        }
      }
      requestAnimationFrame(renderFrame);
    });

    // 8. Stop recording and release the decoders
    recorder.stop();
    await recordingDone;

    for (const loaded of loadedAssets) {
      if (loaded.type === 'video') {
        const vid = loaded.element as HTMLVideoElement;
        vid.pause();
        vid.removeAttribute('src');
        vid.load();
      }
    }

    if (recorderError) {
      throw new Error(`Recording failed: ${recorderError}`);
    }

    // Close audio context
    audioCtx.close();

    onProgress({ phase: 'uploading', message: 'Uploading compiled video…', percent: 85 });

    // 9. Assemble blob and upload to Supabase Storage
    const blob = new Blob(chunks, { type: mimeType });
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const filePath = `${videoId}/${projectId}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('compiled_videos')
      .upload(filePath, blob, { contentType: mimeType, upsert: false });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    // A project only ever has one current cut, so drop the earlier ones. Without this,
    // every re-compile leaves its predecessor in the bucket forever.
    await pruneBucket('compiled_videos', `${videoId}/${projectId}`, filePath);

    const { data: publicUrlData } = supabase.storage
      .from('compiled_videos')
      .getPublicUrl(filePath);

    onProgress({ phase: 'done', message: 'Video compiled successfully!', percent: 100 });

    return { result: { url: publicUrlData.publicUrl, duration: totalDuration } };
  } catch (err) {
    onProgress({ phase: 'error', message: err instanceof Error ? err.message : 'Unknown error', percent: 0 });
    return { error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return 'video/webm';
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/**
 * Resolves once the element has actually presented a frame, rather than merely
 * having data buffered. Falls back to a timeout on browsers without
 * requestVideoFrameCallback (Firefox), so a stalled clip can't hang the render.
 */
function waitForFrame(vid: HTMLVideoElement, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);

    const withCallback = vid as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };

    if (typeof withCallback.requestVideoFrameCallback === 'function') {
      withCallback.requestVideoFrameCallback(finish);
    } else if (vid.readyState >= 2) {
      finish();
    }
  });
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const vid = document.createElement('video');
    vid.crossOrigin = 'anonymous';
    vid.muted = true;
    vid.playsInline = true;
    vid.loop = true;
    vid.preload = 'auto';
    // Deliberately not started here. Playing every clip from load time exhausts the
    // browser's pool of video decoders, and each element past the first few then has
    // no frame to hand the canvas. Playback starts when a clip's segment begins.
    vid.onloadeddata = () => resolve(vid);
    vid.onerror = () => reject(new Error(`Failed to load video: ${url}`));
    vid.src = url;
  });
}

/**
 * Draws an image/video element to fill the canvas, cropping with "cover" behavior.
 */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  el: HTMLImageElement | HTMLVideoElement,
  cw: number,
  ch: number,
) {
  const isVideo = el instanceof HTMLVideoElement;
  const ew = isVideo ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth;
  const eh = isVideo ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight;
  if (!ew || !eh) return;

  const scale = Math.max(cw / ew, ch / eh);
  const dw = ew * scale;
  const dh = eh * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  ctx.drawImage(el, dx, dy, dw, dh);
}
