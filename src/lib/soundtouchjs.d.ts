declare module 'soundtouchjs' {
  export interface SampleSource {
    extract(target: Float32Array, numFrames: number, position: number): number;
  }

  export class SoundTouch {
    rate: number;
    tempo: number;
    set pitch(v: number);
    set pitchOctaves(v: number);
    set pitchSemitones(v: number);
    clear(): void;
  }

  export class SimpleFilter {
    constructor(source: SampleSource, pipe: SoundTouch, callback?: () => void);
    sourcePosition: number;
    position: number;
    extract(target: Float32Array, numFrames: number): number;
    clear(): void;
  }

  export class WebAudioBufferSource implements SampleSource {
    constructor(buffer: AudioBuffer);
    extract(target: Float32Array, numFrames: number, position: number): number;
  }

  export class PitchShifter {
    constructor(context: BaseAudioContext, buffer: AudioBuffer, bufferSize: number, onEnd?: () => void);
  }
}
