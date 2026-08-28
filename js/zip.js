/* ═══════════════════════════════════════════════════════════════════════════
   Zip — a ~100 line store-only (uncompressed) ZIP writer.

   The whole point of this harness is that the agent's output is yours to take
   somewhere else. No backend means no `zip` binary, and no build step means no
   library, so we emit the archive format by hand.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Zip = (function () {
  const CRC = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** MS-DOS packed date/time, which is what the format wants. */
  function dosStamp(d) {
    return {
      time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff,
      date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
    };
  }

  /**
   * @param {Record<string,string>} filemap path → text content
   * @returns {Blob} an application/zip blob ready for a download anchor
   */
  function build(filemap) {
    const enc = new TextEncoder();
    const stamp = dosStamp(new Date());
    const entries = Object.keys(filemap).sort().map((path) => {
      const name = enc.encode(path);
      const data = enc.encode(filemap[path]);
      return { name, data, crc: crc32(data) };
    });

    const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
    const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
    const buf = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(buf.buffer);
    let at = 0;

    const u16 = (v) => { view.setUint16(at, v, true); at += 2; };
    const u32 = (v) => { view.setUint32(at, v >>> 0, true); at += 4; };
    const raw = (b) => { buf.set(b, at); at += b.length; };

    for (const e of entries) {
      e.offset = at;
      u32(0x04034b50);          // local file header
      u16(20);                  // version needed
      u16(0x0800);              // flags: UTF-8 names
      u16(0);                   // method: stored
      u16(stamp.time); u16(stamp.date);
      u32(e.crc); u32(e.data.length); u32(e.data.length);
      u16(e.name.length); u16(0);
      raw(e.name); raw(e.data);
    }

    const centralAt = at;
    for (const e of entries) {
      u32(0x02014b50);          // central directory record
      u16(20); u16(20); u16(0x0800); u16(0);
      u16(stamp.time); u16(stamp.date);
      u32(e.crc); u32(e.data.length); u32(e.data.length);
      u16(e.name.length); u16(0); u16(0);
      u16(0); u16(0); u32(0);
      u32(e.offset);
      raw(e.name);
    }

    u32(0x06054b50);            // end of central directory
    u16(0); u16(0);
    u16(entries.length); u16(entries.length);
    u32(centralSize);
    u32(centralAt);
    u16(0);

    return new Blob([buf], { type: "application/zip" });
  }

  /** Kick off a browser download without leaking the object URL. */
  function download(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  return { build, download, crc32 };
})();
