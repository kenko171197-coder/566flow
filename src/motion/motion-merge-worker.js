importScripts("../../vendor/mediabunny.js");
let active = null;
class MotionMergeAudio {
  constructor(layout, offset, emit) {
    this.layout = layout;
    this.offset = offset;
    this.emit = emit;
    this.next = 0;
    this.last = null;
    this.end = 0;
  }
  async write(data, start) {
    if (!data.length) return;
    const sample = new self.Mediabunny.AudioSample({
      data,
      format: "f32",
      sampleRate: this.layout.sampleRate,
      numberOfChannels: this.layout.numberOfChannels,
      timestamp: this.offset + start / this.layout.sampleRate,
    });
    try {
      await this.emit(sample);
    } finally {
      sample.close();
    }
  }
  async add(sample, frames, time, playbackRate = 1) {
    const rate = this.layout.sampleRate,
      channels = this.layout.numberOfChannels;
    const sourceChannels = sample.numberOfChannels,
      sourceRate = sample.sampleRate * playbackRate;
    const data = new Float32Array(frames * sourceChannels);
    sample.copyTo(data, { planeIndex: 0, format: "f32", frameCount: frames });
    const at = (frame, channel) => {
      const base = frame * sourceChannels;
      if (sourceChannels === channels) return data[base + channel];
      if (sourceChannels === 1 && channels === 2) return data[base];
      if (channels === 1 && sourceChannels === 2)
        return (data[base] + data[base + 1]) / 2;
      if (channels === 1 && sourceChannels === 4)
        return (
          (data[base] + data[base + 1] + data[base + 2] + data[base + 3]) / 4
        );
      if (channels === 2 && sourceChannels === 4)
        return (data[base + channel] + data[base + channel + 2]) / 2;
      if (channels === 2 && sourceChannels === 6)
        return (
          data[base + channel] +
          Math.SQRT1_2 * (data[base + 2] + data[base + channel + 4])
        );
      if (channels === 1 && sourceChannels === 6)
        return (
          Math.SQRT1_2 * (data[base] + data[base + 1]) +
          data[base + 2] +
          0.5 * (data[base + 4] + data[base + 5])
        );
      return channel < sourceChannels ? data[base + channel] : 0;
    };
    const contiguous = this.last && Math.abs(time - this.end) <= 1 / sourceRate;
    const start = Math.max(
      this.next,
      contiguous ? this.next : Math.ceil(time * rate - 1e-7),
    );
    const end = Math.max(
      start,
      Math.floor((time + (frames - 1) / sourceRate) * rate + 1e-7) + 1,
    );
    const output = new Float32Array((end - start) * channels);
    for (let frame = start; frame < end; frame++) {
      const position = (frame / rate - time) * sourceRate;
      const low = Math.floor(position),
        high = Math.ceil(position),
        fraction = position - low;
      for (let channel = 0; channel < channels; channel++) {
        const a =
          low < 0 && contiguous
            ? this.last[channel]
            : at(Math.max(0, Math.min(frames - 1, low)), channel);
        const b = at(Math.max(0, Math.min(frames - 1, high)), channel);
        output[(frame - start) * channels + channel] = a + fraction * (b - a);
      }
    }
    this.last = Array.from({ length: channels }, (_, channel) =>
      at(frames - 1, channel),
    );
    this.end = time + frames / sourceRate;
    this.next = end;
    await this.write(output, start);
  }
  async finish() {
    const frames = Math.max(
      0,
      Math.round(this.end * this.layout.sampleRate) - this.next,
    );
    if (!frames || !this.last) return;
    const output = new Float32Array(frames * this.layout.numberOfChannels);
    for (let frame = 0; frame < frames; frame++)
      output.set(this.last, frame * this.last.length);
    await this.write(output, this.next);
  }
}
async function inspect(blob, ignoreAudio = false) {
  const { Input, BlobSource, ALL_FORMATS } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !(await video.canDecode()))
      throw new Error("MERGE_VIDEO_CODEC_UNSUPPORTED");
    const audio = ignoreAudio ? null : await input.getPrimaryAudioTrack();
    if (audio && !(await audio.canDecode()))
      throw new Error("MERGE_AUDIO_CODEC_UNSUPPORTED");
    const duration = await video.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("MERGE_DURATION_INVALID");
    return { duration, hasAudio: !!audio };
  } finally {
    input.dispose();
  }
}
async function measureDuration(message) {
  const blob = message.clips?.[0];
  if (!(blob instanceof Blob) || !blob.size || message.clips.length !== 1)
    throw new Error("MERGE_INPUT_INVALID");
  const { Input, BlobSource, ALL_FORMATS } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error("MOTION_VIDEO_METADATA_FAILED");
    const duration = await video.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("MOTION_VIDEO_DURATION_INVALID");
    if (active?.id === message.id)
      self.postMessage({ type: "done", id: message.id, duration });
  } finally {
    input.dispose();
  }
}
async function run(message) {
  const {
    Input,
    BlobSource,
    ALL_FORMATS,
    Output,
    Mp4OutputFormat,
    BufferTarget,
    VideoSampleSink,
    VideoSampleSource,
    AudioSampleSink,
    AudioSampleSource,
    Quality,
    QUALITY_HIGH,
  } = self.Mediabunny;
  const { id, clips } = message;
  if (
    !Array.isArray(clips) ||
    clips.length < 1 ||
    clips.length > 500 ||
    clips.some((blob) => !(blob instanceof Blob) || blob.size < 1)
  ) {
    throw new Error("MERGE_INPUT_INVALID");
  }
  const playbackRate =
    message.playbackRate === void 0 ? 1 : message.playbackRate;
  if (
    typeof playbackRate !== "number" ||
    !Number.isFinite(playbackRate) ||
    playbackRate <= 0 ||
    (playbackRate !== 1 &&
      (clips.length !== 1 || message.originalAudio !== void 0))
  )
    throw new Error("MOTION_VIDEO_SPEED_INVALID");
  const replacingAudio = message.originalAudio !== void 0;
  if (
    replacingAudio &&
    (!(message.originalAudio instanceof Blob) ||
      !message.originalAudio.size ||
      !Array.isArray(message.originalAudioRanges) ||
      !message.originalAudioRanges.length ||
      message.originalAudioRanges.length !== clips.length ||
      message.originalAudioRanges.some(
        (r, i) =>
          !r ||
          !Number.isFinite(r.start) ||
          !Number.isFinite(r.end) ||
          r.start < 0 ||
          r.end <= r.start ||
          (i && r.start < message.originalAudioRanges[i - 1].end),
      ))
  )
    throw new Error("MOTION_ORIGINAL_AUDIO_INVALID");
  const info = [];
  for (const blob of clips) {
    const metadata = await inspect(blob, replacingAudio);
    info.push({
      ...metadata,
      inputDuration: metadata.duration,
      duration: metadata.duration / playbackRate,
    });
  }
  if (
    !message.allowMixedAudio &&
    info.some((item) => item.hasAudio !== info[0].hasAudio)
  )
    throw new Error("MERGE_AUDIO_LAYOUT_MISMATCH");
  if (active?.id !== id) return;
  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  });
  const videoSource = new VideoSampleSource({
    codec: "avc",
    quality: QUALITY_HIGH,
  });
  output.addVideoTrack(videoSource);
  const audioSource =
    replacingAudio ||
    (message.allowMixedAudio
      ? info.some((item) => item.hasAudio)
      : info[0].hasAudio)
      ? new AudioSampleSource({
          codec: "aac",
          quality: new Quality({ bitrate: 192e3 }),
        })
      : null;
  if (audioSource) output.addAudioTrack(audioSource);
  active.output = output;
  let offset = 0;
  let totalFrames = 0;
  let audioLayout =
    replacingAudio || message.allowMixedAudio
      ? { sampleRate: 48e3, numberOfChannels: 2 }
      : null;
  let canvas = null;
  let videoLayout = null,
    normalizedFrames = 0,
    directFrames = 0;
  const totalWork =
    info.reduce((sum, item) => sum + item.duration, 0) * (audioSource ? 2 : 1);
  let lastPercent = -1,
    lastProgressAt = 0;
  const progress = (index, stage, work, force = false) => {
    const percent =
      stage === "complete"
        ? 100
        : Math.min(99, Math.max(0, Math.floor((work * 100) / totalWork)));
    const now = Date.now();
    if (!force && (percent <= lastPercent || now - lastProgressAt < 200))
      return;
    lastPercent = Math.max(lastPercent, percent);
    lastProgressAt = now;
    self.postMessage({
      type: "progress",
      id,
      index: index + 1,
      count: clips.length,
      percent: lastPercent,
      stage,
      normalizedFrames,
      directFrames,
    });
  };
  try {
    await output.start();
    for (let index = 0; index < clips.length; index++) {
      const workBefore = offset * (audioSource && !replacingAudio ? 2 : 1);
      progress(index, "video", workBefore, true);
      if (active?.id !== id) return;
      const input = new Input({
        source: new BlobSource(clips[index]),
        formats: ALL_FORMATS,
      });
      try {
        const track = await input.getPrimaryVideoTrack();
        const videoSink = new VideoSampleSink(track);
        let firstVideo = null;
        let clipFrames = 0;
        for await (const sample of videoSink.samples(
          0,
          info[index].inputDuration,
        )) {
          try {
            if (active?.id !== id) return;
            if (firstVideo === null) firstVideo = sample.timestamp;
            sample.setTimestamp(
              offset +
                Math.max(0, sample.timestamp - firstVideo) / playbackRate,
            );
            if (playbackRate !== 1)
              sample.setDuration(sample.duration / playbackRate);
            if (message.normalizeVideo)
              videoLayout ||
                (videoLayout = {
                  width: Math.max(2, Math.round(sample.displayWidth / 2) * 2),
                  height: Math.max(2, Math.round(sample.displayHeight / 2) * 2),
                });
            const needsCanvas =
              message.normalizeVideo &&
              ((sample.rotation || 0) !== 0 ||
                sample.displayWidth !== videoLayout.width ||
                sample.displayHeight !== videoLayout.height ||
                sample.codedWidth !== videoLayout.width ||
                sample.codedHeight !== videoLayout.height);
            if (needsCanvas) {
              canvas ||
                (canvas = new OffscreenCanvas(
                  videoLayout.width,
                  videoLayout.height,
                ));
              const context = canvas.getContext("2d", { alpha: false });
              context.fillStyle = "#000";
              context.fillRect(0, 0, canvas.width, canvas.height);
              const scale = Math.min(
                canvas.width / sample.displayWidth,
                canvas.height / sample.displayHeight,
              );
              const width = sample.displayWidth * scale,
                height = sample.displayHeight * scale;
              sample.draw(
                context,
                (canvas.width - width) / 2,
                (canvas.height - height) / 2,
                width,
                height,
              );
              const normalized = new self.Mediabunny.VideoSample(canvas, {
                timestamp: sample.timestamp,
                duration: sample.duration,
              });
              try {
                await videoSource.add(
                  normalized,
                  clipFrames === 0 ? { keyFrame: true } : void 0,
                );
              } finally {
                normalized.close();
              }
              normalizedFrames++;
            } else {
              await videoSource.add(
                sample,
                clipFrames === 0 ? { keyFrame: true } : void 0,
              );
              directFrames++;
            }
            clipFrames++;
            progress(
              index,
              "video",
              workBefore +
                Math.min(
                  info[index].duration,
                  sample.timestamp - offset + Math.max(0, sample.duration || 0),
                ),
            );
          } finally {
            sample.close();
          }
        }
        if (!clipFrames) throw new Error("MERGE_EMPTY_VIDEO_CLIP");
        totalFrames += clipFrames;
        if (audioSource && !replacingAudio) {
          progress(index, "audio", workBefore + info[index].duration, true);
          const audioTrack = await input.getPrimaryAudioTrack();
          const audioSink = audioTrack ? new AudioSampleSink(audioTrack) : null;
          let firstAudio = null;
          let normalized = null;
          for await (const sample of audioSink
            ? audioSink.samples(0, info[index].inputDuration)
            : []) {
            try {
              if (active?.id !== id) return;
              if (firstAudio === null) firstAudio = sample.timestamp;
              const relativeTime =
                sample.timestamp -
                (playbackRate === 1 ? firstAudio : firstVideo);
              const skip =
                playbackRate === 1
                  ? 0
                  : Math.min(
                      sample.numberOfFrames,
                      Math.max(0, Math.ceil(-relativeTime * sample.sampleRate)),
                    );
              const localTime = Math.max(
                0,
                relativeTime + skip / sample.sampleRate,
              );
              const remaining = info[index].inputDuration - localTime;
              const frames = Math.min(
                sample.numberOfFrames - skip,
                Math.floor(remaining * sample.sampleRate),
              );
              if (frames <= 0) continue;
              audioLayout ||
                (audioLayout = {
                  sampleRate: sample.sampleRate,
                  numberOfChannels: sample.numberOfChannels,
                });
              normalized ||
                (normalized = new MotionMergeAudio(
                  audioLayout,
                  offset,
                  (value) => audioSource.add(value),
                ));
              if (skip) {
                const data = new Float32Array(frames * sample.numberOfChannels);
                sample.copyTo(data, {
                  planeIndex: 0,
                  format: "f32",
                  frameOffset: skip,
                  frameCount: frames,
                });
                const trimmed = new self.Mediabunny.AudioSample({
                  data,
                  format: "f32",
                  sampleRate: sample.sampleRate,
                  numberOfChannels: sample.numberOfChannels,
                  timestamp: localTime,
                });
                try {
                  await normalized.add(
                    trimmed,
                    frames,
                    localTime / playbackRate,
                    playbackRate,
                  );
                } finally {
                  trimmed.close();
                }
              } else
                await normalized.add(
                  sample,
                  frames,
                  localTime / playbackRate,
                  playbackRate,
                );
              progress(
                index,
                "audio",
                workBefore +
                  info[index].duration +
                  Math.min(info[index].duration, normalized.end),
              );
            } finally {
              sample.close();
            }
          }
          await normalized?.finish();
          if (message.allowMixedAudio) {
            let next = normalized
              ? Math.round(normalized.end * audioLayout.sampleRate)
              : 0;
            const end = Math.round(
              info[index].duration * audioLayout.sampleRate,
            );
            const padding = new MotionMergeAudio(audioLayout, offset, (value) =>
              audioSource.add(value),
            );
            while (next < end) {
              const count = Math.min(4096, end - next);
              await padding.write(
                new Float32Array(count * audioLayout.numberOfChannels),
                next,
              );
              next += count;
              progress(
                index,
                "audio",
                workBefore +
                  info[index].duration +
                  next / audioLayout.sampleRate,
              );
            }
          }
        }
      } finally {
        input.dispose();
      }
      offset += info[index].duration;
      progress(
        index,
        "clip_ready",
        offset * (audioSource && !replacingAudio ? 2 : 1),
        true,
      );
    }
    if (replacingAudio) {
      const input = new Input({
        source: new BlobSource(message.originalAudio),
        formats: ALL_FORMATS,
      });
      try {
        const track = await input.getPrimaryAudioTrack();
        if (!track || !(await track.canDecode()))
          throw new Error("MOTION_ORIGINAL_AUDIO_MISSING");
        const duration = await track.computeDuration();
        if (
          !Number.isFinite(duration) ||
          message.originalAudioRanges.some((r) => r.end > duration + 0.1)
        )
          throw new Error("MOTION_ORIGINAL_AUDIO_INVALID");
        const sink = new AudioSampleSink(track);
        const normalized = new MotionMergeAudio(audioLayout, 0, (value) =>
          audioSource.add(value),
        );
        let audioOffset = 0;
        for (const range of message.originalAudioRanges) {
          if (audioOffset >= offset) break;
          const end2 = Math.min(range.end, range.start + offset - audioOffset);
          for await (const sample of sink.samples(range.start, end2)) {
            try {
              if (active?.id !== id) return;
              const rate = sample.sampleRate;
              const first = Math.max(
                0,
                Math.round((range.start - sample.timestamp) * rate),
              );
              const last = Math.min(
                sample.numberOfFrames,
                Math.round((end2 - sample.timestamp) * rate),
              );
              if (last <= first) continue;
              const frames = last - first;
              const data = new Float32Array(frames * sample.numberOfChannels);
              sample.copyTo(data, {
                planeIndex: 0,
                format: "f32",
                frameOffset: first,
                frameCount: frames,
              });
              const time =
                audioOffset +
                Math.max(0, sample.timestamp + first / rate - range.start);
              const trimmed = new self.Mediabunny.AudioSample({
                data,
                format: "f32",
                sampleRate: rate,
                numberOfChannels: sample.numberOfChannels,
                timestamp: time,
              });
              try {
                await normalized.add(trimmed, frames, time);
              } finally {
                trimmed.close();
              }
              progress(
                clips.length - 1,
                "original_audio",
                offset + Math.min(offset, normalized.end),
              );
            } finally {
              sample.close();
            }
          }
          audioOffset += end2 - range.start;
        }
        await normalized.finish();
        let next = normalized.next,
          end = Math.round(offset * audioLayout.sampleRate);
        while (next < end) {
          if (active?.id !== id) return;
          const count = Math.min(4096, end - next);
          await normalized.write(
            new Float32Array(count * audioLayout.numberOfChannels),
            next,
          );
          next += count;
        }
      } finally {
        input.dispose();
      }
    }
    videoSource.close();
    audioSource?.close();
    progress(clips.length - 1, "finalizing", totalWork, true);
    await output.finalize();
    if (active?.id !== id) return;
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("MERGE_OUTPUT_EMPTY");
    progress(clips.length - 1, "complete", totalWork, true);
    self.postMessage({
      type: "done",
      id,
      blob: new Blob([buffer], { type: "video/mp4" }),
      duration: offset,
      videoFrames: totalFrames,
      audioState: audioSource ? "audio_present" : "audio_track_absent",
    });
  } finally {
    if (active?.output === output) active.output = null;
    if (output.state !== "finalized" && output.state !== "canceled")
      await output.cancel().catch(() => {});
  }
}
self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "cancel") {
    if (active?.id === message.id) {
      active.output?.cancel().catch(() => {});
      active = null;
    }
    return;
  }
  if (!["merge", "measure_duration"].includes(message.type) || active) return;
  active = { id: message.id, output: null };
  (message.type === "measure_duration"
    ? measureDuration(message)
    : run(message)
  )
    .catch((error) => {
      if (active?.id === message.id)
        self.postMessage({
          type: "error",
          id: message.id,
          code: error?.message || "MERGE_FAILED",
        });
    })
    .finally(() => {
      if (active?.id === message.id) active = null;
    });
};
