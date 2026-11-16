importScripts("../../vendor/mediabunny.js");
self.onmessage = async ({ data }) => {
  const { id, base64, type } = data || {};
  let input, output;
  try {
    const MB = self.Mediabunny;
    const decode = () => {
      const chunks = [];
      for (let offset = 0; offset < base64.length; offset += 65536) {
        const text = atob(base64.slice(offset, offset + 65536));
        const bytes = new Uint8Array(text.length);
        for (let index = 0; index < text.length; index++)
          bytes[index] = text.charCodeAt(index);
        chunks.push(bytes);
      }
      return new Blob(chunks, { type });
    };
    input = new MB.Input({
      source: new MB.BlobSource(decode()),
      formats: MB.ALL_FORMATS,
    });
    const videos = await input.getVideoTracks();
    if (!videos.length) throw new Error("VIDEO_TRACK_MISSING");
    const audio = await input.getAudioTracks();
    if (!audio.length) {
      self.postMessage({ id, success: true, unchanged: true });
      return;
    }
    const formats = {
      "video/mp4": MB.Mp4OutputFormat,
      "video/webm": MB.WebMOutputFormat,
      "video/quicktime": MB.MovOutputFormat,
    };
    const Format = formats[type];
    if (!Format) throw new Error("VIDEO_CONTAINER_UNSUPPORTED");
    output = new MB.Output({
      format: new Format(),
      target: new MB.BufferTarget(),
    });
    const conversion = await MB.Conversion.init({
      input,
      output,
      tracks: "all",
      video: {},
      audio: { discard: true },
      copy: { mode: "forced" },
      showWarnings: false,
    });
    if (
      !conversion.isValid ||
      conversion.utilizedTracks.filter((track) => track.isVideoTrack())
        .length !== videos.length
    )
      throw new Error("VIDEO_COPY_UNSUPPORTED");
    await conversion.execute();
    const blob = new Blob([output.target.buffer], { type });
    if (!blob.size) throw new Error("EMPTY_VIDEO_OUTPUT");
    const encoded = new FileReaderSync().readAsDataURL(blob);
    self.postMessage({
      id,
      success: true,
      base64: encoded.slice(encoded.indexOf(",") + 1),
      type,
    });
  } catch (_) {
    self.postMessage({ id, success: false, error: "FLOW_UPLOAD_MUTE_FAILED" });
  } finally {
    input?.dispose();
  }
};
