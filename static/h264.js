/* Воспроизведение потока H264 с регистратора через WebCodecs. */

(function () {
  function concat(left, right) {
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
  }

  function avcCodec(data) {
    for (let i = 0; i + 7 < data.length; i += 1) {
      let start = -1;
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) start = i + 3;
      else if (i + 5 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
        start = i + 4;
      }
      if (start < 0 || start + 3 >= data.length) continue;
      if ((data[start] & 0x1f) !== 7) continue;
      const hex = (value) => value.toString(16).padStart(2, "0");
      return "avc1." + hex(data[start + 1]) + hex(data[start + 2]) + hex(data[start + 3]);
    }
    return "";
  }

  function playH264(canvas, url) {
    const abort = new AbortController();
    let stopped = false;
    const context = canvas.getContext("2d");
    let decoder = null;

    function note(text) {
      context.fillStyle = "#9aa592";
      context.font = "14px sans-serif";
      context.fillText(text, 12, 28);
    }

    if (typeof VideoDecoder !== "function") {
      note("Этот браузер не воспроизводит H264.");
      return function stop() {};
    }

    decoder = new VideoDecoder({
      output(frame) {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        context.drawImage(frame, 0, 0);
        frame.close();
      },
      error() {
        note("Кадр H264 не разобрался.");
      },
    });

    const stop = function stop() {
      stopped = true;
      abort.abort();
      if (decoder && decoder.state !== "closed") {
        try { decoder.close(); } catch (error) { /* уже закрыт */ }
      }
    };

    (async function run() {
      let pending = new Uint8Array(0);
      let configured = false;
      let timestamp = 0;
      const response = await fetch(url, { signal: abort.signal, cache: "no-store" });
      if (!response.ok || !response.body) {
        note("Поток H264 не открылся.");
        return;
      }
      const reader = response.body.getReader();
      while (!stopped) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending = concat(pending, chunk.value);
        while (pending.length >= 5) {
          const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
          const key = view.getUint8(0) === 1;
          const length = view.getUint32(1);
          if (length > 8000000) {
            pending = pending.slice(1);
            continue;
          }
          if (pending.length < 5 + length) break;
          const data = pending.slice(5, 5 + length);
          pending = pending.slice(5 + length);
          if (!configured) {
            if (!key) continue;
            const codec = avcCodec(data) || "avc1.640028";
            decoder.configure({ codec: codec, optimizeForLatency: true });
            configured = true;
          }
          if (!key && decoder.decodeQueueSize > 12) continue;
          decoder.decode(new EncodedVideoChunk({
            type: key ? "key" : "delta",
            timestamp: timestamp,
            data: data,
          }));
          timestamp += 40000;
        }
      }
    })().catch(function (error) {
      if (!stopped && error.name !== "AbortError") note("Поток H264 прервался.");
    });

    return stop;
  }

  window.playH264 = playH264;
})();
