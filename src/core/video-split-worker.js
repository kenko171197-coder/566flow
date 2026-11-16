importScripts("../../vendor/mediabunny.js");
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_PARTS = 120;
const QUIET_BIN_SECONDS = 0.02;
let active = null;
async function findQuietCut(sink, from, to, target, id) {
  const binCount = Math.ceil((to - from) / QUIET_BIN_SECONDS);
  const power = new Float64Array(binCount);
  const frames = new Uint32Array(binCount);
  for await (const sample of sink.samples(from, to)) {
    try {
      if (active?.id !== id) return null;
      for (let channel = 0; channel < sample.numberOfChannels; channel++) {
        const data = new Float32Array(sample.numberOfFrames);
        sample.copyTo(data, { planeIndex: channel, format: "f32-planar" });
        for (let frame = 0; frame < data.length; frame++) {
          const bin = Math.floor(
            (sample.timestamp + frame / sample.sampleRate - from) /
              QUIET_BIN_SECONDS,
          );
          if (bin < 0 || bin >= binCount) continue;
          power[bin] += data[frame] * data[frame];
          frames[bin]++;
        }
      }
    } finally {
      sample.close();
    }
  }
  const levels = power.map((sum, index) =>
    frames[index] ? Math.sqrt(sum / frames[index]) : NaN,
  );
  const ordered = Array.from(levels)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!ordered.length) return null;
  const peak = ordered.at(-1);
  if (peak === 0) return target;
  const reference = ordered[Math.floor((ordered.length - 1) * 0.9)] || peak;
  const noiseFloor = ordered[Math.floor((ordered.length - 1) * 0.1)];
  const threshold = Math.min(
    reference * 0.35,
    Math.max(reference * 0.08, noiseFloor * 1.5),
  );
  let best = null;
  for (let i = 0; i < binCount; ) {
    if (!Number.isFinite(levels[i]) || levels[i] > threshold) {
      i++;
      continue;
    }
    let end = i + 1;
    while (
      end < binCount &&
      Number.isFinite(levels[end]) &&
      levels[end] <= threshold
    )
      end++;
    if ((end - i) * QUIET_BIN_SECONDS >= 0.16) {
      const cut = Math.min(
        to,
        Math.max(from, from + ((i + end) * QUIET_BIN_SECONDS) / 2),
      );
      if (!best || Math.abs(cut - target) < Math.abs(best - target)) best = cut;
    }
    i = end;
  }
  return best;
}
async function inspectAudioTrack(input, id, stage) {
  let track = null,
    config = null,
    codec = null,
    reason = "decoder_probe_rejected",
    errorName = null;
  try {
    track = await input.getPrimaryAudioTrack();
    if (!track) return { track: null, audioState: "audio_track_absent" };
    if (await track.canDecode()) return { track, audioState: "audio_present" };
    codec = (await track.getCodec?.()) ?? null;
    config = (await track.getDecoderConfig?.()) ?? null;
    if (typeof track.getCodec === "function" && !codec)
      reason = "codec_unrecognized";
    else if (typeof track.getDecoderConfig === "function" && !config)
      reason = "decoder_config_missing";
    else if (typeof self.AudioDecoder === "undefined")
      reason = "audio_decoder_unavailable";
    else if (config)
      reason =
        (await self.AudioDecoder.isConfigSupported(config))?.supported === true
          ? "decoder_probe_rejected"
          : "codec_configuration_unsupported";
  } catch (error) {
    reason = track ? "decoder_probe_error" : "audio_track_read_error";
    errorName = String(error?.name || "Error").slice(0, 80);
  }
  const safeCodec = (value) =>
    typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)
      ? value
      : null;
  const diagnostic = {
    stage,
    reason,
    trackFound: !!track,
    codec: safeCodec(codec),
    codecString: safeCodec(config?.codec),
    sampleRate: Number.isFinite(config?.sampleRate) ? config.sampleRate : null,
    channels: Number.isFinite(config?.numberOfChannels)
      ? config.numberOfChannels
      : null,
    descriptionBytes: Number.isFinite(config?.description?.byteLength)
      ? config.description.byteLength
      : null,
    audioDecoderAvailable: typeof self.AudioDecoder !== "undefined",
    secureContext: self.isSecureContext === true,
    errorName,
  };
  console.warn(
    "[MotionAudioDecode]",
    JSON.stringify({ runId: id, ...diagnostic }),
  );
  self.postMessage({ type: "audio_diagnostic", id, diagnostic });
  return { track, audioState: "audio_decode_unsupported" };
}
async function planCuts(
  blob,
  duration,
  maxSeconds,
  count,
  id,
  cutStrategy = "silence",
  minSeconds = 0,
) {
  if (!["duration", "silence"].includes(cutStrategy))
    throw new Error("INVALID_SPLIT_STRATEGY");
  if (minSeconds > 0 && duration <= minSeconds)
    throw new Error("INVALID_DURATION");
  if (minSeconds > 0 && maxSeconds <= minSeconds)
    throw new Error("INVALID_MAX_SECONDS");
  const boundaries = [0];
  let quietCuts = 0,
    balancedCuts = 0;
  let limit = maxSeconds - 0.06;
  if (minSeconds > 0 && duration / Math.ceil(duration / limit) <= minSeconds)
    limit = maxSeconds;
  const { Input, BlobSource, ALL_FORMATS, AudioSampleSink } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  let audioState = "audio_track_absent";
  try {
    let sink = null;
    const probe = await inspectAudioTrack(input, id, "split_plan");
    audioState = probe.audioState;
    if (cutStrategy === "silence" && audioState === "audio_present")
      sink = new AudioSampleSink(probe.track);
    if (cutStrategy === "duration") {
      const fixedLimit = maxSeconds;
      while (duration - boundaries.at(-1) > fixedLimit + 0.001) {
        if (active?.id !== id) return null;
        if (boundaries.length >= MAX_PARTS) throw new Error("TOO_MANY_PARTS");
        const start = boundaries.at(-1),
          remaining = duration - start;
        const parts = Math.ceil((remaining - 0.001) / fixedLimit);
        if (minSeconds > 0 && remaining / parts <= minSeconds)
          throw new Error("INVALID_DURATION");
        const length =
          minSeconds > 0 && (remaining - fixedLimit) / (parts - 1) <= minSeconds
            ? remaining / parts
            : fixedLimit;
        boundaries.push(
          minSeconds > 0
            ? start + length
            : Math.round((start + length) * 1e3) / 1e3,
        );
        balancedCuts++;
      }
    }
    while (
      cutStrategy === "silence" &&
      count > 1 &&
      duration - boundaries.at(-1) > limit + 0.001
    ) {
      if (active?.id !== id) return null;
      if (boundaries.length >= MAX_PARTS) throw new Error("TOO_MANY_PARTS");
      const start = boundaries.at(-1);
      const remainingParts = Math.ceil((duration - start - 0.001) / limit);
      const target = start + (duration - start) / remainingParts;
      if (minSeconds > 0 && (duration - start) / remainingParts <= minSeconds)
        throw new Error("INVALID_DURATION");
      const minimumLength =
        minSeconds > 0
          ? minSeconds +
            Math.min(
              0.001,
              ((duration - start) / remainingParts - minSeconds) / 2,
            )
          : 0.5;
      const lower = Math.max(
        start + minimumLength,
        duration - (MAX_PARTS - boundaries.length) * limit,
      );
      const upper = Math.min(start + limit, duration - minimumLength);
      let cut = target;
      let quietCut = null;
      if (sink && upper > lower) {
        const from = lower;
        const to = upper;
        if (to - from >= 0.16) {
          try {
            quietCut = await findQuietCut(sink, from, to, target, id);
          } catch (_) {
            sink = null;
          }
        }
      }
      if (active?.id !== id) return null;
      if (quietCut !== null && minSeconds > 0) {
        const rest = duration - quietCut;
        const parts = Math.ceil((rest - 0.001) / limit);
        if (rest / parts <= minSeconds) quietCut = null;
      }
      if (quietCut !== null) {
        cut = quietCut;
        quietCuts++;
      } else balancedCuts++;
      const boundedCut = Math.min(upper, Math.max(lower, cut));
      boundaries.push(
        minSeconds > 0 ? boundedCut : Math.round(boundedCut * 1e3) / 1e3,
      );
    }
  } finally {
    input.dispose();
  }
  boundaries.push(duration);
  if (
    minSeconds > 0 &&
    boundaries.some(
      (end, index) => index > 0 && end - boundaries[index - 1] <= minSeconds,
    )
  )
    throw new Error("INVALID_DURATION");
  console.info("[MotionSplitPlan]", {
    runId: id,
    initialCount: count,
    count: boundaries.length - 1,
    quietCuts,
    balancedCuts,
    maxSeconds,
    minimumExclusiveSeconds: minSeconds,
    audioState,
    cutStrategy,
  });
  return {
    boundaries,
    audioState,
    cutStrategy,
    quietCuts,
    timeCuts: balancedCuts,
  };
}
function recordMediaFailure(id, stage, error, detail = {}) {
  const diagnostic = {
    stage,
    errorName: String(error?.name || "Error").slice(0, 80),
    errorCode: /^[A-Z][A-Z0-9_]{1,99}$/.test(
      String(error?.code || error?.message || ""),
    )
      ? String(error.code || error.message)
      : null,
    ...detail,
  };
  console.warn(
    "[MotionMediaDecode]",
    JSON.stringify({ runId: id, ...diagnostic }),
  );
  self.postMessage({ type: "media_diagnostic", id, diagnostic });
}
async function audioOf(blob, start, end, id, transcription = null) {
  const {
    Input,
    BlobSource,
    ALL_FORMATS,
    Output,
    WavOutputFormat,
    BufferTarget,
    Conversion,
  } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    const output = new Output({
      format: new WavOutputFormat(),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { discard: true },
      audio: {
        ...(transcription && {
          numberOfChannels: 1,
          sampleRate: transcription.sampleRate,
          codec: "pcm-s16",
          sampleFormat: "s16",
        }),
        process: (sample) => {
          if (sample.timestamp < 0) {
            if (sample.timestamp < -1 / sample.sampleRate)
              throw new Error("AUDIO_TRIM_TIMESTAMP_INVALID");
            console.info("[MotionSplit] Audio trim rounded to zero", {
              runId: id,
              start,
              end,
              timestamp: sample.timestamp,
              sampleRate: sample.sampleRate,
            });
            sample.setTimestamp(0);
          }
          return sample;
        },
      },
      trim: { start, end },
      copy: false,
      showWarnings: false,
    });
    if (active?.id !== id) return null;
    if (
      !conversion.isValid ||
      !conversion.utilizedTracks.some((track) => track.isAudioTrack())
    ) {
      throw new Error("AUDIO_CODEC_UNSUPPORTED");
    }
    active.conversion = conversion;
    await conversion.execute();
    if (active?.id !== id) return null;
    active.conversion = null;
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("EMPTY_AUDIO_OUTPUT");
    return new Blob([buffer], { type: "audio/wav" });
  } catch (error) {
    recordMediaFailure(id, "audio_export", error, { start, end });
    throw error;
  } finally {
    input.dispose();
  }
}
async function motionVideoOf(blob, start, end, id, index, count) {
  const {
    Input,
    BlobSource,
    ALL_FORMATS,
    Output,
    Mp4OutputFormat,
    BufferTarget,
    VideoSampleSink,
    VideoSampleSource,
    QUALITY_HIGH,
  } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  let output = null;
  let source = null;
  let phase = "video_probe",
    frameCount = 0,
    lastTimestamp = null,
    codecString = null;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode()))
      throw new Error("VIDEO_CODEC_UNSUPPORTED");
    try {
      codecString = (await track.getDecoderConfig?.())?.codec || null;
    } catch (_) {}
    phase = "video_output_start";
    output = new Output({
      format: new Mp4OutputFormat(),
      target: new BufferTarget(),
    });
    source = new VideoSampleSource({ codec: "avc", quality: QUALITY_HIGH });
    output.addVideoTrack(source);
    active.output = output;
    await output.start();
    const sink = new VideoSampleSink(track);
    let firstTimestamp = null;
    phase = "video_decode";
    for await (const sample of sink.samples(start, end)) {
      try {
        if (active?.id !== id) return null;
        const timestamp = sample.timestamp;
        lastTimestamp = timestamp;
        if (timestamp < start - 1e-6 || timestamp >= end - 1e-6) continue;
        if (firstTimestamp === null) firstTimestamp = timestamp;
        sample.setTimestamp(Math.max(0, timestamp - firstTimestamp));
        sample.setDuration(
          Math.min(sample.duration, end - start - sample.timestamp),
        );
        phase = "video_encode";
        await source.add(
          sample,
          frameCount === 0 ? { keyFrame: true } : void 0,
        );
        frameCount++;
        phase = "video_decode";
        if (frameCount % 5 === 0)
          self.postMessage({
            type: "progress",
            id,
            index,
            count,
            percent: Math.min(
              99,
              Math.floor(((timestamp - start) / (end - start)) * 100),
            ),
          });
      } finally {
        sample.close();
      }
    }
    if (!frameCount) throw new Error("EMPTY_VIDEO_CLIP");
    phase = "video_finalize";
    source.close();
    await output.finalize();
    if (active?.id !== id) return null;
    active.output = null;
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("EMPTY_OUTPUT");
    return { blob: new Blob([buffer], { type: "video/mp4" }), frameCount };
  } catch (error) {
    recordMediaFailure(id, phase, error, {
      start,
      end,
      frameCount,
      lastTimestamp,
      codecString:
        typeof codecString === "string" &&
        /^[a-zA-Z0-9_.-]{1,80}$/.test(codecString)
          ? codecString
          : null,
    });
    throw error;
  } finally {
    if (active?.output === output) active.output = null;
    if (output && output.state !== "finalized" && output.state !== "canceled") {
      await output.cancel().catch(() => {});
    }
    input.dispose();
  }
}
async function durationOf(blob) {
  const { Input, BlobSource, ALL_FORMATS } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("NO_VIDEO_TRACK");
    const duration = await track.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("INVALID_DURATION");
    return duration;
  } finally {
    input.dispose();
  }
}
async function audioDurationOf(blob) {
  const { Input, BlobSource, ALL_FORMATS } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("AUDIO_OUTPUT_TRACK_MISSING");
    const duration = await track.computeDuration();
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("INVALID_AUDIO_DURATION");
    return duration;
  } finally {
    input.dispose();
  }
}
async function run({
  id,
  blob,
  maxSeconds,
  mode,
  includeAudio,
  range,
  cutStrategy = "silence",
  ackEachFrame,
  continueOnFrameError = false,
  maxFrameRetries,
}) {
  const motion = mode === "motion";
  const exportAudio = motion && includeAudio !== false;
  if (
    continueOnFrameError &&
    (!motion ||
      !Number.isSafeInteger(maxFrameRetries) ||
      maxFrameRetries < 0 ||
      maxFrameRetries > 10)
  )
    throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
  if (!(blob instanceof Blob) || blob.size === 0 || blob.size > MAX_BYTES)
    throw new Error("INVALID_VIDEO_SIZE");
  if (!Number.isFinite(maxSeconds) || maxSeconds < 1)
    throw new Error("INVALID_MAX_SECONDS");
  const duration = await durationOf(blob);
  if (active?.id !== id) return;
  if (
    range &&
    (!motion ||
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > duration + 0.001 ||
      range.end - range.start > maxSeconds + 0.001)
  )
    throw new Error("INVALID_FRAME_RANGE");
  const initialCount = range
    ? 1
    : Math.ceil(
        duration /
          (cutStrategy === "duration" ? maxSeconds : maxSeconds - 0.06),
      );
  if (initialCount > MAX_PARTS) throw new Error("TOO_MANY_PARTS");
  const plan = await planCuts(
    blob,
    duration,
    maxSeconds,
    initialCount,
    id,
    range ? "silence" : cutStrategy,
    motion && !range ? 3 : 0,
  );
  if (!plan || active?.id !== id) return;
  if (range) {
    plan.boundaries = [range.start, range.end];
    plan.cutStrategy = cutStrategy;
    plan.quietCuts = plan.timeCuts = 0;
  }
  const { boundaries } = plan;
  const count = boundaries.length - 1;
  if (count > MAX_PARTS) throw new Error("TOO_MANY_PARTS");
  const audioState = exportAudio ? plan.audioState : "audio_not_requested";
  self.postMessage({
    type: "plan",
    id,
    duration,
    count,
    ...(motion
      ? {
          boundaries,
          audioState,
          cutStrategy: plan.cutStrategy,
          quietCuts: plan.quietCuts,
          timeCuts: plan.timeCuts,
        }
      : {}),
  });
  const {
    Input,
    BlobSource,
    ALL_FORMATS,
    Output,
    Mp4OutputFormat,
    BufferTarget,
    Conversion,
  } = self.Mediabunny;
  for (let index = 0; index < count; index++) {
    if (active?.id !== id) return;
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (motion) {
      const codeOf = (error, stage) => {
        const raw = String(error?.code || error?.message || "");
        return /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
          ? raw
          : stage === "audio"
            ? "MOTION_AUDIO_EXTRACT_FAILED"
            : "MOTION_SPLIT_FAILED";
      };
      const retry = async (stage, action) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await action();
          } catch (error) {
            if (
              !continueOnFrameError ||
              attempt >= maxFrameRetries ||
              active?.id !== id
            )
              throw error;
            const ready = new Promise((resolve) => {
              active.retryAck = { index, attempt: attempt + 1, resolve };
            });
            self.postMessage({
              type: "frame_retry",
              id,
              index,
              count,
              stage,
              retryCount: attempt + 1,
              code: codeOf(error, stage),
            });
            await ready;
            if (active?.id !== id) return null;
          }
        }
      };
      let result, actualDuration;
      try {
        result = await retry("split", async () => {
          const value = await motionVideoOf(blob, start, end, id, index, count);
          if (!value || active?.id !== id) return null;
          const measured = await durationOf(value.blob);
          if (!range && measured <= 3) throw new Error("INVALID_DURATION");
          if (measured > maxSeconds + 0.001)
            throw new Error("OUTPUT_EXCEEDS_MAX_SECONDS");
          const verifyInput = new Input({
            source: new BlobSource(value.blob),
            formats: ALL_FORMATS,
          });
          try {
            if ((await verifyInput.getAudioTracks()).length)
              throw new Error("OUTPUT_HAS_AUDIO");
          } finally {
            verifyInput.dispose();
          }
          if (active.totalBytes + value.blob.size > 500 * 1024 * 1024)
            throw new Error("OUTPUT_TOO_LARGE");
          return { ...value, duration: measured };
        });
        if (!result || active?.id !== id) return;
        actualDuration = result.duration;
      } catch (error) {
        if (!continueOnFrameError) throw error;
        if (active?.id !== id) return;
        const saved2 =
          ackEachFrame === true
            ? new Promise((resolve) => {
                active.frameAck = { index, resolve };
              })
            : null;
        self.postMessage({
          type: "frame_error",
          id,
          index,
          count,
          start,
          end,
          stage: "split",
          code: codeOf(error, "split"),
        });
        if (saved2) await saved2;
        continue;
      }
      const clip = result.blob;
      active.totalBytes += clip.size;
      const saved =
        ackEachFrame === true
          ? new Promise((resolve) => {
              active.frameAck = { index, resolve };
            })
          : null;
      self.postMessage({
        type: "clip",
        id,
        index,
        count,
        blob: clip,
        duration: actualDuration,
        frameCount: result.frameCount,
        start,
        end,
      });
      if (exportAudio && audioState === "audio_present") {
        try {
          const value = await retry("audio", async () => {
            const audio = await audioOf(blob, start, end, id);
            if (active?.id !== id) return null;
            const measured = await audioDurationOf(audio);
            if (Math.abs(measured - (end - start)) > 0.1)
              throw new Error("AUDIO_BOUNDARY_MISMATCH");
            return { audio, duration: measured };
          });
          if (!value || active?.id !== id) return;
          self.postMessage({
            type: "audio",
            id,
            index,
            count,
            blob: value.audio,
            start,
            end,
            duration: value.duration,
            audioState: "audio_present",
          });
        } catch (error) {
          if (!continueOnFrameError) throw error;
          if (active?.id !== id) return;
          self.postMessage({
            type: "frame_error",
            id,
            index,
            count,
            start,
            end,
            stage: "audio",
            code: codeOf(error, "audio"),
          });
        }
      }
      if (saved) {
        await saved;
        if (active?.id !== id) return;
      }
      continue;
    }
    const input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    });
    try {
      const output = new Output({
        format: new Mp4OutputFormat(),
        target: new BufferTarget(),
      });
      const conversion = await Conversion.init({
        input,
        output,
        tracks: "primary",
        video: {},
        audio: { discard: true },
        trim: { start, end },
        copy: false,
        showWarnings: false,
      });
      if (active?.id !== id) return;
      if (
        !conversion.isValid ||
        !conversion.utilizedTracks.some((track) => track.isVideoTrack())
      ) {
        throw new Error("VIDEO_CODEC_UNSUPPORTED");
      }
      active.conversion = conversion;
      let lastPercent = -1;
      conversion.onProgress = (progress) => {
        const percent = Math.floor(progress * 100);
        if (percent >= lastPercent + 5) {
          lastPercent = percent;
          self.postMessage({ type: "progress", id, index, count, percent });
        }
      };
      await conversion.execute();
      if (active?.id !== id) return;
      active.conversion = null;
      const buffer = output.target.buffer;
      if (!buffer) throw new Error("EMPTY_OUTPUT");
      const clip = new Blob([buffer], { type: "video/mp4" });
      const actualDuration = await durationOf(clip);
      if (actualDuration > maxSeconds + 0.001)
        throw new Error("OUTPUT_EXCEEDS_MAX_SECONDS");
      const verifyInput = new Input({
        source: new BlobSource(clip),
        formats: ALL_FORMATS,
      });
      try {
        if ((await verifyInput.getAudioTracks()).length)
          throw new Error("OUTPUT_HAS_AUDIO");
      } finally {
        verifyInput.dispose();
      }
      active.totalBytes += clip.size;
      if (active.totalBytes > 500 * 1024 * 1024)
        throw new Error("OUTPUT_TOO_LARGE");
      self.postMessage({
        type: "clip",
        id,
        index,
        count,
        blob: clip,
        duration: actualDuration,
      });
    } finally {
      input.dispose();
    }
  }
  self.postMessage({ type: "done", id, count });
}
async function extractAudioRange({ id, blob, range }) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_BYTES)
    throw new Error("INVALID_VIDEO_SIZE");
  const duration = await durationOf(blob);
  if (
    !range ||
    !Number.isFinite(range.start) ||
    !Number.isFinite(range.end) ||
    range.start < 0 ||
    range.end <= range.start ||
    range.end > duration + 0.001
  )
    throw new Error("INVALID_FRAME_RANGE");
  if (active?.id !== id) return;
  const { Input, BlobSource, ALL_FORMATS } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  let hasAudio;
  try {
    const probe = await inspectAudioTrack(input, id, "extract_audio");
    hasAudio = probe.audioState !== "audio_track_absent";
    if (probe.audioState === "audio_decode_unsupported")
      throw new Error("AUDIO_DECODE_UNSUPPORTED");
  } finally {
    input.dispose();
  }
  if (active?.id !== id) return;
  if (!hasAudio) {
    self.postMessage({
      type: "audio",
      id,
      audioState: "audio_track_absent",
      blob: null,
      ...range,
    });
    return;
  }
  const audio = await audioOf(blob, range.start, range.end, id);
  if (active?.id !== id) return;
  const audioDuration = await audioDurationOf(audio);
  if (Math.abs(audioDuration - (range.end - range.start)) > 0.1)
    throw new Error("AUDIO_BOUNDARY_MISMATCH");
  if (active?.id === id)
    self.postMessage({
      type: "audio",
      id,
      audioState: "audio_present",
      blob: audio,
      duration: audioDuration,
      ...range,
    });
}
async function extractFullAudio({ id, blob }) {
  if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_BYTES)
    throw new Error("INVALID_VIDEO_SIZE");
  const duration = await durationOf(blob);
  const { Input, BlobSource, ALL_FORMATS } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  let probe;
  try {
    probe = await inspectAudioTrack(input, id, "full_audio");
  } finally {
    input.dispose();
  }
  if (active?.id !== id) return;
  if (probe.audioState !== "audio_present")
    throw new Error(
      probe.audioState === "audio_track_absent"
        ? "MOTION_AUDIO_NOT_AVAILABLE"
        : "AUDIO_DECODE_UNSUPPORTED",
    );
  const audio = await audioOf(blob, 0, duration, id);
  if (active?.id !== id) return;
  const measured = await audioDurationOf(audio);
  if (Math.abs(measured - duration) > 0.1)
    throw new Error("AUDIO_BOUNDARY_MISMATCH");
  if (active?.id === id)
    self.postMessage({
      type: "audio",
      id,
      audioState: "audio_present",
      blob: audio,
      duration: measured,
      start: 0,
      end: duration,
    });
}
async function prepareTranscriptAudio({ id, blob }) {
  if (!(blob instanceof Blob) || !blob.size || blob.type !== "audio/wav")
    throw new Error("MOTION_AUDIO_ARTIFACT_INVALID");
  const { Input, BlobSource, ALL_FORMATS } = self.Mediabunny;
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  let duration, sampleRate;
  try {
    const probe = await inspectAudioTrack(input, id, "transcript_audio");
    if (probe.audioState !== "audio_present")
      throw new Error("AUDIO_DECODE_UNSUPPORTED");
    const track = await input.getPrimaryAudioTrack();
    duration = await track.computeDuration();
    sampleRate = Math.min(16e3, await track.getSampleRate());
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("MOTION_AUDIO_ARTIFACT_INVALID");
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0)
      throw new Error("MOTION_AUDIO_ARTIFACT_INVALID");
  } finally {
    input.dispose();
  }
  if (active?.id !== id) return;
  const audio = await audioOf(blob, 0, duration, id, { sampleRate });
  if (active?.id !== id) return;
  const measured = await audioDurationOf(audio);
  if (Math.abs(measured - duration) > 0.1)
    throw new Error("AUDIO_BOUNDARY_MISMATCH");
  console.info("[MotionTranscriptAudio]", {
    runId: id,
    inputBytes: blob.size,
    uploadBytes: audio.size,
    duration: measured,
    sampleRate,
    channels: 1,
  });
  self.postMessage({
    type: "audio",
    id,
    audioState: "audio_present",
    blob: audio,
    duration: measured,
    start: 0,
    end: duration,
  });
}
self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "frame_retry_ready") {
    if (
      active?.id === message.id &&
      active.retryAck?.index === message.index &&
      active.retryAck?.attempt === message.retryCount
    ) {
      const ack = active.retryAck;
      active.retryAck = null;
      ack.resolve();
    }
    return;
  }
  if (message.type === "frame_saved") {
    if (active?.id === message.id && active.frameAck?.index === message.index) {
      const ack = active.frameAck;
      active.frameAck = null;
      ack.resolve();
    }
    return;
  }
  if (message.type === "cancel") {
    if (active?.id === message.id) {
      const conversion = active.conversion;
      const output = active.output;
      const ack = active.frameAck,
        retryAck = active.retryAck;
      active = null;
      ack?.resolve();
      retryAck?.resolve();
      conversion?.cancel?.().catch(() => {});
      output?.cancel?.().catch(() => {});
    }
    return;
  }
  if (
    ![
      "split",
      "extract_audio",
      "extract_full_audio",
      "prepare_transcript_audio",
    ].includes(message.type) ||
    active
  )
    return;
  active = { id: message.id, conversion: null, output: null, totalBytes: 0 };
  (message.type === "extract_audio"
    ? extractAudioRange(message)
    : message.type === "extract_full_audio"
      ? extractFullAudio(message)
      : message.type === "prepare_transcript_audio"
        ? prepareTranscriptAudio(message)
        : run(message)
  )
    .catch((error) => {
      if (active?.id === message.id)
        self.postMessage({
          type: "error",
          id: message.id,
          code: error?.message || "SPLIT_FAILED",
        });
    })
    .finally(() => {
      if (active?.id === message.id) active = null;
    });
};
