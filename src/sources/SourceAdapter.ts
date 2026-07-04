import type { SourceFrame, SourceInput } from '../core/types';

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string, cache = true): Promise<HTMLImageElement> {
  if (!cache) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('AgencyDitherFX could not decode image data.'));
      image.src = url;
    });
  }
  const cached = imageCache.get(url);
  if (cached) return cached;
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`AgencyDitherFX could not load image: ${url}`));
    image.src = url;
  });
  imageCache.set(url, promise);
  promise.catch(() => imageCache.delete(url));
  return promise;
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.onloadeddata = () => resolve(video);
    video.onerror = () => reject(new Error(`AgencyDitherFX could not load video: ${url}`));
    video.src = url;
    video.load();
  });
}

function isVideoUrl(value: string): boolean {
  return /\.(mp4|webm|ogv|mov)(?:$|[?#])/i.test(value);
}

export class SourceAdapter {
  private ownedVideo: HTMLVideoElement | null = null;
  private streamVideo: HTMLVideoElement | null = null;
  private objectUrl = '';
  private frame: SourceFrame | null = null;

  async set(input: SourceInput, kind?: 'image' | 'video'): Promise<SourceFrame> {
    this.release();
    let drawable: CanvasImageSource;
    let width = 0;
    let height = 0;
    let dynamic = false;

    if (input instanceof Blob) {
      this.objectUrl = URL.createObjectURL(input);
      const video = kind === 'video' || input.type.startsWith('video/');
      const source = video ? await loadVideo(this.objectUrl) : await loadImage(this.objectUrl, false);
      drawable = source;
      if (source instanceof HTMLVideoElement) this.ownedVideo = source;
    } else if (typeof input === 'string') {
      const source = kind === 'video' || isVideoUrl(input)
        ? await loadVideo(input)
        : await loadImage(input);
      drawable = source;
      if (source instanceof HTMLVideoElement) this.ownedVideo = source;
    } else if (input instanceof MediaStream) {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = input;
      await video.play();
      this.streamVideo = video;
      drawable = video;
    } else if (input instanceof SVGElement) {
      const markup = new XMLSerializer().serializeToString(input);
      drawable = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
    } else {
      drawable = input;
    }

    if (drawable instanceof HTMLVideoElement) {
      width = drawable.videoWidth;
      height = drawable.videoHeight;
      dynamic = true;
    } else if (drawable instanceof HTMLImageElement) {
      width = drawable.naturalWidth;
      height = drawable.naturalHeight;
    } else if (drawable instanceof HTMLCanvasElement) {
      width = drawable.width;
      height = drawable.height;
      dynamic = true;
    } else {
      const bitmap = drawable as ImageBitmap;
      width = bitmap.width;
      height = bitmap.height;
    }

    this.frame = { drawable, width, height, dynamic, ready: width > 0 && height > 0 };
    return this.frame;
  }

  get current(): SourceFrame | null {
    return this.frame;
  }

  async play(): Promise<void> {
    const drawable = this.frame?.drawable;
    if (drawable instanceof HTMLVideoElement && drawable.paused) {
      await drawable.play().catch(() => undefined);
    }
  }

  pause(): void {
    const drawable = this.frame?.drawable;
    if (drawable instanceof HTMLVideoElement) drawable.pause();
  }

  release(): void {
    this.pause();
    if (this.ownedVideo) {
      this.ownedVideo.removeAttribute('src');
      this.ownedVideo.load();
    }
    if (this.streamVideo) this.streamVideo.srcObject = null;
    this.ownedVideo = null;
    this.streamVideo = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.frame = null;
  }
}
