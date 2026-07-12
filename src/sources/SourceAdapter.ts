import type { SourceFrame, SourceInput } from '../core/types';

const imageCache = new Map<string, Promise<HTMLImageElement>>();
const MAX_CACHED_IMAGES = 64;

function cacheImage(url: string, promise: Promise<HTMLImageElement>): void {
  imageCache.set(url, promise);
  while (imageCache.size > MAX_CACHED_IMAGES) {
    const oldest = imageCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    imageCache.delete(oldest);
  }
}

function loadImage(url: string, cache = true): Promise<HTMLImageElement> {
  if (!cache) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        image.onload = null;
        image.onerror = null;
        resolve(image);
      };
      image.onerror = () => {
        image.onload = null;
        image.onerror = null;
        reject(new Error('AgencyDitherFX could not decode image data.'));
      };
      image.src = url;
    });
  }
  const cached = imageCache.get(url);
  if (cached) {
    imageCache.delete(url);
    imageCache.set(url, cached);
    return cached;
  }
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      resolve(image);
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      reject(new Error(`AgencyDitherFX could not load image: ${url}`));
    };
    image.src = url;
  });
  cacheImage(url, promise);
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
    video.onloadeddata = () => {
      video.onloadeddata = null;
      video.onerror = null;
      resolve(video);
    };
    video.onerror = () => {
      video.onloadeddata = null;
      video.onerror = null;
      reject(new Error(`AgencyDitherFX could not load video: ${url}`));
    };
    video.src = url;
    video.load();
  });
}

function isVideoUrl(value: string): boolean {
  return /\.(mp4|webm|ogv|mov)(?:$|[?#])/i.test(value);
}

function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
    return Promise.resolve();
  }
  return image.decode();
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = (): void => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        cleanup();
        resolve();
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('AgencyDitherFX could not load video metadata.'));
    };
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('error', onError);
    if (!video.srcObject) video.load();
  });
}

export class SourceAdapter {
  private ownedVideo: HTMLVideoElement | null = null;
  private streamVideo: HTMLVideoElement | null = null;
  private objectUrl = '';
  private frame: SourceFrame | null = null;
  private generation = 0;

  async set(input: SourceInput, kind?: 'image' | 'video'): Promise<SourceFrame | null> {
    this.release();
    const generation = this.generation;
    let drawable: CanvasImageSource;
    let width = 0;
    let height = 0;
    let dynamic = false;
    let ownedVideo: HTMLVideoElement | null = null;
    let streamVideo: HTMLVideoElement | null = null;
    let objectUrl = '';

    const cleanupPending = (): void => {
      if (ownedVideo) {
        ownedVideo.pause();
        ownedVideo.removeAttribute('src');
        ownedVideo.load();
      }
      if (streamVideo) {
        streamVideo.pause();
        streamVideo.srcObject = null;
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };

    try {
      if (input instanceof Blob) {
        objectUrl = URL.createObjectURL(input);
        const video = kind === 'video' || input.type.startsWith('video/');
        const source = video ? await loadVideo(objectUrl) : await loadImage(objectUrl, false);
        drawable = source;
        if (source instanceof HTMLVideoElement) ownedVideo = source;
      } else if (typeof input === 'string') {
        const source = kind === 'video' || isVideoUrl(input)
          ? await loadVideo(input)
          : await loadImage(input);
        drawable = source;
        if (source instanceof HTMLVideoElement) ownedVideo = source;
      } else if (input instanceof MediaStream) {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = input;
        await video.play();
        streamVideo = video;
        drawable = video;
      } else if (input instanceof SVGElement) {
        const markup = new XMLSerializer().serializeToString(input);
        drawable = await loadImage(
          `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
          false
        );
      } else {
        drawable = input;
      }

      if (drawable instanceof HTMLVideoElement) {
        await waitForVideoMetadata(drawable);
        width = drawable.videoWidth;
        height = drawable.videoHeight;
        dynamic = true;
      } else if (drawable instanceof HTMLImageElement) {
        await waitForImage(drawable);
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

      if (generation !== this.generation) {
        cleanupPending();
        return null;
      }

      this.ownedVideo = ownedVideo;
      this.streamVideo = streamVideo;
      this.objectUrl = objectUrl;
      this.frame = { drawable, width, height, dynamic, ready: width > 0 && height > 0 };
      return this.frame;
    } catch (error) {
      cleanupPending();
      if (generation !== this.generation) return null;
      throw error;
    }
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
    this.generation += 1;
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
