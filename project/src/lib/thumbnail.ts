import { supabase } from '@/lib/supabase';
import { pruneBucket } from '@/lib/storage';

const WIDTH = 1280;
const HEIGHT = 720;

/**
 * Builds a YouTube thumbnail from a B-roll still plus the video title, and uploads
 * it to Supabase Storage. Everything happens on a canvas in the browser — no image
 * generation API needed, which keeps the pipeline to the two keys the app already has.
 */
export async function generateThumbnail(
  backgroundUrl: string,
  title: string,
  videoId: string,
  projectId: string,
): Promise<{ url?: string; error?: string }> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');

    // Background: the B-roll still, cropped to cover, or a brand gradient if it won't load.
    let drewBackground = false;
    if (backgroundUrl) {
      try {
        const img = await loadImage(backgroundUrl);
        drawCover(ctx, img, WIDTH, HEIGHT);
        drewBackground = true;
      } catch {
        // fall through to the gradient
      }
    }

    if (!drewBackground) {
      const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
      gradient.addColorStop(0, '#0891b2');
      gradient.addColorStop(1, '#0a0a0f');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }

    // Darken the lower half so the title stays readable over busy footage.
    const scrim = ctx.createLinearGradient(0, HEIGHT * 0.25, 0, HEIGHT);
    scrim.addColorStop(0, 'rgba(0,0,0,0)');
    scrim.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Accent bar — gives the thumbnail a consistent channel identity.
    ctx.fillStyle = '#2dd4ff';
    ctx.fillRect(0, HEIGHT - 12, WIDTH, 12);

    drawTitle(ctx, title.toUpperCase());

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Failed to encode the thumbnail image');

    const filePath = `${videoId}/${projectId}/${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from('thumbnails')
      .upload(filePath, blob, { contentType: 'image/png', upsert: false });

    if (uploadError) throw new Error(`Thumbnail upload failed: ${uploadError.message}`);

    await pruneBucket('thumbnails', `${videoId}/${projectId}`, filePath);

    const { data } = supabase.storage.from('thumbnails').getPublicUrl(filePath);
    return { url: data.publicUrl };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/**
 * Fits the title into at most three lines, shrinking the font until it fits rather
 * than truncating — a cut-off thumbnail title reads as broken.
 */
function drawTitle(ctx: CanvasRenderingContext2D, title: string) {
  const maxWidth = WIDTH - 120;
  const maxLines = 3;

  let fontSize = 96;
  let lines: string[] = [];

  while (fontSize >= 44) {
    ctx.font = `900 ${fontSize}px Inter, system-ui, sans-serif`;
    lines = wrapText(ctx, title, maxWidth);
    if (lines.length <= maxLines) break;
    fontSize -= 6;
  }

  if (lines.length > maxLines) lines = lines.slice(0, maxLines);

  const lineHeight = fontSize * 1.12;
  const blockHeight = lines.length * lineHeight;
  let y = HEIGHT - 70 - blockHeight + lineHeight * 0.8;

  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.lineWidth = fontSize * 0.16;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.fillStyle = '#ffffff';

  for (const line of lines) {
    ctx.strokeText(line, 60, y);
    ctx.fillText(line, 60, y);
    y += lineHeight;
  }
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
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

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, cw: number, ch: number) {
  const scale = Math.max(cw / img.naturalWidth, ch / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}
