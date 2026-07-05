// Self-hosted replacement for the @leaningtech/cheerpx npm shim: loads the
// CheerpX runtime from this origin instead of cxrtnc.leaningtech.com. The
// runtime files are mirrored into the Worker's static assets by
// scripts/mirror-cheerpx.mjs (which pins the same version).
const version = "1.3.0";
// Indirection keeps bundlers from trying to resolve the runtime URL at build
// time (same trick as the upstream npm shim).
const dynImport = new Function("x", "return import(x)");
const CheerpX = await dynImport(new URL(`/cheerpx/${version}/cx.esm.js`, self.location.href).href);

export const Linux = CheerpX.Linux;
export const HttpBytesDevice = CheerpX.HttpBytesDevice;
export const CloudDevice = CheerpX.CloudDevice;
export const GitHubDevice = CheerpX.GitHubDevice;
export const IDBDevice = CheerpX.IDBDevice;
export const WebDevice = CheerpX.WebDevice;
export const DataDevice = CheerpX.DataDevice;
export const OverlayDevice = CheerpX.OverlayDevice;
export const System = CheerpX.System;
