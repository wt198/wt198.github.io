const UUIDS = {
  service: '8d53dc1d-1db7-4cd3-868b-8a527460aa84',
  characteristic: 'da2e7828-fbce-4e01-ae9e-261174997c48',
};

const SMP = { read: 0, write: 2, os: 0, image: 1, reset: 5, state: 0, upload: 1 };
const state = {
  device: null,
  smp: null,
  image: null,
  imageName: '',
  imageInfo: null,
  imageHash: null,
  busy: false,
};
const $ = (id) => document.getElementById(id);

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return null;
}

function joinBytes(left, right) {
  const a = bytes(left) || new Uint8Array();
  const b = bytes(right) || new Uint8Array();
  const output = new Uint8Array(a.length + b.length);
  output.set(a);
  output.set(b, a.length);
  return output;
}

function hex(value, limit = 0) {
  const data = bytes(value);
  if (!data) return '--';
  const selected = limit ? data.slice(0, limit) : data;
  return `${Array.from(selected, (item) => item.toString(16).padStart(2, '0')).join('')}${limit && data.length > limit ? '...' : ''}`;
}

function sizeLabel(value) {
  if (!Number.isFinite(value)) return '--';
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1048576).toFixed(2)} MiB`;
}

function log(message) {
  const view = $('logView');
  view.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
  view.scrollTop = view.scrollHeight;
}

function hint(id, message, kind = '') {
  const element = $(id);
  element.textContent = message;
  element.className = `hint${kind ? ` ${kind}` : ''}`;
}

function progress(done, total, message) {
  const amount = Math.max(1, Number(total) || 1);
  const completed = Math.max(0, Math.min(amount, Number(done) || 0));
  const percent = (completed / amount) * 100;
  $('otaProgressBar').style.width = `${percent}%`;
  $('otaPercent').textContent = `${percent.toFixed(1)}%`;
  $('otaProgressText').textContent = message || `${sizeLabel(completed)} / ${sizeLabel(amount)}`;
}

function setTransfer(label, kind = '') {
  $('transferState').textContent = label;
  $('transferState').className = `transfer-state${kind ? ` ${kind}` : ''}`;
}

function setConnected(connected) {
  const ready = Boolean(window.isSecureContext && navigator.bluetooth);
  $('connectionDot').classList.toggle('connected', connected);
  $('connectionText').textContent = connected ? 'Connected' : 'Not connected';
  $('deviceBadge').textContent = connected ? 'CONNECTED' : 'NOT CONNECTED';
  $('deviceBadge').className = `badge ${connected ? 'success' : 'neutral'}`;
  $('connectBtn').disabled = connected || state.busy || !ready;
  $('disconnectBtn').disabled = !connected || state.busy;
  $('otaUploadBtn').disabled = !connected || !state.image || !state.imageInfo || state.busy;
  $('imageStateBtn').disabled = !connected || state.busy;
  $('resetBtn').disabled = !connected || state.busy;
}

function initializeRuntime() {
  const secure = window.isSecureContext;
  const bluetooth = 'bluetooth' in navigator;
  $('runtimeOrigin').textContent = window.location.origin || 'file://';
  $('runtimeSecurity').textContent = secure ? 'OK' : 'Use HTTPS or localhost';
  $('runtimeSecurity').style.color = secure ? 'var(--green)' : 'var(--orange)';
  $('runtimeBluetooth').textContent = bluetooth ? 'Available' : 'Unavailable';
  $('runtimeBluetooth').style.color = bluetooth ? 'var(--green)' : 'var(--red)';
  $('runtimeOta').textContent = 'SMP over BLE';
  $('runtimeOta').style.color = 'var(--cyan)';
  if (!secure || !bluetooth) {
    hint('browserHint', !secure ? 'Open this page over HTTPS or localhost.' : 'Use desktop Chrome or Edge with Web Bluetooth.', 'error');
  } else {
    hint('browserHint', 'Device selection must be started by clicking the button.');
  }
}

function cborHeader(type, value) {
  if (value < 24) return Uint8Array.from([(type << 5) | value]);
  if (value < 256) return Uint8Array.from([(type << 5) | 24, value]);
  if (value < 65536) return Uint8Array.from([(type << 5) | 25, value >> 8, value & 255]);
  const output = new Uint8Array(5);
  output[0] = (type << 5) | 26;
  new DataView(output.buffer).setUint32(1, value >>> 0, false);
  return output;
}

function cborEncode(value) {
  if (value === null) return Uint8Array.from([246]);
  if (value === false) return Uint8Array.from([244]);
  if (value === true) return Uint8Array.from([245]);
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0) return cborHeader(0, value);
    if (Number.isInteger(value)) return cborHeader(1, -1 - value);
    const output = new Uint8Array(9);
    output[0] = 251;
    new DataView(output.buffer).setFloat64(1, value, false);
    return output;
  }
  if (typeof value === 'string') {
    const data = new TextEncoder().encode(value);
    return joinBytes(cborHeader(3, data.length), data);
  }
  if (value instanceof Uint8Array) return joinBytes(cborHeader(2, value.length), value);
  if (Array.isArray(value)) return value.reduce((output, item) => joinBytes(output, cborEncode(item)), cborHeader(4, value.length));
  if (typeof value === 'object') {
    return Object.entries(value).reduce((output, [key, item]) => joinBytes(output, cborEncode(key), cborEncode(item)), cborHeader(5, Object.keys(value).length));
  }
  throw new Error(`Unsupported CBOR type: ${typeof value}`);
}

function cborDecode(input) {
  const data = bytes(input);
  const textDecoder = new TextDecoder();
  let offset = 0;
  function length(additional) {
    if (additional < 24) return additional;
    if (additional === 24) return data[offset++];
    if (additional === 25) {
      const value = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      return value;
    }
    if (additional === 26) {
      const value = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
      offset += 4;
      return value;
    }
    if (additional === 27) {
      const value = new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(0, false);
      offset += 8;
      return value;
    }
    throw new Error('Unsupported CBOR length');
  }
  function item() {
    const header = data[offset++];
    const type = header >> 5;
    const additional = header & 31;
    if (type === 0) return length(additional);
    if (type === 1) return -1 - length(additional);
    if (type === 2) {
      const count = length(additional);
      const value = data.slice(offset, offset + count);
      offset += count;
      return value;
    }
    if (type === 3) {
      const count = length(additional);
      const value = textDecoder.decode(data.slice(offset, offset + count));
      offset += count;
      return value;
    }
    if (type === 4) return Array.from({ length: length(additional) }, item);
    if (type === 5) {
      const result = {};
      for (let index = 0, count = length(additional); index < count; index += 1) result[item()] = item();
      return result;
    }
    if (type === 7 && additional === 20) return false;
    if (type === 7 && additional === 21) return true;
    if (type === 7 && additional === 22) return null;
    if (type === 7 && additional === 26) {
      const value = new DataView(data.buffer, data.byteOffset + offset, 4).getFloat32(0, false);
      offset += 4;
      return value;
    }
    if (type === 7 && additional === 27) {
      const value = new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(0, false);
      offset += 8;
      return value;
    }
    throw new Error(`Unsupported CBOR item: ${header.toString(16)}`);
  }
  return item();
}

class SmpClient {
  constructor(characteristic) {
    this.characteristic = characteristic;
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = new Uint8Array();
  }

  async initialize() {
    await this.characteristic.startNotifications();
    this.characteristic.addEventListener('characteristicvaluechanged', (event) => this.receive(new Uint8Array(event.target.value.buffer.slice(0))));
  }

  receive(chunk) {
    this.buffer = joinBytes(this.buffer, chunk);
    while (this.buffer.length >= 8) {
      const length = (this.buffer[2] << 8) | this.buffer[3];
      if (this.buffer.length < 8 + length) return;
      const packet = this.buffer.slice(0, 8 + length);
      this.buffer = this.buffer.slice(8 + length);
      const sequence = packet[6];
      const pending = this.pending.get(sequence);
      if (!pending) continue;
      this.pending.delete(sequence);
      try {
        pending.resolve({ body: cborDecode(packet.slice(8)) });
      } catch (error) {
        pending.reject(error);
      }
    }
  }

  async command(group, id, operation, body = {}, timeout = 12000) {
    const sequence = this.sequence++ & 255;
    const payload = cborEncode(body);
    const packet = new Uint8Array(8 + payload.length);
    packet[0] = operation;
    packet[2] = payload.length >> 8;
    packet[3] = payload.length & 255;
    packet[4] = group >> 8;
    packet[5] = group & 255;
    packet[6] = sequence;
    packet[7] = id;
    packet.set(payload, 8);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        reject(new Error('SMP response timeout'));
      }, timeout);
      this.pending.set(sequence, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
    try {
      if (this.characteristic.properties.writeWithoutResponse) await this.characteristic.writeValueWithoutResponse(packet);
      else await this.characteristic.writeValueWithResponse(packet);
    } catch (error) {
      this.pending.delete(sequence);
      throw error;
    }
    const result = await response;
    const code = result.body?.rc ?? result.body?.err?.rc ?? 0;
    if (code) throw new Error(`SMP error ${code}`);
    return result.body;
  }
}

async function digest(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function parseImage(data) {
  if (!data || data.length < 32) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== 0x96f3b83d) return null;
  return { version: `${view.getUint8(20)}.${view.getUint8(21)}.${view.getUint16(22, true)}+${view.getUint32(24, true)}` };
}

function zipEnd(data) {
  for (let index = data.length - 22; index >= Math.max(0, data.length - 0xffff - 22); index -= 1) {
    if (data[index] === 80 && data[index + 1] === 75 && data[index + 2] === 5 && data[index + 3] === 6) return index;
  }
  throw new Error('ZIP end record not found');
}

function zipEntries(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = zipEnd(data);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(data.slice(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function zipRead(data, entry) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offset = entry.localOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`Invalid ZIP entry: ${entry.name}`);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = data.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8 && 'DecompressionStream' in window) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('This browser cannot decompress the ZIP entry');
}

async function readImageFile(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  if (!file.name.toLowerCase().endsWith('.zip')) return { data, name: file.name };
  const entries = zipEntries(data);
  let target = entries.find((entry) => entry.name.toLowerCase().endsWith('.bin'));
  const manifest = entries.find((entry) => entry.name.toLowerCase().endsWith('manifest.json'));
  if (manifest) {
    try {
      const json = JSON.parse(new TextDecoder().decode(await zipRead(data, manifest)));
      const name = json.files?.map((item) => item.file).find((item) => item?.toLowerCase().endsWith('.bin'));
      target = entries.find((entry) => entry.name.endsWith(name)) || target;
    } catch (error) {
      log(`Ignored manifest: ${error.message}`);
    }
  }
  if (!target) throw new Error('No .bin image in ZIP');
  return { data: await zipRead(data, target), name: `${file.name} / ${target.name}` };
}

function flag(value) { return value === true || value === 1 || value === 'true'; }
function clearFlag(value) { return value === false || value === 0 || value === 'false'; }
function slot(image) { return image.image === undefined ? `slot ${image.slot ?? '?'}` : `image ${image.image} / slot ${image.slot ?? '?'}`; }
function flags(image) {
  const result = [];
  if (flag(image.active)) result.push('ACTIVE');
  if (flag(image.pending)) result.push('PENDING');
  if (flag(image.confirmed)) result.push('CONFIRMED');
  if (flag(image.permanent)) result.push('PERMANENT');
  if (clearFlag(image.bootable)) result.push('NOT BOOTABLE');
  return result.length ? result : ['IDLE'];
}
function safe(value) { return String(value).replace(/[&<>"']/g, (item) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[item])); }

function renderState(body) {
  const images = Array.isArray(body?.images) ? body.images : [];
  $('stateSummary').textContent = images.length ? `${images.length} slots` : 'No images';
  $('stateSummary').className = `badge ${images.length ? 'accent' : 'neutral'}`;
  $('imageList').innerHTML = images.length ? images.map((image) => `<div class="image-slot"><div class="slot-label">${safe(slot(image))}</div><div class="slot-info"><strong>${safe(image.version || 'Unknown version')}</strong><span>${safe(hex(image.hash, 8))} · ${sizeLabel(Number(image.size) || 0)}</span></div><div class="slot-flags ${flag(image.active) ? 'active' : ''}">${flags(image).join('<br>')}</div></div>`).join('') : '<div class="empty-state">No MCUboot image slots were returned.</div>';
}

function chooseTestImage(body) {
  const images = (Array.isArray(body?.images) ? body.images : []).map((image) => ({ ...image, hash: bytes(image.hash), hashHex: hex(image.hash) }));
  const activeHashes = new Set(images.filter((image) => flag(image.active)).map((image) => image.hashHex));
  const candidates = images.filter((image) => image.hash?.length && !clearFlag(image.bootable) && !flag(image.active));
  const unique = candidates.find((image) => !activeHashes.has(image.hashHex));
  if (unique) return unique;
  return candidates.find((image) => activeHashes.has(image.hashHex)) || null;
}

async function imageState() {
  if (!state.smp) throw new Error('SMP is not connected');
  const body = await state.smp.command(SMP.image, SMP.state, SMP.read, {});
  renderState(body);
  log(`Image state received: ${(body.images || []).map((image) => `${slot(image)} ${flags(image).join('/')}`).join(' · ') || 'none'}`);
  $('otaProgressText').textContent = 'Image state read';
  return body;
}

async function upload() {
  if (!state.smp) throw new Error('SMP is not connected');
  if (!state.image || !state.imageInfo) throw new Error('Select a valid signed MCUboot image');
  state.busy = true;
  setConnected(true);
  setTransfer('Uploading');
  let offset = 0;
  try {
    const imageHash = state.imageHash || await digest(state.image);
    log(`Starting OTA: ${state.imageName} · ${sizeLabel(state.image.length)} · ${state.imageInfo.version}`);
    while (offset < state.image.length) {
      const chunk = state.image.slice(offset, Math.min(state.image.length, offset + 128));
      const body = offset === 0 ? { off: 0, len: state.image.length, sha: imageHash, data: chunk } : { off: offset, data: chunk };
      progress(offset, state.image.length, `Sending chunk · ${sizeLabel(offset)} / ${sizeLabel(state.image.length)}`);
      const response = await state.smp.command(SMP.image, SMP.upload, SMP.write, body, 20000);
      const next = Number(response.off ?? offset + chunk.length);
      if (!Number.isFinite(next) || next <= offset || next > state.image.length) throw new Error(`Invalid upload offset: ${response.off}`);
      offset = next;
      await new Promise((resolve) => setTimeout(resolve, 18));
    }
    progress(state.image.length, state.image.length, 'Upload complete; reading image state');
    const body = await imageState();
    const target = chooseTestImage(body);
    if (!target) throw new Error('No bootable non-active image slot was returned');
    await state.smp.command(SMP.image, SMP.state, SMP.write, { hash: target.hash, confirm: false });
    setTransfer('Ready to reboot', 'success');
    progress(state.image.length, state.image.length, `Test boot marked · ${slot(target)} · confirm before reboot`);
    log(`Test boot marked: ${slot(target)} · ${hex(target.hash, 8)}`);
  } catch (error) {
    setTransfer('Failed', 'error');
    progress(offset, state.image.length, `Failed: ${error.message}`);
    throw error;
  } finally {
    state.busy = false;
    setConnected(Boolean(state.device?.gatt?.connected));
  }
}

async function reset() {
  if (!state.smp) throw new Error('SMP is not connected');
  state.busy = true;
  setTransfer('Restarting');
  progress(1, 1, 'Reset command sent; wait for the device to advertise again');
  try {
    await state.smp.command(SMP.os, SMP.reset, SMP.write, {}, 2000);
  } catch (error) {
    log(`Reset sent or connection closed: ${error.message}`);
  } finally {
    state.busy = false;
    log('Device is restarting. Reconnect after the new image boots.');
  }
}

function disconnect() {
  if (state.device?.gatt?.connected) state.device.gatt.disconnect();
}

async function connect() {
  if (!window.isSecureContext || !navigator.bluetooth) throw new Error('Web Bluetooth is unavailable in this browser context');
  $('connectBtn').disabled = true;
  try {
    log('Opening Bluetooth device chooser...');
    state.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [UUIDS.service] }, { namePrefix: 'SivyBand' }], optionalServices: [UUIDS.service] });
    state.device.addEventListener('gattserverdisconnected', () => {
      state.smp = null;
      setConnected(false);
      $('runtimeOta').textContent = 'Disconnected';
      log('Device disconnected');
    });
    state.device = state.device;
    const server = await state.device.gatt.connect();
    const service = await server.getPrimaryService(UUIDS.service);
    const characteristic = await service.getCharacteristic(UUIDS.characteristic);
    state.smp = new SmpClient(characteristic);
    await state.smp.initialize();
    $('deviceName').textContent = state.device.name || 'SivyBand';
    $('deviceAddress').textContent = 'SMP OTA service connected';
    $('runtimeOta').textContent = 'Connected';
    setConnected(true);
    hint('browserHint', 'Connected. Read image state or upload a signed image.', 'success');
    log('SMP OTA service ready');
  } catch (error) {
    setConnected(false);
    log(`Connection failed: ${error.message}`);
    hint('browserHint', error.message, 'error');
  }
}

async function fileSelected(file) {
  if (!file) return;
  state.image = null;
  state.imageInfo = null;
  state.imageHash = null;
  try {
    const result = await readImageFile(file);
    state.image = result.data;
    state.imageName = result.name;
    state.imageInfo = parseImage(result.data);
    state.imageHash = await digest(result.data);
    $('otaFileName').textContent = result.name;
    $('otaFileSize').textContent = sizeLabel(result.data.length);
    $('otaVersion').textContent = state.imageInfo?.version || 'Unknown; signed image required';
    $('otaHash').textContent = hex(state.imageHash, 12);
    hint('imageHint', state.imageInfo ? 'Valid MCUboot image header detected.' : 'MCUboot image header not found. Choose a signed .bin or dfu_application.zip.', state.imageInfo ? 'success' : 'error');
    progress(0, result.data.length, `Loaded · ${sizeLabel(result.data.length)}`);
    log(`Image loaded: ${result.name} · ${sizeLabel(result.data.length)} · ${state.imageInfo?.version || 'unknown version'}`);
    setConnected(Boolean(state.device?.gatt?.connected));
  } catch (error) {
    hint('imageHint', `Load failed: ${error.message}`, 'error');
    log(`Image load failed: ${error.message}`);
  }
}

function run(action) { action().catch((error) => log(`Operation failed: ${error.message}`)); }

function bind() {
  initializeRuntime();
  setConnected(false);
  progress(0, 1, 'Select an OTA image');
  log('SivyBand Gen2 OTA Console ready');
  $('connectBtn').addEventListener('click', () => run(connect));
  $('disconnectBtn').addEventListener('click', disconnect);
  $('otaFile').addEventListener('change', (event) => run(() => fileSelected(event.target.files[0])));
  $('otaUploadBtn').addEventListener('click', () => run(upload));
  $('imageStateBtn').addEventListener('click', () => run(imageState));
  $('resetBtn').addEventListener('click', () => run(reset));
  $('clearLogBtn').addEventListener('click', () => { $('logView').textContent = ''; });
}

window.addEventListener('DOMContentLoaded', bind);
