declare module '@mediapipe/camera_utils' {
  export class Camera {
    constructor(video: HTMLVideoElement, options: {
      onFrame: () => Promise<void>;
      width?: number;
      height?: number;
    });
    start(): Promise<void>;
    stop(): void;
  }
}
