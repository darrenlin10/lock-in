// Device presets (design doc §5.3).
//
// Presets use real pixel dimensions plus a default content rectangle for the
// paper. They are *starting points*, not guarantees: clock style, widgets and
// notifications change the usable area, so the UI lets users move and resize
// the paper and saves that calibration per device.
//
// Rectangles are fractions of the canvas: { x, y, w, h } in 0..1.
// Guides are preview-only overlays (never drawn into the export).

const PHONE_RECT = { x: 0.08, y: 0.34, w: 0.84, h: 0.5 };
const PHONE_GUIDES = [
  { label: 'Clock & widgets', x: 0, y: 0, w: 1, h: 0.31 },
  { label: 'Shortcuts / notifications', x: 0, y: 0.87, w: 1, h: 0.13 },
];
const ANDROID_GUIDES = [
  { label: 'Clock', x: 0, y: 0, w: 1, h: 0.3 },
  { label: 'Shortcuts / fingerprint', x: 0, y: 0.86, w: 1, h: 0.14 },
];
const COMPUTER_RECT = { x: 0.6, y: 0.14, w: 0.3, h: 0.7 };
const COMPUTER_GUIDES = [
  { label: 'Clock (macOS)', x: 0.3, y: 0, w: 0.4, h: 0.3 },
  { label: 'Clock (Windows)', x: 0, y: 0.7, w: 0.38, h: 0.3 },
  { label: 'Sign-in', x: 0.35, y: 0.8, w: 0.3, h: 0.2 },
];

export const DEVICES = [
  { id: 'iphone-6.1', group: 'iPhone', name: 'iPhone 16 / 15 / 14 Pro', w: 1179, h: 2556, rect: PHONE_RECT, guides: PHONE_GUIDES },
  { id: 'iphone-6.3', group: 'iPhone', name: 'iPhone 17 / 17 Pro / 16 Pro', w: 1206, h: 2622, rect: PHONE_RECT, guides: PHONE_GUIDES },
  { id: 'iphone-6.7', group: 'iPhone', name: 'iPhone 16 Plus / 15 Plus / 15 Pro Max', w: 1290, h: 2796, rect: PHONE_RECT, guides: PHONE_GUIDES },
  { id: 'iphone-6.9', group: 'iPhone', name: 'iPhone 17 Pro Max / 16 Pro Max', w: 1320, h: 2868, rect: PHONE_RECT, guides: PHONE_GUIDES },
  { id: 'iphone-13', group: 'iPhone', name: 'iPhone 14 / 13 / 12', w: 1170, h: 2532, rect: PHONE_RECT, guides: PHONE_GUIDES },
  { id: 'iphone-se', group: 'iPhone', name: 'iPhone SE (2nd/3rd gen)', w: 750, h: 1334, rect: { x: 0.08, y: 0.3, w: 0.84, h: 0.56 }, guides: [{ label: 'Clock', x: 0, y: 0, w: 1, h: 0.28 }, { label: 'Notifications', x: 0, y: 0.88, w: 1, h: 0.12 }] },
  { id: 'pixel-9', group: 'Android', name: 'Pixel 9 / 8 (20:9)', w: 1080, h: 2424, rect: PHONE_RECT, guides: ANDROID_GUIDES },
  { id: 'pixel-9-pro-xl', group: 'Android', name: 'Pixel 9 Pro XL', w: 1344, h: 2992, rect: PHONE_RECT, guides: ANDROID_GUIDES },
  { id: 'galaxy-s', group: 'Android', name: 'Galaxy S25 / S24 (19.5:9)', w: 1080, h: 2340, rect: PHONE_RECT, guides: ANDROID_GUIDES },
  { id: 'galaxy-ultra', group: 'Android', name: 'Galaxy S24 Ultra', w: 1440, h: 3120, rect: PHONE_RECT, guides: ANDROID_GUIDES },
  { id: 'desktop-1080p', group: 'Computer', name: 'Full HD monitor / laptop', w: 1920, h: 1080, rect: COMPUTER_RECT, guides: COMPUTER_GUIDES },
  { id: 'desktop-1440p', group: 'Computer', name: 'QHD monitor', w: 2560, h: 1440, rect: COMPUTER_RECT, guides: COMPUTER_GUIDES },
  { id: 'desktop-4k', group: 'Computer', name: '4K monitor', w: 3840, h: 2160, rect: COMPUTER_RECT, guides: COMPUTER_GUIDES },
  { id: 'macbook-air-13', group: 'Computer', name: 'MacBook Air 13" (M2/M3)', w: 2560, h: 1664, rect: COMPUTER_RECT, guides: COMPUTER_GUIDES },
  { id: 'macbook-pro-14', group: 'Computer', name: 'MacBook Pro 14"', w: 3024, h: 1964, rect: COMPUTER_RECT, guides: COMPUTER_GUIDES },
];

export const CUSTOM_DEVICE_ID = 'custom';

export function clampRect(r) {
  const c = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  const w = c(r.w, 0.15, 1);
  const h = c(r.h, 0.15, 1);
  return { x: c(r.x, 0, 1 - w), y: c(r.y, 0, 1 - h), w, h };
}

/**
 * Resolve the active device from design settings.
 * Custom dimensions pick phone or computer defaults based on orientation.
 */
export function resolveDevice(design) {
  if (design.deviceId === CUSTOM_DEVICE_ID) {
    const w = Math.round(Math.min(8000, Math.max(320, Number(design.customW) || 1179)));
    const h = Math.round(Math.min(8000, Math.max(320, Number(design.customH) || 2556)));
    const portrait = h >= w;
    return {
      id: CUSTOM_DEVICE_ID,
      group: 'Custom',
      name: `Custom ${w}×${h}`,
      w,
      h,
      rect: portrait ? PHONE_RECT : COMPUTER_RECT,
      guides: portrait ? PHONE_GUIDES : COMPUTER_GUIDES,
    };
  }
  return DEVICES.find((d) => d.id === design.deviceId) || DEVICES[0];
}

/** Calibrated rect for a device (saved per device) or its default. */
export function rectFor(device, savedRects = {}) {
  const key = device.id === CUSTOM_DEVICE_ID ? `custom-${device.w}x${device.h}` : device.id;
  return clampRect(savedRects[key] || device.rect);
}

export function rectKey(device) {
  return device.id === CUSTOM_DEVICE_ID ? `custom-${device.w}x${device.h}` : device.id;
}

/** Plain-language description of the content rect, for the scenery prompt. */
export function describeRect(r) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  return `rectangle from ${pct(r.x)} to ${pct(r.x + r.w)} of the width and ${pct(r.y)} to ${pct(r.y + r.h)} of the height`;
}
