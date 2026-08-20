const UUIDS = {
  smpService: '8d53dc1d-1db7-4cd3-868b-8a527460aa84',
  smpCharacteristic: 'da2e7828-fbce-4e01-ae9e-261174997c48',
};

const SMP = {
  OP_READ: 0,
  OP_WRITE: 2,
  GROUP_OS: 0,
  GROUP_IMAGE: 1,
  OS_RESET: 5,
  IMG_STATE: 0,
  IMG_UPLOAD: 1,
};

const SMP_RC_NAMES = {
  1: 'unknown error',
  2: 'not enough memory',
  3: 'invalid image',
  4: 'image already pending',
  5: 'no image pending',
  6: 'image not confirmed',
  7: 'image already confirmed',
  8: 'flash failure',
  9: 'image already booted',
  10: 'image not bootable',
  11: 'invalid length',
  12: 'invalid offset',
  13: 'flash context error',
  14: 'no image',
  15: 'no upgrade',
  16: 'invalid version',
};

const state = {
  device: null,
  server: null,
  characteristic: null,
  smp: null,
  otaBytes: null,
  otaName: '',
  otaInfo: null,
  otaHash: null,
  otaLastModified: 0,
  otaUploadOffset: 0,
  busy: false,
};

const $ = (id) => document.getElementById(id);

function normalizeBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

const APP_BUILD = '20260820-cbor5-resume2';
const UPLOAD_CHUNK_SIZE = 128;
const UPLOAD_RETRY_LIMIT = 4;
const RECONNECT_RETRY_LIMIT = 3;

function concatBytes(...values) {
  const chunks = values.map((value) => normalizeBytes(value) || new Uint8Array());
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function bytesToHex(value, limit = 0) {
  const bytes = normalizeBytes(value);
  if (!bytes) return '--';
  const selected = limit > 0 ? bytes.slice(0, limit) : bytes;
  const suffix = limit > 0 && bytes.length > limit ? '…' : '';
  return `${Array.from(selected, (byte) => byte.toString(16).padStart(2, '0')).join('')}${suffix}`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '--';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatTime(value = Date.now()) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function log(message) {
  const view = $('logView');
  view.textContent += `[${formatTime()}] ${message}\n`;
  view.scrollTop = view.scrollHeight;
}

function setHint(id, message, kind = '') {
  const element = $(id);
  element.textContent = message;
  element.className = `hint${kind ? ` ${kind}` : ''}`;
}

function setProgress(done, total, status = '') {
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeDone = Math.max(0, Math.min(safeTotal, Number(done) || 0));
  const percent = (safeDone / safeTotal) * 100;
  $('otaProgressBar').style.width = `${percent}%`;
  $('otaPercent').textContent = `${percent.toFixed(1)}%`;
  $('otaProgressText').textContent = status || `${formatBytes(safeDone)} / ${formatBytes(safeTotal)}`;
}

function setTransferState(label, kind = '') {
  $('transferState').textContent = label;
  $('transferState').className = `transfer-state${kind ? ` ${kind}` : ''}`;
}

function setConnection(connected) {
  $('connectionDot').classList.toggle('connected', connected);
  $('connectionText').textContent = connected ? '已连接' : '未连接';
  $('deviceBadge').textContent = connected ? 'CONNECTED' : '未连接';
  $('deviceBadge').className = `badge ${connected ? 'success' : 'neutral'}`;
  const browserReady = Boolean(window.isSecureContext && navigator.bluetooth);
  $('connectBtn').disabled = connected || state.busy || !browserReady;
  $('disconnectBtn').disabled = !connected || state.busy;
  $('otaUploadBtn').disabled = !connected || !state.otaBytes || !state.otaInfo || state.busy;
  $('imageStateBtn').disabled = !connected || state.busy;
  $('resetBtn').disabled = !connected || state.busy;
}

function updateRuntime() {
  const secure = window.isSecureContext;
  const bluetooth = 'bluetooth' in navigator;
  $('runtimeOrigin').textContent = window.location.origin || 'file://';
  $('runtimeSecurity').textContent = secure ? 'OK' : '需要 HTTPS/localhost';
  $('runtimeSecurity').style.color = secure ? 'var(--green)' : 'var(--orange)';
  $('runtimeBluetooth').textContent = bluetooth ? '可用' : '不可用';
  $('runtimeBluetooth').style.color = bluetooth ? 'var(--green)' : 'var(--red)';
  $('runtimeOta').textContent = 'SMP over BLE';
  $('runtimeOta').style.color = 'var(--cyan)';
  if (!secure || !bluetooth) {
    $('connectBtn').disabled = true;
    setHint('browserHint', !secure ? '当前页面不是安全上下文，请使用 HTTPS 或 localhost。' : '当前浏览器没有 Web Bluetooth，请使用桌面 Chrome/Edge。', 'error');
  } else {
    setHint('browserHint', '支持桌面 Chrome/Edge；设备选择必须由用户点击触发。');
  }
}

function cborHead(major, value) {
  if (value < 24) return Uint8Array.from([(major << 5) | value]);
  if (value < 256) return Uint8Array.from([(major << 5) | 24, value]);
  if (value < 65536) return Uint8Array.from([(major << 5) | 25, value >> 8, value & 0xff]);
  const result = new Uint8Array(5);
  result[0] = (major << 5) | 26;
  new DataView(result.buffer).setUint32(1, value >>> 0, false);
  return result;
}

function cborEncode(value) {
  if (value === null) return Uint8Array.from([0xf6]);
  if (value === false) return Uint8Array.from([0xf4]);
  if (value === true) return Uint8Array.from([0xf5]);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0) return cborHead(0, value);
    if (Number.isInteger(value) && value < 0) return cborHead(1, -1 - value);
    const result = new Uint8Array(9);
    result[0] = 0xfb;
    new DataView(result.buffer).setFloat64(1, value, false);
    return result;
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return concatBytes(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concatBytes(cborHead(2, value.length), value);
  if (Array.isArray(value)) {
    let result = cborHead(4, value.length);
    for (const item of value) result = concatBytes(result, cborEncode(item));
    return result;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    let result = cborHead(5, entries.length);
    for (const [key, item] of entries) result = concatBytes(result, cborEncode(key), cborEncode(item));
    return result;
  }
  throw new Error(`不支持的 CBOR 类型：${typeof value}`);
}

function cborDecode(bytes) {
  const data = normalizeBytes(bytes);
  let offset = 0;
  const decoder = new TextDecoder();

  function ensureAvailable(length) {
    if (offset + length > data.length) throw new Error('CBOR 数据被截断');
  }

  function readLength(additional) {
    if (additional < 24) return additional;
    if (additional === 24) {
      ensureAvailable(1);
      return data[offset++];
    }
    if (additional === 25) {
      ensureAvailable(2);
      const value = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      return value;
    }
    if (additional === 26) {
      ensureAvailable(4);
      const value = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
      offset += 4;
      return value;
    }
    if (additional === 27) {
      ensureAvailable(8);
      const value = new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, false);
      offset += 8;
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR 整数超出 JavaScript 安全范围');
      return Number(value);
    }
    if (additional === 31) return -1;
    throw new Error(`不支持的 CBOR 长度编码：additional=${additional}，offset=${offset - 1}`);
  }

  function readItem() {
    ensureAvailable(1);
    const head = data[offset++];
    const major = head >> 5;
    const additional = head & 0x1f;
    if (major === 0) {
      if (additional === 31) throw new Error('CBOR 无符号整数使用非法的不定长编码');
      return readLength(additional);
    }
    if (major === 1) {
      if (additional === 31) throw new Error('CBOR 负整数使用非法的不定长编码');
      return -1 - readLength(additional);
    }
    if (major === 2) {
      const length = readLength(additional);
      if (length < 0) {
        const chunks = [];
        while (data[offset] !== 0xff) {
          const chunk = readItem();
          if (!(chunk instanceof Uint8Array)) throw new Error('CBOR 不定长字节串包含非字节块');
          chunks.push(chunk);
        }
        offset += 1;
        return concatBytes(...chunks);
      }
      ensureAvailable(length);
      const value = data.slice(offset, offset + length);
      offset += length;
      return value;
    }
    if (major === 3) {
      const length = readLength(additional);
      if (length < 0) {
        let value = '';
        while (data[offset] !== 0xff) {
          const chunk = readItem();
          if (typeof chunk !== 'string') throw new Error('CBOR 不定长文本包含非文本块');
          value += chunk;
        }
        offset += 1;
        return value;
      }
      ensureAvailable(length);
      const value = decoder.decode(data.slice(offset, offset + length));
      offset += length;
      return value;
    }
    if (major === 4) {
      const length = readLength(additional);
      if (length < 0) {
        const result = [];
        while (data[offset] !== 0xff) result.push(readItem());
        offset += 1;
        return result;
      }
      return Array.from({ length }, () => readItem());
    }
    if (major === 5) {
      const length = readLength(additional);
      const result = {};
      if (length < 0) {
        while (data[offset] !== 0xff) result[readItem()] = readItem();
        offset += 1;
        return result;
      }
      for (let index = 0; index < length; index += 1) result[readItem()] = readItem();
      return result;
    }
    if (major === 6) {
      readLength(additional);
      return readItem();
    }
    if (major === 7 && additional === 20) return false;
    if (major === 7 && additional === 21) return true;
    if (major === 7 && additional === 22) return null;
    if (major === 7 && additional === 23) return undefined;
    if (major === 7 && additional === 26) {
      ensureAvailable(4);
      const value = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
      offset += 4;
      return value;
    }
    if (major === 7 && additional === 27) {
      ensureAvailable(8);
      const value = new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(0, false);
      offset += 8;
      return value;
    }
    throw new Error(`不支持的 CBOR 数据项：0x${head.toString(16)}`);
  }

  return readItem();
}

function runCborSelfTest() {
  const indefiniteMap = cborDecode([0xbf, 0x63, 0x6f, 0x66, 0x66, 0x19, 0x04, 0x00, 0xff]);
  const indefiniteBytes = cborDecode([0x5f, 0x42, 0x01, 0x02, 0x41, 0x03, 0xff]);
  const uint64 = cborDecode([0x1b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00]);
  if (indefiniteMap.off !== 1024 || bytesToHex(indefiniteBytes) !== '010203' || uint64 !== 262144) {
    throw new Error('CBOR 解码器启动自检失败');
  }
}

class SmpClient {
  constructor(characteristic) {
    this.characteristic = characteristic;
    this.sequence = 0;
    this.pending = new Map();
    this.receiveBuffer = new Uint8Array();
    this.notificationHandler = null;
  }

  async init() {
    await this.characteristic.startNotifications();
    this.notificationHandler = (event) => {
      this.onNotify(new Uint8Array(event.target.value.buffer.slice(0)));
    };
    this.characteristic.addEventListener('characteristicvaluechanged', this.notificationHandler);
  }

  close(error = new Error('蓝牙连接已断开')) {
    if (this.notificationHandler) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this.notificationHandler);
      this.notificationHandler = null;
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.receiveBuffer = new Uint8Array();
  }

  onNotify(chunk) {
    this.receiveBuffer = concatBytes(this.receiveBuffer, chunk);
    while (this.receiveBuffer.length >= 8) {
      const length = (this.receiveBuffer[2] << 8) | this.receiveBuffer[3];
      const total = 8 + length;
      if (this.receiveBuffer.length < total) return;
      const packet = this.receiveBuffer.slice(0, total);
      this.receiveBuffer = this.receiveBuffer.slice(total);
      const sequence = packet[6];
      const pending = this.pending.get(sequence);
      if (!pending) continue;
      this.pending.delete(sequence);
      try {
        pending.resolve({
          op: packet[0],
          group: (packet[4] << 8) | packet[5],
          sequence,
          id: packet[7],
          body: cborDecode(packet.slice(8)),
        });
      } catch (error) {
        pending.reject(error);
      }
    }
  }

  async command(group, id, op, body = {}, timeoutMs = 12000) {
    const sequence = this.sequence++ & 0xff;
    const payload = cborEncode(body);
    const packet = new Uint8Array(8 + payload.length);
    packet[0] = op;
    packet[2] = (payload.length >> 8) & 0xff;
    packet[3] = payload.length & 0xff;
    packet[4] = (group >> 8) & 0xff;
    packet[5] = group & 0xff;
    packet[6] = sequence;
    packet[7] = id;
    packet.set(payload, 8);

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        reject(new Error('等待 SMP 响应超时'));
      }, timeoutMs);
      this.pending.set(sequence, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });

    try {
      if (this.characteristic.properties.writeWithoutResponse) {
        await this.characteristic.writeValueWithoutResponse(packet);
      } else {
        await this.characteristic.writeValueWithResponse(packet);
      }
    } catch (error) {
      const pending = this.pending.get(sequence);
      this.pending.delete(sequence);
      pending?.reject(error);
      return await response;
    }

    const result = await response;
    const errorCode = result.body?.rc ?? result.body?.err?.rc ?? 0;
    if (errorCode !== 0) {
      const error = new Error(`SMP 返回码 ${errorCode}：${SMP_RC_NAMES[errorCode] || '未知错误'}`);
      error.rc = errorCode;
      error.body = result.body;
      throw error;
    }
    return result.body;
  }
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function parseMcuBootImageInfo(bytes) {
  const data = normalizeBytes(bytes);
  if (!data || data.length < 32) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0x96f3b83d) return null;
  return {
    version: `${view.getUint8(20)}.${view.getUint8(21)}.${view.getUint16(22, true)}+${view.getUint32(24, true)}`,
  };
}

function findEocd(bytes) {
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 0xffff - 22); index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) return index;
  }
  throw new Error('未找到 ZIP 文件结束记录');
}

function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const eocd = findEocd(bytes);
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 中央目录无效');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extractZipEntry(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const localOffset = entry.localOffset;
  if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`ZIP 文件头无效：${entry.name}`);
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  const compressed = bytes.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8 && 'DecompressionStream' in window) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error(entry.method === 8 ? '当前浏览器无法解压 ZIP 文件项' : `不支持的 ZIP 压缩方式：${entry.method}`);
}

async function readOtaFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!file.name.toLowerCase().endsWith('.zip')) return { bytes, name: file.name };
  const entries = readZipEntries(bytes);
  let target = entries.find((entry) => entry.name.toLowerCase().endsWith('.bin'));
  const manifest = entries.find((entry) => entry.name.toLowerCase().endsWith('manifest.json'));
  if (manifest) {
    try {
      const manifestJson = JSON.parse(new TextDecoder().decode(await extractZipEntry(bytes, manifest)));
      const manifestName = manifestJson.files?.map((item) => item.file).find((name) => name?.toLowerCase().endsWith('.bin'));
      if (manifestName) target = entries.find((entry) => entry.name.endsWith(manifestName)) || target;
    } catch (error) {
      log(`忽略 manifest.json：${error.message}`);
    }
  }
  if (!target) throw new Error('ZIP 文件中没有找到 .bin 镜像');
  return { bytes: await extractZipEntry(bytes, target), name: `${file.name} / ${target.name}` };
}

function imageFlag(value) {
  return value === true || value === 1 || value === 'true';
}

function imageFlagClear(value) {
  return value === false || value === 0 || value === 'false';
}

function imageSlotLabel(image) {
  return image.image === undefined ? `slot ${image.slot ?? '?'}` : `image ${image.image} / slot ${image.slot ?? '?'}`;
}

function imageFlags(image) {
  const flags = [];
  if (imageFlag(image.active)) flags.push('ACTIVE');
  if (imageFlag(image.pending)) flags.push('PENDING');
  if (imageFlag(image.confirmed)) flags.push('CONFIRMED');
  if (imageFlag(image.permanent)) flags.push('PERMANENT');
  if (image.bootable === false || image.bootable === 0) flags.push('NOT BOOTABLE');
  return flags.length ? flags : ['IDLE'];
}

function imageStateSummary(body) {
  const images = Array.isArray(body?.images) ? body.images : [];
  if (!images.length) return '没有镜像';
  return images.map((image) => `${imageSlotLabel(image)} ${imageFlags(image).join('/')}`).join(' · ');
}

function selectTestImage(body) {
  const images = (Array.isArray(body?.images) ? body.images : []).map((image) => ({
    ...image,
    hash: normalizeBytes(image.hash),
    hashHex: bytesToHex(image.hash),
  }));
  const activeHashes = new Set(images.filter((image) => imageFlag(image.active)).map((image) => image.hashHex));
  const candidates = images.filter((image) => image.hash?.length && !imageFlagClear(image.bootable) && !imageFlag(image.active));
  const unique = candidates.find((image) => !activeHashes.has(image.hashHex));
  if (unique) return { image: unique };
  const duplicateActive = candidates.find((image) => activeHashes.has(image.hashHex));
  return duplicateActive ? { duplicateActive } : { image: null };
}

function renderImageState(body) {
  const images = Array.isArray(body?.images) ? body.images : [];
  $('stateSummary').textContent = images.length ? `${images.length} 个槽位` : '无镜像';
  $('stateSummary').className = `badge ${images.length ? 'accent' : 'neutral'}`;
  if (!images.length) {
    $('imageList').innerHTML = '<div class="empty-state">设备没有返回可显示的 MCUboot 镜像槽位。</div>';
    return;
  }
  $('imageList').innerHTML = images.map((image) => {
    const flags = imageFlags(image);
    const hash = bytesToHex(image.hash, 8);
    const active = imageFlag(image.active);
    const version = image.version || '版本未知';
    return `<div class="image-slot"><div class="slot-label">${imageSlotLabel(image)}</div><div class="slot-info"><strong>${version}</strong><span>${hash} · ${formatBytes(Number(image.size) || 0)}</span></div><div class="slot-flags ${active ? 'active' : ''}">${flags.join('<br>')}</div></div>`;
  }).join('');
}

async function readImageState() {
  if (!state.smp) throw new Error('SMP OTA 服务尚未就绪');
  const body = await state.smp.command(SMP.GROUP_IMAGE, SMP.IMG_STATE, SMP.OP_READ, {});
  renderImageState(body);
  log(`镜像状态：${imageStateSummary(body)}`);
  $('otaProgressText').textContent = '已读取镜像状态';
  return body;
}

async function uploadOta() {
  if (!state.smp) throw new Error('SMP OTA 服务尚未就绪');
  if (!state.otaBytes) throw new Error('请选择 .zip 或签名 .bin 镜像');
  if (!state.otaInfo) throw new Error('未识别 MCUboot 镜像头，请选择签名 .bin 或 dfu_application.zip');
  state.busy = true;
  setConnection(true);
  setTransferState('上传中');
  const image = state.otaBytes;
  const hash = state.otaHash || await sha256(image);
  let offset = Math.min(state.otaUploadOffset, image.length);
  let restartedFromZero = false;
  try {
    log(`开始 OTA：${state.otaName} · ${formatBytes(image.length)} · ${state.otaInfo?.version || '版本未知'}`);
    if (offset > 0 && offset < image.length) log(`从已确认偏移 ${formatBytes(offset)} 继续上传`);
    while (offset < image.length) {
      const chunk = image.slice(offset, Math.min(image.length, offset + UPLOAD_CHUNK_SIZE));
      const body = offset === 0 ? { off: offset, len: image.length, sha: hash, data: chunk } : { off: offset, data: chunk };
      setProgress(offset, image.length, `正在发送分块 · ${formatBytes(offset)} / ${formatBytes(image.length)}`);
      let response = null;
      let restartLoop = false;
      for (let attempt = 1; attempt <= UPLOAD_RETRY_LIMIT; attempt += 1) {
        try {
          await ensureSmpConnected();
          response = await state.smp.command(SMP.GROUP_IMAGE, SMP.IMG_UPLOAD, SMP.OP_WRITE, body, 20000);
          break;
        } catch (error) {
          if (error.rc === 12 && offset > 0) {
            const expectedOffset = Number(error.body?.off);
            if (Number.isFinite(expectedOffset) && expectedOffset >= 0 && expectedOffset <= image.length) {
              offset = expectedOffset;
              state.otaUploadOffset = expectedOffset;
              log(`设备要求从 ${formatBytes(expectedOffset)} 继续，已同步上传偏移`);
              restartLoop = true;
              break;
            }
            if (!restartedFromZero) {
              offset = 0;
              state.otaUploadOffset = 0;
              restartedFromZero = true;
              log('设备上传上下文已丢失，将从头重新开始一次');
              restartLoop = true;
              break;
            }
          }
          if (attempt >= UPLOAD_RETRY_LIMIT) throw error;
          log(`分块发送失败，将重试 ${attempt}/${UPLOAD_RETRY_LIMIT - 1}：${error.message}`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 300));
        }
      }
      if (restartLoop) continue;
      if (!response) throw new Error('分块上传没有收到有效响应');
      const nextOffset = Number(response.off ?? offset + chunk.length);
      if (!Number.isFinite(nextOffset) || nextOffset <= offset || nextOffset > image.length) throw new Error(`SMP 返回无效偏移量：${response.off}`);
      offset = nextOffset;
      state.otaUploadOffset = nextOffset;
      await new Promise((resolve) => setTimeout(resolve, 18));
    }

    setProgress(image.length, image.length, '上传完成，正在读取镜像状态');
    const imageState = await readImageState();
    const selection = selectTestImage(imageState);
    if (selection.duplicateActive) {
      setTransferState('镜像重复', 'warning');
      throw new Error('上传镜像与当前运行镜像哈希相同，未标记 test boot');
    }
    if (!selection.image) throw new Error('没有找到可启动的非当前镜像槽位');
    await state.smp.command(SMP.GROUP_IMAGE, SMP.IMG_STATE, SMP.OP_WRITE, { hash: selection.image.hash, confirm: false });
    setTransferState('等待重启', 'success');
    setProgress(image.length, image.length, `已标记 test boot · ${imageSlotLabel(selection.image)} · 请确认后重启`);
    log(`新镜像已标记为 test boot：${imageSlotLabel(selection.image)} · ${bytesToHex(selection.image.hash, 8)}`);
  } catch (error) {
    setTransferState('失败', 'error');
    setProgress(offset, image.length, `失败：${error.message}`);
    throw error;
  } finally {
    state.busy = false;
    setConnection(Boolean(state.device?.gatt?.connected));
  }
}

async function resetDevice() {
  if (!state.smp) throw new Error('SMP OTA 服务尚未就绪');
  state.busy = true;
  setTransferState('正在重启');
  setProgress(1, 1, '已发送重启命令，请等待设备重新广播');
  try {
    await state.smp.command(SMP.GROUP_OS, SMP.OS_RESET, SMP.OP_WRITE, {}, 2000);
  } catch (error) {
    log(`重启命令已发送或连接已断开：${error.message}`);
  } finally {
    state.busy = false;
    log('设备正在重启；确认新镜像后请重新连接。');
  }
}

function disconnectDevice() {
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
}

function handleGattDisconnected() {
  const disconnectedClient = state.smp;
  state.server = null;
  state.characteristic = null;
  state.smp = null;
  disconnectedClient?.close(new Error('蓝牙连接已断开'));
  setConnection(false);
  $('runtimeOta').textContent = '未连接';
  log(state.busy ? '设备已断开，上传器将自动尝试重连并续传' : '设备已断开');
}

async function openSmpConnection(reconnecting = false) {
  if (!state.device) throw new Error('尚未选择蓝牙设备');
  let client = null;
  try {
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService(UUIDS.smpService);
    const characteristic = await service.getCharacteristic(UUIDS.smpCharacteristic);
    client = new SmpClient(characteristic);
    await client.init();
    state.server = server;
    state.characteristic = characteristic;
    state.smp = client;
    $('deviceName').textContent = state.device.name || 'SivyBand';
    $('deviceAddress').textContent = 'SMP OTA 服务已连接';
    $('runtimeOta').textContent = '已连接';
    setConnection(true);
    log(reconnecting ? '蓝牙已自动重连，继续 OTA' : 'SMP OTA 服务已就绪');
    return client;
  } catch (error) {
    client?.close(error);
    state.server = null;
    state.characteristic = null;
    state.smp = null;
    setConnection(false);
    throw error;
  }
}

async function ensureSmpConnected() {
  if (state.device?.gatt?.connected && state.smp) return state.smp;
  let lastError = null;
  for (let attempt = 1; attempt <= RECONNECT_RETRY_LIMIT; attempt += 1) {
    try {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      return await openSmpConnection(true);
    } catch (error) {
      lastError = error;
      log(`自动重连失败 ${attempt}/${RECONNECT_RETRY_LIMIT}：${error.message}`);
    }
  }
  throw new Error(`自动重连失败：${lastError?.message || '未知错误'}`);
}

async function connectDevice() {
  if (!window.isSecureContext || !navigator.bluetooth) throw new Error('当前浏览器环境不支持 Web Bluetooth');
  $('connectBtn').disabled = true;
  try {
    log('正在打开蓝牙设备选择器…');
    const selectedDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUIDS.smpService] }, { namePrefix: 'SivyBand' }],
      optionalServices: [UUIDS.smpService],
    });
    if (state.device !== selectedDevice) {
      state.device?.removeEventListener('gattserverdisconnected', handleGattDisconnected);
      state.device = selectedDevice;
      state.device.addEventListener('gattserverdisconnected', handleGattDisconnected);
    }
    log(`已选择设备：${state.device.name || 'SivyBand'}`);
    await openSmpConnection(false);
    setHint('browserHint', '设备已连接，可读取槽位状态或上传签名镜像。', 'success');
  } catch (error) {
    setConnection(false);
    if (error.name === 'NotFoundError') log('用户取消了设备选择');
    else log(`连接失败：${error.message}`);
    setHint('browserHint', error.message, 'error');
  }
}

async function handleFile(file) {
  if (!file) return;
  state.otaBytes = null;
  state.otaHash = null;
  state.otaInfo = null;
  state.otaUploadOffset = 0;
  try {
    const image = await readOtaFile(file);
    state.otaBytes = image.bytes;
    state.otaName = image.name;
    state.otaInfo = parseMcuBootImageInfo(image.bytes);
    state.otaHash = await sha256(image.bytes);
    state.otaLastModified = file.lastModified;
    $('otaFileName').textContent = image.name;
    $('otaFileSize').textContent = formatBytes(image.bytes.length);
    $('otaVersion').textContent = state.otaInfo?.version || '未知（请确认是签名镜像）';
    $('otaHash').textContent = bytesToHex(state.otaHash, 12);
    setHint('imageHint', state.otaInfo ? '已识别 MCUboot 镜像头，可以上传。' : '未识别 MCUboot 镜像头，请确认选择的是签名 .bin 或 dfu_application.zip。', state.otaInfo ? 'success' : 'error');
    setProgress(0, image.bytes.length, `已加载 · ${formatBytes(image.bytes.length)}`);
    log(`镜像已加载：${image.name} · ${formatBytes(image.bytes.length)} · ${state.otaInfo?.version || '版本未知'}`);
    setConnection(Boolean(state.device?.gatt?.connected));
  } catch (error) {
    setHint('imageHint', `加载失败：${error.message}`, 'error');
    log(`镜像加载失败：${error.message}`);
  }
}

function run(action) {
  action().catch((error) => log(`操作失败：${error.message}`));
}

function bindUi() {
  updateRuntime();
  setConnection(false);
  setProgress(0, 1, '等待选择镜像');
  log('SivyBand Gen2 OTA Console 已就绪');
  log(`Web build: ${APP_BUILD}`);
  try {
    runCborSelfTest();
    log('CBOR decoder self-test: PASS');
  } catch (error) {
    log(`CBOR decoder self-test: FAIL · ${error.message}`);
    setHint('browserHint', error.message, 'error');
    $('connectBtn').disabled = true;
  }
  $('connectBtn').addEventListener('click', () => run(connectDevice));
  $('disconnectBtn').addEventListener('click', disconnectDevice);
  $('otaFile').addEventListener('change', (event) => run(() => handleFile(event.target.files[0])));
  $('otaUploadBtn').addEventListener('click', () => run(uploadOta));
  $('imageStateBtn').addEventListener('click', () => run(readImageState));
  $('resetBtn').addEventListener('click', () => run(resetDevice));
  $('clearLogBtn').addEventListener('click', () => { $('logView').textContent = ''; });
}

window.addEventListener('DOMContentLoaded', bindUi);
